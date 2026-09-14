// Quo proxy  ·  READ-ONLY, EXCEPT action=send  ·  (Supabase Edge Function)
//
// Quo is the phone system — the numbers the desk actually answers. It used to
// be called OpenPhone and rebranded in 2026, so every older doc, SDK and blog
// post you find describes THIS api under the old name. They are the same API.
//
// Devoted Care's workspace, confirmed live 2026-09-11:
//     +1 805 312 7736   Scheduling Department   (the one this dashboard cares about)
//     +1 805 419 6909   Client Support Line
//     +1 805 246 7002   Client Inquiry Line
//     +1 507 417 8132   Primary
//
// WHY THIS EXISTS, AND WHAT IT IS ALLOWED TO DO.
//
// The Quo key must never reach the browser — anything in index.html or
// config.js is world-readable via view-source. Same argument as the AxisCare
// token, and netlify/functions/axiscare.js has the long version of it.
//
// But Quo is a sharper knife than AxisCare. AxisCare's API is a read API; if
// its token leaked, a stranger could READ. Quo's API can ACT:
//
//     POST   /v1/messages                  sends a real text, from a real
//                                          agency number, to a real person,
//                                          billed to the agency
//     DELETE /v1/contacts/{id}             deletes a contact
//     POST   /v1/tasks/{id}/complete       and a dozen more state changes
//
// Roughly half of Quo's ~45 endpoints mutate something. Until 2026-09-14 this
// file forwarded GET and nothing else, and that was its whole security
// argument. It now does ONE more thing:
//
//     action=send  ->  POST /v1/messages, and that is the complete list.
//
// Everything else is still read-only, still GET upstream, still behind the
// path allowlist. This proxy cannot delete a contact, complete a task, patch a
// contact or mark a conversation read, and no parameter makes it able to.
//
// Claude: the "do not add a send" instruction that used to sit here has been
// SATISFIED, not overridden. CLAUDE.md said wiring SMS was a PHI decision and
// a billing decision rather than a code decision; Mitch made it on 2026-09-14,
// with the guards in the doSend block chosen and agreed before anything was
// written. What has NOT changed:
//
//   - a second mutation is a new decision, not a precedent set by this one
//   - the four guards on send (roster allowlist, line pinning, hourly cap,
//     size caps) are the terms the decision was made on. Removing one is
//     re-opening the decision, not tidying up.
//   - there is still no login on the dashboard, so the roster allowlist is
//     doing the work an authenticated caller would otherwise do.
//
// AUTHENTICATION — the one thing worth reading twice.
//
//     Authorization: <the key>
//
// The raw key. Quo's docs say plainly "The Quo API does not use a Bearer
// token for authentication." Measured against the live key on 2026-09-11,
// `Bearer <key>` ALSO returns 200 — Quo appears to strip the prefix — so this
// is more forgiving than the docs suggest and copying the AxisCare header by
// mistake would not actually break. We send the documented form anyway,
// because relying on undocumented leniency is how a working integration
// breaks during somebody else's refactor.
//
// Secrets (Supabase project secrets — never in the repo, never in index.html):
//   QUO_API_KEY        required. Generated in Quo under workspace settings >
//                      API. Needs workspace owner or admin rights, and the
//                      key name may not contain spaces. Server-side only.
//   QUO_API_BASE       optional. Defaults to https://api.quo.com. No trailing
//                      slash, and NO /v1 — the version lives in the path, the
//                      same way AXISCARE_SITE_URL pairs with /api/... paths.
//   QUO_ALLOWED_PATHS  optional. Comma-separated path prefixes this proxy may
//                      call. Leave unset for the read-only list below.
//   ALLOWED_ORIGIN     shared with devi-agent. Comma-separated origin list.
//   QUO_SHARED_SECRET  optional. If set, requires a matching X-Quo-Secret
//                      header. See the note on CORS below — worth setting.
//
// CORS IS NOT ACCESS CONTROL, and on this function that matters more than it
// does on devi-agent. ALLOWED_ORIGIN stops another *website* reading the
// replies in a visitor's browser. It does nothing about curl: a CORS check is
// enforced by the browser, not by the server. Deployed --no-verify-jwt, this
// endpoint is reachable by anyone who knows the URL, and what it reads back
// includes message bodies, call transcripts and client contact details —
// materially more sensitive than the roster. The dashboard has no login (a
// reviewed, accepted decision — README, "Security posture"), so QUO_SHARED_
// SECRET is the only thing here that actually authenticates a caller. It is
// optional to match devi-agent; it is recommended for exactly this reason.
//
// A COMMIT DOES NOT DEPLOY THIS FILE. index.html auto-deploys to Netlify;
// supabase/functions/ does not. After changing anything here:
//     npx supabase functions deploy quo --no-verify-jwt
// JWT verification OFF because the dashboard sends no JWT — same as
// devi-agent. Until that command runs, the browser gets a 404 and the Quo
// module reports the function as not deployed.
//
// From the browser console on the deployed site:
//     await Quo.status()                          is it configured?
//     await Quo.ping()                            does the key actually work?
//     await Quo.get('/v1/phone-numbers')          the inboxes
//     await Quo.get('/v1/users')                  the workspace members
//     await Quo.get('/v1/conversations', { maxResults: 10 })

/* Quo's own documented ceiling is 10 requests per second per API key, shared
   by everything pointed at that key. Nothing in this dashboard calls Quo on a
   schedule yet, so we are nowhere near it — but a 429 is surfaced plainly
   below rather than folded into a generic error, because when it does start
   mattering the message is the whole diagnosis. */
const RATE_PER_SEC_DOC = 10;

