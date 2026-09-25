// carenotes-summary  ·  the Care Notes day review, one AM/PM line per client  ·  (Supabase Edge Function)
//
// WHAT THIS IS FOR
//
// The Care Notes page opens on one date and shows, per client, an AM block and
// a PM block. Until now those blocks printed the caregiver's raw AxisCare note
// verbatim under a heading that said "Yesterday's Summary", which is the one
// thing a summary section is not. This writes the summary that belongs there.
// Asked for by Carlo on 2026-09-23.
//
// ── ONE MODEL CALL PER DATE, NOT ONE PER CLIENT ─────────────────────────────
//
// A whole date fits in one request, comfortably. Measured on the live mirror
// 2026-09-23 across the 37 dates in care_notes:
//
//     notes per date    avg 18.9   max 23
//     clients per date  avg 13.3   max 17
//     input tokens      avg ~3,400  max ~5,000
//
// So a date costs about 1.5 cents on Haiku 4.5 and the entire history
// backfills for under 50 cents. Asking per client-shift would be ~26 requests
// for the same tokens, and would throw away the one thing a whole-date pass
// can see that a per-row pass cannot: the same client's AM and PM read
// together, and one client's day beside the next.
//
// ── ON DEMAND, SAVED, NEVER SWEPT ───────────────────────────────────────────
//
// Summaries are written the first time ANYBODY opens that date and saved in
// public.care_note_summaries, one row per client x date x shift. Every later
// open, by anybody, reads the saved rows and spends nothing. A date nobody
// opens is never summarised. There is no cron and no backfill job.
//
//   key   <YYYY-MM-DD>|<axiscare client id>|<am|pm>
//
// A row records source_sig -- a fingerprint of the visit ids AND the note text
// behind it. carenotes-sync re-reads FRESH_DAYS = 2, so a caregiver can still
// be correcting today's or yesterday's note; a changed note changes the
// signature and the row is rewritten on the next open. Past dates settle and
// are written once.
//
// It also records MODEL and PROMPT_VERSION. Change either and old summaries
// are rewritten on their next open, which is what makes switching
// CARENOTES_MODEL actually change what the desk sees. Same rule as
// comms-summary.
//
// ── WHY THE FUNCTION READS THE NOTES ITSELF ─────────────────────────────────
//
// The browser already holds them in state.careNotes, so the obvious design is
// to post them here. It deliberately does not. The dashboard has no per-person
// login: a function that summarised whatever it was handed and saved the
// result would let anyone with the site URL write invented clinical summaries
// into the table and run the Anthropic key up on any text they liked. Taking
// only a DATE, reading care_notes with the service key, and saving with it
// means a summary can only ever describe notes AxisCare actually holds, and
// spend is capped at one pass per date per model.
//
// The table has RLS on and NO policies. The anon key can neither read nor
// write it; only this function touches it.
//
// ── PHI ─────────────────────────────────────────────────────────────────────
//
// These are clinical shift notes and they go to Anthropic in full. Carlo,
// 2026-09-23: "The Anthropic API that we have has the PHI contract." That is
// what makes this allowed; see CLAUDE.md, "What leaves the browser".
//
// Contact details are still redacted before the notes leave this function --
// a phone number or an email address in a care note adds nothing to a summary
// of somebody's shift, and comms-summary already measured that a prompt rule
// alone does not hold.
//
// ── THE MODEL HAS NO TOOLS ──────────────────────────────────────────────────
//
// It reads notes and returns text. Nothing it writes reaches any record except
// these summary rows. Same safety argument as devi-agent and comms-summary.
//
// ── SECRETS (Supabase project secrets) ──────────────────────────────────────
//   ANTHROPIC_API_KEY          shared with devi-agent, care-brief, comms-summary
//   ALLOWED_ORIGIN             shared with all of them
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   provided by Supabase itself
//   CARENOTES_MODEL            optional; default claude-haiku-4-5
//   CARENOTES_EFFORT           optional; default low. NOT sent to a Haiku
//                              model, which rejects the effort parameter (400)
//
// No new secret is needed. Switching model needs no code change and no redeploy:
//   npx supabase secrets set CARENOTES_MODEL=claude-sonnet-5 --project-ref gdzgoyawavffjdjpjbfz
//
// A COMMIT DOES NOT DEPLOY THIS FILE:
//   npx supabase functions deploy carenotes-summary --project-ref gdzgoyawavffjdjpjbfz --no-verify-jwt

