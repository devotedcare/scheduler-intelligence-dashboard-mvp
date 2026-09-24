// caregiver-about-summary  ·  "About [Name] — AI Summary"  ·  (Supabase Edge Function)
//
// WHAT THIS IS FOR
//
// Asked for 2026-09-24: turn the caregiver profile's "About" line -- one
// computed sentence built from three or four fields -- into a real judgement
// a scheduler can act on, read from EVERYTHING on file about this caregiver:
// profile, skills, assignment history, care notes, feedback, complaints,
// incidents, attendance (both sources -- see below), shift declines,
// availability, work preferences, languages, driving, travel limits,
// dementia/hospice/transfer/behavioral/overnight experience, how long they
// stayed on past cases, recurring patterns. Six sections, fixed shape:
//
//   overall                    2-4 sentences
//   strongestExperience[]      only what the data actually supports
//   bestFit[]                  what kind of client/shift, and WHY
//   schedulingConsiderations[] driving, travel, availability, work prefs, limits
//   reliability[]              factual, from attendance/call-offs/no-shows/
//                              lateness -- never "reliable"/"unreliable"
//                              without the facts that say so
//   importantHistory[]         meaningful feedback/incidents/problems/
//                              strengths -- never routine filler
//
// ── THIS FUNCTION IS BUILT DIFFERENTLY FROM CARENOTES-SUMMARY / CARE-BRIEF /
//    CARE-ALERT-SUMMARY, AND THAT IS DELIBERATE ──────────────────────────────
//
// Those three have the function read its OWN data (care_notes, by an id the
// browser names), specifically so the browser can never hand the function
// invented text. That pattern cannot work here: assignment history -- "how
// long did they stay on this case", "what are they working now" -- comes
// from AxisCare visit history, fetched by the browser through the NETLIFY
// AxisCare proxy. A Supabase Edge Function has no path to AxisCare at all --
// nothing server-side can re-derive it, or any of it.
//
// So the browser assembles the whole dossier (cgAiDigestText() in
// index.html) and sends it whole. This is the SAME trade-off devi-agent
// already makes for the entire scheduling board (deviContext()) -- a
// browser-built context bundle sent to Claude for read-only text generation,
// no tools, nothing written back except this function's own cache row. It is
// not a new hole: this dashboard has no per-person login (an accepted MVP
// posture -- see CLAUDE.md, "Known and accepted"), and every fact in the
// dossier already renders somewhere on this same, PIN-gated profile page.
//
// ── THE CACHE KEY IS COMPUTED HERE, FROM THE DOSSIER ITSELF ─────────────────
//
// The browser never sends a signature -- it is hashed server-side from the
// `digest` text the request actually carries. Two requests with a
// byte-identical dossier always hash the same, so a caregiver nobody's
// dossier has changed for costs nothing on a repeat view. The browser keeps
// its OWN, separate, purely-local fingerprint (cgFnv1a() in index.html) just
// to decide whether to bother asking again at all -- that one does not need
// to match this one and never has to.
//
// ── ONE ROW PER CAREGIVER, OVERWRITTEN ───────────────────────────────────────
//
// Unlike carenotes-summary/care-alert-summary (one row per note/block,
// because each is a small, independent fact), there is exactly one "About"
// per caregiver, so public.caregiver_about_summaries is keyed by caregiver id
// and each generation replaces the previous row outright.
//
// ── THE MODEL HAS NO TOOLS. NOTHING IT WRITES REACHES ANY OTHER RECORD ──────
//
// It reads the dossier and returns six pieces of text. Same safety argument
// as devi-agent, comms-summary, carenotes-summary and care-alert-summary.
//
// ── PHI ───────────────────────────────────────────────────────────────────
//
// Same basis as the sibling functions: "The Anthropic API that we have has
// the PHI contract." (Carlo, 2026-09-23.) Contact details are redacted
// before the dossier leaves this function, and again over the output.
//
// ── SECRETS (Supabase project secrets) ──────────────────────────────────────
//   ANTHROPIC_API_KEY   shared with devi-agent, care-brief, comms-summary, carenotes-summary, carealerts-summary
//   ALLOWED_ORIGIN       shared with all of them
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   provided by Supabase itself
//   CGABOUT_MODEL         optional; default claude-haiku-4-5
//   CGABOUT_EFFORT        optional; default low. NOT sent to a Haiku model (400)
//
// No new secret is needed. Switching model needs no code change and no redeploy:
//   npx supabase secrets set CGABOUT_MODEL=claude-sonnet-5 --project-ref gdzgoyawavffjdjpjbfz
//
// A COMMIT DOES NOT DEPLOY THIS FILE:
//   npx supabase functions deploy caregiver-about-summary --project-ref gdzgoyawavffjdjpjbfz --no-verify-jwt
//
// The table is created by supabase/caregiver-about-summaries.sql (also
// section 10e of schema.sql). Run it against the live database before this
// function has anywhere to write.

