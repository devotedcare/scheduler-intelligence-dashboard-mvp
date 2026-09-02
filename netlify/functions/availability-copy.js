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
     0. RE-CARVES every future day that already holds rows, against the
        visits AxisCare has NOW. See "THE RE-CARVE" below — this is the
        pass that stops the save-time carve going stale.
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

/* THE SHORTEST BLOCK WORTH STORING, in minutes. Mirrors AV_MIN_MIN in
   index.html and must stay in step with it: if the two disagree, the copy
   proposes a shape the browser would never write and re-proposes it on
   every run. Strictly under, and only for the two statuses the desk named —
   School / Childcare / Appointment are short by nature. */
const AV_MIN_MIN = 180;
/* Open and nothing else — see AV_DROP_SHORT in index.html. */
const AV_DROP_SHORT = ['Open'];
const tooShort = s => !s.allDay && AV_DROP_SHORT.indexOf(s.status) >= 0 &&
                      (s.endMin - s.startMin) < AV_MIN_MIN;

/* How far past today the re-carve looks. The visit pull is sized to match. */
const RECARVE_DAYS = 92;

function dayShift(ds, n) {
  const d = new Date(ds + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return ymd(d);
}

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
  startMin: b.allDay ? null : b.startMin, endMin: b.allDay ? null : b.endMin,
  note: b.note == null ? null : b.note });
function sameShape(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].status !== b[i].status || !!a[i].allDay !== !!b[i].allDay ||
        a[i].startMin !== b[i].startMin || a[i].endMin !== b[i].endMin) return false;
  }
  return true;
}

/* WHO THE DAY BELONGS TO. The re-carve narrows somebody else's row, so it
   writes the day back under the name already on it rather than stamping
   itself over Mae or Beatrice — the panel's history line should still say
   who decided this caregiver was available. Days are written whole, so a
   day almost always carries one author (11,703 of 11,704 on this account);
   the most common wins, ties broken alphabetically so a retry is stable. */
/* One segment, readable, for the dry run's change list. */
function fmtSeg(x) {
  if (x.allDay) return x.status + ' all day';
  const hm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  return x.status + ' ' + hm(x.startMin) + '-' + hm(x.endMin);
}

function dayAuthor(rows) {
  const n = {};
  rows.forEach(r => { const k = r.updatedBy || AV_AUTO_AUTHOR; n[k] = (n[k] || 0) + 1; });
  return Object.keys(n).sort((a, b) => n[b] - n[a] || (a < b ? -1 : 1))[0] || AV_AUTO_AUTHOR;
}

/* ---- THE RE-CARVE -----------------------------------------------------
   The carve in the browser is a SNAPSHOT: it runs once, when a scheduler
   saves, against the visits AxisCare had at that instant. Match a client to
   a caregiver afterwards and the stored Open still covers the hours they
   are now booked for, and nothing looked again.

   That is what put Alrenz Ellivera on the calendar as free all day on
   2026-09-12 while assigned to Jose Ortiz 8a-8p: availability entered
   2026-09-01, visit assigned 2026-09-02.

   This pass closes it. Every future day that holds rows is re-derived from
   what is stored plus that date's real visits, and rewritten if the answer
   differs. It is idempotent — running it twice changes nothing the second
   time — which is what makes it safe on an hourly schedule.

   THREE THINGS IT WILL NOT DO:
     · it never changes a status. Only 'Open' is cut; a visit landing on
       Vacation or Unavailable stays the disagreement it is, for a person to
       resolve, exactly as before.
     · it never widens. It can only remove hours, never add them. So a visit
       CANCELLED in AxisCare leaves its hole behind — the uncarved intent was
       never stored, so there is nothing to restore it from. Re-saving the
       day in the panel is the fix, as it always was.
     · it never touches the past. Days before today are history. */
