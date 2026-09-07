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
   notes sweep already assumes it. Stop early and report `complete:false`
   rather than being killed mid-write with the lock still held. A hand-run
   with ?maxMs= can have longer; the local dev server has no timeout.

   6000, NOT 8000. The deadline is checked BETWEEN chunks, so the real stop
   is always one chunk late and the budget is a floor, not a ceiling: the
   true worst case is budget + the largest chunk, and then the upsert and the
   two heartbeat writes on top. Measured 2026-09-03 against live AxisCare
   with the handler running for real:

     budget 8000  ->  runs of 6,797ms and 9,941ms.  That second one is over
                      10s once the upsert and two heartbeat writes land -
                      exactly the death this constant exists to avoid, and a
                      run killed there strands running_at until
                      LOCK_STALE_MS without ever advancing the cursor.
     budget 6000  ->  runs of 7,119ms and 7,898ms.  Inside 10s with room.

   The cost is one more run per pass: 2-3 rather than 2, depending on how
   AxisCare is answering that minute (600-800ms per request, and it moved
   that much between two measurements ten minutes apart). At the quiet-period
   cadence - the ten-minute cron - that is a completed pass every 20-30 min.
   last_ok_at is the pass START stamp, so its peak age is two passes' worth,
   ~50 min - inside MIRROR_COLD_MS, which moved to 90 min for exactly this
   reason. When anyone is actually using the app the MIN_GAP_MS debounce sets
   the pace instead and it is minutes.

   Do not go lower to buy more headroom. 4000 needs four runs, i.e. 40
   minutes at the quiet cadence, which puts the peak age of last_ok_at at ~80
   min - still inside 90, but with almost nothing spare, and any slower
   AxisCare ages it out. At that point every browser falls back to the 9.6s
   live scan. Correct, but it throws away the entire point of the mirror. */
const SOFT_DEADLINE_MS = 6000;

/* The soft deadline may only stop a run that has advanced the cursor, or a
   slow AxisCare could spend the whole budget on the near re-read, make no
   progress, and leave the pass unable to finish. But that guard also means a
   resumed run has NO upper bound until it has read chunk 0 AND one full
   cursor chunk - a floor of ~5.9s today that grows with AxisCare latency and
   is completely independent of SOFT_DEADLINE_MS. At 2x latency that floor is
   ~11.8s: killed by the platform, with running_at stranded until
   LOCK_STALE_MS and the cursor never advanced.

   So there is a second, HARD ceiling that fires whether or not the run made
   progress. If AxisCare is slow enough that even one chunk cannot fit inside
   it, the pass genuinely cannot complete and the right outcome is exactly
   what happens: last_ok_at stops advancing, the mirror ages out, and every
   browser falls back to the live scan. Slow and correct, and it self-heals. */
const HARD_DEADLINE_MS = 9000;
const MAX_MS_CAP       = 600000;

/* A FULL SCAN DOES NOT FIT IN ONE INVOCATION, so a pass spans runs.

   Measured 2026-09-03: the window is 58 days, 16 sequential requests, 1,323
   visits and 9,622ms. Against the budget it stops short EVERY time and
   reports `partial`. Nothing swept, last_ok_at never advanced, and after
   MIRROR_COLD_MS the dashboard's read path fell back to the live scan
   permanently — the mirror would have been built and then silently never
   used. Caught 2026-09-03 when the desk asked why a filled shift was still
   being offered.

   So the window is cut into date chunks and the pass carries a cursor,
   the same shape carenotes-sync uses. Chunks rather than an AxisCare
   nextPageToken: nothing here has verified that a token survives the gap
   between two invocations, while a date range is durable by construction
   and costs one cheap re-request if a run dies mid-chunk.

   The pass STAMP is held across runs too. Sweeping on a per-run stamp
   would delete everything the previous run had just written. */
const CHUNK_DAYS = 14;

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

/* HOW MANY ARE OPEN, asked of the TABLE rather than of this run.

   A pass spans several invocations, so `open.length` is only what THIS run
   happened to see: a resumed run that finishes the last chunk might have
   found none in it and would have written shifts_open:0 while the table
   held eight. The browser reads this column, so it has to describe the
   mirror, not the slice of it one invocation looked at. */