const ANTHROPIC_KEY = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
const DB_URL = (Deno.env.get("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
const DB_KEY = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
const ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

const MODEL = (Deno.env.get("CGABOUT_MODEL") || "claude-haiku-4-5").trim();
const EFFORT = (Deno.env.get("CGABOUT_EFFORT") || "low").trim();
const SEND_EFFORT = !!EFFORT && !/haiku/i.test(MODEL);

/* Bump when the prompt or the bullet rules change in a way that should
   rewrite summaries already saved. They are rewritten on their next open. */
const PROMPT_VERSION = 1;

const API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_MS = 60000;
const TABLE = "caregiver_about_summaries";

/* The dossier is capped at 20,000 characters in index.html already; this is
   a second, independent ceiling so a request from anywhere else cannot turn
   into an enormous one. */
const MAX_DIGEST_CHARS = 24000;

const MAX_OVERALL_CHARS = 900;
const MAX_BULLET_CHARS = 220;
const MAX_BULLETS: Record<string, number> = {
  strongestExperience: 6, bestFit: 4, schedulingConsiderations: 6,
  reliability: 6, importantHistory: 6,
};

const RATE_MAX = 300;
const RATE_TOTAL = 1500;
const GEN_HOURLY_CAP = 60;      // model calls (i.e. CAREGIVERS re-summarised) per isolate per hour
const WINDOW_MS = 60 * 60 * 1000;

class UpstreamError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// --- CORS (same shape as every sibling function) -----------------------------
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
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    ...(allowAll ? {} : { vary: "Origin" }),
  };
}
const json = (cors: Record<string, string>, status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" },
  });

// --- rate limits --------------------------------------------------------------
const hits = new Map<string, number[]>();
let all: number[] = [];
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = all.filter((t) => now - t < WINDOW_MS);
  if (recent.length >= RATE_TOTAL) { all = recent; return true; }
  const seen = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (seen.length >= RATE_MAX) { hits.set(ip, seen); all = recent; return true; }
  recent.push(now); all = recent;
  seen.push(now); hits.set(ip, seen);
  if (hits.size > 5000) [...hits.keys()].slice(0, 1000).forEach((k) => hits.delete(k));
  return false;
}
const gens: number[] = [];
function genCapped(): boolean {
  const now = Date.now();
  while (gens.length && now - gens[0] >= WINDOW_MS) gens.shift();
  if (gens.length >= GEN_HOURLY_CAP) return true;
  gens.push(now);
  return false;
}

/* Two requests for the same caregiver within a few seconds of each other
   (two schedulers, or one profile re-rendering) wait on the same pass. */
const inflight = new Map<string, Promise<Out>>();

// --- text ---------------------------------------------------------------------

function redact(s: string): string {
  return String(s ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email address]")
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, "[link]")
    .replace(/\+1\d{10}\b/g, "[phone number]")
    .replace(/\b1[2-9]\d{9}\b/g, "[phone number]")
    .replace(/(?:\+?1[\s.\-\/]?)?\(?\b[2-9]\d{2}\)?[\s.\-\/]?\d{3}[\s.\-\/]?\d{4}\b/g, "[phone number]");
}

/* Same FNV-1a fold as the sibling functions -- only has to change when the
   content changes, not be cryptographic, and stable across isolates. This is
   the AUTHORITATIVE cache key: computed from the digest the request actually
   carries, never trusted from the caller. */