const KEY = (Deno.env.get("QUO_API_KEY") ?? "").trim();
const BASE = (Deno.env.get("QUO_API_BASE") ?? "https://api.quo.com").trim().replace(/\/+$/, "");
const SECRET = (Deno.env.get("QUO_SHARED_SECRET") ?? "").trim();
const ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "*")
  .split(",").map((s) => s.trim()).filter(Boolean);

/* Read-only endpoints, confirmed against Quo's published reference on
   2026-09-11. Every one of these is a GET route.

   Deliberately ABSENT, and each for the same reason — they only exist as
   mutations, so listing them would be noise at best and an invitation at
   worst: POST /v1/messages, POST|PATCH|DELETE /v1/contacts/{id},
   POST /v1/conversations/{id}/mark-as-*, the whole /v1/tasks/{id}/* family.
   The method gate already makes them unreachable; leaving them out of the
   allowlist means nobody reading this file thinks otherwise.

   A prefix here permits the collection AND everything under it, so
   "/v1/calls" covers "/v1/calls/{id}". */
const DEFAULT_ALLOWED = [
  "/v1/phone-numbers",        // the four inboxes. Used by ping — no client data.
  "/v1/users",                // workspace members. No client data.
  "/v1/contacts",             // GET only: list / read. PHI-adjacent.
  "/v1/contact-custom-fields",
  "/v1/conversations",        // threads, not bodies
  "/v1/messages",             // GET only: list / read. Message BODIES. PHI.
  "/v1/calls",
  "/v1/call-summaries",
  "/v1/call-transcripts",     // transcripts of real client calls. PHI.
  "/v1/call-recordings",
  "/v1/call-voicemails",
  "/v1/tasks",
  "/v1/webhooks",             // GET only: list what is registered. Diagnostic.
];

/* REQUIRED query parameters, from Quo's OpenAPI spec. Worth having here in
   writing because the docs show DEFAULTS for these and the API still rejects
   the call without them — so the obvious first attempt at each of these
   routes returns 400, and the 400 reads like a bug in this proxy.

       /v1/messages       phoneNumberId (PN...), participants[], maxResults
       /v1/calls          phoneNumberId (PN...), participants[] (EXACTLY one —
                          1:1 conversations only), maxResults
       /v1/conversations  maxResults
       /v1/contacts       maxResults  — capped at 50 here, not 100
       /v1/phone-numbers  none, and NOT paginated
       /v1/users          none required

   phoneNumberId comes from /v1/phone-numbers, which is what ping reads.
   Paging is `pageToken`, never a page number; `since` is deprecated in
   favour of createdAfter / createdBefore.

   ARRAYS ARE REPEATED PARAMETERS, AND "name[]" IS A SILENT TRAP.
   Measured against the live account 2026-09-11:

       ?phoneNumbers=PN0T9aATba      25 rows, ALL from that one inbox
       ?phoneNumbers[]=PN0T9aATba    25 rows from SIX different inboxes —
                                     HTTP 200, filter silently ignored,
                                     byte-identical to sending no filter
       ?participants[]=+1805…        HTTP 400 "Expected array"

   So "[]" either fails loudly or, worse, succeeds while doing nothing. The
   correct form everywhere is plain repetition:

       participants=%2B18055551234&participants=%2B18055559999

   This is the same shape as the AxisCare `caregiverIds` trap documented in
   CLAUDE.md — a parameter accepted with a 200 and then ignored, so the code
   looks right until somebody notices another person's data on the screen.

   The "+" MUST be percent-encoded as %2B. A raw "+" in a query string
   decodes to a SPACE, which is a different phone number and not an error. */

/* ping asks for the cheapest endpoint that proves the key works end to end
   and carries no client information — the same role /api/caregivers?limit=1
   plays for AxisCare. It is also the only list route with no required
   parameters, which is what makes it usable as a bare health check. */
const PING_PATH = "/v1/phone-numbers";

const TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 60000;
const MAX_QUERY_PARAMS = 20;

/* Abuse brake, per isolate — Supabase may run several, so this is a brake and
   not a guarantee. Same shape and the same reasoning as devi-agent's. */
/* SIZED AGAINST WHAT THE CARD ACTUALLY COSTS, not against a round number.
   One Communication Logs card is 12 lines x 2 = 24 requests, so 120 was
   FIVE caregiver profiles an hour per scheduler — a normal morning's work
   would have hit it, and the failure surfaces as an unexplained error on
   the card. 720 is 30 profiles an hour, which is busier than the desk gets.

   This is not the control on sending. SEND_HOURLY_CAP bounds that
   separately, and the roster allowlist bounds who can be reached at all;
   this only stops one caller monopolising the proxy. */
const RATE_MAX = 720;                     // per claimed caller, per window
const RATE_TOTAL = 2000;                  // per isolate, per window — the real cap
const RATE_WINDOW_MS = 60 * 60 * 1000;

// --- CORS --------------------------------------------------------------------
//
// Lifted from devi-agent so both functions behave identically and one
// ALLOWED_ORIGIN secret configures both. The two traps repeat here because
// they cost time once already: "null" is what a page opened off disk sends
// and is NOT a wildcard, and a local server sends a REAL origin
// (http://localhost:8888 for `netlify dev`), which needs its own entry.
function normOrigin(s: string): string {
  return s.trim().replace(/\/+$/, "");
}

function originAllowed(origin: string): boolean {
  if (!origin) return false;
  const o0 = normOrigin(origin);
  return ORIGINS.some((raw) => {
    const o = normOrigin(raw);
    if (o === o0) return true;
    if (!o.includes("*")) return false;
    const i = o.indexOf("*");
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
    "access-control-allow-headers": "content-type, x-quo-secret",
    /* POST is advertised because action=send needs it. The method gate in the
       handler is what actually restricts it — this header only tells a browser
       what to bother preflighting, and CORS was never the lock. */
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    ...(allowAll ? {} : { vary: "Origin" }),
  };
}

const json = (cors: Record<string, string>, status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" },
  });

