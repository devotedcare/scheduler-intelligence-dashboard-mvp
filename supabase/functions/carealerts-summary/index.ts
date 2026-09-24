// carealerts-summary  ·  "Clients Needing Attention", extracted not pasted  ·  (Supabase Edge Function)
//
// WHAT THIS IS FOR
//
// "Clients Needing Attention" used to show the caregiver's raw AxisCare note,
// cleaned and cut at 150 characters with "...". Reported back (2026-09-24):
// that is not a summary, it is the full note lightly rephrased, and most of a
// flagged note is the ROUTINE shift -- meals, vitals, small talk -- with the
// actual issue sitting in a sentence or two inside it. A scheduler should see
// what happened and what to do about it, not the caregiver's whole shift.
//
// This reads ONE flagged note at a time and returns two short bullet lists:
//   whatHappened     (1-3 bullets)  -- only the part of the note that IS the
//                                      flagged issue
//   schedulerAction  (1-2 bullets)  -- what the scheduler specifically needs
//                                      to do about THIS note, not the
//                                      category's generic checklist
//
// ── WHICH note+category is the browser's call, the CONTENT is this function's ──
//
// index.html already runs a keyword categoriser (categorizeNote() /
// CARE_CATEGORIES) over every note to decide which client is flagged and why
// -- that part is deterministic and free, and this function does not repeat
// it. The browser sends {noteId, catKey} pairs naming which alerts are on
// screen. That is the same shape as care-brief: the caller says WHICH record,
// and the function reads THAT record's own words itself and returns only
// what it produced.
//
// A noteId that is not a real care_notes row is simply dropped -- the
// browser cannot hand this function invented text, and nothing it sends
// reaches the model except a category KEY, checked against the fixed
// CATEGORIES map below. Nobody with the site URL can make this function
// summarise or spend on text of their own.
//
// ── ONE MODEL CALL PER PAGE OPEN, NOT ONE PER ALERT ─────────────────────────
//
// "Clients Needing Attention" is small on a real day (CLAUDE.md's own
// measurement of the sibling day-review: a handful of clients, not dozens),
// so every note still-needing extraction is batched into ONE request, the
// same shape carenotes-summary uses for a whole date of AM/PM blocks.
//
// ── WRITTEN ONCE, READ BACK FOREVER ──────────────────────────────────────────
//
// public.care_alert_summaries holds one row per NOTE x CATEGORY, keyed
// `<visit_id>__<cat_key>` -- the exact id buildCareAlerts() already uses for
// the tracked alert, so a row here lines up with "Full alert" one-to-one. The
// first person to open Care Notes Review with a note flagged pays for it;
// everyone after reads the saved row and spends nothing. A note nobody's
// browser ever flags is never sent to the model.
//
// ── THE MODEL HAS NO TOOLS ───────────────────────────────────────────────────
//
// It reads a note and returns bullets. Nothing it writes reaches any record
// except these rows. Same safety argument as devi-agent, comms-summary and
// carenotes-summary.
//
// ── PHI ───────────────────────────────────────────────────────────────────
//
// Same clinical shift notes as carenotes-summary, same basis: "The Anthropic
// API that we have has the PHI contract." (Carlo, 2026-09-23.) Contact
// details are still redacted before the note leaves this function, and again
// over the model's output -- comms-summary already measured that a prompt
// rule alone does not reliably hold.
//
// ── SECRETS (Supabase project secrets) ──────────────────────────────────────
//   ANTHROPIC_API_KEY          shared with devi-agent, care-brief, comms-summary, carenotes-summary
//   ALLOWED_ORIGIN             shared with all of them
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   provided by Supabase itself
//   CAREALERTS_MODEL           optional; default claude-haiku-4-5
//   CAREALERTS_EFFORT          optional; default low. NOT sent to a Haiku model (400)
//
// No new secret is needed. Switching model needs no code change and no redeploy:
//   npx supabase secrets set CAREALERTS_MODEL=claude-sonnet-5 --project-ref gdzgoyawavffjdjpjbfz
//
// A COMMIT DOES NOT DEPLOY THIS FILE:
//   npx supabase functions deploy carealerts-summary --project-ref gdzgoyawavffjdjpjbfz --no-verify-jwt
//
// The table is created by supabase/care-alert-summaries.sql (also section
// 10d of schema.sql). Both need to be run against the live database before
// this function will have anywhere to write.

