// app-gate  ·  the ONLY way the dashboard reaches its Supabase data  ·  (Supabase Edge Function)
//
// WHAT THIS IS FOR
//
// Until 2026-09-18 the browser read and wrote this project's tables directly,
// with the anon key baked into config.js. That key is public — view-source has
// it — so anyone who found the site URL could read the desk's records and,
// worse, write them: a browser nobody can identify pushing a bad copy over the
// shared scheduler_state row, with no way to stop it. That is exactly how a
// sibling app lost every record (369 kB -> 17 kB, recovered from a daily
// backup at a cost of 41 hours of work).
//
// Now the tables have RLS on and NO anon policies, and every read and write
// comes through here:
//
//   1. the PIN is checked on EVERY request — there is no session and no token
//   2. then the work is done with the service-role key
//
// Point 1 is the requirement, not an implementation detail. Changing APP_PIN
// locks out every open tab on its very next request, including one that has
// been open for days. A token, or a "verified once at load" flag, would not.
//
// ── WHAT A CALLER MAY DO ────────────────────────────────────────────────────
//
//   (no action)       the PIN was right; that is all the lock screen asks
//   state.head        the scheduler_state rev, for the 20-second poll
//   state.load        the whole scheduler_state row
//   state.save        compare-and-swap on rev; an EMPTY overlay may not
//                     replace one holding records unless `force` is set
//   state.create      the first-run insert, only if the row does not exist
//   rest              one PostgREST request against an ALLOWLISTED table,
//                     method, column set and query shape — see ALLOW. It is
//                     exactly the set of requests index.html makes, and
//                     nothing outside it is reachable whatever the PIN.
//   photo.put/.del    one caregiver photo in the caregiver-photos bucket
//
// scheduler_state is deliberately NOT reachable through `rest`. Its writes
// have to pass the empty-copy guard and the rev check, and a generic relay
// would be a way round both.
//
// ── STATUS CODES ────────────────────────────────────────────────────────────
//
// 401 and 403 from this function ALWAYS mean "the PIN": the browser clears the
// PIN it holds and puts the lock screen back on either. So an upstream 401/403
// (which the service key should never produce) is reported as 502, never
// passed through — a misconfigured key must not look like a changed PIN and
// bounce the whole desk to the lock screen in a loop. For the same reason a
// request this function refuses on shape is 400, never 403.
//
//   401 bad_pin {attempts_left}      429 locked {retry_after, seconds}
//   409 conflict (rev moved)         422 empty_refused
//   400 bad request / not allowed    503 not_configured / throttle_unavailable
//                                        / upstream_busy — fail closed
// An upstream 429 is reported as 503 for the same reason 401/403 are
// remapped: 429 from here means the PIN throttle and nothing else.
//
// ── THE THROTTLE, AND HOW IT DIFFERS FROM THE REFERENCE ─────────────────────
//
// It counts DISTINCT wrong PINs per IP (see supabase/app-gate.sql). The desk
// shares one office IP, and the moment the PIN is changed every open tab fails
// several requests at once — counting requests would lock the whole office out
// for fifteen minutes, including whoever types the new PIN. And the verdict
// for every request (ok / bad / locked) comes from ONE SQL call holding the
// IP's row lock, so a burst of simultaneous guesses is answered in turn: no
// more than 8 distinct PINs are ever compared per window.
//
// ── SECRETS (Supabase project secrets) ──────────────────────────────────────
//   APP_PIN                     required. Unset = every request refused (503)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   provided by Supabase itself
//   DB_SECRET_KEY               optional override for the service key
//   ALLOWED_ORIGIN              shared with the other four functions
//   APP_WORKSPACES              optional, comma list; default devoted_care
//
// Changing the PIN — every open tab is locked out on its next request:
//   npx supabase secrets set APP_PIN=<new pin> --project-ref gdzgoyawavffjdjpjbfz
//
// DEPLOYED WITH JWT VERIFICATION ON, unlike the other four functions. The
// browser sends the anon key as its bearer token, so the gateway turns away
// anything that does not even carry that before a PIN is looked at:
//   npx supabase functions deploy app-gate --project-ref gdzgoyawavffjdjpjbfz
// (no --no-verify-jwt). A COMMIT DOES NOT DEPLOY THIS FILE.

import { createClient } from "jsr:@supabase/supabase-js@2";

