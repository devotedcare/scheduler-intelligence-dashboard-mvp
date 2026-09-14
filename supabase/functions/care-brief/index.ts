// care-brief  ·  one line of care needs for a shift-offer text  ·  (Supabase Edge Function)
//
// WHAT THIS IS FOR
//
// A caregiver being offered a weekend shift should know what they are
// accepting BEFORE they say yes. This turns a client's recorded care needs
// into ONE SHORT LINE for the text message — nothing else.
//
//     "Wheelchair, hands-on transfers, 2-person assist, toileting and
//      bathing/dressing help, repositioning every 2 hours, high fall risk."
//
// Mitch asked for it on 2026-09-14 and set the rules; they are reproduced in
// PROMPT below, verbatim where it matters.
//
// ── WHY THE FUNCTION FETCHES THE DATA ITSELF ────────────────────────────────
//
// The obvious design is: the browser reads the care needs and posts them here
// to be summarised. This deliberately does NOT do that.
//
// Client care detail — mobility, continence, cognition — is the most
// sensitive thing either app holds. The dashboard has no login. If the
// browser had to hold the raw text to send it, that text would be readable by
// anyone with the site URL, forever, whether or not anybody opened a text
// composer. Instead this function reads Concierge directly and returns ONLY
// the finished line. The raw clinical record never crosses into the browser
// and is never stored in the Scheduling database.
//
// That is also why there is no `fields` parameter. A caller passes a client
// id and gets a sentence. It cannot ask for anything else.
//
// ── THE MEDICATION RULE IS ENFORCED BY INPUT, NOT BY ASKING ─────────────────
//
// Mitch: "Do NOT include medications" — an absolute rule, whatever happens.
// A prompt instruction alone would be a request. So:
//
//   1. Only whitelisted fields are read at all. Measured across all 18 active
//      clients on 2026-09-14: mobility, personal, adl, transferAssist,
//      ambulation, standLong and goals contain ZERO drug names or dosages.
//      medManage, routineAM, routinePM, routineDay, feeding and `other` all
//      do, and are never read.
//   2. `safety` is read ONLY if it passes the medication filter for that
//      client. It carries real scope boundaries ("do not do wound packing")
//      and leaks a drug name for 1 of 18, so it is included per-client rather
//      than dropped for everyone.
//   3. The OUTPUT is filtered too. If a drug name appears in the generated
//      line the line is discarded, not sent — belt and braces, because the
//      model could in principle infer one.
//
// The model therefore never sees a medication, and could not emit one
// unnoticed if it did.
//
// ── SECRETS (Supabase project secrets) ──────────────────────────────────────
//   ANTHROPIC_API_KEY          shared with devi-agent
//   CONCIERGE_SUPABASE_URL     the Client Concierge project
//   CONCIERGE_ANON_KEY        read-only anon key for it. NOT named
//                              SUPABASE_ANON_KEY_CONCIERGE: Supabase reserves
//                              the SUPABASE_ prefix and skips such secrets.
//   CARE_MODEL                 optional; falls back to CONCIERGE_MODEL
//   ALLOWED_ORIGIN             shared with devi-agent and quo
//
// A COMMIT DOES NOT DEPLOY THIS FILE:
//   npx supabase functions deploy care-brief --project-ref <ref> --no-verify-jwt

