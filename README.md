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

**Status: MVP.** Caregivers (184), clients (20) and open shifts are **live from
AxisCare**. Sample data is cleared at boot — if a screen is empty, AxisCare had
nothing or the fetch failed, and the banner says which. Care notes, medication
lists and attendance have no AxisCare source yet.
Deployed for internal use, link-access only, no login.
See [Security posture](#security-posture) before real client data is entered.

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
supabase/schema.sql            Table + row-level security. Run once.

.env.example                   The variable names you need. Not a real .env.
CHANGELOG.md                   What changed, and why — including the
                               decisions and the mistakes.
.gitignore                     Blocks .env and roster-verification.html —
                               both contain real data.
```

The only third-party code loaded at runtime is Inter from Google Fonts and
`@supabase/supabase-js` from jsDelivr. Charts are hand-drawn SVG — there is no
charting library.

---

## How the data model works

This matters more than the deploy steps, because it explains a decision that
looks odd until you know why.

**The seed data is deliberately not saved.**

Caregivers, clients and shifts are demo records generated *relative to the
moment the page loads*:

```js
const NOW = new Date();
function at(offsetHours){ /* ...NOW + offsetHours... */ }
{ id:'s1', start: at(3.5), end: at(11.5), status:'open' }
```

The Today view is built on that: `fmtDay()` returns "Today" / "Tomorrow", and
shifts sort by how many hours away they are. If we saved the whole state object
to the database — the obvious approach, and the one the Finance dashboard uses —
those timestamps would be frozen at the moment of the first save. Open the app
tomorrow and "starting in 3 hours" would actually be yesterday afternoon. The
dashboard's core promise quietly breaks.

**So we save an overlay instead: only what a human actually did.**

| Bucket    | What goes in it                                            |
|-----------|------------------------------------------------------------|
| `adds`    | Records the user created — new tasks, handoff notes, guides |
| `dels`    | Seed records the user removed                               |
| `patches` | Field-level edits to seed records (task marked Done, caregiver note changed) |
| `maps`    | Keyed stores the user wrote into — contact log, medication profiles, care-note overrides |
| `scalars` | Small settings — who's on shift, message templates          |

On every load the app regenerates the seed with fresh clocks, then replays the
overlay on top. Demo timing stays live; real work is durable.

Two consequences worth knowing:

- **The overlay is small.** A full shift of work is a few kilobytes, not a
  megabyte. Saves are fast and cheap.
- **System-generated tasks persist correctly** because their IDs are
  deterministic (`sys_coret_c1`, not `sys_1723!` + a timestamp). Marking one
  Done sticks across reloads.

### What is fetched, and in what order

`ROSTER.hydrate()` clears the sample records, then fetches **caregivers, clients
and open shifts in parallel** — about 4 seconds, dominated by the visit scan that
finds open shifts.

Three rules make that safe:

- **It runs before the baseline snapshot.** Otherwise the overlay diffs a real
  roster against a demo baseline and records all 184 caregivers as human edits.
  That bug shipped 323KB to Supabase before a test caught it.
- **A failed read shows nothing rather than something wrong.** If AxisCare is
  unreachable the dashboard is empty and says so, with a Retry. An implausibly
  small roster is rejected rather than applied. Sample data can be restored
  deliberately with `DEMO.on()`, never automatically.
- **`ROSTER.reconcile()` runs after every overlay is applied.** A saved overlay
  predates the roster swap and can reference caregivers who no longer exist.

Fields AxisCare has no source for — reliability, hours worked, call-offs,
verification history on caregivers; `reqSkills`, `risk` and `hasBackup` on
clients — are `null` and render as "Not tracked". They are never filled with a
placeholder number, because a real name beside an invented reliability score is
how someone ends up staffing on fiction.

Open shifts are derived, not fetched: a visit that is not removed, has no
caregiver, and is scheduled in the future. AxisCare has no field for *when* a
shift became open, so "open for N days" cannot be shown.

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
CLOUD.reset()       // wipe all saved work, back to clean demo data (asks first)
```

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

**Connected and in use.** The proxy talks to AxisCare successfully, and the
**caregiver roster is live** — 184 active people fetched on every load. Clients,
shifts, care notes and medication lists are still sample data and are labelled
as such in the UI. See [CLAUDE.md](CLAUDE.md) for what is live versus sample,
and for why open shifts cannot simply be read from AxisCare.

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

Visits are the important ones for this dashboard — a visit carries client,
caregiver, scheduled start/end and actual start/end, which is what Open Shifts,
Find Coverage and the Today view are built on.

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

### Why the dashboard still shows demo caregivers

**Deliberate, as of 2026-08-21.** The proxy works; the UI is simply not wired to
it yet. Reviewed and left on demo data on purpose — the reasoning is below so
the decision can be re-taken with the facts rather than re-researched.

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
| `SUPABASE_ANON_KEY` | for sync | — | anon/publishable key — **never** `service_role` |
| `SCHEDULER_WORKSPACE` | no | `devoted_care` | Change to run an isolated second copy |
| `SCHEDULER_TABLE` | no | `scheduler_state` | |
| `SCHEDULER_POLL_MS` | no | `20000` | Min 8000 |
| `AXISCARE_SITE_URL` | for AxisCare | — | `https://7060.axiscare.com`. Server-side only. |
| `AXISCARE_API_TOKEN` | for AxisCare | — | Server-side only. Never reaches the browser. |
| `AXISCARE_API_VERSION` | no | `2023-10-01` | Sent as `X-AxisCare-Api-Version`. Required by AxisCare; a wrong value 400s *before* auth. |
| `AXISCARE_ALLOWED_PATHS` | no | built-in list | Comma-separated path prefixes |
| `SUPABASE_SERVICE_ROLE_KEY` | for care notes | — | **Server-side only.** Used by the care-notes sync to write to Supabase. Never sent to a browser. |

Changing any of these requires a **redeploy** — they are read at build time.

> The Supabase **database password** is not in this table on purpose. It is only
> for direct Postgres access; this dashboard uses the REST API with the anon key.
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
> `file://` there is no server behind `/.netlify/functions/…`, so the browser
> blocks the request and the app falls back to the demo roster. That is expected,
> not a bug — the app says so in the console. The dashboard itself works fine
> that way; only AxisCare and Supabase need the server.

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

**Resetting the demo data.** Console → `CLOUD.reset()`. Clears the shared
overlay and reloads with clean seed data. It asks for confirmation. Do this
before a demo so nobody sees last week's test entries.

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
- `new row violates row-level security policy` → the policies in
  `supabase/schema.sql` section 2 weren't applied. Re-run that section.
- `relation "public.scheduler_state" does not exist` → the schema was run
  against the wrong project. Check the URL in the variable matches the project.
- `Invalid API key` → wrong key, or a stray space/newline when pasting.

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
the proxy, not the app. Sample data is still available with `DEMO.on()`.

**Everything is stale after a deploy.**
Hard-refresh (Ctrl-F5). `index.html` and `config.js` are sent with
no-cache headers, so this should be rare.

---

## Security posture

Stated plainly, because it is a deliberate MVP trade-off rather than an
oversight:

- **There is no login.** Anyone with the URL can open the dashboard.
- **The Supabase anon key is public.** It ships in `config.js`, visible in
  view-source. That is normal and expected for Supabase — protection comes from
  row-level security policies, not key secrecy.
- **Those policies currently allow anonymous read and write** to the one
  workspace row, because without a login there is no authenticated role to grant
  them to. So: anyone with the site URL can read and modify the scheduler data.
- Deletes are blocked at the database level. Nothing on the internet can drop
  the row.
- The AxisCare token is the one true secret, and it never leaves the server.
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

**The fix, when that time comes** (about ten minutes): require a shared secret
on the function — `?s=<secret>` read from a Netlify environment variable, the
same pattern `WEBHOOK_SHARED_SECRET` uses on the Client Concierge dashboard.
While no UI code calls the proxy, the secret never has to exist in the browser,
which makes it a real control rather than a cosmetic one.

This is acceptable while the app runs on **fictional demo data** for internal
evaluation. It stops being acceptable the moment real caregiver names, client
names, care notes or medication lists are entered — that is PHI, and an
unauthenticated public URL is a disclosure.

**Before real data goes in**, do all three:

1. Add Supabase email/password auth and a sign-in gate to the app.
2. Run section 4 of `supabase/schema.sql` to revoke the anonymous policies.
3. Turn on Netlify password protection or SSO as a second layer
   *(requires a paid Netlify plan)*.

---

## Roadmap

Next, in the order that unblocks the most:

1. **Caregivers — done.** 184 active people, live on every load.

2. **Open shifts — done.** Derived from visits that are unassigned, not
   removed, and in the future. Verified against the previous dashboard: same
   three shifts. Costs ~8 requests over a 28-day window.

3. **Care notes — done.** Swept into Supabase every 15 minutes by
   `netlify/functions/carenotes-sync.js`, because the note text is only on
   AxisCare's per-visit call (~170 requests for a week). The dashboard reads the
   mirror and makes no AxisCare calls for notes.

4. **Attendance and the "Not tracked" figures.** Punctuality, no-shows, weekly
   hours and prior-client history are all derivable from `clockIn` versus
   `scheduledStartDate` on visits already being fetched. This would replace the
   "Not tracked" placeholders on the caregiver workspace.

5. **Authentication** — required before real client data. See above.
6. **Per-user identity** — replace the "on shift" dropdown with real accounts so
   `updated_by` means something.
7. **Supabase Realtime** — swap 20-second polling for live push, so two
   schedulers see each other's changes instantly.
8. **Write-back to AxisCare** — currently one-way by design. Assigning coverage
   in the dashboard would create the visit in AxisCare.

---

*Internal tool — Devoted Care Services, Ventura County.*