const ANTHROPIC_KEY = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
const DB_URL = (Deno.env.get("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
const DB_KEY = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
const ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

/* `||`, not `??`: a secret set to an empty string must fall back to the
   default rather than send model "" and fail every request. */
const MODEL = (Deno.env.get("CAREALERTS_MODEL") || "claude-haiku-4-5").trim();
const EFFORT = (Deno.env.get("CAREALERTS_EFFORT") || "low").trim();
/* Haiku 4.5 answers 400 to output_config.effort. */
const SEND_EFFORT = !!EFFORT && !/haiku/i.test(MODEL);

/* Bump when PROMPT or the bullet rules change in a way that should rewrite
   rows already saved. They are rewritten on their next open. */
const PROMPT_VERSION = 1;

const API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TZ = "America/Los_Angeles";
const TIMEOUT_MS = 60000;
const TABLE = "care_alert_summaries";
const NOTES_TABLE = "care_notes";

/* A page open asking for more than this is refused rather than sent -- well
   clear of any real day's flagged-client count and stops a bad request
   turning into an enormous one. */
const MAX_UNITS = 30;

/* One note past this is truncated for the model, same ceiling
   carenotes-summary uses -- the live p99 is far under it. */
const MAX_NOTE_CHARS = 8000;

/* Bullet shape, enforced on the model's answer (not just asked for in the
   prompt): a bullet list a scheduler cannot scan in five seconds has failed
   at the one thing this function exists to do. */
const MIN_WHAT = 1, MAX_WHAT = 3;
const MIN_ACTION = 1, MAX_ACTION = 2;
const MAX_BULLET_CHARS = 140;

const RATE_MAX = 300;                     // requests per caller per hour; a cached read counts
const RATE_TOTAL = 1500;                  // per isolate per hour
const GEN_HOURLY_CAP = 120;               // model calls (i.e. PAGE OPENS with something new) per isolate per hour
const WINDOW_MS = 60 * 60 * 1000;

/* Only categories a note can genuinely be flagged under reach this function.
   'documentation' and 'missing' are Care Note Issues, a different section,
   and are never sent here. Mirrors the key/label/actions fields of
   CARE_CATEGORIES in index.html -- keep the two in step; this copy exists so
   the model has the same category label and the same starting point for
   "what does a scheduler usually do about this" that the page already shows
   on every other screen, without trusting the browser to supply that text
   itself. catKey values NOT in this map are rejected outright. */
const CATEGORIES: Record<string, { label: string; actions: string[] }> = {
  falls: { label: "Falls", actions: ["Contact caregiver immediately", "Verify incident documentation", "Contact family", "Notify office management", "Review fall prevention measures", "Send Fall Prevention Guide"] },
  hospitalization: { label: "Hospitalizations", actions: ["Confirm client status and hospital", "Contact family for updates", "Notify office management", "Pause or adjust scheduled shifts", "Document hospitalization and expected return", "Plan a safe return-to-care check-in"] },
  er: { label: "ER Visits", actions: ["Confirm what happened and current status", "Contact family", "Notify office management", "Review the care plan for risk factors", "Document the ER visit and outcome", "Monitor closely on the next shift"] },
  medication: { label: "Medication Issues", actions: ["Contact caregiver for details", "Confirm what was missed or refused", "Notify Care Quality Coordinator", "Contact family / responsible party", "Review the medication schedule", "Monitor closely on the next shift"] },
  safety: { label: "Safety Concerns", actions: ["Contact caregiver for details", "Address or remove the hazard", "Review the home for other risks", "Notify office management", "Send Safe Transfer Guide", "Document the safety concern"] },
  refused: { label: "Refused Care", actions: ["Contact caregiver for details", "Review the care plan and client preferences", "Notify Care Quality Coordinator", "Contact family if care is being declined", "Document the refusal and follow-up plan"] },
  changeCondition: { label: "Changes in Condition", actions: ["Review previous notes for a trend", "Notify Care Quality Coordinator", "Contact family if significant change", "Update the care plan if needed", "Monitor closely and reassess"] },
  agitation: { label: "Agitation", actions: ["Contact caregiver for additional details", "Review previous care notes", "Notify Care Quality Coordinator", "Send Agitated Client Response Guide", "Contact family if behavior is worsening", "Monitor for recurring incidents"] },
  confusion: { label: "Confusion", actions: ["Review previous notes", "Notify Care Quality Coordinator", "Contact family if significant change", "Monitor for patterns", "Escalate if condition worsens"] },
  behavioral: { label: "Behavioral Changes", actions: ["Contact caregiver for details", "Review previous notes for a trend", "Notify Care Quality Coordinator", "Contact family if significant change", "Monitor for recurring incidents"] },
  family: { label: "Family Concerns", actions: ["Call the family the same day", "Listen fully and document the concern", "Notify Care Quality Coordinator", "Identify a structured next step within policy", "Follow up to confirm resolution"] },
  foodIntake: { label: "Poor Food Intake", actions: ["Review previous care notes", "Monitor for a recurring pattern", "Notify family if needed", "Follow up with caregiver", "Send Nutrition & Hydration Guide", "Encourage detailed meal documentation"] },
  fluidIntake: { label: "Poor Fluid Intake", actions: ["Review previous care notes", "Watch for signs of dehydration", "Notify family if needed", "Follow up with caregiver", "Send Nutrition & Hydration Guide", "Encourage detailed fluid documentation"] },
};

class UpstreamError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// --- CORS (same shape as devi-agent, quo, care-brief, comms-summary and carenotes-summary) ---
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

// --- rate limits (only an ALLOWED request is counted, so the window drains) ---
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

/* Two schedulers opening Care Notes Review within a few seconds of each
   other would otherwise each run a pass over the same flagged notes and
   each pay for it. Keyed on the sorted set of ids actually requested, so two
   different days in flight at once do not block each other. */
const inflight = new Map<string, Promise<Result>>();

// --- text ---------------------------------------------------------------------

/* Same three redactions as carenotes-summary, and for the same reason: a
   phone number or email in a care note adds nothing to what a scheduler
   needs from this screen, and a prompt rule alone does not reliably hold. */
function redact(s: string): string {
  return String(s ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email address]")
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, "[link]")
    .replace(/\+1\d{10}\b/g, "[phone number]")
    .replace(/\b1[2-9]\d{9}\b/g, "[phone number]")
    .replace(/(?:\+?1[\s.\-\/]?)?\(?\b[2-9]\d{2}\)?[\s.\-\/]?\d{3}[\s.\-\/]?\d{4}\b/g, "[phone number]");
}
function cleanNote(t: string): string {
  return String(t ?? "").replace(/^[\s\-–—•\*·]+/, "").trim();
}
function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}

