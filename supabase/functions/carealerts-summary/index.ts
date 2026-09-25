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
const PROMPT_VERSION = 2;

const API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TZ = "America/Los_Angeles";
const TIMEOUT_MS = 60000;
const TABLE = "care_alert_summaries";
const TRIAGE_TABLE = "care_alert_triage";
/* Bumping this re-triages every date, exactly as PROMPT_VERSION rewrites every summary. */
const TRIAGE_VERSION = 2;
/* A ceiling on what one date may raise. A date is ~19 notes; if the model wants to flag
   more than this it has misunderstood the job, and a flooded panel is worse than the
   keyword screen it replaced. The excess is dropped and logged, never silently kept. */
const MAX_TRIAGE_FIND = 8;
const NOTES_TABLE = "care_notes";

/* A page open asking for more than this is refused rather than sent -- well
   clear of any real day's flagged-client count and stops a bad request
   turning into an enormous one. */
const MAX_UNITS = 30;
/* Every note on one Pacific day, not just the flagged ones -- the lookup map is
   built from the whole day. The live table averages ~19 a day; 500 is headroom,
   not a target, and only the flagged ones ever reach the model. */
const MAX_DAY_NOTES = 500;

/* One note past this is truncated for the model, same ceiling
   carenotes-summary uses -- the live p99 is far under it. */
const MAX_NOTE_CHARS = 8000;

/* Bullet shape, enforced on the model's answer (not just asked for in the
   prompt): a bullet list a scheduler cannot scan in five seconds has failed
   at the one thing this function exists to do. */
const MIN_WHAT = 1, MAX_WHAT = 3;
const MIN_ACTION = 1, MAX_ACTION = 2;
/* A PARAGRAPH, not a bullet, since PROMPT_VERSION 2. Mitch's own example runs to ~290
   characters in its first paragraph, so 140 would have truncated the target shape on
   arrival and the row would have silently lost its longest sentence. */
const MAX_BULLET_CHARS = 420;

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
  /* Added with the index.html category of the same key. This map is the SECOND list:
     an unknown catKey is dropped silently, so a category added to the browser alone
     would never be summarised and the row would read "could not analyse". */
  skin: { label: "Skin & Bleeding", actions: ["Contact caregiver for details", "Confirm home health or the nurse knows", "Contact family", "Notify Care Quality Coordinator", "Review repositioning and skin care in the care plan", "Monitor closely on the next shift"] },
  /* Aggression toward the CAREGIVER, added 2026-09-25 with the index.html category of
     the same key. `safety` above is environmental (hazards, near-misses); this is
     something the client did to the person caring for them, and it ranks critical. */
  cgSafety: { label: "Caregiver Safety", actions: ["Call the caregiver today to check they are alright", "Confirm whether they are willing to return to this client", "Notify office management and document as a safety incident", "Contact family about the behaviour", "Review whether this placement is still appropriate", "Send Agitated Client Response Guide"] },
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

function laOffsetMin(utcMs: number): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" })
    .formatToParts(new Date(utcMs)).find((p) => p.type === "timeZoneName")?.value ?? "GMT-8";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part);
  if (!m) return -480;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}
/* The UTC instant of Pacific midnight starting `day`. The offset is probed at
   08:00 UTC, which is 00:00 or 01:00 Pacific -- before the 2am daylight-saving
   change on either transition day, so it is the offset midnight actually had. */
function laMidnightUtc(day: string): number {
  const [y, mo, d] = day.split("-").map(Number);
  return Date.UTC(y, mo - 1, d) - laOffsetMin(Date.UTC(y, mo - 1, d, 8)) * 60000;
}

/* EXACTLY index.html's fetchCareNotes id, and it must stay exactly that:
     id: "cn" + String(n.visit_id).replace(/[^A-Za-z0-9]+/g, "_")
   That is the id the browser names a note by, because it keeps no other copy
   of visit_id on the record. */
