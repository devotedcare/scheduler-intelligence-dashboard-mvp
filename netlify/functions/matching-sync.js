/* ===============================================================
   CLIENT MATCHING SYNC  —  Client Concierge -> our Supabase

   Client Concierge (project abotpetigotopedfuvbc) is where the desk
   records what a client needs in a caregiver: the gender preference,
   whether driving is required, and the list of caregivers the client
   is matched to. Find Coverage here needs all three.

   WHY A SYNC RATHER THAN READING CONCIERGE LIVE. Two reasons, and the
   second is the important one.

   1. Concierge's anon key would have to reach the browser, and that key
      can read the WHOLE of concierge_records — 179 care notes and 42
      family check-ins included. This app has no login, so that would
      publish clinical notes to anyone with the site URL. Here the key
      stays server-side and only the matching fields ever leave.

   2. Concierge stores the matched caregivers as NAMES, not ids:
        ["Maria Theresa Yap", "Roy Pena", "Leonardo Mission", ...]
      Names do not join to anything. 33 of the 45 distinct names matched
      the AxisCare roster exactly on the first pass; the other 12 were
      middle names ("Joanna Pagcu" / "Joanna Fe Pagcu"), suffixes
      ("Leonardo Mission" / "Leonardo Mission Jr."), one typo
      ("Marikeen Brahser" / "Brasher") and one nickname ("Marge Pineda" /
      "Margarita Pineda"). Resolving that on every page load would be a
      guess repeated forever. Resolved ONCE into a table, it becomes a
      fact somebody can correct.

   TWO OWNERS, DELIBERATELY:
     Concierge owns WHICH NAMES are on a client's list. This sync adds
       and removes rows to match it, every run.
     This app owns WHICH CAREGIVER a name resolves to. Once a row is
       match_state='confirmed' the sync never touches its caregiver_id
       again — the same guard the availability copy uses with
       'Auto-copy', for the same reason: a machine may overwrite its own
       work and never a person's.

   NICKNAMES ARE NOT GUESSED. "Marge" -> "Margarita" is obvious to a
   human and unsafe for a matcher: getting it wrong either offers a
   caregiver the family did not ask for, or hides one they did. Anything
   short of a confident match is left 'unmatched' and shown as such.

   Schedule is in netlify.toml. Matching changes maybe weekly, so it runs
   far less often than the care-notes sweep. By hand:
       /.netlify/functions/matching-sync
       /.netlify/functions/matching-sync?dry=1     report, write nothing

   Environment (all server-side, never in the browser):
       CONCIERGE_SUPABASE_URL, SUPABASE_ANON_KEY_CONCIERGE
       SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
       AXISCARE_SITE_URL, AXISCARE_API_TOKEN, AXISCARE_API_VERSION
   =============================================================== */
'use strict';

const env = (n, d) => {
  const v = process.env[n];
  return (v === undefined || v === '') ? d : v;
};

/* ---- name matching -------------------------------------------------
   Deliberately conservative. Two tiers only:

     exact   — the normalised full names are identical
     tokens  — every word of the Concierge name appears in the AxisCare
               name, which is what absorbs a missing middle name or a
               "Jr." suffix without inventing anything

   A one-character typo ("Brahser") does NOT match, and should not: the
   next tier down is edit distance, and at distance 1 a real surname pair
   like Chan/Chen collapses. Those land as 'unmatched' for a human. */
const norm = s => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

function buildMatcher(roster) {
  const exact = new Map();
  roster.forEach(c => {
    const k = norm(c.name);
    if (!k) return;
    if (!exact.has(k)) exact.set(k, []);
    exact.get(k).push(c);
  });
  return function match(name) {
    const n = norm(name);
    if (!n) return { id: null, how: 'blank' };

    const hit = exact.get(n);
    if (hit && hit.length === 1) return { id: hit[0].id, how: 'exact' };
    if (hit && hit.length > 1) return { id: null, how: 'ambiguous' };

    const words = n.split(' ').filter(Boolean);
    if (words.length < 2) return { id: null, how: 'too-short' };
    const cands = roster.filter(c => {
      const t = norm(c.name);
      return words.every(w => new RegExp('(^| )' + w + '( |$)').test(t));
    });
    if (cands.length === 1) return { id: cands[0].id, how: 'tokens' };
    if (cands.length > 1) return { id: null, how: 'ambiguous' };
    return { id: null, how: 'none' };
  };
}

/* ---- the Concierge preference labels we understand ------------------
   raw_prefs keeps the complete list regardless, so a label added over
   there is never silently lost — it just is not promoted to a column
   until somebody wires it. */
function readPrefs(prefs) {
  const get = label => {
    const p = (prefs || []).find(x => String(x.label || '').toLowerCase() === label);
    return p ? String(p.value == null ? '' : p.value).trim() : '';
  };
  const g = get('caregiver gender').toLowerCase();
  const d = get('driving required').toLowerCase();
  return {
    /* "No Preference" is a real answer and it means null — the client has
       no preference, which is different from nobody having asked. */
    gender_pref: g === 'female' ? 'F' : g === 'male' ? 'M' : null,
    driving_required: d === 'yes' ? true : d === 'no' ? false : null,
    language: get('language') || null
  };
}

