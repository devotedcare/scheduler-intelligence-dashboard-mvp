# Scheduler Intelligence — Devoted Care

An operations dashboard for the scheduling desk. It answers one question first —
**what needs attention right now** — and then gives the scheduler the tools to
act on it: fill open shifts, work call-offs, review care notes, run the shift
handoff, and keep weekly tasks moving.

AxisCare remains the system of record for caregivers, clients and visits. This
dashboard is the layer on top that makes the day navigable.

> **Working on this through Claude?** Read [CLAUDE.md](CLAUDE.md) first. It lists
> every AxisCare field that actually exists, so nothing has to be guessed, and it
> explains which parts need the lead developer.

**Status: MVP, in use by the scheduling desk.** Caregivers, clients, open shifts,
each caregiver's calendar and care notes are **live from AxisCare**, and calls
and texts are live from Quo. There is no sample data — if a screen is empty,
AxisCare had nothing or the fetch failed, and the banner says which. Medication
lists cannot be fetched, and attendance has no source yet.
Deployed for internal use, link-access only, no login.
See [Security posture](#security-posture) — its triggers for adding a login
have been reached.

---

## Contents

- [What's in the repo](#whats-in-the-repo)
- [How the data model works](#how-the-data-model-works) ← read this one
- [Setup part 1 — Supabase](#setup-part-1--supabase)
- [Setup part 2 — Netlify](#setup-part-2--netlify)
- [Setup part 3 — AxisCare](#setup-part-3--axiscare)
- [Environment variables](#environment-variables)
- [Running it locally](#running-it-locally)
- [Operating notes](#operating-notes)
- [Troubleshooting](#troubleshooting)
- [Security posture](#security-posture)
- [Roadmap](#roadmap)

See [CHANGELOG.md](CHANGELOG.md) for how the app got here.

---

## What's in the repo

```
CLAUDE.md                      Read first. What AxisCare actually provides,
                               and who owns which part of the system.
index.html                     The entire dashboard. One file, no framework,
                               no bundler, no npm dependencies.
config.js                      Supabase keys. Regenerated on every deploy.
404.html                       Not-found page.

netlify.toml                   Build, redirects, caching, security headers.
scripts/build-config.js        Writes config.js from environment variables.
scripts/dev-server.js          Local dev server. Serves the site and runs the
                               real Netlify function. No dependencies.
netlify/functions/axiscare.js  Server-side AxisCare proxy (keeps the token off
                               the browser).
netlify/functions/carenotes-sync.js
                               Scheduled sweep of caregiver shift notes into
                               Supabase. Chunked, resumable.
netlify/functions/openshifts-sync.js
                               Mirrors open shifts into public.open_shifts
                               every 10 minutes.
netlify/functions/openshifts-sync-now.js
                               Unscheduled twin the browser nudges; a scheduled
                               function cannot be called over HTTP.
netlify/functions/availability-copy.js
                               Hourly: re-carves availability around AxisCare
                               visits, then copies last month's pattern forward.
netlify/functions/matching-sync.js
                               Hourly copy of Client Concierge's caregiver
                               matches and client preferences.

supabase/schema.sql            Every table, trigger and the lock. Safe to re-run:
                               it keeps the tables locked (section 11 checks).
supabase/open-shifts.sql       Section 8 of schema.sql on its own.
supabase/comm-summaries.sql    Section 9 of schema.sql on its own.
supabase/app-gate.sql          Section 10: the PIN throttle table and gate_check().
supabase/app-gate-lock.sql     Section 11 on its own: drops every anon policy.
                               Run ONLY once the PIN-gated index.html is live.
supabase/app-gate-unlock.sql   Undoes the lock (re-opens every table to the anon key).
supabase/config.toml           Pins the project ref for the Supabase CLI.
supabase/functions/            Edge Functions. A commit does NOT deploy these.
  app-gate/                    THE ONLY WAY THE PAGE REACHES SUPABASE: checks
                               the desk PIN on every request, then reads/writes
  devi-agent/                  Ask Devi's Claude calls
  quo/                         Quo proxy: reads calls and texts, sends texts
  care-brief/                  The care-needs line in a shift-offer text
  comms-summary/               Summary by Devi on Communication Logs

.env.example                   The variable names you need. Not a real .env.
CHANGELOG.md                   What changed, and why — including the
                               decisions and the mistakes.
.gitignore                     Blocks .env and roster-verification.html —
                               both contain real data.
```

The only third-party code loaded at runtime is Inter from Google Fonts (and, on
a Reports PDF export only, jsPDF and html2canvas from cdnjs). There is no
Supabase client library: the page reaches Supabase only through the `app-gate`
Edge Function. Charts are hand-drawn SVG — there is no charting library.

---

## How the data model works

This matters more than the deploy steps, because it explains a decision that
looks odd until you know why.

**What comes from AxisCare is deliberately not saved.**

Caregivers, clients and open shifts are fetched from AxisCare on every load. If
we saved the whole state object to the database — the obvious approach, and the
one the Finance dashboard uses — the saved copy would be replayed over the live
one, and a shift filled in AxisCare an hour ago would still read as open.

> The rule is older than the live data. It was built when those records were
> demo data generated relative to the moment the page loaded, and a whole-state
> save would have frozen their timestamps. The reason changed; the rule did not.

**So we save an overlay instead: only what a human actually did.**

| Bucket    | What goes in it                                            |
|-----------|------------------------------------------------------------|
| `adds`    | Records the user created — new tasks, handoff notes, guides |
| `dels`    | Records the user deleted — on the desk's own lists a permanent tombstone (CLAUDE.md, 3g) |
| `patches` | Field-level edits to records the page loaded (task marked Done, a caregiver's review cadence) |
| `maps`    | Keyed stores the user wrote into — contact log, medication profiles, care-note overrides |
| `scalars` | Small settings — who's on shift, message templates          |

On every load the app fetches fresh records, then replays the overlay on top.
AxisCare stays current; the desk's work is durable.

Two consequences worth knowing:

- **The overlay is small.** A full shift of work is a few kilobytes, not a
  megabyte. Saves are fast and cheap.
- **System-generated tasks persist correctly** because their IDs are
  deterministic (`sys_coret_c1`, not `sys_1723!` + a timestamp). Marking one
  Done sticks across reloads.

### What is fetched, and in what order

`ROSTER.hydrate()` fetches **caregivers, clients and open shifts in parallel**.
The roster paints as soon as caregivers and their profiles land (about 2s). Open
shifts come from the `open_shifts` mirror (about 0.7s) and fall back to a live
visit scan (about 9–10s) only when the mirror is cold.

Three rules make that safe:

- **It runs before the baseline snapshot.** Otherwise the overlay diffs a real
  roster against a demo baseline and records all 184 caregivers as human edits.
  That bug shipped 323KB to Supabase before a test caught it.
- **A failed read shows nothing rather than something wrong.** If AxisCare is
  unreachable the dashboard is empty and says so, with a Retry. An implausibly
  small roster is rejected rather than applied. There is no sample data to fall
  back to.
- **`ROSTER.reconcile()` runs after every overlay is applied.** A saved overlay
  predates the roster swap and can reference caregivers who no longer exist.

Fields AxisCare has no source for — reliability, hours worked, call-offs,
verification history on caregivers; `reqSkills`, `risk` and `hasBackup` on
clients — are `null` and render as "Not tracked". They are never filled with a
placeholder number, because a real name beside an invented reliability score is
how someone ends up staffing on fiction.

Open shifts are derived, not fetched: a visit that is not removed, has no
caregiver, and is scheduled in the future. `openshifts-sync` applies that rule
for the whole desk and writes the answer to `public.open_shifts`. AxisCare has no field for *when* a
shift became open, so "open for N days" cannot be shown.

**Not everything loads at boot.** A caregiver's own calendar is fetched the
first time their workspace is opened, by `CGVISITS`, and cached per caregiver
— one request set covering one month back to twelve forward, so the month
arrows cost nothing afterwards. It is deliberate that this is not in
`hydrate()`: nobody who never opens a profile should wait for it.

Those visits are held **outside `state`**. `state.shifts` is a tracked CLOUD
slice, so a few hundred visits placed there would be diffed into the overlay and
written to Supabase as though a scheduler had typed them by hand — the same
323KB failure described above.

### Saving and conflicts

Every UI action calls `render()`, which is wrapped to schedule a save ~900ms
later. The save goes to `localStorage` first (instant, survives going offline)
and then to Supabase.

Three schedulers share one row, so writes use optimistic concurrency:

```
UPDATE scheduler_state SET overlay=…, rev=rev+1
 WHERE id='devoted_care' AND rev = <the rev we last read>
```

If that matches zero rows someone else saved first — the app re-reads their
version, re-layers its own changes on top, and retries once. Other tabs pick up
changes by polling every 20 seconds, on window focus, and on reconnect.

The pill in the top bar shows where things stand:

| Pill | Meaning |
|------|---------|
| **Synced** | Saved to Supabase and shared with the team |
| **Saving** | Write in flight |
| **Local** | No Supabase keys — saving to this browser only |
| **Offline** | Keys present, database unreachable. Work is still saved locally and pushed on reconnect. |
| **Sync error** | Rejected — hover the pill for the reason. Usually a missing RLS policy. |

### Console helpers

Open DevTools on the deployed site:

```js
CLOUD.status()      // { state, rev, workspace, cloud }
CLOUD.overlay()     // exactly what would be saved right now
CLOUD.sync()        // force a pull
CLOUD.save()        // force a push
CLOUD.reset()       // DESTRUCTIVE: wipes the whole desk's saved work - see Operating notes
```

For a caregiver's calendar — `id` is the app id, e.g. `'a731'`:

```js
CGVISITS.status(id)   // 'idle' | 'loading' | 'ready' | 'error'
CGVISITS.info(id)     // { status, count, from, to, requests, error }
CGVISITS.retry(id)    // clear the cache and fetch again
```

`count: 0` with `status: 'ready'` is a caregiver who genuinely has no visits,
which is the common case — not a failure.

---

## Setup part 1 — Supabase

Roughly five minutes.

1. **Create the project.** [supabase.com/dashboard](https://supabase.com/dashboard)
   → **New project**.
   - Name: `devoted-care-scheduler`
   - Database password: generate one and put it in the password manager. You
     will not need it for this app, but you cannot retrieve it later.
   - Region: pick the one closest to Ventura County — `West US (North California)`.
   - Wait for provisioning to finish (~2 minutes).

   > Use a **separate project** from the Finance dashboard. That app holds
   > financial records; this one holds care notes and medication lists. Keeping
   > them in different databases means one weak policy cannot expose both.

2. **Create the table.** Left sidebar → **SQL Editor** → **New query**. Paste
   the entire contents of [`supabase/schema.sql`](supabase/schema.sql) and press
   **Run**. You should see `Success. No rows returned`.

3. **Check it worked.** **Table Editor** → you should see `scheduler_state` with
   one row, `id = devoted_care`.

4. **Copy the two keys.** **Project Settings** → **Data API**:

   | Copy this | Looks like | Goes in |
   |-----------|-----------|---------|
   | Project URL | `https://abcdefgh.supabase.co` | `SUPABASE_URL` |
   | anon / publishable key | `eyJhbGciOiJIUzI1NiIs…` (long) | `SUPABASE_ANON_KEY` |

   > Take the **anon** key. The `service_role` key on the same page bypasses all
   > row-level security — it must never be given to a browser. `build-config.js`
   > will warn you if it detects one, but do not rely on that.

5. **Deploy the PIN gate.** With keys in `config.js` the page opens on a PIN
   screen and reads nothing until `app-gate` accepts a PIN, so it has to exist:

   ```
   npx supabase secrets set APP_PIN=<the desk PIN> --project-ref <ref>
   npx supabase functions deploy app-gate --project-ref <ref>
   ```

   `schema.sql` already created its throttle table (section 10). Use at least
   six digits: the throttle allows 8 guesses per network per 15 minutes.

---

## Setup part 2 — Netlify

1. **Push this repo to GitHub** (your step).

2. **Create the site.** [app.netlify.com](https://app.netlify.com) → **Add new
   site** → **Import an existing project** → GitHub → pick the repo.

3. **Build settings.** Netlify reads `netlify.toml`, so the fields should
   already be filled in. Confirm they read:

   | Field | Value |
   |-------|-------|
   | Build command | `node scripts/build-config.js` |
   | Publish directory | `.` |
   | Functions directory | `netlify/functions` |

4. **Add the environment variables** *before* the first deploy finishes, or just
   redeploy after. **Site configuration** → **Environment variables** → **Add a
   variable** → *Add a single variable*, scope **All deploy contexts**:

   ```
   SUPABASE_URL       = https://your-project-ref.supabase.co
   SUPABASE_ANON_KEY  = eyJhbGciOi...
   ```

5. **Redeploy.** **Deploys** → **Trigger deploy** → **Clear cache and deploy
   site**. The env vars are read at build time, so a plain redeploy is required
   after changing any of them.

6. **Verify.** Open the site.
   - The pill in the top bar should say **Synced** within a second or two.
   - Tick a task complete, hard-refresh (Ctrl-F5). It should still be complete.
   - Open the site in a second browser. The same task should be complete there.
   - In Supabase → Table Editor → `scheduler_state`, `rev` should be climbing.

   If the pill says **Local**, the build did not see your variables — check the
   deploy log for the `[build-config]` lines, which print exactly what it found.

### Renaming the site

**Site configuration** → **Site details** → **Change site name**, to get
`devoted-care-scheduler.netlify.app` instead of the generated name.

---

## Setup part 3 — AxisCare

**Connected and in use.** Caregivers, clients, open shifts, each caregiver's
calendar and care notes are all live from AxisCare; medication lists cannot be
fetched (AxisCare answers 403). See [CLAUDE.md](CLAUDE.md), *What is live and
what is sample*, and for how open shifts are derived from visits.

**Why a proxy at all.** Two reasons, both hard blockers:

1. The token would be readable by anyone who views source if it lived in
   `index.html` or `config.js`.
2. A browser cannot call the AxisCare API directly regardless — the request is
   cross-origin and gets blocked.

So the browser calls `/.netlify/functions/axiscare`, which runs on Netlify's
server where the token lives as an environment variable, and that calls AxisCare.

### How AxisCare's API actually works

Taken from the OpenAPI spec AxisCare publishes at
[`/api/documentation.html`](https://7060.axiscare.com/api/documentation.html)
(the page is a Stoplight viewer; the machine-readable source is at
`/api/stoplight/reference/api.yaml`), and confirmed with live calls.

| | |
|---|---|
| Base | `https://7060.axiscare.com` — the site root. Paths already include `/api`. |
| Auth | `Authorization: Bearer <token>` — always. There is no other scheme. |
| **Version** | `X-AxisCare-Api-Version: 2023-10-01` — a **required header**, not a path segment. |
| Methods | This proxy forwards GET only, so it can never mutate AxisCare. |

Two things that cost real time when unknown, so they are worth stating plainly:

- **Paths are unversioned.** It is `/api/caregivers`, not `/api/v1/caregivers`.
  Any version-looking segment produces `400 "Unsupported version"`.
- **The version check runs before authentication.** A missing or wrong version
  header returns the same 400 whether the token is valid, invalid or absent —
  so a wrong version silently masks every other problem, including a bad token.

`2023-10-01` is the version for every endpoint. `List Caregivers` additionally
accepts `2026-02-06`.

### Endpoints available to this account

Confirmed reachable: `caregivers`, `clients`, `visits`, `schedules`,
`contacts`, `applicants`, `call-logs`, `adls`, `organizations`,
`taggingCategories`, `classes`. (`/api/tokens/expiring` exists in the spec but
returns 403 for this token, and is not on the proxy allowlist.)

**`/api/visits` and `/api/schedules` require a date range** or they return 422:

```
/api/visits      needs  startDate + endDate,  or updatedSinceDate,  or visitIds
/api/schedules   needs  startDate + endDate,  or scheduleIds
```

`/api/visits` also takes **`caregiverIds`**, which narrows the result to one
caregiver — that is how each caregiver's calendar is built. Mind the plural:
`caregiverId`, `caregiver`, `employeeId` and `caregiverExternalId` all return
**200 and are silently ignored**, handing back every caregiver's visits. A query
matching nothing returns **404 `"No visits found"`**, not an empty array, so
that status has to be read as "none" rather than as an error.

Visits are the important ones for this dashboard — a visit carries client,
caregiver, scheduled start/end and actual start/end, which is what Open Shifts,
Find Coverage, the Today view and the caregiver calendar are built on.

### Configure it

Add to Netlify environment variables (names match the Client Concierge
dashboard, so both projects configure AxisCare identically):

```
AXISCARE_SITE_URL    = https://7060.axiscare.com
AXISCARE_API_TOKEN   = …                          (the secret)
AXISCARE_API_VERSION = 2023-10-01                 (optional — this is the default)
```

Redeploy, then from the browser console on the live site:

```js
await AxisCare.status()
// { ok:true, configured:true, siteUrl:'https://7060.axiscare.com',
//   apiVersion:'2023-10-01', tokenSet:true, tokenLength:36, mode:'ready' }

await AxisCare.ping()
// { ok:true, message:'AxisCare responded successfully — token and version are correct.' }

await AxisCare.get('/api/caregivers', { limit: 1 })
await AxisCare.get('/api/visits', { startDate:'2026-08-21', endDate:'2026-08-22' })
```

`status()` reports whether the token is present and its length; it never
returns the token. `ping()` makes a real call so you can tell a configuration
problem from a credentials problem.

Query parameters are passed as the second argument and forwarded to AxisCare
(internally as `q_*` on the function URL).

**If a request is refused with an allowlist error**, the path is not permitted.
That guard is what stops the function becoming an open proxy anyone could aim
at any URL. Widen it deliberately:

```
AXISCARE_ALLOWED_PATHS = /api/caregivers,/api/clients,/api/visits,/api/schedules
```

### How the roster was wired (history)

> **Historical — written 2026-08-21, before the roster went live on 2026-08-24.**
> Kept because the "blocker" below is where the rule against invented figures
> came from: fields AxisCare has no source for are `null` and read "Not
> tracked". Counts here are from that day; CLAUDE.md has the current ones.

On 2026-08-21 the proxy worked but the UI was deliberately not wired to it. The
reasoning follows.

#### The roster

643 caregivers, **180 active** — 170 `Active`, 7 `Temporarily Unavailable`,
3 `On Vacation Leave`. Note `status.active` is `true` for all three labels, so
filtering on it alone will include people who are not currently schedulable.
Paginate via `results.nextPage` (100/page = 7 pages).

#### What AxisCare can fill

| Dashboard field | AxisCare source | Coverage on active |
|---|---|---|
| `name`, `gender`, phone, email | direct fields | 98–99% |
| `base` (home city) | `mailingAddress.city` | 98% |
| `skills` | `classes[]` — `ALZ` Alzheimer's, `HLE` Hoyer lift, `ELC` hospice, `CNA`, `SS` Spanish, `FES` English | 60% |
| `avail` / `hours` | `classes[]` — `WKDY`, `WKND`, `MRNNG`, `AFTRNN`, `NOVRN`, `AD`, `LH`, `SH`, `LV` | 60% |
| `restrictions` | `classes[]` — `OWP` pets, `CFC`/`CMC` client gender, `OWC` couples, `DL`/`WDL` licence | 60% |
| travel radius | `acceptableDrivingDistance` | **20%** |
| `reliability`, `callOffs30`, `declinesStreak`, `weekHrs`, `priorClients` | **nothing** | **0%** |

#### The blocker worth understanding

That last row is why this was not just switched on. Those values are currently
**invented** — `reliability: 96`, `callOffs30: 0`, `weekHrs: 30` are hardcoded
demo numbers. Attached to a fictional "Rosa Delgado" that is obviously sample
data. Attached to a **real caregiver's name** it reads as fact, and a scheduler
could staff a high-risk client on a fabricated reliability score. Real
identities plus invented performance metrics is worse than honest demo data.

#### How to do it properly when the time comes

`/api/visits` makes those metrics genuinely derivable. Every visit carries both
scheduled and actual times plus clock-in/out with GPS:

```
scheduledStartDate / scheduledEndDate    what was planned
startDate / endDate                      what actually happened
clockIn / clockOut  { time, method, coordinates, location }
verified, removed, type, service, chargeRate
```

From a rolling window (~90 visits/week at current volume) you can compute real
punctuality, no-shows, weekly hours, and prior-client history. Wiring visits
also makes Today, Open Shifts and Find Coverage real, since all three are
built on visits rather than on caregiver records.

#### Two gotchas already found

- **City strings are dirty.** `CAMARILLO`, `Camarilllo`, `"Oxnard "`, `oxnard`
  are distinct values today. Normalise case and whitespace, and expect ~40% of
  active caregivers to live outside Ventura County (Canoga Park, Los Angeles,
  Lancaster, Lemoore…), so they are absent from the app's `CITY` distance map.
  *Corrected 2026-09-08: it is 8 of the 104 schedulable caregivers, not ~40%;
  `normCity()` cleans the strings before the map is consulted.*
- **40% of active caregivers carry no `classes` tags at all**, so they yield no
  skills or availability. They should still appear in the roster with empty
  skills — hiding real staff would be worse than showing an incomplete profile.

#### One implementation note

Hydration must happen **before** `CLOUD.boot()` takes its baseline snapshot,
otherwise the overlay will record the entire real roster as user edits. The
order has to be: seed → fetch AxisCare → `BASE = snapshot()` → replay overlay.
Also note several derivations parse the numeric part of the seed id
(`parseInt(c.id.slice(1))` on `'c7'`), so AxisCare ids need either the same
shape or those call sites updated.

### Response shapes

Results are nested under `results`, keyed by resource, and the shape is not
uniform — worth knowing before writing mappers:

```
/api/caregivers  ->  results.caregivers  is an OBJECT keyed by id  { "3": {...} }
/api/clients     ->  results.clients     is an ARRAY               [ {...} ]
/api/visits      ->  results.visits      is an ARRAY               [ {...} ]
```

Paginated endpoints return `results.nextPage`. The Client Concierge dashboard
normalises this with `j?.results?.data ?? j?.results ?? []`.

---

## Environment variables

All set in Netlify → Site configuration → Environment variables.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SUPABASE_URL` | for sync | — | `https://<ref>.supabase.co`, no trailing slash |
| `SUPABASE_ANON_KEY` | for sync | — | anon/publishable key — **never** `service_role`. It only gets requests past the gateway to `app-gate`; with no anon policies it reads and writes nothing itself |
| `SCHEDULER_WORKSPACE` | no | `devoted_care` | Change to run an isolated second copy — and add the same name to `APP_WORKSPACES` on `app-gate`, or it is refused |
| `SCHEDULER_TABLE` | no | `scheduler_state` | Leave it. `app-gate` only reaches `scheduler_state` and refuses any other |
| `SCHEDULER_POLL_MS` | no | `20000` | Min 8000 |
| `AXISCARE_SITE_URL` | for AxisCare | — | `https://7060.axiscare.com`. Server-side only. |
| `AXISCARE_API_TOKEN` | for AxisCare | — | Server-side only. Never reaches the browser. |
| `AXISCARE_API_VERSION` | no | `2023-10-01` | Sent as `X-AxisCare-Api-Version`. Required by AxisCare; a wrong value 400s *before* auth. |
| `AXISCARE_ALLOWED_PATHS` | no | built-in list | Comma-separated path prefixes |
| `SUPABASE_SERVICE_ROLE_KEY` | for the syncs | — | **Server-side only.** Used by `carenotes-sync`, `openshifts-sync`, `availability-copy` and `matching-sync` to write to Supabase. Never sent to a browser. |
| `CONCIERGE_SUPABASE_URL` | for matching | — | The Client Concierge project, read by `matching-sync` |
| `SUPABASE_ANON_KEY_CONCIERGE` | for matching | — | That project's anon key |

Changing any of these requires a **redeploy** — they are read at build time.

### Supabase Edge Function secrets

A **separate store**: Supabase dashboard → Project Settings → Edge Functions →
Secrets. Read by the five functions in `supabase/functions/`. Changing a secret
needs no redeploy (setting one restarts every function); changing a function
does, and **a commit does not deploy one**:

```
npx supabase functions deploy <name> --project-ref gdzgoyawavffjdjpjbfz --no-verify-jwt
npx supabase functions deploy app-gate --project-ref gdzgoyawavffjdjpjbfz     # JWT check ON: no flag
```

| Secret | Read by | Notes |
|---|---|---|
| `APP_PIN` | app-gate | **The desk PIN.** Unset = everyone refused. Changing it locks out every open tab on its next request — see CLAUDE.md, *The PIN gate* |
| `APP_WORKSPACES` | app-gate | optional, comma list; default `devoted_care` |
| `ANTHROPIC_API_KEY` | devi-agent, care-brief, comms-summary | `.env` calls the same value `CLAUDE_API_KEY` |
| `ALLOWED_ORIGIN` | all five | Browser origins allowed, comma-separated. Never `null`. `app-gate` allows no origin at all while it is unset |
| `QUO_API_KEY` | quo, comms-summary | The key has no scopes; see CLAUDE.md |
| `QUO_ROSTER_URL` | quo, comms-summary | This site's public AxisCare proxy. Texting is refused while unset |
| `QUO_API_BASE`, `QUO_ALLOWED_PATHS`, `QUO_SHARED_SECRET` | quo | optional |
| `CONCIERGE_MODEL` | devi-agent, care-brief | `DEVI_MODEL` overrides it for Devi; also `DEVI_EFFORT`, `DEVI_MAX_TOKENS`, `DEVI_SHARED_SECRET` |
| `CONCIERGE_SUPABASE_URL`, `CONCIERGE_ANON_KEY` | care-brief | Not `SUPABASE_ANON_KEY_CONCIERGE`: Supabase skips secrets named `SUPABASE_…` |
| `CARE_MODEL`, `CARE_CHECK_MODEL` | care-brief | optional |
| `COMMS_MODEL`, `COMMS_EFFORT` | comms-summary | optional; default `claude-haiku-4-5` and `low` |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are supplied by Supabase itself.

> The Supabase **database password** is not in this table on purpose. It is only
> for direct Postgres access; the dashboard reaches its data only through
> `app-gate`.
> Do not add it to Netlify.

> Auth is always Bearer for AxisCare, so there is no auth-style switch.
> `AXISCARE_AUTH_STYLE`, `AXISCARE_TOKEN_HEADER` and `AXISCARE_TOKEN_PARAM`
> existed while the scheme was unknown and were removed on 2026-08-21.

---

## Running it locally

**Use the dev server.** One command, no dependencies, no Netlify account:

```bash
node scripts/dev-server.js      # http://localhost:8888
```

It reproduces what Netlify does:

- serves the site from the repo root
- runs the **real** function code in `netlify/functions/` using the variables
  from `.env`, so `/.netlify/functions/axiscare` behaves exactly as in production
- generates `config.js` **in memory** from `.env`, so Supabase sync works without
  overwriting the committed placeholder

Check it is wired up:

```
http://localhost:8888/.netlify/functions/axiscare?action=ping
http://localhost:8888/.netlify/functions/axiscare?action=get&path=/api/caregivers&q_limit=1
```

The function is re-read on every request, so edits to it take effect without a
restart. Changes to `index.html` just need a refresh.

> **Opening `index.html` straight from disk will not load AxisCare.** On
> `file://` there is no server behind `/.netlify/functions/…`, so the red banner
> says the page was opened straight from disk and nothing is shown. That is
> expected, not a bug.

> **The dev server does not run the Supabase Edge Functions.** Ask Devi, Quo,
> the care-needs line and Summary by Devi call the deployed ones, which answer a
> local page only if `ALLOWED_ORIGIN` lists `http://localhost:8888`.

### Keep local testing out of the shared workspace

`.env` points at the same Supabase row the deployed site uses, so ticking tasks
locally syncs to the team. To work in isolation, set a different workspace in
`.env`:

```
SCHEDULER_WORKSPACE=devoted_care_local
```

The row is created on first save. Netlify is unaffected — it uses its own
environment variables.

### If you prefer the Netlify CLI

```bash
npm install -g netlify-cli
netlify login && netlify link
netlify dev
```

Equivalent, but it needs an account and a linked site. The dev server above
exists so neither is required.

> Running `node scripts/build-config.js` locally overwrites `config.js` with
> empty values unless the variables are exported in your shell. If that happens,
> `git checkout config.js`. The dev server never writes to it.

---

## Operating notes

**`CLOUD.reset()` deletes the whole desk's work — do not run it on the live
workspace.** It clears the shared overlay for every scheduler: tasks, handoff
notes, caregiver notes, feedback and complaints, the contact log and every
profile edit, then reloads. It asks once and cannot be undone. It used to be
advice for clearing test entries before a demo, back when the records were demo
data. Availability, day notes, care notes, open shifts, photos and Devi
summaries live in their own tables and storage and are not touched.

**Everyone shares one workspace.** All three schedulers write to the same row.
That is intentional — it is a shared desk, not per-user data. To spin up an
isolated copy (training, a client demo), set `SCHEDULER_WORKSPACE` to a
different value on a second Netlify site pointed at the same repo.

**Attribution uses the "on shift" scheduler.** Whoever is selected as on shift
gets recorded in `updated_by`. There is no login, so this is a label rather
than an identity.

**Deleting the workspace row.** You can't from the app, by design — there is no
delete policy in the schema. Reset blanks the overlay instead.

---

## Troubleshooting

**Pill says "Local" on the deployed site.**
The build didn't see your variables. Netlify → Deploys → open the latest →
search the log for `[build-config]`. It prints the workspace, table, and whether
Supabase was configured. Fix the variable, then **Clear cache and deploy site**.

**Pill says "Sync error" — hover it for the message.**
- `new row violates row-level security policy`, or data that reads as empty →
  that browser is running a build from before the PIN gate and still calling
  `/rest/v1` directly. **Hard refresh** (Ctrl+Shift+R). Do not add a policy back:
  the tables have none on purpose.
- `relation "public.scheduler_state" does not exist` → the schema was run
  against the wrong project. Check the URL in the variable matches the project.
- `Invalid API key` → wrong key, or a stray space/newline when pasting.

**The PIN screen says "Can't reach the server".**
The page could not reach `app-gate`, so it stays locked — it never treats
"unreachable" as "correct". In order: is `app-gate` deployed
(`npx supabase functions list --project-ref gdzgoyawavffjdjpjbfz`)? Is this
page's address in `ALLOWED_ORIGIN` (a local copy needs `http://localhost:8888`,
a deploy preview is not listed)? Is the Supabase project paused?

**"Too many wrong PINs".** Eight different wrong PINs came from this network in
15 minutes, so it is locked out for 15. It clears itself; to clear it now,
`delete from public.auth_throttle;` in the SQL editor.

**"The server refused this page".** A 401/403 that was not a PIN answer — most
often the anon key in `config.js` no longer matches the project (rotated keys).
Hard refresh; if it persists, check `SUPABASE_ANON_KEY` in Netlify.

**"The desk PIN is not set up".** `APP_PIN` is missing from the Supabase secrets,
so `app-gate` refuses everyone (it fails closed).

**Pill says "Offline" but the internet is fine.**
Usually the Supabase project is paused — free-tier projects pause after a week
of inactivity. Open the Supabase dashboard and resume it.

**Changes don't appear in another browser.**
Give it up to 20 seconds, or switch away and back to the tab to force a pull.
If it never arrives, check `rev` is incrementing in the Supabase Table Editor —
if it isn't, saves aren't landing and the pill will say why.

**A task I completed came back as Open.**
Expected in one specific case: a *system* task whose underlying condition has
gone away (the caregiver's call-off count dropped) is no longer generated, so
there is nothing to mark Done. Manual tasks always persist.

**Print / PDF opens a blank window.**
Pop-ups are blocked for the site. Allow them in the address bar.

**`AxisCare.get()` returns 503 "not configured".**
`AXISCARE_SITE_URL` or `AXISCARE_API_TOKEN` is missing. `await AxisCare.status()`
shows which.

**AxisCare returns 400 "Unsupported version".**
`AXISCARE_API_VERSION` is wrong — it should be `2023-10-01`. Note this check
runs *before* authentication, so a wrong version produces the same 400 whether
the token is good or not. Fix the version first, then judge the token.

**AxisCare returns 422.**
The endpoint needs query parameters you did not send. `/api/visits` and
`/api/schedules` both require a date range. AxisCare's own message says exactly
what is missing and is passed through as `axisError`:

```js
await AxisCare.get('/api/visits', { startDate:'2026-08-21', endDate:'2026-08-22' })
```

**AxisCare returns 401 / 403.**
Now it really is the token. Run `await AxisCare.ping()` — it distinguishes a
configuration problem from a credentials problem.

**`carenotes-sync` returns `{"error":"Not configured"}`.**
It names what is missing. Almost always `SUPABASE_SERVICE_ROLE_KEY` — the sync
writes with the service-role key, not the anon one. Add it in Netlify (and in
`.env` for local runs), then **restart the dev server**, which reads `.env` only
at startup. You should see `[dev] loaded 10 variables from .env`.

**The sync returns `"done": false` every time.**
That is correct, not a failure. Each run stops at a ~5s deadline and saves a
cursor so the next one continues — the limit exists so a scheduled run survives
the platform timeout. For a backfill, raise the budget:
`?days=14&maxMs=120000` (local only; there is no timeout on the dev server).

**Care Notes is empty and nothing is syncing.**
Work down this list:
1. Does the `care_notes` table exist? Re-run `supabase/schema.sql`.
2. Is `SUPABASE_SERVICE_ROLE_KEY` set? Hit the function and read `missing`.
3. **Is anything triggering it?** The schedule in `netlify.toml` only runs on a
   **deployed** site. The local dev server has no cron — trigger it by hand.

**A red "Couldn't reach AxisCare" banner.**
The dashboard shows nothing rather than something stale or invented. The banner
names the reason and offers **Retry**. Check
`/.netlify/functions/axiscare?action=ping` — if that fails too it is the token or
the proxy, not the app. There is no sample data to fall back to.

**A caregiver's calendar is empty.**
Most likely correct: 126 of 184 active caregivers had no visits in the current
month. The calendar says "0 scheduled visits from AxisCare" when that is the
case, and shows a red error only when the fetch genuinely failed. Check the
caregiver in AxisCare before assuming the dashboard is wrong.

**A caregiver's calendar shows someone else's clients.**
That would mean the `caregiverIds` filter stopped applying. Note the plural —
`caregiverId` (singular) returns 200 and is silently ignored, handing back every
caregiver's visits. `CGVISITS` also drops any visit whose `caregiver.id` does
not match, so this should not be reachable; if it happens, that guard is gone.

**Everything is stale after a deploy.**
Hard-refresh (Ctrl-Shift-R). A tab that was already open keeps running the old
code — and keeps saving with it — until it is reloaded; it shows a red *Refresh
needed* banner when it notices. See CLAUDE.md, *A deploy does not reach an open
tab*.

**A Supabase change "didn't deploy".**
It probably didn't: a commit deploys `index.html` to Netlify and nothing in
`supabase/functions/`. See [Supabase Edge Function secrets](#supabase-edge-function-secrets)
for the command. A browser reports an undeployed function as "Failed to fetch",
not as a 404.

---

## Security posture

Stated plainly, because some of it is a deliberate MVP trade-off rather than an
oversight:

- **The dashboard opens behind a desk PIN** (since 2026-09-18). It is not a
  login — the desk shares one PIN — but it is the credential for every Supabase
  read and write. The browser remembers it once per computer (every tab shares
  it, so it is typed only the first time and when it is wrong) and sends it with **every**
  request to the `app-gate` Edge Function, which checks it against the
  `APP_PIN` secret and only then works with the service-role key. There is no
  session and no token, so **changing `APP_PIN` locks out every open tab on its
  next request**, including one left open for days. See CLAUDE.md, *The PIN
  gate*.
- **The Supabase anon key is public, and no longer opens anything.** It still
  ships in `config.js` — it gets a request past the Supabase gateway — but every
  table has RLS on with no anon policy, so on its own it reads and writes
  nothing. `app-gate` only relays the exact requests the page makes (a fixed list
  of tables, methods and columns).
- **Wrong PINs are throttled per network:** 8 *distinct* wrong PINs in 15 minutes
  lock that IP out for 15 minutes, right PIN included. A tab still repeating an
  old PIN after a change is not counted twice, so a PIN change does not lock the
  office out. To clear a lockout: `delete from public.auth_throttle;`
- **An empty copy cannot overwrite the board.** `app-gate` refuses to save an
  overlay with no records over one that has them (only the deliberate
  `CLOUD.reset()` may), and every save is compare-and-swap on `rev`.
- **Caregiver photos stay on a public URL** — an `<img>` cannot send a PIN — but
  uploading or removing one goes through `app-gate`.
- The real secrets — the AxisCare token, the Quo and Anthropic keys, the
  Supabase service-role key and `APP_PIN` — live in Netlify variables or
  Supabase secrets and never reach the browser (the PIN is typed, not shipped).
- **Not behind the PIN yet:** the AxisCare proxy (below) and the other four Edge
  Functions (`quo`, `devi-agent`, `care-brief`, `comms-summary`) still answer
  anyone with the URL, as before. The PIN protects the desk's own records in
  Supabase; it does not yet protect what those endpoints serve.
- **The Quo function can send texts** from agency lines, but only to numbers on
  the active AxisCare roster. See CLAUDE.md, *Read-only — except `action=send`*.
- **The AxisCare proxy has no caller authentication** — see below. This one is
  different in kind from the others, so it is written up separately.

### Accepted risk: the AxisCare proxy is open

`/.netlify/functions/axiscare` checks that the path is on its allowlist and
that the method is GET. It does **not** check who is calling. Anyone who knows
the site URL can open, for example:

```
https://<site>.netlify.app/.netlify/functions/axiscare?action=get&path=/api/clients&q_limit=100
```

and receive real client records — confirmed to include `firstName`,
`lastName`, `dateOfBirth`, `residentialAddress`, `telephonyPhone` and
`allergies`. That is PHI, and unlike the Supabase item above it is real data
rather than demo data.

**Reviewed and accepted on 2026-08-21** while the app is in active development
and the URL is known only to the team. The protection today is that the URL is
undiscovered, not that access is restricted — a Netlify site is publicly
reachable, and nobody has to open the dashboard to reach the function.

**Revisit when any of these becomes true** — the first one to happen is the
trigger:

- The site URL is shared beyond the immediate team, or linked anywhere
- The dashboard starts rendering real AxisCare data (rather than demo data)
- The app moves from development into day-to-day scheduling use

> **Status, 2026-09-15 — recorded, not decided.** The dashboard renders live
> AxisCare data and live Quo calls and texts, and the scheduling desk works from
> it, so at least two of the triggers above have been reached. None of the steps
> below has been taken. The ten-minute fix also no longer works as written: it
> relied on no UI code calling the proxy, and the dashboard now calls it on every
> load, so a shared secret would have to ship to the browser. This is Carlo's
> call (CLAUDE.md, *Known and accepted*).

**The fix, when that time comes** (about ten minutes): require a shared secret
on the function — `?s=<secret>` read from a Netlify environment variable, the
same pattern `WEBHOOK_SHARED_SECRET` uses on the Client Concierge dashboard.
While no UI code calls the proxy, the secret never has to exist in the browser,
which makes it a real control rather than a cosmetic one.

> **Since 2026-09-18 there is a better fix than a shared secret in the page.**
> The desk PIN is exactly the credential this paragraph was missing: the proxy
> could require it and check it against `app-gate` (or its own copy of
> `APP_PIN`), so the page sends the PIN it already holds. That is Carlo's side —
> `netlify/functions/axiscare.js` and a Netlify variable — and it is the natural
> next step after the Supabase lock. The same goes for the other four Edge
> Functions.

What the PIN gate replaced: the old list here said to add Supabase auth and a
sign-in gate, and to run section 4 of `supabase/schema.sql` to revoke the
anonymous policies. The PIN gate did the revoking (`supabase/app-gate-lock.sql`,
now also section 11 of `schema.sql`) without per-person logins. Netlify password
protection or SSO *(paid plan)* remains available as a second layer.

---

## Roadmap

Next, in the order that unblocks the most:

1. **Caregivers — done.** 184 active people, live on every load.

2. **Open shifts — done.** Derived from visits that are unassigned, not
   removed, and in the future. Verified against the previous dashboard: same
   three shifts. Costs ~14 requests over today → end of next month (measured 2026-09-03: 1,321 visits scanned, 9.1s).

3. **Care notes — done.** Swept into Supabase every 15 minutes by
   `netlify/functions/carenotes-sync.js`, because the note text is only on
   AxisCare's per-visit call (~170 requests for a week). The dashboard reads the
   mirror and makes no AxisCare calls for notes.

4. **Caregiver calendar — done.** Each caregiver's month grid plots their own
   assigned client visits, one block per visit with the client and the times.
   Fetched with `/api/visits?caregiverIds=…` when the caregiver is opened —
   one month back to twelve forward, 2–4 requests.

5. **Caregiver communication — done.** The Communication Logs card reads every
   agency line from Quo, Find Coverage texts caregivers through Quo, and
   *Summary by Devi* puts one or two sentences on top of a call or a text day.

6. **Attendance and the "Not tracked" figures.** Punctuality, no-shows and
   weekly hours are derivable from `clockIn` versus `scheduledStartDate` on
   visits already being fetched — the calendar fetch has the records in hand
   already. This would replace the "Not tracked" placeholders on the caregiver
   workspace. (Prior-client history is now covered by the calendar.)

7. **Authentication** — required before real client data. See above.
8. **Per-user identity** — replace the "on shift" dropdown with real accounts so
   `updated_by` means something.
9. **Supabase Realtime** — swap 20-second polling for live push, so two
   schedulers see each other's changes instantly.
10. **Write-back to AxisCare** — currently one-way by design. Assigning coverage
   in the dashboard would create the visit in AxisCare.

---

*Internal tool — Devoted Care Services, Ventura County.*