function planRecarve(days, cgId, visits, fromDate, toDate) {
  const out = [];
  Object.keys(days).sort().forEach(ds => {
    if (ds < fromDate || ds > toDate) return;
    const stored = days[ds];
    if (!stored || !stored.length) return;
    const was = stored.map(shape);
    const want = carve(visitWins(visits, cgId, ds), was);
    if (sameShape(was, want)) return;

    out.push({ day: ds, segs: want, was: was, author: dayAuthor(stored), cleared: !want.length });
  });
  return out;
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
/* THE MINUTES OF ONE DATE THAT ARE ALREADY A VISIT, in that date's own
   frame (minutes from ITS midnight, so a window may sit outside 0..1440).

   Three sources, because a visit and an availability block can each cross
   midnight and both are stored on the date they START:

     ds          a normal visit, and the front half of an overnight
     ds - 1      last night's visit running into this morning, shifted back
                 a day: 8pm-6am stored on ds-1 as 1200..1800 reads here as
                 -240..360, so this date is busy until 6am
     ds + 1      tomorrow's visit shifted forward, so an OVERNIGHT block
                 stored on ds (8pm-8am is 1200..1920) is cut by the visit
                 it runs into

   The middle source is the one that was missing: a whole-day Open on the
   morning after an overnight read as free from midnight while the caregiver
   was still on the visit. Identical to carvableVisits() in index.html. */
function visitWins(visits, cgId, ds) {
  const out = [];
  const take = (list, shift) => (list || []).forEach(w => {
    const a = w[0] + shift, b = w[1] + shift;
    if (b <= a || (b - a) >= 1440) return;
    if (b <= 0 || a >= 2880) return;
    out.push([Math.max(a, 0), Math.min(b, 2880)]);
  });
  take(visits[cgId + '|' + ds], 0);
  take(visits[cgId + '|' + dayShift(ds, -1)], -1440);
  take(visits[cgId + '|' + dayShift(ds, 1)], 1440);
  return out.sort((a, b) => a[0] - b[0]);
}

function carve(wins, segs) {
  const v = wins || [];
  const out = [];
  segs.forEach(sg => {
    if (!v.length || sg.status !== 'Open') { out.push(Object.assign({}, sg)); return; }
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
    /* Nothing actually cut: keep the segment as it stands, so a whole-day
       Open stays whole-day rather than being flattened to 00:00-24:00.
       Mirrors carveSegs() in index.html. */
    if (parts.length === 1 && parts[0][0] === (sg.allDay ? 0 : sg.startMin) &&
        parts[0][1] === (sg.allDay ? 1440 : sg.endMin)) { out.push(Object.assign({}, sg)); return; }
    /* A fragment starting at or after midnight belongs to the next date;
       start_min < 1440 is a database constraint. */
    parts.filter(w => w[0] < 1440).forEach(w => {
      /* THE SHORT-BLOCK DROP, on the pieces THE CARVE CUT and nothing else.
         Never on a segment no visit touched: this pass runs unattended every
         hour, and deleting a block somebody typed just for being short is
         not its job. Mirrors carveSegs() in index.html. */
      out.push(Object.assign({}, sg, { allDay: false, startMin: w[0], endMin: w[1] }));
    });
  });
  out.sort((a, b) => (a.allDay ? -1 : a.startMin) - (b.allDay ? -1 : b.startMin));
  /* The short-block drop, on the whole result, and it may leave the day
     empty - see carveSegs() in index.html for why both. The emptied-day
     hazard is handled in copyClashes(). */
  return out.filter(x => !tooShort(x));
}

/* WOULD THIS COPIED SHAPE CONTRADICT A REAL VISIT?

   Only Open is carved. Every other status is passed through untouched, so a
   Vacation / Unavailable / School shape borrowed from last month lands on a
   date AxisCare has a real visit and simply sits on top of it — the copy
   asserting the caregiver is off on a day they are booked to work.

   A PERSON may record that. It is a genuine disagreement between two
   systems and calDayStatus() flags it for somebody to resolve. A job that
   copies last month forward may NOT manufacture one.

   This is the mechanism that turned Alrenz Ellivera's 2026-09-06 and 09-13
   into "Unavailable all day" on dates he is with Jose Ortiz 8a-8p: the
   re-carve correctly emptied the day, an empty day is owned by nobody
   (copyOwns() is `segs.length > 0 && every(Auto-copy)`), so the ownership
   guard did not fire and August's pattern landed on top.

   It is also the same mechanism behind Wilma Escolano's single August
   vacation week becoming Unavailable on all 61 days of September and
   October, which took an actively-working caregiver out of coverage.

   Guarding the WRITE rather than the ownership is what makes this robust:
   it does not care how the day came to be empty. */
function copyClashes(wins, segs) {
  if (!wins || !wins.length) return false;
  return (segs || []).some(sg => {
    if (sg.status === 'Open') return false;
    const a = sg.allDay ? 0 : sg.startMin, b = sg.allDay ? 1440 : sg.endMin;
    return wins.some(w => w[0] < b && w[1] > a);
  });
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
    /* The reason on a row belongs to the day somebody typed it on, not to
       every future date that borrows the shape, so the copy keeps writing
       note:null exactly as it did before. The RE-CARVE is the opposite
       case: it rewrites the very row the note is on, and preserves it. */
    const wins = visitWins(visits, cgId, ds);
    const want = carve(wins, hit.segs.map(b => Object.assign(shape(b), { note: null })));
    if (!want.length) continue;                       /* swallowed by a visit */
    /* Never write a copied statement that contradicts a real visit. */
    if (copyClashes(wins, want)) continue;
    /* compared AFTER the carve, or a carved day is re-proposed every run */
    if (existing.length && sameShape(existing.map(shape), want.map(shape))) continue;
    out.push({ day: ds, segs: want });
  }
  return out;
}

