/* ============================================================================
   OPEN SHIFTS — the HTTP-invocable twin of openshifts-sync
   ============================================================================

   WHY THIS FILE EXISTS AT ALL

   Netlify will not let a SCHEDULED function be invoked over HTTP. A request to
   one comes back 403 Forbidden, and it does so silently as far as the page is
   concerned. Observed on the live site 2026-09-03:

       POST /.netlify/functions/openshifts-sync   ->  403 (Forbidden)
       GET  /.netlify/functions/matching-sync     ->  403 (Forbidden)

   Both of those carry a `schedule` in netlify.toml. matching-sync has been
   asking for a refresh from the browser since it was written and has been
   getting 403 every time — its own catch says "no function locally; fine",
   which swallowed it. So its stale-while-revalidate has never actually run in
   production. Worth knowing before trusting the same shape anywhere else.

   THE SPLIT

       openshifts-sync       has the schedule. The cron floor. Not callable.
       openshifts-sync-now   no schedule. What the dashboard POSTs to.

   Both run the SAME handler — this file delegates, it does not reimplement.
   There is one copy of the scan, the lock, the resume cursor and the sweep.

   THEY CANNOT COLLIDE. The shared handler takes a lock (`running_at`) and
   debounces on `last_run_at`, so a cron tick landing on top of a page load
   returns `skipped` in a few hundred milliseconds rather than starting a
   second scan. That guard was written for three schedulers opening at 9am and
   covers this for free.

   Everything else — environment, query parameters, the response shape — is
   documented in openshifts-sync.js. Read that one.
   ========================================================================= */

'use strict';

exports.handler = require('./openshifts-sync').handler;