const ANTHROPIC_KEY = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
const DB_URL = (Deno.env.get("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
const DB_KEY = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
const ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

/* `||`, not `??`: a secret set to an empty string must fall back to the
   default rather than send model "" and fail every request. */
const MODEL = (Deno.env.get("CARENOTES_MODEL") || "claude-haiku-4-5").trim();
const EFFORT = (Deno.env.get("CARENOTES_EFFORT") || "low").trim();
/* Haiku 4.5 answers 400 to output_config.effort. Every current model above it
   accepts it, so it is sent only when it can be understood. */
const SEND_EFFORT = !!EFFORT && !/haiku/i.test(MODEL);

/* Bump when PROMPT or the note formatting changes in a way that should rewrite
   summaries already saved. They are rewritten on their next open. */
/* 2: a block may hold more than one caregiver's note -- the PM window runs to
      6am, and a 45-word cap written for one note lost a caregiver's whole
      shift, reproduced against the live model 2026-09-23
   7: the caregiver's name moved OUT of the summary text and into its own
      "Caregiver: <name>" line the page renders above it (index.html,
      careShiftSummaryHtml) -- so the model must stop naming the caregiver
      and stop writing the caregiver as the subject ("Emelina helped Brenda
      through her morning routine"). It now writes a neutral, mostly
      passive shift report and leads with whatever the scheduler needs to
      know, ahead of routine care. Asked for by Mitch, 2026-09-25. */
const PROMPT_VERSION = 9;

const API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TZ = "America/Los_Angeles";
const TIMEOUT_MS = 120000;         // a whole date is a bigger call than one conversation
const TABLE = "care_note_summaries";
const NOTES_TABLE = "care_notes";

/* The AM window is 06:00-14:00 Pacific and the PM window is everything else.
   This MUST answer exactly the way careShiftOf() does in index.html, or a
   summary lands under the wrong heading. */
const AM_FROM = 6, AM_TO = 14;

/* A CLIENT'S WHOLE DAY -- every block they have -- is budgeted at this many
   words, which is the density of the sample Mitch supplied (11 clients, 399
   words, mean 36.3 per client-day). Each block is told its own share, because
   the model demonstrably cannot divide one budget across blocks it writes
   separately: told "40 words for the whole client", a two-block client came
   back at 83. */
const DAY_BUDGET_WORDS = 40;

/* A block past this is not a summary any more. Kept as the backstop that
   actually protects the page; the word budget above is what shapes it. */
const MAX_CHARS = 700;

/* A date with more notes than this is refused rather than sent. The live
   maximum is 23; 60 is well clear of any real day and stops a bad date
   parameter turning into an enormous request. */
const MAX_NOTES = 60;

/* One note past this is truncated for the model. The live maximum is 6,130
   characters and p99 is 2,045, so this trims nothing that occurs today. */
const MAX_NOTE_CHARS = 8000;

const RATE_MAX = 300;                     // requests per caller per hour; a cached read counts
const RATE_TOTAL = 1500;                  // per isolate per hour
const GEN_HOURLY_CAP = 120;               // model calls (i.e. DATES) per isolate per hour; the cost brake
const WINDOW_MS = 60 * 60 * 1000;

// --- CORS (same shape as devi-agent, quo, care-brief and comms-summary) ------
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

// --- rate limits (only an ALLOWED request is counted, so the window drains) --
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

/* Two schedulers opening the same date within a few seconds would otherwise
   each run a pass and each pay for it. The second waits on the first and then
   reads the rows it wrote. Per isolate, so it is a brake rather than a
   guarantee -- the same honest limit the other functions' locks have, and the
   worst case it fails to prevent costs about 1.5 cents. */
const inflight = new Map<string, Promise<DayResult>>();

class UpstreamError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// --- time ---------------------------------------------------------------------

/* Pacific calendar day and hour of an instant. AxisCare stamps its own offset
   and the page groups by Pacific day, so these must answer exactly the way
   careDayKey() and carePacHour() do in index.html. Reading a timestamp through
   the server's own clock is the bug that has already bitten the care-notes
   sync and the caregiver calendar. */
function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}
function pacHour(iso: string): number {
  return parseInt(new Date(iso).toLocaleString("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }), 10);
}
function shiftOf(iso: string): "am" | "pm" {
  const h = pacHour(iso);
  return (Number.isFinite(h) && h >= AM_FROM && h < AM_TO) ? "am" : "pm";
}
function timeLabel(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch { return ""; }
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

// --- text ---------------------------------------------------------------------

/* Care notes are typed by caregivers in AxisCare and a few of them carry a
   family member's phone number or an email address. None of that belongs in a
   summary of somebody's shift, and comms-summary already measured that telling
   the model to leave contact details out does not hold on its own -- with the
   rule in the prompt it still wrote an email address into a summary. So they
   are replaced HERE, before the notes leave this function, which also keeps
   them from reaching Anthropic at all; and once more over the output. */
function redact(s: string): string {
  return String(s ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email address]")
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, "[link]")
    /* E.164 and bare 11-digit first -- the NANP pattern below cannot match
       either. Live caregiver numbers are all 999-999-9999; a care note is not. */
    .replace(/\+1\d{10}\b/g, "[phone number]")
    .replace(/\b1[2-9]\d{9}\b/g, "[phone number]")
    .replace(/(?:\+?1[\s.\-\/]?)?\(?\b[2-9]\d{2}\)?[\s.\-\/]?\d{3}[\s.\-\/]?\d{4}\b/g, "[phone number]");
}

/* Same leading-punctuation trim as cleanNoteText() in index.html, so the model
   sees what the page shows. */
function cleanNote(t: string): string {
  return String(t ?? "").replace(/^[\s\-–—•\*·]+/, "").trim();
}

/* A fingerprint of the notes behind one row: their ids AND their text, so a
   caregiver correcting a note rewrites the summary. FNV-1a over the joined
   string -- this only has to change when the content changes, not be a
   cryptographic hash, and it must be stable across isolates. */
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

type Note = {
  visit_id: string; client_id: number | null; client_name: string | null;
  caregiver_name: string | null; visit_at: string | null; note: string;
};
type Row = {
  key: string; summary: string; source_sig: string; model: string; prompt_version: number;
};
type Unit = {
  key: string; clientId: number; clientName: string; shift: "am" | "pm";
  notes: Note[]; sig: string;
  /* sig fingerprints the visit ids AND the text, so two visits carrying the same
     pasted note have DIFFERENT sigs. textSig fingerprints the text alone, which is
     what identifies a block the model would be asked about twice. */
  textSig: string;
};
type DayResult = {
  day: string;
  units: { key: string; clientId: number; shift: "am" | "pm"; summary: string; sourceCount: number }[];
  generated: number; reused: number; model: string; saveFailed?: number;
};

function dbHeaders(extra?: Record<string, string>): Record<string, string> {
  return { apikey: DB_KEY, Authorization: "Bearer " + DB_KEY, Accept: "application/json", ...(extra ?? {}) };
}

/* Everything care_notes holds for one PACIFIC day. The filter is on the UTC
   instants of Pacific midnight to Pacific midnight, so it cannot inherit the
   "sliced textually vs cast" bug the open-shift mirror documents: a visit at
   2026-09-18T20:00-07:00 is the 18th here and the 19th in UTC. */
async function notesForDay(day: string): Promise<Note[]> {
  const from = new Date(laMidnightUtc(day)).toISOString();
  const to = new Date(laMidnightUtc(day) + 26 * 3600000).toISOString();   // 26h covers either DST shape
  const url = DB_URL + "/rest/v1/" + NOTES_TABLE +
    "?select=visit_id,client_id,client_name,caregiver_name,visit_at,note" +
    "&visit_at=gte." + encodeURIComponent(from) +
    "&visit_at=lt." + encodeURIComponent(to) +
    "&order=visit_at.asc&limit=" + (MAX_NOTES + 1);
  const r = await fetch(url, { headers: dbHeaders(), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new UpstreamError(502, "Could not read the care notes (HTTP " + r.status + ").");
  const rows = await r.json() as Note[];
  /* the 26-hour window can reach into the next Pacific day; keep only this one */
  return rows.filter((n) => n.visit_at && dayKey(n.visit_at) === day);
}

/* A failed READ is not a reason to refuse -- the summaries can still be
   written, they just cannot be served from the table this time. */
async function savedForDay(day: string): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  try {
    const r = await fetch(DB_URL + "/rest/v1/" + TABLE +
      "?select=key,summary,source_sig,model,prompt_version&day=eq." + encodeURIComponent(day),
      { headers: dbHeaders(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) { console.warn("[carenotes-summary] read HTTP " + r.status); return out; }
    (await r.json() as Row[]).forEach((row) => out.set(row.key, row));
  } catch (e) { console.warn("[carenotes-summary] read failed:", (e as Error)?.message); }
  return out;
}

async function dbPut(rows: Record<string, unknown>[]): Promise<boolean> {
  if (!rows.length) return true;
  try {
    const now = new Date().toISOString();
    const r = await fetch(DB_URL + "/rest/v1/" + TABLE + "?on_conflict=key", {
      method: "POST",
      headers: dbHeaders({ "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(rows.map((x) => ({ ...x, updated_at: now }))),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) console.warn("[carenotes-summary] write HTTP " + r.status + ": " + (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) { console.warn("[carenotes-summary] write failed:", (e as Error)?.message); return false; }
}

/* Rows this date holds that no longer correspond to any note -- a visit
   removed in AxisCare, or a note deleted from the mirror. Cheap to drop while
   we are already holding the date's rows, and it stops a summary outliving the
   note it describes. */
async function dbDel(keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    await fetch(DB_URL + "/rest/v1/" + TABLE + "?key=in.(" +
      keys.map((k) => '"' + k.replace(/"/g, '""') + '"').join(",") + ")", {
      method: "DELETE", headers: dbHeaders({ Prefer: "return=minimal" }), signal: AbortSignal.timeout(15000),
    });
  } catch { /* the row is simply stale; the next open tries again */ }
}

/* Written by the model, prompt and source in force now. Anything else is
   rewritten on this open. */
const current = (row: Row | undefined, u: Unit): boolean =>
  !!row && row.model === MODEL && row.prompt_version === PROMPT_VERSION && row.source_sig === u.sig;

// --- grouping ------------------------------------------------------------------

/* One unit per client x shift, exactly the blocks the page draws. Notes with
   no client id cannot be placed on a row and are dropped -- the page groups by
   clientId too, so they are not displayed either. */
function unitsFor(day: string, notes: Note[]): Unit[] {
  const by = new Map<string, Unit>();
  for (const n of notes) {
    if (n.client_id == null || !n.visit_at) continue;
    const text = cleanNote(n.note);
    if (!text) continue;
    const shift = shiftOf(n.visit_at);
    const key = day + "|" + n.client_id + "|" + shift;
    let u = by.get(key);
    if (!u) {
      u = { key, clientId: Number(n.client_id), clientName: String(n.client_name || "Client"), shift, notes: [], sig: "", textSig: "" };
      by.set(key, u);
    }
    u.notes.push(n);
  }
  const list = [...by.values()];
  for (const u of list) {
    /* visit_id breaks the tie: PostgREST promises no order for equal visit_at,
       so without it sig() depends on row order and a reshuffle pays for a
       regeneration that changes nothing. visit_id is care_notes' primary key,
       so the tiebreak is total. Two live client-days already tie. */
    u.notes.sort((a, b) => String(a.visit_at).localeCompare(String(b.visit_at)) ||
      String(a.visit_id).localeCompare(String(b.visit_id)));
    u.sig = sig(u.notes.map((n) => n.visit_id + "\u0001" + cleanNote(n.note)));
    u.textSig = sig(u.notes.map((n) => cleanNote(n.note)));
  }
  /* client name then AM before PM, so the model reads a client's day in order */
  list.sort((a, b) => a.clientName.localeCompare(b.clientName) || a.shift.localeCompare(b.shift));
  return list;
}

// --- the model -------------------------------------------------------------------

const PROMPT = [
  "You summarise caregiver shift notes for Devoted Care, a home-care agency in Ventura County,",
  "California. A scheduler reads your summaries first thing in the morning to see how yesterday",
  "went across every client, and opens the original note only when something needs following up.",
  "",
  "You are given one DAY. Within it, each block is ONE CLIENT and ONE SHIFT -- AM is 6am-2pm,",
  "PM is 2pm-6am, which is the evening AND the whole night. Each block holds what the",
  "caregivers wrote after those visits. Summarise EVERY block.",
  "",
  "A BLOCK MAY HOLD MORE THAN ONE NOTE. The PM window runs to 6am, so an evening",
  "caregiver and an overnight caregiver can both write in the same block, and a",
  "client can have two visits in one window. When a block has more than one note,",
  "cover EVERY note in it -- never summarise only the first or only the longest.",
  "You do not need to say how many caregivers wrote in this block or separate their",
  "visits out -- just describe what happened across the shift. You may use up to",
  "FIVE sentences and 75 words for a block that holds two or more notes.",
  "",
  "OUTPUT: a JSON array and nothing else. No markdown, no code fence, no preamble. One object per",
  "block, in the order given: [{\"id\":\"<the block id>\",\"summary\":\"<the summary>\"}]",
  "Every id you were given must appear exactly once. Use the ids verbatim.",
  "",
  "EVERY BLOCK CARRIES ITS OWN WORD BUDGET, on a \"Budget:\" line in its header. Honour that",
  "number. It is already divided for you: a client's whole day is budgeted together, so a",
  "client with one block gets the lot and a client with an AM and a PM block gets half each.",
  "Do not borrow from the other block. One sentence is the normal shape for a half-share.",
  "",
  "SHORT AND SPECIFIC ARE NOT OPPOSITES, and you need both. Short means mentioning FEWER",
  "things. It NEVER means naming the same things more vaguely.",
  "",
  "NEVER name a CATEGORY of care in place of the care itself. These are banned outright:",
  "\"morning routine\", \"evening routine\", \"night routine\", \"personal care\", \"home care\",",
  "\"pet care\", \"household tasks\", \"light housework\", \"care provided\", \"care given\",",
  "\"care completed\", \"assistance as needed\", \"assisted as needed\". Write the actual thing:",
  "  NOT \"pet and home care completed\"",
  "  BUT \"Caregiver fed the birds, cleaned the litter box and swept the porch\"",
  "  NOT \"morning routine completed with shower\"",
  "  BUT \"Caregiver helped Client shower, then dressed her and made breakfast\"",
  "A scheduler cannot act on a category. If it will not all fit, drop the least important",
  "item COMPLETELY and write what is left concretely -- never compress by going vaguer.",
  "",
  "A scheduler reads fifteen clients before 9am and can open any original note in one click,",
  "so a quiet day should still be short. Count the words before you answer. If you are over,",
  "cut care tasks first and never cut something the office has to act on. Plain prose -- no",
  "headings, labels, bullets or quotation marks.",
  "",
  "HOW IT SHOULD READ. A short handover report TO THE SCHEDULER, in plain sentences that say",
  "who did what.",
  "",
  "NEVER WRITE A PERSONAL NAME for the caregiver or the client -- the page already prints both",
  "directly above your text, so a name there is wasted words. Write the ordinary words",
  "\"Caregiver\" and \"Client\" instead, and use them as real subjects:",
  "  \"Caregiver helped Client shower and dress, then made her breakfast.\"",
  "  \"Client refused a shower but let Caregiver change her clothes.\"",
  "  \"Caregiver took Client to the farmers market and made lunch when they got back.\"",
  "That is the voice the desk asked for. Do NOT retreat into subject-less fragments like",
  "\"Morning routine completed\" or \"Medications given\" -- a whole summary written that way",
  "reads as a checklist and tells the scheduler less than it looks like it does.",
  "",
  "Not every sentence needs a subject, and repeating \"Caregiver ... Caregiver ... Caregiver\"",
  "at the head of every sentence is worse than varying it -- join clauses with \"then\" and",
  "\"and\", and let the client be the subject when the client is who acted (\"Client slept",
  "through\", \"Client ate almost nothing at lunch\"). Flowing prose that groups related care --",
  "not a timestamped log, not a checklist.",
  "",
  "NEVER SPEND A CLAUSE ON THE SHIFT WINDOW ITSELF. \"Evening and overnight care included...\",",
  "\"Overnight:\", \"Caregiver cared for Client through the evening and night\" -- the column this",
  "lands in is already headed AM Shift or PM Shift, so a clause that only names the window",
  "says nothing. Open with something that HAPPENED.",
  "Saying WHEN something happened is fine where it carries information -- \"woke in the night\",",
  "\"refused dinner\", \"settled by morning\". What is banned is a phrase about the window with no",
  "action in it.",
  "",
  "AND WRITE NO NUMBERS -- this is the rule most often lost, so it is repeated here beside",
  "the register and again in RULES below. No clock times, no counts, no volumes, no doses.",
  "\"woke around 3:00 AM\" is \"woke in the night\"; \"fed at 9:20 PM and 3:30 AM\" is \"fed",
  "twice overnight\"; \"three brief changes\" is \"changed several times\". SPELLING A NUMBER OUT",
  "DOES NOT MAKE IT ALLOWED -- \"at three o'clock\" and \"bedtime at eleven\" are clock times and",
  "are banned exactly as the digits are. The one exception is a figure somebody REACTED to,",
  "and it is spelled out in RULES.",
  "",
  "TWO CLIENTS IN ONE BLOCK. Most blocks are one person, and \"Client\" is right for them.",
  "A COUPLE is one block with two people in it -- there \"the client\" is wrong and confusing,",
  "so use the first names the note uses and say which of them each thing happened to.",
  "",
  "These are illustrations, not real notes -- never reuse their wording, details or times:",
  "",
  "  Routine, nothing to flag:   Caregiver helped Client shower and dress, then made",
  "                              breakfast and washed up afterwards. They did side-step and",
  "                              walking exercises together. Both sons visited in the",
  "                              afternoon.",
  "",
  "  Needs a scheduler's eye:    Client woke anxious and kept repeating herself, wheezing and",
  "                              pale, and a breathing treatment did not settle it. Her",
  "                              abdomen was distended, so Caregiver used a heating pad and",
  "                              the visiting nurse checked the catheter.",
  "",
  "  A couple, one block:        Caregiver gave Ambrose his laxative and took both of them to",
  "                              a nail appointment. Winifred had a sponge bath, and Caregiver",
  "                              changed briefs for both.",
  "",
  "  NOT this -- the window named, then the clock:",
  "                              Evening and overnight care included peri-care and brief",
  "                              changes. Client woke around 1:15 AM when Ensure was",
  "                              offered, and was ready for breakfast by 7:30 AM.",
  "  The same shift, written right:",
  "                              Caregiver gave peri-care and changed briefs. Client woke once",
  "                              in the night and took Ensure, then slept until morning.",
  "",
  "  NOT this -- a category instead of the care:",
  "                              Pet and home care completed. Evening routine included lotion",
  "                              and oxygen setup.",
  "  The same shift, written right:",
  "                              Caregiver fed the birds, cleaned the litter box and swept the",
  "                              porch, then massaged Client's legs with lotion and set up her",
  "                              oxygen for the night.",
  "",
  "PRIORITISE, in this order, and lead with whichever of these the notes actually contain:",
  "1. a change in the client's condition, or anything unusual the caregiver observed",
  "2. care that was missed, refused, or left incomplete",
  "3. a safety concern -- a fall, an injury, a near-miss, anything unsafe in the home",
  "4. anything the caregiver raised or seemed concerned about",
  "5. anything that needs the scheduler or the office to follow up",
  "Routine, uneventful care can follow in one short clause once the above is covered -- or be",
  "the whole summary when none of the above applies. A quiet, ordinary shift is a good",
  "outcome: say so briefly rather than padding it out with routine tasks.",
  "",
  "WHAT ALWAYS SURVIVES THE CUT, ahead of any care task: a change in the client's condition or",
  "care plan; confusion, agitation, a refusal, a fall or new pain; anything the client or the",
  "family asked for; and anything the caregiver raised or left for the office. If you are over",
  "budget, a routine care task comes out to make room for one of these -- never the other way",
  "round.",
  "",
  "RULES:",
  "- Use ONLY what the note says. Never infer a diagnosis, a cause, a severity or an outcome that",
  "  was not written. If the note is vague, your summary is vague -- do not improve it.",
  "- Never give medical advice and never suggest a treatment or a medication change.",
  "- Keep medication names and doses only where the note is reporting what happened with them",
  "  (refused, vomited, ran out). Do not list a routine medication pass beyond \"medications given\".",
  "- NEVER write the caregiver's or the client's personal NAME -- both are already shown",
  "  above your text. Use the plain words \"Caregiver\" and \"Client\", and use them as subjects.",
  "  The ONE exception is a couple, below. A family member, nurse or doctor the note mentions",
  "  may be referred to by role (\"the nurse\", \"her son\") but never invent one who is not in",
  "  the note.",
  "- WRITE NO NUMBERS. No clock times, no vital signs, no blood sugars, no intake or output",
  "  volumes, no doses, no counts of brief changes, bathroom trips or repositionings, no menu",
  "  quantities. The scheduler cannot act on a reading and the note behind the button already",
  "  has every one of them. Describe the PATTERN instead: \"restless and up to the toilet all",
  "  night\", \"ate almost nothing at lunch\", \"slept through\".",
  "- THE ONE EXCEPTION: a figure the note shows somebody REACTING to. A dose repeated because",
  "  the first did nothing; a reading a nurse or the family was rung about; an instruction that",
  "  followed from it. Even then, give it ONCE and say what was done -- never a run of",
  "  individual readings.",
  "- A number you print is a claim you have to be right about, and the desk cannot check it",
  "  without opening the note. When in doubt, leave it out.",
  "- Notes may mix English and Tagalog, be lightly punctuated, or be typed on a phone. Summarise",
  "  the meaning in English.",
  "- Contact details already appear as [phone number], [email address] or [link]. Do not mention",
  "  those placeholders.",
  "- If a note says essentially nothing (a few words, or boilerplate), say that THE NOTE",
  "  records almost nothing about the shift. Do not invent a shift to describe.",
  "- NEVER mention the block, its id, its AM/PM label or the shift window, and never remark",
  "  that a note looks misfiled or belongs elsewhere. Summarise the care in the notes you were",
  "  given. How they are grouped is not the reader's problem and not yours.",
  "- NEVER characterise how well somebody documented their shift. Describe what the note",
  "  contains; do not write that a caregiver \"reported minimal detail\", \"gave little\" or",
  "  \"documented poorly\". That is a judgement about a person, it is saved in a clinical",
  "  record, and the block header already says whose shift it was.",
].join("\n");

/* `share` is DAY_BUDGET_WORDS split across however many blocks this client has
   on the date, rounded to 5 so it reads as guidance rather than false
   precision. Computed here because the model cannot do it: see PROMPT_VERSION 6. */
function blockFor(u: Unit, share: number): string {
  const head = "### " + u.key + "\n" +
    "Client: " + u.clientName + "\n" +
    /* NO GLOSS ON THE PM WINDOW. This line used to read "PM (2:00 PM - 6:00 AM,
       evening and overnight)" -- handing the model, in the user message inches above the
       notes, the exact phrase the system prompt forbids it to open with. All 7 of the
       live rows that opened "Evening and overnight care included..." were PM blocks. The
       hours say what the window is; the prompt says what it covers. */
    "Shift: " + (u.shift === "am" ? "AM (6:00 AM - 2:00 PM)"
                                  : "PM (2:00 PM - 6:00 AM)") + "\n" +
    "Budget: " + share + " words\n";
  const body = u.notes.map((n) => {
    /* FIRST NAME, from care_notes.caregiver_name -- the agency's own spelling.
       Passing the full name invited "Donmar Erick Villanueva's shift with Jose
       Ortiz from 6:55 PM", 14 words of identification against a 45-word cap. */
    const who = String(n.caregiver_name || "").trim().split(/\s+/)[0] || "Caregiver";
    const when = n.visit_at ? timeLabel(n.visit_at) : "";
    const text = redact(cleanNote(n.note)).slice(0, MAX_NOTE_CHARS);
    return who + (when ? " (" + when + ")" : "") + ": " + text;
  }).join("\n\n");
  return head + "\n" + body;
}

async function askClaude(day: string, units: Unit[]): Promise<Map<string, string>> {
  /* how many blocks each client has in THIS request, so the day budget can be
     split before the model ever sees it */
  const blocks = new Map<number, number>();
  units.forEach((u) => blocks.set(u.clientId, (blocks.get(u.clientId) ?? 0) + 1));
  const share = new Map<number, number>();
  blocks.forEach((n, id) => share.set(id, Math.max(15, Math.round(DAY_BUDGET_WORDS / n / 5) * 5)));
  /* A caregiver sometimes pastes the SAME note onto both of a client's visits for a
     date -- 13 client-days in the live mirror, 6% of the two-block ones, six clients.
     Handed that daytime note under a heading reading "PM (2:00 PM - 6:00 AM, evening and
     overnight)", the model invents an overnight to fill the heading, and has written
     summaries that CONTRADICT the note it was given. So ask once per distinct note text
     and copy the answer to its twins: that cannot fabricate, it is what the page showed
     anyway whenever this behaved, and it costs fewer tokens. A prompt rule was tried
     first and held in one candidate but not the next -- the wrong kind of guarantee for
     invented clinical content. The share above is deliberately still computed from the
     REAL block count, so collapsing changes no summary's length. */
  const twins = new Map<string, Unit[]>();
  for (const u of units) {
    const k = u.clientId + "\u0001" + u.textSig;
    const g = twins.get(k);
    if (g) g.push(u); else twins.set(k, [u]);
  }
  const send = [...twins.values()].map((g) => g[0]);

  const content =
    "Date: " + new Date(laMidnightUtc(day) + 12 * 3600000).toLocaleDateString("en-US",
      { timeZone: TZ, weekday: "long", month: "long", day: "numeric", year: "numeric" }) + "\n" +
    "Blocks to summarise: " + send.length + "\n\n" +
    send.map((u) => blockFor(u, share.get(u.clientId) ?? DAY_BUDGET_WORDS)).join("\n\n");

  /* max_tokens INCLUDES THINKING. Haiku does not think unless asked, but a
     CARENOTES_MODEL switch to Sonnet 5 or Opus 5 does by default, and a budget
     sized for the answer returns HTTP 200 with an EMPTY text block -- the trap
     care-brief, devi-agent and comms-summary all hit. 26 blocks of 45 words is
     ~1,500 tokens of answer, so this is thinking room, and only what is used is
     billed. */
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 16000,
    system: PROMPT,
    messages: [{ role: "user", content }],
  };
  /* No temperature: Sonnet 5 and Opus 5 reject it, and switching the model must
     not start failing every request. */
  if (SEND_EFFORT) body.output_config = { effort: EFFORT };

  const r = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": ANTHROPIC_VERSION },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await r.json().catch(() => null) as any;
  if (!r.ok) throw new UpstreamError(502, "Anthropic: " + (data?.error?.message || ("HTTP " + r.status)));
  if (data?.stop_reason === "refusal") throw new UpstreamError(502, "The model declined to summarise these notes.");
  const text = ((data?.content ?? []) as any[]).filter((p) => p?.type === "text").map((p) => p.text || "").join("").trim();
  console.info("[carenotes-summary] " + MODEL + " day=" + day + " blocks=" + units.length +
    " in=" + (data?.usage?.input_tokens ?? "?") + " out=" + (data?.usage?.output_tokens ?? "?"));
  if (!text) {
    throw new UpstreamError(502, data?.stop_reason === "max_tokens"
      ? "The model spent its whole budget thinking and returned no text (stop_reason: max_tokens)."
      : "The model returned no text (stop_reason: " + String(data?.stop_reason ?? "unknown") + ").");
  }

  /* Parse defensively. A block missing from the answer simply stays
     unsummarised and the page falls back to the original note for it -- far
     better than losing the whole date to one malformed entry. */
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch {
    const m = /\[[\s\S]*\]/.exec(text);          // a fence or a sentence around it
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* fall through */ } }
  }
  if (!Array.isArray(parsed)) throw new UpstreamError(502, "The model did not return a JSON array of summaries.");

  const want = new Set(send.map((u) => u.key));
  const out = new Map<string, string>();
  for (const item of parsed) {
    const id = String(item?.id ?? "");
    if (!want.has(id) || out.has(id)) continue;   // an unknown or repeated id is discarded
    /* typeof, not String(): String({...}) is "[object Object]", a non-empty
       string under MAX_CHARS, so it would be SAVED and then served forever in
       place of the note it was meant to summarise. */
    if (typeof item?.summary !== "string") continue;
    const s = redact(item.summary)
      .replace(/\s*\n+\s*/g, " ").replace(/^["'“‘]+|["'”’]+$/g, "").trim();
    /* Refuse a runaway rather than cutting it off mid-sentence: a truncated
       summary saved forever is worse than none, and the next open tries again. */
    if (!s || s.length > MAX_CHARS) continue;
    out.set(id, s);
  }

  /* every twin gets the answer its representative got. A representative the model
     dropped leaves its whole group unsummarised, which is the existing behaviour for a
     dropped block: that block alone falls back to its raw note. */
  for (const group of twins.values()) {
    const s = out.get(group[0].key);
    if (s === undefined) continue;
    for (let i = 1; i < group.length; i++) out.set(group[i].key, s);
  }
  return out;
}

// --- one date --------------------------------------------------------------------

async function summariseDay(day: string): Promise<DayResult> {
  const notes = await notesForDay(day);
  if (notes.length > MAX_NOTES) {
    throw new UpstreamError(413, "That date holds " + notes.length + " care notes, more than this can summarise in one pass (" + MAX_NOTES + ").");
  }
  const units = unitsFor(day, notes);
  const saved = await savedForDay(day);

  /* drop rows whose notes have gone entirely */
  const live = new Set(units.map((u) => u.key));
  const orphans = [...saved.keys()].filter((k) => !live.has(k));
  if (orphans.length) await dbDel(orphans);

  const stale = units.filter((u) => !current(saved.get(u.key), u));
  const out: DayResult = {
    day, units: [], generated: 0, reused: units.length - stale.length, model: MODEL,
  };

  let fresh = new Map<string, string>();
  if (stale.length) {
    if (genCapped()) throw new UpstreamError(429, "Too many dates have been summarised in the last hour. Try again shortly.");
    fresh = await askClaude(day, stale);
    const rows = stale.filter((u) => fresh.has(u.key)).map((u) => ({
      key: u.key, day, client_id: u.clientId, shift: u.shift,
      summary: fresh.get(u.key), source_sig: u.sig, source_count: u.notes.length,
      model: MODEL, prompt_version: PROMPT_VERSION,
    }));
    /* Report what HAPPENED, not what was attempted. The model call is already
       paid for either way, so a failed write costs nothing extra -- but saying
       "generated: 22" when nothing was saved is a false success, and the next
       open silently regenerates with no sign of why. */
    const stored = await dbPut(rows);
    out.generated = stored ? rows.length : 0;
    if (!stored && rows.length) out.saveFailed = rows.length;
  }

  for (const u of units) {
    const s = fresh.get(u.key) ?? (current(saved.get(u.key), u) ? saved.get(u.key)!.summary : "");
    /* sourceCount travels so the BROWSER can tell that the summary describes
       more notes than it holds -- state.careNotes is boot-time, this table is
       live. The page falls back to the raw notes when they disagree, so it
       never shows a summary it cannot also show the originals for. */
    if (s) out.units.push({ key: u.key, clientId: u.clientId, shift: u.shift, summary: s, sourceCount: u.notes.length });
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
      return json(cors, 405, { ok: false, error: "Summaries are requested with POST. GET supports only ?action=status." });
    }
    return json(cors, 200, {
      ok: true, configured: missing().length === 0, missing: missing(),
      model: MODEL, effort: SEND_EFFORT ? EFFORT : "not sent (" + MODEL + " does not accept it)",
      promptVersion: PROMPT_VERSION, maxNotesPerDay: MAX_NOTES,
    });
  }
  /* POST, not GET: a request here can cost money and write rows, and a GET
     lands in browser history, prefetches and crawler queues. */
  if (req.method !== "POST") return json(cors, 405, { ok: false, error: "Only POST (and GET ?action=status) are supported." });

  if (missing().length) {
    return json(cors, 503, { ok: false, error: "Care note summaries are not configured on the server.", missing: missing() });
  }

  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return json(cors, 429, { ok: false, error: "too many requests - try again shortly" });

  const b = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return json(cors, 400, { ok: false, error: "Send a JSON body." });

  const day = String(b.day ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(Date.parse(day + "T00:00:00Z"))) {
    return json(cors, 400, { ok: false, error: "day must be YYYY-MM-DD." });
  }
  /* A future date has no notes and a date before the mirror begins has none
     either; both are answered from the table rather than refused, because an
     empty answer is the honest one. */

  try {
    let p = inflight.get(day);
    if (!p) {
      p = summariseDay(day).finally(() => { inflight.delete(day); });
      inflight.set(day, p);
    }
    return json(cors, 200, { ok: true, ...(await p) });
  } catch (err) {
    const e = err as Error & { status?: number };
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    const status = timedOut ? 504 : (e instanceof UpstreamError ? e.status : 500);
    console.warn("[carenotes-summary] failed:", e?.message);
    return json(cors, status, { ok: false, error: timedOut ? "Timed out reading the notes or writing the summaries." : (e?.message || "Something went wrong.") });
  }
});