const DB_URL = (Deno.env.get("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
const DB_KEY = (Deno.env.get("DB_SECRET_KEY") ?? "").trim() ||
  (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
/* Closed by default, unlike the other four functions: with ALLOWED_ORIGIN
   unset, no other website may read this function's answers from a visitor's
   browser. A gate fails closed. */
const ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const TABLE = "scheduler_state";
/* The workspace row(s) a caller may name. `__probe` is always allowed: it is
   the throwaway row the deploy checks write to, so they never touch the desk's
   real row. Nothing in the app uses it. */
const WORKSPACES = new Set(
  [...(Deno.env.get("APP_WORKSPACES") || "devoted_care").split(","), "__probe"]
    .map((s) => s.trim()).filter(Boolean),
);

const MAX_FAILS = 8;                 // distinct wrong PINs per IP per window
const WINDOW_S = 15 * 60;
const LOCK_S = 15 * 60;
const FAIL_DELAY_MS = 500;

/* The live overlay is ~1.4 MB. Well under this; the cap only stops a caller
   making the function parse something absurd. */
const MAX_BODY = 12 * 1024 * 1024;
/* A stored photo is a JPEG of at most 512px on its longest edge — about 60 KB
   typically, a few hundred at worst. */
const MAX_PHOTO = 2 * 1024 * 1024;

// --- CORS (same shape as devi-agent, quo, care-brief and comms-summary) -------
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
    /* authorization + apikey carry the anon JWT the gateway checks. */
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    /* Content-Range carries PostgREST's row counts. Nothing reads it today,
       but a relay that hid it would break the first caller that does. */
    "access-control-expose-headers": "content-range, x-gate",
    "access-control-max-age": "86400",
    ...(allowAll ? {} : { vary: "Origin" }),
  };
}

// --- small helpers -------------------------------------------------------------
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let hmacKey: CryptoKey | null = null;
async function hmacHex(s: string): Promise<string> {
  if (!hmacKey) {
    /* Keyed with the service key: stable across requests, never sent to a
       browser, so a stored hash of a wrong PIN says nothing about the PIN. */
    hmacKey = await crypto.subtle.importKey("raw", enc.encode("app-gate:" + DB_KEY),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, enc.encode(s)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}
/* Compares every character whatever happens. Both sides are HMACs of the same
   length, so timing says nothing about how much of the PIN was right — nor how
   long it is. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/* Does this overlay hold ANY record? adds/dels are arrays per slice, patches
   and maps are objects per slice, scalars is one flat object. v, updatedAt and
   updatedBy are bookkeeping and say nothing about records. */
function hasRecords(o: unknown): boolean {
  if (!isObj(o)) return false;
  for (const kind of ["adds", "dels", "patches", "maps"]) {
    const g = o[kind];
    if (!isObj(g)) continue;
    for (const k of Object.keys(g)) {
      const v = g[k];
      if (Array.isArray(v) ? v.length > 0 : (isObj(v) && Object.keys(v).length > 0)) return true;
    }
  }
  return isObj(o.scalars) && Object.keys(o.scalars).length > 0;
}

// --- the relay allowlist ---------------------------------------------------------
//
// One entry per table index.html reaches, and per method it uses. A method is
// either `true` (no body) or the exact set of columns a body may carry; a body
// with any other key is refused. This is TIGHTER than the anon policies it
// replaces, on purpose: those allowed insert/update/delete of any column on
// caregiver_profile, for example, while the app only ever writes
// employment_status (see CLAUDE.md, "caregiver_profile is read-only").
//
// When index.html gains a new Supabase request, it has to be added here too,
// or it fails with 400 not_allowed. That is the point.
type Rule = true | string[];
const ALLOW: Record<string, Partial<Record<"GET" | "POST" | "PATCH" | "DELETE", Rule>>> = {
  caregiver_profile: {
    GET: true,
    PATCH: ["employment_status", "updated_by"],                   // saveEmploymentStatus
    POST: ["caregiver_id", "employment_status", "updated_by"],   // its new-hire upsert
  },
  care_notes: { GET: true },
  /* READ ONLY, deliberately. These are AI summaries of clinical shift notes,
     written only by carenotes-summary with the service key; nothing in the
     browser may create or change one. The table has RLS on with no policies,
     which the anon key cannot get past -- this relay uses the service key, so
     GET works without touching the SQL. Added for Ask Devi, 2026-09-23. */
  care_note_summaries: { GET: true },
  open_shifts: { GET: true },
  open_shifts_sync: { GET: true },
  client_match_prefs: { GET: true },
  client_caregiver_match: { GET: true },
  caregiver_availability: {
    GET: true,
    PATCH: ["note"],                                             // AVNOTECLEAN; only {note:null}
  },
  caregiver_day_notes: {
    GET: true,
    POST: ["caregiver_id", "on_date", "note", "updated_by"],     // NOTES.save upsert
    DELETE: true,                                                // NOTES.save, empty text
  },
  "rpc/set_availability_days": {
    POST: ["p_caregiver_id", "p_dates", "p_segments", "p_updated_by"],
  },
};
/* Query parameters that shape a result rather than filter rows. Anything else
   is a filter, and a PATCH or DELETE must carry at least one: an unfiltered
   one would touch every row in the table. */
const SHAPING = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
/* Prefer tokens a request may carry through. Everything else is dropped. */
const PREFER_OK = /^(return=(representation|minimal)|resolution=(merge-duplicates|ignore-duplicates)|count=(exact|planned|estimated)|missing=default)$/;

type Relay = { ok: true; table: string; query: string; method: string; body: unknown; prefer: string } |
  { ok: false; why: string };

function checkRelay(p: Record<string, unknown>): Relay {
  const method = String(p.method || "GET").toUpperCase();
  const raw = String(p.path || "");
  const q = raw.indexOf("?");
  const table = q < 0 ? raw : raw.slice(0, q);
  const query = q < 0 ? "" : raw.slice(q + 1);
  const rules = Object.prototype.hasOwnProperty.call(ALLOW, table) ? ALLOW[table] : null;
  if (!rules) return { ok: false, why: "table not allowed: " + table };
  const rule = rules[method as keyof typeof rules];
  if (!rule) return { ok: false, why: method + " not allowed on " + table };
  if (/[#\s]/.test(query)) return { ok: false, why: "malformed query" };

  let params: URLSearchParams;
  try { params = new URLSearchParams(query); } catch { return { ok: false, why: "malformed query" }; }
  let filters = 0;
  for (const [k, v] of params) {
    /* No resource embedding: `select=*,other_table(*)` would reach tables
       outside this list through a foreign key, with the service key's rights. */
    if (k === "select" && /[()]/.test(v)) return { ok: false, why: "embedded select not allowed" };
    if (!SHAPING.has(k)) filters++;
  }
  if ((method === "PATCH" || method === "DELETE") && filters === 0) {
    return { ok: false, why: method + " without a filter would touch every row" };
  }

  const body = p.body;
  if (rule === true) {
    if (body !== undefined && body !== null) return { ok: false, why: method + " on " + table + " takes no body" };
  } else {
    const rows = Array.isArray(body) ? body : [body];
    if (!rows.length || rows.length > 2000) return { ok: false, why: "bad body" };
    for (const r of rows) {
      if (!isObj(r)) return { ok: false, why: "bad body" };
      for (const k of Object.keys(r)) {
        if (!rule.includes(k)) return { ok: false, why: "column not allowed: " + table + "." + k };
      }
    }
    /* AVNOTECLEAN's PATCH exists only to CLEAR notes. A relay that let any
       value through would be a free-text write to every matching row. */
    if (table === "caregiver_availability" && method === "PATCH") {
      if (Array.isArray(body) || !isObj(body) || Object.keys(body).length !== 1 || body.note !== null) {
        return { ok: false, why: "only {note:null} may be written here" };
      }
    }
  }

  const prefer = String(p.prefer || "").split(",").map((s) => s.trim()).filter((s) => PREFER_OK.test(s)).join(",");
  return { ok: true, table, query, method, body, prefer };
}

// --- the handler ---------------------------------------------------------------
Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get("origin") ?? "");
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, ...extra, "content-type": "application/json", "cache-control": "no-store", "x-gate": "app-gate" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  /* Read per request, not at start-up: the value a request is checked against
     is always the secret as it stands now. (`secrets set` restarts the
     function anyway; this just means nothing here could ever hold an old one.) */
  const PIN = Deno.env.get("APP_PIN") ?? "";
  /* Fail closed: no PIN configured refuses everyone, rather than admitting them. */
  if (!PIN) return json({ error: "not_configured" }, 503);
  if (!DB_URL || !DB_KEY) return json({ error: "no_database_key" }, 503);

  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) return json({ error: "too_large" }, 413);

  const db = createClient(DB_URL, DB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  /* WHICH IP. Measured on this project 2026-09-18 with a throwaway echo
     function: the edge (Cloudflare) sets cf-connecting-ip to the caller's real
     address, REPLACES a caller-supplied X-Forwarded-For (a forged
     "203.0.113.7, 198.51.100.9" arrived as the real address) and refuses a
     request that tries to forge cf-connecting-ip itself (error 1000).
     `Forwarded` passes through untouched, so it is caller-written and never
     read here.

     A request that arrives WITHOUT cf-connecting-ip did not come through that
     edge, and on such a path X-Forwarded-For is whatever the caller wrote.
     Keying on it there would let a caller mint a fresh throttle bucket per
     request, or forge the office's address and lock the desk out. So every
     such request shares ONE bucket instead: it is throttled all the same and
     cannot touch anybody else's. (The other four functions' comments say
     X-Forwarded-For is caller-written; on the Cloudflare path it is not.) */
  const ip = (req.headers.get("cf-connecting-ip") ?? "").trim() || "no-edge-ip";
  const now = Date.now();

  let body: Record<string, unknown>;
  try {
    const b = await req.json();
    if (!isObj(b)) return json({ error: "bad_json" }, 400);
    body = b;
  } catch { return json({ error: "bad_json" }, 400); }

  /* THE PIN CHECK, and the throttle, in ONE atomic call.

     The comparison happens here (in constant time, on HMACs), but the VERDICT
     comes from gate_check(), which holds the IP's row lock while it decides.
     So every request from one IP is answered in turn: once 8 distinct wrong
     PINs are on record, everything after them gets "locked" - a right PIN
     included, so a locked caller learns nothing. An earlier version read the
     lock and recorded the failure as two separate calls, and a burst of
     simultaneous guesses all passed the read before the 8th failure landed.

     If the throttle cannot be reached this fails CLOSED: an unreadable
     throttle is an unthrottled one. */
  const given = typeof body.pin === "string" ? body.pin : "";
  const givenMac = await hmacHex(given);
  const right = !!given && same(givenMac, await hmacHex(PIN));
  const { data: tdata, error: terr } = await db.rpc("gate_check", {
    p_ip: ip, p_key: givenMac, p_ok: right, p_max: MAX_FAILS, p_window_s: WINDOW_S, p_lock_s: LOCK_S,
  });
  if (terr) {
    console.error("[app-gate] throttle unavailable", terr.message);
    return json({ error: "throttle_unavailable" }, 503);
  }
  const verdict = (Array.isArray(tdata) ? tdata[0] : tdata) as { verdict: string; fails: number; locked_until: string | null } | null;
  if (!verdict) return json({ error: "throttle_unavailable" }, 503);
  if (verdict.verdict === "locked") {
    const until = verdict.locked_until ? Date.parse(verdict.locked_until) : now + LOCK_S * 1000;
    return json({ error: "locked", retry_after: Math.max(1, Math.ceil((until - now) / 1000)) }, 429);
  }
  if (verdict.verdict !== "ok") {
    await sleep(FAIL_DELAY_MS);
    return json({ error: "bad_pin", attempts_left: Math.max(0, MAX_FAILS - Number(verdict.fails || 0)) }, 401);
  }
  /* A right PIN does NOT clear the IP's earlier failures, which the reference
     did: the desk polls every 20 seconds from one office IP, so clearing on
     success would reset the count for anybody else on that network three
     times a minute. Failures age out with their window. To clear a lockout
     by hand:   delete from public.auth_throttle;                           */

  const action = body.action == null ? "" : String(body.action);

  // No action: the PIN was right, which is all the lock screen needs to know.
  if (!action) return json({ ok: true });

  // ── scheduler_state ─────────────────────────────────────────────────────────
  if (action.startsWith("state.")) {
    const ws = String(body.workspace || "");
    if (!WORKSPACES.has(ws)) return json({ error: "unknown_workspace" }, 400);
    /* config.js still carries a `table` setting. This function only ever
       reaches scheduler_state, so a build configured for another table must
       be told so rather than silently using the desk's real row. */
    if (body.table != null && body.table !== TABLE) return json({ error: "unknown_table" }, 400);

    if (action === "state.head") {
      const { data, error } = await db.from(TABLE).select("rev").eq("id", ws).maybeSingle();
      if (error) return json({ error: "read_failed", message: error.message }, 502);
      return json({ ok: true, row: data ?? null });
    }

    if (action === "state.load") {
      const { data, error } = await db.from(TABLE).select("overlay,rev,updated_by").eq("id", ws).maybeSingle();
      if (error) return json({ error: "read_failed", message: error.message }, 502);
      return json({ ok: true, row: data ?? null });
    }

    if (action === "state.create") {
      const overlay = body.overlay;
      if (!isObj(overlay)) return json({ error: "no_data" }, 400);
      const { error } = await db.from(TABLE).insert({
        id: ws, overlay, rev: 1, updated_at: new Date().toISOString(),
        updated_by: body.updated_by == null ? null : String(body.updated_by),
      });
      if (error) {
        if (error.code === "23505") return json({ error: "conflict" }, 409);
        return json({ error: "write_failed", message: error.message }, 502);
      }
      return json({ ok: true, rev: 1 });
    }

    if (action === "state.save") {
      const overlay = body.overlay;
      if (!isObj(overlay)) return json({ error: "no_data" }, 400);
      const force = body.force === true;
      const by = body.updated_by == null ? null : String(body.updated_by);

      /* THE GUARD AGAINST AN EMPTY COPY OVERWRITING A FULL ONE — the failure
         this whole function exists for. Only paid for when the incoming copy
         is empty, so an ordinary save never re-reads the 1.4 MB row. */
      if (!force && !hasRecords(overlay)) {
        const { data, error } = await db.from(TABLE).select("overlay,rev").eq("id", ws).maybeSingle();
        if (error) return json({ error: "read_failed", message: error.message }, 502);
        /* THE REV FIRST. A tab that has not read the board yet (a fresh
           browser, first save 900 ms after boot) sends an empty overlay on
           rev 0. That was always a harmless conflict - the browser pulls,
           merges and saves again - and it must stay one: 422 is for a copy
           that IS current and would really wipe the board. */
        if (data && Number(data.rev) !== Number(body.rev)) return json({ error: "conflict" }, 409);
        if (data && hasRecords(data.overlay)) {
          console.warn("[app-gate] refused an empty overlay over a full one", { ws, ip, by });
          return json({
            error: "empty_refused",
            message: "Refused: this copy holds no records and the shared board does. Nothing was overwritten.",
          }, 422);
        }
      }

      if (!force) {
        /* Compare-and-swap, exactly as the browser always did it: the save
           names the rev it was editing, and only lands if the row is still
           there. The new rev is computed here, not taken from the caller. */
        const rev = Number(body.rev);
        if (!Number.isInteger(rev) || rev < 0) return json({ error: "bad_rev" }, 400);
        const { data, error } = await db.from(TABLE)
          .update({ overlay, rev: rev + 1, updated_at: new Date().toISOString(), updated_by: by })
          .eq("id", ws).eq("rev", rev).select("rev");
        if (error) return json({ error: "write_failed", message: error.message }, 502);
        if (!data || !data.length) return json({ error: "conflict" }, 409);
        return json({ ok: true, rev: data[0].rev });
      }

      /* force: the deliberate "clear all data" (CLOUD.reset). No empty-copy
         guard and no rev from the caller — but still a compare-and-swap on
         the rev as it stands, so the rev only ever moves forward and every
         open tab sees the change on its next poll. */
      for (let attempt = 0; attempt < 4; attempt++) {
        const cur = await db.from(TABLE).select("rev").eq("id", ws).maybeSingle();
        if (cur.error) return json({ error: "read_failed", message: cur.error.message }, 502);
        if (!cur.data) return json({ error: "no_row" }, 404);
        const rev = Number(cur.data.rev);
        const { data, error } = await db.from(TABLE)
          .update({ overlay, rev: rev + 1, updated_at: new Date().toISOString(), updated_by: by })
          .eq("id", ws).eq("rev", rev).select("rev");
        if (error) return json({ error: "write_failed", message: error.message }, 502);
        if (data && data.length) {
          console.warn("[app-gate] forced overwrite of scheduler_state", { ws, ip, by, rev: data[0].rev });
          return json({ ok: true, rev: data[0].rev });
        }
      }
      return json({ error: "conflict" }, 409);
    }

    return json({ error: "unknown_action" }, 400);
  }

  // ── the allowlisted PostgREST relay ────────────────────────────────────────
  if (action === "rest") {
    const r = checkRelay(body);
    if (!r.ok) {
      console.warn("[app-gate] relay refused", r.why);
      return json({ error: "not_allowed", message: r.why }, 400);
    }
    const headers: Record<string, string> = {
      apikey: DB_KEY, authorization: "Bearer " + DB_KEY, accept: "application/json",
    };
    if (r.prefer) headers.prefer = r.prefer;
    const init: RequestInit = { method: r.method, headers };
    if (r.body !== undefined && r.body !== null) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(r.body);
    }
    let up: Response;
    try {
      up = await fetch(DB_URL + "/rest/v1/" + r.table + (r.query ? "?" + r.query : ""), init);
    } catch (e) {
      return json({ error: "upstream_unreachable", message: String((e as Error)?.message || e) }, 502);
    }
    const text = await up.text();
    if (up.status === 401 || up.status === 403) {
      console.error("[app-gate] upstream refused the service key", up.status, text.slice(0, 200));
      return json({ error: "upstream_denied", upstream_status: up.status }, 502);
    }
    /* 429 from THIS function means the PIN throttle; the browser locks on
       it. A busy database is not that. */
    if (up.status === 429) return json({ error: "upstream_busy", upstream_status: 429 }, 503);
    const out: Record<string, string> = { ...cors, "cache-control": "no-store", "x-gate": "rest" };
    const ct = up.headers.get("content-type"); if (ct) out["content-type"] = ct;
    const cr = up.headers.get("content-range"); if (cr) out["content-range"] = cr;
    /* A 204 or 304 may not carry a body; everything else passes through
       byte for byte, so the browser's existing `r.ok` / `r.json()` /
       `r.status === 404` handling reads exactly what it always read. */
    return new Response(up.status === 204 || up.status === 304 ? null : text, { status: up.status, headers: out });
  }

  // ── caregiver photos ────────────────────────────────────────────────────────
  if (action === "photo.put" || action === "photo.del") {
    /* The object key is the bare AxisCare numeric id — see CLAUDE.md,
       "Uploading and removing a photo", rule 1. */
    const key = String(body.key ?? "");
    if (!/^\d{1,12}$/.test(key)) return json({ error: "bad_key" }, 400);
    const url = DB_URL + "/storage/v1/object/caregiver-photos/" + key;
    const auth = { apikey: DB_KEY, authorization: "Bearer " + DB_KEY };
    let up: Response;
    if (action === "photo.put") {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        const bin = atob(String(body.data ?? ""));
        bytes = new Uint8Array(new ArrayBuffer(bin.length));
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch { return json({ error: "bad_data" }, 400); }
      if (!bytes.length || bytes.length > MAX_PHOTO) return json({ error: "bad_size" }, 400);
      /* Always a JPEG (CLAUDE.md, rule 4). Checked on the BYTES, not on a
         content-type the caller asserts. */
      if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return json({ error: "not_jpeg" }, 400);
      try {
        up = await fetch(url, {
          method: "POST",
          /* max-age=60, not a bare 60 — see the comment in CGPHOTO.upload. */
          headers: { ...auth, "content-type": "image/jpeg", "x-upsert": "true", "cache-control": "max-age=60" },
          body: bytes,
        });
      } catch (e) { return json({ error: "upstream_unreachable", message: String((e as Error)?.message || e) }, 502); }
    } else {
      try { up = await fetch(url, { method: "DELETE", headers: auth }); }
      catch (e) { return json({ error: "upstream_unreachable", message: String((e as Error)?.message || e) }, 502); }
    }
    const text = await up.text();
    /* Storage reports some refusals as 400 with the real 403 in the body;
       those pass through, because the browser reads the body to tell a
       not-found from a refusal. Only a bare 401/403 is remapped. */
    if (up.status === 401 || up.status === 403) {
      console.error("[app-gate] storage refused the service key", up.status, text.slice(0, 200));
      return json({ error: "upstream_denied", upstream_status: up.status }, 502);
    }
    if (up.status === 429) return json({ error: "upstream_busy", upstream_status: 429 }, 503);
    return new Response(text, {
      status: up.status,
      headers: { ...cors, "content-type": up.headers.get("content-type") || "application/json", "cache-control": "no-store", "x-gate": "photo" },
    });
  }

  return json({ error: "unknown_action" }, 400);
});
