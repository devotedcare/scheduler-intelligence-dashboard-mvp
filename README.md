# Scheduler Intelligence — Devoted Care

An operations dashboard for the scheduling desk. It answers one question first —
**what needs attention right now** — and then gives the scheduler the tools to
act on it: fill open shifts, work call-offs, review care notes, run the shift
handoff, and keep weekly tasks moving.

AxisCare remains the system of record for caregivers, clients and visits. This
dashboard is the layer on top that makes the day navigable.

**Status: MVP.** Deployed for internal use, link-access only, no login.
See [Security posture](#security-posture) before real client data is entered.

---

## Contents

- [What's in the repo](#whats-in-the-repo)
- [How the data model works](#how-the-data-model-works) ← read this one
- [Setup part 1 — Supabase](#setup-part-1--supabase)
- [Setup part 2 — Netlify](#setup-part-2--netlify)
- [Setup part 3 — AxisCare](#setup-part-3--axiscare-optional-for-now)
- [Environment variables](#environment-variables)
- [Running it locally](#running-it-locally)
- [Operating notes](#operating-notes)
- [Troubleshooting](#troubleshooting)
- [Security posture](#security-posture)
- [Roadmap](#roadmap)

---

## What's in the repo

```
index.html                     The entire dashboard. One file, no framework,
                               no bundler, no npm dependencies.
config.js                      Supabase keys. Regenerated on every deploy.
404.html                       Not-found page.

netlify.toml                   Build, redirects, caching, security headers.
scripts/build-config.js        Writes config.js from environment variables.
netlify/functions/axiscare.js  Server-side AxisCare proxy (keeps the token off
                               the browser).
supabase/schema.sql            Table + row-level security. Run once.

.env.example                   The variable names you need. Not a real .env.
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

## Setup part 3 — AxisCare (optional for now)

The proxy is deployed and testable, but **the dashboard still renders demo
data**. Nothing in the UI calls AxisCare yet — mapping real fields is the next
piece of work, and it needs a sample response to build against.

**Why a proxy at all.** Two reasons, both hard blockers:

1. The token would be readable by anyone who views source if it were in
   `index.html` or `config.js`.
2. A browser cannot call the AxisCare API directly regardless — the request is
   cross-origin and will be blocked unless AxisCare explicitly allows your
   Netlify domain.

So the browser calls `/.netlify/functions/axiscare`, which runs on Netlify's
server where the token lives as an environment variable, and that calls AxisCare.

**To wire it up:**

1. Add to Netlify environment variables:
   ```
   AXISCARE_BASE_URL   = https://…        (no trailing slash)
   AXISCARE_TOKEN      = …                (the secret)
   AXISCARE_AUTH_STYLE = bearer           (or: header, query)
   ```
2. Redeploy.
3. Open the site, then the browser console:

   ```js
   await AxisCare.status()
   // { ok: true, configured: true, tokenSet: true, tokenLength: 64, mode: 'ready', … }

   await AxisCare.get('/caregivers')
   ```

   `status()` never returns the token itself — only whether it is present and
   how long it is.

4. Paste one real response back to me and I'll map the fields into the
   caregiver, client and shift models.

**If `get()` returns a 400 about the allowlist**, the path is not in the
permitted list. That guard stops the function becoming an open proxy that
anyone could point at any URL. Add your paths:

```
AXISCARE_ALLOWED_PATHS = /caregivers,/clients,/visits,/schedules
```

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
| `AXISCARE_BASE_URL` | for AxisCare | — | Server-side only |
| `AXISCARE_TOKEN` | for AxisCare | — | Server-side only. Never reaches the browser. |
| `AXISCARE_AUTH_STYLE` | no | `bearer` | `bearer` \| `header` \| `query` |
| `AXISCARE_TOKEN_HEADER` | no | `X-API-Key` | Used when style is `header` |
| `AXISCARE_TOKEN_PARAM` | no | `token` | Used when style is `query` |
| `AXISCARE_ALLOWED_PATHS` | no | built-in list | Comma-separated path prefixes |

Changing any of these requires a **redeploy** — they are read at build time.

---

## Running it locally

**Quickest look** — open `index.html` in a browser. Everything works except
cloud sync and the AxisCare function; changes save to that browser.

**With sync, no Netlify CLI** — put your Supabase URL and anon key directly into
`config.js` and open the file. Don't commit that edit.

**Full fidelity, including the function:**

```bash
npm install -g netlify-cli
netlify login
netlify link                 # connect to the site you created
netlify dev                  # http://localhost:8888
```

`netlify dev` pulls the environment variables down from the site, so both
Supabase sync and `/.netlify/functions/axiscare` behave exactly as in production.

> Running `node scripts/build-config.js` locally will overwrite `config.js` with
> empty values unless the variables are exported in your shell. If that happens,
> `git checkout config.js`.

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
`AXISCARE_BASE_URL` or `AXISCARE_TOKEN` is missing. `await AxisCare.status()`
shows which.

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

1. **AxisCare read integration** — replace seeded caregivers, clients and shifts
   with live data. Needs a sample API response to map against. The proxy is
   already deployed and waiting.
2. **Authentication** — required before real client data. See above.
3. **Per-user identity** — replace the "on shift" dropdown with real accounts so
   `updated_by` means something.
4. **Supabase Realtime** — swap 20-second polling for live push, so two
   schedulers see each other's changes instantly.
5. **Write-back to AxisCare** — currently one-way by design. Assigning coverage
   in the dashboard would create the visit in AxisCare.

---

*Internal tool — Devoted Care Services, Ventura County.*