// --- rate limit --------------------------------------------------------------
const hits = new Map<string, number[]>();
let all: number[] = [];
function rateLimited(ip: string): boolean {
  const now = Date.now();

  /* ONLY AN ALLOWED REQUEST IS COUNTED.
     This used to push the timestamp BEFORE the comparison, so a caller who
     kept hammering after being refused kept topping the window up and it
     never drained — one burst locked the proxy out for a full hour, and a
     client that retries on 429 (which is the natural thing to write) held
     itself out indefinitely. Refusing without recording is what makes the
     window a rolling window rather than a latch. */
  const recent = all.filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_TOTAL) { all = recent; return true; }

  const seen = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (seen.length >= RATE_MAX) { hits.set(ip, seen); all = recent; return true; }

  recent.push(now); all = recent;
  seen.push(now);
  hits.set(ip, seen);
  /* Evict the oldest rather than clearing: hits.clear() would hand every
     caller a fresh allowance, which rotated X-Forwarded-For values could
     trigger on purpose. */
  if (hits.size > 5000) {
    [...hits.keys()].slice(0, 1000).forEach((k) => hits.delete(k));
  }
  return seen.length > RATE_MAX;
}

// --- Quo ---------------------------------------------------------------------

/* Belt and braces: never let the key escape in an error string. */
function redact(text: unknown): string {
  const s = String(text ?? "");
  return KEY ? s.split(KEY).join("[REDACTED]") : s;
}

function allowedPaths(): string[] {
  const raw = (Deno.env.get("QUO_ALLOWED_PATHS") ?? "").trim();
  if (!raw) return DEFAULT_ALLOWED;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/* Reject anything that could turn this into an open proxy. Every rule is here
   because it blocks a specific way of escaping the allowlist — a scheme turns
   it into a server-side request forgery tool, ".." walks out of the prefix,
   and "//host" is a protocol-relative URL that most parsers treat as absolute. */
function validatePath(path: string, allow: string[]): string | null {
  if (!path) return 'Missing "path" parameter.';
  if (!path.startsWith("/")) return 'Path must start with "/".';
  if (path.includes("..")) return 'Path must not contain "..".';
  if (path.startsWith("//")) return 'Path must not start with "//".';
  if (/^[a-z][a-z0-9+.-]*:/i.test(path.slice(1))) return "Path must not contain a URL scheme.";
  if (path.length > 512) return "Path is too long.";
  const hit = allow.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"));
  if (!hit) {
    return 'Path "' + path + '" is not in the allowlist. Allowed prefixes: ' + allow.join(", ") +
      ". Add it via the QUO_ALLOWED_PATHS secret — but only if it is a GET route.";
  }
  return null;
}

/* Warm isolates are reused between invocations, so this genuinely reduces
   load on a key that only gets 10 requests a second. */
const cache = new Map<string, { at: number; status: number; data: unknown }>();

/* A 429 IS EXPECTED HERE, WHICH IS WHY IT IS RETRIED RATHER THAN SURFACED.
   Quo's ceiling is 10 req/s for the whole API key, and the key is shared by
   every scheduler because they all come through this one function. Opening a
   caregiver profile sweeps every agency line, so two people opening profiles
   at once can cross it through no fault of either.

   Measured 2026-09-11: a 24-request sweep at concurrency 5 took 2,267ms —
   about 10.6 req/s — and 4 of the 24 came back 429. The browser paces itself
   below the limit, and this is the second line of defence for when two
   browsers pace independently and collide.

   Retry-After is honoured when sent. Only 429 and 5xx are retried: a 400 or a
   404 is an answer, and repeating it just spends the budget that the retry
   exists to protect. */
const RETRIES = 2;

async function callQuo(url: string): Promise<{ res: Response; data: unknown }> {
  let res!: Response;
  for (let i = 0; i <= RETRIES; i++) {
    res = await fetch(url, {
      headers: {
        Accept: "application/json",
        /* RAW KEY. No "Bearer " — see the header. */
        Authorization: KEY,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok || (res.status !== 429 && res.status < 500)) break;
    if (i === RETRIES) break;
    const ra = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 350 * Math.pow(2, i);
    /* Release the socket before sleeping, or the connection is held open for
       the whole backoff. */
    await res.body?.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, Math.min(wait, 4000)));
  }
  const text = await res.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : null; }
  catch { data = { raw: redact(text).slice(0, 2000) }; }
  return { res, data };
}

/* Quo's own error messages are good — surface them rather than replacing them
   with something vaguer. The shape is not pinned down in its docs, so check
   the field names it actually uses in order. */
function quoErrors(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.message === "string" && d.message) return d.message;
  if (typeof d.error === "string" && d.error) return d.error;
  if (Array.isArray(d.errors)) return d.errors.map((e) => typeof e === "string" ? e : JSON.stringify(e)).join("; ");
  if (d.error && typeof d.error === "object") {
    const e = d.error as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
  }
  if (typeof d.title === "string" && d.title) return d.title;
  return null;
}

