/* ===============================================================
   AVAILABILITY COPY  —  this month and next, for EVERY caregiver

   The dashboard already runs this copy in the browser, but only for a
   caregiver somebody opens: cascadeNextMonth() is gated on CGVISITS being
   'ready', which only happens because a calendar was opened. That is cheap
   and it works for anyone being actively scheduled — and it left everyone
   else behind.

   On 2026-09-01 that meant 101 of 140 caregivers had an empty September.
   Their September was never written while August was current, so once
   September arrived it became the SOURCE, it was empty, and October could
   not be built either. Permanently stuck, not merely late.

   This is the backstop: server-side, on a schedule, for the whole roster,
   so November gets filled on October 1st whether or not anybody clicks.

   WHAT IT DOES, per caregiver, in this order:
     1. the CURRENT month, from today forward  (never rewrites days already
        lived through)
     2. the NEXT month, which then sources from the month just written

   The rules are identical to the in-app copy, deliberately — it is the same
   feature, not a second one:
     · source = the most recent month before the target that holds rows,
       within COPY_LOOKBACK_MONTHS. Older than that is left blank, because
       nobody has confirmed that caregiver in over a month.
     · for each weekday, the LAST date carrying it, skipping Vacation /
       Sick / Appointment, and preferring a date with no AxisCare visit so a
       one-off carve is not promoted to the weekday's shape.
     · rows are stamped 'Auto-copy'. The copy may replace its own rows and
       NEVER one a person typed.
     · every written day is carved against that date's own visits.

   WHY IT IS CHUNKED. Filling a fresh month for the roster is ~2,500 rows.
   Netlify's timeout varies by plan, so rather than bet on a number this
   works to a soft deadline, saves the caregiver it reached, and the next
   run continues. Same shape as carenotes-sync.

   Schedule is in netlify.toml. By hand:
       /.netlify/functions/availability-copy
       /.netlify/functions/availability-copy?dry=1
       /.netlify/functions/availability-copy?maxMs=120000   local only
       /.netlify/functions/availability-copy?reset=1        clear the cursor

   Environment (all server-side, never in the browser):
       SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
       AXISCARE_SITE_URL, AXISCARE_API_TOKEN, AXISCARE_API_VERSION
   =============================================================== */
'use strict';

const AV_AUTO_AUTHOR = 'Auto-copy';
const COPY_SKIP = ['Vacation', 'Sick', 'Appointment'];
const COPY_LOOKBACK_MONTHS = 1;

/* Leaves room for a slow write to finish. The cursor makes an overshoot
   survivable either way, which is the point of having one. */
const SOFT_DEADLINE_MS = 20000;
const MAX_MS = 600000;

const env = (n, d) => { const v = process.env[n]; return (v === undefined || v === '') ? d : v; };
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
function ymAdd(ym, n) {
  const p = String(ym).split('-'), d = new Date(+p[0], +p[1] - 1 + n, 1);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1);
}

/* ---- REST ----------------------------------------------------------- */
function sbHeaders() {
  const k = env('SUPABASE_SERVICE_ROLE_KEY', '');
  return { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' };
}
async function sbGet(path) {
  const url = env('SUPABASE_URL', '').replace(/\/+$/, '') + '/rest/v1' + path;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 160));
  return r.json();
}
async function sbGetAll(path) {
  const out = []; let from = 0;
  for (;;) {
    const url = env('SUPABASE_URL', '').replace(/\/+$/, '') + '/rest/v1' + path;
    const r = await fetch(url, { headers: Object.assign({ Range: from + '-' + (from + 999) }, sbHeaders()) });
    if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 160));
    const b = await r.json();
    if (!b.length) break;
    out.push.apply(out, b);
    if (b.length < 1000) break;
    from += 1000;
  }
  return out;
}
async function saveCursor(patch) {
  const url = env('SUPABASE_URL', '').replace(/\/+$/, '') + '/rest/v1/availability_copy_sync?id=eq.availcopy';
  await fetch(url, { method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(patch) }).catch(() => {});
}
async function axGet(path, q) {
  const u = new URL(env('AXISCARE_SITE_URL', '').replace(/\/+$/, '') + path);
  Object.keys(q || {}).forEach(k => { if (q[k] != null) u.searchParams.set(k, q[k]); });
  const r = await fetch(u.toString(), {
    headers: {
      Authorization: 'Bearer ' + env('AXISCARE_API_TOKEN', ''),
      'X-AxisCare-Api-Version': env('AXISCARE_API_VERSION', ''),
      Accept: 'application/json'
    }
  });
  if (!r.ok) { const e = new Error('axiscare ' + r.status); e.status = r.status; throw e; }
  return r.json();
}

