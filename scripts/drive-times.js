#!/usr/bin/env node
/* Regenerates DRIVE_TIMES in index.html — road drive times between cities.

   Find Coverage shows "~20 mins away" from this table. It is generated
   ONCE, here, and pasted into index.html; the page itself never calls a
   routing service. Run it only when a caregiver or client lives in a city
   the table does not know yet (the row then reads "Drive time not known"):

       node scripts/drive-times.js > drive-times.txt

   then replace the DRIVE_TIMES block in index.html with the output.

   WHAT LEAVES THIS MACHINE: the coordinates of the city centres below, and
   nothing else — no address, no name, no key. The routes come from the
   public OSRM demo server over OpenStreetMap data (© OpenStreetMap
   contributors, ODbL). That server is fine for a one-off run like this and
   is not meant for page traffic, which is why the page never calls it.

   WHICH POINT STANDS FOR A CITY matters: moving Simi Valley's point by a
   couple of miles moved its pairs by 3–4 minutes when this was measured.
   These are the city centres OpenStreetMap's Nominatim returns for the
   city name (2026-09-21), except Ventura, whose first hit was the county
   centroid, so it is the city of San Buenaventura's point. Keep them fixed
   so a regeneration only changes what the roads changed. City names must
   be spelled exactly as AxisRoster.normCity() writes them, because that is
   what the lookup is keyed on.

   "Los Angeles" is deliberately absent: the city is 47 miles across, so no
   single point answers for an address in it. A caregiver recorded that way
   reads "Drive time not known" until their neighbourhood is recorded.

   Times are free-flow — no traffic — and each pair is the mean of the two
   directions. Pairs are kept only when at least one side is in the
   service area (SERVICE below), because clients live there. */
'use strict';

/* The service area: the cities the Find Coverage Location picker offers
   (CITY in index.html) and where every active client lives. */
const SERVICE = {
  'Camarillo':        [34.2176371, -119.0383541],
  'Fillmore':         [34.3985613, -118.9125093],
  'Moorpark':         [34.285558,  -118.8820414],
  'Newbury Park':     [34.183671,  -118.91183],
  'Ojai':             [34.4480495, -119.242889],
  'Oxnard':           [34.1976308, -119.180381],
  'Port Hueneme':     [34.1477558, -119.1951559],
  'Santa Paula':      [34.3541659, -119.0592705],
  'Simi Valley':      [34.2677404, -118.7538071],
  'Thousand Oaks':    [34.1705609, -118.8375937],
  'Ventura':          [34.2783355, -119.293174],
  'Westlake Village': [34.1460234, -118.8061794]
};
/* Caregiver home cities outside the service area, as recorded in AxisCare
   on 2026-09-21. Add a city here when a caregiver's row reads "Drive time
   not known". */
const OUTSIDE = {
  'Agoura Hills':     [34.1481692, -118.7655456],
  'Canoga Park':      [34.2011078, -118.5978087],
  'Garden Grove':     [33.7746292, -117.9463717],
  'Granada Hills':    [34.2661558, -118.5174342],
  'Lancaster':        [34.6981064, -118.1366153],
  'Lemoore':          [36.3006495, -119.7827122],
  'North Hills':      [34.2429575, -118.4854081],
  'North Hollywood':  [34.1649502, -118.374752],
  'Pacoima':          [34.2625025, -118.427027],
  'Panorama City':    [34.2242902, -118.4453745],
  'Woodland Hills':   [34.1684364, -118.6058382]
};

async function main() {
  const names = Object.keys(SERVICE).concat(Object.keys(OUTSIDE));
  const pts = names.map(n => SERVICE[n] || OUTSIDE[n]);
  const coords = pts.map(p => p[1] + ',' + p[0]).join(';');           /* OSRM is lon,lat */
  const url = 'https://router.project-osrm.org/table/v1/driving/' + coords +
              '?annotations=duration,distance';
  const res = await fetch(url, { headers: { 'User-Agent': 'devoted-care-scheduler drive-times (one-off)' } });
  if (!res.ok) throw new Error('OSRM HTTP ' + res.status);
  const j = await res.json();
  if (j.code !== 'Ok') throw new Error('OSRM ' + j.code + ' ' + (j.message || ''));

  const inService = n => Object.prototype.hasOwnProperty.call(SERVICE, n);
  const rows = {};
  for (let i = 0; i < names.length; i++) {
    for (let k = i + 1; k < names.length; k++) {
      const a = names[i], b = names[k];
      if (!inService(a) && !inService(b)) continue;
      const d1 = j.durations[i][k], d2 = j.durations[k][i];
      const m1 = j.distances[i][k], m2 = j.distances[k][i];
      if (d1 == null || d2 == null || m1 == null || m2 == null) throw new Error('no route ' + a + ' - ' + b);
      const min = Math.round((d1 + d2) / 2 / 60);
      const mi = Math.round((m1 + m2) / 2 / 1609.344 * 10) / 10;
      const [x, y] = a < b ? [a, b] : [b, a];                          /* keyed alphabetically */
      (rows[x] = rows[x] || []).push([y, min, mi]);
    }
  }
  const q = s => "'" + s.replace(/'/g, "\\'") + "'";
  const out = [];
  out.push('const DRIVE_TIMES = {');
  const keys = Object.keys(rows).sort();
  keys.forEach((a, n) => {
    const list = rows[a].sort((p, r) => p[0] < r[0] ? -1 : 1)
      .map(p => q(p[0]) + ':[' + p[1] + ',' + p[2] + ']').join(', ');
    out.push('  ' + q(a) + ': {' + list + '}' + (n < keys.length - 1 ? ',' : ''));
  });
  out.push('};');
  process.stdout.write(out.join('\n') + '\n');
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
