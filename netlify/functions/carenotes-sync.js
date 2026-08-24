/* ===============================================================
   CARE NOTES SYNC  —  AxisCare -> Supabase

   Why this exists rather than a live fetch:

   A caregiver's shift documentation is only available on the
   per-visit detail call, /api/visits/{visitId} -> careNote. There
   is no bulk endpoint. At ~170 worked visits a week that is 170
   requests for a single sweep — roughly 34s at a polite 5 req/sec.
   Doing that on page load would be slow for one person and would
   put the whole team over AxisCare's limits. The Client Concierge
   dashboard hit 429s three times learning this.

   So notes are swept here on a schedule and the dashboard reads
   them from Supabase, making zero AxisCare calls.

   WHY IT IS CHUNKED. Netlify functions are time-limited (10s
   synchronous, more in background, and it varies by plan). Rather
   than bet on a limit, each run works until its deadline, writes
   what it has, and saves a cursor. The next run continues from
   there. A sweep that needs 34s simply takes several runs.

   Schedule is set in netlify.toml. It can also be triggered by
   hand for a backfill:
       /.netlify/functions/carenotes-sync?days=7

   Environment (all server-side, never in the browser):
       AXISCARE_SITE_URL, AXISCARE_API_TOKEN, AXISCARE_API_VERSION
       SUPABASE_URL
       SUPABASE_SERVICE_ROLE_KEY   writes bypass RLS; anon can only read
   =============================================================== */
'use strict';

/* The scheduled run only has to keep up: new visits, plus a short
   window where a note may still be edited. Three days does that in
   a fraction of the work — the same shape Client Concierge settled on
   (days=3 nightly, a wider pass weekly). A backfill passes ?days=
   explicitly. Visits with no note are never stored, so they cannot be
   skipped and are re-checked each run; keeping the window short is
   what stops that mattering. */
const DEFAULT_DAYS = 3;
const MAX_DAYS = 31;

/* Measured on site 7060: a visit-detail call takes ~1s, not the 250ms
   originally assumed. Three consequences, all handled below.

   1. The deadline has to leave room for one more slow request, or a run
      overshoots. An 8-visit run measured 8.19s against a 7s deadline.
   2. Fixed throttling is pointless when latency alone holds us near
      1 req/sec, so the limiter only sleeps if we are genuinely faster
      than MAX_RATE_PER_SEC.
   3. Re-reading notes we already hold wastes most of every run. Visits
      already stored are skipped, except in the FRESH_DAYS window where
      a note may still be edited. */
const SOFT_DEADLINE_MS = 5000;   // hard stop; leaves headroom under a 10s platform limit
const MAX_RATE_PER_SEC = 5;      // only enforced if AxisCare answers faster than this
const FRESH_DAYS = 2;            // always re-read these, in case a note was edited

const env = (n, d) => {
  const v = process.env[n];
  return (v === undefined || v === null || v === '') ? d : String(v).trim();
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

const sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

/* Only pauses when we are actually outrunning the limit. At ~1s per
   request this never sleeps; it exists so a faster AxisCare cannot
   push us over. */
let lastRequestAt = 0;
async function paced(fn) {
  const minGap = 1000 / MAX_RATE_PER_SEC;
  const wait = lastRequestAt ? minGap - (Date.now() - lastRequestAt) : 0;
  await sleep(wait);
  lastRequestAt = Date.now();
  return fn();
}
const ymd = d => d.toISOString().slice(0, 10);
const redact = (s, t) => (t ? String(s || '').split(t).join('[REDACTED]') : String(s || ''));

/* ---------- AxisCare ---------- */
function axisHeaders() {
  return {
    Accept: 'application/json',
    Authorization: 'Bearer ' + env('AXISCARE_API_TOKEN', ''),
    'X-AxisCare-Api-Version': env('AXISCARE_API_VERSION', '2023-10-01')
  };
}
async function axis(path) {
  const base = env('AXISCARE_SITE_URL', '').replace(/\/+$/, '');
  const r = await fetch(base + path, { headers: axisHeaders(), signal: AbortSignal.timeout(15000) });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const e = new Error('AxisCare HTTP ' + r.status + ' on ' + path);
    e.status = r.status;
    e.body = redact(body, env('AXISCARE_API_TOKEN', '')).slice(0, 300);
    throw e;
  }
  return r.json();
}

/* Visits for one day. Follows nextPage — a wide window silently
   truncates, and visits page on nextPageToken, not startAfterId. */