function browserNoteId(visitId: string): string {
  return "cn" + String(visitId).replace(/[^A-Za-z0-9]+/g, "_");
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
type Unit = { id: string; noteId: string; visitId: string; catKey: string; clientId: number | null; text: string; sig: string };
type Result = {
  day: string;
  /* found:true means the TRIAGE pass raised this, not the browser's keyword screen -- so
     the browser knows to add a row for it rather than look for one it already has.
     catKey and clientId travel with a found alert for the same reason. */
  units: { id: string; whatHappened: string[]; schedulerAction: string[]; found?: boolean; catKey?: string; clientId?: number | null }[];
  triaged?: boolean; found?: number;
  generated: number; reused: number; dropped: number; model: string; saveFailed?: number;
};

function dbHeaders(extra?: Record<string, string>): Record<string, string> {
  return { apikey: DB_KEY, Authorization: "Bearer " + DB_KEY, Accept: "application/json", ...(extra ?? {}) };
}
function inList(ids: string[]): string {
  return "(" + ids.map((id) => '"' + id.replace(/"/g, '""').replace(/,/g, "\\,") + '"').join(",") + ")";
}

/* Everything care_notes holds for one PACIFIC day, keyed BOTH by the real
   visit_id and by the browser's munged form of it.

   It has to be a day-window scan rather than the primary-key lookup this once
   was: index.html keeps no copy of visit_id on a care-note record, so the
   noteId it sends is already munged and cannot be turned back into the real
   one. Reading the day and munging each row matches in that space instead.

   Keying both ways is deliberate: an index.html that is later fixed to send
   the real visit_id keeps working with no second change here.

   The window is the UTC instants of Pacific midnight to Pacific midnight, so
   it cannot inherit the "sliced textually vs cast" bug the open-shift mirror
   documents: a visit at 2026-09-18T20:00-07:00 is the 18th here, the 19th in
   UTC. */
async function notesForDay(day: string): Promise<Map<string, NoteRow>> {
  const out = new Map<string, NoteRow>();
  const from = new Date(laMidnightUtc(day)).toISOString();
  const to = new Date(laMidnightUtc(day) + 26 * 3600000).toISOString();   // 26h covers either DST shape
  const url = DB_URL + "/rest/v1/" + NOTES_TABLE +
    "?select=visit_id,client_id,note,visit_at" +
    "&visit_at=gte." + encodeURIComponent(from) +
    "&visit_at=lt." + encodeURIComponent(to) +
    "&order=visit_at.asc&limit=" + MAX_DAY_NOTES;
  const r = await fetch(url, { headers: dbHeaders(), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new UpstreamError(502, "Could not read the care notes (HTTP " + r.status + ").");
  for (const n of await r.json() as NoteRow[]) {
    /* the 26-hour window can reach into the next Pacific day; keep only this one */
    if (!n.visit_at || dayKey(n.visit_at) !== day) continue;
    out.set(n.visit_id, n);
    out.set(browserNoteId(n.visit_id), n);
  }
  return out;
}

/* Has this date already been reasoned over by this model and this triage prompt? The
   marker exists so a date where NOTHING was found still costs one model call ever,
   rather than one per page open -- there would be no row in care_alert_summaries to
   prove the pass had run. */
async function triageDone(day: string): Promise<boolean> {
  try {
    const r = await fetch(DB_URL + "/rest/v1/" + TRIAGE_TABLE +
      "?day=eq." + encodeURIComponent(day) + "&select=model,prompt_version", { headers: dbHeaders() });
    if (!r.ok) return false;
    const rows = await r.json() as { model: string; prompt_version: number }[];
    return !!(rows && rows[0] && rows[0].model === MODEL && rows[0].prompt_version === TRIAGE_VERSION);
  } catch { return false; }
}

async function markTriaged(day: string, notesSeen: number, found: number): Promise<void> {
  try {
    await fetch(DB_URL + "/rest/v1/" + TRIAGE_TABLE + "?on_conflict=day", {
      method: "POST",
      headers: dbHeaders({ "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify([{ day, model: MODEL, prompt_version: TRIAGE_VERSION, notes_seen: notesSeen, found, updated_at: new Date().toISOString() }]),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { console.warn("[carealerts-summary] triage marker failed:", (e as Error)?.message); }
}

/* Every saved alert for this date, keyed by id. The table has no day column and needs
   none: we are already holding every visit_id for the date. This is how a TRIAGE-found
   alert comes back on a later open, when the browser does not know to ask for it. */
async function rowsForVisits(visitIds: string[]): Promise<Map<string, SavedRow & { cat_key: string; note_id: string; client_id: number | null }>> {
  const out = new Map<string, SavedRow & { cat_key: string; note_id: string; client_id: number | null }>();
  if (!visitIds.length) return out;
  try {
    const r = await fetch(DB_URL + "/rest/v1/" + TABLE + "?found_by=eq.triage&note_id=in.(" +
      visitIds.map((v) => '"' + v.replace(/"/g, '""') + '"').join(",") +
      ")&select=id,note_id,cat_key,client_id,source_sig,model,prompt_version,what_happened,scheduler_action",
      { headers: dbHeaders() });
    if (!r.ok) return out;
    for (const row of await r.json() as any[]) out.set(row.id, row);
  } catch (e) { console.warn("[carealerts-summary] day read failed:", (e as Error)?.message); }
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
  "  whatHappened     1 to " + MAX_WHAT + " short PARAGRAPHS of flowing prose, each under",
  "                    " + MAX_BULLET_CHARS + " characters. Not bullet points and not a checklist.",
  "  schedulerAction   1 or 2 sentences stating what needs to happen and why.",
  "",
  "HOW IT SHOULD READ. The way you would tell a scheduler about it on the phone: what the",
  "shift was like, then the incident, then what followed.",
  "",
  "NAME THE CLIENT, by the first name the note uses. \"Jose became agitated around 11:00 PM\",",
  "not \"Client became agitated\". The row above your text already shows the client and the",
  "caregiver, but a scheduler reading a safety incident should see the person in the sentence.",
  "Call the caregiver \"the caregiver\" -- the row names them. Anyone else goes by relationship",
  "where the note gives one: \"his wife\", \"her daughter\", \"the nurse\".",
  "",
  "GIVE THE INCIDENT ITS CONTEXT. A restless night, a difficult afternoon, repeated waking --",
  "that frame is what makes the incident understandable, so include it briefly.",
  "But do NOT list routine care that has nothing to do with it: meals, vital-sign rounds,",
  "medication rounds, TV, chit-chat, or a minute-by-minute retelling of the shift. If the note",
  "is about a fall, do not mention what the client ate. Include a pattern only where it is part",
  "of the story -- \"he continued waking through the night\" earns its place; \"he had yogurt at",
  "1am\" does not.",
  "",
  "TIMES AND FIGURES ARE ALLOWED HERE, and are often the point: \"around 11:00 PM\", \"oxygen at",
  "78%\", \"blood sugar 343\". A scheduler acting on this needs them. (The care-note summary on",
  "the same page bans numbers outright. That screen is for scanning fifteen clients; this one is",
  "for acting on one. Two screens, two rules, deliberately -- do not carry either rule across.)",
  "",
  "SCHEDULER ACTION IS A STATEMENT, not an imperative menu. Say what requires attention and",
  "why, the way a supervisor would write it:",
  "  \"Jose's attempted physical aggression toward the caregiver requires follow-up and should",
  "   be documented as a safety concern.\"",
  "The category's typical actions are given below each note as a PROMPT FOR YOUR THINKING --",
  "never paste them back as the answer.",
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
  "- Notes may mix English and Tagalog, be lightly punctuated, typed on a phone, or full of",
  "  obvious typos. READ THE MEANING and never soften, reverse or hedge what happened.",
  "  \"jose try to hot me me belt\" means he tried to HIT the caregiver WITH his belt. An earlier",
  "  version of this summary rendered that as \"attempted to grab the caregiver's belt\", which",
  "  reversed it and made a serious incident sound minor. If a typo leaves you genuinely unsure,",
  "  say what the note says in its own terms rather than guessing a milder reading.",
  "- Contact details already appear as [phone number], [email address] or [link]. Do not mention",
  "  those placeholders in a bullet.",
  "- If the note genuinely gives nothing beyond the category itself (e.g. it says only that a fall",
  "  happened, with no further detail), say that plainly in one paragraph rather than inventing",
  "  detail.",
  "",
  "WORKED EXAMPLE of the shape and voice. Invented details -- never reuse its wording:",
  "",
  "  whatHappened[0]  Alma had a restless night with frequent waking and movement between her",
  "                   bedroom and the living room. Around 11:00 PM she became agitated and",
  "                   tried to strike the caregiver with a walking stick. The caregiver kept",
  "                   her distance while Alma's son redirected her back to her room.",
  "  whatHappened[1]  Alma went on waking through the night, moving between her bedroom,",
  "                   bathroom and the living room, with periods of sleep in between.",
  "  schedulerAction  Alma's attempted physical aggression toward the caregiver requires",
  "                   follow-up and should be documented as a safety concern.",
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

async function askClaude(units: Unit[], attempt = 1): Promise<Map<string, { whatHappened: string[]; schedulerAction: string[] }>> {
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
  /* ONE RETRY ON A PARSE FAILURE. Measured 2026-09-25: asking for flowing PROSE made the
     model intermittently answer in prose instead of the JSON array -- twice in three calls
     on one note, and the note in question was a caregiver-safety incident involving a
     threat with a firearm. A failed call saves nothing, so the row degraded to "Could not
     analyse this note automatically" and waited for a human to press Retry.
     Retrying a GENERATE is safe in a way retrying a SEND is not: nothing has been written,
     and the worst case is paying for the call twice. */
  if (!Array.isArray(parsed)) {
    if (attempt < 2) {
      console.warn("[carealerts-summary] non-JSON answer, retrying once");
      return await askClaude(units, attempt + 1);
    }
    throw new UpstreamError(502, "The model did not return a JSON array, on two attempts.");
  }

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

  /* RETRY THE IDS THE MODEL SIMPLY LEFT OUT.
     Measured 2026-09-25, and this is the failure that matters most. Jose Ortiz's
     2026-09-20 note -- the one where he threatens to shoot the caregiver and swings a cue
     stick -- was omitted from a VALID four-id array about half the time. Not a refusal, not
     a parse error: the array came back well-formed with three of the four ids in it, so the
     non-JSON retry above never fired, the row saved nothing, and the board degraded to
     "Could not analyse this note automatically" on the single most serious alert it had.
     The model quietly drops the hardest note in a batch.

     So a missing id is retried once, alone -- a batch of one has no other note to lose it
     behind. Safe for the same reason the parse retry is: nothing has been written yet. */
  const missing = units.filter((u) => !out.has(u.id));
  if (missing.length && attempt < 2) {
    console.warn("[carealerts-summary] model omitted " + missing.length + " of " + units.length +
      " id(s), retrying them alone: " + missing.map((u) => u.id).join(", "));
    for (const u of missing) {
      try {
        const again = await askClaude([u], attempt + 1);
        const got = again.get(u.id);
        if (got) out.set(u.id, got);
      } catch (e) {
        /* One stubborn note must not cost the others their answers. */
        console.warn("[carealerts-summary] retry failed for " + u.id + ": " + ((e as Error)?.message ?? "unknown"));
      }
    }
  }
  return out;
}

// --- the triage pass ---------------------------------------------------------------

/* WHY THIS EXISTS, in one paragraph, because it is the expensive half of this file.

   Until 2026-09-25 this function only ever saw notes that categorizeNote() had already
   flagged by keyword. Measured on the live mirror: 747 notes, 90 flagged, 657 (88%)
   never shown to the model at all. One of the 657 read "She has a lot of pain in her
   ankle and leg! Her ankle is swollen, I applied pain cream!" -- nothing raised it.
   CLAUDE.md records that a PAIN category was measured and REJECTED (41 fires, 5 real)
   because a word list cannot separate new pain from four clients' chronic managed pain.
   That separation is a judgement, so it is made here instead.

   The keyword screen is kept as a FLOOR, not a gate: every unit the browser asks for is
   still extracted exactly as before. This pass only ADDS. */

const TRIAGE_PROMPT = [
  "You are the alert triage for Devoted Care, a home-care agency in Ventura County.",
  "",
  "You are given EVERY caregiver shift note for one date. Decide which of them a scheduler",
  "has to act on today, and say what happened and what to do about it.",
  "",
  "MOST SHIFTS RAISE NOTHING. That is the normal answer. A short list is a good list, and an",
   "empty list is a good day. A long list is worse than useless: it buries the one note that",
  "mattered. Returning [] is correct and expected on a quiet date.",
  "",
  "RAISE IT when the note shows something the OFFICE must do something about:",
  "  - the client was hurt or something NEW appeared: a fall, an injury, new pain, new",
  "    swelling, bleeding, a new sore, a burn",
  "  - a real change from how this client usually is",
  "  - aggression, a threat, or anything frightening toward the CAREGIVER",
  "  - care refused, or care the caregiver could not give",
  "  - the caregiver asked for help, raised a concern, or had to leave the house",
  "  - a medication problem: missed, refused, run out, doubled, wrong",
  "  - somebody outside the agency became involved: 911, paramedics, a nurse, a hospital,",
  "    or a family member complaining about us",
  "",
  "DO NOT RAISE IT for:",
  "  - AN ONGOING CONDITION BEING MANAGED AS USUAL. This is the most common mistake. A",
  "    client with chronic wheezing who was given her breathing treatment is her care plan",
  "    WORKING, not news. Using oxygen, having dementia, being on hospice, having a",
  "    catheter, being incontinent: none of these is an alert for existing.",
  "  - routine care of any kind, however much of it the note lists",
  "  - one ordinary variation: a small meal, a restless night, one refused shower, one",
  "    difficult transfer",
  "  - SOMETHING THAT ALREADY RESOLVED WITH NOTHING LEFT TO DO. \"He was agitated at the",
  "    start of the shift and calmed down after\" is a shift, not an alert.",
  "  - anything you are guessing at, or would have to assume to make interesting",
  "",
  "YOU ARE SEEING ONE DAY, AND YOU DO NOT KNOW THIS CLIENT'S NORMAL. This is the trap that",
  "matters most, because a long overnight log looks dramatic and may be exactly how this",
  "client always is. So: only call something a CHANGE if the NOTE ITSELF says it is new,",
  "different, worse, or unlike before. Never ask the scheduler to \"clarify whether this is",
  "typical\" -- if you have to ask, you are not looking at evidence of a change, and a row",
  "that asks the desk to work out whether there is a problem is worse than no row. A night",
  "of frequent toileting, broken sleep, wandering or repeated questions is BASELINE for",
  "several clients here and must not be raised on its own.",
  "",
  "THE TEST IS ONE QUESTION: would a scheduler pick up the phone today because of this?",
  "If not, leave it out.",
  "",
  "AT MOST ONE ALERT PER NOTE, and only the most important thing in that note.",
  "",
  "CATEGORY: choose the single best key from this list. Use the key exactly as written:",
  "CAT_LINES",                 /* replaced with the real key list in askTriage() */
  "",
  "OUTPUT: a JSON array and nothing else. No markdown, no code fence, no preamble.",
  "One object per note you are raising -- and NO object for a note you are not:",
  "[{\"id\":\"<the note id>\",\"catKey\":\"<a key from the list>\",\"whatHappened\":[\"...\"],\"schedulerAction\":[\"...\"]}]",
  "Use the ids verbatim. Never invent an id. An empty array is a valid answer.",
  "",
  "  whatHappened     1 to " + MAX_WHAT + " short factual bullets, each under " + MAX_BULLET_CHARS + " characters.",
  "                   THE FIRST BULLET MUST SAY WHAT HAPPENED, not who was told about it.",
  "                   \"Family said they would call the doctor\" and \"caregiver notified the",
  "                   family and was told to monitor hourly\" are reactions with the event",
  "                   missing -- name the event first, then the reaction if it matters.",
  "  schedulerAction  1 to " + MAX_ACTION + " short bullets: what the office does about THIS note.",
  "",
  "RULES:",
  "- Use ONLY what the note says. Never infer a diagnosis, a cause, a severity or an outcome",
  "  that was not written. If the note is vague, your bullets are vague.",
  "- Never give medical advice and never suggest a treatment or a medication change.",
  "- Do not copy the note's sentences. State the fact plainly in your own short wording.",
  "- Notes may mix English and Tagalog, be lightly punctuated, typed on a phone, or contain",
  "  obvious typos. Read the MEANING. \"he try to hot me me belt\" means he tried to hit the",
  "  caregiver with a belt; report it as that.",
  "- Contact details already read [phone number], [email address] or [link]. Do not mention",
  "  those placeholders.",
  "- Never name the caregiver or the client in a bullet. The row already shows both.",
  "",
  "WORKED EXAMPLES. Invented -- never reuse their wording, names or details:",
  "",
  "  RAISE. The note says: \"11am she said her ankle hurt a lot and it looked puffy, I put",
  "  pain cream on it. She ate half her lunch.\"",
  "    catKey          changeCondition",
  "    whatHappened    New ankle pain with visible swelling; caregiver applied pain cream.",
  "    schedulerAction Call the caregiver for detail and ask whether the family or nurse knows.",
  "",
  "  DO NOT RAISE. The note says: \"Mild wheezing again this morning, gave her the breathing",
  "  treatment and she settled. Oxygen back on. Ate all her breakfast.\"",
  "    Nothing. This is her ongoing condition being managed exactly as usual.",
  "",
  "  DO NOT RAISE. The note says: \"Helped with a shower, made lunch, we watched TV, changed",
  "  briefs twice, she slept well.\"",
  "    Nothing. A routine shift.",
].join("\n");

/* One block per note. The id is the BROWSER form -- see browserNoteId() -- because that is
   what every alert in this system is keyed by, and a triage-found alert has to line up with
   careAlertOverrides in index.html like any other. */
function triageBlock(n: NoteRow, id: string): string {
  return "### " + id + "\nFull note:\n" + redact(cleanNote(n.note)).slice(0, MAX_NOTE_CHARS);
}

type Found = { id: string; catKey: string; whatHappened: string[]; schedulerAction: string[] };

async function askTriage(day: string, notes: NoteRow[], attempt = 1): Promise<Found[]> {
  const catLines = Object.keys(CATEGORIES).map((k) => "  " + k + "  (" + CATEGORIES[k].label + ")").join("\n");
  const system = TRIAGE_PROMPT.replace("CAT_LINES", catLines);
  const content = "Date: " + day + "\nNotes on this date: " + notes.length + "\n\n" +
    notes.map((n) => triageBlock(n, browserNoteId(n.visit_id))).join("\n\n");

  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 16000,          // INCLUDES THINKING -- see askClaude
    system,
    messages: [{ role: "user", content }],
  };
  if (SEND_EFFORT) body.output_config = { effort: EFFORT };

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
  console.info("[carealerts-summary] TRIAGE " + day + " notes=" + notes.length +
    " in=" + (data?.usage?.input_tokens ?? "?") + " out=" + (data?.usage?.output_tokens ?? "?"));
  if (!text) {
    throw new UpstreamError(502, data?.stop_reason === "max_tokens"
      ? "The triage pass spent its whole budget thinking and returned no text."
      : "The triage pass returned no text (stop_reason: " + String(data?.stop_reason ?? "unknown") + ").");
  }

  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch {
    const m = /\[[\s\S]*\]/.exec(text);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* fall through */ } }
  }
  /* An unparseable answer is NOT an empty date -- throwing keeps the marker unwritten so
     the next open tries again, instead of recording "nothing found" forever. */
  if (!Array.isArray(parsed)) {
    if (attempt < 2) {
      console.warn("[carealerts-summary] triage gave a non-JSON answer, retrying once");
      return await askTriage(day, notes, attempt + 1);
    }
    throw new UpstreamError(502, "The triage pass did not return a JSON array, on two attempts.");
  }

  /* Defensive exactly as askClaude is: an unknown id, an id outside this date, an unknown
     category, a repeat, or bullets that fail the table's CHECK constraints are dropped.
     Losing one finding beats losing the date. */
  const known = new Map<string, NoteRow>();
  notes.forEach((n) => known.set(browserNoteId(n.visit_id), n));
  const seen = new Set<string>();
  const out: Found[] = [];
  let bad = 0;
  for (const item of parsed) {
    const id = String(item?.id ?? "");
    const catKey = String(item?.catKey ?? "");
    if (!known.has(id) || seen.has(id) || !CATEGORIES[catKey]) { bad++; continue; }
    const what = clampBullets(item?.whatHappened, MIN_WHAT, MAX_WHAT);
    const act = clampBullets(item?.schedulerAction, MIN_ACTION, MAX_ACTION);
    if (!what || !act) { bad++; continue; }
    seen.add(id);
    out.push({ id, catKey, whatHappened: what, schedulerAction: act });
    if (out.length >= MAX_TRIAGE_FIND) break;
  }
  if (bad) console.warn("[carealerts-summary] triage dropped " + bad + " malformed finding(s)");
  if (parsed.length > MAX_TRIAGE_FIND) console.warn("[carealerts-summary] triage capped at " + MAX_TRIAGE_FIND + " of " + parsed.length);
  return out;
}

// --- the batch --------------------------------------------------------------------

type WantUnit = { noteId: string; catKey: string };

async function summariseAlerts(day: string, wanted: WantUnit[]): Promise<Result> {
  const notes = await notesForDay(day);

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
    units.push({ id, noteId: w.noteId, visitId: note.visit_id, catKey: w.catKey, clientId: note.client_id, text, sig: sig([note.visit_id, text]) });
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
        id: u.id, note_id: u.visitId, cat_key: u.catKey, client_id: u.clientId,
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

  /* ---------- THE TRIAGE PASS ----------

     Everything above answers the browser's keyword screen. This reads the WHOLE date and
     reasons about every note, because the screen is a floor and not a gate: 657 of 747
     live notes fire no keyword and were never shown to the model at all.

     It runs ONCE per date per model+prompt (the care_alert_triage marker). On any later
     open the findings come back from care_alert_summaries, read by note_id, with no model
     call -- the same "written once, read back forever" rule as the rest of this screen. */
  const dayNotes: NoteRow[] = [];
  const seenVisit = new Set<string>();
  /* notesForDay keys every note TWICE, by visit_id and by browserNoteId, so iterating the
     map without this would send every note to the model twice. */
  for (const n of notes.values()) {
    if (seenVisit.has(n.visit_id)) continue;
    seenVisit.add(n.visit_id);
    dayNotes.push(n);
  }
  const askedIds = new Set(units.map((u) => u.id));

  if (dayNotes.length) {
    const done = await triageDone(day);
    if (done) {
      /* Read back whatever the pass found last time. A row whose id the browser already
         asked about is skipped -- it is in out.units already. */
      const rows = await rowsForVisits(dayNotes.map((n) => n.visit_id));
      for (const row of rows.values()) {
        if (askedIds.has(row.id) || !CATEGORIES[row.cat_key]) continue;
        if (row.model !== MODEL || row.prompt_version !== TRIAGE_VERSION) continue;
        out.units.push({
          id: row.id, whatHappened: row.what_happened, schedulerAction: row.scheduler_action,
          found: true, catKey: row.cat_key, clientId: row.client_id,
        });
      }
      out.triaged = true;
      out.found = out.units.filter((u) => u.found).length;
    } else if (genCapped()) {
      /* Out of model budget for this hour: the keyword answers above still stand, and the
         marker stays unwritten so a later open triages the date properly. */
      out.triaged = false;
    } else {
      const findings = await askTriage(day, dayNotes);
      const byBrowserId = new Map<string, NoteRow>();
      dayNotes.forEach((n) => byBrowserId.set(browserNoteId(n.visit_id), n));
      const rows: Record<string, unknown>[] = [];
      for (const fd of findings) {
        const id = fd.id + "__" + fd.catKey;
        if (askedIds.has(id)) continue;             // the keyword screen already had it
        const note = byBrowserId.get(fd.id);
        if (!note) continue;                        // askTriage validated this, belt and braces
        rows.push({
          id, note_id: note.visit_id, cat_key: fd.catKey, client_id: note.client_id,
          what_happened: fd.whatHappened, scheduler_action: fd.schedulerAction,
          source_sig: sig([note.visit_id, cleanNote(note.note)]),
          /* TRIAGE_VERSION, not PROMPT_VERSION: this row was written by the TRIAGE prompt,
             so the triage version is what should invalidate it. Storing the extraction
             version here meant a PROMPT_VERSION bump orphaned every triage row -- the
             read-back filtered them out while the marker still said the date was done, so
             the findings vanished silently and never regenerated. */
          model: MODEL, prompt_version: TRIAGE_VERSION, found_by: "triage",
        });
        out.units.push({
          id, whatHappened: fd.whatHappened, schedulerAction: fd.schedulerAction,
          found: true, catKey: fd.catKey, clientId: note.client_id,
        });
      }
      const stored = rows.length ? await dbPut(rows) : true;
      /* The marker is written even when nothing was found -- that is what stops a quiet
         date paying for the model on every open. It is NOT written if the save failed,
         because then the findings exist nowhere and must be regenerated. */
      if (stored) await markTriaged(day, dayNotes.length, rows.length);
      out.generated += stored ? rows.length : 0;
      if (!stored && rows.length) out.saveFailed = (out.saveFailed ?? 0) + rows.length;
      out.triaged = stored;
      out.found = rows.length;
    }
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
  /* NO EARLY RETURN ON AN EMPTY LIST since 2026-09-25. It used to answer "nothing to do"
     here, which was the whole gate: a date where the keyword screen flagged nothing never
     reached the model at all, and 657 of 747 live notes fire no keyword. An empty `units`
     is now the NORMAL request on a quiet date -- the triage pass in summariseAlerts() is
     the reason to call this function at all. index.html had the same early return in
     CALERT.load() and it went at the same time; one without the other fixes nothing. */

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
