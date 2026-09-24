# CLAUDE.md — Scheduler Intelligence Dashboard

**Read this before answering any question about AxisCare data or writing any
code against it.** It exists so nobody has to guess what AxisCare provides.
Every field listed here was confirmed by a live API call, and every field *not*
listed genuinely does not exist.

This file is the working reference: what the data is, what the rules are, and
what not to break. It is loaded into every session, so **keep it to what somebody
needs in front of them before they write code.** Three files, one job each:

| | |
|---|---|
| **CLAUDE.md** | the rules, the data reference, the commands. Add a rule here; state the why in a clause, not a page |
| **[CHANGELOG.md](CHANGELOG.md)** | **what changed and when.** New history goes here, not into this file — dated entries, newest last |
| **[docs/HISTORY-2026-09.md](docs/HISTORY-2026-09.md)** | frozen. This file before the 2026-09-24 trim, with every measurement, incident and review behind the rules above. **When a rule here looks arbitrary, the evidence is there** |

Neither of the other two is loaded into context, which is the point — this one
reached 337KB by absorbing both.

---

## What this app is

An operations dashboard for the Devoted Care scheduling desk. It opens on **what
needs attention today**, then gives the scheduler tools to act: fill open shifts,
work call-offs, review care notes, run the shift handoff, keep weekly tasks
moving.

One file — `index.html` — with no framework, no bundler and no npm packages.
Charts are hand-drawn SVG. Everything is plain JavaScript in one `<script>` block.

AxisCare is the system of record for caregivers, clients and visits. This
dashboard sits on top and makes the day navigable.

It opens behind a **desk PIN**, and every Supabase read and write goes through
the `app-gate` Edge Function, which checks that PIN on every request. See
*The PIN gate* before touching any Supabase request.

---

## Working on this project — how to help

Most requests are about **what the dashboard shows and how it looks**, and those
are all done in `index.html`. Keep changes there whenever possible.

Four habits that matter more than anything else:

1. **Check what data actually exists before writing code.** The AxisCare section
   below lists every available field. Guessing a field name produces a silently
   blank row, which is genuinely hard to diagnose later.
2. **Never invent a data field.** If it isn't in the tables below, AxisCare does
   not provide it. Say so plainly and offer the nearest field that does exist.
   Inventing a plausible-sounding field name is the single most damaging thing
   that can happen in this codebase, because it looks like it worked.
3. **If something isn't possible, say so early and explain why in plain
   language** — then offer the closest thing that is.
4. **Diagnose rather than hand back a list of things to try.** Nearly every
   question is answerable from this file or from one URL (see *Checking what
   AxisCare really returns*).

Be straightforward and warm. Explain the *why* rather than just the rule, and
assume good judgement — the constraints here come from AxisCare and the
architecture, not from anyone's ability.

---

## Who does what

**Mitch** directs changes to the dashboard through Claude, using the GitHub
connection. A commit to `main` auto-deploys to Netlify, so a merged change is
live within a couple of minutes. **Carlo** (lead developer) owns anything that
isn't a file in this repo, and does his own GitHub writes.

### Doable through Claude + GitHub

Anything in `index.html` — layout, wording, what a view shows, new panels — plus
documentation. Commit and let Netlify deploy.

### Needs Carlo

Not files in the repo, so a commit cannot change them:

- **Netlify environment variables** — the AxisCare token, the Supabase keys
- **Supabase** — deciding what the tables, RLS policies and secrets should be.
  *Running* the deploy, the SQL or `secrets set` is Claude's
- **AxisCare admin** — the token, and which endpoints the account may call
- **Netlify build settings**, and reading Netlify or Supabase logs

**Pass it to Carlo when:** `action=ping` fails or returns 401/403; the sync pill
reads *Sync error* for everyone; a new AxisCare endpoint is needed. Say what's
needed in one line and carry on with anything that isn't blocked.

**No need to involve anyone for:** a field that isn't in the tables below, a
layout or wording change, or anything already answered in this file.

> `netlify/functions/axiscare.js` *is* in the repo, so a commit would deploy it.
> Don't. It is the security boundary that keeps the AxisCare token off the
> browser, and a mistake there exposes it. Check with Carlo first.

---

## Where the code lives, and what a commit does NOT deploy

| | Deployed by |
|---|---|
| `index.html`, `README.md`, docs | **a commit** → Netlify, live in ~2 min |
| `netlify/functions/*` (`axiscare`, `carenotes-sync`, `openshifts-sync`, `availability-copy`) | a commit → Netlify |
| `supabase/functions/*` — **eight**: `app-gate`, `devi-agent`, `quo`, `care-brief`, `comms-summary`, `carenotes-summary`, `carealerts-summary`, `caregiver-about-summary` | **`npx supabase functions deploy`, never a commit** |
| `supabase/*.sql` | run against the database by hand |
| `config.js` | generated at deploy time from Netlify env vars. Editing it does nothing; the committed copy is intentionally empty |

```
npx supabase functions deploy <name> --project-ref gdzgoyawavffjdjpjbfz --no-verify-jwt
```

`--project-ref` is **not optional** — `functions deploy` does not read
`project_id` from `supabase/config.toml`. `--no-verify-jwt` for every function
**except `app-gate`**, which is deployed with JWT verification on.

> **THE CLI DOES NOT READ `.env`.** `SUPABASE_ACCESS_TOKEN` lives there, but
> `npx supabase` reads the **environment** or a prior `supabase login` — so a
> perfectly good token answers `Unauthorized`, byte-identical to an expired one.
> Export it before blaming the token:
>
> ```
> export SUPABASE_ACCESS_TOKEN=$(grep ^SUPABASE_ACCESS_TOKEN= .env | cut -d= -f2-)
> npx supabase projects list        # NOW it is a token test
> ```
>
> Only Mitch can mint a replacement (Supabase dashboard → Account → Access
> Tokens). A genuinely expired one fails late: the upload starts, then
> `unexpected deploy status 401`.

**A Supabase function can look deployed and not be.** Netlify going green says
nothing about it. If `index.html` lands first, the feature shows its error state
— which is always designed to be the pre-feature page, not a break.

`npx supabase functions list --project-ref gdzgoyawavffjdjpjbfz` is the check,
and it is worth running after any merge that adds one. **Two are unrun as of
2026-09-24** — `carealerts-summary` and `caregiver-about-summary`, both merged
that day and both called from a live `index.html`. Each needs its SQL first:

```
supabase/care-alert-summaries.sql          -> care_alert_summaries
supabase/caregiver-about-summaries.sql     -> caregiver_about_summaries
```

Neither table exists yet, so *Clients Needing Attention* and the caregiver
*About* summary both show their not-deployed message on the live desk.

---

## AxisCare — the connection is already set up and working

| | |
|---|---|
| Site | `https://7060.axiscare.com` |
| Auth | `Authorization: Bearer <token>` — there is no other scheme |
| Version | `X-AxisCare-Api-Version: 2023-10-01` — a **required header** |
| Access | Read-only. The proxy forwards GET and nothing else. |

The browser never talks to AxisCare directly — it cannot, and the token must
never reach it. The app calls its own Netlify function, which holds the token:

```js
await AxisCare.status()   // is it configured?
await AxisCare.ping()     // does the token actually work?
await AxisCare.get('/api/caregivers', { limit: 25 })
await AxisCare.get('/api/visits', { startDate:'2026-08-21', endDate:'2026-08-22' })
```

### Three traps that cost real time

- **Paths are unversioned.** `/api/caregivers`, never `/api/v1/caregivers`. Any
  version-looking segment returns `400 "Unsupported version"`.
- **The version check runs before authentication.** A wrong or missing version
  header returns the same 400 whether the token is valid, invalid or absent — so
  a version problem masks everything else. Rule out the version first, always.
- **`/api/visits` silently truncates, and paginates differently.** A four-week
  window returned 88 visits covering only **three days**, the rest behind
  `results.nextPage`. Visits page on `nextPageToken` while caregivers page on
  `startAfterId`, so code copied from one to the other looks right and quietly
  returns a fraction of the data. Always follow `nextPage` until it is absent.

> **`nextPage` is a FULL URL, not a bare id** — passing it back as
> `startAfterId` reads page one forever. `index.html` carries `axPageCursor`
> for this; `rosterCursor()` in the `quo` Edge Function is the same rule.

### How the live roster gets in

`ROSTER.hydrate()` runs at boot, before `CLOUD.boot()` takes its baseline
snapshot. It fetches the active roster (`statuses=Active`, two requests, ~1.7s),
maps each record with `AxisRoster.map()`, and re-points any record referencing a
caregiver who no longer exists.

```js
await AxisCare.roster()                       // the mapped live roster
await AxisCare.roster({ raw:true })           // untouched AxisCare records
AxisRoster.report(await AxisCare.roster())    // coverage summary
ROSTER.status()                               // what the last hydrate did
CGVISITS.status('a731') / .info('a731') / .retry('a731')
```

`CGVISITS.info()` returning `count: 0` with `status: 'ready'` means the
caregiver genuinely has no visits — the common case, not a failure.

---

## What AxisCare HAS — the complete field list

These are the only fields that exist. Anything not on this list is not available.

### `/api/caregivers`

Returned at `results.caregivers` as an **object keyed by id**, not an array
(`{ "3": {...}, "8": {...} }`). Clients and visits are arrays — this one is not.
Paginate with `results.nextPage`.

```
id                          number
firstName, lastName         string
middleInitial, goesBy       string | null
gender                      "M" | "F" | null
dateOfBirth, ethnicity      string | null
status.active               boolean
status.label                "Active" | "Terminated" | "Temporarily Unavailable"
                            | "On Vacation Leave" | "Inactive"
classes[]                   { code, label }   ← skills & availability live here
applicationDate, interviewDate, hireDate, startDate, terminationDate
administrators[]            { id, name }
region                      { id, name } | null
referredBy                  { type, id, name } | null
payrollId                   string | null
mailingAddress              { streetAddress1, streetAddress2, city, state, postalCode }
homePhone, mobilePhone, otherPhone, personalEmail
externalId                  string | null
acceptableDrivingDistance   number | null      (miles)
payRate                     string | null
```

**Roster reality:** 643 caregivers, **180 active**. `status.active` is `true` for
*Temporarily Unavailable* and *On Vacation Leave* as well as *Active* — so
filtering on it alone includes people who are not currently schedulable. Check
`status.label` when that distinction matters.

**`goesBy` is a nickname, not a name.** Use `firstName` for display. **78 of 184**
active caregivers have a `goesBy` and for **46** it is not their first name at
all — id 312 is *Lorilyn Federis*, recorded as "Yheen". Naming from `goesBy`
renames a quarter of the roster to something schedulers cannot search for. Keep
the nickname though: `cgNameMatch()` searches both, and the profile shows a
*goes by* chip when the two differ.

**Field coverage across active caregivers** — how often a field has a value,
which is what determines whether a UI column is worth adding:

| Field | Coverage |
|---|---|
| gender, mobilePhone | 99% |
| mailingAddress.city, personalEmail, hireDate | 98% |
| region | 91% |
| payRate | 81% |
| `classes[]` (any tags at all) | **60%** |
| acceptableDrivingDistance | **20%** |

### Caregiver `classes[]` — this is where skills and availability live

There is no `skills` field. Everything about what a caregiver can do and when
they work is encoded as class tags. Counts are across active caregivers:

| Code | Label | Count |
|---|---|---|
| `CFC` / `CMC` | Comfortable with Female / Male Clients | 91 / 89 |
| `GF` / `GM` | Female / Male | 85 / 23 |
| `OWP` | Ok with Pets | 85 |
| `WKDY` / `WKND` | Weekdays / Weekends | 82 / 62 |
| `DL` / `WDL` | With / Without Driver's License | 82 / 22 |
| `ALZ` / `WALZ` | With / Without Alzheimer's Care Experience | 65 / 8 |
| `LH` / `SH` | Long Hours / Short Hours | 62 / 27 |
| `NOVRN` | Nights/Overnight | 57 |
| `AD` | All Day | 55 |
| `MRNNG` / `AFTRNN` | Mornings / Afternoon | 55 / 27 |
| `OC` | Own a Car | 41 |
| `ELC` | Hospice/End of Life Care experience | 31 |
| `HLE` | Hoyer Lift experience | 21 |
| `SS` / `FES` | Speak Spanish / Fluent English Speaker | 14 / 11 |
| `LV` | Live-In | 6 |
| `CNA` | CNA caregiver with certification | 4 |
| `QAG` | Quiet and Gentle | 4 |
| `OWC` | Ok with Couples | 4 |
| `T/S` | Talkative/Social | 3 |

**40% of active caregivers carry no tags at all**, so they yield no skills and no
availability. They should still appear in any roster with empty skills — hiding
real staff would be worse than showing an incomplete profile.

**The class tags are NOT availability, and nothing reads them as availability.**
**93 of the 184** active caregivers have no `WKDY`/`WKND`/`AD` tag, and treating
that silence as a schedule excluded every untagged caregiver from shift
suggestions as *"Unavailable today"*. Availability comes from
`public.caregiver_availability` — see *How availability works*. The fields
`c.avail`, `c.win`, `c.today`, `ops.avail2` and `ops.availOverrides` still exist
on the caregiver record but answer no availability question; they are due for
removal and **should not be given new readers**.

### `/api/clients`

Returned at `results.clients` as an **array**.

```
id                    number
firstName, lastName   string
goesBy                string | null
dateOfBirth, gender   string
status                { active, label }
createdDate, startDate, assessmentDate, conversionDate, effectiveEndDate
administrators[]      { id, name, username }
classes[]             { code, label }
region                { id, name } | null
referredBy            { id, type, name } | null
community             null
medicaidNumber        string
preferredCaregiver    { id, firstName, lastName } | null
residentialAddress    { name, streetAddress1, streetAddress2, city, state, postalCode }
billingAddress        { same shape }
personalEmail, billingEmail, homePhone, mobilePhone, otherPhone, telephonyPhone
priorityNote          string | null
advanceDirective, dnr, will
allergies             string
maritalStatus, spouseName
languages[]
triageLevel           { id, description } | null
externalId            string | null
```

### `/api/visits` — **requires a date range**

Returned at `results.visits` as an **array**. Without parameters it returns
`422`. It needs **one** of: `startDate` + `endDate`, or `updatedSinceDate`, or
`visitIds`.

It also accepts **`caregiverIds`**, which narrows to one caregiver. Be careful
with the name: the singular `caregiverId`, and `caregiver`, `employeeId` and
`caregiverExternalId`, all return 200 and are then **silently ignored**. Only
the plural filters. A query that matches nothing returns **404 `"No visits
found"`**, not an empty array.

```
id                    string   e.g. "s=1543:d=2026-08-21"
client                { id, firstName, lastName, externalId }
caregiver             { id, firstName, lastName, externalId }
scheduledStartDate    what was planned
scheduledEndDate
startDate             what actually happened
endDate
clockIn               { time, method, coordinates, location, telephonyPhone }
clockOut              { same shape }
timezone              "US/Pacific"
service               { id, code, description, procedureCode }
type                  "Hourly"
verified              boolean
removed               boolean
chargeRate            number
billableRateMode      "auto"
modificationReason    string | null
```

The richest endpoint and the most useful one here. Roughly **90 visits a week**.
Because every visit carries both scheduled and actual times plus clock-in/out,
this is what makes real punctuality and hours possible.

### `/api/schedules` — **requires a date range**

Returned at `results.schedules` as an **array**. Needs `startDate` + `endDate`,
or `scheduleIds`, otherwise `422`.

```
scheduleId, planId    number
type, day             string
client                { id, firstName, lastName, externalId }
caregiver             { id, firstName, lastName, externalId }
startTime, endTime    string
startDate, endDate    string | null
frequency             number
timezone              string
service               { id, code, description, procedureCode }
```

Schedules are the recurring *plan*; visits are what is actually on the calendar
and what happened. For "what needs attention today", visits are the right source.

### Also available

`/api/contacts`, `/api/applicants`, `/api/call-logs`, `/api/adls`,
`/api/organizations`, `/api/taggingCategories`, `/api/classes/{type}`.

> `/api/adls` returns the global **catalogue** of ADL types. Its `clientIds`
> filter is silently ignored — the `caregiverIds` trap again.

---

## What AxisCare does NOT have

**Claude: if any of these come up, explain this before writing code.** These are
reasonable things to expect, so don't make it sound like an obvious mistake.

| Wanted | Reality |
|---|---|
| Caregiver reliability %, call-off count, decline count | **No such field.** `null` on real caregivers, rendered "Not tracked". *Derivable* from `/api/visits` — compare `clockIn.time` against `scheduledStartDate`, and treat a visit with no `clockIn` as a no-show. |
| Hours worked this week | **No such field.** Derivable by summing visit durations per caregiver over a date range — which `CGWORK` does. |
| Which clients a caregiver has served before | **No such field**, but easily derived — `/api/visits?caregiverIds=…` returns exactly that. |
| A Mon–Sun availability grid | **Does not exist.** Only the coarse class tags, for 60% of caregivers, and those are *not* read as availability. Per-date rows live in Supabase. |
| A clinical skills list | **Does not exist** as a field. Only class tags. |
| Caregiver photos | **AxisCare has none.** No field, no photo/document/attachment endpoint among the 17 that exist, zero mentions of photo/image/avatar/headshot in its 559KB OpenAPI spec. The photos this app shows are its own. |
| Client medications | **Cannot be fetched.** A limitation in AxisCare's own API — the medications call returns `403` on every client. Not fixable in code. |
| Client care needs / ADLs per client | **Not there.** `triageLevel` and `priorityNote` are null on this account, client `classes[]` are payment type only, and `/api/adls` is a catalogue. Client Concierge holds this; see *The care-needs line*. |
| Caregiver availability | **AxisCare has none.** The calendar shows *assigned visits*, which are real. Open and unavailable blocks are per-date rows a scheduler typed into this app's Supabase table. |
| Anything about pay or overtime | **Nothing usable.** `payrollId` is null on all 185 active caregivers; `payRate` is one flat string with 5 distinct values and no overtime variant; "overtime" appears **zero times** in the 496KB OpenAPI spec. See *It is a WORKLOAD chip, not an overtime one*. |
| Writing anything back to AxisCare | Not possible. The proxy is read-only and forwards GET only. |

The pattern worth internalising: **AxisCare knows identity, status, location,
tags and what happened on each visit. It does not know derived judgements about
a caregiver.** Anything evaluative has to be computed from visit history.

### Client fields that do not exist either

`reqSkills`, `risk`, `hasBackup`, `complaints30` and `missedThisWeek` are not in
AxisCare. Client class tags on this account are **payment type only** (`PVT`
Private Pay, `LTC` Long-Term Care Insurance) — there is no clinical requirement
recorded anywhere, so skill-matching a caregiver to a client has nothing on the
client side to match against.

### Figures that read "Not tracked"

Reliability, call-off counts, decline counts and availability-verification
history are `null` on a real caregiver and render as "Not tracked". Two traps,
both already hit:

- `null + '%'` renders the string `"null%"`
- `null < 85` is **true**, so an untracked caregiver gets flagged as a
  performance concern on evidence that does not exist

Use `hasVal(v)` before judging a figure and `nt(v, suffix)` when displaying one.

> **Hours worked is no longer one of them.** `CGWORK` derives real hours from
> AxisCare visits. The `weekHrs` field is still `null` and still reads "Not
> tracked" — different things, and it is `CGWORK` that has the answer.

---

## Checking what AxisCare really returns

Rather than guessing, look. One URL on the live site:

```
/.netlify/functions/axiscare?action=ping
/.netlify/functions/axiscare?action=status
/.netlify/functions/axiscare?action=get&path=/api/caregivers&q_limit=1
```

Query parameters take a `q_` prefix — `q_limit=25`, `q_startDate=2026-08-21`.
First match down this list is the answer:

| What comes back | What it means |
|---|---|
| `"ok": true` with data | Working. A field missing from the response means AxisCare doesn't have it. |
| `503 "not configured"` | Environment variables missing on Netlify. **Carlo.** |
| `400 "Unsupported version"` | `AXISCARE_API_VERSION` is wrong. **Carlo.** Rule this out before blaming the token. |
| `401` / `403` | Now it really is the token — wrong, expired, or lacking permission. **Carlo.** |
| `422` | Missing required query parameters; AxisCare says which in `axisError`. Usually a missing date range. Fixable here. |
| `400 "not in the allowlist"` | The path is deliberately restricted. Adding one is an environment variable. **Carlo.** |

`status` reports whether the token is present and how long it is; never the
token itself.

---

## What is live and what is sample

**Everything the scheduling desk works from is live AxisCare data. There is no
sample data, and no way to bring it back.** `state` ships `caregivers: []`,
`clients: []` and `shifts: []`, and `hydrate()` fills them from AxisCare. An
empty screen means AxisCare genuinely has nothing, or the fetch failed — and the
banner says which.

| On screen | Source |
|---|---|
| **Caregivers** | Live — 184 active, fetched every load |
| **Clients** | Live — 20 active |
| **Open shifts** | **Mirrored** by `openshifts-sync` into `public.open_shifts`. Falls back to the live scan when the mirror is cold |
| **Caregiver calendar** | Live — each caregiver's own scheduled client visits |
| **Care notes** | Live — swept into Supabase on a schedule. The day review is **summarised** by `carenotes-summary`; the caregiver's own words stay one click away |
| **Communication Logs** | Live — every agency line read from Quo when a profile is opened. *Summary by Devi* saved in `public.comm_summaries` |
| Medication lists | Cannot be fetched. AxisCare API limitation |
| Attendance history | No AxisCare source. Derivable from visit clock-ins, not built |
| Tasks, handoff notes, contact log | The dashboard's own records, entered by schedulers |

### The banner tells you where the data came from

`demoNotice()` renders exactly one of these, in priority order:

1. **Couldn't reach AxisCare** (red) — names the reason, offers Retry, and says
   plainly that nothing is shown rather than something invented
2. **Some AxisCare data didn't load** — a partial failure, naming what failed
3. **This screen has no AxisCare source** — `NO_AXIS_SOURCE` holds exactly two
   entries, **medications** and the **contact log**, each explaining *why*,
   because "empty" and "not available" are different messages
4. **Care notes** — a note about the sync mirror, on that screen only

Do not remove these. If a request sounds like "clean up the banners", the honest
fix is to wire the missing data, not to hide the label.

---

## Care notes are SYNCED, not fetched live

**Claude: do not "simplify" this into a direct AxisCare call.**

A caregiver's shift documentation exists **only** on the per-visit detail call —
`GET /api/visits/{visitId}` → `careNote`, a plain string. The visit *list* does
not include it and there is no bulk notes endpoint, so reading a week of notes
is **one request per visit**: ~170 on this account, ~34s at a polite 5 req/sec.
On page load that would be slow for one person and put the team over AxisCare's
limits. The Client Concierge dashboard hit `429` three times learning this.

```
netlify/functions/carenotes-sync.js     scheduled every 15 min (netlify.toml)
  -> reads visits day by day, NEWEST FIRST
  -> reads each visit's careNote
  -> upserts into Supabase  public.care_notes
The dashboard reads public.care_notes. Zero AxisCare calls.
```

