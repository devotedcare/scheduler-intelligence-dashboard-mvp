/* ============================================================================
   OPEN SHIFTS — AxisCare → Supabase mirror
   ============================================================================

   WHY THIS EXISTS

   An open shift is DERIVED, never fetched. AxisCare has no "open shift"
   endpoint; the rule is

       not removed  +  no caregiver  +  scheduled in the FUTURE

   and applying it means scanning every visit in the window. Measured against
   the live account on 2026-09-03:

       window     today → end of next month   (58 days)
       requests   14, SEQUENTIAL — AxisCare pages on nextPageToken, so each
                  page waits for the one before it
       scanned    1,321 visits
       found      12 open shifts
       elapsed    9.1s

   Fourteen requests and thirteen hundred visits, on every page load, in every
   session, to produce twelve rows — and it was the slowest of the five boot
   calls, so the whole dashboard waited for it. This function runs the same
   rule on a schedule and writes the answer to public.open_shifts, which the
   dashboard reads in one query.

   AxisCare remains the system of record. This table is a cache with a
   timestamp on it, and the timestamp is shown to the desk.

   ----------------------------------------------------------------------------
   THE DELETION RULE, which is the whole design

   A shift leaves this table for two different reasons, and they are NOT
   equally safe:

     EVIDENCE   we looked at that visit and it now has a caregiver, or is
                removed, or is in the past. Safe on ANY run, complete or not.
     ABSENCE    we did not see it in the results at all. Safe ONLY after a
                run that scanned the WHOLE window.

   Absence is the dangerous one. A run that dies half way, or hits the page
   cap, or gets a 429 on page 9, has not observed the back half of the window
   — and deleting on that would empty the coverage board with no error
   anywhere. So `sweep` runs only when `complete` is true.

   This is why last_ok_at exists separately from last_run_at, and why the
   dashboard ages out on last_ok_at rather than the more flattering one.

   ----------------------------------------------------------------------------
   STALE-WHILE-REVALIDATE

   The dashboard reads the mirror and then POSTs here without awaiting the
   answer. So AxisCare load follows real usage: a quiet weekend costs nothing,
   a busy desk keeps the mirror sharp. A fixed 5-minute cron would burn ~4,000
   AxisCare requests a day whether or not anyone was working.

   That only works with a LOCK. Three schedulers opening at 9am would
   otherwise fire three concurrent scans, 14 requests each, and CLAUDE.md
   records the Client Concierge dashboard collecting 429s learning exactly
   this. So a trigger is refused when:

     - a run is already in flight (running_at set, and recent), or
     - the last run finished less than MIN_GAP_MS ago

   A cron entry in netlify.toml keeps a floor under it, so the first person in
   each morning is not the one who eats the staleness.

   ----------------------------------------------------------------------------
   ENVIRONMENT — all five already exist in Netlify for the other three syncs.
   No new secret is needed.

       AXISCARE_SITE_URL
       AXISCARE_API_TOKEN
       AXISCARE_API_VERSION
       SUPABASE_URL
       SUPABASE_SERVICE_ROLE_KEY     writes bypass RLS; anon can only read

   MANUAL USE

       /.netlify/functions/openshifts-sync            respects the debounce
       /.netlify/functions/openshifts-sync?force=1    ignore the debounce
       /.netlify/functions/openshifts-sync?maxMs=60000    longer budget (local)

   Returns { ok, complete, open, scanned, requests, deleted, ms, window }.
   ========================================================================= */

'use strict';

/* Netlify's default function timeout is 10s on the entry plan and the care
   notes sweep already assumes it. Stop at 8s and report `complete:false`
   rather than being killed mid-write with the lock still held. A hand-run
   with ?maxMs= can have longer; the local dev server has no timeout. */
const SOFT_DEADLINE_MS = 8000;
const MAX_MS_CAP       = 600000;

/* The read path treats the mirror as cold past this and falls back to the
   live scan, so the trigger has to be able to refresh well inside it. */
const MIN_GAP_MS   = 90 * 1000;      /* debounce: ignore triggers this close together */
const LOCK_STALE_MS = 5 * 60 * 1000; /* a held lock older than this is a dead run */

/* AxisCare pages sequentially. 14 requests covers the current window with
   room; past this we stop and report the run incomplete rather than looping. */
const MAX_PAGES = 40;
const PAGE_LIMIT = 200;