function hintFor(status: number): string | undefined {
  if (status === 400) return "Quo names the offending field above. The most common cause by far: maxResults is REQUIRED on the list routes even though the docs show a default — see the REQUIRED PARAMETERS note near the top of this file. It is capped at 50 on /v1/contacts and 100 everywhere else.";
  if (status === 401) return "Quo rejected the key. Check QUO_API_KEY — it may be wrong, revoked, or copied with surrounding whitespace.";
  /* 402 became reachable on 2026-09-14 with action=send. It used to say "not
     reachable from this proxy, which forwards GET only — if you are seeing
     this, something is wrong", which would now send somebody hunting a bug
     when the real answer is that the agency has run out of credit. */
  if (status === 402) return "Quo's prepaid messaging credits are exhausted, so the text was not sent. Top up the Quo workspace — nothing in this app can fix it.";
  /* Do NOT put "call summaries and transcripts are Business/Scale only" back
     in here. It was copied from Quo's docs, never tested, and is false on this
     account: all three summary/transcript/recording routes answer 200 and 14
     of 14 real calls came back with content. CLAUDE.md records the correction. */
  if (status === 403) return "The key is valid but lacks permission for this route, or the workspace plan does not include it.";
  if (status === 404) return "Quo has no such route, or the record does not exist. Check the path starts with /v1. Note: Quo's behaviour on an EMPTY list result is undocumented — do not assume 404 means empty the way AxisCare does.";
  if (status === 422) return "Quo rejected the parameters. It says which, above.";
  if (status === 429) return "Rate limited. Quo allows " + RATE_PER_SEC_DOC + " requests per second per API key, shared by everything using that key.";
  return undefined;
}

/* ═══════════════════════════════════════════════════════════════════════
   SENDING A TEXT — the one mutation this proxy can perform
   ═══════════════════════════════════════════════════════════════════════
   Added 2026-09-14, at Mitch's explicit request. Until then the file was
   GET-only and CLAUDE.md said plainly that changing it was "a PHI decision
   and a billing decision", not a code decision. That conversation happened;
   what follows is the shape it was agreed in.

   WHAT MAKES THIS SAFE ENOUGH TO EXIST. The dashboard has no login, this
   function is deployed --no-verify-jwt, and CORS is enforced by browsers
   and does nothing against curl. So anyone who learns the URL can reach
   this. Four guards, and only the first two really matter:

     1. THE DESTINATION MUST BE ON THE AXISCARE ROSTER. This is the one
        that converts "a stranger can text anyone on earth from the
        agency's number" into "a stranger could annoy our own caregivers".
        The roster is read through the app's OWN public Netlify AxisCare
        proxy, so no AxisCare token has to be copied into Supabase.
     2. `from` MUST BE ONE OF OUR REAL QUO LINES, matched against the live
        /v1/phone-numbers list. The browser picks WHICH line; it cannot
        invent one, and it cannot spoof a number the agency does not own.
     3. A HARD HOURLY CAP, so the worst case is bounded rather than
        open-ended. Per isolate, so it is a brake and not a guarantee —
        the same honest limit devi-agent's rate limiter has.
     4. Caps on recipients and message length, so one request cannot turn
        into a bulk campaign.

   None of this is a substitute for a login. It is what is achievable
   without one, stated honestly. The real kill switch is deleting the API
   key in Quo, which stops everything instantly.

   TEST MODE IS STRICTER HERE THAN IN THE OLD APP. That one let a
   scheduler type any number. This one requires the test destination to be
   one of the agency's OWN Quo lines — otherwise "test mode" is just an
   unrestricted send-to-anywhere with a friendlier label. */

const SEND_MAX_RECIPIENTS = 25;
const SEND_MAX_CHARS = 1600;            // Quo's own content limit
const SEND_HOURLY_CAP = 200;            // per isolate; see guard 3 above
const SEND_WINDOW_MS = 60 * 60 * 1000;

/* Where to read the active roster from. This is the app's own AxisCare
   proxy on Netlify — a PUBLIC endpoint, which is exactly why it can be
   used here without duplicating AXISCARE_API_TOKEN into Supabase. If it
   is unset, sending is REFUSED rather than silently unguarded. */
const ROSTER_URL = (Deno.env.get("QUO_ROSTER_URL") ?? "").trim().replace(/\/+$/, "");

const sends: number[] = [];
function sendCapped(): boolean {
  const now = Date.now();
  while (sends.length && now - sends[0] >= SEND_WINDOW_MS) sends.shift();
  if (sends.length >= SEND_HOURLY_CAP) return true;
  sends.push(now);
  return false;
}

/* The same three cases index.html's toE164 accepts, and for the same
   reason: NEVER guess a country code onto garbage. A wrong prefix is a
   real number belonging to somebody else. */