Each run stops at a **5-second soft deadline** (`SOFT_DEADLINE_MS`) and saves a
cursor (`care_notes_sync`), so the next run resumes. Days are swept newest
first, so a run that runs out of time has still refreshed the notes people are
most likely to open. **`done: false` is normal on the schedule** — each run does
~6 visits and 96 runs a day against ~24 new visits keeps up easily.

### Two note types — do not confuse them

| | Endpoint | What it is |
|---|---|---|
| **Shift documentation** | `/api/visits/{id}.careNote` | What the caregiver wrote after the visit. This is what Care Notes Review shows. |
| Office notes | `/api/notes/client` | Notes staff typed on the client record. One cheap paginated list. Not currently used. |

`/api/notes/{entityType}` looks tempting because it is one cheap call, but it is
the second kind — it will not give you what a caregiver wrote about a visit.

### Tuning

Measured: a visit-detail call takes ~600ms, a worked week is ~170 visits.

| Setting | Value | Why |
|---|---|---|
| `SOFT_DEADLINE_MS` | 5000 | Stops with room for one more request. An earlier 7000 overshot to 8.19s, close to a 10s platform limit. |
| `DEFAULT_DAYS` | 3 | The schedule only has to keep up. |
| `FRESH_DAYS` | 2 | Today and yesterday are **always re-read** — a caregiver may still be correcting the note. Older stored days are skipped. |
| `MAX_RATE_PER_SEC` | 5 | Only enforced if AxisCare answers faster than that; at ~600ms it never sleeps. |

Visits with **no** care note are never stored, so they cannot be skipped and are
re-checked every run. A short `DEFAULT_DAYS` is what stops that mattering.

### Manual backfill

```
/.netlify/functions/carenotes-sync?days=14
/.netlify/functions/carenotes-sync?days=14&maxMs=120000   # local only
/.netlify/functions/carenotes-sync?force=1                # ignore the skip
```

`maxMs` raises the per-run budget (capped 600000). The 5s default exists to
survive a platform timeout on the schedule; the **local dev server has no
timeout**, so a hand-run backfill can use 60–120s and finish a week in one pass.
Returns `{ ok, done, written, scanned, skipped, requests, ms, avgRequestMs }`.

The sync writes with `SUPABASE_SERVICE_ROLE_KEY`. Since 2026-09-18 the anon key
cannot even *read* `care_notes`: the browser reads it through `app-gate`.

---

## The day review is SUMMARISED — `carenotes-summary`

The Care Notes page opens on one date and shows one row per client with an **AM
Shift** and a **PM Shift** column. Those cells used to print the caregiver's raw
AxisCare note verbatim under a card headed **Yesterday's Summary** — which is the
one thing a summary section is not.

> The unit is **client × date × shift** throughout — the function calls it a
> *block* and that is what `blockFor()` builds. Only the presentation changed on
> 2026-09-24, from nested bordered boxes to a flat four-column table.

```
supabase/functions/carenotes-summary   POST {day:'YYYY-MM-DD'}
  -> reads public.care_notes ITSELF for that Pacific day
  -> ONE model call for the WHOLE date
  -> upserts public.care_note_summaries, one row per client x date x shift
CNSUM (index.html) reads it; careShiftSummaryHtml() draws it
```

### One model call per DATE, not one per client

A date is ~19 notes across ~13 clients, ~3,400 input tokens — **one small
request**, about **1.8¢**, and the entire history backfills for under 50 cents.
Asking per client-shift would be ~26 requests for the same tokens and would
throw away the one thing a whole-date pass can see: **the same client's AM and
PM read together**, and one client's day beside the next.

### Written once, read back forever

The first person to open a date pays for it; everybody else, in every browser,
reads the saved rows. Measured: **30s to generate, 0.68s on every open after**.
A date nobody opens is never summarised. There is no cron and no backfill job.

A row records `source_sig` — a fingerprint of the **visit ids AND the note
text**. `carenotes-sync` re-reads `FRESH_DAYS = 2`, so a caregiver may still be
correcting a note; a changed note changes the signature and **only that row** is
rewritten. `model` and `prompt_version` do the same for a model or prompt change.

`CNSUM.soon(day)` is called from `viewCareNotes()` behind a **400ms timer**,
because the day arrows re-render this view and paging back a week would
otherwise start a model call for every date passed through. Measured: paging
back six dates fires one call, for the date actually landed on.

**An error is never retried by a render.** `render()` runs on every save and
every 20-second poll, so a failure that retried itself would send one request
per render for as long as the page stayed open. Retry is a button.

### Only the DATE goes up — the function reads the notes itself

**Claude: do not "simplify" this into posting `state.careNotes`.** The browser
is already holding them and it would be less code. It would also let anyone with
the site URL save invented **clinical** summaries into the table and spend the
Anthropic key on any text they liked, because there is no per-person login. The
function reads `care_notes` with the service key, so a summary can only ever
describe notes AxisCare actually holds, and spend is capped at one pass per date
per model.

`care_note_summaries` has RLS on and **no write policy** — the anon key cannot
write it. `app-gate` allows **GET only**, added so Ask Devi can read summaries.

### The fallbacks are the whole safety of the screen

Neither is a placeholder. The page must never be *less* useful than it was
before summaries existed:

| | on screen |
|---|---|
| summary ready | the summary, with the caregivers' names and times above it |
| still coming (~30s on a first open) | **the raw note**, under a strip saying it is summarising |
| failed, or not deployed | **the raw note**, under a red strip naming the reason, with Retry |
| the summary describes more notes than this browser holds | **the raw note** |

A spinner for half a minute is worse than the text we already have, which is why
loading shows the note rather than a skeleton.

#### A summary may only replace notes the page can still SHOW

**The sharpest constraint on this screen.** The summary is read from
`care_notes` **as of now**; the caregivers' names, the times and the **View
Original Notes** button all come from `state.careNotes` **as of boot**. And it
needs no timing at all to go wrong: `fetchCareNotes()` reads `limit=400` against
701 rows, so one date **always** holds a partial set in the browser and a
complete one in the function.

So the function returns `source_count`, and `careShiftSummaryHtml()` shows the
summary only when `sourceCount` equals the number of notes this browser holds.
Otherwise the block falls back to its raw notes. **Claude: do not drop that
comparison.** *View Original Notes* being reachable is the entire licence for
the summary replacing the note rather than sitting above it.

#### An empty date is only an answer once the notes have LANDED

`CNSUM.load()` skips a date the browser holds no notes for — but
`state.careNotes` is filled inside `hydrate()`'s `Promise.all` and
`viewCareNotes()` paints well before that, so opening Care Notes during boot
cached `{status:'ready', units:{}}` **permanently**. `careNotesLoaded()` is the
guard: a date that looks empty while the boot is still in flight caches
**nothing**. A date genuinely empty after the boot finished is still answered
empty.

### The prompt — what it may and may not say

`escText()`, never `esc()`. These are written by caregivers in AxisCare — people
outside the desk — and the model's output is arbitrary text too.

`PROMPT_VERSION` is **6**. The rules that are load-bearing rather than style,
each pinned by what a scheduler would do with a wrong one:

- **Never infer a diagnosis, a cause, a severity or an outcome that was not
  written.** If the note is vague the summary is vague — do not improve it.
- **Never give medical advice**, and never suggest a treatment or medication
  change.
- **Medication names only where the note is reporting what happened** with them
  (refused, vomited, ran out). A routine pass is "medications given".
- A note that says **essentially nothing** is reported as saying nothing.
- **A block may hold more than one note.** The PM window runs 14:00–06:00, so an
  evening and an overnight caregiver both write into it; every note must be
  covered and each caregiver named. v1 described a block as one caregiver's one
  visit and lost a caregiver's whole shift.
- **The caregiver is the subject** — *"Edna watered the plants"*, not
  *"Client was assisted"*. Her first name comes from `care_notes.caregiver_name`,
  the agency's own spelling, never from inside the note body (one caregiver was
  *"Aliyah"* in one block and *"Aaliyah"* in the next).
- **Never characterise the caregiver.** *"Edna reports very minimal detail"* is a
  performance judgement, model-written, saved in a clinical table. The note may
  be thin — say that about the NOTE.
- **WRITE NO NUMBERS.** No clock times, vitals, blood sugars, intake or output
  volumes, doses, or counts of brief changes and bathroom trips. Describe the
  pattern: *"restless and up to the toilet all night"*. **One exception: a figure
  the note shows somebody REACTING to** — a dose repeated because the first did
  nothing, a reading the family was rung about. Once, with what was done.
- **The worked examples are invented people** (Rosa, Mr Alder), and the prompt
  says never to reuse a name, reading or time appearing in the instructions. v4's
  examples used real names off the live board, which a model can mistake for data.

#### The length budget is split in CODE, because the model cannot divide

`DAY_BUDGET_WORDS = 40` is **the client's whole day**, matching the density of
the sample Mitch supplied (11 clients, 399 words, mean 36.3 per client-day). The
earlier cap was 45 words **per block**, so a two-shift client was licensed 90.

Telling the model "40 for the whole client" did not work — it cannot hold a
budget across blocks it writes separately, and a two-block client came back at
83. So `askClaude()` counts each client's blocks, divides, and `blockFor()`
stamps a `Budget: N words` line into each header. Deterministic beats instructed.