/* ---- tiny REST helpers ---------------------------------------------- */
async function getJSON(url, headers) {
  const r = await fetch(url, { headers });
  const t = await r.text();
  if (!r.ok) { const e = new Error('HTTP ' + r.status + ' ' + t.slice(0, 200)); e.status = r.status; throw e; }
  try { return JSON.parse(t); } catch (e) { return null; }
}
async function sendJSON(method, url, headers, body) {
  const r = await fetch(url, { method, headers, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) { const e = new Error('HTTP ' + r.status + ' ' + t.slice(0, 300)); e.status = r.status; throw e; }
  try { return JSON.parse(t); } catch (e) { return null; }
}

/* ---- the AxisCare roster, every status ------------------------------
   Every status, not just Active: a client can be matched to somebody who
   has since gone On Vacation Leave, and resolving the name is still the
   right answer. Whether they are schedulable is a separate question that
   the roster split already answers. */
async function fetchRoster() {
  const site = env('AXISCARE_SITE_URL', '').replace(/\/+$/, '');
  const H = {
    Authorization: 'Bearer ' + env('AXISCARE_API_TOKEN', ''),
    'X-AxisCare-Api-Version': env('AXISCARE_API_VERSION', ''),
    Accept: 'application/json'
  };
  const out = [], seen = {};
  let after = null;
  for (let page = 0; page < 15; page++) {
    const u = new URL(site + '/api/caregivers');
    u.searchParams.set('limit', '100');
    if (after != null) u.searchParams.set('startAfterId', after);
    const b = await getJSON(u.toString(), H);
    const results = (b && b.results) || {};
    const cgs = results.caregivers || {};
    /* caregivers come back as an OBJECT keyed by id, unlike clients and visits */
    const list = Array.isArray(cgs) ? cgs : Object.keys(cgs).map(k => cgs[k]);
    if (!list.length) break;
    list.forEach(c => {
      if (!c || c.id == null || seen[c.id]) return;
      seen[c.id] = 1;
      out.push({
        id: c.id,
        name: ((c.firstName || '') + ' ' + (c.lastName || '')).trim(),
        status: (c.status && c.status.label) || null
      });
    });
    const np = results.nextPage;
    if (!np) break;
    const m = /startAfterId=(\d+)/.exec(String(np));
    if (!m) break;
    after = m[1];
  }
  return out;
}

/* ---- the sync ------------------------------------------------------- */
async function runSync(opts) {
  opts = opts || {};
  const started = Date.now();

  const cUrl = env('CONCIERGE_SUPABASE_URL', '').replace(/\/+$/, '');
  const cKey = env('SUPABASE_ANON_KEY_CONCIERGE', '');
  const oUrl = env('SUPABASE_URL', '').replace(/\/+$/, '');
  const oKey = env('SUPABASE_SERVICE_ROLE_KEY', '');
  const missing = [];
  if (!cUrl) missing.push('CONCIERGE_SUPABASE_URL');
  if (!cKey) missing.push('SUPABASE_ANON_KEY_CONCIERGE');
  if (!oUrl) missing.push('SUPABASE_URL');
  if (!oKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) { const e = new Error('not configured: ' + missing.join(', ')); e.code = 503; throw e; }

  const CH = { apikey: cKey, Authorization: 'Bearer ' + cKey };
  const OH = { apikey: oKey, Authorization: 'Bearer ' + oKey, 'Content-Type': 'application/json' };

  /* 1. Concierge clients — one request, 21 rows today */
  const records = await getJSON(
    cUrl + '/rest/v1/concierge_records?type=eq.clients&select=rid,data,updated_at', CH) || [];

  /* 2. what we already hold, so a confirmed resolution survives */
  const existing = await getJSON(
    oUrl + '/rest/v1/client_caregiver_match?select=client_axis_id,caregiver_name,caregiver_id,match_state', OH) || [];
  const held = new Map();
  existing.forEach(r => held.set(r.client_axis_id + '|' + r.caregiver_name, r));

  /* 3. the AxisCare roster, ONLY when a name actually needs resolving.
     The dashboard now calls this function when Find Coverage opens, so most
     runs happen because somebody clicked, not because anything changed. The
     roster is seven AxisCare requests; a run that has nothing new to resolve
     should cost one Concierge read and stop there.

     A name is worth resolving when it is NEW, or when a previous run failed
     to place it — that one is retried because the roster may have gained the
     person since. A name already resolved keeps its answer. */
  let needRoster = false;
  records.forEach(rec => {
    const d = rec.data || {};
    const axisId = parseInt(d.axisId, 10);
    if (!Number.isFinite(axisId)) return;
    (d.caregivers || []).forEach(n => {
      const name = String(n == null ? '' : n).trim();
      if (!name) return;
      const prev = held.get(axisId + '|' + name);
      if (!prev || (prev.match_state !== 'confirmed' && prev.caregiver_id == null)) needRoster = true;
    });
  });
  let match = () => ({ id: null, how: 'not-resolved-this-run' });
  let rosterSize = 0;
  if (needRoster) {
    const roster = await fetchRoster();
    rosterSize = roster.length;
    match = buildMatcher(roster);
  }

  const now = new Date().toISOString();
  const prefRows = [], matchRows = [], keep = new Map();
  const report = { exact: 0, tokens: 0, unmatched: 0, confirmedKept: 0, unchanged: 0, blank: 0 };
  const unresolved = [];

  records.forEach(rec => {
    const d = rec.data || {};
    const axisId = parseInt(d.axisId, 10);
    if (!Number.isFinite(axisId)) return;          /* no AxisCare id, nothing to join to */

    const p = readPrefs(d.prefs);
    prefRows.push({
      client_axis_id: axisId,
      gender_pref: p.gender_pref,
      driving_required: p.driving_required,
      language: p.language,
      /* careReq and careFit are NOT in prefs — they sit on the client record
         itself, because Concierge collects them as fixed checkbox lists
         (CARE_REQ_OPTIONS / CARE_FIT_OPTIONS) rather than free text, so
         matching stays comparable client to client. */
      care_req: Array.isArray(d.careReq) ? d.careReq : [],
      care_fit: Array.isArray(d.careFit) ? d.careFit : [],
      raw_prefs: Array.isArray(d.prefs) ? d.prefs : [],
      concierge_rid: rec.rid,
      synced_at: now
    });

    const names = (d.caregivers || [])
      .map(n => String(n == null ? '' : n).trim())
      .filter(Boolean);                            /* Concierge has at least one blank entry */
    keep.set(axisId, new Set(names));

    names.forEach((name, i) => {
      const prev = held.get(axisId + '|' + name);
      let caregiver_id, match_state;

      if (prev && prev.match_state === 'confirmed') {
        /* a person resolved this. Never re-decide it. */
        caregiver_id = prev.caregiver_id;
        match_state = 'confirmed';
        report.confirmedKept++;
      } else if (prev && !needRoster) {
        /* nothing new to resolve this run, so the roster was never fetched.
           Keep the answer we already had rather than blanking it. */
        caregiver_id = prev.caregiver_id;
        match_state = prev.match_state;
        report.unchanged++;
      } else {
        const m = match(name);
        caregiver_id = m.id;
        match_state = m.id ? 'auto' : 'unmatched';
        if (m.how === 'exact') report.exact++;
        else if (m.how === 'tokens') report.tokens++;
        else { report.unmatched++; unresolved.push({ client: axisId, name, why: m.how }); }
      }

      matchRows.push({
        client_axis_id: axisId, caregiver_name: name,
        caregiver_id, match_state, sort_order: i,
        concierge_rid: rec.rid, synced_at: now
      });
    });
  });

  if (opts.dry) {
    return { ok: true, dry: true, rosterFetched: needRoster, rosterSize, clients: prefRows.length, names: matchRows.length,
      ...report, unresolved, ms: Date.now() - started };
  }

  /* 4. write. Upsert both tables, then remove names Concierge dropped. */
  const UP = h => Object.assign({}, OH, { Prefer: h });
  if (prefRows.length) {
    await sendJSON('POST', oUrl + '/rest/v1/client_match_prefs?on_conflict=client_axis_id',
      UP('resolution=merge-duplicates,return=minimal'), prefRows);
  }
  if (matchRows.length) {
    await sendJSON('POST',
      oUrl + '/rest/v1/client_caregiver_match?on_conflict=client_axis_id,caregiver_name',
      UP('resolution=merge-duplicates,return=minimal'), matchRows);
  }

  /* Concierge owns membership: a name it no longer lists is gone from the
     client, confirmed or not. The confirmed guard protects which caregiver
     a NAME means, not whether the name belongs to the client. */
  let removed = 0;
  for (const [axisId, names] of keep) {
    const stale = existing.filter(r => r.client_axis_id === axisId && !names.has(r.caregiver_name));
    for (const r of stale) {
      const u = oUrl + '/rest/v1/client_caregiver_match'
        + '?client_axis_id=eq.' + axisId
        + '&caregiver_name=eq.' + encodeURIComponent(r.caregiver_name);
      await fetch(u, { method: 'DELETE', headers: OH });
      removed++;
    }
  }

  return {
    ok: true, rosterFetched: needRoster, rosterSize, clients: prefRows.length, names: matchRows.length, removed,
    ...report, unresolved, ms: Date.now() - started
  };
}

const json = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body, null, 2)
});

exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  try {
    const res = await runSync({ dry: q.dry === '1' });
    return json(200, res);
  } catch (e) {
    return json(e.code === 503 ? 503 : 502, { ok: false, error: e.message });
  }
};

/* exported so a local script can run exactly the same code path */
exports.runSync = runSync;
exports.buildMatcher = buildMatcher;
exports.readPrefs = readPrefs;
