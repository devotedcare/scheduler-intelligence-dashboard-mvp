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
//   1. A NARROW SET OF FIELDS is read: mobility, personal, adl,
//      transferAssist, ambulation, standLong, safety, and the structured
//      fallRisk / cognitive / hospice columns. medManage, medInstr,
//      routineAM, routinePM, routineDay, feeding and `other` are never read
//      at all - every one of them contains drug names on this account.
//   2. EVERY field that IS read is filtered first, and a field that trips the
//      filter is dropped on its own. So a drug name in `personal` costs the
//      personal-care detail and keeps mobility and fall risk, rather than
//      losing the whole line.
//   3. The OUTPUT is filtered by the same detector, and then read by a second
//      model asked one question: does this mention a medication? A YES, an
//      unparseable answer, or a failed check all discard the line.
//
// WHAT THIS DOES AND DOES NOT GUARANTEE. Layers 1 and 2 stop what is recorded
// today; layer 3 stops what a pattern cannot describe. None of it is a proof.
// An earlier version of this comment claimed "the model therefore never sees
// a medication, and could not emit one unnoticed if it did" - that was FALSE
// when it was written. The detector behind it was a 25-name denylist that
// missed 48 of 51 realistic medication strings, and the field whitelist it
// relied on was never applied to most of the fields. A confident sentence in
// a safety comment is worth nothing without the measurement behind it; the
// measurement now lives in the test harness and should be re-run when this
// detector is touched.
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

/* ── DETECTING A MEDICATION ─────────────────────────────────────────────
   Rebuilt 2026-09-14 after an adversarial review, and the rebuild matters
   more than the original: the first version was a 25-name denylist and it
   MISSED 48 OF 51 realistic home-care medication strings. Measured, not
   estimated. Two of its own entries could never fire — `\bmg\b` cannot match
   "10mg" because there is no word boundary between a digit and a letter, and
   `\bstatin\b` cannot match "atorvastatin". It caught "10 mg" and nothing
   else people actually type.

   A LIST OF DRUG NAMES CANNOT WORK. The name space is open-ended and
   commercial; any list is out of date the week it is written. So this
   detects the parts of the space that ARE closed, and a model handles the
   rest (see medLooksClinical below):

     1. DOSE AMOUNTS - a digit followed by a unit, space optional. This is
        the single highest-signal pattern and the original got it wrong.
     2. SIG ABBREVIATIONS - bid, tid, qhs, q4h, prn, po. A closed set.
     3. FORMS, ROUTES AND DEVICES - patch, inhaler, nebuliser, oxygen,
        suppository, ointment, eye drops, syringe, sliding scale, comfort
        kit. CLOSED, and the realistic leak: the prompt asks for safety
        precautions and personal care, so "apply barrier cream after each
        episode" and "oxygen at 2L, do not adjust" are what a model would
        faithfully carry across. Every one of those passed the old regex.
     4. DRUG-NAME SUFFIX FAMILIES - -statin, -azepam, -pril, -sartan, -olol,
        -dipine, -prazole, -xaban, -codone. These are how generic names are
        constructed, so they catch drugs no list contains.
     5. A NAMED LIST, last and least, for the common ones that fit no family.

   `iv` is deliberately NOT in the sig list: case-insensitively it matches the
   "IV" in "Calvin Miller IV", and a client's own name must not trip this. */