**KNOWN: Haiku overshoots a stated budget by about three quarters.** One-block
clients land on median 37 against a stated 40; two-block clients are told 20 each
and write ~35, landing at median 71. That is the whole remaining gap to the
sample. Two levers if it matters: lower `DAY_BUDGET_WORDS` to compensate (tuning
against one model's behaviour, so re-check on a switch), or
`CARENOTES_MODEL=claude-sonnet-5` — ~5¢ a date against 1.8¢, one secret, no
redeploy.

#### `max_tokens` is 16000, and the answer is JSON

`max_tokens` **includes thinking**, and Sonnet 5 / Opus 5 think by default —
`care-brief`, `devi-agent` and `comms-summary` all returned HTTP 200 with an
empty text block on a budget sized for the answer. The rest is thinking room, and
only what is used is billed.

The reply is a JSON array of `{id, summary}`, **parsed defensively**: an unknown
id, a repeated id, a non-string, an empty summary or one over `MAX_CHARS` is
discarded, and a block missing from the answer stays unsummarised — that block
alone falls back to its raw note. Losing one entry beats losing the date.

#### PHI, and what is still redacted

These are clinical shift notes and they go to Anthropic in full. Carlo,
2026-09-23: *"The Anthropic API that we have has the PHI contract."*

Phone numbers, email addresses and links are **still** replaced before the notes
leave the function, and again over the output — not because of the BAA, but
because they add nothing to a summary of somebody's shift, and `comms-summary`
already measured that a prompt rule alone does not hold.

#### Switching the model

```
npx supabase secrets set CARENOTES_MODEL=claude-sonnet-5 --project-ref gdzgoyawavffjdjpjbfz
```

Default `claude-haiku-4-5`. `CARENOTES_EFFORT` (default `low`) is sent to every
model **except Haiku**, which answers `400` to it. **No `temperature`** — Sonnet
5 and Opus 5 reject it, so sending one would make the first switch fail on every
request. `GET …?action=status` reports the model in force.

#### Raised and deliberately NOT fixed

- **A failed read of `care_note_summaries` regenerates the whole date.**
  `savedForDay()` returns an empty map on any error, so every unit reads stale.
  Deliberate, costs ~1.8¢, and a failed read must not become a destructive write
  — `orphans` is empty in that case, so nothing is deleted.
- **A partially summarised date looks like a fully summarised one.** Blocks the
  model dropped fall back to raw notes with no marker. Worth a neutral strip.
- **The first open re-renders ~30s in and moves the card under the reader.**
  Worth preserving the scroll position of the nearest `.cd-crow`.
- **KNOWN: the page's own note list is capped at 400 rows.** `fetchCareNotes()`
  reads `limit=400` against 701 rows, so the oldest ~16 dates render "No AxisCare
  care notes synced for this date" when the notes exist. Those dates stay
  unsummarised until the cap is fixed.
- **Any script that buckets `care_notes` by day must use
  `toLocaleDateString('en-CA', {timeZone:'America/Los_Angeles'})`**, exactly as
  `dayKey()` does. An audit script that sliced the UTC string filed a 19:00
  Pacific note under the next day and reported wholesale fabrication that did not
  exist. This is the same trap that bit the care-notes sync, the caregiver
  calendar and the open-shift mirror — made in the checking tool, which is the
  one place nobody thinks to look.

---

## Open shifts — how they are derived

```
an open shift = a visit that is NOT removed
              + has NO caregiver
              + is scheduled in the FUTURE
```

Both other conditions matter. Drop `removed` and cancelled visits appear as
coverage gaps. Drop the future check and every historical unassigned slot floods
the list.

> An earlier conclusion that open shifts do not exist in AxisCare came from a
> `/api/visits` window that silently truncated to three days *in the past*,
> where every unassigned visit happened to be a cancellation — a biased sample.

`AxisLive.fetchOpenShifts()` scans from **today to the end of NEXT month**, so a
scheduler filling next month's gaps sees all of them. `opts.days` overrides it.
That window costs **14 requests, 1,321 visits, 9.1s** to produce ~12 rows — the
single most expensive thing the boot does, and the reason it is mirrored.

### Open shifts are MIRRORED, not scanned in the browser

The rule is unchanged — it just runs in `netlify/functions/openshifts-sync`
once for the whole desk instead of in every session on every page load.

```
openshifts-sync (*/10, and on read)  ->  public.open_shifts
the dashboard reads that table       ->  2 requests, ~0.7s
```

**13.6× faster, and the records are byte-identical** — verified by running both
paths in the same process and comparing every field. That identity is
load-bearing: `shifts` is a tracked CLOUD slice, so a mirrored record differing
in any field would be diffed into the overlay and written to Supabase as though
a scheduler had typed it. `mirrorRowToShift()` reproduces `mapOpenShift()`
exactly, including building `end` from `new Date(undefined)` when AxisCare gave
no end — an Invalid Date, copied rather than improved.

#### It falls back to the live scan, and that is the point

If the sync has never completed a scan, or the heartbeat is cold, or Supabase is
unreachable, `fetchOpenShiftsMirrored()` returns the live scan. So the first
deploy is a non-event and a dead sync degrades to exactly the app we had
yesterday rather than to a blank coverage board.

**Ageing out reads `last_ok_at`, never `last_run_at`.** Only a run that scanned
the WHOLE window is evidence that a shift missing from the results is no longer
open. A partial run updates `last_run_at` and must not make the mirror look fresh.

#### The deletion rule

A shift leaves the table for two reasons and they are **not** equally safe:

- **evidence** — we looked at that visit and it now has a caregiver, is removed,
  or is in the past. Safe on any run.
- **absence** — we did not see it at all. Safe **only** after a complete scan.

A run that dies half way, hits the page cap, or takes a 429 on page 9 has not
observed the back half of the window, and deleting on that would empty the
coverage board with no error anywhere. That is the whole reason `last_ok_at`
exists separately.

#### A pass never fits in one run, so the NEAR window is re-read every run

A full pass is 16 requests and ~9.6s against a `SOFT_DEADLINE_MS` of 6,000, so
**a pass always splits across runs — that is the steady state, not an edge
case.** A resumed run therefore re-reads chunk 0 (today → +13 days), where a
scheduler adds an unassigned visit, **second, after its first cursor chunk**.
Four rules, all load-bearing:

- **The refresh goes AFTER the first cursor chunk, never before it.** The near
  re-read is *optional* — ground this pass already covered — while a cursor chunk
  is the run's actual progress. Ordered first, a run could spend its whole budget
  on it, advance nothing and repeat forever; simulated at 3× latency the pass
  never completed in 40 runs, `last_ok_at` froze and every browser fell back to
  the live scan permanently.
- **The refresh is best-effort.** On a slow run it is skipped and freshness
  degrades. Progress and boundedness are guaranteed; freshness is not.
- **Only a chunk at or beyond the cursor is progress.** The refresh must not
  advance `cursor_chunk`.
- **Skipping the refresh is NOT a failure.** Recording it as one denied
  `complete`, blocked the sweep and froze `last_ok_at` forever.
- **The sweep is untouched.** Re-reading a chunk only ever *upserts*.

There are **two** deadlines. `SOFT_DEADLINE_MS` may only stop a run that has
advanced the cursor; `HARD_DEADLINE_MS` (9,000) fires regardless, because being
killed by the platform with `running_at` still held is worse than a pass that has
to wait for AxisCare to recover.

#### A cursor is an index, and the chunk list moves at midnight

**This one deleted real coverage, about once a day, silently.** `cursor_chunk`
indexes a chunk list rebuilt from `ymd(now)` every run, and `from` moves forward
at **local midnight** — so every boundary slides one day while the saved index
does not. A pass resuming across that boundary leaves a one-day **hole**, then
reports `complete` and lets the sweep delete every row on that date.

The fix is one line: if the window this run computed is not the window the cursor
was saved against (`window_from`/`window_to`), **start a fresh pass**. Costs
redoing one partial run a day.

#### The cursor may not advance past rows that were never written

The sweep needs *"every row in the window carries this pass's stamp"*, which is
strictly stronger than *"every chunk was read"*. `stored` gates the cursor: if
the write did not land, the cursor rewinds to where the run started. `pass_stamp`
deliberately does not roll — chunks below it were stamped by earlier successful
runs of the same pass. The near refresh is wrapped in its own `try` for the same
reason: a 429 in five optional requests must not cost the run its real work.

`SOFT_DEADLINE_MS` is **6,000, not 8,000**: it is checked *between* chunks, so
the real stop is always one chunk late. At 8,000 a run measured 9,941ms before
its writes — over the 10s platform timeout. At 6,000 runs measure 7.1–7.9s.

That costs one more run per pass, and **is why `MIRROR_COLD_MS` is 90 minutes,
not 45.** `last_ok_at` is the pass START stamp, so it is already one full pass old
when written; a 3-run pass on the ten-minute cron peaks at **~50 minutes** of age
in ordinary healthy operation. Against 45 the mirror would read cold for part of
every cycle and every browser would fall back to the 9.6s live scan — the mirror
built, then not used. What makes 90 safe is that the **near window is re-read on
every run**, so the part of the mirror the coverage board shows is at most one run
old whatever `last_ok_at` says.

#### Stale-while-revalidate

The dashboard reads the mirror and then POSTs to the sync **without awaiting**
it, so AxisCare load follows real usage: a quiet weekend costs nothing. A fixed
5-minute cron would burn ~4,000 AxisCare requests a day regardless. That works
only because the function holds a **lock** and a **debounce** — three schedulers
opening at 9am would otherwise fire three concurrent 14-request scans.

The `*/10` cron in `netlify.toml` is a **floor**, not the mechanism.

**The revalidate half has to reach the session that triggered it.**
`revalidateOpenShifts()` waits on the sync we nudged and, if that run scanned
anything, re-reads the mirror and repaints. Three details in it are load-bearing:

- **It parses the body whatever the HTTP status.** A partial run is the normal
  outcome and the handler answers those `502`.
- **It passes `mirrorOnly`,** so the re-read never falls back to a 16-request
  live scan on a result the caller then discards.
- **It MERGES; it does not replace, and must never call `CLOUD.relayer()`.** An
  earlier version assigned mirror rows straight over `state.shifts` and called
  `relayer(['shifts'])` to put the scheduler's work back. That work comes from
  the local overlay, written only by the 900ms-debounced `doSave()`, so an
  assignment made inside that window existed in memory and nowhere else: the
  replace dropped it, the rebase folded the loss into the baseline, and the next
  save pushed the reversion to all three schedulers. `relayer()` re-applies
  **every** slice, so the blast radius was never limited to shifts either.
  Keeping the existing object for an id already held avoids all of it.

  The cost, stated plainly: a shift **retimed** in AxisCare keeps its boot-time
  hours until reload, because a visit id encodes the date but not the time.

It compares by **id set**, not by count: one shift filled and another opened in
the same window is a real change a count misses.

**A `skipped` answer gets one bounded retry.** Reloading straight after changing
something in AxisCare is exactly what a person does, and a reload inside
`MIN_GAP_MS` (90s) is turned away. Two refusals arrive as `skipped` and need
**opposite** treatment:

- **The lock** (`a run is already in flight`) carries `since` and no `lastRunAt`.
  A run is scanning now, so re-nudging is pointless — wait ~12s and re-read.
- **The debounce** (`synced recently`) carries `lastRunAt` and a server-computed
  `agoMs`. Here a nudge is the point once the debounce expires. **Use `agoMs`**:
  deriving the age from `Date.now()` against a server timestamp puts the viewer's
  clock in the loop, and an unsynced desk running three minutes fast waits too
  little and gives up.

Both then **re-read regardless** of what the second nudge says. The wait is
clamped to 2–100s; **one retry per page load**.

#### `shift_date` is sliced textually, never cast

AxisCare stamps its own offset. `2026-09-18T20:00:00-07:00` is the **18th** where
the visit happens and the **19th** in UTC. Measured on the live mirror: **2 of 9**
rows would have landed on the wrong day under a naive cast. Take the leading
`YYYY-MM-DD` from the string.

#### What the mirror does NOT know

An assignment made inside this dashboard never reaches AxisCare — the proxy
forwards GET only — so a shift filled here stays in the table until somebody
types it into AxisCare. These rows are **open in AxisCare**, not **needs
coverage**.

### The list is refreshed ONCE per load; the ASSIGNMENT is re-checked

After boot and one `revalidateOpenShifts()` there is **no timer and no poll**, so
the open-shift list is as old as the tab. Observed: a visit read `caregiver: null`
in the morning and `caregiver: 1104` by the afternoon — filled in AxisCare while
every open session went on offering it.

Re-scanning the window costs what the boot costs. Re-checking **one** visit costs
1 request, ~890 bytes, ~1s:

```
GET /api/visits?visitIds=v=56967:s=0:d=2026-09-03
```

And the only moment the answer has to be right is the moment somebody assigns. So
`verifyShiftStillOpen()` runs there, and both assign paths funnel through
`guardAssign()`: `assignShift` → `assignShiftNow`, and `doAssign` → `doAssignNow`
(which also covers `dispAccept` and `confirmBlockOverride`). Three rules:

- **A shift with no `axisVisitId` is not checked.** It is an in-app record.
- **AxisCare unreachable does NOT block the assignment.** The proxy is read-only,
  so this record is the desk's own work; refusing to let them work because a
  third-party API is down is worse. It says it could not check. A 404 is
  ambiguous and lands here too.
- **A refusal rewrites nothing.** `openStaleShiftWarn()` explains and offers a
  reload. Silently setting `s.assigned` would be an edit to a tracked CLOUD slice
  the scheduler never asked for and the other two would inherit.

**Claude: do not optimise this into a check against `state.shifts`.** The whole
point is that `state.shifts` is the stale thing.

### What AxisCare does not tell you about an open shift

- **When it became open.** No such field, so `openedAt` is `null`. An "open for 3
  days" figure cannot be computed.
- **Why it is open.** A call-off, a cancellation and a never-staffed slot are
  indistinguishable.

---

## The caregiver calendar — one caregiver's own visits

The month grid plots **their assigned client visits**, live from AxisCare. A
block is one visit: the client's name and the scheduled times.

```
GET /api/visits?startDate=…&endDate=…&caregiverIds=<axisId>
```

**`caregiverIds` is the only parameter that filters** — see the trap above. The
payoff is large: a month of *everyone's* visits is 932 records over 11 requests
and ~7s; one caregiver over **fourteen months** is 351 records in 4 requests and
~2.3s.

**The window** is one month back, twelve months forward — exactly what the month
arrows reach, fetched in one go when the caregiver is opened so paging costs
nothing afterwards. A wide `/api/visits` window normally truncates, so this was
checked: the filtered 14-month pull returned **exactly** the same 351 visits as
fourteen per-month calls, provided `nextPage` is followed. Visits exist that far
out because AxisCare generates them from the recurring schedule.

**An empty calendar arrives as a 404** — `{"results":null,"errors":["No visits
found"]}`. That is an empty calendar, not a failure, and it is common: 126 of 184
active caregivers had no visits in the current month. Anything else would paint a
red error banner across two thirds of the roster.

`CGVISITS` fetches on the first render of a caregiver's calendar — not at boot,
because nobody who never opens a profile should pay for it — and caches per
caregiver. It is deliberately **not** stored in `state`: `state.shifts` is a
tracked CLOUD slice, so a few hundred visits there would be written to Supabase
as though a scheduler typed them.

`CGVISITS.load()` **returns a promise**, which is what lets `recarveOnOpen()` and
`cascadeNextMonth()` react to visits landing rather than waiting for a later
render.

### Three states, and only three

| | Colour | Means |
|---|---|---|
| **Open** | green | the caregiver can take a shift |
| **Devoted** | blue | an assigned AxisCare visit, labelled with the client |
| everything else | red | cannot be assigned |

That last row covers **Unavailable, Off, Other Agency, School, Childcare,
Vacation and Sick**. The label inside the block still says which.

**School and Childcare are not availability.** Someone in class, or collecting a
child, cannot take a shift. `availTone()` — beside the `AVAIL` module — is the
single place that judgement is made; change it, not the call sites. It is
deliberately one line: **Open is green, every other status a scheduler can record
is a reason they cannot work, and reads red.**

A day with nothing recorded draws **nothing at all**. It used to say "Needs
update", which is true of every day of every live caregiver and papered over the
visits that matter.

### Times come from the string, not the browser clock

AxisCare timestamps carry their own offset: `2026-08-01T15:30:00-07:00` is half
past three **where the visit happens**. Reading that through `new Date()` and the
viewer's clock moves it — on a laptop set to UTC+8 that visit files itself under
the 2nd at 6:30 AM. Take the wall clock straight off the string.

### Long client names truncate; times do not

Real names are long (`Duane & Lynne Georgeson`, `Raymond "Nacho" Banales Jr.`)
and a `nowrap` label pushed the month past the panel edge. Three levels each had
to be freed: the grid columns (`1fr` is `minmax(auto,1fr)`), the day cell and
block (a flex item defaults to `min-width:auto`), and the label
(`text-overflow:ellipsis` needs `overflow:hidden`). The **name** truncates; the
**time** is `flex:0 0 auto` and never does.

Client names go through `esc()` before reaching the `title` attribute —
`Raymond "Nacho" Banales Jr.` is a real client, and an unescaped quote ends the
attribute early and mangles the cell.

---

## How availability works

**A caregiver is available only on dates where a scheduler logged an `Open`
block.** A date with nothing recorded means not available. AxisCare class tags
never count. This is Carlo's rule, decided 2026-08-26, and it is deliberately
strict: Find Coverage should never offer somebody the desk has not confirmed.

Rows live in `public.caregiver_availability`, one per segment, keyed by the
**AxisCare numeric id**. An overnight is stored on its **start date** with
`end_min` past 1440, so 8pm–8am is `1200..1920` and reads as `20..32` in the
decimal hours the calendar uses.

**An `Open` block may be timed or whole-day.** Whole-day means free the whole of
*that date*, 00:00–24:00, and the calendar draws it with **no time at all**,
because no time *is* the statement. It covers that date and stops at midnight: a
10pm–2am shift is **not** matched by a whole-day Open, because somebody free "all
day Tuesday" has said nothing about Wednesday. A caregiver who genuinely works
overnight is entered as a timed block.

**A tag paints no further than the day it was typed on.** One day tagged is one
day tagged. (A read-time "carry" that let a future date inherit the most recent
same-weekday Open was removed on 2026-08-28: it contradicted the rule above and
had Find Coverage offering caregivers at 3am on dates nobody had confirmed.)

### The day panel has five tabs

Every day opens on **Availability**; the tab is not remembered between days.

| Tab | What it holds |
|---|---|
| **Availability** | Status, Apply to, Time. The only tab that writes `caregiver_availability`. |
| **Notes** | One note for the day. Its own Save. |
| **Delete** | A month picker and a Delete that clears the chosen days' availability. |
| **Cadence** | Placeholder. `availCheckFreq` is edited elsewhere. |
| **History** | Placeholder. |

**Only Availability has a Save that writes availability.** Cadence and History
have no footer at all — a Save button on a tab with nothing to save is a lie.
**Delete keeps its own date selection** (`modalState.delPicked`), separate from
the Availability tab's `picked`, so a multi-day availability pick can never
become a multi-day delete by accident.

### The day note is NOT part of the availability

**Claude: do not move it back onto the availability row.** It lived there until
2026-08-28 and every one of these was broken by it.

A note is about the **date**, not a block of hours. It lives in
`public.caregiver_day_notes`, one row per caregiver per date:

- it can be written on a day with **no availability at all**
- **replacing** the day's hours leaves it alone
- **clearing** the day's availability leaves it alone
- an **empty** note deletes the row rather than storing a blank, so "has a note"
  is simply "a row exists". A CHECK constraint refuses `''`.

While it was a column on `caregiver_availability`, none of that held: every save
carried `modalState.note` onto the new segments, so editing the hours rewrote the
note and clearing the day deleted it. `dpDraft()` sends `note: null` on every
entry; the column is legacy and nothing writes it.

`NOTES` loads one caregiver's notes over the same 13-month window the calendar
reaches, and `calDayStatus()` reads it for the note marker — not the availability
rows.

> The panel can open before the notes land. `openDayPanel` seeds the box from the
> cache if warm, `NOTES.load()` re-renders when the fetch resolves, and the Notes
> tab adopts the stored note then — **unless the scheduler has already typed**,
> which `modalState.noteTouched` records. Without that flag a slow fetch would
> overwrite what somebody was in the middle of writing.

### AxisCare visits carve, at save time

A Devoted visit outranks anything a scheduler types. Entering **Open 9a–5p** on a
day AxisCare has a visit **1p–2p** stores *two* rows — `Open 9a–1p` and
`Open 2p–5p`. The visit itself is never stored: AxisCare stays its own system of
record, and Find Coverage needs no AxisCare call because the table is correct.

**Only `Open` is carved.** A visit landing on Vacation, Unavailable, School or
Other Agency is a *disagreement between two systems*, not something to resolve
silently — `calDayStatus()` sets `conflict` and the day panel says so.

**A whole-day `Open` is carved too, and loses its whole-day shape doing it.** The
table has no way to say "all day except 1–2pm", so it stores `00:00—13:00` and
`14:00—24:00`. Leaving it uncarved would hand Find Coverage a caregiver already
on a visit, which is the single failure the carve exists to prevent. A deferred
trigger (`caregiver_availability_day_shape_t`) enforces the rest — a day is one
whole-day entry *or* timed segments, never both.

A visit of **24 hours or more is not carvable** (`carvableVisits` treats it as a
`mapCgVisit` artefact) so the block is left standing and flagged.

#### `carvableVisits()` reads THREE dates, not one

A visit and an availability block can each cross midnight, and both are stored on
the date they **start**. So carving date `D` composes three sources into `D`'s own
minute frame, which means a window may legitimately sit outside `0..1440`:

| source | shift | why |
|---|---|---|
| `D` | `0` | a normal visit, and the front half of an overnight |
| `D − 1` | `−1440` | **last night's visit running into this morning** |
| `D + 1` | `+1440` | tomorrow's visit, so an overnight *block* is cut by what it runs into |

The middle row was missing until 2026-09-02: a visit running Sep 7 8pm → Sep 8
6am was **invisible on Sep 8**, so a whole-day Open saved there stored
midnight–6am as free while the caregiver was still on the visit. It affected 21
caregiver-days and neither Find Coverage screen catches it.

`netlify/functions/availability-copy.js` has the same logic in `visitWins()`, and
its visit pull is deliberately **one day wider at each end** — without that the
`D − 1` source is empty for the first date of the window, which is *today*.

Consequences, all deliberate:

- The carve at save time is a **snapshot**; an hourly **re-carve** keeps it
  honest. Read-time carving would not drift at all, but costs an AxisCare call per
  search, which is why it is still not done that way.
- The re-carve only ever **subtracts** — see *a cancelled visit leaves its hole*.
- `dpSave()` **refuses to save** unless `CGVISITS.status(c.id) === 'ready'`.
  `forDay()` answers `[]` for a *failed* fetch exactly as for a day with no
  visits, and storing uncarved availability is worse than storing nothing.
- Visits are **decimal hours**, availability is **minutes**; carve in integer
  minutes. A visit with `end: null`, a zero-length one, or one inflated to 24h is
  *not carvable* — leave the block alone and flag it.
- A visit that merely **abuts** a block carves nothing.
- Re-carving already-carved rows is a **no-op**, which is what makes Add safe.
- `dpSave` reads `existing` **per target date** and writes one `saveDays` call per
  distinct carved result. Reading it once from the anchor copied that day's holes
  onto dates with no such visit.

### The re-carve — the carve corrects itself hourly

**Claude: the save-time carve is no longer the only guard. Do not remove this
pass, and do not widen what it is allowed to touch.**

Added after the desk reported a caregiver reading as whole-day Open on a date he
was assigned to a new client. Nothing was broken in `carveSegs()`: the
availability was saved on the 1st, the visit assigned on the 2nd, and no code ever
looked again. 41 rows across 9 caregivers were wrong roster-wide.

`planRecarve()` in `availability-copy.js` re-derives **every future day that
already holds rows** against the visits AxisCare has *now*, and rewrites the day
if the answer differs. It runs as **pass A** of the hourly `availability-copy` job
(`:35`), before the monthly copy. Four rules, all load-bearing:

- it **never changes a status**. Only `Open` is cut.
- it **never widens**, so it cannot invent availability.
- it **never touches the past**.
- it writes the day back under **its existing author** (`dayAuthor()`), not as
  `Auto-copy` — the panel's history line should still say who decided the
  caregiver was available.

It has **no human-author guard**, unlike `planMonth()`. That is deliberate and is
the whole point: the row that prompted it was authored by a person. It is
**idempotent**, and it has **no cursor** — a reconciliation sweep must restart
from the first caregiver, or it would skip exactly the ones whose visits just
moved.

`recarveOnOpen()` in `index.html` is the browser twin, run from `cgCalendar()`
once `AVAIL.load()` and `CGVISITS.load()` have both settled. It is **instant**
rather than up to an hour later, and `CGVISITS` holds **thirteen months** where
the server sweep pulls 92 days — so days beyond December are corrected here and
nowhere else. It costs no AxisCare call.

> **Claude: this WRITES as a side effect of opening a page.** `recarveDone` is
> what stops it running on every render — do not remove it and do not make it
> depend on anything that changes between renders. `cascadeReset()` clears it
> after a human save.

`AVAIL.saveDays()` and `patchIndex()` take an optional `author` for this: the
re-carve is narrowing somebody else's row, so the day keeps the name already on
it. One call writes one name, so callers must group their dates by author.

### KNOWN, OPEN: a cancelled visit leaves its hole

**Reported by the desk 2026-09-02. Not fixed — do not treat it as a bug to
quietly "solve" without checking, and do not paper over it.**

The carve only ever **subtracts**. Cancel or move a visit in AxisCare and the
availability it cut stays cut: `Open 6a–9p` carved to `Open 6a–8a` does not grow
back. The caregiver reads as less available than they are, and nobody is told.

Why it cannot simply be reversed: **the uncarved intent is never stored.** The
table holds what survived the carve, so there is nothing to restore from.

| approach | cost |
|---|---|
| store the **uncarved** block alongside the carved rows | a schema change and a second source of truth |
| carve at **read** time | never drifts, but an AxisCare call per coverage search |
| re-derive from the **monthly copy's** source shape | only works for days the copy owns |
| a **cancellation feed** — re-widen when a visit turns `removed` | `/api/visits` does return `removed`, so probably the cheapest real fix |

Until then the honest workaround is the one that exists: **re-save the day in the
panel**. Worth surfacing on the calendar rather than leaving silent.

### The shortest block worth storing is three hours

`AV_MIN_MIN = 180`, **strictly under**, defined in *both* `index.html` and
`availability-copy.js` — **keep the two in step** or the copy proposes a shape the
browser would never write and re-proposes it every run.

Coverage is all-or-nothing (`coverageDetail()` returns `full` or `none`, never
`partial`), so a block shorter than the shortest real shift can never put anybody
on a visit.

**`Open` and nothing else.** `Unavailable`, `School`, `Childcare` and
`Appointment` are real statements at any length. `Vacation` is whole-day and never
reaches the test.

**Applied to the whole result, not only the pieces this carve just cut.** A sliver
is a sliver however it got there, and scoping it to fresh cuts made them permanent
— a remnant written on Monday no longer overlaps the visit that produced it, so
Tuesday's carve passes it through. That was briefly the behaviour and it left 17
uncleanable rows.

A block somebody **types** too short is refused in `dpDraft()` with a message
rather than silently dropped. **Exactly 3:00 is kept** — 65 of one caregiver's
rows are exactly 3–6pm. **The drop may leave the day with nothing, and that is the
right answer.**

### An empty day is owned by nobody — `copyClashes()`

**Claude: this is the guard that makes an empty day safe. Do not remove it.**

`AVAIL.copyOwns()` is `segs.length > 0 && every(Auto-copy)`, so a day with **no
rows** passes nobody's ownership test, and the monthly copy writes last month's
weekday pattern straight over a day somebody deliberately cleared. On 2026-09-02
the re-carve correctly emptied two dates and the copy pass **in the same run**
turned `Open 6a–9p` typed by Carlo into `Unavailable all day` stamped `Auto-copy`
— on dates AxisCare has him working.

`copyClashes()` fixes it at the **write**, not at the ownership, so it does not
care how the day came to be empty: *the copy may never write a statement that
contradicts a real visit.* Only `Open` is carved, so a borrowed `Vacation` /
`Unavailable` / `School` shape would otherwise land on a booked date untouched.

A **person** may record that disagreement. A job that copies last month forward
may not manufacture one. It is also the fix for a larger mess of the same kind: a
single August vacation week had become `Unavailable` on **all 61 days** of
September and October, taking an actively-working caregiver out of coverage.

### An overnight answers for the morning it runs into

Availability is stored on the date it **starts**, running past 24. So a search for
Aug 27, 2–3am must look back one day and subtract 24; `AVAIL.carryWindows()` does
that, and `runCoverageSearch` fetches the preceding date for exactly this reason.
A block ending at or before 24 carries nothing, which is what stops every block
becoming a two-day claim. A whole-day statement *on* the morning date outranks the
block that ran into it.

**Partial coverage is never shown.** A caregiver free 10–1 cannot take a 9–5
shift, and listing them costs a call that ends in no. `coverageDetail()` returns
`full` or `none`; there is no `partial`.

**Both Find Coverage screens gate on this, not just the date search.** The
shift-locked list used to *score* availability rather than filter on it — nothing
recorded was worth +4 and stayed in the calling queue, so a caregiver with a
completely blank calendar came second on a shift. Fixed 2026-09-01. **Claude: do
not soften this back into a ranking signal.** The comment that justified it —
"nobody has entered any for the live roster yet" — was true when written and is
not now: 50 caregivers had an `Open` row for one date alone. **An empty calendar
is a no, exactly as "Unavailable" is.**

#### Both screens also check AxisCare for an existing visit

`covClash()` asks **AxisCare**, through `COVHIST`, whether the caregiver is
already on a visit at that hour, and falls back to `assignedDuring()` for shifts
assigned inside this dashboard. The date search used `assignedOnDate()`, which only
knew about in-app shifts, so a stale stored `Open` could offer somebody booked.

The hourly re-carve keeps the table right; this makes the **answer** right in the
minutes before it runs. `dateSearch()` returns `clashChecked` and `unchecked`, and
the screen says which — *checked and clear* and *could not check* are different
answers. Bounded at `COV_CLASH_MAX_DATES` (10), because each date costs a
`COVHIST` window and a range search can name thirty.

> **`COVHIST` caches the derived answer per DATE but the network pull per
> WINDOW** (`fetchWindow`), and that distinction is load-bearing. Keyed per date,
> ten concurrent loads opened ten thirteen-request pulls — ~45 requests in three
> seconds, which AxisCare answered with **429 on every one**, account-wide, so the
> care-notes sweep and the roster hydrate wore it too. Ten consecutive dates share
> two windows.

> **The one-hour overnight trap, twice.** `absorb()` used to read an overnight as
> a one-hour visit (`e = s+1` whenever the end wall-hour was smaller than the
> start), so `covClash()` cleared caregivers for the small hours they were
> working. The same trap sat in `coverageMatches()` on the shift side until
> 2026-09-21: it handed `covClash()` `start + 1` for any shift whose end was not
> after its start, so on every **overnight** shift the double-booking check covered
> the first hour alone. Both now pass the real end, which `covClash()` turns into
> end + 24 — an end *equal* to the start included, which is a 24-hour live-in
> shift. `start + 1` is kept only for an end AxisCare did not give. **Still not
> covered on either screen: a visit that *starts* after midnight**, because it is
> filed on the next date.

The excluded simply disappear; there is no greyed-out section. The one place they
are described is `covEmptyReason()`, which runs **only when the list comes back
empty**, because that is the only time the difference matters: "37 recorded
unavailable" means the desk has asked and been told no, "74 with nothing entered"
means it has not asked. It also separates *still loading* from *failed to load* on
`AVAIL.isLoaded(date)` — the first paint lands before the fetch does, and without
that check the screen accuses the whole roster of being unavailable for a second.

`openFindCoverage()` pulls the **day before** the shift as well, so somebody
working 8p–8a does not read as having nothing entered.

### "Availability missing" counts EVERY status, not just Open

Needs Update's *Availability missing* answers one question: **has anybody told us
anything about this caregiver's current month?** `AVAIL.monthCoverage()` is the
only reader and it counts rows of any status.

It did not always: the query hard-coded `status=eq.Open`, so a caregiver whose
month was fully recorded as **Vacation** read as zero rows and was chased for
availability they had already given.

`coveragePage(from, to, offset, openOnly)` carries the distinction:

- **`openOnly: true`** — *which dates can somebody actually work.* Used by
  `primeCoverage`, feeding Find Coverage.
- **`openOnly: false`** — *has anybody told us anything.* Used by
  `primeMonthCoverage`, feeding this warning.

`monthCoverage()` returns both counts — `days` (any status) and `openDays` — so
the two questions can never be confused again. `state: 'none'` means no rows at
all, and that is the ONLY thing that is honestly "Availability missing". Somebody
down as Vacation all month is `has` with `openDays: 0`: an answer, not a gap.

The month window is re-derived on every call and `monthCovKey` forces a refetch
when the month turns over. The exported `forgetCoverage` drops **both** caches —
it used to clear only the wide one, so a roster re-sync left the month cache stale.

### Two caches, one purpose each

| | |
|---|---|
| `AVAIL.load(c)` | one caregiver, the full 13-month calendar window. Fetched when a profile is opened. |
| `AVAIL.primeIndex()` | **every** caregiver, a week back to the end of next month. One paginated query at the end of `finishBoot()`. |
| `AVAIL.fetchDates([…])` | **every** caregiver, specific dates, on demand. Find Coverage calls this on Search, so any date in the recordable span can be searched. |

What is loaded is tracked as a **set of dates**, not a range — that is what lets
an on-demand fetch answer like any other date. `AVAIL.searchWindow()` is the span
availability can exist for at all (one month back to eleven months on); the date
pickers are bounded by it.

Saving a day marks that date loaded, since the app then knows exactly what it
holds. Without that a later `fetchDates` would pull the same rows in and double
them — and a fetch clears its span before absorbing, for the same reason.

**Find Coverage runs on a button, not on every render.** `state.covRun` records
the dates, times and city that were actually searched, so the results always
describe the search that produced them.

**A search always asks the database.** `fetchDates(dates, true)` re-reads even
cached dates, so a scheduler who has just entered availability — or a colleague in
another browser — sees it without reloading. A stale coverage search is the worst
kind of wrong: it says nobody is free when somebody is, and gives the reader no way
to tell. **Do not "optimise" it back into a cache hit.**

`dayAvail()` judges a date by whether **that date** is loaded, never by whether
the roster-wide prefetch has finished. Gating on the global status meant a day the
scheduler had just saved still answered `unloaded` until the prefetch settled.

Keep the two caches separate. `load()` returns early when its cache has an entry,
so priming it from the narrower window would leave a profile calendar marked
`ready` with months that were never fetched — drawn blank, which reads as
"nothing recorded". Neither belongs in `state`.

### `AVAIL.dayAvail()` returns a state, not an array

**Claude: do not collapse these into a boolean.** Three mean "not available" and
three mean "no answer yet", and the difference is the whole point — a failed fetch
otherwise looks exactly like an empty agency.

| State | Means |
|---|---|
| `open` | an `Open` block; `wins` carries the hours — a whole-day Open reads as `[[0,24]]` |
| `blocked` | rows exist, none `Open` — `label` says which kind |
| `none` | in range, nothing recorded → **not available** |
| `outrange` | outside the loaded window |
| `unloaded` | the index has not landed yet |
| `error` / `unconfigured` | it could not load, or there are no Supabase keys |

Every caller must render the last three as "not loaded" and never as a negative.
`AVAIL.openDays(cgId)` answers the same question over the whole window.

### Where the existing rows came from

Seeded 2026-08-27 from the previous app's `caregiver_availability_overrides` —
**6,693 rows, 138 caregivers, 2026-03-04 → 2026-12-31**. `updated_by` carries the
original author across, deliberately, so the history line says who made the call.

Three things about the old data before trusting a row:

- The old table stored a **window label** (`Anytime`, `Morning`, `Afternoon`,
  `Evening`, `Overnight`) where this one stores minutes, resolved with the old
  app's `TYPE_WIN`. So a migrated `Open` is often exactly 0–1440 or 1320–1800,
  which is a *label*, not hours anyone typed.
- The old table had **no unique constraint**, so an edit left its predecessor
  behind; resolved newest-wins.
- **`Devoted Shift` was a status there** and deliberately is not here — 24 such
  rows dropped. AxisCare is the system of record for visits.

These rows predate the carve, so a migrated `Open` was **never carved against
AxisCare visits**. Re-saving the day in the panel carves it correctly.

### What this replaced

Availability used to be a weekly rule (`ops.avail2`, keyed `Mon`..`Sun`) plus
dated overrides derived from the class tags. The editor was removed in full, along
with `OFF_TYPES`, `NOT_OPEN`, `RULE_STATUS`, `dayAvail`, `availDayLabel`,
`windowsForDay` and the day panel that wrote them. Find Coverage asked about
**weekdays**; it now asks about **dates**, because per-date rows cannot answer
"who works Mondays" without inferring a pattern — the weekly rule coming back
through the side door.

---

## Find Coverage — who can be called, then who to call first

### The client's caregiver gender preference filters

It comes from **Client Concierge**, through `CLMATCH` —
`client_match_prefs.gender_pref`, `'F' | 'M' | null`, synced by
`netlify/functions/matching-sync.js`. **AxisCare has no such field**, so the old
`reqGender(cl.restrictions)` read could never fire: `mapClient()` hard-codes
`restrictions: []` for every real client. 16 of the 21 clients ask for a female
caregiver; none ask for a male one.

`covClientPrefs()` is the single place it is read, and both screens ask it.

| Concierge says | The list holds |
|---|---|
| `F` or `M` | that gender only |
| `null`, or no row | **either gender** — nothing recorded means nobody minds |
| the table has not loaded | **everyone**, and the card says the preference was not applied |

That last row is what `genderKnown` exists for. **Claude: do not collapse it into
`genderPref === null`.** A missing preference and an unread one are different
answers, and silently treating "could not read it" as "nobody minds" would put
male caregivers in front of a client who asked for a woman with nothing on screen
to explain it.

**A caregiver whose gender AxisCare does not record is held back** when a
preference exists, because they are not *known* to be the gender asked for. Every
active caregiver now has one, so it currently excludes nobody. It stays as a guard
for a future hire, and the fix is always to record the gender rather than loosen
the rule.

### How the list is ORDERED — the client first, then the caregiver

The gates above decide **who can be called**. This decides **who to call first**.
Rewritten with Carlo on 2026-09-08; `coverageMatches()` is the only place it
happens. The rule the desk asked for: *what the client wants decides the top of
the list, what the caregiver wants decides within that, and geography breaks what
is left.*

| | Term | Points |
|---|---|---|
| **Client** | On this client's Concierge list | **+60** |
| | AxisCare `preferredCaregiver` | **+50** |
| | Worked with this client **in the last 30 days** | **50 + (visits−1) × 1.5**, capped 70 |
| | Client needs a driver — and `covDrives()` says they can drive clients | +10 (**never a penalty**) |
| **Caregiver** | Client's city is one they asked for | +12 |
| | The drive is more than 20% past their stated `maxMiles`, in **road** miles | −25 |
| | Client's gender matches their own stated comfort / doesn't | +8 / −15 |
| | Shift falls in hours they prefer | +6 |
| Logistics | Drive time | `max(0, 20 − 0.45 × minutes)`: 0…20, the client's own city 20, **nothing if either city is unknown** |
| | 32+ hrs / 40+ hrs already booked in the shift's Mon–Sun week | −8 / −25 |

**The magnitudes are load-bearing, not taste.** Everything on the caregiver's side
tops out at **+26** and drive time adds at most **+20**, so **46** is the most the
caregiver's side and geography can ever contribute. The three terms that say *the
client asked for this person* are each worth more than 46 on their own, so none
can be overturned by preferences and geography. That is what makes "the client
first" arithmetic rather than an average. **Change one of those three and re-check
it still holds.** The driving term is deliberately *not* in that group: it is a
requirement of the placement, not a request for a person.

None of these points is shown. The scheduler sees the order, the client's own
reason as grey text, and amber or red warnings.

#### `match_state` is NAME RESOLUTION, not strength of preference

**Claude: do not score `confirmed` above `auto`.** The first version did exactly
that — +60 "Client's chosen caregiver" against +22 "Suggested for this client" —
and both labels were false. `matching-sync.js` says it plainly: **Concierge owns
which names are on a client's list; this app owns only which caregiver a name
resolves to.** `confirmed` means a person fixed a *name-to-record* resolution,
typically a nickname; `auto` means the name matched first time.

One client lists five names, all equally asked for; exactly one is `confirmed`,
only because Concierge spells her differently. Ranking that one 38 points above
the other four would have been an artefact of spelling. So **every resolved name
carries the same weight**, and `sort_order` — Concierge's own ordering — separates
them. `unmatched` rows carry `caregiver_id: null` and are skipped.

> Concierge's matched caregivers had exactly **one** reader before this — the
> read-only card on the client schedule page — so a caregiver the desk had
> explicitly matched got no ranking weight at all. 53 rows, every one resolving to
> an Active caregiver, and only **6** coincide with the AxisCare
> `preferredCaregiver` the ranker was reading instead.

#### Weekly hours — what ranks, and what does not

**`ops.minHours`, `ops.maxHours`, `ops.minShift` and `ops.maxShift` do not rank
anything.** They feed the Work Preferences card, Needs Update, Recent Updates and
the availability report only.

What ranks is the hours a caregiver is **already booked** in AxisCare in the
Monday–Sunday week of the shift, not counting the open shift itself
(`covWeekHours()` over `COVHIST`): 32–39 is −8, 40 or more is −25. Every other
hours term in the file reads `c.weekHrs`, which is `null` on every live caregiver.

**Do not give the min/max a reader without cleaning the data first.** The minimum
is exactly **20** on 104 of 109 schedulable caregivers — the old demo default,
re-saved by the Work Preferences editor on every save because it writes back what
the form showed. There is no `min_hours` column anywhere. The maximum is a
leftover **40** in the overlay hiding the real `caregiver_profile.max_hours` on 43
of them, and four records hold a minimum above the maximum. Even with clean data,
a minimum-hours boost has about **+3** of room before it could outrank a caregiver
the client asked for.

### The calling list shows warnings only

Mitch's call, 2026-09-21: the green chips were noise. **Claude: do not bring a
green chip back.** Every positive term still scores exactly as before; only its
chip went.

On the live board **every #1 row was explained by green chips alone**, so removing
them outright would have left *Call in this order* with no reason on screen. The
facts that say the client asked for this person moved into `covMatchRow()`'s grey
line instead:

```
Erma Delassio
Preferred · Port Hueneme · ~10 mins away · 8 recent visits
```

The order is Mitch's: **why this row is here, then where they are, then how well
they know the client.**

- ***Preferred*** covers both sources — Concierge list (+60) and AxisCare's
  `preferredCaregiver` (+50). They say the same thing to a scheduler, so they read
  the same; the tooltip names which record it came from.
- **The home city** then the drive: a scheduler knows the county, so "Camarillo ·
  ~15 mins away" says more than the minutes alone. Dropped only when AxisCare has
  no city, where *Drive time not known* stands alone.
- ***N recent visits*** — the thirty-day window is in the tooltip.

*Asked to work in X* was there for one day and came off on 2026-09-22 as noise.
Also unshown by choice: the drive term, preferred hours (+6), client-gender
comfort (+8) and the driving bonus (+10). **A row can sit a few points above
another for a reason not on screen** — the accepted cost of chips-as-warnings.

What is left is warnings, never capped, red first:

| Chip | Colour | When |
|---|---|---|
| Doesn't drive clients | **red** | `covDrives()` says no |
| Driving records disagree | amber | the driving records contradict each other |
| Driving not recorded | amber | nobody has recorded anything |
| Long drive — ~20 min past their limit | amber | more than 20% past their `maxMiles`; the chip states the MINUTES PAST |
| Prefers female / male clients | amber | a *typed* client-gender preference the client does not fit |
| Heavy week — 44 h with this shift | amber | the shift would take them to 40 h or more |
| 39 h that week with this shift | amber | 32–39 booked, but a short shift keeps the total under 40 |

Every chip carries its evidence in a tooltip (`why[].tip`).

#### It is a WORKLOAD chip, not an overtime one

**Claude: do not put the word "overtime" back on this chip.** It was there for a
day, it was wrong, and the reason is a fact about the agency rather than wording.

**This agency pays DAILY overtime — hours over 8 in a shift — not weekly overtime
over 40.** Carlo, 2026-09-23. His example settles it: 4 × 10h + 1 × 4h is 44 h
worked and **8 h of overtime**; the weekly-40 reading calls that "4 h over 40",
half the real figure, from a rule this agency does not use.

It matters more here than elsewhere: the dominant shift is **twelve hours — 265 of
497** — and **71% of all visits exceed 8 h**. Under daily overtime almost every
shift the desk fills generates some.

So the chip claims only what the app can stand behind: **how loaded somebody
already is, and what this shift would make it.**

| booked | the shift | chip |
|---|---|---|
| 32 h | 12 h | `Heavy week — 44 h with this shift` |
| 42 h | 12 h | `Heavy week — 54 h with this shift` |
| 36 h | 3 h | `39 h that week with this shift` — under 40, so no judgement word |
| any | no end from AxisCare | `36 h booked that week` |

**One rule, not two.** The score still bands on hours already booked — −8 at
32–39, −25 at 40+, unchanged — but the wording keys on the total the shift would
produce. The tooltip says the hours are **scheduled, not clocked**.

**Why this app may not talk about pay at all.** AxisCare's API is silent on pay
computation — see *What AxisCare does NOT have*. Its only overtime concept is the
**service code on the CLIENT's schedule** (`STDOT40`, `SROT36` against `STD40`,
`SR38`), a per-client contract somebody chose rather than a per-caregiver
calculation, and not even a premium — `SROT36` bills **lower** than `SR38`. **The
app has no evidence of cost, so a chip may not claim one.**