async function visitsForDay(day) {
  let path = '/api/visits?startDate=' + day + '&endDate=' + day;
  const out = [];
  for (let page = 0; page < 20 && path; page++) {
    const j = await axis(path);
    const res = (j && j.results) || {};
    (res.visits || []).forEach(v => out.push(v));
    const next = res.nextPage;
    path = next ? next.replace(/^https?:\/\/[^/]+/, '') : null;
  }
  /* only visits somebody actually worked can carry a note */
  return out.filter(v => !v.removed && v.caregiver && v.caregiver.id != null);
}

/* ---------- Supabase (service role: bypasses RLS) ---------- */
function sbHeaders() {
  const key = env('SUPABASE_SERVICE_ROLE_KEY', '');
  return {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal'
  };
}
async function sb(path, opts) {
  const base = env('SUPABASE_URL', '').replace(/\/+$/, '');
  const r = await fetch(base + '/rest/v1' + path, Object.assign({ headers: sbHeaders() }, opts || {}));
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('Supabase HTTP ' + r.status + ' on ' + path + ' — ' + t.slice(0, 200));
  }
  return r;
}
async function sbGet(path) {
  const base = env('SUPABASE_URL', '').replace(/\/+$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY', '');
  const r = await fetch(base + '/rest/v1' + path, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
  if (!r.ok) throw new Error('Supabase HTTP ' + r.status + ' on ' + path);
  return r.json();
}

async function loadCursor() {
  const rows = await sbGet('/care_notes_sync?id=eq.carenotes&select=*');
  return rows[0] || { id: 'carenotes', cursor_date: null, cursor_index: 0 };
}
async function saveCursor(patch) {
  await sb('/care_notes_sync?id=eq.carenotes', { method: 'PATCH', body: JSON.stringify(patch) });
}
/* Every visit_id we already hold, in one request.

   An earlier version asked per day, filtering on visit_at between
   <day>T00:00:00 and <day>T23:59:59. That silently under-matched:
   visit_at is a timestamptz carrying a -07:00 offset, so an evening
   visit on the 21st is stored as the 22nd in UTC and fell outside its
   own day's window — 50 notes were re-fetched every run. Comparing
   ids avoids the arithmetic altogether. */
async function existingVisitIds(sinceDay) {
  const set = new Set();
  let from = 0;
  for (let page = 0; page < 20; page++) {
    const rows = await sbGet('/care_notes?select=visit_id&visit_at=gte.' + sinceDay +
      'T00:00:00Z&order=visit_at.asc&limit=1000&offset=' + from);
    rows.forEach(r => set.add(r.visit_id));
    if (rows.length < 1000) break;
    from += 1000;
  }
  return set;
}

async function upsertNotes(rows) {
  if (!rows.length) return;
  await sb('/care_notes', { method: 'POST', body: JSON.stringify(rows) });
}

/* ---------- the sweep ---------- */
exports.handler = async function (event) {
  const started = Date.now();
  const q = (event && event.queryStringParameters) || {};

  const missing = ['AXISCARE_SITE_URL', 'AXISCARE_API_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter(n => !env(n, ''));
  if (missing.length) return json(503, { ok: false, error: 'Not configured', missing });

  /* The 5s default exists to survive a platform timeout on the schedule.
     A backfill run by hand — especially against the local dev server,
     which has no timeout at all — can afford much longer, and finishing
     170 visits in three runs beats twenty.
         ?maxMs=60000  */
  let budget = parseInt(q.maxMs, 10);
  if (!Number.isFinite(budget) || budget < 1000) budget = SOFT_DEADLINE_MS;
  budget = Math.min(budget, 600000);

  let days = parseInt(q.days, 10);
  if (!Number.isFinite(days) || days < 1) days = DEFAULT_DAYS;
  days = Math.min(days, MAX_DAYS);

  /* Days newest-first: today's notes matter most, and a run that
     runs out of time has still refreshed the ones people will look at. */
  const today = new Date();
  const dayList = [];
  for (let i = 0; i < days; i++) dayList.push(ymd(new Date(today.getTime() - i * 86400000)));

  let cursor;
  try { cursor = await loadCursor(); }
  catch (e) { return json(502, { ok: false, error: 'Could not read sync cursor: ' + e.message }); }

  /* resume mid-day if the last run stopped there */
  let dayIdx = cursor.cursor_date ? dayList.indexOf(cursor.cursor_date) : 0;
  if (dayIdx < 0) dayIdx = 0;
  let within = cursor.cursor_date ? (cursor.cursor_index || 0) : 0;

  const force = q.force === '1' || q.force === 'true';
  let written = 0, scanned = 0, requests = 0, skipped = 0, complete = false;
  let reqCount = 0, reqTotalMs = 0;   // to predict whether one more will fit

  /* what we already hold, so runs cover new ground instead of re-reading */
  let have = new Set();
  if (!force) {
    const oldest = dayList[dayList.length - 1];
    try { have = await existingVisitIds(oldest); requests++; }
    catch (e) { /* if this fails we simply re-read, which is safe */ }
  }

  try {
    for (; dayIdx < dayList.length; dayIdx++) {
      const day = dayList[dayIdx];
      const visits = await visitsForDay(day);
      requests++;

      /* dayIdx IS the age in days — dayList is built newest-first — so
         no date arithmetic is needed to decide what counts as fresh. */
      const isFresh = dayIdx < FRESH_DAYS;

      const batch = [];
      for (let i = within; i < visits.length; i++) {
        /* Stop while there is still room for one more slow request,
           rather than after discovering there wasn't. */
        const avg = reqCount ? reqTotalMs / reqCount : 1000;
        if (Date.now() - started + avg * 1.3 > budget) {
          await upsertNotes(batch);
          written += batch.length;
          await saveCursor({
            cursor_date: day, cursor_index: i,
            last_run_at: new Date().toISOString(),
            last_status: 'paused at deadline',
            notes_written: (cursor.notes_written || 0) + written
          });
          return json(200, {
            ok: true, done: false, resumedFrom: cursor.cursor_date, pausedAt: { day, index: i },
            written, scanned, skipped, requests, ms: Date.now() - started,
            avgRequestMs: Math.round(avg),
            note: 'Stopped before the platform timeout. The next run continues from here.'
          });
        }

        const v = visits[i];
        /* Recent days are always re-read: a caregiver may still be
           writing or correcting the note. Older ones we already hold
           are skipped. */
        if (!isFresh && have.has(v.id)) { skipped++; continue; }

        scanned++;
        let detail;
        const t = Date.now();
        try { detail = await paced(() => axis('/api/visits/' + encodeURIComponent(v.id))); requests++; }
        catch (e) { continue; }                          // one bad visit must not stop the sweep
        finally { reqTotalMs += Date.now() - t; reqCount++; }

        const rv = (detail.results && (detail.results.visit || detail.results)) || {};
        const raw = rv.careNote;
        const text = typeof raw === 'string' ? raw : (raw && (raw.note || raw.text)) || '';
        if (text && String(text).trim()) {
          batch.push({
            visit_id: v.id,
            client_id: v.client && v.client.id,
            client_name: v.client ? ((v.client.firstName || '') + ' ' + (v.client.lastName || '')).trim() : null,
            caregiver_id: v.caregiver && v.caregiver.id,
            caregiver_name: v.caregiver ? ((v.caregiver.firstName || '') + ' ' + (v.caregiver.lastName || '')).trim() : null,
            visit_at: v.scheduledStartDate || v.startDate || null,
            note: String(text).trim(),
            synced_at: new Date().toISOString()
          });
        }
      }

      await upsertNotes(batch);
      written += batch.length;
      within = 0;                                        // next day starts at the beginning
    }
    complete = true;
  } catch (e) {
    await saveCursor({
      cursor_date: dayList[Math.min(dayIdx, dayList.length - 1)], cursor_index: within,
      last_run_at: new Date().toISOString(), last_status: 'error: ' + e.message.slice(0, 180)
    }).catch(() => {});
    return json(e.status === 429 ? 429 : 502, {
      ok: false, error: e.message, axisBody: e.body,
      written, scanned, requests, ms: Date.now() - started,
      hint: e.status === 429 ? 'AxisCare rate-limited the sweep. It will resume on the next run.' : undefined
    });
  }

  await saveCursor({
    cursor_date: null, cursor_index: 0,
    last_run_at: new Date().toISOString(),
    last_status: 'complete',
    notes_written: (cursor.notes_written || 0) + written
  });

  return json(200, {
    ok: true, done: complete, days, budgetMs: budget, written, scanned, skipped, requests,
    ms: Date.now() - started,
    avgRequestMs: reqCount ? Math.round(reqTotalMs / reqCount) : null
  });
};