const env = (n, d) => (process.env[n] != null && process.env[n] !== '' ? process.env[n] : d);

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/* Never let the AxisCare token reach a response body or the status column. */
function redact(s) {
  const t = env('AXISCARE_API_TOKEN', '');
  let out = String(s == null ? '' : s);
  if (t) out = out.split(t).join('[REDACTED]');
  return out.length > 300 ? out.slice(0, 300) + '…' : out;
}

/* ---------- AxisCare ------------------------------------------------------ */

function axisHeaders() {
  return {
    Authorization: 'Bearer ' + env('AXISCARE_API_TOKEN', ''),
    /* Required on every request. A wrong version returns 400 BEFORE auth is
       checked, which masks a bad token entirely — rule it out first. */
    'X-AxisCare-Api-Version': env('AXISCARE_API_VERSION', ''),
    accept: 'application/json',
  };
}

async function axisGet(path, params) {
  const base = env('AXISCARE_SITE_URL', '').replace(/\/+$/, '');
  const u = new URL(base + path);
  Object.keys(params || {}).forEach(k => {
    if (params[k] != null) u.searchParams.set(k, params[k]);
  });
  /* A hung socket would otherwise hold running_at until LOCK_STALE_MS and
     block every trigger in between. carenotes-sync guards the same way. */
  const r = await fetch(u.toString(), { headers: axisHeaders(), signal: AbortSignal.timeout(15000) });
  if (r.status === 404) return { results: { visits: [] } };   /* "No visits found" is empty, not an error */
  if (!r.ok) throw new Error('AxisCare HTTP ' + r.status + ' ' + redact(await r.text()));
  return r.json();
}

/* ---------- Supabase ------------------------------------------------------ */

function sbHeaders(extra) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY', '');
  return Object.assign({
    apikey: key,
    Authorization: 'Bearer ' + key,
    'content-type': 'application/json',
  }, extra || {});
}

function sbUrl(path) {
  return env('SUPABASE_URL', '').replace(/\/+$/, '') + '/rest/v1' + path;
}

async function sbFetch(path, init) {
  const r = await fetch(sbUrl(path), Object.assign({ signal: AbortSignal.timeout(15000) }, init));
  if (!r.ok) throw new Error('Supabase HTTP ' + r.status + ' ' + redact(await r.text()));
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

const readSync = () =>
  sbFetch('/open_shifts_sync?id=eq.openshifts&select=*', { headers: sbHeaders() })
    .then(rows => (rows && rows[0]) || null);

const patchSync = patch =>
  sbFetch('/open_shifts_sync?id=eq.openshifts', {
    method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch),
  });

const upsertShifts = rows =>
  rows.length
    ? sbFetch('/open_shifts?on_conflict=visit_id', {
        method: 'POST',
        headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(rows),
      })
    : Promise.resolve(null);

/* ---------- the rule ------------------------------------------------------ */

const ymd = d => {
  /* LOCAL date parts, not toISOString(). The window is expressed in the wall
     dates a scheduler thinks in, and a UTC slice rolls over at 5pm Pacific. */
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

/* The leading YYYY-MM-DD of the AxisCare stamp, taken TEXTUALLY.
   '2026-09-03T20:00:00-07:00' is the 3rd where the visit happens; parsing it
   and formatting in UTC makes it the 4th. */
const wallDate = s => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s || ''));
  return m ? m[1] : null;
};

/* The identical rule AxisLive.fetchOpenShifts applies in the browser:
   not removed + no caregiver + scheduled in the future. */
function isOpen(v, now) {
  if (!v || v.removed) return false;
  if (v.caregiver && v.caregiver.id != null) return false;
  if (!v.client || v.client.id == null) return false;
  const startsRaw = v.scheduledStartDate || v.startDate;
  if (!startsRaw) return false;
  return new Date(startsRaw) > now;
}

function toRow(v, stamp) {
  const startsRaw = v.scheduledStartDate || v.startDate;
  const endsRaw = v.scheduledEndDate || v.endDate || null;
  return {
    visit_id: v.id,
    shift_date: wallDate(startsRaw),
    client_id: v.client.id,
    starts_at: startsRaw,
    ends_at: endsRaw,
    service: (v.service && v.service.description) || null,
    synced_at: stamp,
  };
}

/* ---------- handler ------------------------------------------------------- */