**KNOWN BETTER, NOT BUILT:** `COVHIST` already holds what a real overtime figure
needs — `Σ over each DAY: max(0, that day's hours − 8)`. Three reasons it was not
smuggled in with a rewording: it must group by **day**, not by visit (two 5 h visits
in one day is 2 h of OT; by visit it would undercount); the scoring bands would want
revisiting; and **the 8 must be confirmed with payroll** — California uses 8 h/day
for household employees under Wage Order 15 but **9 h/day (and 45 h/week) for
personal attendants** under the Domestic Worker Bill of Rights, and which applies
turns on a duty mix AxisCare does not record.

**The daily line is also not checked ANYWHERE.** `covWeekHours()` returns a Mon–Sun
total and nothing in the ranker looks at a single day. With 71% of visits over 8 h,
the rule that actually binds fires several times a week and the board never mentions
it. Its own piece of work, not started.

### What the client asked for rides the HEADER LINE

```
Patricia McGrath  [FULL ASSISTANCE WITH ADLS] [FEMALE ONLY] [NO DRIVING REQUIRED]
                  PREFERS [Cristal Zambrano · not available] [Dummy Caregiver · not available]
Simi Valley · Tue, Sep 29 12:00 PM–9:00 PM
```

It was a four-sentence grey panel, then a label/value table inside the shift card
— but `.emp-row` is `justify-content:space-between` and the page went **full
width**, so the label sat at the far left and the value at the far right, up to
1,600px apart. Chips on the client's own line measured the card **~190px → 72px**,
wrapping cleanly at 1600, 1280, 1024 and 820.

`.cv-fact` is deliberately **grey, not amber**: same pill as `.cc-part` so the line
reads as one run, because the care type is what a scheduler looks for first and
has to keep the only colour on the line.

#### The three states are told apart by SHAPE, not by wording

Easy to break by "tidying". Concierge owns all three facts and they are the
largest terms in the order, so *could not read it* means the list below was built
without them:

| | on screen |
|---|---|
| recorded, and it constrains the search | a chip with the value |
| recorded, constrains nothing (*Either*, no driving requirement) | **no chip** |
| Concierge unreadable or still loading | a **red** chip saying which |

So an absent chip always means *asked, and nothing to apply*, and red always means
*not asked*. **Claude: do not add a neutral chip for the not-recorded case.** It
would make absence ambiguous and put us back where the table started.

`renderCoverageCommand()` returns **`{match, html}`** rather than a string: the
facts have to name which of the asked-for caregivers are on the calling list,
which is only known once that list is built. One `coverageMatches()` run, not two.

> **`.cv-match .emp-v[title], .cv-match .clm-cg{cursor:help}` was doing live
> work.** There is no standalone `.clm-cg{cursor:help}` rule — a `grep -o` makes
> it look like there is by matching the tail of that compound selector. It moved
> to `.cv-client .clm-cg` rather than being deleted. The `.clm-*` rules themselves
> stayed, because the client schedule page's read-only Caregiver Matching card
> still uses them.

### Drive time comes from `DRIVE_TIMES`, not the `CITY` grid

`DRIVE_TIMES` holds **[minutes, road miles]** between two city centres —
free-flow, **no traffic**, the mean of both directions — generated once from
OpenStreetMap routing by `scripts/drive-times.js` and pasted in. The page never
calls a routing service, no address leaves the browser, and there is no key. Read
it through `driveBetween(a, b)` → `{same, min, mi}` or `null`; format with
`fmtDrive()`, which rounds to 5 minutes because city-centre data cannot honestly
say 17.

**Why a table and not a formula over the grid.** `CITY` is a proximity grid, not a
road map. Across its 66 pairs it reads about two-thirds of the road miles and is
up to 27 minutes out; for a Camarillo client — 10 of the 24 active clients — it
put Ventura caregivers closer than Oxnard ones when the drives are 20 and 15
minutes.

| Row | Means |
|---|---|
| `~15 mins away` | the table has the pair; tooltip gives road miles and "without traffic" |
| `Same city` | both in one city, which the row has just named. Not a number: inside Oxnard it could be 5 minutes or 20 |
| `Drive time not known` | a city is missing, blank, or not in the table. Scores nothing |

**Adding a city** is a line in `scripts/drive-times.js` and a regeneration. The
table holds every home city on the roster and every city in the part of AxisCare's
address dropdown we have seen — from [None Set] to Reseda. **The rest of that
list, S to Z, has never been looked at**, so a selection from it can still read
"not known". **The point that stands for a city matters** (moving Simi Valley's
shifted its pairs by 3–4 minutes), so the script keeps them fixed.

> That dropdown spells Chatsworth **"Chattsworth"**, so `CITY_FIX` carries the
> misspelling. It also omits cities already on records (Canoga Park, Granada
> Hills, Agoura Hills, Lancaster…), so AxisCare holds values from outside its own
> list. Do not read the dropdown as the full set.

#### When the city cannot be placed but the postcode can — `DRIVE_ZIP`

*Los Angeles* is left out on purpose: 47 miles across, so no one point answers for
it. **Reseda and Encino are both 60 minutes from Ventura, MacArthur Park is 81**,
Pico-Union 82. So when the city is not in the table, **the postcode decides where
to measure from** (`DRIVE_ZIP`, read through `drivePlace()`). A ZIP is small enough
to place: 90057 covers about 0.9 square miles against Oxnard's 27. The row still
shows the city AxisCare records, and the tooltip says the postcode was used.

**Fix the record where AxisCare offers the right city.** Its dropdown has Reseda;
it has no Encino, which is why 91316 is in the map. `'Los Angeles 90057'` is a ZIP
centroid rather than a place, because 90057 has no neighbourhood name of its own —
it is *Westlake* locally, and `CITY_FIX` already reads "Westlake" as **Westlake
Village**, 40 miles the other way.

> **`zip` has to be added to BOTH mappers.** `AxisRoster.mapCaregiver()` reads
> `mailingAddress.postalCode`, and `toAppCaregiver()` rebuilds the app record field
> by field — a value added to the first alone never reaches `state`. Caught by the
> live page test, not by reading.

The date search says `~15 mins from Camarillo` / `In Camarillo` against the city
the search was **run** with, and nothing at all under *Any city*.

`miles()` stays, still answering a made-up 30 for an unknown city, because its
remaining callers sit on screens no navigation reaches. **Do not give it a new
caller.**

### The caregiver's own preferences — `cgWants()`

Read from `c.prefCities` (111 caregivers), `ops.maxMiles` (115),
`prefVal(c,'clientGender')` (44, plus the CFC/CMC tag fallback), and
`ops.prefTimes` (44).

> `ops.maxMiles` **is real data.** It looks like it might be `deriveOps()`'s
> `[15,20,25,30][id % 4]` default and it is not — only 25 of 115 match that, which
> is chance, and the distribution holds values the formula cannot produce.
>
> **`ops.minHours` by contrast IS fabricated** and must not be given a reader. All
> 181 are exactly `20`, from `deriveOps()`'s `c.weekHrs < 25 ? 20 : 24` firing on a
> `null` — the documented `null < 85` trap. Live caregivers take `axisOps()`, which
> sets both to `null`; the values survive only because `CARRY` faithfully re-emits
> patches from a code path the roster no longer takes.

**`maxMiles` is a penalty, not a gate** — Carlo's call. The hard gates already
decided who can genuinely be called, and somebody who said 15 miles may still say
yes to 18 for a client who asked for them.

**Nothing in `cgWants()` excludes anybody, and it must stay that way.** It also
stays silent when either side is unrecorded: "nobody asked" is not a preference,
and scoring it as one would rank a caregiver on a question never put to them.

`cgWantsHours()` requires **every** band the shift touches to be one they asked
for. A caregiver who picked *Morning* has not volunteered for an 8a–8p shift just
because it starts in the morning.

#### Three places where absence must never be read as a "no"

All three would have docked a real person points — and printed a red chip
asserting it — on evidence nobody entered.

- **Driving is a bonus and never a penalty.** `cg.driver` is `false` whenever the
  `DL`/`OC` tags are simply absent — **18 of 104** schedulable caregivers, 11 of
  whom `caregiver_profile` records as owning a vehicle. A first attempt kept a
  `−20` by requiring an explicit `ops.prefs.driver === false`, and **that guard
  does not hold**: both work-preference editors seed their driver control from
  `c.driver` (the tag guess) and write it back on every save, so a scheduler
  editing only the travel miles launders "never asked" into a recorded No.

  Since 2026-09-21 it is a **warning, still no penalty**. For a client Concierge
  says needs a driver, `covDrives()` answers *can this caregiver drive the
  client?* from stated answers only: these are elderly clients who need to be
  driven, so **"can drive clients"** (`caregiver_profile.can_transport_clients`)
  decides first, and the licence (`can_drive`, the `DL`/`WDL` tags) only when that
  is silent. A value counts as changed on this dashboard when Recent Updates
  recorded a change to **that field** (`covDriveAudit()`) or it now differs from
  the profile row; such a change is the latest word and stands alone.

  **Only these Recent Updates labels count:** *Driving status updated* and
  *Driving updated* for the licence, *Can drive clients updated* for driving
  clients. **Not *Transportation updated*** — that key covered "Has own vehicle"
  and "Can drive clients" together, so a vehicle-only edit logged it while the
  editor quietly saved its seeded guess, giving one caregiver a red chip from a
  value nobody typed. It was split on 2026-09-21; old entries count for nothing.

  | `covDrives()` | Chip | Score |
  |---|---|---|
  | yes | none | +10 |
  | no | red *Doesn't drive clients* | nothing |
  | conflict — can drive clients but no licence, or sources disagree | amber *Driving records disagree* | nothing |
  | nothing recorded | amber *Driving not recorded* | nothing |

  **Never read `ops.prefs.driver` as evidence.** On 2026-09-15 one pass through
  Work Preferences stamped the tag guess into it for all 105 schedulable
  caregivers, 35 seconds apart, with **zero** *Driving status updated* entries —
  no value changed, and every one now looks answered. Needs Update counts that
  stamp as an answer, so it has stopped asking anyone about driving. Known and
  **not** fixed.

  The +10 follows `covDrives()`, not `c.driver`, so a caregiver recorded as a
  driver whose profile says they do not drive clients no longer earns points while
  wearing a red chip.
- **Client gender.** `prefVal()` falls back to the `CFC`/`CMC` tags and reads a
  present `CFC` with an absent `CMC` as *"Female clients"* — but nobody ever ticked
  `CMC`, so that absence is silence. **A tag may earn the bonus and never the
  penalty**; only a typed `ops.prefs.clientGender` can hold somebody back.
- **Preferred cities.** `c.prefCities` falls back to **the caregiver's own mailing
  city** when nothing was recorded, so "Wants to work in Oxnard" would be claimed
  for anyone who merely lives there — and would double-count, since living there
  already earns the full distance score. `c.prefCitiesRecorded` tells the two
  apart and `cgWantsCity()` requires it.

  > **The flag is hard-`false` in the mapper, and `applyProfile()` is its only
  > writer.** The first version derived it as `!!(m.prefCities &&
  > m.prefCities.length)` — but `mapCaregiver` has *already* filled `prefCities`
  > with the mailing address by that point, so the flag was `true` for exactly the
  > caregivers it existed to exclude. A no-op guard that reads like a working one
  > is worse than no guard; it survived one review pass.

> The pattern is the one `hasVal()` and `nt()` exist for, through a different
> door: a boolean `false` that means "never asked" is exactly as dangerous as
> `null < 85`.

#### The travel limit is checked against ROAD miles, with 20% leeway

Until 2026-09-21 `maxMiles` was measured against the `CITY` grid, whose ceiling is
**25**, so a limit of 25 or more (31 of 104 schedulable caregivers) could never
fire. It is now measured against road miles.

**The 20% leeway is deliberate — Carlo, 2026-09-21.** Against road miles with
none, the −25 fired on 2.4× as many pairs, and most of the new ones were within
20% of the limit — inside the noise of where each city's point sits.

**The chip states the EXCESS** — *Long drive — ~20 min past their limit* — and
**the excess is computed from the RAW values and rounded once.** Subtracting the
two rounded figures on screen disagrees with the truth on **19 of the 149** pairs
that fire. `fmtDrive()` carries the hours form, which one caregiver genuinely
needs (Lemoore to Ventura County is 247 minutes against a stated 30 miles).
`driveRound()` floors at 5, so the shortest firing drive reads *~5 min past*
rather than a number this data cannot honestly give.

> **"Long drive" is an absolute word on a relative test, and that was weighed.**
> 25 of the 149 firings are on drives of 25 minutes or less. Carlo chose it anyway
> over *Past their limit — ~20 min further*, for punchiness. Read it as "long **for
> them**".

What the caregiver actually said, in miles, stays in the tooltip — the minutes are
our conversion at this route's own speed and must never read as something they
stated in minutes. The same city, or a city not in the table, never fires it.

#### Preferred cities must go through `normCity` too

`caregiver_profile.pref_cities` is typed by a person and never cleaned, while
`cl.city` has been through `AxisRoster.normCity`. A raw string compare made
**"Westlake"** — which 9 caregivers record — a different place from the **"Westlake
Village"** clients normalise to, so the preference matched nobody and looked
unpopular. `cgWantsCity()` normalises both sides, and `CITY_FIX` gained
`Westlake`, `Westlake Vlg` and `Westlake Village Ca`.

> Worth knowing: the old fabricated 30 miles quietly absorbed every unmapped city,
> so nobody could see which ones were missing. Expect more of these to become
> visible — each is a one-line `CITY_FIX` entry, or a city added to the script.

---

## Adding a Work Preference touches SEVEN lists, not one