/* Every visit in the window, indexed caregiver|date, as MINUTE windows.
   An overnight runs past 1440, exactly as the app stores availability. */
async function fetchVisits(from, to) {
  const out = {}; let after = null;
  for (let i = 0; i < 30; i++) {
    const q = { startDate: from, endDate: to, limit: 200 };
    if (after) q.nextPageToken = after;
    const b = await axGet('/api/visits', q);
    const R = (b && b.results) || {};
    (R.visits || []).forEach(v => {
      if (v.removed || !v.caregiver || v.caregiver.id == null) return;
      const d = String(v.scheduledStartDate).slice(0, 10);
      const a = +String(v.scheduledStartDate).slice(11, 13) * 60 + +String(v.scheduledStartDate).slice(14, 16);
      let e = +String(v.scheduledEndDate).slice(11, 13) * 60 + +String(v.scheduledEndDate).slice(14, 16);
      if (e <= a) e += 1440;
      (out[v.caregiver.id + '|' + d] = out[v.caregiver.id + '|' + d] || []).push([a, e]);
    });
    const np = R.nextPage;
    if (!np) break;
    const m = /nextPageToken=([^&]+)/.exec(String(np));
    if (!m) break;
    after = decodeURIComponent(m[1]);
  }
  return out;
}

/* ---- the copy rules, mirroring index.html ---------------------------- */
const shape = b => ({ status: b.status, allDay: !!b.allDay,
  startMin: b.allDay ? null : b.startMin, endMin: b.allDay ? null : b.endMin });
function sameShape(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].status !== b[i].status || !!a[i].allDay !== !!b[i].allDay ||
        a[i].startMin !== b[i].startMin || a[i].endMin !== b[i].endMin) return false;
  }
  return true;
}
/* A date with a visit is a bad source: what is stored on it is not what the
   desk said, it is what was LEFT after that date's visits were carved out.
   Copying it forward promotes a one-off hole to the weekday's shape. */
function copySource(days, srcYm, cgId, visits) {
  const clean = {}, fallback = {};
  let any = false;
  Object.keys(days).filter(ds => ds.slice(0, 7) === srcYm).sort().forEach(ds => {
    const segs = days[ds];
    if (!segs || !segs.length) return;
    if (segs.some(b => COPY_SKIP.indexOf(b.status) >= 0)) return;
    const w = new Date(ds + 'T12:00:00').getDay(), hit = { from: ds, segs };
    fallback[w] = hit;
    if (!visits[cgId + '|' + ds]) clean[w] = hit;
    any = true;
  });
  if (!any) return null;
  const out = {};
  Object.keys(fallback).forEach(w => { out[w] = clean[w] || fallback[w]; });
  return out;
}
function sourceMonthFor(days, tgtYm) {
  for (let back = 1; back <= COPY_LOOKBACK_MONTHS; back++) {
    const ym = ymAdd(tgtYm, -back);
    if (Object.keys(days).some(ds => ds.slice(0, 7) === ym && (days[ds] || []).length)) return ym;
  }
  return null;
}
function carve(wins, segs) {
  const v = (wins || []).filter(w => w[1] > w[0] && (w[1] - w[0]) < 1440).sort((a, b) => a[0] - b[0]);
  if (!v.length) return segs.map(x => Object.assign({}, x));
  const out = [];
  segs.forEach(sg => {
    if (sg.status !== 'Open') { out.push(Object.assign({}, sg)); return; }
    let parts = [[sg.allDay ? 0 : sg.startMin, sg.allDay ? 1440 : sg.endMin]];
    v.forEach(([vs, ve]) => {
      const next = [];
      parts.forEach(([a, b]) => {
        if (ve <= a || vs >= b) { next.push([a, b]); return; }
        if (vs > a) next.push([a, vs]);
        if (ve < b) next.push([ve, b]);
      });
      parts = next;
    });
    parts.forEach(w => out.push(Object.assign({}, sg, { allDay: false, startMin: w[0], endMin: w[1] })));
  });
  out.sort((a, b) => (a.allDay ? -1 : a.startMin) - (b.allDay ? -1 : b.startMin));
  return out;
}