const KEY = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
const MODEL = (Deno.env.get("CARE_MODEL") ?? Deno.env.get("CONCIERGE_MODEL") ?? "claude-opus-5").trim();
const CONCIERGE_URL = (Deno.env.get("CONCIERGE_SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
/* CONCIERGE_ANON_KEY, not SUPABASE_ANON_KEY_CONCIERGE: Supabase RESERVES the
   SUPABASE_ prefix for project secrets and silently skips anything that uses
   it - "Env name cannot start with SUPABASE_, skipping". The Netlify side
   still calls the same value SUPABASE_ANON_KEY_CONCIERGE (Netlify has no such
   rule), so that name is accepted as a fallback for local runs. */
const CONCIERGE_KEY = (Deno.env.get("CONCIERGE_ANON_KEY") ??
                       Deno.env.get("SUPABASE_ANON_KEY_CONCIERGE") ?? "").trim();
const ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

const API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_MS = 30000;
/* TWO numbers, and the gap between them is deliberate. TARGET is what the
   model is asked for; MAX_LINE is what is accepted. Asking for the number you
   will enforce leaves no room to finish a sentence, and the first live run
   produced a line ending "...stay in" — cut off mid-clause at 188 characters
   against a 200 cap. Aim short, accept a little over. */
const TARGET_LINE = 170;
const MAX_LINE = 200;                     // characters; ~1 extra SMS segment
const RATE_MAX = 120;
const RATE_TOTAL = 600;
const RATE_WINDOW_MS = 60 * 60 * 1000;

/* Fields that may be read. Measured, not guessed — see the header. */
const SAFE_FIELDS = ["mobility", "personal", "adl", "transferAssist", "ambulation", "standLong"];
/* Read only when it passes the medication filter for that client. */
const CONDITIONAL_FIELDS = ["safety"];
/* Structured columns beside careNeeds. Not free text, so nothing to leak. */
const SAFE_COLUMNS = ["fallRisk", "cognitive", "hospice"];

/* Deliberately broad. A false positive costs a scheduler one manual edit; a
   false negative puts a drug name on a caregiver's phone. */
const MED_RE = new RegExp(
  "\\b(mg|mcg|ml|dosage|dose|dosing|tablet|capsule|bid|tid|qid|prn|po|" +
  "insulin|warfarin|eliquis|coumadin|lasix|bumex|diltiazem|metoprolol|lisinopril|" +
  "gabapentin|oxycodone|hydrocodone|tylenol|acetaminophen|ibuprofen|aspirin|" +
  "statin|metformin|prednisone|furosemide|glucose|medication|meds)\\b", "i");

// --- CORS (same shape as devi-agent and quo) ---------------------------------
function normOrigin(s: string): string { return s.trim().replace(/\/+$/, ""); }
function originAllowed(origin: string): boolean {
  if (!origin) return false;
  const o0 = normOrigin(origin);
  return ORIGINS.some((raw) => {
    const o = normOrigin(raw);
    if (o === "*" || o === o0) return true;
    const i = o.indexOf("*");
    if (i < 0) return false;
    const head = o.slice(0, i), tail = o.slice(i + 1);
    if (!o0.startsWith(head) || !o0.endsWith(tail)) return false;
    if (o0.length < head.length + tail.length) return false;
    const mid = o0.slice(head.length, o0.length - tail.length);
    return !mid.includes(".") && !mid.includes("/");
  });
}
function corsHeaders(origin: string): Record<string, string> {
  const allowAll = ORIGINS.length === 1 && ORIGINS[0] === "*";
  const ok = allowAll || originAllowed(origin);
  if (!ok) return {};
  return {
    "access-control-allow-origin": allowAll ? "*" : origin,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-max-age": "86400",
    ...(allowAll ? {} : { vary: "Origin" }),
  };
}
const json = (cors: Record<string, string>, status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" },
  });

// --- rate limit (only an ALLOWED request is counted, so the window drains) ---
const hits = new Map<string, number[]>();
let all: number[] = [];
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = all.filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_TOTAL) { all = recent; return true; }
  const seen = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (seen.length >= RATE_MAX) { hits.set(ip, seen); all = recent; return true; }
  recent.push(now); all = recent;
  seen.push(now); hits.set(ip, seen);
  if (hits.size > 5000) [...hits.keys()].slice(0, 1000).forEach((k) => hits.delete(k));
  return false;
}

/* A stable fingerprint of the source text, so a cached line can be checked
   against the record it was written from. Same idea as Concierge's srcHash.
   Not a security hash — just change detection. */
function srcHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* The one client record, straight from Concierge. */
async function fetchClient(axisId: string) {
  const u = CONCIERGE_URL + "/rest/v1/concierge_records?type=eq.clients&select=rid,data&limit=200";
  const r = await fetch(u, {
    headers: { apikey: CONCIERGE_KEY, Authorization: "Bearer " + CONCIERGE_KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error("Concierge returned HTTP " + r.status + ".");
  const rows = await r.json() as Array<{ rid: string; data: Record<string, unknown> }>;
  return rows.find((x) => String((x.data || {}).axisId) === String(axisId)) || null;
}

/* Everything the model is allowed to see, and nothing else. */
function gatherFacts(d: Record<string, unknown>) {
  const cn = (d.careNeeds || {}) as Record<string, unknown>;
  const facts: Record<string, string> = {};
  const skipped: string[] = [];

  for (const f of SAFE_FIELDS) {
    const v = String(cn[f] ?? "").trim();
    if (v) facts[f] = v;
  }
  for (const f of CONDITIONAL_FIELDS) {
    const v = String(cn[f] ?? "").trim();
    if (!v) continue;
    if (MED_RE.test(v)) { skipped.push(f); continue; }   // leaks a drug name for this client
    facts[f] = v;
  }
  for (const c of SAFE_COLUMNS) {
    const v = d[c];
    if (v == null || v === "") continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (MED_RE.test(s)) { skipped.push(c); continue; }
    facts[c] = s;
  }
  return { facts, skipped };
}

/* Mitch's rules, as the system prompt. The structure of the MESSAGE is fixed
   in index.html; this fills exactly one slot in it. */
const PROMPT = [
  "You write ONE line of care needs for a text message sent to a home-care caregiver",
  "who is being offered a shift. The caregiver must understand what they are accepting",
  "before they say yes.",
  "",
  "OUTPUT: a single line of about " + TARGET_LINE + " characters and never more than " + MAX_LINE + ",",
  "plain sentence case,",
  "comma-separated phrases, ending with a full stop. No bullet points, no headings,",
  "no preamble, no explanation, no quotation marks. Output the line and nothing else.",
  "",
  "INCLUDE, in this order of priority, only what the supplied facts actually state:",
  "  1. mobility and transfer level (wheelchair, hoyer, hands-on, standby)",
  "  2. two-person assist, if the facts say so",
  "  3. toileting, continence and personal care (bathing, dressing)",
  "  4. repositioning or turning schedules",
  "  5. dementia or behaviour concerns that affect how the caregiver works",
  "  6. hospice or end-of-life care",
  "  7. fall risk and other safety precautions",
  "",
  "RULES:",
  "- Use ONLY the facts supplied below. Do not infer, assume, generalise or add anything.",
  "- NEVER mention any medication, drug name, dose or medication task. Not once, in any form.",
  "- Do not include diagnoses, surgeries, medical history or clinical detail unless it",
  "  directly changes what the caregiver must physically do or watch for.",
  "- Do not name the client or any person.",
  "- NAME THE ACTUAL TASKS. Write \"toileting, bathing and dressing\", never an umbrella",
  "  term like \"personal care\", \"ADLs\", \"full care\" or \"assistance as needed\".",
  "  A caregiver cannot decide whether they can take a shift from a category name;",
  "  they can decide from the tasks. This is the whole purpose of the line.",
  "- Omit anything the facts do not state. A shorter line is correct; an invented one is not.",
  "- Finish the sentence. A complete short line beats a longer one that runs out mid-clause.",
  "- If there is more than will fit, keep the highest-priority items and drop the rest.",
  "- Write plain ASCII only: no en dashes, em dashes, curly quotes or ellipses.",
  "- If the facts contain nothing a caregiver needs in order to decide, output exactly: NONE",
].join("\n");

async function summarise(facts: Record<string, string>, nudge?: string) {
  /* MAX_TOKENS INCLUDES THINKING, and this model thinks by default. The
     budget is spent on reasoning FIRST, so a figure sized for the output —
     one line — returns HTTP 200 with an empty text block and nothing to show
     for it. CLAUDE.md records this exact trap on devi-agent, where 64 tokens
     produced an empty answer and MIN_TOKENS=1024 was the fix.

     1024 was not enough HERE. A care record runs to several thousand
     characters and the reasoning over it consumed the whole budget: on the
     first live run 4 of 18 clients came back empty and 3 more were cut off
     mid-sentence. 4096 leaves the thinking room to finish. The output is one
     line either way, so this costs almost nothing per call. */
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 4096,
    system: PROMPT,
    messages: [{
      role: "user",
      content: "Facts recorded for this client:\n\n" +
        Object.entries(facts).map(([k, v]) => "- " + k + ": " + v).join("\n") +
        (nudge ? "\n\n" + nudge : ""),
    }],
  };
  const r = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await r.json().catch(() => null) as Record<string, unknown> | null;
  if (!r.ok) {
    const e = (data?.error as { message?: string })?.message;
    throw new Error(e || ("Anthropic returned HTTP " + r.status + "."));
  }
  const parts = (data?.content as Array<{ type: string; text?: string }>) || [];
  const text = parts.filter((p) => p.type === "text").map((p) => p.text || "").join("").trim();
  /* stop_reason is the diagnosis when the text is empty — "max_tokens" means
     the thinking ate the budget, which is a different problem from a refusal
     and needs a different fix. Surface it rather than reporting "nothing". */
  if (!text) {
    const why = String(data?.stop_reason ?? "unknown");
    throw new Error(why === "max_tokens"
      ? "The model spent its whole budget thinking and returned no text (stop_reason: max_tokens)."
      : "The model returned no text (stop_reason: " + why + ").");
  }
  return text;
}

/* Everything that must be true of the line before a caregiver can see it. */
function vet(line: string): { ok: boolean; line: string; why?: string } {
  let s = String(line || "").trim();
  if (!s) return { ok: false, line: "", why: "The model returned nothing." };
  if (/^none$/i.test(s)) return { ok: false, line: "", why: "none-recorded" };

  /* A model asked for one line occasionally writes a preamble. Take the last
     non-empty line rather than failing the whole thing. */
  const lines = s.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  s = lines[lines.length - 1];
  s = s.replace(/^["'“‘]+|["'”’]+$/g, "").trim();

  /* ASCII only — one en dash doubles what every message of this type costs
     to send, because it forces the whole SMS out of GSM-7 into UCS-2. */
  s = s.replace(/[–—]/g, "-").replace(/[‘’]/g, "'")
       .replace(/[“”]/g, '"').replace(/…/g, "...").replace(/·/g, "-");
  if (/[^\x20-\x7E]/.test(s)) {
    return { ok: false, line: "", why: "The line contained characters that cannot be sent as a plain text message." };
  }
  /* THE ABSOLUTE RULE. Input whitelisting should make this unreachable; it is
     here because "should" is not good enough when the failure lands on a
     caregiver's phone. */
  if (MED_RE.test(s)) {
    return { ok: false, line: "", why: "The generated line mentioned medication, so it was discarded." };
  }
  if (s.length > MAX_LINE) {
    return { ok: false, line: "", why: "The line came back at " + s.length + " characters; the limit is " + MAX_LINE + "." };
  }
  return { ok: true, line: s };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!Object.keys(cors).length) return json({}, 403, { ok: false, error: "origin not allowed: " + (origin || "(none sent)") });
  /* READ-ONLY. This function summarises; it changes nothing anywhere. */
  if (req.method !== "GET") return json(cors, 405, { ok: false, error: "Only GET is supported." });

  const qs = new URL(req.url).searchParams;
  if (qs.get("action") === "status") {
    return json(cors, 200, {
      ok: true,
      configured: !!(KEY && CONCIERGE_URL && CONCIERGE_KEY),
      model: MODEL,
      missing: [!KEY && "ANTHROPIC_API_KEY", !CONCIERGE_URL && "CONCIERGE_SUPABASE_URL",
                !CONCIERGE_KEY && "CONCIERGE_ANON_KEY"].filter(Boolean),
      safeFields: SAFE_FIELDS, conditionalFields: CONDITIONAL_FIELDS, safeColumns: SAFE_COLUMNS,
      maxLine: MAX_LINE,
    });
  }

  if (!KEY || !CONCIERGE_URL || !CONCIERGE_KEY) {
    return json(cors, 503, {
      ok: false,
      error: "Care-needs summaries are not configured on the server.",
      missing: [!KEY && "ANTHROPIC_API_KEY", !CONCIERGE_URL && "CONCIERGE_SUPABASE_URL",
                !CONCIERGE_KEY && "CONCIERGE_ANON_KEY"].filter(Boolean),
    });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return json(cors, 429, { ok: false, error: "too many requests - try again shortly" });

  const axisId = (qs.get("clientAxisId") || "").trim();
  if (!/^\d{1,9}$/.test(axisId)) return json(cors, 400, { ok: false, error: "clientAxisId must be an AxisCare client id." });

  let rec;
  try { rec = await fetchClient(axisId); }
  catch (err) { return json(cors, 502, { ok: false, error: (err as Error)?.message || "Could not reach Concierge." }); }
  if (!rec) return json(cors, 404, { ok: false, error: "Concierge has no record for that client." });

  const { facts, skipped } = gatherFacts(rec.data);
  if (!Object.keys(facts).length) {
    return json(cors, 200, {
      ok: true, line: null, state: "none-recorded", skipped,
      note: "Concierge records no mobility, personal-care or safety detail for this client.",
    });
  }

  const hash = srcHash(JSON.stringify(facts));
  let raw;
  try { raw = await summarise(facts); }
  catch (err) {
    const e = err as Error;
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return json(cors, timedOut ? 504 : 502, { ok: false, error: timedOut ? "The summary timed out." : e?.message });
  }

  let v = vet(raw);
  /* ONE retry, and only for length. Throwing away an otherwise good summary
     because it ran 28 characters long wastes the call and leaves the
     scheduler with nothing; asking again for a shorter one costs a second.
     A medication hit is NOT retried — that line is discarded, full stop. */
  if (!v.ok && /characters; the limit is/.test(v.why || "")) {
    try {
      const shorter = await summarise(facts,
        "Your previous answer was too long. Give the same line again in under " + TARGET_LINE +
        " characters, keeping only the highest-priority items.");
      const v2 = vet(shorter);
      if (v2.ok) v = v2;
    } catch { /* keep the original verdict */ }
  }
  if (!v.ok && v.why === "none-recorded") {
    return json(cors, 200, { ok: true, line: null, state: "none-recorded", srcHash: hash, skipped,
      note: "Nothing in this client's record is a care need a caregiver needs before accepting." });
  }
  if (!v.ok) {
    return json(cors, 200, { ok: true, line: null, state: "rejected", srcHash: hash, skipped, reason: v.why });
  }
  return json(cors, 200, {
    ok: true, line: v.line, state: "ready", srcHash: hash,
    fields: Object.keys(facts), skipped,
  });
});
