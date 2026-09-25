// ============================================================================
// care-plan  —  the Devoted Care CARE PLAN AGENT
//
// Mitch's spec, 2026-09-25. One living care plan per active client: what a
// caregiver needs to know to care for this client TODAY, plus a separate list
// of things that genuinely need office review.
//
// IT LIVES IN THE SCHEDULING APP, not in Client Concierge. Mitch's document is
// headed "Client Concierge Dashboard" because she reused the header; Carlo
// confirmed the agent belongs here and Concierge reuses it.
//
// ── WHAT IT READS, AND WHY THAT IS THE WHOLE SAFETY ARGUMENT ────────────────
//
// Same shape as care-brief: the browser passes a CLIENT ID and nothing else.
// The function reads the clinical record itself, with its own credentials. A
// design where the browser read the record and posted it up to be summarised
// would make every client's mobility, continence and cognition readable by
// anyone with the site URL. There is no `fields` parameter and no way to ask
// this function for raw text.
//
//   Concierge  concierge_records.data.careNeeds  (the assessment)
//              + the fallRisk / cognitive / hospice columns
//   this app   public.care_notes                 (what has actually happened)
//              public.client_care_plans          (the plan being maintained)
//
// ── MEDICATIONS ARE READ HERE, AND NOT IN care-brief ────────────────────────
//
// Carlo, 2026-09-25: "include the medication so that the model can properly
// give more accurate suggestion." PROMPT_VERSION 2 reads medManage, medInstr,
// routineAM, routinePM, routineDay, feeding and `other` -- the fields
// care-brief deliberately never touches.
//
// THIS DOES NOT OVERTURN care-brief's RULE, because that rule is about a
// different audience. Mitch's "Do NOT include medications" was written for a
// function whose whole output is ONE LINE OF AN OUTBOUND TEXT to a caregiver
// who has not accepted the shift yet: forwarded, screenshotted, read on a lock
// screen, alongside a client named by given name only. A care plan is read by
// the ASSIGNED caregiver and the office, inside the PIN-gated dashboard.
//
//   care-brief  -> SAFE_FIELDS only, medication filtered in and out. UNCHANGED.
//   care-plan   -> READ_FIELDS, medications included, no medication filter.
//
// Claude: do not "harmonise" these two field lists. They differ on purpose, and
// care-brief's tests assert its own list.
//
// ── PERMISSION IS THE HARD PART, NOT THE DATA ───────────────────────────────
//
// index.html's medication guide says "Caregivers remind and observe only --
// they do not give or administer medications". 177 of 748 live care notes
// document a caregiver giving one. That contradiction is real, and it is not
// this agent's to settle. Mitch's spec: "Never assume that a caregiver is
// permitted to administer a medication simply because the medication appears
// somewhere in the client's records."
//
// So the prompt states what is RECORDED about responsibility, never asserts
// permission, and sends an unclear or contradicted responsibility to the
// attention list -- which is exactly where her spec puts it.
//
// ── THE PLAN IS STORED IN THE SCHEDULING DATABASE ───────────────────────────
//
// Which care-brief's header says the clinical record never is. A care plan
// cannot be a living document otherwise. RLS is on with no policies,
// service-role only. See supabase/client-care-plans.sql. With medications now
// included, what is at rest here is a fuller clinical record than before, and
// the dashboard still has no per-person login.
//
// ── SECRETS (Supabase project secrets; a commit does NOT deploy this) ───────
//
//   ANTHROPIC_API_KEY            required
//   CONCIERGE_SUPABASE_URL       required   } already set for care-brief
//   CONCIERGE_ANON_KEY  or  SUPABASE_ANON_KEY_CONCIERGE   required
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   required (this project)
//   CAREPLAN_MODEL               optional; default falls back to CONCIERGE_MODEL
//   CAREPLAN_EFFORT              optional; NOT sent to Haiku, which 400s on it
//   ALLOWED_ORIGIN               shared with the other functions
//
//   npx supabase functions deploy care-plan --project-ref gdzgoyawavffjdjpjbfz --no-verify-jwt
//   Run supabase/client-care-plans.sql FIRST -- this function swallows database
//   errors by design, so a missing table looks fine on screen while re-billing
//   the Anthropic key on every open.
// ============================================================================