function sig(parts: string[]): string {
  const s = parts.join("\u0000");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return s.length.toString(36) + "-" + h.toString(36);
}

// --- the database ---------------------------------------------------------------

type Sections = {
  overall: string;
  strongestExperience: string[]; bestFit: string[]; schedulingConsiderations: string[];
  reliability: string[]; importantHistory: string[];
};
type SavedRow = { id: string; sections: Sections; source_sig: string; model: string; prompt_version: number };
type Out = { sections: Sections; model: string; generated: boolean };

function dbHeaders(extra?: Record<string, string>): Record<string, string> {
  return { apikey: DB_KEY, Authorization: "Bearer " + DB_KEY, Accept: "application/json", ...(extra ?? {}) };
}

async function savedFor(caregiverId: string): Promise<SavedRow | undefined> {
  try {
    const r = await fetch(DB_URL + "/rest/v1/" + TABLE +
      "?select=id,sections,source_sig,model,prompt_version&id=eq." + encodeURIComponent(caregiverId),
      { headers: dbHeaders(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) { console.warn("[caregiver-about-summary] read HTTP " + r.status); return undefined; }
    const rows = await r.json() as SavedRow[];
    return rows[0];
  } catch (e) { console.warn("[caregiver-about-summary] read failed:", (e as Error)?.message); return undefined; }
}

async function dbPut(row: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch(DB_URL + "/rest/v1/" + TABLE + "?on_conflict=id", {
      method: "POST",
      headers: dbHeaders({ "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) console.warn("[caregiver-about-summary] write HTTP " + r.status + ": " + (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) { console.warn("[caregiver-about-summary] write failed:", (e as Error)?.message); return false; }
}

// --- the model -------------------------------------------------------------------

const PROMPT = [
  "You write the \"About\" summary for a caregiver's profile on a home-care scheduling desk.",
  "You are given a DOSSIER: everything on file about ONE caregiver, assembled from their profile,",
  "skills, assignment history, care notes, feedback, complaints, incidents, attendance, shift-offer",
  "history, availability, work preferences, languages, driving, travel limits and ratings.",
  "",
  "GOAL: a scheduler who reads this should immediately understand what kind of caregiver this is,",
  "what clients they are experienced with, what to know before assigning them, and whether anything",
  "in their history is worth checking first -- WITHOUT reading the raw dossier.",
  "",
  "Produce exactly six sections as JSON:",
  "",
  '  "overall"                    2 to 4 sentences: what kind of caregiver this appears to be,',
  "                                 based on their ACTUAL recorded history. Not a label -- an",
  "                                 explanation.",
  '  "strongestExperience"        an array of short bullets naming ONLY the conditions/skills the',
  "                                 dossier actually supports (e.g. dementia, hospice, transfers,",
  "                                 two-person assist, behavioral clients, overnight, facility",
  "                                 experience). Empty array if nothing stands out.",
  '  "bestFit"                    an array of short bullets on what kind of clients or shifts this',
  "                                 caregiver appears best suited for, and WHY -- tie each one to a",
  "                                 specific fact (experience, ratings, feedback, preferences).",
  '  "schedulingConsiderations"   an array of short bullets: driving/license status, availability',
  "                                 or travel limits, meaningful work preferences, and any",
  "                                 assignment limitation a scheduler needs to know before assigning",
  "                                 them.",
  '  "reliability"                an array of short, FACTUAL bullets built from attendance,',
  "                                 call-offs, no-shows, lateness and shift-offer history. Name",
  "                                 recurring patterns ONLY when several records actually support",
  "                                 one (e.g. \"three late arrivals in the last month\", not \"is",
  "                                 sometimes late\"). If there is not enough history to see a",
  "                                 pattern, say that plainly instead of guessing at one.",
  '  "importantHistory"           an array of short bullets: meaningful client/family feedback,',
  "                                 incidents, assignment problems, strengths, or recurring",
  "                                 concerns. Never routine information that does not help",
  "                                 scheduling -- a quiet, uneventful record needs no bullet here.",
  "",
  "OUTPUT: a single JSON object and nothing else. No markdown, no code fence, no preamble:",
  '{"overall":"...","strongestExperience":["..."],"bestFit":["..."],"schedulingConsiderations":["..."],"reliability":["..."],"importantHistory":["..."]}',
  "",
  "HARD RULES:",
  "- NEVER invent information. Every claim must trace to something the dossier actually says. A",
  "  short dossier gets a short, honest summary -- not a padded one.",
  "- NEVER call the caregiver \"good\", \"bad\", \"reliable\" or \"unreliable\" (or any close synonym)",
  "  without the specific facts, in the same bullet, that support it.",
  "- The dossier may hand you TWO separately-labelled attendance sources that do not fully overlap.",
  "  If they tell a different story, SAY they disagree rather than silently picking one to believe.",
  "- If any other part of the dossier conflicts with another part, say plainly that the records",
  "  conflict rather than choosing one silently.",
  "- The dossier explicitly does not know WHY an assignment ended unless a scheduler note says so.",
  "  Do not guess a reason. You may still note the pattern itself (e.g. several short assignments)",
  "  without asserting a cause.",
  "- Missing information is a fact worth stating, not something to skip past. Say plainly when a",
  "  section has little or nothing to go on (e.g. \"No attendance history is on file\"), rather than",
  "  omitting the section or writing around the gap.",
  "- Do not give medical advice, and do not speculate about anything not explicitly in the dossier.",
  "- Contact details already appear as [phone number], [email address] or [link]. Do not mention",
  "  those placeholders in a bullet.",
].join("\n");

async function askClaude(digest: string): Promise<Sections> {
  const content = "DOSSIER:\n\n" + redact(digest);

  /* max_tokens INCLUDES THINKING -- the trap every sibling function
     documents. A budget sized for six short sections alone returns HTTP 200
     with an empty text block the instant CGABOUT_MODEL points at a model
     that thinks by default. */
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 16000,
    system: PROMPT,
    messages: [{ role: "user", content }],
  };
  if (SEND_EFFORT) body.output_config = { effort: EFFORT };   // no temperature: Sonnet 5 / Opus 5 reject it

  const r = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": ANTHROPIC_VERSION },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await r.json().catch(() => null) as any;
  if (!r.ok) throw new UpstreamError(502, "Anthropic: " + (data?.error?.message || ("HTTP " + r.status)));
  if (data?.stop_reason === "refusal") throw new UpstreamError(502, "The model declined to summarise this caregiver.");
  const text = ((data?.content ?? []) as any[]).filter((p) => p?.type === "text").map((p) => p.text || "").join("").trim();
  console.info("[caregiver-about-summary] " + MODEL +
    " in=" + (data?.usage?.input_tokens ?? "?") + " out=" + (data?.usage?.output_tokens ?? "?"));
  if (!text) {
    throw new UpstreamError(502, data?.stop_reason === "max_tokens"
      ? "The model spent its whole budget thinking and returned no text (stop_reason: max_tokens)."
      : "The model returned no text (stop_reason: " + String(data?.stop_reason ?? "unknown") + ").");
  }

  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* fall through */ } }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UpstreamError(502, "The model did not return a JSON object.");
  }

  const cleanBullet = (s: string) => redact(s).replace(/\s*\n+\s*/g, " ").replace(/^["'"'•\-]+|["'"']+$/g, "").trim();
  const arr = (v: unknown, cap: number): string[] => {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const item of v) {
      if (typeof item !== "string") continue;
      const s = cleanBullet(item);
      if (!s || s.length > MAX_BULLET_CHARS) continue;
      out.push(s);
      if (out.length >= cap) break;
    }
    return out;
  };

  const overallRaw = typeof parsed.overall === "string" ? cleanBullet(parsed.overall) : "";
  if (!overallRaw) throw new UpstreamError(502, "The model did not return an overall summary.");

  return {
    overall: overallRaw.length > MAX_OVERALL_CHARS ? overallRaw.slice(0, MAX_OVERALL_CHARS).trim() : overallRaw,
    strongestExperience: arr(parsed.strongestExperience, MAX_BULLETS.strongestExperience),
    bestFit: arr(parsed.bestFit, MAX_BULLETS.bestFit),
    schedulingConsiderations: arr(parsed.schedulingConsiderations, MAX_BULLETS.schedulingConsiderations),
    reliability: arr(parsed.reliability, MAX_BULLETS.reliability),
    importantHistory: arr(parsed.importantHistory, MAX_BULLETS.importantHistory),
  };
}

// --- one caregiver -----------------------------------------------------------------

async function summariseCaregiver(caregiverId: string, digest: string): Promise<Out> {
  const s = sig([digest]);
  const saved = await savedFor(caregiverId);
  if (saved && saved.source_sig === s && saved.model === MODEL && saved.prompt_version === PROMPT_VERSION) {
    return { sections: saved.sections, model: MODEL, generated: false };
  }
  if (genCapped()) throw new UpstreamError(429, "Too many caregivers have been summarised in the last hour. Try again shortly.");
  const sections = await askClaude(digest);
  const stored = await dbPut({ id: caregiverId, sections, source_sig: s, model: MODEL, prompt_version: PROMPT_VERSION });
  /* Report what happened, not what was attempted -- a failed write still
     returns the fresh sections for THIS request (the model call is already
     paid for), but the next open will not find them cached and will pay
     again. That is the honest cost of a write failure, not a false success. */
  if (!stored) console.warn("[caregiver-about-summary] generated but failed to save for " + caregiverId);
  return { sections, model: MODEL, generated: true };
}

function missing(): string[] {
  const m: string[] = [];
  if (!ANTHROPIC_KEY) m.push("ANTHROPIC_API_KEY");
  if (!DB_URL) m.push("SUPABASE_URL");
  if (!DB_KEY) m.push("SUPABASE_SERVICE_ROLE_KEY");
  return m;
}

// --- the handler -------------------------------------------------------------------

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!Object.keys(cors).length) return json({}, 403, { ok: false, error: "origin not allowed: " + (origin || "(none sent)") });

  if (req.method === "GET") {
    if (new URL(req.url).searchParams.get("action") !== "status") {
      return json(cors, 405, { ok: false, error: "Summaries are requested with POST. GET supports only ?action=status." });
    }
    return json(cors, 200, {
      ok: true, configured: missing().length === 0, missing: missing(),
      model: MODEL, effort: SEND_EFFORT ? EFFORT : "not sent (" + MODEL + " does not accept it)",
      promptVersion: PROMPT_VERSION, maxDigestChars: MAX_DIGEST_CHARS,
    });
  }
  if (req.method !== "POST") return json(cors, 405, { ok: false, error: "Only POST (and GET ?action=status) are supported." });

  if (missing().length) {
    return json(cors, 503, { ok: false, error: "Caregiver summaries are not configured on the server.", missing: missing() });
  }

  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return json(cors, 429, { ok: false, error: "too many requests - try again shortly" });

  const b = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return json(cors, 400, { ok: false, error: "Send a JSON body." });

  const caregiverId = String(b.caregiverId ?? "").trim();
  if (!caregiverId) return json(cors, 400, { ok: false, error: "caregiverId is required." });
  const digest = typeof b.digest === "string" ? b.digest : "";
  if (!digest.trim()) return json(cors, 400, { ok: false, error: "digest is required and must be non-empty text." });
  if (digest.length > MAX_DIGEST_CHARS) {
    return json(cors, 413, { ok: false, error: "That dossier is " + digest.length + " characters, more than this can read in one pass (" + MAX_DIGEST_CHARS + ")." });
  }

  try {
    let p = inflight.get(caregiverId);
    if (!p) {
      p = summariseCaregiver(caregiverId, digest).finally(() => { inflight.delete(caregiverId); });
      inflight.set(caregiverId, p);
    }
    const out = await p;
    return json(cors, 200, { ok: true, sections: out.sections, model: out.model, generated: out.generated });
  } catch (err) {
    const e = err as Error & { status?: number };
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    const status = timedOut ? 504 : (e instanceof UpstreamError ? e.status : 500);
    console.warn("[caregiver-about-summary] failed:", e?.message);
    return json(cors, status, { ok: false, error: timedOut ? "Timed out reading the dossier or writing the summary." : (e?.message || "Something went wrong.") });
  }
});