async function writeDays(cgId, dates, segs, author) {
  const url = env('SUPABASE_URL', '').replace(/\/+$/, '') + '/rest/v1/rpc/set_availability_days';
  const body = {
    p_caregiver_id: cgId, p_dates: dates,
    p_segments: segs.map(s => ({ status: s.status, all_day: !!s.allDay,
      start_min: s.allDay ? null : s.startMin, end_min: s.allDay ? null : s.endMin,
      note: s.note == null ? null : s.note })),
    p_updated_by: author || AV_AUTO_AUTHOR
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

  const rows = await sbGetAll('/caregiver_availability?select=caregiver_id,on_date,status,all_day,start_min,end_min,note,updated_by&order=caregiver_id.asc,on_date.asc');
  const byCg = {};
  rows.forEach(r => {
    const d = byCg[r.caregiver_id] || (byCg[r.caregiver_id] = {});
    (d[r.on_date] = d[r.on_date] || []).push({
      status: r.status, allDay: !!r.all_day,
      startMin: r.all_day ? null : r.start_min, endMin: r.all_day ? null : r.end_min,
      note: r.note, updatedBy: r.updated_by
    });
  });

  const ids = Object.keys(byCg).sort((a, b) => +a - +b);
  /* THE VISIT PULL IS THE EXPENSIVE PART AND BOTH PASSES NEED IT, so it
     happens once, up front, over whichever window is wider.

     The copy's old cheap way out - "does anybody have an empty target
     month? if not, there is nothing to do" - used to skip this call
     entirely. It cannot any more: the re-carve has to run whether or not a
     month is empty, because the days it fixes are the FULL ones. That
     short-circuit still applies, but now only to the copy pass. */
  const recarveTo = dayShift(today, RECARVE_DAYS);
  const copyTo = ymd(new Date(+nextM.split('-')[0], +nextM.split('-')[1], 0));
  /* ONE DAY WIDER AT EACH END, and it is load-bearing. visitWins() reads
     ds-1 and ds+1, so without the extra day the overnight tail is invisible
     on the FIRST date of the window - which is today, the date the desk is
     looking at - and the last date is cut by nothing. One extra page. */
  const visitsTo = recarveTo > copyTo ? recarveTo : copyTo;
  const visits = await fetchVisits(dayShift(today, -1), dayShift(visitsTo, 1));

  /* ---- PASS A: THE RE-CARVE ---------------------------------------
     Every future day that already holds rows, re-derived against the
     visits AxisCare has NOW. Idempotent, so the hourly schedule settles to
     doing nothing until a visit actually moves.

     One day per write, deliberately: the days differ from one another, and
     a failure should cost one day rather than a batch. */
  let recarved = 0, cleared = 0, recarveStoppedAt = null;
  const changes = [];
  for (const id of ids) {
    if (outOfTime()) { recarveStoppedAt = id; break; }
    for (const p of planRecarve(byCg[id], +id, visits, today, recarveTo)) {
      if (changes.length < 200) changes.push({ cg: +id, day: p.day, by: p.author,
        from: p.was.map(fmtSeg), to: p.segs.map(fmtSeg) });
      if (p.cleared) cleared++;
      if (opts.dry) { recarved++; continue; }
      try {
        await writeDays(+id, [p.day], p.segs, p.author);
        recarved++;
        byCg[id][p.day] = p.segs.map(x => Object.assign({}, x, { updatedBy: p.author }));
      } catch (e) { /* one day failing must not stop the sweep */ }
    }
  }

  /* ---- PASS B: THE MONTHLY COPY ------------------------------------

     A CHEAP WAY OUT, FOR THE COPY ONLY. The in-app copy already handles
     anyone a scheduler opens or edits; this pass exists for the ones nobody
     touches, so the question worth asking first is simply: does any
     caregiver have an EMPTY target month it could fill?

     It used to stop the whole function before spending a single AxisCare
     request. It cannot any more — the re-carve above needs those visits, and
     the days it fixes are the FULL ones, which is exactly the case this
     shortcut skips. The visits are paid for by the time we reach here, so
     this now only skips pass B. */
  const anyGap = ids.some(id => [thisM, nextM].some(ym =>
    sourceMonthFor(byCg[id], ym) &&
    !Object.keys(byCg[id]).some(ds => ds.slice(0, 7) === ym)));
  if (!anyGap) {
    const rcDone = !recarveStoppedAt;
    await saveCursor({ cursor_cg: null, last_run_at: new Date().toISOString(),
      last_status: rcDone ? 'nothing to copy' : 're-carve paused at caregiver ' + recarveStoppedAt });
    return { ok: true, done: rcDone, dry: !!opts.dry, caregivers: ids.length, written: 0,
      visitsFetched: true, months: [thisM, nextM],
      recarve: { changed: recarved, cleared: cleared, through: recarveTo,
                 resumeFrom: recarveStoppedAt, changes: changes },
      ms: Date.now() - started };
  }


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

  const done = !stoppedAt && !recarveStoppedAt;
  await saveCursor({
    cursor_cg: stoppedAt ? +stoppedAt : null,
    last_run_at: new Date().toISOString(),
    last_status: done ? 'complete' : 'paused at caregiver ' + (stoppedAt || recarveStoppedAt),
    rows_written: ((cursor && +cursor.rows_written) || 0) + (opts.dry ? 0 : written)
  });

  return { ok: true, done, dry: !!opts.dry, months: [thisM, nextM], caregivers: ids.length,
    monthsFilled: touched, written, visitsFetched: true, resumeFrom: stoppedAt,
    recarve: { changed: recarved, cleared: cleared, through: recarveTo,
               resumeFrom: recarveStoppedAt, changes: changes },
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