/* Same FNV-1a fold as carenotes-summary's sig() -- only has to change when
   the content changes, not be cryptographic, and must be stable across
   isolates. */
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

type NoteRow = { visit_id: string; client_id: number | null; note: string; visit_at: string | null };
type SavedRow = { id: string; source_sig: string; model: string; prompt_version: number; what_happened: string[]; scheduler_action: string[] };
type Unit = { id: string; noteId: string; catKey: string; clientId: number | null; text: string; sig: string };
type Result = {
  day: string;
  units: { id: string; whatHappened: string[]; schedulerAction: string[] }[];
  generated: number; reused: number; dropped: number; model: string; saveFailed?: number;
};

function dbHeaders(extra?: Record<string, string>): Record<string, string> {
  return { apikey: DB_KEY, Authorization: "Bearer " + DB_KEY, Accept: "application/json", ...(extra ?? {}) };
}
function inList(ids: string[]): string {
  return "(" + ids.map((id) => '"' + id.replace(/"/g, '""').replace(/,/g, "\\,") + '"').join(",") + ")";
}

/* The exact notes named by the browser's {noteId, catKey} pairs -- a direct
   primary-key lookup, not a day-window scan, because the caller already
   knows which visit_ids it wants. A noteId with no matching row is simply
   absent from the result and that unit is dropped later. */
async function notesByIds(noteIds: string[]): Promise<Map<string, NoteRow>> {
  const out = new Map<string, NoteRow>();
  if (!noteIds.length) return out;
  const url = DB_URL + "/rest/v1/" + NOTES_TABLE +
    "?select=visit_id,client_id,note,visit_at&visit_id=in." + encodeURIComponent(inList(noteIds));
  const r = await fetch(url, { headers: dbHeaders(), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new UpstreamError(502, "Could not read the care notes (HTTP " + r.status + ").");
  (await r.json() as NoteRow[]).forEach((n) => out.set(n.visit_id, n));
  return out;
}

async function savedByIds(ids: string[]): Promise<Map<string, SavedRow>> {
  const out = new Map<string, SavedRow>();
  if (!ids.length) return out;
  try {
    const r = await fetch(DB_URL + "/rest/v1/" + TABLE +
      "?select=id,source_sig,model,prompt_version,what_happened,scheduler_action&id=in." + encodeURIComponent(inList(ids)),
      { headers: dbHeaders(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) { console.warn("[carealerts-summary] read HTTP " + r.status); return out; }
    (await r.json() as SavedRow[]).forEach((row) => out.set(row.id, row));
  } catch (e) { console.warn("[carealerts-summary] read failed:", (e as Error)?.message); }
  return out;
}

async function dbPut(rows: Record<string, unknown>[]): Promise<boolean> {
  if (!rows.length) return true;
  try {
    const now = new Date().toISOString();
    const r = await fetch(DB_URL + "/rest/v1/" + TABLE + "?on_conflict=id", {
      method: "POST",
      headers: dbHeaders({ "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(rows.map((x) => ({ ...x, updated_at: now }))),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) console.warn("[carealerts-summary] write HTTP " + r.status + ": " + (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) { console.warn("[carealerts-summary] write failed:", (e as Error)?.message); return false; }
}

const current = (row: SavedRow | undefined, u: Unit): boolean =>
  !!row && row.model === MODEL && row.prompt_version === PROMPT_VERSION && row.source_sig === u.sig;

// --- the model -------------------------------------------------------------------

const PROMPT = [
  "You read ONE flagged caregiver shift note at a time for Devoted Care, a home-care agency.",
  "The note has already been flagged under a specific ISSUE CATEGORY by a keyword screen -- your",
  "job is to pull out ONLY the part of the note that is that issue, for a scheduler who is",
  "scanning a short list of flagged clients and has not read the note.",
  "",
  "You are given several such notes, each with an id, its category, and the full note text.",
  "Produce, for EVERY note given:",
  "",
  "  whatHappened     1 to " + MAX_WHAT + " short bullets -- ONLY the specific incident/issue that",
  "                    matches the stated category. Each bullet is one short, factual sentence,",
  "                    under " + MAX_BULLET_CHARS + " characters.",
  "  schedulerAction   1 to " + MAX_ACTION + " short bullets -- what THIS scheduler needs to do about",
  "                    THIS specific note. Use the category's typical actions (given below each",
  "                    note) as a starting menu, but pick and phrase only what this note's own",
  "                    details call for -- never paste the menu verbatim as the answer.",
  "",
  "EXCLUDE anything not part of the flagged issue, even if the note mentions it: routine meals,",
  "medication administration that is not the issue itself, vital-sign readings, casual",
  "conversation, TV or other leisure activity, routine toileting or hygiene, and minute-by-minute",
  "narration of the shift. If the note is about a fall, do not mention what the client ate that day.",
  "",
  "OUTPUT: a JSON array and nothing else. No markdown, no code fence, no preamble. One object per",
  'note, in the order given: [{"id":"<the id>","whatHappened":["...","..."],"schedulerAction":["..."]}]',
  "Every id you were given must appear exactly once. Use the ids verbatim.",
  "",
  "RULES:",
  "- Use ONLY what the note says. Never infer a diagnosis, a cause, a severity or an outcome that",
  "  was not written. If the note is vague about the issue, say only what it actually says.",
  "- Never give medical advice and never suggest a treatment or a medication change.",
  "- Do not reproduce the note's own sentences verbatim -- state the facts plainly and briefly, in",
  "  your own short wording. This is an extraction, not a lightly-edited copy.",
  "- Notes may mix English and Tagalog, be lightly punctuated, or be typed on a phone. Write the",
  "  bullets in plain English regardless of how the note is written.",
  "- Contact details already appear as [phone number], [email address] or [link]. Do not mention",
  "  those placeholders in a bullet.",
  "- If the note genuinely gives nothing beyond the category itself (e.g. it says only that a fall",
  "  happened, with no further detail), say that plainly in one bullet rather than inventing detail.",
].join("\n");

function blockFor(u: Unit): string {
  const cat = CATEGORIES[u.catKey];
  const head = "### " + u.id + "\n" + "Flagged category: " + cat.label + "\n" +
    "Typical actions for this category (a starting menu, not the answer): " + cat.actions.join("; ") + "\n" +
    "Full note:\n";
  return head + redact(u.text).slice(0, MAX_NOTE_CHARS);
}

function clampBullets(v: unknown, min: number, max: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const s = redact(item).replace(/\s*\n+\s*/g, " ").replace(/^["'"'•\-•]+|["'"']+$/g, "").trim();
    if (!s || s.length > MAX_BULLET_CHARS) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out.length >= min ? out : null;
}

async function askClaude(units: Unit[]): Promise<Map<string, { whatHappened: string[]; schedulerAction: string[] }>> {
  const content = "Notes to extract: " + units.length + "\n\n" + units.map(blockFor).join("\n\n");

  /* max_tokens INCLUDES THINKING -- the trap care-brief, devi-agent,
     comms-summary and carenotes-summary all documented. A budget sized for
     the answer alone returns HTTP 200 with an empty text block the moment
     CAREALERTS_MODEL points at a model that thinks by default. */
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
  if (data?.stop_reason === "refusal") throw new UpstreamError(502, "The model declined to read these notes.");
  const text = ((data?.content ?? []) as any[]).filter((p) => p?.type === "text").map((p) => p.text || "").join("").trim();
  console.info("[carealerts-summary] " + MODEL + " units=" + units.length +
    " in=" + (data?.usage?.input_tokens ?? "?") + " out=" + (data?.usage?.output_tokens ?? "?"));
  if (!text) {
    throw new UpstreamError(502, data?.stop_reason === "max_tokens"
      ? "The model spent its whole budget thinking and returned no text (stop_reason: max_tokens)."
      : "The model returned no text (stop_reason: " + String(data?.stop_reason ?? "unknown") + ").");
  }

  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch {
    const m = /\[[\s\S]*\]/.exec(text);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* fall through */ } }
  }
  if (!Array.isArray(parsed)) throw new UpstreamError(502, "The model did not return a JSON array.");

  const want = new Set(units.map((u) => u.id));
  const out = new Map<string, { whatHappened: string[]; schedulerAction: string[] }>();
  for (const item of parsed) {
    const id = String(item?.id ?? "");
    if (!want.has(id) || out.has(id)) continue;
    const whatHappened = clampBullets(item?.whatHappened, MIN_WHAT, MAX_WHAT);
    const schedulerAction = clampBullets(item?.schedulerAction, MIN_ACTION, MAX_ACTION);
    /* A note missing either list is discarded whole rather than saved half-
       done -- the browser falls back to "could not summarise" for it, and
       the next open tries again. A one-sided row (an issue with no action,
       or an action with no stated issue) is worse than neither. */
    if (!whatHappened || !schedulerAction) continue;
    out.set(id, { whatHappened, schedulerAction });
  }
  return out;
}

// --- the batch --------------------------------------------------------------------

type WantUnit = { noteId: string; catKey: string };

async function summariseAlerts(day: string, wanted: WantUnit[]): Promise<Result> {
  const noteIds = [...new Set(wanted.map((w) => w.noteId))];
  const notes = await notesByIds(noteIds);

  const units: Unit[] = [];
  let dropped = 0;
  for (const w of wanted) {
    const cat = CATEGORIES[w.catKey];
    const note = notes.get(w.noteId);
    /* A catKey this function does not recognise, a noteId with no row, a
       note outside the day it was asked under, or an empty note after
       cleaning: none of these can become a model call. */
    if (!cat || !note || !note.visit_at || dayKey(note.visit_at) !== day) { dropped++; continue; }
    const text = cleanNote(note.note);
    if (!text) { dropped++; continue; }
    const id = w.noteId + "__" + w.catKey;
    units.push({ id, noteId: w.noteId, catKey: w.catKey, clientId: note.client_id, text, sig: sig([note.visit_id, text]) });
  }

  const saved = await savedByIds(units.map((u) => u.id));
  const stale = units.filter((u) => !current(saved.get(u.id), u));
  const out: Result = { day, units: [], generated: 0, reused: units.length - stale.length, dropped, model: MODEL };

  let fresh = new Map<string, { whatHappened: string[]; schedulerAction: string[] }>();
  if (stale.length) {
    if (genCapped()) throw new UpstreamError(429, "Too many notes have been analysed in the last hour. Try again shortly.");
    fresh = await askClaude(stale);
    const rows = stale.filter((u) => fresh.has(u.id)).map((u) => {
      const f = fresh.get(u.id)!;
      return {
        id: u.id, note_id: u.noteId, cat_key: u.catKey, client_id: u.clientId,
        what_happened: f.whatHappened, scheduler_action: f.schedulerAction,
        source_sig: u.sig, model: MODEL, prompt_version: PROMPT_VERSION,
      };
    });
    const stored = await dbPut(rows);
    out.generated = stored ? rows.length : 0;
    if (!stored && rows.length) out.saveFailed = rows.length;
  }

  for (const u of units) {
    /* A unit the model (or a failed save) could not produce is simply absent
       from the response. The browser treats a missing id as "could not
       analyse this one automatically" -- it never falls back to the raw
       note, because that is the exact thing this function exists to stop
       showing on this screen. "Full alert" still has the original text. */
    const f = fresh.get(u.id);
    if (f) { out.units.push({ id: u.id, whatHappened: f.whatHappened, schedulerAction: f.schedulerAction }); continue; }
    const row = current(saved.get(u.id), u) ? saved.get(u.id) : undefined;
    if (row) out.units.push({ id: u.id, whatHappened: row.what_happened, schedulerAction: row.scheduler_action });
  }
  return out;
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
      return json(cors, 405, { ok: false, error: "Extraction is requested with POST. GET supports only ?action=status." });
    }
    return json(cors, 200, {
      ok: true, configured: missing().length === 0, missing: missing(),
      model: MODEL, effort: SEND_EFFORT ? EFFORT : "not sent (" + MODEL + " does not accept it)",
      promptVersion: PROMPT_VERSION, maxUnitsPerRequest: MAX_UNITS,
      categories: Object.keys(CATEGORIES),
    });
  }
  /* POST, not GET: a request here can cost money and write rows. */
  if (req.method !== "POST") return json(cors, 405, { ok: false, error: "Only POST (and GET ?action=status) are supported." });

  if (missing().length) {
    return json(cors, 503, { ok: false, error: "Care alert extraction is not configured on the server.", missing: missing() });
  }

  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return json(cors, 429, { ok: false, error: "too many requests - try again shortly" });

  const b = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return json(cors, 400, { ok: false, error: "Send a JSON body." });

  const day = String(b.day ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(Date.parse(day + "T00:00:00Z"))) {
    return json(cors, 400, { ok: false, error: "day must be YYYY-MM-DD." });
  }
  const rawUnits = Array.isArray(b.units) ? b.units : null;
  if (!rawUnits) return json(cors, 400, { ok: false, error: "units must be an array of {noteId, catKey}." });
  if (rawUnits.length > MAX_UNITS) {
    return json(cors, 413, { ok: false, error: "That's " + rawUnits.length + " notes, more than this can analyse in one request (" + MAX_UNITS + ")." });
  }
  const seen = new Set<string>();
  const wanted: WantUnit[] = [];
  for (const raw of rawUnits) {
    const noteId = String((raw as any)?.noteId ?? "").trim();
    const catKey = String((raw as any)?.catKey ?? "").trim();
    if (!noteId || !catKey || !CATEGORIES[catKey]) continue;   // silently dropped -- see summariseAlerts()
    const id = noteId + "__" + catKey;
    if (seen.has(id)) continue;
    seen.add(id);
    wanted.push({ noteId, catKey });
  }
  if (!wanted.length) return json(cors, 200, { ok: true, day, units: [], generated: 0, reused: 0, dropped: rawUnits.length, model: MODEL });

  const key = day + "|" + [...seen].sort().join(",");
  try {
    let p = inflight.get(key);
    if (!p) {
      p = summariseAlerts(day, wanted).finally(() => { inflight.delete(key); });
      inflight.set(key, p);
    }
    return json(cors, 200, { ok: true, ...(await p) });
  } catch (err) {
    const e = err as Error & { status?: number };
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    const status = timedOut ? 504 : (e instanceof UpstreamError ? e.status : 500);
    console.warn("[carealerts-summary] failed:", e?.message);
    return json(cors, status, { ok: false, error: timedOut ? "Timed out reading the notes or writing the extraction." : (e?.message || "Something went wrong.") });
  }
});