**Claude: `WP_TRI` is not the list.** Adding a field to it alone gets you a
control that saves, displays, and is then invisible to every screen that is
supposed to chase it. None of the other lists are derived from it; they are all
written by hand.

| # | Where | What it drives |
|---|---|---|
| 1 | `WP_TRI` | what the editor saves and reads back |
| 2 | the read rows (`row('CNA', yn('cna'))`) | the Work Preferences card |
| 3 | the edit selects (`sel('cna', …)`) | the Work Preferences modal |
| 4 | **`CG_REQUIRED`** | **Needs Update** — "Missing profile information" |
| 5 | **`CG_WATCH`** | **Recent Updates** — the change audit |
| 6 | **`prefVal()`** | the AxisCare class-tag fallback |
| 7 | **`DV_PREF_FIELDS`** (+ the `wantsCg` regex) | recording it through Ask Devi |

Learned on CNA: 4, 5 and 7 were missed and each is a separate visible failure —
the desk is never prompted for the field, answering it leaves no audit entry, and
Devi cannot record it.

**6 has to land in the SAME change as 4.** Adding a field to `CG_REQUIRED` without
a `prefVal` branch chases **everybody**, including the caregivers AxisCare already
answers for — on CNA that was 4 active caregivers who carry the tag and would have
been rung about a certification already on file. The rule: **a tag is a Yes;
silence is silence.** `cgTag(c,'CNA')` returns `true`; no tag returns `null`, never
`false`; and `ops.prefs.cna` is checked first, so a typed No is never overruled.

> **Not every field has a tag**, and inventing one is worse than leaving the branch
> out. Check the class-tag table first: if AxisCare records the fact, seed from it;
> if not, `prefVal` correctly falls through to `null` and the desk is asked.

**The approval card shows the EFFECTIVE value, not the stored one.**
`dactPrefProposal` read `ops.prefs[k]` directly, so a caregiver whose answer comes
from a class tag was described as *"currently not recorded"* while their profile
read **Yes**. Telling somebody they are filling a blank at the moment they click
the button that writes is wrong when they are overwriting a recorded answer.

**One thing must be added alongside `DV_PREF_FIELDS`:** the field's words in the
**`wantsCg`** regex above the loop. Without it, an instruction naming a caregiver
Devi cannot resolve returns `null` and Devi says **nothing at all**, instead of
"I could not find that caregiver."

---

## Where the caregiver photos come from

**Not from AxisCare** — it has no photo of any kind, so there is nothing to sync.
Do not go looking for a sync job; there has never been one.

They live in this project's own Supabase Storage bucket **`caregiver-photos`**,
public-read, one object per caregiver named for the **AxisCare numeric id** (`312`,
not `a312`). 177 photos, 157 of the 173 Active caregivers.

**Claude: `cgPhotoUrl(c, px)` returns the plain object URL, always. Do not
"optimise" it back to `/storage/v1/render/image/...`.** It looks like the obvious
win and it is a billed one: Supabase counts **distinct origin images transformed**
per billing period — not transformations — and the Pro plan includes 100. There are
177 photos, so a single paint of the caregiver list puts the account over on its
own. That is exactly what happened, **167 against 100**. The browser scales with
`object-fit:cover`; `px` stays only because it says how big the slot is.

The resize buys nothing now anyway: every object over 500KB was a PNG, and
re-encoding those 33 to JPEG at their exact pixel dimensions took the bucket
**64.9MB → 11.0MB**, largest object 432KB, objects over 500KB **0**.

**A missing photo is not an error.** Sixteen Active caregivers have none. The row
asks anyway and `onerror="cgPhotoFail(this)"` swaps in the camera placeholder,
covering "never had one" and "could not load it" with one fallback. Supabase
answers a missing public object with **400, not 404**. `loading="lazy"` means only
visible rows ask, so no has-photo manifest is needed.

### Uploading and removing a photo

`CGPHOTO` owns this. **Claude: the UI here is yours to restyle. These seven rules
are not.**

1. **The object key is `c.axisId`, bare, with no file extension.** Not `c.id` —
   that is `a312` and the bucket is keyed `312`. Getting it wrong writes an orphan
   object nothing ever displays.
2. **Never the transform endpoint** (above).
3. **Check the MIME type again after the file dialog.** `accept=` is advisory on
   some platforms, so a renamed file would be stored with a content-type that does
   not match its bytes.
4. **Always store a JPEG, capped at `MAX_EDGE` (512) on the longest edge.** Nothing
   displays above 160px, and with no server-side resize the list downloads
   **originals** — at the old 1433 cap that was ~1.6MB for twenty-five rows. **Keep
   this number and the stored photos in step.** A JPEG that already fits passes
   through byte for byte; a **PNG is always converted** even when it fits (PNGs
   average 1.74MB against 53KB, and schedulers upload straight from a phone, so
   without this the bucket refills at ~2MB a time); and fill the canvas **white
   before drawing**, because every transparent pixel otherwise encodes black.
5. **The cache-buster is only for the session that made the change.**
   `CGPHOTO.stamp()` returns 0 for everyone else, so the normal case stays
   cacheable. On every URL, nothing would ever cache.
6. **Nothing here touches a CLOUD slice.** The filename *is* the id — no database
   row, no `caregiver_profile` column. Keep `ver` / `menuFor` / `busyFor`
   module-level.
7. **Only a genuine not-found counts as "already gone" on delete.** Storage answers
   400 for a missing object, a bad request, *and* on some versions an RLS refusal
   with the real 403 buried in the body — which reported "Photo removed" while the
   photo reappeared in the same frame. Read the body.

Writes go through `GATE.fetch` → `photo.put` / `photo.del`, which enforces rules 1,
3 and 4 server-side too (the key must be digits, the bytes must start `FF D8 FF`).
**Reads are unchanged and still public** — an image tag cannot send a PIN.

> **This app has no `--panel` and no `--bad-tx` CSS variable.** The white is
> `--surface`, the danger red `--crit-tx`. An invalid custom property makes the
> whole declaration compute to `unset`, so the first photo menu had an icon that
> vanished into its own dark circle. Check a variable exists — the palette is
> defined once, near the top of the `<style>` block.

---

## Quo — the phone system. Reads the Communication Logs, and sends texts

Quo was called **OpenPhone** until it rebranded in 2026; every older doc, SDK and
Stack Overflow answer under that name describes this same API.

**The API key sees TWELVE inboxes, not the four the Quo app shows a signed-in
user** — Scheduling, Recruitment, Client Support, Client Inquiry, Emergency
Hotline, Billing, Finance, CEO Direct, Marketing Direct and three Primary lines.
That gap is why the Communication Logs card sweeps every line. Nine users.

It is a **Supabase Edge Function**, because `QUO_API_KEY` is a Supabase secret —
**a commit does not deploy it.**

### Read-only — EXCEPT `action=send`

AxisCare's API is a read API. **Quo's API can act**: roughly half its ~45 endpoints
mutate — `POST /v1/messages` sends a real, billed, irreversible text;
`PATCH /v1/contacts/{id}` is a destructive **replace**, not a merge.

> The proxy accepts **GET, plus POST for exactly one action — `send`**. It cannot
> delete a contact, patch a contact, complete a task or mark a conversation read,
> and no parameter makes it able to.

Agreed with Mitch on 2026-09-14, with the guards below settled *before* any code
was written, and the backstop he named is real: the API key can be deleted in Quo
at any moment. **The next request will be the second mutation and that is a new
decision, not a precedent.**

| | Guard | What it buys |
|---|---|---|
| **1** | **The destination must be on the active AxisCare roster** | The one that matters. Turns "a stranger can text anyone on earth from the agency's number" into "a stranger could annoy our own caregivers". |
| **2** | **`from` must be one of our real Quo lines**, matched against live `/v1/phone-numbers` | The browser picks *which* line; it cannot invent or spoof one. |
| 3 | `SEND_HOURLY_CAP` 200 | Per isolate, so a brake rather than a guarantee. |
| 4 | `SEND_MAX_RECIPIENTS` 25, `SEND_MAX_CHARS` 1600 | One request cannot become a bulk campaign. |

**Guard 1 fails CLOSED and must stay that way.** If the roster cannot be read, or
comes back empty, or comes back *truncated*, the send is refused and nothing is
cached. An incomplete allowlist refuses real caregivers — annoying, and the safe
direction.

> **The roster is read through the app's own PUBLIC Netlify AxisCare proxy**
> (`QUO_ROSTER_URL`), not a second copy of the token — that endpoint is already
> world-readable, which is why it needs no secret duplicated into Supabase. **If
> `QUO_ROSTER_URL` is unset, sending is refused entirely.** All three of
> `mobilePhone`, `homePhone` and `otherPhone` are collected, because the scheduler
> may well be texting the one AxisCare lists second.

Four things a review caught, all now guarded:

- **A recipient's NAME could inflate the message past every length check.**
  `personalise()` used `String.replace` with a **string** replacement, which honours
  `$&`, `` $` `` and `$'` — a template under the 1,600 limit plus a name of repeated
  `$'` produced a **7.5 million character** body, ~49,000 billable segments. Three
  fixes, all needed: the replacement is a **function**, the first name is capped at
  40 characters, and the length is **re-measured after substitution**. It also
  mangled the message of any caregiver whose own name contained a `$`.
- **A tick could outlive the shift it was made on** — the bar counted ticks in the
  queue on screen while the button opened on every tick in the tab, so it read "Text
  1" and opened with five, and the draft is built from the *current* query. The bar
  derives **one** list and hands it to the button, and `seedQueryFromShift()` clears
  `state.covSel`. **Claude: do not "simplify" the button back to a no-argument
  call.**
- **The rate limiter never drained** — it pushed the timestamp *before* comparing,
  so hammering after a 429 kept the window topped up. Only an **allowed** request is
  counted. `RATE_MAX` also moved 120 → 720: one Communication Logs card is 24
  requests, so the old ceiling was five caregiver profiles an hour per scheduler.
- **A stuck roster cursor was recorded as a complete read.** `fetchClients` treats a
  stuck cursor as "done", right for a list and wrong for the thing that decides
  **who may be texted**.

**Test mode is stricter than the old app's**: the destination must be **one of the
agency's own Quo lines**, otherwise "test mode" is an unrestricted send-to-anywhere
with a friendlier label. The roster check still reads the caregiver's number, never
the test destination.

**A send is never retried.** `callQuo()` retries a 429 and a 5xx, which is right for
a read and wrong for a send: a request that timed out **may well have reached Quo**.
`sendOne()` makes one attempt and says honestly that the outcome is unknown. For the
same reason the endpoint answers **200 with per-recipient verdicts** even when some
failed — a status code that invites a blind retry would text people twice.

**`to` carries exactly one number, always.** Quo accepts an array, and a
multi-element array creates a **group thread where every caregiver sees every other
caregiver's number**. The function loops and POSTs once per recipient.

**The key has no scopes** — the same value that lists messages can send them and
delete contacts. There is no read-only key to issue, which is precisely why the
boundary lives in our code rather than in the credential.

### The API's own traps

