// comms-summary  ·  "Summary by Devi" for one call or one day of texts  ·  (Supabase Edge Function)
//
// WHAT THIS IS FOR
//
// The Communication Logs dialog on a caregiver's profile shows one call or one
// day of texting at a time. This writes one or two sentences above it saying
// what the conversation was about and where it ended, so a scheduler can scan
// it without reading the whole thread. Asked for on 2026-09-15.
//
// ── ON DEMAND, SAVED, NEVER SWEPT ───────────────────────────────────────────
//
// A summary is written the first time somebody OPENS that conversation and is
// saved in public.comm_summaries. Every later open, by anybody, reads the saved
// one. Nothing summarises a conversation nobody looks at.
//
//   a call          key  call:<callId>                  written once
//   a day of texts  key  text:<lineId>|<day>|<phone>    rewritten when the
//                                                       day gains a message
//
// A text entry in the dialog is ONE LINE'S TEXTS FOR ONE PACIFIC DAY, so
// today's entry keeps growing while people reply. Its row carries the message
// count and the newest message id, and a mismatch is what regenerates it. Past
// days never change, so in practice they are written once as well.
//
// THE PHONE NUMBER IS PART OF THE TEXT KEY. The dialog's own entry id is only
// <lineId>|<day>, and two caregivers texted on the Scheduling line on the same
// day share it. Keying on that alone would show one caregiver the other's
// summary.
//
// A row also records the MODEL and PROMPT_VERSION that wrote it. Change either
// and old summaries are rewritten on their next open, which is what makes
// switching COMMS_MODEL actually change what the desk sees.
//
// ── WHY THE FUNCTION READS QUO ITSELF ───────────────────────────────────────
//
// The browser already holds the messages, so the obvious design is to post
// them here. It deliberately does not. The dashboard has no login: a function
// that summarised whatever it was handed and saved the result would let anyone
// with the site URL write invented summaries into the table and run up the
// Anthropic bill with any text they liked. Taking only an id, reading the
// conversation from Quo, and saving with the service key means a summary can
// only ever describe a real conversation, and spend is capped at one summary
// per real conversation per model.
//
// The table has RLS on and NO policies. The anon key can neither read nor write
// it; only this function, with SUPABASE_SERVICE_ROLE_KEY, touches it.
//
// ── DELETED CONVERSATIONS ───────────────────────────────────────────────────
//
// No background clean-up, agreed 2026-09-15. Finding a deleted conversation
// means re-reading Quo for every saved summary, which is exactly the sweep this
// design exists to avoid. The dialog's list comes live from Quo, so a summary
// of a deleted conversation is simply never shown. A row is deleted when this
// function NOTICES: Quo answers 404 for the call, or the day holds no messages.
//
// ── THE MODEL HAS NO TOOLS ──────────────────────────────────────────────────
//
// It reads a conversation and returns text. Nothing it writes reaches any
// record except this one summary row. Same safety argument as devi-agent.
//
// ── SECRETS (Supabase project secrets) ──────────────────────────────────────
//   ANTHROPIC_API_KEY          shared with devi-agent and care-brief
//   QUO_API_KEY                shared with quo
//   QUO_ROSTER_URL             shared with quo; used here only to NAME people
//   ALLOWED_ORIGIN             shared with devi-agent, quo and care-brief
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   provided by Supabase itself
//   COMMS_MODEL                optional; default claude-haiku-4-5
//   COMMS_EFFORT               optional; default low. NOT sent to a Haiku model,
//                              which rejects the effort parameter with a 400
//
// Switching model needs no code change and no redeploy:
//   npx supabase secrets set COMMS_MODEL=claude-sonnet-5 --project-ref gdzgoyawavffjdjpjbfz
//
// A COMMIT DOES NOT DEPLOY THIS FILE:
//   npx supabase functions deploy comms-summary --project-ref gdzgoyawavffjdjpjbfz --no-verify-jwt