const MED_RE = new RegExp([
  /* 1. dose amounts - "10mg", "10 mg", "0.5 ml", "2 units" */
  "\\d\\s*(mg|mcg|ug|ml|cc|gram|grams|g|unit|units|iu|meq|tsp|tbsp)\\b",
  /* 2. sig abbreviations */
  "\\b(bid|tid|qid|qd|qod|qhs|qam|qpm|q\\d+h|prn|po|sl|im|subq|sq|npo)\\b",
  /* 3. forms, routes, devices - closed, and the realistic leak */
  "\\b(tablets?|capsules?|pills?|pillbox|pill box|blister pack|suppositor\\w*|" +
  "inhalers?|nebuli[sz]\\w*|oxygen|patch|patches|transdermal|sublingual|" +
  "subcutaneous|intravenous|topical|injections?|injectable|syringes?|vials?|lozenges?|" +
  "troche|ointments?|nasal spray|syrup|elixir|" +
  /* "glaucoma drops" is a medication and was passing: the pattern only knew
     "eye drops". A bare \bdrops\b would fire on "he drops things", so the
     qualifiers are listed instead. */
  "(eye|ear|nasal|glaucoma|antibiotic|steroid|lubricating|prescription|medicated)\\s*drops|" +
  "sliding scale|comfort kit|medication administration record)\\b",
  /* the standalone acronym, case-sensitive so "Mar" in a name is safe */
  "\\bMAR\\b",
  /* 4. explicit medication words */
  "\\b(medication\\w*|medicine\\w*|meds|drugs?|prescri\\w+|pharmac\\w+|dosages?|" +
  "dosing|administer\\w*|refill\\w*)\\b",
  /* 5. generic-name suffix families */
  /* {2,} not {3,}: losartan is lo+sartan, and it is the commonest ARB on this
     roster. [aeiou]lol not olol: only metoprolol and atenolol actually end
     "olol" - carvedilol ends "ilol" and labetalol "alol", so the literal
     suffix was catching about a third of the beta blockers. */
  "\\w{2,}(statins?|azepam|azolam|zolam|pril|sartan|[aeiou]lol|dipine|prazole|tidine|" +
  "cillin|mycin|oxacin|floxacin|triptan|codone|morphone|fentanyl|fentanil|" +
  "barbital|phylline|terol|sone|olone|parin|xaban|gliptin|glutide|semide|" +
  "thiazide|caine|profen|dronate)\\b",
  /* 6. the common names that fit no family */
  "\\b(insulin|warfarin|coumadin|eliquis|xarelto|plavix|aspirin|tylenol|" +
  "acetaminophen|ibuprofen|morphine|dilaudid|ativan|xanax|valium|seroquel|" +
  "haldol|haloperidol|lasix|bumex|digoxin|lithium|synthroid|levothyroxine|" +
  "metformin|jardiance|keppra|aricept|donepezil|memantine|namenda|flomax|" +
  "oxybutynin|senna|colace|miralax|dulcolax|nitroglycerin|albuterol|" +
  "lantus|humalog|heparin|lovenox|zoloft|lexapro|prozac|trazodone|" +
  "tramadol|gabapentin|lyrica|pregabalin|atropine|scopolamine|glycopyrrolate|" +
  "glucose)\\b",
].join("|"));
const MED_FLAGS = "i";
const MED = () => new RegExp(MED_RE.source, MED_FLAGS);
const hasMed = (s: string) => MED().test(String(s || ""));

/* FILTER BY SENTENCE, NOT BY FIELD.
   Dropping a whole field over one word is correct but blunt, and it was
   costing real care detail. Duane Georgeson's personal-care field reads:

     "Assist with dressing. Velcro compression wraps. Changing briefs about
      2-5x daily. Wipe his eyes after glaucoma drops. Soft neck brace at
      times."

   One sentence of that is a medication and four are exactly what a caregiver
   needs before accepting a shift. Dropping the field lost all five and left
   the line reading "walker, stand-by assist, high fall risk" for a client who
   needs briefs changed five times a day.

   So the offending SENTENCE goes and the rest stays. If nothing survives, the
   field is dropped as before - the rule is unchanged, only the granularity. */