function toE164(raw: unknown): string | null {
  const s = String(raw ?? "");
  if (/^\+[1-9]\d{7,14}$/.test(s.trim())) return s.trim();
  let d = s.replace(/[^0-9]/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  if (d.length !== 10) return null;
  if (d[0] === "0" || d[0] === "1" || d[3] === "0" || d[3] === "1") return null;
  return "+1" + d;
}

/* Our own Quo lines, with the users Quo returns inline on each one — the
   "Send as" list comes free with the "Send from" list. Cached briefly:
   a line is not added mid-shift, and this is on the path of every send. */
let lineCache: { at: number; lines: Array<{ id: string; number: string; name: string; users: Array<{ id: string; name: string; email: string }> }> } | null = null;
async function ourLines() {
  if (lineCache && Date.now() - lineCache.at < 10 * 60 * 1000) return lineCache.lines;
  const { res, data } = await callQuo(BASE + "/v1/phone-numbers");
  if (!res.ok) throw new Error("Could not read the agency's Quo lines.");
  const rows = ((data as { data?: unknown[] })?.data ?? []) as Array<Record<string, unknown>>;
  const lines = rows.map((n) => ({
    id: String(n.id ?? ""),
    number: toE164(n.number) ?? String(n.number ?? ""),
    name: String(n.name ?? n.number ?? ""),
    users: (Array.isArray(n.users) ? n.users : []).map((u: Record<string, unknown>) => ({
      id: String(u.id ?? ""),
      name: (String(u.firstName ?? "") + " " + String(u.lastName ?? "")).replace(/\s+/g, " ").trim() || String(u.email ?? ""),
      email: String(u.email ?? ""),
    })).filter((u) => u.id),
  })).filter((l) => l.id && l.number);
  /* Never cache an EMPTY list. Quo answering 200 with no lines is either a
     transient or a workspace problem, and caching it disables sending for
     ten minutes with a dropdown that simply has nothing in it. */
  if (lines.length) lineCache = { at: Date.now(), lines };
  return lines;
}

/* Every number on the ACTIVE AxisCare roster, E.164. The allowlist that
   makes this endpoint tolerable. A failure here refuses the send — it must
   never fall open, because falling open is precisely the thing guard 1
   exists to prevent. */
/* AxisCare's `nextPage` is a FULL URL, not a bare id:
     "https://7060.axiscare.com/api/caregivers?statuses=Active&startAfterId=37&limit=3"
   Passing that straight back as startAfterId reads page one forever, and this
   proxy would then have "verified" the whole roster against its first 200
   names. index.html carries `axPageCursor` for exactly this reason, with a
   comment recording that it already truncated the roster once. Same rule
   here: pull the cursor out of whatever shape arrives, and fall back to the
   highest id in the page just read rather than silently stopping short. */
function rosterCursor(next: unknown, page: Array<Record<string, unknown>>): string | null {
  const m = /[?&](?:startAfterId|after|afterId|cursor|pageToken)=([^&]+)/.exec(String(next ?? ""));
  if (m) return decodeURIComponent(m[1]);
  const s = String(next ?? "");
  if (s && s !== "true" && /^[\w.:-]+$/.test(s)) return s;
  let max: number | null = null;
  for (const c of page) {
    const id = Number(c?.id);
    if (Number.isFinite(id) && (max === null || id > max)) max = id;
  }
  return max === null ? null : String(max);
}

let rosterCache: { at: number; nums: Set<string>; count: number } | null = null;
async function rosterNumbers(): Promise<Set<string>> {
  if (rosterCache && Date.now() - rosterCache.at < 10 * 60 * 1000) return rosterCache.nums;
  if (!ROSTER_URL) throw new Error("QUO_ROSTER_URL is not set, so the roster allowlist cannot be checked and sending is refused.");

  const nums = new Set<string>();
  const seen = new Set<string>();
  let after: string | null = null;
  let complete = false;

  for (let page = 0; page < 8; page++) {
    const u = ROSTER_URL + "?action=get&path=%2Fapi%2Fcaregivers&q_limit=200&q_statuses=Active" +
      (after ? "&q_startAfterId=" + encodeURIComponent(after) : "");
    const r = await fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error("Could not read the caregiver roster (HTTP " + r.status + ").");
    const b = await r.json().catch(() => null) as
      { data?: { results?: { caregivers?: Record<string, Record<string, unknown>>; nextPage?: string } } } | null;

    const rows = Object.values(b?.data?.results?.caregivers ?? {});
    let fresh = 0;
    for (const c of rows) {
      const id = String(c?.id ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      fresh++;
      /* All three numbers, because `c.phone` in the browser collapses to
         mobile || home || other and a scheduler may well be texting the one
         AxisCare happens to list second. Every one of them is still this
         caregiver's own number, which is the only thing the guard asserts. */
      for (const f of ["mobilePhone", "homePhone", "otherPhone"]) {
        const e = toE164(c[f]);
        if (e) nums.add(e);
      }
    }

    const next = b?.data?.results?.nextPage;
    if (!next) { complete = true; break; }            // AxisCare says that was the last page
    /* A STUCK CURSOR IS NOT A FINISHED READ. AxisCare still claims there is
       a next page, and we got nothing new from it — so we do not know what
       is on the rest of the roster. index.html's fetchClients treats this as
       "done" and that is fine for a LIST; here it decides who may be texted,
       and calling a short read complete would cache a partial allowlist for
       ten minutes. Refuse instead. */
    if (!fresh) break;                                // cursor stopped advancing — NOT complete
    const cur = rosterCursor(next, rows);
    if (cur === null) break;                          // unreadable cursor — NOT complete
    after = cur;
  }

  /* A SHORT read must not be cached as if it were the roster. An incomplete
     allowlist does not fail open — it refuses caregivers who are really on the
     roster, which is the safe direction — but caching it would make that
     wrongness last ten minutes instead of one request. */
  if (!nums.size) throw new Error("The roster came back empty, so no destination could be verified. Nothing was sent.");
  if (!complete) throw new Error("The caregiver roster could not be read in full, so destinations could not be verified. Nothing was sent.");
  rosterCache = { at: Date.now(), nums, count: seen.size };
  return nums;
}

/* What a failed SEND means, in the words a scheduler can act on. Kept
   apart from hintFor(), which answers for the read routes. */
function sendHintFor(status: number): string | undefined {
  if (status === 400) return "Quo rejected the message itself — check the number and that the text is not empty.";
  if (status === 401) return "Quo rejected the API key, so nothing was sent. QUO_API_KEY may have been revoked.";
  if (status === 402) return "Quo's prepaid messaging credits are exhausted. Top up the Quo workspace — nothing in this app can fix it.";
  if (status === 403) return "This Quo line is not allowed to send, or the workspace plan does not cover it.";
  if (status === 404) return "Quo does not recognise the sending line. It may have been removed from the workspace.";
  if (status === 422) return "Quo could not accept these details — most often a number it will not deliver to.";
  if (status === 429) return "Quo is rate-limiting the agency's key. Wait a moment and send the rest.";
  if (status >= 500) return "Quo had a server error. This one was NOT retried, because a retry can text somebody twice — send it again only if the caregiver did not receive it.";
  return undefined;
}

/* ONE message. Quo takes `to` as an array but the old app always sent
   exactly one element, and so does this: a multi-element `to` creates a
   GROUP THREAD where every caregiver sees every other caregiver's number,
   which is a different feature and not one anybody asked for. */
async function sendOne(from: string, to: string, content: string, userId: string) {
  const body: Record<string, unknown> = { from, to: [to], content };
  if (userId) body.userId = userId;
  /* DELIBERATELY NOT callQuo(). That helper retries a 429 and a 5xx, which is
     right for a read and wrong here: a send that timed out or 502'd may well
     have reached Quo, and retrying it texts the caregiver twice. A read costs
     a request; a duplicate text costs the desk's credibility. One attempt, and
     the per-recipient result says honestly that it is unknown. */
  const res = await fetch(BASE + "/v1/messages", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  /* Quo answers a queued message 202, not 200. */
  if (res.status === 202 || res.ok) {
    const d = (data as { data?: { id?: string }; id?: string }) ?? {};
    return { ok: true as const, id: d.data?.id ?? d.id ?? null };
  }
  const why = quoErrors(data) || ("Quo returned HTTP " + res.status + ".");
  /* sendHintFor, NOT hintFor. The read hints are written for the list
     routes, so a failed TEXT was telling the scheduler that "maxResults is
     REQUIRED on the list routes… capped at 50 on /v1/contacts" — advice
     about a call they did not make, attached to a message that did not
     arrive. Wrong help is worse than none. */
  const hint = sendHintFor(res.status);
  return { ok: false as const, error: hint ? why + " " + hint : why };
}

/* `{name}` is the only token, substituted per recipient. Every OTHER
   {placeholder} is deleted rather than transmitted — a literal "{client}"
   arriving on a caregiver's phone is worse than a gap. Same rule the old
   app used, and it runs server-side so one template personalises N ways. */
const NAME_MAX = 40;

function personalise(template: string, name: string): string {
  /* CAPPED. The name arrives in the request body and nothing upstream
     bounds it; a real first name is never near 40 characters. */
  const first = (String(name ?? "").trim().split(/\s+/)[0] || "there").slice(0, NAME_MAX);
  return template
    /* THE FUNCTION FORM, NOT THE STRING FORM, AND THIS IS NOT STYLE.
       String.prototype.replace treats `$` in a STRING replacement as a
       substitution pattern: `$&` re-inserts the match, `$\`` everything
       before it, and `$'` everything AFTER it. So a name of repeated `$'`
       re-inserts the rest of the template once per occurrence, and the
       message grows geometrically — measured on this function, a 1,524-char
       template under the 1,600 limit plus a 10,000-char name produced a
       **7.5 million character** body, roughly 49,000 billable SMS segments,
       from one request that passed every length check.

       It also misfires with no attacker at all: a caregiver whose first
       name contains `$` would have their own message quietly mangled.

       A replacer FUNCTION is never scanned for `$` patterns. */
    .replace(/\{name\}/gi, () => first)
    .replace(/\{[^}]*\}/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: Object.keys(cors).length ? 204 : 403, headers: cors });
  }
  if (!Object.keys(cors).length) {
    /* No CORS headers means the browser rejects the reply anyway; answering
       403 with a readable reason makes it visible in the network tab rather
       than looking like the function is down. */
    return new Response(JSON.stringify({ ok: false, error: "origin not allowed: " + (origin || "(none sent)") }),
      { status: 403, headers: { "content-type": "application/json" } });
  }

  const url = new URL(req.url);
  const qs = url.searchParams;
  const action = qs.get("action") || "status";
  const configured = !!(KEY && BASE);

  /* THE METHOD GATE.
     ------------------------------------------------------------------
     Until 2026-09-14 this was GET-only, full stop, and that was the whole
     security argument of the file. It is now GET **plus POST for exactly
     one action**, `send`, because the desk asked for texting — the
     conversation CLAUDE.md said had to happen before this changed.

     The shape is deliberate: POST reaches nothing but `send`, and `get`
     can still only ever issue a GET upstream. So the proxy remains
     incapable of deleting a contact, completing a task or marking a
     conversation read; the ONLY mutation it can perform is the one that
     was asked for, and it is guarded by everything in doSend(). */
  const isSend = action === "send";
  if (req.method !== "GET" && !(req.method === "POST" && isSend)) {
    return json(cors, 405, {
      ok: false,
      error: req.method === "POST"
        ? 'POST is only accepted for action=send. Everything else on this proxy is read-only.'
        : "Only GET is supported, plus POST for action=send. This proxy cannot modify anything else in Quo.",
    });
  }
  /* A send must be POSTed. Refusing it over GET is not pedantry: a GET is
     what ends up in a browser history, a prefetch, a link somebody pastes
     into a chat, and a crawler's queue. None of those may cost money. */
  if (isSend && req.method !== "POST") {
    return json(cors, 405, { ok: false, error: "action=send must be POSTed, never fetched with GET." });
  }

  /* ---- status: is the plumbing in place? Never reveals the key. ---- */
  if (action === "status") {
    return json(cors, 200, {
      ok: true,
      configured,
      apiBase: BASE || null,
      keySet: !!KEY,
      keyLength: KEY ? KEY.length : 0,      // presence check without disclosure
      sharedSecretRequired: !!SECRET,
      allowedPaths: allowedPaths(),
      /* `readOnly` is FALSE now, and it is reported rather than quietly
         dropped: something that was true of this function for three days is
         not true any more, and a stale `true` here would be worse than no
         field at all. Everything except action=send still is read-only. */
      readOnly: false,
      canSend: !!ROSTER_URL,
      sendLimits: { maxRecipients: SEND_MAX_RECIPIENTS, maxChars: SEND_MAX_CHARS, hourlyCap: SEND_HOURLY_CAP },
      rosterGuard: ROSTER_URL
        ? "on — a text can only be sent to a number on the active AxisCare roster"
        : "OFF — QUO_ROSTER_URL is unset, so sending is refused entirely",
      mode: configured ? "ready" : "not configured",
      note: configured
        ? "Configured. Run Quo.ping() to confirm the key actually works."
        : "Set QUO_API_KEY in the Supabase project secrets, then redeploy with: npx supabase functions deploy quo --no-verify-jwt",
    });
  }

  if (!configured) {
    return json(cors, 503, {
      ok: false,
      error: "Quo is not configured on the server.",
      missing: [!KEY && "QUO_API_KEY", !BASE && "QUO_API_BASE"].filter(Boolean),
      hint: "Supabase dashboard > Project Settings > Edge Functions > Secrets. QUO_API_BASE has a default and is only needed if Quo moves the URL.",
    });
  }

  if (SECRET && req.headers.get("x-quo-secret") !== SECRET) {
    return json(cors, 401, { ok: false, error: "bad or missing X-Quo-Secret" });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    return json(cors, 429, { ok: false, error: "too many requests — try again shortly" });
  }

  /* ---- ping: prove the key works, end to end ---- */
  if (action === "ping") {
    try {
      /* No parameters. /v1/phone-numbers is the one list route that is NOT
         paginated — it takes no maxResults and its envelope carries no
         nextPageToken. Sending one anyway is how a ping starts failing for a
         reason that has nothing to do with the key. */
      const { res, data } = await callQuo(BASE + PING_PATH);
      const errs = quoErrors(data);
      return json(cors, res.ok ? 200 : 502, {
        ok: res.ok,
        status: res.status,
        message: res.ok
          ? "Quo responded successfully — the key is correct."
          : "Quo rejected the request.",
        hint: res.ok ? undefined : hintFor(res.status),
        quoError: errs || undefined,
      });
    } catch (err) {
      const e = err as Error;
      const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
      return json(cors, timedOut ? 504 : 502, {
        ok: false,
        error: timedOut
          ? "Quo did not respond within " + (TIMEOUT_MS / 1000) + "s."
          : "Could not reach Quo: " + redact(e?.message),
      });
    }
  }

  /* ---- lines: the Send-from / Send-as picker's data, in one request ----
     A thin read, but it belongs here rather than in the browser: the browser
     would otherwise have to know that /v1/phone-numbers returns `users`
     inline, and the send path has to build the same list anyway to validate
     `from`. One shape, one place, so the picker and the guard can never
     disagree about which lines exist. */
  if (action === "lines") {
    try {
      const lines = await ourLines();
      return json(cors, 200, { ok: true, lines });
    } catch (err) {
      return json(cors, 502, { ok: false, error: redact((err as Error)?.message) || "Could not read the agency's Quo lines." });
    }
  }

  /* ---- send: the one mutation. Read the header block before changing it. ---- */
  if (isSend) {
    if (!ROSTER_URL) {
      return json(cors, 503, {
        ok: false,
        error: "Texting is not enabled: QUO_ROSTER_URL is not set, so the caregiver-roster check cannot run.",
        hint: "Set QUO_ROSTER_URL in the Supabase project secrets to the app's own public AxisCare proxy, then redeploy.",
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json() as Record<string, unknown>;
    } catch {
      return json(cors, 400, { ok: false, error: "The request body was not valid JSON." });
    }

    const content = String(body.content ?? "");
    const rawFrom = String(body.from ?? "");
    const wantUser = String(body.userId ?? "");
    const testTo = body.testTo == null ? "" : String(body.testTo);
    const recips = Array.isArray(body.to) ? body.to : [];

    if (!content.trim()) return json(cors, 400, { ok: false, error: "The message is empty." });
    if (content.length > SEND_MAX_CHARS) {
      return json(cors, 400, { ok: false, error: "That message is " + content.length + " characters; the limit is " + SEND_MAX_CHARS + "." });
    }
    if (!recips.length) return json(cors, 400, { ok: false, error: "Nobody was selected to text." });
    if (recips.length > SEND_MAX_RECIPIENTS) {
      return json(cors, 400, { ok: false, error: "Too many recipients (" + recips.length + "); the limit is " + SEND_MAX_RECIPIENTS + "." });
    }

    /* THE HOURLY CAP IS PER MESSAGE, checked inside the loop below — this
       comment used to claim it was checked against the whole batch before
       anything was sent, which was simply not what the code did.

       Per message is the right unit (it counts what was actually spent) and
       it does mean a batch can stop half way. That is visible rather than
       silent: every recipient past the ceiling comes back with "The hourly
       sending limit was reached. Nothing further was sent." in their own
       result row, so the scheduler can see exactly who got it and who did
       not, and the roster and line reads below still happen once for the
       whole batch. */
    let lines: Awaited<ReturnType<typeof ourLines>>;
    let roster: Set<string>;
    try {
      [lines, roster] = await Promise.all([ourLines(), rosterNumbers()]);
    } catch (err) {
      return json(cors, 502, { ok: false, error: redact((err as Error)?.message) || "Could not verify the send. Nothing was sent." });
    }

    const line = lines.find((l) => l.id === rawFrom || l.number === toE164(rawFrom) || l.number === rawFrom);
    if (!line) {
      return json(cors, 400, {
        ok: false,
        error: rawFrom ? "That is not one of the agency's Quo lines." : "Choose a line to send from.",
        lines: lines.map((l) => ({ id: l.id, number: l.number, name: l.name })),
      });
    }

    /* Test mode sends the real thing to one of OUR OWN lines. Anything else
       would make "test" a way to text an arbitrary number, which is the guard
       this endpoint is built around. */
    let testE = "";
    if (testTo) {
      testE = toE164(testTo) || "";
      const ownLine = lines.find((l) => l.number === testE);
      if (!ownLine) {
        return json(cors, 400, {
          ok: false,
          error: "In test mode the destination must be one of the agency's own Quo lines, so a test can never reach a real person by accident.",
          lines: lines.map((l) => ({ id: l.id, number: l.number, name: l.name })),
        });
      }
      if (testE === line.number) {
        return json(cors, 400, { ok: false, error: "A line cannot text itself. Pick a different line as the test destination." });
      }
    }

    /* Who it is attributed to inside Quo. The caregiver sees only the line
       number either way — this decides whose name is on the thread for the
       desk. Explicit pick, else a member of this line, else omit and let Quo
       decide rather than pinning every send on a person at random. */
    const userId = (wantUser && line.users.some((u) => u.id === wantUser)) ? wantUser : "";

    const results: Array<Record<string, unknown>> = [];
    let sent = 0;
    for (const r of recips) {
      const rec = (r ?? {}) as Record<string, unknown>;
      const name = String(rec.name ?? "");
      const real = toE164(rec.phone);
      const entry: Record<string, unknown> = { id: rec.id ?? null, name, phone: rec.phone ?? null };

      if (!real) {
        results.push({ ...entry, ok: false, error: "No usable mobile number on file." });
        continue;
      }
      /* The roster check reads the CAREGIVER'S number, never the test
         destination — otherwise test mode would be a way round the allowlist. */
      if (!roster.has(real)) {
        results.push({ ...entry, ok: false, error: "That number is not on the active AxisCare roster, so it was not texted." });
        continue;
      }
      if (sendCapped()) {
        results.push({ ...entry, ok: false, error: "The hourly sending limit was reached. Nothing further was sent." });
        continue;
      }

      const dest = testE || real;
      /* The length check at the top ran on the TEMPLATE. Substitution can
         only ever make it longer, so the thing actually sent has to be
         measured too — otherwise SEND_MAX_CHARS bounds the wrong string. */
      const body = personalise(content, name);
      if (body.length > SEND_MAX_CHARS) {
        results.push({ ...entry, ok: false, error: "After filling in the name this message came to " + body.length + " characters; the limit is " + SEND_MAX_CHARS + "." });
        continue;
      }
      try {
        const out = await sendOne(line.number, dest, body, userId);
        if (out.ok) sent++;
        results.push({ ...entry, ok: out.ok, test: !!testE, messageId: out.ok ? out.id : undefined, error: out.ok ? undefined : out.error });
      } catch (err) {
        const e = err as Error;
        const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
        results.push({ ...entry, ok: false, error: timedOut ? "Quo did not respond in time; this one may or may not have been sent." : redact(e?.message) });
      }
    }

    /* 200 whatever the mix. Every recipient carries its own verdict, and a
       partial send is a normal outcome the scheduler has to SEE rather than a
       failure to retry blindly — re-POSTing on a 502 would text the people who
       already got it a second time. */
    return json(cors, 200, {
      ok: sent > 0,
      sent,
      failed: results.length - sent,
      test: !!testE,
      from: { id: line.id, number: line.number, name: line.name },
      results,
    });
  }

  if (action !== "get") {
    return json(cors, 400, { ok: false, error: 'Unknown action "' + action + '". Use "status", "ping", "get", "lines" or "send".' });
  }

  /* ---- get: proxy a read ---- */
  const path = qs.get("path") || "";
  const bad = validatePath(path, allowedPaths());
  if (bad) return json(cors, 400, { ok: false, error: bad });

  /* Forward q_* params as real query params: q_maxResults=10 -> maxResults=10.
     Same convention as the AxisCare proxy, so the two read alike.

     APPEND, NOT SET. Quo expresses an array as a REPEATED parameter —
     participants=A&participants=B — and `set` would silently keep only the
     last one, turning a group lookup into a one-person lookup with no error
     anywhere. `qs.entries()` already yields duplicate keys separately, so
     append is all that is needed.

     And note: the array syntax is PLAIN REPETITION, never "name[]". See the
     warning block at the top of this file — "[]" is accepted with a 200 and
     then ignored. */
  const params = new URLSearchParams();
  let count = 0;
  for (const [k, v] of qs.entries()) {
    if (!k.startsWith("q_")) continue;
    if (++count > MAX_QUERY_PARAMS) return json(cors, 400, { ok: false, error: "Too many query parameters." });
    params.append(k.slice(2), v);
  }

  const q = params.toString();
  const target = BASE + path + (q ? (path.includes("?") ? "&" : "?") + q : "");

  const hit = cache.get(target);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return json(cors, 200, { ok: true, cached: true, status: hit.status, data: hit.data });
  }

  try {
    const { res, data } = await callQuo(target);

    if (!res.ok) {
      const errs = quoErrors(data);
      /* Map upstream auth failures to 502: a 401 from here would read as
         "your X-Quo-Secret is wrong", which is a different problem. */
      return json(cors, (res.status === 401 || res.status === 403) ? 502 : res.status, {
        ok: false,
        status: res.status,
        error: "Quo returned HTTP " + res.status + ".",
        quoError: errs || undefined,
        hint: hintFor(res.status),
        data,
      });
    }

    cache.set(target, { at: Date.now(), status: res.status, data });
    if (cache.size > 100) cache.delete(cache.keys().next().value as string);

    /* Quo wraps list results in a `data` key and carries the cursor beside it.
       Passed through verbatim — the browser unwraps, exactly as it does for
       AxisCare's results.<entity>. */
    return json(cors, 200, { ok: true, cached: false, status: res.status, data });

  } catch (err) {
    const e = err as Error;
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return json(cors, timedOut ? 504 : 502, {
      ok: false,
      error: timedOut
        ? "Quo did not respond within " + (TIMEOUT_MS / 1000) + "s."
        : "Could not reach Quo: " + redact(e?.message),
      hint: timedOut ? undefined : "Check that QUO_API_BASE is correct and reachable. It should be https://api.quo.com with no trailing slash and no /v1.",
    });
  }
});