**Auth is the raw key**, `Authorization: <the key>` — no `Bearer`. (`Bearer <key>`
also returns 200 because Quo strips it, but relying on undocumented leniency is how
an integration breaks during somebody else's refactor.) There is **no version
header** — the version is in the path. **Do not invent a `QUO_API_VERSION`.**

**`maxResults` is REQUIRED on the list routes despite documenting a default of
10**, and the 400 reads like a bug in our proxy:

| Route | Required query params |
|---|---|
| `/v1/messages` | `phoneNumberId` (`PN…`), `participants`, `maxResults` |
| `/v1/calls` | `phoneNumberId`, `participants` — **exactly one**, 1:1 only — `maxResults` |
| `/v1/conversations` | `maxResults` |
| `/v1/contacts` | `maxResults`, capped at **50**, not 100 |
| `/v1/phone-numbers`, `/v1/users` | none, and phone-numbers is **not paginated** |

Paging is `pageToken`; `since` is deprecated for `createdAfter` / `createdBefore`.

**An array is a REPEATED parameter, and `name[]` is a silent trap** — the
`caregiverIds` trap again in a different API:

```
?phoneNumbers=PN0T9aATba      25 rows, ALL from that one inbox
?phoneNumbers[]=PN0T9aATba    25 rows from SIX inboxes — HTTP 200, filter silently
                              ignored, identical to sending no filter at all
```

Repeat the parameter instead, and the **`+` must be percent-encoded as `%2B`** — a
raw `+` decodes to a space, which is a different phone number and not an error. The
proxy uses `params.append`, never `params.set`, which would keep only the last of a
repeated parameter and turn a group lookup into a one-person lookup with no error.

> `participants` on `/v1/conversations` is **also silently ignored**, so there is no
> way to find one person's conversations across lines in one call. That is why the
> card queries per inbox.

**10 requests per second per API key**, shared by everything pointed at it.

**Call summaries, transcripts and recordings all work on this account** —
`/v1/call-summaries/{callId}`, `/v1/call-transcripts/{id}`,
`/v1/call-recordings/{callId}`, all 200, and 14 of 14 answered calls over 45 seconds
came back `completed`. This section used to say they were Business/Scale only —
read from the docs, never tested here, and it stopped a working feature being built
for half a day.

**404 is ambiguous and is not laundered into success.** AxisCare returns 404 for an
empty `/api/visits`; Quo's behaviour on an empty list is **undocumented**. The proxy
returns the 404 with Quo's body intact.

### The secrets

**Supabase** project secrets, not Netlify environment variables.

| Name | Required | Default |
|---|---|---|
| `QUO_API_KEY` | **yes** | — |
| `QUO_API_BASE` | no | `https://api.quo.com` — no trailing slash, **no `/v1`** (every allowlisted path already starts `/v1/`) |
| `QUO_ALLOWED_PATHS` | no | the built-in read-only list |
| `QUO_ROSTER_URL` | **for texting** | unset — sending is refused while unset |
| `QUO_SHARED_SECRET` | no | unset |
| `ALLOWED_ORIGIN` | — | **reused from `devi-agent`** |

**`QUO_SHARED_SECRET` buys less than it looks like.** CORS is enforced by the
browser, so `ALLOWED_ORIGIN` stops another *website* reading replies and does
nothing about curl; and since the dashboard has no login, any secret the *browser*
would send would ship in `config.js` and be public too. It is real protection only
for a server-to-server caller.

What this endpoint reads back — message bodies, call transcripts, client contact
details — is **materially more sensitive than the roster**. Weigh that before the
allowlist is widened.

### The browser module

`Quo` in `index.html`, deliberately a near-clone of `AxisCare`. It sits after every
other module and five lines above `CLOUD.boot();`, where it cannot disturb the boot
order.

```js
await Quo.status() / .ping() / .inboxes() / .users() / .lines()
await Quo.get('/v1/conversations', { maxResults: 10 })
await Quo.send({ from, userId, content, to:[{id,name,phone}] })
await CARE.load(342)    // the care-needs line for one client, via care-brief
```

`Quo.send` is deliberately **not** a generic `post(method, path)`: a helper that
could post anything would invite a second mutation without re-opening the decision
that allowed the first. Query params take the `q_` prefix. Quo wraps list results in
`data`, so a raw `get()` reads `r.data.data`.

**Nothing Quo returns goes into `state`**, and it must not become a `SLICES` entry —
a few hundred messages diffed into the CLOUD overlay is the 323KB bug through a new
door. If Quo data ever needs to persist it gets its own table and module cache, the
way `CGVISITS` does.

---

## Communication Logs — the caregiver card, live from Quo

`CGCOMMS` fetches; `cgCommsPanel` draws. Both are live — **no table, no sync job,
nothing scheduled.**

**It sweeps EVERY line, and that is measured**: Scheduling 110 caregiver
conversations, Recruitment 43, Client Support 30, Client Inquiry 9, the other eight
lines **0**. **111 of 181 caregivers appear.** A Scheduling-only card — what was
first asked for — would have missed 82 conversations, most of them Recruitment,
which is exactly where a new caregiver's first contact lives. `lineList()` reads
`/v1/phone-numbers` once per session, so a new line appears on the next reload with
nobody editing `index.html`.

**24 requests per caregiver** (12 lines × messages + calls), plus `/v1/phone-numbers`
and `/v1/users` once per session; typically 2.3s, worst seen 4.2s. **`CONC` is 4**
because Quo's ceiling is 10 req/s for the whole key, shared by all three schedulers —
at concurrency 5, 24 requests ran at 10.6 req/s and took **four 429s**. The Edge
Function retries a 429 with backoff on top; both halves are needed, the pool keeps
one browser polite and the retry covers two colliding. `userList()` deliberately
**never rejects**, so a failure there costs the staff names and not the sweep.

### `toE164()` is deliberately strict, and that is the safety property

**A loose match here would show one caregiver ANOTHER caregiver's private
messages.** That is the worst thing this card could do, so there is no fuzzy
matching, no last-7-digits fallback and no "close enough". 182 of 183 active
caregivers have a number, every one in the format `999-999-9999`, so the normaliser
accepts that shape, tolerates a leading `1`/`+1`, and returns **null** for everything
else — including extensions, non-NANP numbers, and an area code or exchange starting
`0` or `1`, which a bare ten-digit length test would wave through.

**Nothing is written back onto `c`.** `c.phone` rides the `caregivers` CLOUD slice,
so normalising in place would diff into the shared overlay and replay for all three
schedulers.

Nothing else goes into `state` either — `CGCOMMS` keeps its cache in the module, the
same reason `CGVISITS` does.

### The shape

**ONE row shape serves the card and the modal's rail**, so moving between them is
continuous: glyph · bold heading · timestamp pushed right · a two-line gist under it.

```
(○) Ruffa    Scheduling Department              Sep 10 · 1:52 PM
    "Good afternoon! We're currently updating our caregiver profiles…"
```

**The bold slot holds WHO AT THE OFFICE handled it, not the line** — the line is
usually the same word repeated, while staff names vary and are what a scheduler
scans for. A row with no staff falls back to the caregiver's own first name, which
correctly marks the entries **they** started. The card leads with `Last contact 21
hours ago · 50 calls · 60 texts`.

> **`userId` may not be the person who took the call.** Over 226 calls it is set on
> all of them and `initiatedBy` on none, but `answeredBy` is set on 65 — and on **54
> of those 60** workspace-member cases it names somebody else. So the rail's
> `userId || answeredBy || initiatedBy` very likely names the wrong member of staff
> on a real share of calls; *Summary by Devi* names who spoke instead. **The rail is
> unchanged**: which field it should trust is a decision, not a typo.

**View Details is master / detail, not a longer list** — a 330px rail against a
detail pane, in a dialog of `min(875px, 94vw)`. The two numbers do different jobs:
875 is what Mitch settled on after finding 1340 too big, `94vw` is the
**fit-to-screen guard** below a ~931px window. **Change the px; leave the vw alone.**
330 is the measured floor at which a three-name staff list stops clipping.

> **`.mwide` IS 680px, NOT 880 — there is an `!important` you cannot see.**
> `.mwide{max-width:680px!important}` sits ~70,000 characters further down the
> stylesheet, wedged between `.qs-customtog` and `.rv-grid` with no comment, and
> nothing in the `.modal.mwide{max-width:880px}` rule hints that it is overridden.
> This is why two attempts at widening this dialog **changed nothing on screen**
> while looking correct in the source. **Do not "clean this up" by deleting the bare
> rule** — it would resize every wide modal in the app at once.

The dialog gets its width from its own `.mcomms` class, added in `openCgAll`,
**re-asserted in `renderCgAllModal`** so a re-render cannot lose it, removed in
`closeModal`, and *removed* for any other `which` so switching card type in place
cannot leave a Notes modal oversized.

**The detail pane is one heading, one quiet meta line, then the content** — and the
meta line does **not** repeat the agency line or the staff name, both already bold on
the row just clicked. (A grey `<dl>` facts box held exactly that and was removed as
furniture around a repeat. **Do not put it back.**) A text day shows the whole thread
directly with **no heading over it**; a call shows **Quo's own summary**, fetched on
demand and labelled "from Quo".

**The call summary is lazy and cached by call id** — not fetched during the sweep,
because a caregiver has ~50 calls. Four states, three of which are not failures:
`loading`, `ready`, **`none`** (Quo's own "no actionable details"), and `error`.

**Quo 404s when a call has no summary — that is NOT an outage** (4 of 14 calls on
one caregiver, every one short or unanswered), so `loadSummary` maps 404 to `none`.
And the module's 404 branch checks **whose 404 it is**: our proxy forwards Quo's
status inside its own envelope (`{ok:false, status:404, error}`) while the Supabase
gateway answers a missing function with `{code:"NOT_FOUND"}` and no `ok`. Testing
the status alone told the desk *"The Quo function is not deployed"* **while the
function was serving that very request**. Once a proxy forwards upstream statuses, a
status code alone no longer identifies who answered.

**`renderCgAllModal` preserves the rail and detail scroll positions.** It replaces
`innerHTML` wholesale, so clicking a row near the bottom of a 78-row rail threw the
list to the top — the one thing a master/detail must not do — and the summary landing
a second later did it again.

**The thread IS chat bubbles — reversed on purpose.** The old app avoided them and
the first version here followed it; **Mitch asked for "messenger vibes" having seen
both**, so this is a decision rather than drift. Do not quietly revert it on the
grounds that the old app did it differently — that question was already asked and
answered. Caregiver left, desk right, attribution *under* the bubble,
`white-space:pre-wrap` to keep the line breaks people typed. **An undelivered text
gets a red bubble and "Not delivered"** — one live thread shows the same message sent
twice, both undelivered, before a third got through, which the sender had no way of
knowing. **The RAIL stays a flat list**; bubbles are for reading one conversation, not
scanning fifty.

`cmSel` is module-level and keyed by caregiver, **not** in `state`: it is one
person's cursor inside one open dialog.

> Four layout rules that each fixed a reported wart, kept because each is easy to
> undo by tidying: **row separators are a TOP border** on every row but the first
> (the card clips at a fixed height, so the visually-last row is almost never
> `:last-child` and a bottom border left a stray hairline); **`cmFit()` trims the
> card to a WHOLE number of rows and must run AFTER `pfxFit()`** (which measures the
> *full* list to decide whether *View Details* appears — cap first and the button
> vanishes along with the only way to reach the rest), which is also why **the gist
> is clamped to one line in the card**; **`.pfx-more` loses its `border-top` on this
> card only**, because this card already ends in its own separators; and
> **`.cm-split` is `calc(62vh - 148px)`**, because `.mb` is itself
> `max-height:62vh; overflow:auto` and a taller split put a *third* scrollbar outside
> the dialog — **if the header or summary strip changes height, this number moves
> with it.** A bottom fade was tried instead of `cmFit` and made it worse; do not
> reintroduce it.

### It shows unanswered calls and undelivered texts — the old app hid them

A **deliberate divergence**. The old app filtered them out on Mitch's instruction, in
a card about client conversation summaries. Here the log is for a scheduling desk,
where "we rang her three times and she never picked up" is the point: **30 of 271
calls unanswered** and **9 of 314 texts undelivered** in a 14-caregiver sample.
`answeredAt` is the only reliable mark — a call can read `completed` and still never
have been picked up.

**Timestamps are pinned to US/Pacific.** Quo stamps UTC, and the **text-day grouping
uses Pacific days too** — a scheduler on a laptop set to UTC would otherwise see
yesterday evening's texts filed under today.

**Six states, and three must never read as "no communications":** `nophone` / `idle`
/ `loading` / `error` / partial / ready. A **partial** sweep says so and offers Retry
rather than passing a short list off as the whole log; if *every* read fails that is
an error, not "nothing on file", which would be a confident lie about a caregiver we
learned nothing about.

**Message text goes through `escText()`, never `esc()`.**

```js
CGCOMMS.status('a731') / .info('a731') / .retry('a731')
CGCOMMS.toE164('805-555-0123')
CGCOMMS.deviRetry('call:AC…')
```

---

## Summary by Devi — one or two sentences on top of a conversation

The dialog shows a short summary **above the heading** of whichever call or text day
is open, labelled *Summary by Devi* so nobody mistakes it for Quo's. **Quo's own
call summary stays underneath**, so the two can be compared — the decision, not an
oversight. `supabase/functions/comms-summary` writes it; the model has **no tools**.

**Written once, when opened — never swept.** A summary is written the first time
anybody opens that conversation and saved in `public.comm_summaries`; every later
open, by anybody, reads the row.

| | key | rewritten when |
|---|---|---|
| a call | `call:<callId>` | never, unless the model or prompt changes |
| a day of texts | `text:<lineId>\|<YYYY-MM-DD>\|<+1…>` | the day gains a message |

- **A text entry is one line's texts for one Pacific day**, so today's keeps
  growing; the row stores `source_count` / `source_last_id` and a mismatch
  regenerates. **Quo's count decides, not the browser's** — the sweep reads only 50
  messages per line.
- **The phone number is in the text key.** The dialog's own entry id is
  `<lineId>|<day>`, which two caregivers texted on one line on one day share —
  keying on that would show one caregiver the other's summary.
- **An unanswered call, or one with no transcript, gets no box and no request.**

**Claude: do not "simplify" this into posting the messages from the browser.** Same
argument as `carenotes-summary`: it would let anyone with the site URL save invented
summaries and spend the Anthropic key on any text they liked. The browser sends
`{kind:'call', callId}` or `{kind:'text', lineId, day, phone, count, lastId}` and
nothing else. `GEN_HOURLY_CAP` (400 model calls per isolate) is the brake on top.

`comm_summaries` has RLS on and **no policies at all** — the anon key gets `401` on
select and insert. Deliberately stricter than `care_notes` because these rows
describe conversation content. Names come from the roster through `QUO_ROSTER_URL`,
and **if that read fails the summary is shown but not saved**, so the next open can
name the caregiver rather than leaving "the caregiver" in the table forever.

**Contact details are redacted in code — a prompt rule did not hold.** Version 2
capped the length and **told** the model to leave out contact details; it kept to the
length on all four rows it rewrote and **still wrote an applicant's email address
into one.** So `redact()` replaces emails, phone numbers and links **before they
leave the function** and again over the output, which also means they never reach
Anthropic. Street addresses have no reliable pattern and are left to the prompt.
**Claude: do not remove `redact()` on the grounds that the prompt already says it.**
That is the exact reasoning it replaced.

**Office staff are named from who SPOKE, not from `call.userId`.** On one measured
call `userId` was Marivic, `answeredBy` was Patty, and every office turn in the
transcript was Patty (14) or Ruffa (9); given two answers the model named Marivic
twice and Patty once. The details now list the staff whose `userId` is on transcript
turns, most turns first, falling back to `answeredBy` then `userId`.

**Switching the model** (`COMMS_MODEL`, default `claude-haiku-4-5`;
`?action=status` reports it) is safe for the same four reasons everywhere in this
repo: **every row records `model` and `prompt_version`** and is rewritten on its next
open if either changed; `COMMS_EFFORT` is sent to every model **except Haiku**; **no
`temperature`**; and **`max_tokens` is 4096, not sized for two sentences**, because
it includes thinking. About **$0.001–0.002 a summary** on Haiku; 0.25–0.6s on any
later open.

**An error is never retried by a render.** The summary landing re-renders the dialog
and the render is what asks for it, so **an error or a *pending* state holds until
somebody clicks Retry or Check again.** A day that gains a message still refreshes on
its own, once, because its `gen` changed.

**A deleted conversation's summary is removed only when noticed** — there is no
background job, because checking every saved summary against Quo is exactly the sweep
this design avoids, and the dialog's list comes live from Quo so it is never shown.

---

## Texting a caregiver from Find Coverage

The Text button on a Find Coverage row **sends**, through Quo, from an agency line.
It used to be an `sms:` deep link that opened the scheduler's own phone app, and the
only thing that actually worked was Copy. `QUOSEND` resolves who and which line;
`renderCoverageTextModal` draws; the Edge Function does everything that matters.

### The scheduler picker maps to Quo BY EMAIL

| Picker | Quo member | Email |
|---|---|---|
| Mitch | Marivic Diswe | `services@devoted.care` |
| Sean | Sean Diswe | `sean@devoted.care` |
| Carlo | Jan Carlo Cardama | `jcmcardama@gmail.com` |
| Mae | Ruffa Mae Golingho | `maegolingho@gmail.com` |
| Jen | Jenn | `jendevotedcare@gmail.com` |
| Angelica | Angel Lano | `angelicalano24@gmail.com` |
| Patty | Patty Solis | `hrdevotedcare@gmail.com` |
| Tine | Kristine Opalda | `schedulingdevotedcare@gmail.com` |

**Not by name**, because the two lists genuinely disagree and always will — and Quo
records Jen as `"Jenn "`, with a trailing space. **Not by Quo user id**, because an
id is opaque: nobody reviewing the file can tell whether `USpODQ2ABD` is still
Marivic, and a member removed and re-added gets a new one. An email is stable and
checkable by eye. `QUOSEND.who()` prints the resolved mapping.

**A name with no mapping is not an error** — it sends with no `userId`, Quo applies
its default, and the caregiver sees the same line number either way. Guessing a
colleague would be worse.

**Send as depends on Send from, and is re-derived when the line changes.** Quo
requires the sender to be a **member of the line**, and they differ sharply —
Scheduling carries all nine, Recruitment two. Silently sending as somebody not on the
new line would have Quo reject it for a reason the screen never mentioned. When the
person on shift is not on the chosen line the modal says so, and *"Quo's default
sender"* is an explicit option rather than a hidden fallback.

**One recipient reads their own name; several read `{name}`.** With one recipient the
first name is baked in, because the scheduler should read the exact words that will
arrive; with several the draft carries the literal `{name}` and the Edge Function
replaces it per recipient. Without that, a batch built from the first ticked
caregiver greets **everyone** by that one person's name.
`buildCoverageText(cgId, key, multi)` takes the flag and **both** call sites pass it.
`personalise()` deletes every **other** `{token}` rather than transmitting it.

**The checkboxes send each person their own private message** — explicitly **not** a
Quo group thread. Mitch asked for them and said group texting was not wanted yet. A
caregiver with no phone number gets **no checkbox at all**, because a tick that
cannot become a text is a promise the screen does not keep. After a send, **only the
recipients who actually received it are unticked**, so a retry is one click.

**`state.covSel` is per-browser and must never go into `SLICES`** — anything there is
diffed into the shared overlay and applied to the other desks on their next poll, so
one scheduler's ticks would appear under another's cursor mid-sentence. Not in
`localStorage` either: a selection should not outlive the tab.

**Nothing is written to `state.contactLog`**, deliberately.
`renderCoverageCommand()` drops anybody in the contact log out of the calling queue,
so logging a text would make the caregiver disappear from the list the moment the
message went out — before they have had a chance to reply. **Sent texts appear on
that caregiver's Communication Logs card**, live from Quo.

> **The Assign button is gone from Find Coverage** (Mitch, 2026-09-14): it had no
> working behaviour behind it on this screen. `dispAccept` and `assignShift` are
> untouched and still reached from the Today board, the Auto-offer modal and the
> quick-contact modal.

### A client's name in an outbound text is the GIVEN NAME ONLY

`shortClientName()` — "Brenda Janowski" becomes **"Brenda"**. A caregiver being
offered a shift does not need the client's legal name, and a text is forwarded,
screenshotted and read on a lock screen.

**The given name is kept whole**: "Mary Lou Brown" is *Mary Lou*, "Duane & Lynne
Georgeson" is *Duane & Lynne* — a couple, so dropping half would be wrong rather than
brief. **A suffix is not a surname**: AxisCare stores `"Calvin George"` / `"Miller
Jr"`, so taking the last word off keeps *Miller*, the very thing this exists to
remove. Strip the suffix first. **Outbound only** — every screen the desk reads keeps
the full name.

### ONE non-GSM-7 character doubles what a message costs

An SMS is GSM-7 until it contains a character outside that set — an **en dash, em
dash, curly quote or ellipsis** — at which point the whole message becomes UCS-2 and
a concatenated segment drops from **153 characters to 67**. **12 of the 14 outbound
templates were paying that, for a single en dash in the time range**: 45 segments
where plain ASCII is 25. Use `-`, `'` and `...`. A regression test renders every
template and asserts it stays GSM-7.

---

## The care-needs line — `care-brief`

The **Weekend availability** template carries one line describing what the caregiver
would be taking on, so they know before they say yes. Four blocks separated by blank
lines; with no care-needs line the block is **dropped entirely** so the blanks close
up rather than leaving a gap where the care needs should have been.

```
Hi Maria, are you available for weekend coverage with Brenda?

Saturday, 8:00 AM-8:00 PM - Camarillo

Care needs: Wheelchair dependent, hands-on for all transfers, help with
toileting, bathing and dressing, reposition every 2 hours, high fall risk.

Please reply YES if you're available and comfortable with these care needs.
Thank you.
```

**Claude: do not go looking for care needs in AxisCare.** There are none — see *What
AxisCare does NOT have*. Client Concierge holds it, in
`concierge_records.data.careNeeds` plus the `fallRisk` / `cognitive` / `hospice`
columns; **18 of 18** active clients have usable content there. (Concierge's own
`caregiverBrief` was the first plan and was abandoned on measurement: it exists for
**1 of 18** clients and runs to ~600 characters.)

**The function fetches its own data — that is the PHI design.** It reads Concierge
itself and returns only the finished sentence. The obvious design — browser reads the
record, posts it up to be summarised — would make every client's mobility, continence
and cognition readable by anyone with the site URL. **The raw clinical record never
reaches the browser and is never stored in the Scheduling database.** There is no
`fields` parameter: a caller passes a client id and gets a sentence.

### "Do NOT include medications" — three layers, because a prompt is a request

1. **A narrow set of fields is read**: `mobility`, `personal`, `adl`,
   `transferAssist`, `ambulation`, `standLong`, `safety`, and the structured
   `fallRisk` / `cognitive` / `hospice`. `medManage`, `medInstr`, `routineAM`,
   `routinePM`, `routineDay`, `feeding` and `other` are **never read** — every one
   holds drug names on this account.
2. **Every field read is filtered, per SENTENCE**, so a medication sentence is
   dropped and the rest of the field kept. One client's `personal` field is *"Assist
   with dressing. Velcro compression wraps. Changing briefs about 2-5x daily. Wipe
   his eyes after glaucoma drops. Soft neck brace at times."* — dropping the field
   would lose four things a caregiver needs.
3. **The output is filtered by the same detector, then read by a second model** asked
   one question. A YES, an unparseable answer, or a failed check all discard the line.

`skipped` in the response says exactly what was held back — `["personal (1
sentence)", "cognitive"]` — so a scheduler can see something was removed rather than
wondering why a line reads thin.

**A LIST OF DRUG NAMES CANNOT WORK.** The first version was a 25-name denylist and it
missed **48 of 51** realistic home-care medication strings; two of its own entries
could never fire (`\bmg\b` cannot match `"10mg"` — no word boundary between a digit
and a letter — and `\bstatin\b` cannot match `atorvastatin`), and `SAFE_FIELDS` had
no filter at all. The regex now covers only the parts that are **closed** — dose
amounts with or without a space, sig abbreviations, forms/routes/devices, and
generic-name **suffix families** (`-statin`, `-sartan`, `-xaban`, `[aeiou]lol`,
`-prazole`) — and the model handles the rest. **94% missed → 8%**, zero false
positives on real care text.

Three details worth keeping: `{2,}` not `{3,}`, because *losartan* is lo+sartan;
`[aeiou]lol` not `olol`, because only metoprolol and atenolol end "olol" —
*carvedilol* ends "ilol"; and `iv` is deliberately **not** in the sig list, because
case-insensitively it matches the "IV" in *Calvin Miller IV*.

**The checker runs at `temperature: 0`**, and knows equipment is not medication. It
called "Velcro compression wraps" and "soft neck brace" medication — a garment and an
orthotic — so the prompt lists explicit negatives; and the **same sentence** got YES
three times and NO twice, which is worse than either answer because nobody can
reproduce it.

Two prompt rules that are not style: **`max_tokens` is 4096** (at 1024, **4 of 18
clients returned empty and 3 more were cut off mid-sentence** — thinking again); and
**no umbrella terms**, because asked for a shorter line the model wrote *"full
personal care at bedside"* instead of naming toileting and bathing, and a caregiver
cannot decide whether they can take a shift from a category name. `personal care`,
`ADLs`, `full care` and `assistance as needed` are forbidden and a test asserts none
appear. `TARGET_LINE` (170) and `MAX_LINE` (200) are deliberately different: asking
for the number you will enforce leaves no room to finish a sentence.

**Send is disabled until the line has generated.** Sending a weekend offer with the
Care needs section missing is the one mistake this feature exists to prevent — the
caregiver would be asked to confirm they are "comfortable with these care needs"
without having been shown any. **Only "still coming" blocks Send**: nothing recorded,
or a line written and discarded, are *finished* answers, and `ctCareWarn()` explains
which. Other templates never wait.

`CARE` caches per client per session, and an edited draft is **never** overwritten
when the line lands — `buildCoverageTextWithout()` tells an untouched draft from the
scheduler's own words.

> **`.q-b` must set font-family and line-height.** A `<button>` inherits neither, so
> the Text BUTTON rendered in Arial at `line-height:normal` (24px) beside the Call
> ANCHOR in Inter (28.09px) — same class, same padding, two typefaces. `1.4` is
> exactly what the anchor already computed, so buttons grow to match and nothing else
> moves. Shared class, so this also squares up Skip, Decline, No answer and Callback.

---

## The Caregiver Overview — four cards

```
Communication Logs     Notes
Client Feedback        Client Complaint
```

### Client Feedback and Client Complaint are ONE store

Both read and write `state.cgConcerns`. **There was no backend change** — entries
live in the `scheduler_state` overlay JSON, so the split is `index.html` only. Two
slices was the alternative and costs more than it looks: a new slice path means the
shared overlay has to be migrated and every open tab refreshed at the same moment,
or a tab still running the old code writes the entries back under the old path.

`fbKind(f)` is the only place that decides which card an entry sits on:

| Entry | Card |
|---|---|
| `kind: 'feedback'` or `kind: 'complaint'` | that card. A saved kind always wins |
| no kind, `type` Concern or Complaint | Client Complaint |
| no kind, `type` Positive Feedback, or no type | Client Feedback |

**Client Feedback has no type**: it is a note. **Client Complaint requires Concern
or Complaint**, with nothing pre-selected, and the type picker comes before Notes.

**Claude: do not bring back a Positive Feedback type, and never infer a type from
the words.** Only the person who took the call knows whether an entry is a concern
or a complaint.

**The Reliability concern badge counts Complaint, not Concern.** An entry typed
Complaint raises the red badge; a Concern does not. The persona summary counts all
three kinds, so a Concern is still mentioned there.

Entry text on both cards goes through `escText()`. The Notes card beside them still
uses `esc()` in its text position, which does nothing about a `<` typed into a note
— left alone because it is outside that change, but it is the same trap.

> **The Updates card is gone**, with its composer, `state.cgUpdates`, its `SLICES`
> entry and the `.cgp-scroll` CSS only it used. The slice held **0 records**.
> `{ path:'updates' }` in `SLICES` is **a different feature** — Operations Updates,
> which Devi posts internal scheduling notes to. Untouched.

---

## The Caregiver Profile — Skills and Experience

```
Work Preferences                       (full width)
Employment Summary     Client Blocks — Do Not Assign
Skills                 Experience
Personality            Hobbies & Interests
```

| Card | Options | Free text |
|---|---|---|
| **Skills** | Mobility & Safety, Personal Care, Daily Living Support — 19 options | `skillsNote` |
| **Experience** | Dementia / Alzheimer's, Parkinson's, Stroke, Diabetes, Hospice, Post-hospital recovery, **Others** — listed flat | `experienceNote` |

Experience has no group heading: a lone "Care Experience" heading under a card
titled Experience told the reader nothing and made a ticked Others read as "Care
Experience: Others".

**No backend change.** Both are fields on the caregiver's `cgProfiles` record.

### One stored list became two, and the first save must write both

Until the split, every tick on either card lived in `cgProfiles[].skills`, and on
the day **61 of the 68 filled-in profiles** held Care Experience ticks there.
Nothing was migrated. Instead:

- **Experience reads `p.skills`** until it has an `experience` list of its own.
  `cgChips()` keeps only each card's own options, so the two never show the same
  tick.
- **The first Skills save also writes Experience's list** (`pair` on the Skills
  field, applied in `chipSave()`). Once `p.experience` exists it does nothing.
  **Only Skills carries `pair`** — an earlier version put it on Experience too, so
  saving Experience froze a copy of a seeded Skills card and it stopped following
  the AxisCare tags.

**Claude: do not remove the `pair` write.** Saving Skills rewrites `p.skills` with
Skills options only. Without it, every Dementia, Hospice and Parkinson's tick
disappears from Experience the moment somebody saves Skills — on 61 real
caregivers. `skills-exp-test` and `skills-exp-ui-test` both pin it.

### What else reads them

`CG_REQUIRED` has a **Skills** row and an **Experience** row; a tick or the
"Anything else" line answers either. **Others** exists because Experience is
required — without it a caregiver who has never cared for any of the six named
conditions would stay on Needs Update with nothing they could honestly tick.

Recent Updates logs *Skills updated* and *Experience updated*, including when only
the free-text line changed, because that line now answers Needs Update and a
cleared row must say who cleared it. The persona sentence (`cgAbout`) reads
Experience first, then Skills, and never names "Others". **The resume does not read
these cards** — it reads `c.skills`, the AxisCare class tags.

---

## Ask Devi — the local router first, Claude for the rest

Two answerers, not interchangeable.

**`aiAnswer()` answers first.** A regex router over about twenty report builders
(`aiAvailable`, `aiCallOffs`, `aiOpenShifts`…). Its answers are *computed from the
real tables*, instant, and free. It is not a fallback — it is the primary.

**`deviAsk()` takes what the router could not match.** `aiAnswer()` returns
`fallthrough:true` where it used to say "Not sure I caught that". That is also, with
no extra machinery, how **follow-ups** arrive: "why?", "what about Saturday?", "who
else?" match no pattern, so they land in Devi with the whole conversation behind
them.

### It is ONE page — the dock was removed 2026-09-22

There was a sticky strip at the bottom of every page. Mitch had it removed — a bar
pinned to every screen is a cost every page pays for something opened occasionally.

**What it bought, stated plainly, because rebuilding it is a real option:** a
question could be asked *without leaving the page it was about*. That was the
original request, and giving it up is the whole trade.

### The composer is the sibling apps', not its own thing

Three apps the same desk uses all day should not each have their own idea of what
asking looks like, so this one follows Client Concierge and Finance:

```
+-------------------------------------------------+
|  Ask Devi anything - or ask it to record        |   <- textarea, 3 rows
|  availability, a work preference or a task...   |
+-------------------------------------------------+
  [ * Suggested questions ]  Changes need your approval     [Clear] [Ask]
```

- **A `<textarea>`, not an `<input>`.** Instructions are the longest thing typed
  here and they were the thing the one-line box hid.
- **Enter sends, Shift+Enter is a newline.**
- **Every example sits behind the one button** — all 26 `AI_EXAMPLES`, including
  the two instruction shapes, which are the only thing telling a scheduler that
  Devi can be *told* to do something.
- **"Changes need your approval" is Finance's line**, and it is true here for the
  same reason.

#### The composer is at the FOOT of the page, on an empty thread too

The page is a full-height flex column: the thread takes the slack and scrolls, the
composer is the last row. On an empty thread that leaves the box at the bottom with
a screen of white above it, which **looks** like a defect and is not.

**Claude: do not "fix" that white space.** It was fixed once, with an
`.ai-wrap.start` class that opened the box at the top of an empty page. Carlo
reported it within the hour — *"why is it in the upper left corner and not in the
bottom similar to Concierge and Finance?"* — and it was reverted the same day. A
composer that moves depending on whether you have asked anything yet is worse than
one that sits still in a wrong-looking place. The suggestions stay **collapsed** for
the same reason.

#### The chat is FULL WIDTH, and it took a scoped rule — `.ai-wrap` is two screens

**`.ai-wrap` is used by two unrelated screens**: `viewAssistant()` here, and
`guideAiForm()`, the guide library's AI-assisted draft form.

| where | rule | |
|---|---|---|
| the Ask Devi CSS block | `.ai-wrap{max-width:880px}` | looks authoritative |
| the guide library block, ~1,100 lines lower | `.ai-wrap{max-width:620px}` | **wins** — equal specificity, later in the file |

**This is the `.mwide{max-width:680px!important}` trap again.** When a width on this
page does not match its rule, look for a second owner of the class before touching
the rule you found first.

```css
.v-assistant .ai-wrap{max-width:none}     /* (0,2,0) beats the guide's (0,1,0) */
```

Renaming the class on one of the two screens is the tidier fix and a much larger
diff — every rule in both blocks, plus `.ai-card` / `.ai-h` / `.ai-sub` / `.ai-go`,
which the guide form also owns and the composer must not reuse. **`.ai-card` is
taken**; the composer's own classes are `.ai-ta`, `.ai-tools`, `.ai-sugbtn` and
`.ai-approve`.

> The cost: on a wide monitor an answer's text runs the full width. `.ai-ask` still
> caps at 80%. If the desk finds the answers too wide, the fix is a max-width on
> `.ai-ans` — **not** on `.ai-wrap`, which would narrow the composer again.

### The answer TYPES, and the thread behaves like a chat

**Concierge and Finance do not do the same thing.** Concierge has **real SSE
streaming and no typewriter at all** — zero `@keyframes` and zero `animation:` rules
in 20,961 lines, so what looks like typing there is the model's tokens arriving; do
not go looking for a `typeOut()` in it. Finance streams **and** typewrites on top
(`setTimeout(…,16)`, step `max(2, ceil((n−s)/24))`).

**Finance is the one copied**: it is the only one with a typewriter, its
`faiTypeTo()` is fed a complete string on its non-streaming fallback path so this
needed **no Edge Function change**, and Concierge's scroll pin is unconditional,
which is a defect — scroll up to re-read and it yanks you back with no escape.
Finance pins only within **80px** of the bottom, which is the rule copied here.

`.ai-thread>*:first-child{margin-top:auto}` is the whole placement fix, the one line
both siblings carry with the same warning: **not** `justify-content:flex-end`, which
clips overflow in a scroll container.

**The page scrolled, not the thread.** `.ai-thread` has always been `flex:1 1 auto;
overflow-y:auto` — but **an element only overflows inside a BOUNDED parent**, and
`body.ai-white .main` was `min-height:100vh`, which grows. So the column stretched
with the conversation, the page scrolled, and the composer slid out of reach.
`aiScrollToBottom()` was a no-op for the same reason. Both siblings bound it with a
magic number; **Scheduling needs none**, because its topbar is a flex child:

```css
body.ai-white .app {height:100dvh;min-height:0}
body.ai-white .main{min-height:0;overflow:hidden}
body.ai-white .view{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
```

Flex does the arithmetic, so it is exact at every width and cannot drift when the
topbar changes height. Scoped to `body.ai-white`.

**`render()` carries what is half-typed, and the thread's scroll position.** It runs
on every save and every 20-second poll and rewrites the view wholesale — so a poll
landing mid-sentence emptied the box, and a long conversation jumped back to the top
every 20 seconds while somebody was reading. It now carries both, with Finance's
80px rule: follow the conversation when the reader is at the foot of it, leave them
where they are when they have scrolled up.

**The counters live in `state.aiLog`, never in the DOM.** `e.live` (the raw text)
and `e.shown` (how much of it) are fields on the turn, so the poll destroying and
recreating the node costs **one frame**. In the DOM, every poll would restart the
animation from zero. The 16ms timer is module-level, drives every live turn at once,
and **stops rescheduling itself** when none is left. `document.hidden` and
`prefers-reduced-motion` both jump straight to the end.

**It types the RAW TEXT and re-renders — never the HTML.** `aiLiveHTML()` slices
`e.live` and runs it through `deviRender()` every frame. Cutting `deviRender()`'s
*output* at N characters would bisect a tag, an entity or an attribute and reopen
exactly the injection path `escText()` exists to close.

**ONLY DEVI'S ANSWERS TYPE.** A router answer is computed in under a millisecond and
its `html` is built markup — tables and lists — not model prose. Animating it would
mean slicing rendered HTML, which the rule above forbids.

> The honest cost: Concierge's streaming **removes** dead air (~15s → ~2s). A
> typewriter over an answer already in hand **adds** about 1.6s to a
> 1,200-character reply. That was the accepted trade for a change needing no
> deploy. **Real streaming is still worth doing** and is a separate piece of work:
> `stream:true` in `devi-agent`, an SSE reader in `deviAsk()`, and Concierge's
> content-type sniff so the page and the function can deploy in either order.

#### A caregiver first name must match as a WHOLE WORD

`"yesterday".includes("ester")` is **true**, so every question containing the word
*yesterday* was answered with Ester Siron's profile card — **4 of 10** ordinary
scheduling questions hijacked, on a desk whose care-note screen is literally
*"Yesterday's Summary"*.

```js
new RegExp('(^|[^a-z0-9])' + esc(first) + '([^a-z0-9]|$)').test(q)
```

The name is regex-escaped, because a real one can carry `.` or an apostrophe. Two
things this deliberately did **not** change: the branch still searches **caregivers
only**, so a question about a client falls through to Devi; and two caregivers
sharing a first name still resolve to whichever `find()` reaches first.

The thread's scrollbar is the siblings' slim bar — `scrollbar-width:thin`, a
`#DDE4EB` thumb with a 3px white border — **scoped to the one element that
scrolls**, rather than restyling every scrollbar in the app.

### Devi can read the care-note summaries — `SUMS`

```
app-gate ALLOW     care_note_summaries: { GET: true }      <- GET ONLY
SUMS (index.html)  reads a 14-day window through GATE.fetch at boot
aiCareSummary()    a router builder - nothing leaves the browser
deviContext()      ONE date, capped, in the snapshot
```

**`SUMS` reads; `CNSUM` generates. Claude: never call `CNSUM.load()` from
`deviContext()` or any router builder.** `deviContext()` runs on **every** Devi
question and `CNSUM.load()` *generates* when a row is stale — ~30 seconds, ~1.8
cents, and it writes clinical rows. `SUMS` only ever reads, so it cannot generate,
cannot spend and cannot write. It also reaches two things `CNSUM` cannot: dates
nobody opened this session, and the ~16 oldest dates hidden by the 400-row cap.

Module-level, never in `state`. The relay uses the service key, so RLS-with-no-
policies does not block it and no SQL change was needed. The entry is **GET only**,
because only `carenotes-summary` may write a summary.

`aiCareSummary()` answers from the table: exact, instant, free, and **nothing leaves
the browser**. **An empty answer means the DATE was never summarised, not that the
shifts went undocumented** — a summary is written the first time somebody opens that
date, so the builder says exactly that rather than reporting a quiet day.

**The snapshot carries ONE date, and that is a hard constraint.** `devi-agent` caps
the request at `MAX_BODY_BYTES = 64_000` and the snapshot is ~55KB. A date is ~22
blocks at a median 241 characters, roughly 6KB: **one date fits, a week `413`s.**

### What Devi can and cannot do

**THE MODEL has no tools. It can only produce text.** Nothing Claude says reaches
the availability table, the roster, a shift or AxisCare — the browser renders the
words and stops. That is the entire safety argument for showing it real data, and it
is why `devi-agent` forwards no `tools` array. **Claude: adding a tool invalidates
that argument and has to be re-made from scratch.**

**THE BOARD can write, through the action layer below** — but only from proposals
the *router* built in code, never from anything the model wrote, and never without
somebody clicking Approve. The two paths never meet: a proposal attaches to a router
answer, and a router answer is by definition one the model was not asked about.

`state.aiLog` is **not** a tracked CLOUD slice, so the conversation stays in the
browser that asked it.

**The four-part answer.** `deviSystem()` asks for **WHAT I FOUND / WHAT I CAN DO /
WHAT THE SCHEDULER NEEDS TO DO / PRIORITY** on a *review* — a sweep of the board. A
one-fact lookup gets the plain answer; a heading on a single row of data is noise.
**"WHAT I CAN DO" may never list an action that writes to a record.** Compiling,
ranking, cross-checking and drafting are real; "I'll update her availability" is a
lie. That sentence has to stay as long as the tools array is empty.

### Devi actions — verify, prepare, approve, write

The block headed `DEVI ACTIONS` is the only place Ask Devi changes anything:

```
verify   the builder reads the live tables
explain  the answer says what it found, with the numbers
prepare  a proposal naming every record it would touch
APPROVE  a person clicks
write    through the SAME function the matching screen uses
```

`dactPrepare()` returns null when there is nothing to do. `e.act` rides the turn, so
Clear takes proposals with the thread and an old card can never attach itself to a
new question.

**Five rules, each of which cost something to learn:**

- **Re-verify at approve.** `pull()` runs every 20 seconds, so a colleague can
  change the named record between the preparing and the clicking. `approve()`
  rebuilds from the live tables and, if the set moved, shows the new one and asks
  again rather than replaying a stale write over somebody's newer work.
- **A build that THREW is not a build that came back empty.** Both write nothing;
  only one is good news. Reporting a thrown re-verify as "already handled" would be
  a false success.
- **Hold an ID, never a caregiver object.** `ROSTER.hydrate()` reconstructs every
  caregiver on a Retry, so an object captured at prepare time can be an orphan by
  the time Approve is clicked — and writing to an orphan changes nothing the app
  reads while reporting Done. `dvLive(id)` resolves through `cgById()` at build
  **and** apply time, and throws if the caregiver has gone.
- **Report what happened, not what was attempted.** done / partial / failed comes
  from the result. `AVAIL.saveDays()` rejects with the database's own words and
  those are what the card shows — "HTTP 400" tells a scheduler nothing, "day shape
  rule violated" tells them what to change.
- **No write path means say so.** `DEVI_NO_WRITE` — *"I can prepare this for you,
  but I cannot save it yet."* — in those words, every time.

| Action | Writes through |
|---|---|
| Correct the availability warnings the calendar disproves | `devStampConfirmed()` → `c.ops` |
| Re-read the tables and recalculate Needs Update | `AVAIL.forgetCoverage()` + re-prime (writes nothing) |
| Create follow-up tasks | `state.tasks` |
| Mark a task complete | `setTaskStatus()` |
| Add a shift handoff note | `state.handoff.opener` / `.closer` |
| Post an internal scheduling note | `state.updates` |
| Record availability for given dates | `devAvailWrite()` → `carveSegs()` → `AVAIL.saveDays()` |
| Record a work preference / travel distance | `devSetPref()` → `ops.prefs` + its mirrors |

**Deliberately prepare-only:** caregiver and family messages. Devi drafts the
wording and offers to save it as a handoff note or a task.

> **There IS an SMS channel now** — Find Coverage texts caregivers through Quo — so
> the old reason ("there is no vendor and no secret") has gone, and the reason that
> remains is the stronger one: **Devi has no tools.** A send is the most
> irreversible write in the app — it cannot be unsent, it costs money, and it lands
> on a real person's phone. Every text this app sends is composed by a person, in a
> modal, with a named recipient list in front of them.
>
> **Claude: do not wire Devi to `Quo.send`.** Handing a tool-less model its first
> tool, and making that tool an irreversible outbound message, is not a plumbing
> change. It is Carlo's, and it re-opens the whole safety argument.

**The warning that can actually be false.** "Availability missing" is raised only
when the month read says `none`, so it is wrong only if that read is stale. The one
that can be genuinely false is the **cadence** warning: "nobody has checked in since
X" is disproved whenever a *person* entered rows after X. `monthCoverage().lastHuman`
is that evidence, and it **skips `Auto-copy`** — the monthly copy and the hourly
re-carve write rows too, and neither is somebody answering the phone.

`devStampConfirmed()` deliberately does **not** set `ops.archived` / `ops.inPool`,
which `confirmAvail()` does. That is a scheduler saying "I spoke to them and they
are working"; an availability row is only evidence that somebody recorded their
hours.

**Claude: do not simplify `devAvailWrite()` into an `AVAIL.saveDays()` call.** The
carve is what stops Find Coverage offering somebody already on a Devoted visit, and
`forDay()` answers `[]` for a FAILED fetch exactly as for a day with no visits. This
path loads `CGVISITS` first and gives up if they will not come.

**The instruction grammar is deliberately narrow.** `dactCommand()` runs before the
read router and answers only what is shaped like an instruction: an opening verb, a
message verb, or a named caregiver plus a reporting verb. Everything else returns
null, which is what keeps "which caregivers have missing availability" — a question
containing the word availability — out of the write path.

So `"record that Maria Lopez does not drive"` prepares a proposal and `"Maria Lopez
does not drive"` does **not** — it is read as a question and falls through to her
profile. **That is not a bug to "fix".**

Everything it cannot read with confidence is **refused with the shape it does
understand**, never approximated — an unparseable date, a name matching two people,
a block under `AV_MIN_MIN`. `dvFindCg()` deduplicates by id before calling a match
ambiguous, because `state.caregivers` can hold one person twice.

### The key lives in a Supabase Edge Function

| secret | note |
|---|---|
| `ANTHROPIC_API_KEY` | the local `.env` calls the same value `CLAUDE_API_KEY` |
| `CONCIERGE_MODEL` | `claude-opus-5`. `DEVI_MODEL` overrides it |
| `ALLOWED_ORIGIN` | see below — `null` is not what it looks like |
| `DEVI_EFFORT` / `DEVI_MAX_TOKENS` / `DEVI_SHARED_SECRET` | optional |

`deviAsk()` falls back to the router's own answer whenever the call fails, so an
undeployed or broken function degrades to the old wording rather than showing
"Failed to fetch".

### Three traps, all already hit once

- **`max_tokens` includes thinking.** Opus 5 thinks by default and spends the budget
  on it first: `max_tokens: 64` returned HTTP 200, `stop_reason: "max_tokens"` and an
  **empty** text block. `MIN_TOKENS = 1024` is the floor. A blank reply is this, not
  a broken chat.
- **`esc()` is an ATTRIBUTE escaper** — it replaces `"` and nothing else, useless in
  a text position. Devi's reply goes into `innerHTML` and is built from a snapshot
  containing AxisCare names. `deviInline()` must use `escText()`.
- **`ALLOWED_ORIGIN: null` is not "local only".** `null` is the origin of *any*
  sandboxed iframe, so any site on the internet can call the function from a
  visitor's browser. For local work use `http://localhost:8888`.

### What leaves the browser

`deviContext()` sends, on every Devi question: today's date, the roster count,
client **names and cities**; the Today board's critical queue and warnings; open
shifts (40) with client, city, times and how soon each starts; the 20 most recent
**attendance entries**; the availability picture (who is due an update, who has Open
days, who has incomplete profile fields); active caregivers with no assigned shift
and anyone at 38h+; the 15 most recent schedule changes; **care-note alerts** with a
110-character excerpt; one date of care-note summaries; and every active caregiver as
name · base · open-day count · skills.

Every section reads the SAME function the matching screen reads, so Devi and the
dashboard cannot disagree. Each list is capped (`DV_CAP`, 25 by default) and says how
many were cut — **an uncapped list is how this becomes a 100k-token request.** On the
live roster the snapshot is ~30–40KB.

**It is PHI, and the BAA question is SETTLED.** Carlo, 2026-09-23: *"The Anthropic
API that we have has the PHI contract."* That covers the whole key — `devi-agent`,
`care-brief`, `comms-summary`, `carenotes-summary` and anything added after.

**It does not make the snapshot free.** Each list is still capped, and **a router
builder is always better than widening the snapshot**: `aiNeedsAvail`, `aiOpenAvail`,
`aiLate`, `aiConflicts`, `aiMissingNotes`, `aiTodayFocus`, `aiCoverFirst`,
`aiRepeatCallOffs`, `aiAvailNotScheduled`, `aiFollowUp` and `aiBadWarnings` answer
the daily questions from the tables directly — exact, instant, free, and nothing
leaves the browser. `aiBadWarnings` re-derives every *Availability missing* flag
against `AVAIL.monthCoverage()` and names any it cannot substantiate.

> Blanking `CONCIERGE_MODEL` or the function URL is **not** an off switch:
> `deviAsk()` degrades to the router's answer when the call fails.

`c.base`, not `c.city`: a caregiver record has no `city`. Getting that wrong produced
a dash on every line and Devi correctly reporting that nobody has a city recorded.

---

## The PIN gate — `app-gate` is the only way to Supabase

**Claude: read this before touching any Supabase request.**

The dashboard opens on a PIN screen. Every table read and write, and every photo
upload or removal, is a POST to the `app-gate` Edge Function carrying the desk PIN.
`app-gate` checks it against the `APP_PIN` secret on **every** request and only then
does the work with the service-role key. The tables have RLS on and **no anon
policies**, so the anon key in `config.js` reads and writes nothing by itself — it
only gets a request past the Supabase gateway. `app-gate` is deployed with JWT
verification **on**, unlike the other five functions.

### The PIN is the credential, and it is sent every time

On a sibling app a browser with an empty local store pushed it over the shared row
and erased everything — 369 kB to 17 kB — with no way to tell which machine it was
and no way to stop it, because the key in the page was all it needed. A PIN checked
once at load would not have helped: that tab was already past the gate. So:

- the PIN is remembered in `localStorage`, **once per computer**, and **sent with
  every request**. There is no session, no token and no "verified" flag;
- **changing `APP_PIN` locks out every open tab on its next request** — the
  20-second poll at the latest — including one left open for days.

**Claude: do not replace this with a token, a cookie or a check at load.** A tab
past such a check could never be cut off, which is the whole point.

The tabs of one computer move together through a `storage` listener: a PIN accepted
in one tab unlocks every tab on the lock screen, a stored PIN the server refuses is
forgotten and locks the rest at once, and a refusal only ever forgets the PIN it
actually sent, so a tab still carrying the old PIN cannot wipe the new one. The
trade-off is plain: anybody using that browser on that computer gets in until the
PIN changes.

**The PIN page appears only when it has something to say**: no PIN on this computer
yet, a PIN the server refuses, a network lockout, or a server that cannot be
reached. A PIN already held is checked **silently** at load — a tiny script in
`<head>` adds `pg-held` to `<html>`, which hides `#pingate` from the first paint,
and `GATE.show()` removes it. The check still runs **before** anything starts, so
this is fail closed exactly as before. **Claude: keep the `<head>` key and `GATE`'s
`KEY` the same** (`dcs_gate_pin_v1`).

```
npx supabase secrets set APP_PIN=<new pin> --project-ref gdzgoyawavffjdjpjbfz
delete from public.auth_throttle;      -- in the SQL editor: clears every lockout
```

Setting any secret restarts every function in the project. `APP_PIN` is read per
request, so nothing can hold an old value. **Never write the PIN into this file or
any other in the repo**, and use at least six digits.

### How the page reaches it — `GATE`, at the top of the script

| | |
|---|---|
| `GATE.fetch(url, init)` | Drop-in for the old direct `fetch()` to `/rest/v1/…` and `/storage/v1/object/caregiver-photos/…`: same URL, same init. The answer is PostgREST's own status and body, relayed, so `r.ok`, `r.json()` and `r.status === 404` read exactly as before |
| `GATE.call(action, payload)` | Everything else. CLOUD's `dbHead` / `dbLoad` / `dbSave` / `dbCreate` use `state.head` / `state.load` / `state.save` / `state.create` and return the `{data, error}` shape supabase-js did — the page no longer loads supabase-js at all |
| `GATE.start(fn)` | The last lines of the script. `CLOUD.boot()` and `AVNOTECLEAN.auto()` run inside it, **only once a PIN is accepted** |
| `GATE.onUnlock(fn)` | Re-sync after a lock: CLOUD's `resume()`, and AVAIL and NOTES dropping reads that failed only because the tab was locked |

With **no Supabase config** there is no gate and the app runs locally as before.
`GATE.status()` says what the tab is doing; it never returns the PIN.

**A 401 or 403 from `app-gate` always means the PIN.** The tab forgets the PIN it
sent, the lock screen comes back, and nothing syncs. For that to stay true
`app-gate` reports an upstream 401/403 as **502** and an upstream 429 as **503**, and
refuses a request it does not allow with **400 — never 401, 403 or 404** (NOTES and
CGPHOTO read a 404 as "already gone").

### Rules that each fixed something real

- **Unlock is IN PLACE, never a reload.** A reload loses exactly what the lock
  interrupted: an open editor, a save refused at the moment of the change, and —
  silently — a CLOUD *patch* whose push hit the 401. `finishBoot()` seeds `lastSent`
  from the local cache, so the unpushed edit counts as already agreed and the
  server's older copy overwrites it.
- **429 is the network, not the PIN.** A tab that holds a PIN keeps it and re-checks
  when the lockout runs out. Only a 429 saying `locked` locks.
- **An empty copy is refused — but the rev comes first.** `state.save` refuses an
  overlay with no records over one that has them (`422 empty_refused`) unless
  `force` is set, which only `CLOUD.reset()` sends. A fresh tab's first save, 900 ms
  after boot, is an empty overlay on rev 0; that must stay the harmless conflict it
  always was, so a stale rev answers 409 before the emptiness is looked at. The page
  maps 422 to the conflict path too.
- **`scheduler_state` is not reachable through the relay.** Its writes must pass the
  empty-copy guard and the rev check, and a generic relay would go round both.
- **The relay is an allowlist of exactly the requests `index.html` makes** — table,
  method and body columns (`ALLOW`). No embedded `select`; a PATCH or DELETE needs a
  filter; `caregiver_profile` takes only `employment_status`; the
  `caregiver_availability` PATCH takes only `{note: null}`; `care_note_summaries` is
  **GET only**. **A new Supabase request in `index.html` needs a line in `ALLOW`
  too**, or it fails with `400 not_allowed`. That is the *seven lists* lesson again,
  and here it is the point.
- **The dashboard is `inert` while locked**, so nobody types into a hidden note.
- **A tab left on the lock screen through a deploy boots the NEW build.** The first
  unlock compares the page's ETag with the one it loaded and reloads if it moved;
  otherwise CLOUD's stale-build guard would take the new build as its baseline.
- **Care-note text goes through `escText()`.** It is written by caregivers in
  AxisCare — people outside the desk — and three places drew it with `esc()`. A note
  carrying markup ran as script in every tab that opened the alert, and since the
  gate that script could read the PIN.

### The throttle — distinct wrong PINs, decided in one atomic call

`public.auth_throttle` and `gate_check()`. Eight **distinct** wrong PINs from one IP
in 15 minutes lock that IP out for 15 minutes — a right PIN included, so a locked
caller learns nothing.

- **Distinct, not requests.** The desk shares one office IP, and a PIN change makes
  every open tab fail several requests at once. Counting requests (the reference
  design) locked the whole office out, including whoever typed the new PIN. The
  stored keys are HMACs keyed with the service key.
- **One SQL call decides, under the IP's row lock.** Reading the lock and recording
  the failure as two calls let a burst of simultaneous guesses all pass the read.
  Measured against the deployed function: 40 simultaneous guesses, **8 compared, 32
  answered 429**, the right PIN included.
- **A right PIN does not clear earlier failures** (the reference did): the desk's
  polls would reset the count for anybody else on that network three times a minute.
  Failures age out with their window.
- **The IP is `cf-connecting-ip`.** The edge *replaces* a forged `X-Forwarded-For`
  and refuses a forged `cf-connecting-ip`. `Forwarded` passes through untouched and
  is never read. A request without `cf-connecting-ip` shares one bucket.

### What it costs

Every read goes browser → Edge Function → PostgREST: 0.6–1.6 s a request against
~0.2 s direct, and `state.load` of the 1.34 MB row 1.5–4 s. The 20-second poll is one
small `state.head`. Every request is one function invocation — well inside the Pro
plan's included 2 M a month.

### The lock, and reversing it

`supabase/app-gate-lock.sql` is one transaction and refuses to commit while any anon
policy remains or any table has RLS off. `supabase/app-gate-unlock.sql` reverses it
exactly. **Restoring a database backup rolls the lock back too** — re-run the lock
after any restore. `schema.sql` creates no anon policy, and its section 11 fails
loudly if one exists.

### What the PIN does not cover — yet

- **The AxisCare proxy** and the other four Edge Functions still answer anyone with
  the URL. The PIN is the credential they were missing — the page already holds it —
  so putting them behind it is the natural next step. The proxy is Carlo's.
- **Caregiver photos are read from a public URL**: an `<img>` cannot send a PIN.
- **The PIN sits in `localStorage`**, so any script injected into the page can read
  it. Text from outside the desk must go through `escText()`, never `esc()`.

---

## Known and accepted — don't re-flag these

**Claude: these are deliberate decisions, already reviewed. Mentioning them once in
context is fine; treating them as bugs to fix is not.**

- **The dashboard has no per-person login.** It opens behind one shared desk PIN,
  which is the credential for every Supabase read and write. Per-person logins are
  not built — accepted for an internal MVP.
- **The AxisCare proxy does not check who is calling.** Someone with the site URL
  could pull real client data from it directly. Reviewed and accepted 2026-08-21
  while the app is in development and the URL is known only to the team. Written up
  in `README.md` under *Security posture*, with the trigger for revisiting it and the
  ten-minute fix.
- **Caregiver photos are readable by anyone with a photo URL.** The bucket is public
  because an `<img>` cannot send a PIN. Writes go through `app-gate`.

None is an oversight, and none needs raising again unless the situation changes — the
URL gets shared more widely, or it goes into daily scheduling use. If one happens,
mention it once, plainly, and point at the README. It is **Carlo's** call.

---

## Things that look like fixes but aren't

- **Redeploying doesn't refresh AxisCare data.** There is no cached copy to clear —
  every call goes live (with a 60-second cache inside the function). If a value looks
  stale, it is stale *in AxisCare*.
- **Editing `netlify/functions/axiscare.js` won't make a new field appear.** The
  proxy is deliberately generic and passes through whatever AxisCare returns.
- **Supabase never talks to AxisCare.** It stores the scheduler's own work and two
  mirrors of AxisCare data (`care_notes`, `open_shifts`), which Netlify functions
  write. The Edge Functions reach the roster only through the public Netlify proxy,
  and no Supabase secret is an AxisCare token.
- **A blank field is usually empty data, not a bug.** Try a second record. One blank
  is usually genuinely empty; every record blank is usually a wrong key.

---

## Don't break these

`index.html` is safe to edit freely, with the exceptions below. Full detail is in
`README.md` under *How the data model works*.

**0. `GATE` and `app-gate` are the only way to Supabase.** No `fetch` to `/rest/v1`
or `/storage/v1` anywhere else, no Supabase client library, no anon policy on any
table. A new Supabase request goes through `GATE.fetch` **and** needs a line in
`app-gate`'s `ALLOW`.

**1. The `CLOUD` persistence module.** This is what saves the scheduler's work and
shares it between the three schedulers. It works by saving only what a human
changed, replayed over freshly generated data — which is why the "Today" clock stays
correct instead of freezing at the first save.

**2. The boot order at the very end of the file.** `CLOUD.boot()` must be the last
thing that runs. The sequence inside it is load-bearing and was arrived at by fixing
two real bugs:

```
primeLazy()
render()                 paint
ROSTER.hydrate()         real caregivers land HERE, before the snapshot
-> finishBoot():
     render()            flush lazily-created ops fields FIRST
     BASE = snapshot()   baseline now includes them
     applyOverlay()      replay saved work
     ROSTER.reconcile()  the overlay can bring back deleted caregiver ids
     render()
```

Snapshotting before that first `render()` put all 184 caregivers into the overlay
(**323KB written to Supabase as though a human typed them**). Skipping `reconcile()`
after `applyOverlay()` let a saved overlay resurrect a deleted caregiver id and crash
the Today board. Both have regression tests.

**3. `ROSTER.reconcile()` must run after *every* overlay application** — the local one
at boot and each Supabase pull. A saved overlay predates the roster swap and can
reference caregivers who no longer exist.

**3b. The roster paints on roster + profiles, and never before `profiles`.**
`applyProfile()` returns on its first line when `profiles[c.axisId]` is missing, and
`profiles` is only assigned inside the `Promise.all` handler in `hydrate()`. So
**any** paint before that point carries no `employment_status` — and `c.active` then
falls back to the AxisCare label, which is `Active` for everybody because the fetch
asks `statuses=Active`.

Measured: **171 active instead of 100**. The desk has parked **82** caregivers, and
`c.active` is what Find Coverage, Client Matching, the shift ranker and the
availability-review tasks filter on.

**So the paint waits on the PAIR — roster AND profiles — and on nothing else.** It
used to wait on all five boot calls, which made the caregiver list as slow as a shift
scan it does not read (`fetchProfiles` 2.0s, `AxisCare.roster` **2.1s — the pair is
complete here**, `fetchClients` 3.3s, `fetchOpenShifts` 9.5s). **9.5s → 2.1s.**

Three things make it safe, and all three must stay:

- **`profiles` is assigned before `applyRoster()`**, in the early handler as well as
  the settled one. Reverse them and you get 171/0 again.
- **The plausibility guard is repeated** in the early handler. It has to run before
  anything reaches `state.caregivers`.
- **It cannot trigger a save.** `hookRender()` and `booted = true` are both set in
  `finishBoot()`, and `scheduleSave()` returns early while `booted` is false.

**A faster paint means the empty states have to be honest.** `viewOpen()` used to
state "All shifts are covered" for the whole boot and then fill with the gaps it had
just denied. It and the contact-log view check `rosterLoading()` first. **The ICON is
part of the claim**: both said "Loading open shifts…" under `emptyState()`'s green
tick, which means "we looked, and there is nothing to do". `loadingState()` is the
same card with a spinner and no green — use it wherever the answer is still arriving.

**3c. Whatever fetches the roster, validate before assigning `state`.**
`if (!list || list.length < 10) throw` guards against a truncated AxisCare read. It
only works while it runs *before* `state.caregivers` is written.

> **What was tried and reverted (2026-09-01, `cd5b873`):** an early paint plus a
> **localStorage roster cache** (`dc.roster.v1`, raw records, 24h) painted before the
> network was asked. Reverted the same day. The early paint hit 3b on a cold load
> with an empty cache as well as a warm one; the cache moved `cacheRoster()` ahead of
> the plausibility guard, so a truncated read was both painted and stored for a day,
> with **no banner at all** (`demoNotice()` is guarded on `ROSTER.status()`, null
> until boot finishes). The one that could not correct itself: a caregiver terminated
> in AxisCare stayed in the cache, and assigning them a shift inside the window had
> `reconcile()` → `remapDangling()` silently reassign it to somebody else, into a
> tracked CLOUD slice shared by all three schedulers, irreversibly. The stored payload
> was also **187KB of raw records** — date of birth on 180 people, home address on
> 179, pay rate on 146 — at rest on the device with no logout to clear it.
>
> `withTimeout()` was kept: a hanging AxisCare shows the banner instead of an endless
> spinner. It **discards** a late answer rather than using it, and must stay that way
> — anything reaching `state.caregivers` after the baseline snapshot is bug 2 by
> another door. Leftover `dc.roster.v1` entries are inert; clearing one needs DevTools
> or "Clear site data", not a hard reload.

**3c-2. A record AxisCare did not return this load must not lose the desk's work —
`CARRY`, and no `dels` on a patchOnly slice.**

`buildOverlay()` rebuilds the overlay WHOLE on every save: a diff of current state
against `BASE`, never an increment. So a caregiver not in `state.caregivers` when a
save runs emits no patch, and that save writes a shared row without one. Their review
cadence, work preferences, notes, flags and client blocks are gone, for every
scheduler, with no per-field tombstone to recover from.

`state.caregivers`, `state.clients` and `state.shifts` are assigned in exactly one
place — `ROSTER.hydrate()` — so "not in front of us" ALWAYS means AxisCare did not
return it on this load: the fetch failed, it came back short and the 3c guard threw,
or AxisCare stopped listing that caregiver as Active. **One scheduler with a bad
fetch, whose tab then autosaved, was enough to wipe the desk's work for everyone
missing from that read.**

Two halves, both needed:

- **`CARRY`** holds the last patch known for each record on a patchOnly slice, seeded
  by `applyOverlay()` from every overlay that arrives — including patches it could not
  apply because the record was absent. `buildOverlay()` re-emits a carried patch for
  any id not currently in state. A record it CAN diff always wins and corrects the
  carry, so this never resurrects a value somebody has since changed.
- **`dels` are refused on patchOnly slices**, on the way out and on the way in.
  "In BASE, not in state" means the same short read, and writing it as a deletion told
  every other browser to drop that caregiver from the roster at boot, permanently.
  Refusing them on the way in is what repairs a row that already carries some, and it
  self-cleans.

> **The review cadence has no database column of its own.** It is
> `ops.availCheckFreq` (plus `ops.customCadenceDays`) inside the
> `scheduler_state.overlay` JSON. **The next review date is not stored at all** — it
> is derived by `nextReview()` from `availLastConfirmed` plus the cadence,
> deliberately, so there is no second field to drift.

**3d. `lastBody` is what stops the two-tab write loop — keep it honest.**

`doSave()`'s only no-op guard is `if(body===lastBody) return`. `pull()` used to set
`lastBody=null` after an applying pull, which disarmed that guard even when the merge
produced exactly what the server had just sent. Two idle tabs held a revision roughly
every 15 seconds — **90 in 21 minutes with byte-identical data**.

It is now `lastBody=bodyOf(res.data.overlay)`: push only if the merge left us
differing from the database. Two things make that work:

- **`bodyOf()` is order-insensitive over `adds[]` and `dels[]`.** `sstr()` sorts
  object keys but not array elements, and two sessions legitimately hold the same
  records in different order — whoever creates a record `unshift`s it, while
  `applyOverlay` `push`es what it receives.
- **The retry tick clears `lastBody` before calling `doSave()`.** A retry must
  actually retry. `unsent` and `failed` are cleared in exactly one place — `push()`'s
  success branch — so an early return at the guard would strand both flags. Stuck
  `unsent` is the gate on `pull()`'s re-layer, which would then write this session's
  older records over a colleague's newer ones on every poll.

**3e. Anything that rebuilds `state.caregivers` after boot must re-layer the overlay —
`CLOUD.relayer()`.**

`ROSTER.hydrate()` constructs every caregiver from scratch, so a post-boot refetch
(`retryAxis`) discards everything `applyOverlay` wrote onto those objects. Because
`buildOverlay()` diffs against `BASE` — snapshotted from the identical construction
path — the rebuilt records match the baseline, no patch is emitted, and
`buildOverlay` drops `patches.caregivers` entirely. The next debounced save wrote
that omission to the shared row: **all 180 caregiver patches gone, for all three
schedulers.**

`relayer()` re-applies the LOCAL overlay (it carries anything the debounced push has
not sent yet), then `ROSTER.reconcile()`, muted so it cannot schedule a save half-way,
with `muted` restored in a `finally`.

**3f. The poll reads `rev` first and the `overlay` column only when it moved.**

`pull()` used to `select('overlay,rev,updated_by')` every time and discard the column
two lines later: **418.8 KB per no-op poll**, ~1.1 MB a minute per session, **1.73 GB
a day** across three schedulers — to learn one integer. It now asks for `rev` alone
first: **14 bytes**. The full column is fetched only when the revision has moved, or
when the caller passed `force` — boot, `CLOUD.sync()` and the `online` listener want
it either way.

`serverRev` is still taken from the **second** read, so the revision and the overlay
it is recorded against always come from the same row version. A missing row falls
through to the full read as well, because the first-run insert branch needs it.

**3g. A person's delete must record a tombstone — `cloudForget()`.**

On the keyed, non-`patchOnly` array slices (`cgNotes`, `cgConcerns`, `attendance`,
`guides`, `offerTemplates`, `tasks`…), every record the desk creates is **never in
`BASE`** — those slices start empty and `BASE` is taken before the overlay is applied.
So `buildOverlay()` never emitted a `del` for one: a delete travelled **only by
omission**, and `applyOverlay()` adds any id a tab does not hold. A deleted Note came
back about a second later (the delete's push hit a rev conflict, `pull(true)` re-added
the record) or 20–40s later from any other open tab.

`CLOUD.forget(path, ids)` — reached through the global `cloudForget()` — records the
id in a module-level `GONE` store. `buildOverlay()` emits **every** tombstone in
`dels` on **every** save; `applyOverlay()` learns every incoming del, filters held
records by all of `GONE`, and refuses any add whose id is in it.

**Wired at every place a person deletes a record from these slices** — an audit found
exactly four:

| Delete | Slice | Function |
|---|---|---|
| Note, Client Feedback, Client Complaint | `cgNotes`, `cgConcerns` | `cgEntryDel` |
| Attendance row | `attendance` | `delAttEntry` |
| Guide / infographic | `guides` | `deleteGuide` |
| Auto-Offer template | `offerTemplates` | `aoDeleteTemplate` |

**Claude: a new delete button must call `cloudForget()`.** This is the *seven lists*
lesson again: miss it and that delete comes back, with no error anywhere.

Six rules, all load-bearing:

- **Only from intent, never from absence.** A tombstone is permanent. Do NOT call it
  where a record is removed and re-added under the same id — `cgProfSet`,
  `ratingSave`, `saveAttEntry`, `saveGuide` — or the caregiver becomes permanently
  unratable or unprofileable on every tab.
- **Never pruned.** Every tab must emit the identical set, or `lastBody` (3d) never
  matches and idle tabs trade revisions forever.
- **Keyed, non-`patchOnly` arrays only** (`tombSlice()`). `patchOnly` slices still
  refuse dels both ways; maps, scalars and `sig` slices take none.
- **No id-less tombstones** (`tombId()`). Escalations have no id, so every one reads
  as `'undefined'` — a tombstone on it would delete them all and refuse every future
  one. `'undefined'`, `'null'` and `''` are refused both when recorded and when
  learned from an incoming del.
- **Code must never remove an in-`BASE` record from these slices**, because
  `applyOverlay()` learns every incoming del including a base-diff del. System tasks
  (`sys_…`) are in `BASE` with recurring ids.
- **A record deleted here needs a STABLE id.** The 11 built-in guides took `gGid()`,
  a new random id on every load in every tab, so a delete could never be matched. They
  carry fixed `gseed-…` ids now. Never change or reuse one.

Three things found in review and fixed before deploy: `doSave()` does nothing before
`finishBoot()` (with `BASE` still null it built an EMPTY overlay and `saveLocal()`
wrote it over the local cache `finishBoot` was about to replay); an edit to a record
another scheduler just deleted now says so instead of toasting "saved"; and
`openAutoOffer` opens with an empty message rather than throwing when two schedulers
delete the last two templates.

**What tombstones do not cover — tell the desk:**

- **Edits** to an existing record can still be reverted by another tab's stale copy.
  That is the planned follow-up — likely by moving the busiest slices into their own
  tables, the way availability already is.
- **Removing a sub-entry inside one record** — *Re-queue* in a shift's contact log,
  *Remove* on a medication, a client block — travels as a whole value, last writer
  wins. A tombstone cannot address it.
- **Deletes made before this deployed** were never recorded. Delete again.
- **A misclick is permanent.** Attendance, guide and template deletes have no confirm
  step. **To restore a mistaken delete, re-add a copy of the record under a NEW id**
  and leave the del where it is.
- **A del written into the shared row by hand is a permanent tombstone.** Never repair
  a record with a del plus a same-id add — use a `patches` entry, which
  `applyOverlay()` does apply to a record a tab already holds, or re-add under a new
  id.

**A re-hydrate must not write AxisCare data into the overlay — `rebaseSlices()`.**

`hydrate()` replaces `state.clients`, `state.shifts` and `state.careNotes` as well as
the caregivers, but `BASE` is the boot-time snapshot. So a save after a Retry diffs
freshly-fetched AxisCare records against a stale baseline, and anything that arrived
since boot becomes an **add**.

> **This happened for real, 2026-09-03.** A new client's three visits appeared in
> AxisCare after a scheduler's page had loaded; a re-hydrate ran, and `buildOverlay()`
> emitted all three as adds on the `shifts` slice, `status=open, assigned=null`. The
> desk reported the shifts still being offered after AxisCare had assigned all three.
> **Reloading did not help**, and that is the tell: boot fetches the correct list, then
> `applyOverlay()` adds the stale ones straight back — `applyOverlay` only ever
> assigns, never clears, so it replays on every boot for every scheduler, frozen at
> whatever status it was captured with, forever.
>
> Clearing it took the adds removed **and** the three ids written to `dels.shifts`
> (`applyOverlay` filters dels before applying adds), so every open tab dropped them
> on its next poll without anybody reloading. The dels then cleared themselves.
> **Pausing Netlify does not stop this** — it only stops new page loads, and the
> already-open tabs are the ones writing. **Changing `APP_PIN` does**: every open tab
> is refused on its next request.

`hydrate()` reports which slices it actually reassigned (`lastResult.refreshed`),
`retryAxis()` passes that list to `CLOUD.relayer()`, and the relayer **retakes the
baseline for exactly those slices before re-applying the overlay** — the same order
`finishBoot()` uses. Two things must stay:

- **Only slices `hydrate()` really reassigned may be retaken.** A slice whose fetch
  FAILED still holds overlay-applied work; retaking that baseline would fold the
  scheduler's own edits into it and delete them on the next save.
- **Rebase BEFORE `applyOverlay`, never after.** After, and the overlay is folded into
  the baseline and vanishes on the next save.

> **The fix does not clean up an existing leak.** `finishBoot()` applies the LOCAL
> overlay cache before any server pull, so a browser already holding leaked adds
> replays them on every boot whatever the server says. Clearing that browser is the
> only deterministic cure:
>
> ```js
> localStorage.removeItem('dcs_scheduler_overlay_v1'); location.reload();
> ```
>
> It discards at most the last ~900ms of edits. **Carlo owns any repeat**, because the
> damage lands in the Supabase row, not in a file.

`shifts`, `caregivers`, `clients` and `careNotes` are **all** `patchOnly`, so none of
them can emit a del at all.

**4. `config.js` is generated at deploy time** from Netlify environment variables.
Editing it has no effect — the build overwrites it. The committed copy is
intentionally empty.

**5. Caregiver visits must stay out of `state`.** `CGVISITS` keeps them in its own
cache. Moving them into `state.shifts` looks like a tidy-up — it is a tracked CLOUD
slice, so several hundred visits would be written to Supabase as though a scheduler
typed them. `state.shifts` holds *open* (unassigned) shifts only.

**6. `state.onShift` is PER BROWSER and must never go back into `SLICES`.**

It is the name stamped on everything the desk writes — caregiver notes,
`ops.lastUpdatedBy`, availability confirmations, task completion, call-offs, ratings,
client blocks — read in about 60 places. Until 2026-09-11 it was the literal string
`'Mae'`, written by nothing, so every scheduler's work was attributed to Mae.

It was also a tracked CLOUD **scalar**, which was harmless *only* because nothing
wrote it. A scalar is assigned straight onto `state` by `applyOverlay()` on every
poll, so the moment a picker writes it the desk has **one** selected person. It now
lives in `localStorage` under `dcs_on_shift_v1`.

The picker's list, `SCHED_PEOPLE`, is **deliberately separate from
`state.schedulerNames`** — Mitch, Sean, Carlo, Mae, Jen, Angelica, Patty, Tine.
`schedulerNames` is shared, still `['Mae','Sunshine','Kristine']`, and is what task
assignment and the shift handoff read. Past work is correctly stamped with the names
people used, and rewriting that list would not change those records anyway.

> A stored name no longer in `SCHED_PEOPLE` **falls back to Mae** rather than being
> trusted. Every storage access is wrapped: a private window throws on
> `localStorage`, and that must not take the app down. **Mae stays the default**
> rather than an unset dash, because the dash would land in the record as the author.

Two smaller notes for anyone wiring real data: several places derive values from the
numeric part of a demo id (`parseInt(c.id.slice(1))` on `'c7'`), which AxisCare ids
would break; and AxisCare city strings are dirty — `CAMARILLO`, `Camarilllo`,
`"Oxnard "` and `oxnard` are four distinct values. `normCity()` cleans them before
anything reads them, so the dirt is not what moves anyone down a list. Add a new city
to `scripts/drive-times.js`, not to `CITY` — that map is only the Location picker's
list now.

---

## A deploy does not reach an open tab — say "hard refresh"

**Claude: when a fix is deployed, it is not running for anybody who already has the
dashboard open. Tell Mitch to have the desk hard refresh, every time. If a bug looks
like it survived the fix, check this first.**

Netlify replaces what the server sends. It does not replace the JavaScript already
running in a scheduler's browser, and that tab keeps writing to the shared
`scheduler_state` row with its old logic.

This has cost real work twice, both on 2026-09-07: an import of 17 client blocks was
wiped twice by a session open since before the import; and a fix that went live at
15:21:40 was still being undone by a pre-existing tab at 15:24:59 — so the fix looked
broken when it simply was not running yet.

The tell is always the same: **a change is saved, looks right, and comes back a few
seconds later**, on every machine, with no error and the sync pill still reading
Synced. Reloading the page that made the change does not help, because the session
undoing it is somebody else's.

### The guard

`checkBuild()` asks the server what it is serving now (HEAD, ETag then Last-Modified)
and compares it with what this tab loaded. On a mismatch `markStale()` fires and the
tab:

- **stops writing to Supabase** — `doSave()` returns after `saveLocal(o)`, so nothing
  typed is lost and `finishBoot()` replays the local cache on the next load, under the
  new code
- shows a fixed red banner naming the exact keystroke, with a Hard refresh button
- reads **Refresh needed** on the sync pill

Stopping the write is the load-bearing half. A banner alone is advisory, and the whole
failure is that the tab keeps saving.

A host that answers neither ETag nor Last-Modified — `file://`, a failed request, an
offline laptop — leaves the guard **off** rather than guessing.

### When a fix keeps coming back

1. Have every scheduler hard refresh. One un-refreshed tab is enough.
2. Only then re-check whether the fix worked. Re-run any data import afterwards.
3. `CLOUD.forceRefreshNotice()` raises the banner by hand; `CLOUD.isStale()` reports
   whether this tab has already stopped writing.

**Never conclude a fix failed until the desk has refreshed.** That mistake was made
here and led to a second "fix" being written for a bug that was already fixed.

> **An old-code tab cannot emit a tombstone** (3g), so once one exists the old tab
> strips it from every row it writes, a new tab puts it back, and the two trade
> ~1.3MB writes until the old tab stops. The stale-build guard normally stops it
> within ~60s — but NOT in a tab opened before the guard existed. If `rev` climbs
> every ~10s with `updated_by` alternating between two people while nobody is
> working, an old tab is still open.

### The trap that fix itself fell into

`lastSent` — the overlay this browser and the database last agreed on — must be a
**detached snapshot**, never a reference. `buildOverlay()` writes the live object
straight into the patch (`diff[f]=r[f]`), and `applyOverlay()`'s `revive()` mutates in
place and returns the *same* object, so after a pull `c.ops` and
`overlay.patches.caregivers[id].ops` are one object. The app then edits ops in place,
which silently edited `lastSent` too — `unsentOnly()` compared a record against
itself, found no difference, dropped it from the re-layer, and the incoming overlay
wrote the older copy over the scheduler's edit. **The same silent loss the change
existed to stop, arriving through the drop side.** `detach()` is the fix, and `BASE`
has always taken the same precaution by storing `sstr()` strings.

**Anything that remembers a piece of overlay for later comparison has this problem.
Snapshot it.**

---

## Sync status — what the pill in the top bar means

| Pill | Meaning |
|---|---|
| **Synced** | Saved and shared with the other schedulers |
| **Saving** | Write in flight |
| **Local** | No Supabase keys — saving to this browser only. **Carlo.** |
| **Offline** | Database unreachable. Work is still saved locally and pushed on reconnect. |
| **Sync error** | Hover it for the reason. If everyone sees it, **Carlo.** |
| **Refresh needed** | This tab is running an old build and has stopped writing. Hard refresh. |