exports.handler = async function (event) {
  const t0 = Date.now();
  const qs = (event && event.queryStringParameters) || {};
  const force = qs.force === '1' || qs.force === 'true';

  let budget = Number(qs.maxMs);
  if (!Number.isFinite(budget) || budget < 1000) budget = SOFT_DEADLINE_MS;
  budget = Math.min(budget, MAX_MS_CAP);
  const outOfTime = () => Date.now() - t0 > budget;

  const missing = ['AXISCARE_SITE_URL', 'AXISCARE_API_TOKEN', 'AXISCARE_API_VERSION',
                   'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter(n => !env(n, ''));
  if (missing.length) return json(503, { ok: false, error: 'not configured', missing });

  /* ---- the lock and the debounce -------------------------------------- */
  let state = null;
  try { state = await readSync(); }
  catch (e) { return json(502, { ok: false, error: redact(e.message) }); }

  const now = new Date();
  if (!force && state) {
    const running = state.running_at ? new Date(state.running_at) : null;
    if (running && now - running < LOCK_STALE_MS)
      return json(200, { ok: true, skipped: 'a run is already in flight', since: state.running_at });

    const last = state.last_run_at ? new Date(state.last_run_at) : null;
    if (last && now - last < MIN_GAP_MS)
      return json(200, { ok: true, skipped: 'synced recently', lastRunAt: state.last_run_at,
                         agoMs: now - last });
  }

  const stamp = now.toISOString();
  await patchSync({ running_at: stamp });

  /* ---- the scan -------------------------------------------------------- */
  /* Today through the END OF NEXT MONTH — the same window the browser used,
     so a scheduler filling next month's gaps sees all of them. */
  const from = ymd(now);
  const to = ymd(new Date(now.getFullYear(), now.getMonth() + 2, 0));

  let requests = 0, scanned = 0, complete = false, failure = null;
  const open = [];

  try {
    let token = null;
    for (;;) {
      const params = { startDate: from, endDate: to, limit: PAGE_LIMIT };
      if (token) params.nextPageToken = token;
      const res = await axisGet('/api/visits', params);
      requests++;
      const results = (res && res.results) || {};
      const list = results.visits || [];
      scanned += list.length;
      list.forEach(v => { if (isOpen(v, now)) open.push(toRow(v, stamp)); });

      const next = results.nextPage;
      if (!next) { complete = true; break; }
      const m = /[?&]nextPageToken=([^&]+)/.exec(String(next));
      if (!m) { failure = 'could not read the nextPage cursor'; break; }
      token = decodeURIComponent(m[1]);

      if (requests >= MAX_PAGES) { failure = 'stopped at the page cap (' + MAX_PAGES + ')'; break; }
      if (outOfTime()) { failure = 'ran out of time after ' + requests + ' requests'; break; }
    }
  } catch (e) {
    failure = redact(e.message);
  }

  /* ---- write ------------------------------------------------------------ */
  let deleted = 0;
  try {
    /* Upsert first, always. Even a partial scan learned something true, and
       an open shift appearing a run early is harmless. */
    for (let i = 0; i < open.length; i += 500) await upsertShifts(open.slice(i, i + 500));

    /* Sweep ONLY after a complete scan. Absence is evidence of nothing when
       we did not look at the whole window — see the deletion rule above. */
    if (complete) {
      const gone = await sbFetch(
        '/open_shifts?synced_at=lt.' + encodeURIComponent(stamp) + '&select=visit_id',
        { headers: sbHeaders({ Prefer: 'return=representation' }), method: 'DELETE' });
      deleted = Array.isArray(gone) ? gone.length : 0;
    }
  } catch (e) {
    failure = failure || redact(e.message);
  }

  const ms = Date.now() - t0;
  const status = failure ? (complete ? 'error: ' : 'partial: ') + failure : 'ok';
  const patch = {
    running_at: null,
    last_run_at: stamp,
    last_status: status,
    window_from: from,
    window_to: to,
    scanned: scanned,
    shifts_open: open.length,
  };
  /* last_ok_at is the freshness contract and only a WHOLE window earns it. */
  if (complete && !failure) patch.last_ok_at = stamp;
  try { await patchSync(patch); } catch (e) { /* the scan still happened */ }

  return json(failure && !complete ? 502 : 200, {
    ok: !failure, complete, open: open.length, scanned, requests, deleted, ms,
    window: { from, to }, status,
  });
};