const ANTHROPIC_KEY = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
const QUO_KEY = (Deno.env.get("QUO_API_KEY") ?? "").trim();
const QUO_BASE = (Deno.env.get("QUO_API_BASE") || "https://api.quo.com").trim().replace(/\/+$/, "");
const ROSTER_URL = (Deno.env.get("QUO_ROSTER_URL") ?? "").trim().replace(/\/+$/, "");
const DB_URL = (Deno.env.get("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
const DB_KEY = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
const ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

/* `||`, not `??`: a secret set to an empty string must fall back to the
   default rather than send model "" and fail every request. */
const MODEL = (Deno.env.get("COMMS_MODEL") || "claude-haiku-4-5").trim();
const EFFORT = (Deno.env.get("COMMS_EFFORT") || "low").trim();
/* Haiku 4.5 answers 400 to output_config.effort. Every current model above it
   accepts it, so the parameter is sent only when it can be understood. */
const SEND_EFFORT = !!EFFORT && !/haiku/i.test(MODEL);

/* Bump when PROMPT or the conversation formatting changes in a way that should
   rewrite summaries already saved. They are rewritten on their next open. */
const PROMPT_VERSION = 4;   // 2: two sentences, under 40 words. 3: contact details redacted. 4: office staff named from who spoke (all 2026-09-15)

const API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TZ = "America/Los_Angeles";
const TIMEOUT_MS = 30000;
const TABLE = "comm_summaries";

/* A summary past this is not "a quick scan" any more. Asked for under 40
   words (~250 characters); a little over is accepted, a paragraph is not. */
const MAX_CHARS = 600;

const RATE_MAX = 600;                     // requests per caller per hour; a cached read counts
const RATE_TOTAL = 3000;                  // per isolate per hour
const GEN_HOURLY_CAP = 400;               // model calls per isolate per hour; the cost brake
const WINDOW_MS = 60 * 60 * 1000;

// --- CORS (same shape as devi-agent, quo and care-brief) ---------------------
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

// --- small helpers -----------------------------------------------------------

/* The same strict rule as index.html and quo: never guess a country code onto
   garbage, because a wrong prefix is somebody else's real number. */
function toE164(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  let d = s.replace(/[^0-9]/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  if (d.length !== 10) return null;
  if (d[0] === "0" || d[0] === "1" || d[3] === "0" || d[3] === "1") return null;
  return "+1" + d;
}

function firstName(full: string): string {
  return String(full || "").trim().split(/\s+/)[0] || "";
}

/* Pacific calendar day of an instant. The dialog groups texts by Pacific day,
   so this must answer exactly the way index.html's dayKey() does. */
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
function nextDay(day: string): string {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
}

function stamp(iso: string, withDate: boolean): string {
  try {
    const o: Intl.DateTimeFormatOptions = withDate
      ? { timeZone: TZ, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
      : { timeZone: TZ, hour: "numeric", minute: "2-digit" };
    return new Intl.DateTimeFormat("en-US", o).format(new Date(iso));
  } catch { return String(iso || ""); }
}

function duration(sec: unknown): string {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "";
  const m = Math.floor(n / 60), s = Math.round(n % 60);
  return m ? m + " min " + s + " sec" : s + " sec";
}

// --- Quo (GET only) ----------------------------------------------------------

/* CONTACT DETAILS NEVER REACH THE MODEL. The prompt tells it to leave out
   email addresses, phone numbers and links, and that did not hold: with the
   rule in place Haiku still wrote an applicant's email address into one of the
   first four summaries. A prompt rule is a request, so they are replaced here
   in the conversation before it is sent -- which also keeps them from being
   sent to Anthropic at all -- and once more over the output as a backstop.
   Street addresses have no reliable pattern and are left to the prompt. */
function redact(s: string): string {
  return String(s ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email address]")
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, "[link]")
    .replace(/(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone number]");
}

class UpstreamError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/* Quo allows 10 requests a second for the whole key, shared with the quo proxy
   and every scheduler. A 429 or 5xx is retried with backoff; anything else is
   an answer. The same rule callQuo() in the quo function follows. */
async function quo(path: string, params?: Record<string, string>): Promise<{ status: number; data: any }> {
  const u = new URL(QUO_BASE + path);
  /* append, never set: a repeated parameter must stay repeated. URLSearchParams
     also encodes a "+" as %2B, which a phone number needs -- a raw "+" decodes
     to a space and is a different number. */
  for (const [k, v] of Object.entries(params ?? {})) u.searchParams.append(k, v);
  let res!: Response;
  for (let i = 0; i <= 2; i++) {
    res = await fetch(u.toString(), {
      headers: { Accept: "application/json", Authorization: QUO_KEY },   // raw key, no "Bearer"
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok || (res.status !== 429 && res.status < 500) || i === 2) break;
    const ra = Number(res.headers.get("retry-after"));
    await res.body?.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 350 * Math.pow(2, i), 4000)));
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data };
}

function quoFail(what: string, r: { status: number; data: any }): UpstreamError {
  const said = r.data && (r.data.message || r.data.error || (Array.isArray(r.data.errors) ? r.data.errors.join("; ") : ""));
  return new UpstreamError(502, "Quo could not read " + what + " (HTTP " + r.status + (said ? ": " + String(said).slice(0, 200) : "") + ").");
}

// --- context: who is who ------------------------------------------------------
//
// Each read is cached for ten minutes per isolate, the same as quo's caches.
// None of it is a guard -- it only puts names on people -- so the lines and
// staff lists degrade to empty rather than failing a summary.

type Line = { id: string; name: string; number: string };
let linesCache: { at: number; v: Line[] } | null = null;
async function ourLines(): Promise<Line[]> {
  if (linesCache && Date.now() - linesCache.at < 600000) return linesCache.v;
  const r = await quo("/v1/phone-numbers");
  if (r.status !== 200) return linesCache?.v ?? [];
  const v = ((r.data?.data ?? []) as any[]).map((n) => ({
    id: String(n?.id ?? ""), name: String(n?.name || n?.number || ""), number: toE164(n?.number) ?? "",
  })).filter((l) => l.id);
  if (v.length) linesCache = { at: Date.now(), v };
  return v;
}

let staffCache: { at: number; v: Map<string, string> } | null = null;
async function staff(): Promise<Map<string, string>> {
  if (staffCache && Date.now() - staffCache.at < 600000) return staffCache.v;
  const r = await quo("/v1/users", { maxResults: "50" });
  if (r.status !== 200) return staffCache?.v ?? new Map();
  const v = new Map<string, string>();
  for (const u of (r.data?.data ?? []) as any[]) {
    if (!u?.id) continue;
    /* Trimmed: this workspace really does record one lastName as "Jenn ". */
    const n = (String(u.firstName ?? "") + " " + String(u.lastName ?? "")).replace(/\s+/g, " ").trim();
    v.set(String(u.id), firstName(n) || String(u.email ?? ""));
  }
  if (v.size) staffCache = { at: Date.now(), v };
  return v;
}

/* AxisCare's nextPage is a FULL URL, not a bare id -- the trap index.html's
   axPageCursor and quo's rosterCursor both record. */
function pageCursor(next: unknown, page: any[]): string | null {
  const m = /[?&](?:startAfterId|after|afterId|cursor|pageToken)=([^&]+)/.exec(String(next ?? ""));
  if (m) return decodeURIComponent(m[1]);
  let max: number | null = null;
  for (const c of page) { const id = Number(c?.id); if (Number.isFinite(id) && (max === null || id > max)) max = id; }
  return max === null ? null : String(max);
}

async function axisList(path: string, key: "caregivers" | "clients", extra: string, maxPages: number): Promise<{ rows: any[]; complete: boolean }> {
  const out: any[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  for (let p = 0; p < maxPages; p++) {
    const u = ROSTER_URL + "?action=get&path=" + encodeURIComponent(path) + extra +
      (after ? "&q_startAfterId=" + encodeURIComponent(after) : "");
    const r = await fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error("AxisCare roster HTTP " + r.status);
    const b = await r.json().catch(() => null) as any;
    const raw = b?.data?.results?.[key];
    const rows = Array.isArray(raw) ? raw : Object.values(raw ?? {});
    let fresh = 0;
    for (const c of rows as any[]) {
      const id = String(c?.id ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id); out.push(c); fresh++;
    }
    const next = b?.data?.results?.nextPage;
    if (!next) return { rows: out, complete: true };
    if (!fresh) break;
    const cur = pageCursor(next, rows as any[]);
    if (cur === null) break;
    after = cur;
  }
  return { rows: out, complete: false };
}

type Roster = { byPhone: Map<string, string>; clients: string[] };
let rosterCache: { at: number; v: Roster } | null = null;
/* Returns null when the roster could not be read IN FULL. The summary is still
   written, but it is not SAVED: a summary saved without the caregiver's name
   would read "the caregiver" forever, when the next open could have named her. */
async function roster(): Promise<Roster | null> {
  if (rosterCache && Date.now() - rosterCache.at < 600000) return rosterCache.v;
  if (!ROSTER_URL) return null;
  try {
    const [cgs, cls] = await Promise.all([
      axisList("/api/caregivers", "caregivers", "&q_limit=200&q_statuses=Active", 8),
      axisList("/api/clients", "clients", "&q_limit=100", 20),
    ]);
    if (!cgs.complete || !cls.complete) return null;
    const byPhone = new Map<string, string>();
    for (const c of cgs.rows) {
      /* firstName, never goesBy -- CLAUDE.md: goesBy is a nickname and for a
         quarter of the roster it is not their name at all. */
      const name = (String(c?.firstName ?? "") + " " + String(c?.lastName ?? "")).replace(/\s+/g, " ").trim();
      if (!name) continue;
      for (const f of ["mobilePhone", "homePhone", "otherPhone"]) {
        const e = toE164(c?.[f]);
        if (e && !byPhone.has(e)) byPhone.set(e, name);
      }
    }
    const clients = cls.rows.filter((c) => c?.status?.active).map((c) => {
      const n = (String(c?.firstName ?? "") + " " + String(c?.lastName ?? "")).replace(/\s+/g, " ").trim();
      const nick = String(c?.goesBy ?? "").trim();
      return nick && nick.toLowerCase() !== firstName(n).toLowerCase() ? n + " (goes by " + nick + ")" : n;
    }).filter(Boolean).sort();
    const v = { byPhone, clients };
    rosterCache = { at: Date.now(), v };
    return v;
  } catch (e) {
    console.warn("[comms-summary] roster read failed:", (e as Error)?.message);
    return null;
  }
}

// --- the saved summaries -------------------------------------------------------

/* All three context reads at once, none of which can reject. Started as soon as
   a summary is known to be needed, alongside the Quo reads rather than after
   them: on a cold isolate the roster is the slowest step, and a first summary
   measured 7.6s with it run last. Each is cached for ten minutes, so a start
   that turns out unneeded (an unanswered call) costs nothing later. */
function context(): Promise<[Line[], Map<string, string>, Roster | null]> {
  return Promise.all([
    ourLines().catch(() => [] as Line[]),
    staff().catch(() => new Map<string, string>()),
    roster(),
  ]);
}

type Row = { key: string; summary: string; source_count: number; source_last_id: string | null; model: string; prompt_version: number };

function dbHeaders(extra?: Record<string, string>): Record<string, string> {
  return { apikey: DB_KEY, Authorization: "Bearer " + DB_KEY, Accept: "application/json", ...(extra ?? {}) };
}

/* A failed READ is not a reason to refuse: the summary can still be written,
   it just cannot be served from the table this time. Logged, not thrown. */
async function dbGet(key: string): Promise<Row | null> {
  try {
    const r = await fetch(DB_URL + "/rest/v1/" + TABLE + "?select=key,summary,source_count,source_last_id,model,prompt_version&key=eq." +
      encodeURIComponent(key) + "&limit=1", { headers: dbHeaders(), signal: AbortSignal.timeout(10000) });
    if (!r.ok) { console.warn("[comms-summary] read HTTP " + r.status); return null; }
    const rows = await r.json() as Row[];
    return rows[0] ?? null;
  } catch (e) { console.warn("[comms-summary] read failed:", (e as Error)?.message); return null; }
}

async function dbPut(row: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch(DB_URL + "/rest/v1/" + TABLE + "?on_conflict=key", {
      method: "POST",
      headers: dbHeaders({ "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) console.warn("[comms-summary] write HTTP " + r.status + ": " + (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) { console.warn("[comms-summary] write failed:", (e as Error)?.message); return false; }
}

async function dbDel(key: string): Promise<void> {
  try {
    await fetch(DB_URL + "/rest/v1/" + TABLE + "?key=eq." + encodeURIComponent(key), {
      method: "DELETE", headers: dbHeaders({ Prefer: "return=minimal" }), signal: AbortSignal.timeout(10000),
    });
  } catch { /* the row is invisible anyway; the next notice tries again */ }
}

/* Written by the model and prompt in force now. A switch rewrites on open. */
const current = (row: Row | null): row is Row =>
  !!row && row.model === MODEL && row.prompt_version === PROMPT_VERSION;

// --- the model -------------------------------------------------------------------

const PROMPT = [
  "You summarise ONE phone call, or ONE day of text messages, between Devoted Care (a home-care",
  "agency in Ventura County, California) and one of its caregivers. A scheduler at the agency reads",
  "your summary to understand the conversation at a glance, without opening it.",
  "",
  "OUTPUT: at most TWO sentences and under 40 words in total; one sentence is better when it is",
  "enough. Plain prose only: no headings, labels, bullet points, quotation marks or preamble.",
  "Output the summary and nothing else.",
  "",
  "SAY what the conversation was about and where it ended: what was asked, offered or reported,",
  "what the caregiver answered, and anything still waiting on someone (a reply, a confirmation, a",
  "callback, a document). When the office has something left to do, end with it. Say each point",
  "once: never close by repeating something already said.",
  "",
  "RULES:",
  "- Use only what is in the conversation. Never guess reasons, intentions or outcomes that were not said.",
  "- Name people by first name, using the names given in the details. Say \"the caregiver\" only if no name is given.",
  "- Anyone in the client list is a client of the agency. Keep the days, dates, times and places that",
  "  matter for scheduling.",
  "- Leave out phone numbers, email addresses, street addresses and links. In the conversation they",
  "  already appear as [phone number], [email address] or [link]; do not mention those placeholders.",
  "- Call transcripts are machine-generated and may be garbled, or mix English and Tagalog. Summarise",
  "  the meaning in English and do not repeat words that are clearly mistranscribed.",
  "- If nothing of substance was said (a voicemail greeting, a call that cut out, a wrong number), say",
  "  so in one short sentence.",
  "- If the office sent messages and the caregiver did not reply that day, say what was sent and that",
  "  there was no reply that day.",
].join("\n");

async function writeSummary(content: string): Promise<string> {
  /* max_tokens INCLUDES THINKING. Haiku does not think unless asked, but a
     COMMS_MODEL switch to Sonnet 5 or Opus 5 does by default, and a budget
     sized for two sentences returns HTTP 200 with an EMPTY text block --
     care-brief and devi-agent both hit this. 4096 is the floor they settled on,
     and only what is used is billed. */
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 4096,
    system: PROMPT,
    messages: [{ role: "user", content }],
  };
  /* No temperature: Sonnet 5 and Opus 5 reject it, and switching the model
     must not start failing every request. */
  if (SEND_EFFORT) body.output_config = { effort: EFFORT };

  const r = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": ANTHROPIC_VERSION },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await r.json().catch(() => null) as any;
  if (!r.ok) throw new UpstreamError(502, "Anthropic: " + (data?.error?.message || ("HTTP " + r.status)));
  if (data?.stop_reason === "refusal") throw new UpstreamError(502, "The model declined to summarise this conversation.");
  const text = ((data?.content ?? []) as any[]).filter((p) => p?.type === "text").map((p) => p.text || "").join("").trim();
  /* Token use per summary, in the function logs, so the cost of a model
     switch can be read off real traffic rather than estimated. */
  console.info("[comms-summary] " + MODEL + " in=" + (data?.usage?.input_tokens ?? "?") + " out=" + (data?.usage?.output_tokens ?? "?"));
  if (!text) {
    throw new UpstreamError(502, data?.stop_reason === "max_tokens"
      ? "The model spent its whole budget thinking and returned no text (stop_reason: max_tokens)."
      : "The model returned no text (stop_reason: " + String(data?.stop_reason ?? "unknown") + ").");
  }
  /* Keep it one paragraph and unquoted, and refuse a runaway rather than
     cutting it off mid-sentence: a truncated summary saved forever is worse
     than none, and the next open simply tries again. */
  const s = redact(text).replace(/\s*\n+\s*/g, " ").replace(/^["'“‘]+|["'”’]+$/g, "").trim();
  if (s.length > MAX_CHARS) throw new UpstreamError(502, "The summary came back at " + s.length + " characters, too long to use.");
  return s;
}

function detailsBlock(d: Record<string, string | undefined>, clients: string[] | null): string {
  const lines = Object.entries(d).filter(([, v]) => v).map(([k, v]) => k + ": " + v);
  if (clients && clients.length) lines.push("Active clients of the agency: " + clients.join("; "));
  return lines.join("\n");
}

// --- a call ----------------------------------------------------------------------

async function summariseCall(callId: string) {
  const key = "call:" + callId;
  const row = await dbGet(key);
  if (current(row)) return { state: "ready", summary: row.summary, model: row.model, cached: true };

  const ctxP = context();
  const c = await quo("/v1/calls/" + encodeURIComponent(callId));
  if (c.status === 404) { if (row) await dbDel(key); return { state: "gone" }; }
  if (c.status !== 200) throw quoFail("the call", c);
  const call = c.data?.data ?? {};
  /* Nothing was said, so there is nothing to summarise and no model call. */
  if (!call.answeredAt) return { state: "none", reason: "unanswered" };

  const t = await quo("/v1/call-transcripts/" + encodeURIComponent(callId));
  /* 404 is Quo saying it has no transcript for this call -- usually a short
     one. Not an outage, and not a reason to delete a saved summary. */
  if (t.status === 404) return { state: "none", reason: "no-transcript" };
  if (t.status !== 200) throw quoFail("the call transcript", t);
  const tr = t.data?.data ?? {};
  if (tr.status && tr.status !== "completed") return { state: "pending" };
  const dialogue = ((tr.dialogue ?? []) as any[]).filter((x) => String(x?.content ?? "").trim());
  if (!dialogue.length) return { state: "none", reason: "empty-transcript" };

  if (genCapped()) throw new UpstreamError(429, "Devi has written too many summaries this hour. Try again shortly.");

  const [lines, people, ros] = await ctxP;
  const ourNumbers = new Set(lines.map((l) => l.number).filter(Boolean));
  const line = lines.find((l) => l.id === call.phoneNumberId);
  const cgPhone = ((call.participants ?? []) as unknown[]).map(toE164).find((p) => p && !ourNumbers.has(p)) ?? null;
  const cgName = (cgPhone && ros?.byPhone.get(cgPhone)) || "";
  const cgFirst = firstName(cgName);
  /* WHO AT THE OFFICE SPOKE comes from the transcript turns, not call.userId.
     Measured 2026-09-15: a call whose userId is Marivic had answeredBy Patty
     and every office turn stamped Patty or Ruffa. Handed both answers, the
     model named Marivic on two runs and Patty on the third. The turns are who
     actually spoke; answeredBy and then userId are only fallbacks. */
  const spoke = new Map<string, number>();
  for (const x of dialogue) {
    const n = x.userId ? people.get(String(x.userId)) : "";
    if (n) spoke.set(n, (spoke.get(n) ?? 0) + 1);
  }
  const handledBy: string = [...spoke.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).join(", ") ||
    (call.answeredBy ? people.get(String(call.answeredBy)) : "") ||
    (call.userId ? people.get(String(call.userId)) : "") || "";

  /* Consecutive turns by the same speaker are merged: a transcript splits one
     sentence into several rows, and the repetition is tokens for nothing. */
  const turns: string[] = [];
  let last = "";
  for (const x of dialogue) {
    const id = toE164(x.identifier);
    const who = x.userId && people.get(String(x.userId))
      ? people.get(String(x.userId)) + " (office)"
      : (id && ourNumbers.has(id)) ? "Office"
      : (id && id === cgPhone) ? (cgFirst ? cgFirst + " (caregiver)" : "Caregiver")
      : "Other caller";
    const said = redact(String(x.content)).replace(/\s+/g, " ").trim();
    if (who === last && turns.length) turns[turns.length - 1] += " " + said;
    else turns.push(who + ": " + said);
    last = who;
  }

  const content = detailsBlock({
    "Conversation": "phone call",
    "Agency line": line?.name,
    "When": call.createdAt ? stamp(call.createdAt, true) + " Pacific" : undefined,
    "Direction": call.direction === "incoming" ? "incoming (the caregiver called the agency)" : "outgoing (the agency called the caregiver)",
    "Length": duration(call.duration ?? tr.duration),
    "Caregiver": cgName || undefined,
    "Office staff who spoke": handledBy || undefined,
  }, ros?.clients ?? null) + "\n\nTRANSCRIPT\n" + turns.join("\n");

  const summary = await writeSummary(content);
  /* Saved only when the roster was read in full -- see roster(). */
  const stored = ros ? await dbPut({
    key, kind: "call", phone: cgPhone, source_count: dialogue.length, source_last_id: null,
    summary, model: MODEL, prompt_version: PROMPT_VERSION,
  }) : false;
  return { state: "ready", summary, model: MODEL, cached: false, stored };
}

// --- a day of texts ----------------------------------------------------------------

async function dayMessages(lineId: string, phone: string, day: string): Promise<any[]> {
  const after = new Date(laMidnightUtc(day)).toISOString();
  const before = new Date(laMidnightUtc(nextDay(day))).toISOString();
  const out: any[] = [];
  let token: string | null = null;
  for (let p = 0; p < 5; p++) {
    const q: Record<string, string> = { phoneNumberId: lineId, participants: phone, maxResults: "100", createdAfter: after, createdBefore: before };
    if (token) q.pageToken = token;
    const r = await quo("/v1/messages", q);
    if (r.status !== 200) throw quoFail("the messages", r);
    const rows = (r.data?.data ?? []) as any[];
    out.push(...rows);
    token = r.data?.nextPageToken || null;
    if (!token || !rows.length) break;
  }
  /* Filtered by Pacific day as well as by window, so whether Quo treats the
     window edges as inclusive cannot move a message onto the wrong day. */
  return out.filter((m) => m?.createdAt && dayKey(m.createdAt) === day)
    .sort((a, b) => String(a.createdAt) < String(b.createdAt) ? -1 : String(a.createdAt) > String(b.createdAt) ? 1 : 0);
}

async function summariseText(lineId: string, day: string, phone: string, hintCount: number | null, hintLast: string | null) {
  const key = "text:" + lineId + "|" + day + "|" + phone;
  const row = await dbGet(key);
  /* The fast path: the browser sees the same messages this summary was written
     from, so nothing has been added and Quo need not be asked. */
  if (current(row) && hintCount !== null && row.source_count === hintCount && row.source_last_id === hintLast) {
    return { state: "ready", summary: row.summary, model: row.model, cached: true };
  }

  const ctxP = context();
  const msgs = await dayMessages(lineId, phone, day);
  if (!msgs.length) { if (row) await dbDel(key); return { state: "gone" }; }
  const lastId = String(msgs[msgs.length - 1].id ?? "");
  /* The browser's count can differ without anything having changed -- its
     sweep reads the 50 newest messages per line, so an older day at that edge
     is partial. Quo's own count is the one that decides. */
  if (current(row) && row.source_count === msgs.length && row.source_last_id === lastId) {
    return { state: "ready", summary: row.summary, model: row.model, cached: true };
  }

  if (genCapped()) throw new UpstreamError(429, "Devi has written too many summaries this hour. Try again shortly.");

  const [lines, people, ros] = await ctxP;
  const line = lines.find((l) => l.id === lineId);
  const cgName = ros?.byPhone.get(phone) || "";
  const cgFirst = firstName(cgName);
  const staffOn = new Set<string>();

  const thread = msgs.map((m) => {
    const out = m.direction !== "incoming";
    const staffName = out && m.userId ? people.get(String(m.userId)) : "";
    if (staffName) staffOn.add(staffName);
    const who = out ? (staffName ? staffName + " (office)" : "Office") : (cgFirst ? cgFirst + " (caregiver)" : "Caregiver");
    let text = redact(String(m.text ?? "")).trim();
    if (!text) text = Array.isArray(m.media) && m.media.length ? "[sent an attachment]" : "[empty message]";
    const failed = m.status === "undelivered" || m.status === "failed";
    return "[" + stamp(m.createdAt, false) + "] " + who + ": " + text + (failed ? "  [NOT DELIVERED]" : "");
  });

  const content = detailsBlock({
    "Conversation": "text messages, one day",
    "Agency line": line?.name,
    "Date": stamp(msgs[0].createdAt, true).replace(/,?\s*\d{1,2}:\d{2}\s*[AP]M$/i, "") + " (Pacific)",
    "Caregiver": cgName || undefined,
    "Office staff texting": [...staffOn].join(", ") || undefined,
  }, ros?.clients ?? null) + "\n\nMESSAGES (oldest first)\n" + thread.join("\n");

  const summary = await writeSummary(content);
  const stored = ros ? await dbPut({
    key, kind: "text", phone, source_count: msgs.length, source_last_id: lastId,
    summary, model: MODEL, prompt_version: PROMPT_VERSION,
  }) : false;
  return { state: "ready", summary, model: MODEL, cached: false, stored };
}

// --- the handler ----------------------------------------------------------------------

function missing(): string[] {
  return [
    !ANTHROPIC_KEY && "ANTHROPIC_API_KEY", !QUO_KEY && "QUO_API_KEY",
    !DB_URL && "SUPABASE_URL", !DB_KEY && "SUPABASE_SERVICE_ROLE_KEY",
  ].filter(Boolean) as string[];
}

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
      promptVersion: PROMPT_VERSION, namesPeople: !!ROSTER_URL,
    });
  }
  /* POST, not GET: a request here can cost money and write a row, and a GET
     lands in browser history, prefetches and crawler queues. */
  if (req.method !== "POST") return json(cors, 405, { ok: false, error: "Only POST (and GET ?action=status) are supported." });

  if (missing().length) {
    return json(cors, 503, { ok: false, error: "Devi summaries are not configured on the server.", missing: missing() });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return json(cors, 429, { ok: false, error: "too many requests - try again shortly" });

  const b = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return json(cors, 400, { ok: false, error: "Send a JSON body." });

  try {
    if (b.kind === "call") {
      const callId = String(b.callId ?? "");
      if (!/^[A-Za-z0-9_-]{4,80}$/.test(callId)) return json(cors, 400, { ok: false, error: "callId is not a Quo call id." });
      return json(cors, 200, { ok: true, ...(await summariseCall(callId)) });
    }
    if (b.kind === "text") {
      const lineId = String(b.lineId ?? ""), day = String(b.day ?? ""), phone = String(b.phone ?? "");
      if (!/^PN[A-Za-z0-9_-]{2,60}$/.test(lineId)) return json(cors, 400, { ok: false, error: "lineId is not a Quo line id." });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(Date.parse(day + "T00:00:00Z"))) return json(cors, 400, { ok: false, error: "day must be YYYY-MM-DD." });
      if (toE164(phone) !== phone) return json(cors, 400, { ok: false, error: "phone must be an E.164 number." });
      const hintCount = Number.isInteger(b.count) ? Number(b.count) : null;
      const hintLast = typeof b.lastId === "string" ? b.lastId : null;
      return json(cors, 200, { ok: true, ...(await summariseText(lineId, day, phone, hintCount, hintLast)) });
    }
    return json(cors, 400, { ok: false, error: 'kind must be "call" or "text".' });
  } catch (err) {
    const e = err as Error & { status?: number };
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    const status = timedOut ? 504 : (e instanceof UpstreamError ? e.status : 500);
    console.warn("[comms-summary] failed:", e?.message);
    return json(cors, status, { ok: false, error: timedOut ? "Timed out reading the conversation or writing the summary." : (e?.message || "Something went wrong.") });
  }
});