function stripMedSentences(text: string): { kept: string; dropped: number } {
  const parts = String(text || "").split(/(?<=[.!?])\s+|\n+/);
  const keep: string[] = [];
  let dropped = 0;
  for (const p of parts) {
    const s = p.trim();
    if (!s) continue;
    if (hasMed(s)) { dropped++; continue; }
    keep.push(s);
  }
  return { kept: keep.join(" ").trim(), dropped };
}

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

  /* EVERY FIELD IS FILTERED. The first version exempted SAFE_FIELDS on the
     strength of one measurement - "zero drug names across 18 clients on
     2026-09-14" - which is a fact about a Tuesday, not a property of the
     system. The moment a scheduler types "unsteady in the hour after her
     Lasix" into Concierge's personal-care box, an unfiltered field hands it
     straight to the model, and the header's claim that the model never sees
     a medication becomes false with no code having changed.

     Filtering is PER FIELD, not per client: a drug name in the personal field drops
     that field alone and keeps mobility and fall risk, so the caregiver still gets
     the line that matters instead of nothing at all. */
  for (const f of SAFE_FIELDS.concat(CONDITIONAL_FIELDS)) {
    const v = String(cn[f] ?? "").trim();
    if (!v) continue;
    const { kept, dropped } = stripMedSentences(v);
    if (!kept) { skipped.push(f); continue; }          /* nothing survived */
    if (dropped) skipped.push(f + " (" + dropped + " sentence" + (dropped === 1 ? "" : "s") + ")");
    facts[f] = kept;
  }
  for (const c of SAFE_COLUMNS) {
    const v = d[c];
    if (v == null || v === "") continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (hasMed(s)) { skipped.push(c); continue; }
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

/* THE BACKSTOP A REGEX CANNOT BE.
   Dose formats, sig abbreviations, forms and suffix families are closed sets
   and MED_RE handles them. BRAND NAMES ARE NOT: Xarelto, Seroquel, Jardiance
   and whatever launches next month match no pattern and appear on no list
   that stays current. So the finished line is also read by a model, asked one
   question, and discarded on a YES.

   A small fast model, because the question is easy and this sits on a path
   that already takes several seconds. If the check itself fails - timeout,
   outage, anything - the line is DISCARDED, not passed: an unverifiable line
   is treated exactly like a failed one. */
const CHECK_MODEL = (Deno.env.get("CARE_CHECK_MODEL") ?? "claude-haiku-4-5-20251001").trim();

async function mentionsMedication(line: string): Promise<{ hit: boolean; checked: boolean }> {
  const body = {
    model: CHECK_MODEL,
    max_tokens: 16,
    system: "You check one sentence for a home-care agency. Answer with exactly one word, YES or NO, " +
      "and nothing else.\n\n" +
      "A MEDICATION is a substance given to or applied to the person. Answer YES if the sentence " +
      "names or refers to any of these:\n" +
      "- a drug or medicine by name, brand or generic\n" +
      "- a dose, strength, frequency or medication schedule\n" +
      "- giving, administering, reminding about, refilling or managing medication\n" +
      "- a substance given as treatment: oxygen, medicated creams or ointments, eye, ear or " +
      "glaucoma drops, medicated patches, inhalers, nebuliser solutions, suppositories, injections\n" +
      "- phrases such as 'give 2 units', 'sliding scale' or 'comfort kit'\n\n" +
      /* The negatives matter as much as the positives. Without them the
         checker called "Velcro compression wraps" and "soft neck brace"
         medication for one real client, four times in six - equipment a
         person WEARS is not a substance they are GIVEN. */
      "EQUIPMENT AND GARMENTS ARE NOT MEDICATION. Answer NO for anything worn, used or pushed " +
      "that contains no medicine: compression wraps or stockings, braces, splints, slings, " +
      "walkers, wheelchairs, canes, Hoyer lifts, briefs, pads, catheters, oxygen TUBING as " +
      "equipment rather than the oxygen itself, hearing aids, glasses.\n\n" +
      "Also answer NO if the sentence only describes mobility, transfers, bathing, dressing, " +
      "toileting, continence care, repositioning, skin checks, supervision, cognition, behaviour " +
      "or fall risk.",
    messages: [{ role: "user", content: line }],
    /* TEMPERATURE 0. This is a yes/no classifier, not a writer. At the
       default the SAME sentence came back YES three times and NO twice in
       six tries, so a client kept their care line or lost it on a coin flip
       - the worst kind of failure, because nobody can reproduce it. */
    temperature: 0,
  };
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { hit: true, checked: false };
    const data = await r.json().catch(() => null) as Record<string, unknown> | null;
    const parts = (data?.content as Array<{ type: string; text?: string }>) || [];
    const said = parts.filter((p) => p.type === "text").map((p) => p.text || "").join("").trim().toUpperCase();
    if (said.startsWith("NO")) return { hit: false, checked: true };
    if (said.startsWith("YES")) return { hit: true, checked: true };
    return { hit: true, checked: false };            /* unparseable - refuse */
  } catch {
    return { hit: true, checked: false };            /* unverifiable - refuse */
  }
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
  if (hasMed(s)) {
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

  /* LAST GATE. Everything above is pattern matching; this is the only step
     that can recognise a brand name nobody listed. */
  const mc = await mentionsMedication(v.line);
  if (mc.hit) {
    return json(cors, 200, {
      ok: true, line: null, state: "rejected", srcHash: hash, skipped,
      reason: mc.checked
        ? "The generated line referred to medication, so it was discarded."
        : "The line could not be checked for medication, so it was not used.",
    });
  }

  return json(cors, 200, {
    ok: true, line: v.line, state: "ready", srcHash: hash,
    fields: Object.keys(facts), skipped, medChecked: true,
  });
});