const ANTHROPIC_KEY = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
const MODEL = (Deno.env.get("CAREPLAN_MODEL") ?? Deno.env.get("CONCIERGE_MODEL") ?? "claude-opus-5").trim();
const EFFORT = (Deno.env.get("CAREPLAN_EFFORT") ?? "medium").trim();
/* Haiku answers 400 to output_config.effort -- the trap every function here documents. */
const SEND_EFFORT = !!EFFORT && !/haiku/i.test(MODEL);

const CONCIERGE_URL = (Deno.env.get("CONCIERGE_SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
const CONCIERGE_KEY = (Deno.env.get("CONCIERGE_ANON_KEY") ??
                       Deno.env.get("SUPABASE_ANON_KEY_CONCIERGE") ?? "").trim();
const DB_URL = (Deno.env.get("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
const DB_KEY = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
const ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

const API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TABLE = "client_care_plans";
const NOTES_TABLE = "care_notes";
const TZ = "America/Los_Angeles";
const TIMEOUT_MS = 90000;

const PROMPT_VERSION = 2;

/* How much recent history the plan reasons over. A pattern is the point -- one
   difficult transfer is not a care-plan change, repeated ones are -- so this has
   to be wide enough to show a trend and narrow enough to be CURRENT. 60 days is
   about 8 weeks of visits for a daily client. */
const NOTE_DAYS = 60;
const MAX_NOTES = 60;
const MAX_NOTE_CHARS = 1600;
const MAX_ITEMS_PER_SECTION = 8;
const MAX_ITEM_CHARS = 220;
const MAX_ATTENTION = 5;
const MAX_FIELD_CHARS = 4000;

/* Printed under the card. Not a caveat about missing data any more -- a caveat about
   PERMISSION, which is the thing a caregiver must not get wrong. */
const MED_NOTE = "Medication lines describe what is recorded for this client. They are not " +
  "authority to give anything: caregivers remind and observe unless the client's own record " +
  "says otherwise. Check with the office if it is unclear.";

/* The only section titles that may appear, so the card stays stable and a
   model cannot invent a heading. A section that does not apply is OMITTED --
   never filled with "None" or "Not applicable", per the spec. */
const SECTIONS = [
  "Conditions and care considerations",
  "Cognition and communication",
  "Mobility and transfers",
  "Falls and safety",
  "Personal care",
  "Toileting",
  "Meals, nutrition and hydration",
  "Medication support",
  "Daily routine and preferences",
  "Behaviour and dementia approaches",
  "Special precautions",
  "Family and office instructions",
  "Other client-specific needs",
];

/* Fields read from careNeeds. DELIBERATELY WIDER THAN care-brief's -- see the header.
   The medication and routine fields are the ones care-brief refuses, and they are here
   because a plan that cannot say what a shift involves is not a plan. */
const READ_FIELDS = [
  "mobility", "personal", "adl", "transferAssist", "ambulation", "standLong", "safety",
  "medManage", "medInstr", "routineAM", "routinePM", "routineDay", "feeding", "other",
];
const SAFE_COLUMNS = ["fallRisk", "cognitive", "hospice"];

// --- no medication filter, since PROMPT_VERSION 2 --------------------------
/* care-brief's detector and its per-sentence stripper USED TO RUN HERE, on every field
   read and again over every item returned. Both are gone: with medications deliberately
   included, dropping them would be dropping the thing this version exists to add.

   What that means honestly: there is no longer a mechanical backstop on medication
   content in this function. The only guards are the prompt's rules about permission and
   the fixed caveat printed under the card. care-brief keeps its detector, its
   second-model check and its tests -- that function's guarantee is unchanged.

   redact() stays. Phone numbers, emails and links add nothing to a care plan. */

/* Contact details add nothing to a care plan and must not be stored here.
   Same redaction the other functions apply. */
function redact(s: string): string {
  return String(s ?? "")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/gi, "[email address]")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/\b(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone number]");
}

class UpstreamError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// --- CORS (same shape as care-brief, quo and the summary functions) ----------
function normOrigin(s: string): string { return s.trim().replace(/\/+$/, ""); }
function originAllowed(origin: string): boolean {
  if (!origin) return false;
  const o0 = normOrigin(origin);
  return ORIGINS.some((raw) => {
    const o = normOrigin(raw);
    if (o === "*" || o === o0) return true;
    const i = o.indexOf("*");
    if (i < 0) return false;
    return o0.startsWith(o.slice(0, i)) && o0.endsWith(o.slice(i + 1));
  });
}
function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": originAllowed(origin) ? origin : "null",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}
function json(cors: Record<string, string>, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}

// --- brakes -----------------------------------------------------------------
const GEN_CAP = 60;                       // model calls per isolate per hour
const WINDOW_MS = 60 * 60 * 1000;
const gens: number[] = [];
function genCapped(): boolean {
  const now = Date.now();
  while (gens.length && now - gens[0] > WINDOW_MS) gens.shift();
  if (gens.length >= GEN_CAP) return true;
  gens.push(now);
  return false;
}

function dbHeaders(extra?: Record<string, string>): Record<string, string> {
  return { apikey: DB_KEY, Authorization: "Bearer " + DB_KEY, Accept: "application/json", ...(extra ?? {}) };
}

function sig(parts: string[]): string {
  const s = parts.join("\u0000");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return s.length.toString(36) + "-" + h.toString(36);
}

// --- the sources ------------------------------------------------------------

type Assessment = { text: string; skipped: string[] };

/* The client's Concierge record, whitelisted and filtered. Returns the prose a
   plan may be built from and a list of what was held back, so a thin plan can
   be explained rather than wondered about. */
async function assessmentFor(clientId: number): Promise<Assessment> {
  const skipped: string[] = [];
  if (!CONCIERGE_URL || !CONCIERGE_KEY) return { text: "", skipped: ["Client Concierge is not configured"] };
  let rows: { rid: string; data: Record<string, unknown> }[] = [];
  try {
    const r = await fetch(CONCIERGE_URL + "/rest/v1/concierge_records?type=eq.clients&select=rid,data&limit=200", {
      headers: { apikey: CONCIERGE_KEY, Authorization: "Bearer " + CONCIERGE_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return { text: "", skipped: ["Client Concierge returned HTTP " + r.status] };
    rows = await r.json();
  } catch (e) {
    return { text: "", skipped: ["Client Concierge could not be read: " + ((e as Error)?.message ?? "unknown")] };
  }

  /* Concierge keys its own records by its own id, so the AxisCare id is matched
     against whichever field carries it. Same lookup care-brief does. */
  const want = String(clientId);
  const rec = rows.find((x) => {
    const d = (x.data ?? {}) as Record<string, unknown>;
    return String(d.axisId ?? d.axiscareId ?? d.externalId ?? d.clientId ?? x.rid) === want;
  });
  if (!rec) return { text: "", skipped: ["No Client Concierge record for this client"] };

  const d = (rec.data ?? {}) as Record<string, unknown>;
  const cn = (d.careNeeds ?? {}) as Record<string, unknown>;
  const out: string[] = [];

  for (const f of READ_FIELDS) {
    const raw = String(cn[f] ?? "").trim();
    if (!raw) continue;
    out.push(f + ": " + redact(raw).slice(0, MAX_FIELD_CHARS));
  }
  for (const c of SAFE_COLUMNS) {
    const v = d[c] ?? cn[c];
    if (v === null || v === undefined || String(v).trim() === "") continue;
    out.push(c + ": " + redact(String(v).trim()));
  }
  return { text: out.join("\n"), skipped };
}

type Note = { visit_id: string; visit_at: string | null; caregiver_name: string | null; note: string };

/* This client's recent notes, newest first. The EVIDENCE half: an assessment
   says what was true at intake, the notes say what is true now. */
async function notesFor(clientId: number): Promise<Note[]> {
  const from = new Date(Date.now() - NOTE_DAYS * 86400000).toISOString();
  try {
    const u = DB_URL + "/rest/v1/" + NOTES_TABLE +
      "?client_id=eq." + clientId + "&visit_at=gte." + encodeURIComponent(from) +
      "&select=visit_id,visit_at,caregiver_name,note&order=visit_at.desc&limit=" + MAX_NOTES;
    const r = await fetch(u, { headers: dbHeaders(), signal: AbortSignal.timeout(20000) });
    if (!r.ok) return [];
    return (await r.json() as Note[]).filter((n) => String(n.note ?? "").trim());
  } catch { return []; }
}

type PlanRow = {
  client_id: number; sections: { title: string; items: string[] }[];
  attention: Record<string, string>[]; source_sig: string; model: string; prompt_version: number;
  notes_seen: number; skipped: string[];
};

async function savedPlan(clientId: number): Promise<PlanRow | null> {
  try {
    const r = await fetch(DB_URL + "/rest/v1/" + TABLE + "?client_id=eq." + clientId +
      "&select=client_id,sections,attention,source_sig,model,prompt_version,notes_seen,skipped",
      { headers: dbHeaders(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const rows = await r.json() as PlanRow[];
    return rows && rows[0] ? rows[0] : null;
  } catch { return null; }
}

async function putPlan(row: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch(DB_URL + "/rest/v1/" + TABLE + "?on_conflict=client_id", {
      method: "POST",
      headers: dbHeaders({ "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) console.warn("[care-plan] write HTTP " + r.status + ": " + (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) { console.warn("[care-plan] write failed:", (e as Error)?.message); return false; }
}

// --- the model --------------------------------------------------------------

const PROMPT = [
  "You are the Devoted Care Care Plan Agent. You maintain ONE care plan for ONE client, for",
  "caregivers and the Devoted Care office to read before and during a shift.",
  "",
  "YOUR JOB IS NOT TO COPY THE SOURCES. Read them, work out what is true about this client's",
  "care NOW, and write that. A care plan that restates the assessment is worth nothing.",
  "",
  "You are given, for this client only:",
  "  ASSESSMENT      what Client Concierge records about their care needs",
  "  RECENT NOTES    what caregivers actually wrote on recent shifts, newest first",
  "  CURRENT PLAN    the plan in force, if there is one",
  "Never use anything about another client. You have nothing else; do not imply you do.",
  "",
  "== WHEN THERE IS NO CURRENT PLAN ==",
  "Build one. Include only what is relevant to caring for this client today, organised so a",
  "caregiver can find what they need fast.",
  "",
  "== WHEN THERE IS A CURRENT PLAN ==",
  "Treat it as a living document. Carry forward everything still true, and change only what",
  "the evidence actually changes: a real change in condition, a change in how much help is",
  "needed, a new safety concern, a new or changed need, a changed routine, a new instruction,",
  "or something that makes an existing item out of date.",
  "DO NOT REWRITE THE PLAN BECAUSE NEW TEXT EXISTS. If nothing meaningful changed, return the",
  "plan you were given, unchanged.",
  "",
  "== HOW TO REASON ==",
  "Weigh how recent something is, how reliable the source is, whether more than one source",
  "says it, and whether it is an ONGOING need or a ONE-OFF event. Do not look for keywords --",
  "understand what the words mean. \"Normally walks to the bathroom but needed hands-on help",
  "today\" may be the first sign of a mobility change; one instance is not a plan change, and",
  "the same thing in several notes is.",
  "",
  "ONE unusual meal refusal is not a care-plan change. Repeated poor intake is a care concern.",
  "ONE difficult transfer needs attention. Repeated documentation of more help with transfers",
  "justifies changing the mobility section.",
  "",
  "== WHEN SOURCES DISAGREE ==",
  "Do not simply take the newest sentence. Prefer what is current, specific, reliable and",
  "clearly about this client's present condition. Resolve it yourself when the evidence is",
  "enough. If it could affect care or safety and you cannot resolve it, raise it for review",
  "and say exactly what is unclear. Never guess.",
  "",
  "== WHAT NOT TO WRITE ==",
  "- No generic caregiving advice. Every line must be about THIS client. Do not add a task",
  "  because it is common for older adults.",
  "- Never invent a diagnosis, a limitation, a preference, a schedule, a risk, or a family",
  "  instruction. If it is not in the sources, it does not go in the plan.",
  "- Do not diagnose. Report what is documented and what a caregiver needs to do.",
  "- No duplication. Say a thing once, in the section where a caregiver would look for it.",
  "  Combine related items. Drop anything a newer, reliable instruction has replaced. The plan",
  "  should get CLEARER over time, not longer.",
  "- If a section does not apply, LEAVE IT OUT. Never write \"None\", \"Not applicable\" or",
  "  \"No concerns\".",
  "",
  "== MEDICATIONS ==",
  "You have the client's medication and routine fields, so the plan can be accurate about",
  "what a shift actually involves. Use them carefully.",
  "",
  "- THIS IS NOT A MEDICATION LIST and it is not a MAR. Do not transcribe the record. Include",
  "  a medication only where it changes what the caregiver DOES, watches for, or reports.",
  "- NEVER STATE OR IMPLY THAT A CAREGIVER MAY ADMINISTER A MEDICATION. Devoted Care's own",
  "  guidance is that caregivers REMIND AND OBSERVE; they do not give or administer. A drug",
  "  appearing in the record is NOT permission. Where the record says who is responsible, say",
  "  so plainly. Where it does not, say it is not recorded -- never fill the gap yourself.",
  "- If the record and the recent notes DISAGREE about who gives a medication, or about",
  "  whether one is still taken, that belongs in \"attention\", not in the plan. Unclear",
  "  caregiver responsibility around a medication is exactly what the office is for.",
  "- Name a drug only where the name is what a caregiver needs: one they must remind about at",
  "  a particular time, one with a handling instruction (with food, crushed, eye drops), or",
  "  one the notes show something happening with -- refused, vomited, ran out, not given.",
  "- Never invent or alter a dose, a time or a schedule, and never suggest a change to one.",
  "  If you were not given a dose, do not write one.",
  "",
  "== SAFETY ==",
  "Pay particular attention to anything affecting falls, transfers, mobility, cognition,",
  "wandering, behaviour, swallowing, food and fluid intake, skin integrity, positioning,",
  "breathing, toileting, infection, and emergency instructions.",
  "",
  "== WHAT NEEDS THE OFFICE ==",
  "Do not send everything for review. Resolve routine updates yourself. Raise something only",
  "when a person genuinely has to decide or clarify: important conflicting information you",
  "cannot resolve, a significant safety issue needing office action, unclear caregiver",
  "responsibility, an important missing fact, or a change big enough that caregiver",
  "instructions should not move without confirmation.",
  "NEVER write \"needs review\". Say what the issue is and why it matters.",
  "",
  "== OUTPUT ==",
  "A JSON object and nothing else. No markdown, no code fence, no preamble:",
  '{"sections":[{"title":"<an allowed title>","items":["...","..."]}],',
  ' "attention":[{"issue":"...","found":"...","whyItMatters":"...","action":"...","source":"..."}]}',
  "",
  "ALLOWED SECTION TITLES -- use these exactly, include only the ones that apply, and keep",
  "them in this order:",
  "TITLES",
  "",
  "Each item is one short instruction or fact, under " + MAX_ITEM_CHARS + " characters, written for a caregiver",
  "to act on. At most " + MAX_ITEMS_PER_SECTION + " items in a section.",
  "\"attention\" is an EMPTY ARRAY unless something genuinely needs the office. At most " + MAX_ATTENTION + ".",
  "In \"source\", name where it came from: the assessment, a note and its date, or the plan.",
  "",
  "== BEFORE YOU ANSWER ==",
  "Is this current? Is every line specific to this client? Does it tell a caregiver what they",
  "actually need to know? Did you drop what is out of date or repeated? Did you tell a one-off",
  "apart from an ongoing need? Did you avoid assuming? Did you resolve what you reasonably",
  "could instead of escalating it? Would a caregiver reading this know how to care for this",
  "client today? If not, fix it before answering.",
].join("\n");

function clampItems(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const it of v) {
    if (typeof it !== "string") continue;
    const s = redact(it).replace(/\s*\n+\s*/g, " ").replace(/^["'“‘•\-\s]+|["'”’\s]+$/g, "").trim();
    if (!s || s.length > MAX_ITEM_CHARS) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

async function askClaude(clientName: string, a: Assessment, notes: Note[], current: PlanRow | null) {
  const dayOf = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ }) : "unknown date";

  const noteBlock = notes.length
    ? notes.map((n) => {
        const who = String(n.caregiver_name ?? "").trim().split(/\s+/)[0] || "Caregiver";
        return "[" + dayOf(n.visit_at) + " · " + who + "] " + redact(String(n.note)).slice(0, MAX_NOTE_CHARS);
      }).join("\n\n")
    : "(no recent notes)";

  const planBlock = current && current.sections && current.sections.length
    ? current.sections.map((s) => s.title + "\n" + (s.items || []).map((i) => "  - " + i).join("\n")).join("\n\n")
    : "(no plan yet)";

  const content =
    "CLIENT: " + clientName + "\n\n" +
    "== ASSESSMENT ==\n" + (a.text || "(nothing recorded)") + "\n\n" +
    "== RECENT NOTES (newest first, " + notes.length + ") ==\n" + noteBlock + "\n\n" +
    "== CURRENT PLAN ==\n" + planBlock;

  const body: Record<string, unknown> = {
    model: MODEL,
    /* max_tokens INCLUDES THINKING, and CAREPLAN_MODEL defaults to a model that thinks by
       default -- the trap care-brief, devi-agent, comms-summary and both summary functions
       all hit, each returning HTTP 200 with an empty text block. */
    max_tokens: 32000,
    system: PROMPT.replace("TITLES", SECTIONS.map((t) => "  " + t).join("\n")),
    messages: [{ role: "user", content }],
  };
  if (SEND_EFFORT) body.output_config = { effort: EFFORT };   // no temperature: Opus 5 rejects it

  const r = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": ANTHROPIC_VERSION },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await r.json().catch(() => null) as any;
  if (!r.ok) throw new UpstreamError(502, "Anthropic: " + (data?.error?.message || ("HTTP " + r.status)));
  if (data?.stop_reason === "refusal") throw new UpstreamError(502, "The model declined to write this plan.");
  const text = ((data?.content ?? []) as any[]).filter((p) => p?.type === "text").map((p) => p.text || "").join("").trim();
  console.info("[care-plan] " + MODEL + " client=" + clientName + " notes=" + notes.length +
    " in=" + (data?.usage?.input_tokens ?? "?") + " out=" + (data?.usage?.output_tokens ?? "?"));
  if (!text) {
    throw new UpstreamError(502, data?.stop_reason === "max_tokens"
      ? "The model spent its whole budget thinking and returned no text."
      : "The model returned no text (stop_reason: " + String(data?.stop_reason ?? "unknown") + ").");
  }

  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* fall through */ } }
  }
  if (!parsed || typeof parsed !== "object") throw new UpstreamError(502, "The model did not return a JSON object.");

  /* Defensively, the way every function here parses: an unknown section title, a
     repeat, an empty section or an over-long item is dropped rather than stored. */
  const seen = new Set<string>();
  const sections: { title: string; items: string[] }[] = [];
  for (const title of SECTIONS) {
    const raw = (parsed.sections ?? []).find((s: any) => String(s?.title ?? "").trim() === title);
    if (!raw || seen.has(title)) continue;
    const items = clampItems(raw.items, MAX_ITEMS_PER_SECTION);
    if (!items.length) continue;
    seen.add(title);
    sections.push({ title, items });
  }

  const attention: Record<string, string>[] = [];
  for (const it of (Array.isArray(parsed.attention) ? parsed.attention : [])) {
    const f = (k: string) => {
      const s = redact(String(it?.[k] ?? "")).replace(/\s+/g, " ").trim();
      return s.length > 400 ? "" : s;
    };
    const row = { issue: f("issue"), found: f("found"), whyItMatters: f("whyItMatters"), action: f("action"), source: f("source") };
    /* "Needs review" with nothing behind it is the thing the spec forbids, so a row
       without an issue AND a reason is not an escalation and is dropped. */
    if (!row.issue || !row.whyItMatters) continue;
    attention.push(row);
    if (attention.length >= MAX_ATTENTION) break;
  }
  return { sections, attention };
}

// --- one client -------------------------------------------------------------

async function planFor(clientId: number, clientName: string, force: boolean) {
  const [a, notes] = await Promise.all([assessmentFor(clientId), notesFor(clientId)]);
  const current = await savedPlan(clientId);

  if (!a.text && !notes.length) {
    return {
      ok: true, clientId, sections: [], attention: [], skipped: a.skipped, notesSeen: 0,
      reused: false, generated: false, model: MODEL, medNote: MED_NOTE,
      reason: "Nothing to build a plan from: no readable Client Concierge record and no recent care notes.",
    };
  }

  const srcSig = sig([a.text, String(notes.length), ...notes.map((n) => n.visit_id + "\u0001" + String(n.note).length)]);
  if (!force && current && current.source_sig === srcSig &&
      current.model === MODEL && current.prompt_version === PROMPT_VERSION) {
    return {
      ok: true, clientId, sections: current.sections ?? [], attention: current.attention ?? [],
      skipped: current.skipped ?? [], notesSeen: current.notes_seen ?? 0,
      reused: true, generated: false, model: MODEL, medNote: MED_NOTE,
    };
  }

  if (genCapped()) throw new UpstreamError(429, "Too many care plans have been written in the last hour. Try again shortly.");
  const out = await askClaude(clientName, a, notes, current);
  const stored = await putPlan({
    client_id: clientId, client_name: clientName,
    sections: out.sections, attention: out.attention,
    skipped: a.skipped, notes_seen: notes.length,
    source_sig: srcSig, model: MODEL, prompt_version: PROMPT_VERSION,
  });
  return {
    ok: true, clientId, sections: out.sections, attention: out.attention,
    skipped: a.skipped, notesSeen: notes.length,
    reused: false, generated: true, saved: stored, model: MODEL, medNote: MED_NOTE,
  };
}

// --- the handler ------------------------------------------------------------

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!originAllowed(origin)) return json(cors, 403, { ok: false, error: "origin not allowed: " + (origin || "(none sent)") });

  const url = new URL(req.url);
  if (url.searchParams.get("action") === "status") {
    return json(cors, 200, {
      ok: true,
      configured: !!(ANTHROPIC_KEY && CONCIERGE_URL && CONCIERGE_KEY && DB_URL && DB_KEY),
      missing: [!ANTHROPIC_KEY && "ANTHROPIC_API_KEY", !CONCIERGE_URL && "CONCIERGE_SUPABASE_URL",
                !CONCIERGE_KEY && "CONCIERGE_ANON_KEY", !DB_URL && "SUPABASE_URL",
                !DB_KEY && "SUPABASE_SERVICE_ROLE_KEY"].filter(Boolean),
      model: MODEL, effort: SEND_EFFORT ? EFFORT : "not sent (" + MODEL + " does not accept it)",
      promptVersion: PROMPT_VERSION, noteDays: NOTE_DAYS, sections: SECTIONS,
      /* readFields is deliberately wider than care-brief's safeFields -- status reports it
         so the difference is visible without reading the source. */
      readFields: READ_FIELDS, safeColumns: SAFE_COLUMNS, medNote: MED_NOTE,
      medicationsIncluded: true,
    });
  }
  if (req.method !== "POST") return json(cors, 405, { ok: false, error: "POST a {clientId} to write a care plan." });
  if (!ANTHROPIC_KEY || !DB_URL || !DB_KEY) return json(cors, 503, { ok: false, error: "care-plan is not configured." });

  let b: any = null;
  try { b = await req.json(); } catch { /* handled below */ }
  const clientId = Number(b?.clientId);
  if (!Number.isFinite(clientId) || clientId <= 0) return json(cors, 400, { ok: false, error: "clientId must be a positive number." });
  const clientName = String(b?.clientName ?? "").trim().slice(0, 120) || "This client";

  try {
    return json(cors, 200, await planFor(clientId, clientName, b?.force === true));
  } catch (e) {
    const err = e as UpstreamError;
    const status = err?.status && err.status >= 400 ? err.status : 500;
    return json(cors, status, { ok: false, error: err?.message || "care-plan failed." });
  }
});
