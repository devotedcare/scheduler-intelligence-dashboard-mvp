// Quo proxy  ·  READ-ONLY  ·  (Supabase Edge Function)
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
// WHY THIS EXISTS, AND WHY IT FORWARDS GET AND NOTHING ELSE.
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
// Roughly half of Quo's ~45 endpoints mutate something. So the method gate
// below is the security boundary of this file: the handler accepts GET, and
// the upstream call is GET. There is no code path here that can send a
// message, and that is deliberate rather than incidental. The allowlist is
// defence in depth behind it, not the primary lock.
//
// Claude: DO NOT add a POST branch, a `method` parameter, or a send action
// "so the dashboard can text a caregiver about an open shift". That is a real
// thing the desk will eventually want and it is NOT a code decision — it is a
// PHI decision and a billing decision, and CLAUDE.md already records it as
// Carlo's under "Devi actions": there is no SMS channel in this dashboard on
// purpose. Wiring one starts with that conversation, not with this file.
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
const RATE_MAX = 120;                     // per claimed caller, per window
const RATE_TOTAL = 600;                   // per isolate, per window — the real cap
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
    /* GET and OPTIONS. Not POST — see the header. */
    "access-control-allow-methods": "GET, OPTIONS",
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

  all = all.filter((t) => now - t < RATE_WINDOW_MS);
  all.push(now);
  if (all.length > RATE_TOTAL) return true;

  const seen = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
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
  if (status === 402) return "Quo's prepaid messaging credits are exhausted. Not reachable from this proxy, which forwards GET only — if you are seeing this, something is wrong.";
  if (status === 403) return "The key is valid but lacks permission, or the workspace plan does not include this. Call summaries and transcripts are Business/Scale plans only.";
  if (status === 404) return "Quo has no such route, or the record does not exist. Check the path starts with /v1. Note: Quo's behaviour on an EMPTY list result is undocumented — do not assume 404 means empty the way AxisCare does.";
  if (status === 422) return "Quo rejected the parameters. It says which, above.";
  if (status === 429) return "Rate limited. Quo allows " + RATE_PER_SEC_DOC + " requests per second per API key, shared by everything using that key.";
  return undefined;
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

  /* THE METHOD GATE. This is the security boundary of the file — with GET the
     only verb accepted here and the only verb sent upstream, there is no
     reachable path that sends a message or deletes anything. */
  if (req.method !== "GET") {
    return json(cors, 405, {
      ok: false,
      error: "Only GET is supported. This proxy is read-only by design — it cannot send messages or modify anything in Quo.",
    });
  }

  const url = new URL(req.url);
  const qs = url.searchParams;
  const action = qs.get("action") || "status";
  const configured = !!(KEY && BASE);

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
      readOnly: true,
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

  if (action !== "get") {
    return json(cors, 400, { ok: false, error: 'Unknown action "' + action + '". Use "status", "ping" or "get".' });
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