async function countOpen() {
  const base = env('SUPABASE_URL', '').replace(/\/+$/, '');
  const r = await fetch(base + '/rest/v1/open_shifts?select=visit_id',
    { headers: sbHeaders({ Prefer: 'count=exact', Range: '0-0' }),
      signal: AbortSignal.timeout(15000) });
  const cr = r.headers.get('content-range') || '';   /* e.g. "0-0/8" */
  const m = /\/(\d+)\s*$/.exec(cr);
  return m ? +m[1] : null;
}

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

  /* ---- the window, and where in it this pass has got to --------------- */
  /* Today through the END OF NEXT MONTH — the same window the browser used,
     so a scheduler filling next month's gaps sees all of them. */
  const from = ymd(now);
  const to = ymd(new Date(now.getFullYear(), now.getMonth() + 2, 0));

  /* Chunk boundaries, recomputed identically every run so a cursor saved by
     one invocation still means the same thing to the next. */
  const chunks = [];
  for (let d = new Date(from + 'T12:00:00'); ymd(d) <= to;) {
    const a = ymd(d);
    d.setDate(d.getDate() + CHUNK_DAYS - 1);
    const b = ymd(d) > to ? to : ymd(d);
    chunks.push([a, b]);
    d.setDate(d.getDate() + 1);
  }

  /* Resume where the last run stopped, and keep ITS stamp: the sweep
     deletes rows older than the pass stamp, so changing it mid-pass would
     delete what the earlier runs of this same pass just wrote. */
  let chunkAt = (state && state.cursor_chunk) || 0;
  if (chunkAt >= chunks.length) chunkAt = 0;

  /* A cursor is an INDEX into a chunk list rebuilt from ymd(now), and `from`
     moves at LOCAL MIDNIGHT - so every boundary slides one day while the
     saved index does not. Resuming across that boundary leaves a one-day
     HOLE between the last chunk the previous run read and the chunk this one
     resumes at, and `complete` would then let the sweep delete every row on
     that date still carrying the previous stamp: real open shifts gone from
     the coverage board, last_ok_at advanced so the browser keeps trusting the
     mirror, and no error anywhere.

     Replaying this handler’s own window/chunk code: cursor 2 loses
     2026-10-01, cursor 3 loses 2026-10-15, cursor 4 loses 2026-10-29, and a
     pass straddling the month rollover loses 2026-10-28. Roughly one pass a
     day is in flight at midnight, so it fires about daily.

     The comment below used to say the chunks are "recomputed identically
     every run so a cursor saved by one invocation still means the same thing
     to the next". That only ever held WITHIN a calendar day.

     So: if the window this run computed is not the window the cursor was
     saved against, start a fresh pass. Costs redoing one partial run a day.
     window_from/window_to are `date` columns, so PostgREST hands back plain
     YYYY-MM-DD strings that compare directly. On a first-ever run they are
     null, which differs from `from` and resets a cursor already at 0 - a
     no-op. */
  if (state && (state.window_from !== from || state.window_to !== to)) chunkAt = 0;

  const resuming = chunkAt > 0 && state && state.pass_stamp;
  const stamp = resuming ? state.pass_stamp : now.toISOString();
  await patchSync({ running_at: now.toISOString(), pass_stamp: stamp });

  /* ALWAYS RE-READ THE NEAR WINDOW, even on a resumed run.

     A full pass costs more than the budget and always will: measured on
     this account 2026-09-03, 16 requests / 1,323 visits / 9,622ms against
     a SOFT_DEADLINE_MS of 6,000. So a pass ALWAYS splits across runs, and
     a resumed run used to start at the cursor - chunk 3 or 4, out in late
     October - and never look at chunk 0 again until the pass finished and
     a fresh one came round.

     Chunk 0 is today..+13 days. It is where a scheduler adds an
     unassigned visit, and it was being re-read on every OTHER run: up to
     ~20 minutes on the ten-minute cron alone. last_ok_at meanwhile stayed
     MIRROR_COLD_MS, so the browser went on trusting a mirror that was
     missing the shift somebody had just created - reported by the desk
     2026-09-03, and a regression against the live scan this replaced,
     which saw a new shift on the very next reload.

     Upserting from a partial scan is already safe by design ("even a
     partial scan learned something true"), so reading a chunk twice in a
     pass costs nothing but the requests. The SWEEP is untouched and still
     needs a whole window - absence is still evidence of nothing.

     Bounded at one extra chunk - the near window is 5 requests, 3.3-3.9s
     depending on AxisCare. Measured end to end with the real handler, the
     resumed run comes in at 7.1s: inside both the 6s soft budget (which is
     checked between chunks, so it always overshoots by one) and the 10s
     platform timeout. */
  const resumeAt = chunkAt;
  const order = [];
  for (let i = resumeAt; i < chunks.length; i++) order.push(i);
  /* SECOND, not first. The near re-read is OPTIONAL - a refresh of ground this
     pass already covered - while a cursor chunk is the run’s actual progress.
     Putting the optional work first meant a run could spend its whole budget on
     it, advance nothing, and repeat that forever: simulated at 3x AxisCare
     latency the pass never completed in 40 runs, so last_ok_at froze, the mirror
     aged out and every browser fell back to the live scan permanently.

     Ordering it after the first cursor chunk fixes that by construction. Every
     run now advances the cursor at least once before anything may stop it, so
     both deadlines can bound the run without ever being able to starve the
     pass. The refresh becomes best-effort: on a slow day it is skipped and
     freshness degrades to what it was before, which is the right thing to give
     up. On a normal day it still happens - measured, a resumed run reads its
     first cursor chunk in ~1.7s and the near window in ~3.9s, finishing well
     inside the budget. */
  if (resumeAt > 0) order.splice(1, 0, 0);

  let requests = 0, scanned = 0, complete = false, failure = null, progressed = false;
  const open = [];

  try {
    for (let oi = 0; oi < order.length; oi++) {
      const idx = order[oi];
      const [cFrom, cTo] = chunks[idx];
      /* The near re-read covers ground this pass has ALREADY read, so a
         failure in it must not cost the run its real work. Without this a
         429 on any of its ~5 requests throws to the outer catch with
         chunkAt still at resumeAt: five extra requests of failure exposure
         bolted in front of every resumed run, able to strand the pass while
         AxisCare is rate-limiting. A refresh that fails is just a refresh
         that did not happen. */
      const isNearRefresh = idx < resumeAt;
      let token = null;
      try {
        for (;;) {
          const params = { startDate: cFrom, endDate: cTo, limit: PAGE_LIMIT };
          if (token) params.nextPageToken = token;
          const res = await axisGet('/api/visits', params);
          requests++;
          const results = (res && res.results) || {};
          const list = results.visits || [];
          scanned += list.length;
          list.forEach(v => { if (isOpen(v, now)) open.push(toRow(v, stamp)); });
          const next = results.nextPage;
          if (!next) break;
          const m = /[?&]nextPageToken=([^&]+)/.exec(String(next));
          if (!m) { failure = 'could not read the nextPage cursor'; break; }
          token = decodeURIComponent(m[1]);
          if (requests >= MAX_PAGES) { failure = 'stopped at the page cap (' + MAX_PAGES + ')'; break; }
        }
      } catch (e) {
        if (!isNearRefresh) throw e;
        console.warn('[openshifts] near re-read failed, carrying on: ' + redact(e.message));
        continue;
      }
      if (failure) {
        if (!isNearRefresh) break;
        console.warn('[openshifts] near re-read stopped early: ' + failure);
        failure = null;
        continue;
      }
      /* Only a chunk at or beyond the cursor is PROGRESS. The extra near
         read is a refresh of ground this pass already covered, so it must
         not advance the cursor - doing so would skip a chunk that has
         never been read and let `complete` lie to the sweep. */
      if (idx >= resumeAt) { chunkAt = idx + 1; progressed = true; }
      /* Stop BETWEEN chunks, never inside one: a half-read chunk cannot be
         resumed from a date boundary.

         And never before this run has advanced the cursor at least once.
         The original loop got that for free by checking after the increment;
         with the near re-read in front of the cursor it has to be explicit,
         or a slow AxisCare could spend the whole budget on chunk 0, make no
         progress, and leave the pass unable to finish - last_ok_at frozen,
         the mirror ageing out, and every browser back on the 9.6s live scan
         forever. One chunk of overrun is what SOFT deadline means. */
      /* Running out of time with only the OPTIONAL near refresh left is not a
         failure - every cursor chunk has been read and the pass has genuinely
         covered the window. Recording it as one would deny `complete`, block
         the sweep, and freeze last_ok_at forever: simulated, the pass never
         finished in 40 runs because the final run always had [lastChunk, 0]
         queued and stopped between them. */
      const onlyRefreshLeft = chunkAt >= chunks.length;
      if (oi + 1 < order.length && progressed && outOfTime()) {
        if (onlyRefreshLeft) break;
        failure = 'out of time after ' + (oi + 1) + '/' + order.length + ' chunks'; break;
      }
      /* The ceiling the guard above cannot enforce. Deliberately NOT gated on
         `progressed`: being killed by the platform with the lock held is worse
         than a pass that has to wait for AxisCare to recover. */
      if (oi + 1 < order.length && Date.now() - t0 >= HARD_DEADLINE_MS) {
        if (onlyRefreshLeft) break;
        failure = 'hard deadline after ' + (oi + 1) + '/' + order.length + ' chunks'; break;
      }
    }
    if (!failure && chunkAt >= chunks.length) complete = true;
  } catch (e) {
    failure = redact(e.message);
  }

  /* ---- write ------------------------------------------------------------ */
  let deleted = 0;
  /* The sweep needs "every row in the window carries THIS pass’s stamp",
     which is strictly stronger than "every chunk was read". The cursor is
     advanced by the scan loop alone, so a failed upsert used to persist a
     cursor claiming rows were stamped that were never written - and the next
     run then completed the pass and swept them. Measured shape: a run scans
     chunks 0-2, the upsert 503s, cursor 3 is saved anyway, the next run
     completes and deletes every row dated 09-17..10-14. Most of the board. */
  let stored = false;
  try {
    /* Upsert first, always. Even a partial scan learned something true, and
       an open shift appearing a run early is harmless. */
    for (let i = 0; i < open.length; i += 500) await upsertShifts(open.slice(i, i + 500));
    stored = true;                       /* this run’s scan is now in the table */

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

  /* After the writes, so it counts what the mirror now holds. Best-effort:
     a failure here must not lose the run that already succeeded. */
  let tableOpen = null;
  try { tableOpen = await countOpen(); } catch (e) { /* fall back to open.length */ }

  const ms = Date.now() - t0;
  const status = failure ? (complete ? 'error: ' : 'partial: ') + failure : 'ok';
  const patch = {
    running_at: null,
    last_run_at: now.toISOString(),
    last_status: status,
    window_from: from,
    window_to: to,
    scanned: scanned,
    shifts_open: tableOpen != null ? tableOpen : open.length,
    /* Where the next run resumes. Cleared on a completed pass so the next
       one starts a fresh window with a fresh stamp. */
    /* Rewind to where this run STARTED if its rows never landed. resumeAt is
       captured before chunkAt is touched, so this costs one re-read of the
       chunks whose upsert was lost and restores the invariant the sweep
       depends on. pass_stamp deliberately does NOT roll: chunks below
       resumeAt were stamped by earlier successful runs of this same pass. */
    cursor_chunk: complete ? 0 : (stored ? chunkAt : resumeAt),
    pass_stamp: complete ? null : stamp,
  };
  /* last_ok_at is the freshness contract and only a WHOLE window earns it. */
  if (complete && !failure) patch.last_ok_at = stamp;
  try { await patchSync(patch); } catch (e) { /* the scan still happened */ }

  return json(failure && !complete ? 502 : 200, {
    ok: !failure, complete, open: tableOpen != null ? tableOpen : open.length,
    seenThisRun: open.length, scanned, requests, deleted, ms,
    window: { from, to }, status,
    chunks: chunks.length, cursorChunk: complete ? 0 : chunkAt, resumed: !!resuming,
  });
};