/* ---- one caregiver, one month --------------------------------------- */
function planMonth(days, cgId, tgtYm, notBefore, visits) {
  const srcYm = sourceMonthFor(days, tgtYm);
  if (!srcYm) return [];
  const src = copySource(days, srcYm, cgId, visits);
  if (!src) return [];
  const p = tgtYm.split('-'), dim = new Date(+p[0], +p[1], 0).getDate();
  const out = [];
  for (let d = 1; d <= dim; d++) {
    const ds = tgtYm + '-' + pad(d);
    if (notBefore && ds < notBefore) continue;
    const hit = src[new Date(ds + 'T12:00:00').getDay()];
    if (!hit) continue;
    const existing = days[ds] || [];
    /* a single human row on the day protects the whole day */
    if (existing.length && !existing.every(b => b.updatedBy === AV_AUTO_AUTHOR)) continue;
    const want = carve(visits[cgId + '|' + ds], hit.segs.map(shape));
    if (!want.length) continue;                       /* swallowed by a visit */
    /* compared AFTER the carve, or a carved day is re-proposed every run */
    if (existing.length && sameShape(existing.map(shape), want.map(shape))) continue;
    out.push({ day: ds, segs: want });
  }
  return out;
}

async function writeDays(cgId, dates, segs) {
  const url = env('SUPABASE_URL', '').replace(/\/+$/, '') + '/rest/v1/rpc/set_availability_days';
  const body = {
    p_caregiver_id: cgId, p_dates: dates,
    p_segments: segs.map(s => ({ status: s.status, all_day: !!s.allDay,
      start_min: s.allDay ? null : s.startMin, end_min: s.allDay ? null : s.endMin, note: null })),
    p_updated_by: AV_AUTO_AUTHOR
  };
  const r = await fetch(url, { method: 'POST', headers: sbHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error('write ' + r.status + ' ' + (await r.text()).slice(0, 160));
}

/* ---- the run --------------------------------------------------------- */
async function runCopy(opts) {
  opts = opts || {};
  const started = Date.now();
  const budget = Math.min(MAX_MS, Math.max(2000, opts.maxMs || SOFT_DEADLINE_MS));
  const outOfTime = () => Date.now() - started > budget;

  for (const n of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'AXISCARE_SITE_URL', 'AXISCARE_API_TOKEN']) {
    if (!env(n, '')) { const e = new Error('not configured: ' + n); e.code = 503; throw e; }
  }
  if (opts.reset) { await saveCursor({ cursor_cg: null, last_status: 'reset' }); }

  const today = ymd(new Date());
  const thisM = today.slice(0, 7), nextM = ymAdd(thisM, 1);

  const rows = await sbGetAll('/caregiver_availability?select=caregiver_id,on_date,status,all_day,start_min,end_min,updated_by&order=caregiver_id.asc,on_date.asc');
  const byCg = {};
  rows.forEach(r => {
    const d = byCg[r.caregiver_id] || (byCg[r.caregiver_id] = {});
    (d[r.on_date] = d[r.on_date] || []).push({
      status: r.status, allDay: !!r.all_day,
      startMin: r.all_day ? null : r.start_min, endMin: r.all_day ? null : r.end_min,
      updatedBy: r.updated_by
    });
  });

  /* A CHEAP WAY OUT. The expensive part is the visit pull, and the in-app
     copy already handles anyone a scheduler opens or edits. This job exists
     for the ones nobody touches, so the question worth asking first is
     simply: does any caregiver have an EMPTY target month it could fill?
     If not, there is nothing here for this job to do and it stops before
     spending a single AxisCare request. */
  const ids = Object.keys(byCg).sort((a, b) => +a - +b);
  const anyGap = ids.some(id => [thisM, nextM].some(ym =>
    sourceMonthFor(byCg[id], ym) &&
    !Object.keys(byCg[id]).some(ds => ds.slice(0, 7) === ym)));
  if (!anyGap) {
    await saveCursor({ cursor_cg: null, last_run_at: new Date().toISOString(), last_status: 'nothing to do' });
    return { ok: true, done: true, caregivers: ids.length, written: 0, visitsFetched: false,
      months: [thisM, nextM], ms: Date.now() - started };
  }

  const visits = await fetchVisits(today, ymd(new Date(+nextM.split('-')[0], +nextM.split('-')[1], 0)));

  let cursor = null;
  try { const c = await sbGet('/availability_copy_sync?id=eq.availcopy&select=*'); cursor = c && c[0]; } catch (e) {}
  const startAt = (cursor && cursor.cursor_cg != null) ? String(cursor.cursor_cg) : null;
  let began = !startAt;

  let written = 0, touched = 0, stoppedAt = null;
  for (const id of ids) {
    if (!began) { if (id === startAt) began = true; else continue; }
    if (outOfTime()) { stoppedAt = id; break; }

    for (const [tgt, notBefore] of [[thisM, today], [nextM, null]]) {
      const plan = planMonth(byCg[id], +id, tgt, notBefore, visits);
      if (!plan.length) continue;
      const groups = {};
      plan.forEach(p => { const k = JSON.stringify(p.segs); (groups[k] = groups[k] || []).push(p.day); });
      for (const k of Object.keys(groups)) {
        if (opts.dry) { written += groups[k].length; continue; }
        try { await writeDays(+id, groups[k], JSON.parse(k)); written += groups[k].length; }
        catch (e) { /* one caregiver failing must not stop the sweep */ }
      }
      /* reflect locally so the NEXT month sources from what was just written */
      plan.forEach(p => { byCg[id][p.day] = p.segs.map(s => Object.assign({ updatedBy: AV_AUTO_AUTHOR }, s)); });
      touched++;
    }
  }

  const done = !stoppedAt;
  await saveCursor({
    cursor_cg: stoppedAt ? +stoppedAt : null,
    last_run_at: new Date().toISOString(),
    last_status: done ? 'complete' : 'paused at caregiver ' + stoppedAt,
    rows_written: ((cursor && +cursor.rows_written) || 0) + (opts.dry ? 0 : written)
  });

  return { ok: true, done, dry: !!opts.dry, months: [thisM, nextM], caregivers: ids.length,
    monthsFilled: touched, written, visitsFetched: true, resumeFrom: stoppedAt,
    ms: Date.now() - started };
}

const json = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body, null, 2)
});

exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  try {
    return json(200, await runCopy({
      dry: q.dry === '1', reset: q.reset === '1',
      maxMs: q.maxMs ? parseInt(q.maxMs, 10) : 0
    }));
  } catch (e) {
    return json(e.code === 503 ? 503 : 502, { ok: false, error: e.message });
  }
};

exports.runCopy = runCopy;
