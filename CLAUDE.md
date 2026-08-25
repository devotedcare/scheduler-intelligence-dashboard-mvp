# CLAUDE.md — Scheduler Intelligence Dashboard

**Read this before answering any question about AxisCare data or writing any
code against it.** It exists so nobody has to guess what AxisCare provides. Every
field listed here was confirmed by a live API call, and every field *not* listed
genuinely does not exist.

---

> Background on how the app reached its current shape, including two
> conclusions that turned out to be wrong, is in [CHANGELOG.md](CHANGELOG.md).

## What this app is

An operations dashboard for the Devoted Care scheduling desk. It opens on **what
needs attention today**, then gives the scheduler tools to act: fill open shifts,
work call-offs, review care notes, run the shift handoff, keep weekly tasks
moving.

One file — `index.html` — with no framework, no bundler and no npm packages.
Charts are hand-drawn SVG. Everything is plain JavaScript in one `<script>` block.

AxisCare is the system of record for caregivers, clients and visits. This
dashboard sits on top and makes the day navigable.

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
   language** — then offer the closest thing that is. The known limitations are
   documented below; read them before starting, so nobody spends an afternoon on
   something that cannot work.
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
live within a couple of minutes. No local setup, no build step to run.

**Carlo** (lead developer) owns anything that isn't a file in this repo.

### Mitch can do, through Claude + GitHub

- Anything in `index.html` — layout, wording, what a view shows, new panels
- Documentation (`README.md`, this file)
- Commit and let Netlify deploy

### Needs Carlo

These are not files in the repo, so they cannot be changed by committing:

- **Netlify environment variables** — the AxisCare token, the Supabase keys
- **Supabase** — the table, the row-level-security policies, anything in the database
- **AxisCare admin** — the token itself, which endpoints the account may call
- **Netlify build settings**, and reading Netlify or Supabase logs

**Pass it to Carlo when:** `action=ping` fails or returns 401/403; the sync pill
reads *Sync error* for everyone; a new AxisCare endpoint is needed (that is an
environment variable); or anything above is genuinely required.

When that happens, say what's needed in one line and carry on with anything that
isn't blocked. No need to stop work or wait.

**No need to involve anyone for:** a field that isn't in the tables below, a
layout or wording change, or anything already answered in this file.

> `netlify/functions/axiscare.js` *is* in the repo, so a commit would deploy it.
> Don't. It is the security boundary that keeps the AxisCare token off the
> browser, and a mistake there exposes it. Check with Carlo first.

---

## What is live and what is sample

**Everything the scheduling desk works from is now live AxisCare data.**

| On screen | Source |
|---|---|
| **Caregivers** | Live — 184 active, fetched every load |
| **Clients** | Live — 20 active |
| **Open shifts** | Live — derived from unassigned future visits |
| **Caregiver calendar** | Live — each caregiver’s own scheduled client visits |
| **Care notes** | Live — swept into Supabase on a schedule, read from there |
| Medication lists | Cannot be fetched. AxisCare API limitation |
| Attendance history | No AxisCare source. Derivable from visit clock-ins, not built |
| Tasks, handoff notes, contact log | The dashboard's own records, entered by schedulers |

**There is no sample data on screen by default.** The seed records still exist in
`index.html`, but `purgeDemo()` clears them at boot. If a screen is empty it is
because AxisCare genuinely has nothing, or because the fetch failed — and the
banner says which.

### Bringing sample data back

For a demo or a screenshot, in the browser console:

```js
DEMO.on()      // restore the sample caregivers, clients, shifts and notes
DEMO.off()     // clear it again
DEMO.isOn()
```

Both reload the page. While it is on, every screen carries a banner saying so.
The setting is per-browser and never leaves the device.

### The banner tells you where the data came from

`demoNotice()` renders exactly one of these, in priority order:

1. **Couldn't reach AxisCare** (red) — names the reason, offers Retry, and says
   plainly that nothing is shown rather than something invented
2. **Sample data is switched on** — with how to turn it off
3. **Some AxisCare data didn't load** — a partial failure, naming what failed
4. **This screen has no AxisCare source** — care notes, medications, attendance,
   contact log. Each explains *why*, because "empty" and "not available" are
   different messages
5. **Live confirmation** on Caregivers and Open Shifts

Do not remove these. If a request sounds like "clean up the banners", the honest
fix is to wire the missing data, not to hide the label.

### Figures that read "Not tracked"

Reliability, hours worked, call-off counts, decline counts and
availability-verification history have **no AxisCare source**. On a real
caregiver they are `null` and render as "Not tracked".

The same applies to clients: `reqSkills`, `risk`, `hasBackup`, `complaints30`
and `missedThisWeek` do not exist in AxisCare. Client class tags on this account
are **payment type only** (`PVT` Private Pay, `LTC` Long-Term Care Insurance) —
there is no clinical requirement recorded anywhere, so skill-matching a caregiver
to a client has nothing on the client side to match against.

Two traps, both already hit once:

- `null + '%'` renders the string `"null%"`
- `null < 85` is **true**, so an untracked caregiver gets flagged as a
  performance concern on evidence that does not exist

Use `hasVal(v)` before judging a figure and `nt(v, suffix)` when displaying one.

---

## Care notes are SYNCED, not fetched live

**Claude: do not "simplify" this into a direct AxisCare call.** It was built
this way for a measured reason.

A caregiver's shift documentation exists **only** on the per-visit detail call:

```
GET /api/visits/{visitId}  ->  careNote        (a plain string)
```

The visit *list* does not include it, and there is no bulk notes endpoint for
shift documentation. So reading a week of notes is **one request per visit** —
about 170 on this account, roughly 34 seconds at a polite 5 req/sec. Doing that
on page load would be slow for one person and would put the team over AxisCare's
limits. The Client Concierge dashboard hit `429` three times learning exactly
this.

### How it works instead

```
netlify/functions/carenotes-sync.js     scheduled every 15 min (netlify.toml)
  -> reads visits day by day, newest first
  -> reads each visit's careNote
  -> upserts into Supabase  public.care_notes
The dashboard reads public.care_notes. Zero AxisCare calls.
```

**Each run stops at a 7-second soft deadline** and saves a cursor
(`care_notes_sync`), so the next run resumes. Netlify's function timeout varies
by plan; this design does not depend on knowing it. A sweep needing 34s simply
takes several runs.

Days are swept **newest first**, so a run that runs out of time has still
refreshed the notes people are most likely to open.

### Two note types — do not confuse them

| | Endpoint | What it is |
|---|---|---|
| **Shift documentation** | `/api/visits/{id}.careNote` | What the caregiver wrote after the visit. This is what Care Notes Review shows. |
| Office notes | `/api/notes/client` | Notes staff typed on the client record. Authors are office staff, one cheap paginated list. Not currently used. |

`/api/notes/{entityType}` looks tempting because it is one cheap call, but it is
the second kind — it will not give you what a caregiver wrote about a visit.

### Tuning, and why it is the way it is

Measured on this account: a visit-detail call takes **~600ms**, and a worked week
is ~170 visits.

| Setting | Value | Why |
|---|---|---|
| `SOFT_DEADLINE_MS` | 5000 | Stops with room for one more request. An earlier 7000 overshot to 8.19s, uncomfortably close to a 10s platform limit. |
| `DEFAULT_DAYS` | 3 | The schedule only has to keep up. Same shape Client Concierge settled on. |
| `FRESH_DAYS` | 2 | Today and yesterday are **always re-read** — a caregiver may still be writing or correcting the note. Older days already stored are skipped. |
| `MAX_RATE_PER_SEC` | 5 | Only enforced if AxisCare answers faster than that. At ~600ms per call it never sleeps. |

### Manual backfill

```
/.netlify/functions/carenotes-sync?days=14
/.netlify/functions/carenotes-sync?days=14&maxMs=120000   # local only
/.netlify/functions/carenotes-sync?force=1                # ignore the skip
```

`maxMs` raises the per-run time budget. The 5s default exists to survive a
platform timeout on the schedule; the **local dev server has no timeout**, so a
hand-run backfill can use 60–120s and finish a week in one pass instead of
twenty. Capped at 600000.

Returns `{ ok, done, written, scanned, skipped, requests, ms, avgRequestMs }`.

**`done: false` is normal on the schedule** — each run does ~6 visits in 5s and
saves a cursor. At 96 runs a day against ~24 new visits it keeps up easily; it
just works in slices rather than finishing in one.

Visits with **no** care note are never stored, so they cannot be skipped and are
re-checked every run. Keeping `DEFAULT_DAYS` short is what stops that mattering.

**Needs Carlo:** the sync writes with `SUPABASE_SERVICE_ROLE_KEY`, a Netlify
environment variable. Anon can only *read* `care_notes`, so a stranger with the
site URL cannot forge or delete notes.

---

## Open shifts — how they are derived

**Correction.** An earlier version of this file said open shifts do not exist in
AxisCare. That was wrong, and it is worth knowing why: the finding came from a
`/api/visits` window that silently truncated to three days *in the past*, where
every unassigned visit happened to be a cancellation. The conclusion was drawn
from a biased sample.

The rule that actually works:

```
an open shift = a visit that is NOT removed
              + has NO caregiver
              + is scheduled in the FUTURE
```

Verified 2026-08-24: that returns exactly the shifts the previous dashboard
displayed — Ziad Niazi (Sep 6), Fayde Macune (Sep 7), Virginia Eddy (Sep 18),
all Thousand Oaks.

Both other conditions matter. Drop `removed` and cancelled visits appear as
coverage gaps. Drop the future check and every historical unassigned slot floods
the list.

`AxisLive.fetchOpenShifts()` scans a 28-day window: ~700 visits, 8 requests,
about 4 seconds. Widening the window costs proportionally.

### What AxisCare does not tell you about an open shift

- **When it became open.** There is no such field, so `openedAt` is `null`. An
  "open for 3 days" figure cannot be computed from the API.
- **Why it is open.** A call-off, a cancellation and a never-staffed slot are
  indistinguishable.

---

## The caregiver calendar — one caregiver's own visits

The month grid on a caregiver's workspace plots **their assigned client
visits**, live from AxisCare. A block is one visit: the client's name and the
scheduled times.

```
GET /api/visits?startDate=…&endDate=…&caregiverIds=<axisId>
```

### `caregiverIds` is the only parameter that filters

**This is the trap worth knowing.** `caregiverId`, `caregiver`, `employeeId`
and `caregiverExternalId` are all accepted with a **200 OK** and then silently
ignored — you get the whole unfiltered page back. Nothing errors, nothing warns,
and code written against any of them looks like it works right up until someone
notices another caregiver's clients on the calendar. Only the plural
`caregiverIds` actually filters. Verified on this account 2026-08-25.

The payoff is large. A month of *everyone's* visits is 932 records over 11
requests and ~7s. One caregiver over **fourteen months** is 351 records in 4
requests and ~2.3s.

### The window, and why it is fetched all at once

One month back, twelve months forward — exactly what the month arrows reach,
and they are disabled at both ends. The whole span is fetched in one go when
the caregiver is opened, so paging between months costs nothing afterwards.

A wide `/api/visits` window normally truncates, so this was checked rather than
assumed: the filtered 14-month pull returned **exactly** the same 351 visits as
fourteen separate per-month calls, provided `nextPage` is followed.

Visits do exist that far out — roughly 26 a month through Aug 2027 for an
active caregiver, because AxisCare generates them from the recurring schedule.

### An empty calendar arrives as a 404

A caregiver with no visits in the window returns:

```
HTTP 404   {"results":null,"errors":["No visits found"]}
```

**That is an empty calendar, not a failure**, and it is common — 126 of the 184
active caregivers had no visits in the current month. Treat 404 on this call as
zero results; anything else would paint a red error banner across two thirds of
the roster.

### Where it is loaded, and where it is kept

`CGVISITS` (near the bottom of `index.html`) fetches on the first render of a
caregiver's calendar — not at boot, because nobody who never opens a profile
should pay for it — and caches per caregiver.

It is deliberately **not** stored in `state`. `state.shifts` is a tracked CLOUD
slice, so a few hundred visits placed there would be written to Supabase as
though a scheduler had typed them by hand. That is the 323KB overlay bug in
*Don't break these*, and it would happen again.

### Three states, and only three

A day can read exactly one of:

| | Colour | Means |
|---|---|---|
| **Open** | green | the caregiver can take a shift |
| **Devoted** | blue | an assigned AxisCare visit, labelled with the client |
| everything else | red | cannot be assigned |

That last row covers **Unavailable, Off, Other Agency, School, Childcare,
Vacation and Sick**. The label inside the block still says which.

**School and Childcare are not availability.** Someone in class, or collecting a
child, cannot take a shift — so they clear `c.avail[day]` and carry no hours. If
a caregiver is free, the day says Open. `OFF_TYPES` and `NOT_OPEN` (next to
`RULE_STATUS`) are the single place that judgement is made; change them, not the
individual call sites.

A day with nothing recorded draws **nothing at all**. It used to say "Needs
update", which is true of every day of every live caregiver — no availability
has been entered for anyone — and papered over the visits that matter.

That is also why green and red are rare on real data today: only assigned visits
come from AxisCare. Availability is entered by schedulers, in the day panel.

### Long client names truncate; times do not

Real names are long — `Duane & Lynne Georgeson`, `Raymond "Nacho" Banales Jr.`
— and a `nowrap` label with nothing allowed to shrink pushed the whole month
past the panel edge. Three levels each had to be freed: the grid columns
(`1fr` means `minmax(auto,1fr)`, which will not go below min-content), the day
cell and block (a flex item defaults to `min-width:auto`), and the label itself
(`text-overflow:ellipsis` needs `overflow:hidden`).

The **name** truncates. The **time** is `flex:0 0 auto` and never does, so a
shift always reads its hours. The full name is in the `title`, and on the day
panel behind a click.

Client names go through `esc()` before reaching the `title` attribute. That is
not decoration: `Raymond "Nacho" Banales Jr.` is a real client on this account,
and an unescaped quote ends the attribute early and mangles the rest of the cell.

### Times come from the string, not the browser clock

AxisCare timestamps carry their own offset: `2026-08-01T15:30:00-07:00` is half
past three in the afternoon **where the visit happens**. Reading that through
`new Date()` and the viewer's clock moves it — on a laptop set to UTC+8 that
visit files itself under the 2nd at 6:30 AM. The wall clock is taken straight
off the string instead. The care-notes sync was bitten by the same class of bug;
see its section above.

---

## AxisCare — the connection is already set up and working

Confirmed live. Nothing needs configuring.

| | |
|---|---|
| Site | `https://7060.axiscare.com` |
| Auth | `Authorization: Bearer <token>` — always. There is no other scheme. |
| Version | `X-AxisCare-Api-Version: 2023-10-01` — a **required header** |
| Access | Read-only. The proxy forwards GET and nothing else. |

The browser never talks to AxisCare directly — it cannot, and the token must
never reach it. Instead the app calls its own Netlify function, which holds the
token server-side:

```js
await AxisCare.status()   // is it configured?
await AxisCare.ping()     // does the token actually work?
await AxisCare.get('/api/caregivers', { limit: 25 })
await AxisCare.get('/api/visits', { startDate:'2026-08-21', endDate:'2026-08-22' })
```

### How the live roster gets in

`ROSTER.hydrate()` runs at boot, before `CLOUD.boot()` takes its baseline
snapshot. It fetches the active roster (`statuses=Active`, two requests, ~1.7s),
maps each record with `AxisRoster.map()`, keeps Ana, and re-points any demo
record that referenced a caregiver who no longer exists.

From the browser console on the live site:

```js
await AxisCare.status()                       // is the proxy configured?
await AxisCare.ping()                         // does the token actually work?
await AxisCare.roster()                       // the mapped live roster
await AxisCare.roster({ raw:true })           // untouched AxisCare records
AxisRoster.report(await AxisCare.roster())    // coverage summary
ROSTER.status()                               // what the last hydrate did

CGVISITS.status('a731')                       // a caregiver's calendar load
CGVISITS.info('a731')                         // { count, from, to, requests }
CGVISITS.retry('a731')                        // clear the cache and refetch
```

`CGVISITS.info()` returning `count: 0` with `status: 'ready'` means the
caregiver genuinely has no visits, which is the common case — not a failure.

### Two traps that cost real time

- **Paths are unversioned.** `/api/caregivers`, never `/api/v1/caregivers`. Any
  version-looking segment returns `400 "Unsupported version"`.
- **The version check runs before authentication.** A wrong or missing version
  header returns the same 400 whether the token is valid, invalid or absent — so
  a version problem masks everything else. Rule out the version first, always.
- **`/api/visits` silently truncates, and paginates differently.** A four-week
  window returned 88 visits covering only **three days**, with the rest behind
  `results.nextPage`. Worse, visits page on `nextPageToken` while caregivers
  page on `startAfterId` — so code copied from one to the other looks right and
  quietly returns a fraction of the data. Always follow `nextPage` until it is
  absent.

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

**Roster reality:** 643 caregivers, **180 active**. Note `status.active` is
`true` for *Temporarily Unavailable* and *On Vacation Leave* as well as *Active*
— so filtering on `status.active` alone includes people who are not currently
schedulable. Check `status.label` when that distinction matters.

**Field coverage across active caregivers** — how often a field actually has a
value, which is what determines whether a UI column is worth adding:

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

It also accepts **`caregiverIds`**, which narrows the result to one caregiver
and is what the caregiver calendar uses. Be careful with the name: the singular
`caregiverId`, and `caregiver`, `employeeId` and `caregiverExternalId`, all
return 200 and are then **silently ignored**. See *The caregiver calendar* above.

A query that matches nothing returns **404 `"No visits found"`**, not an empty
array.

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

This is the richest endpoint and the most useful one for this dashboard. Current
volume is roughly **90 visits a week**. Because every visit carries both the
scheduled and the actual times plus clock-in/out, this is what makes real
punctuality and hours possible.

### `/api/schedules` — **requires a date range**

Returned at `results.schedules` as an **array**. Needs `startDate` + `endDate`,
or `scheduleIds`, otherwise `422`.

```
scheduleId, planId    number
type, day             string
client                { id, firstName, lastName, externalId }
caregiver             { id, firstName, lastName, externalId }
startTime, endTime    string
startDate             string
endDate               string | null
frequency             number
timezone              string
service               { id, code, description, procedureCode }
```

Schedules are the recurring *plan*; visits are what is actually on the calendar
and what happened. For "what needs attention today", visits are the right source.

### Also available

`/api/contacts`, `/api/applicants`, `/api/call-logs`, `/api/adls`,
`/api/organizations`, `/api/taggingCategories`, `/api/classes/{type}`.

---

## What AxisCare does NOT have

**Claude: if any of these come up, explain this before writing code.** These are
reasonable things to expect, so don't make it sound like an obvious mistake —
just explain what was found and move to what does work.

| Wanted | Reality |
|---|---|
| Caregiver reliability %, call-off count, decline count | **No such field.** `null` on real caregivers, rendered as "Not tracked". *Derivable* from `/api/visits` — compare `clockIn.time` against `scheduledStartDate`, and treat a visit with no `clockIn` as a no-show. |
| Hours worked this week | **No such field.** Derivable by summing visit durations per caregiver over a date range. |
| Which clients a caregiver has served before | **No such field**, but easily derived — `/api/visits?caregiverIds=…` returns exactly that. The caregiver calendar does it. |
| A Mon–Sun availability grid | **Does not exist.** Only the coarse class tags above (`WKDY`, `WKND`, `MRNNG`, `NOVRN`…), and only for 60% of caregivers. |
| A clinical skills list | **Does not exist** as a field. Only class tags. |
| Client medications | **Cannot be fetched.** A limitation in AxisCare's own API, confirmed on the Client Concierge dashboard where the medications call returns `403` on every client. The Medication List screen here is demo data. Not fixable in code, and no re-sync or deploy would change it. |
| Caregiver availability (a Mon–Sun grid) | **Does not exist.** The calendar shows *assigned visits*, which are real. The open/unavailable days beside them come from availability a scheduler typed in, not from AxisCare. |
| Writing anything back to AxisCare | Not possible through this app. The proxy is read-only by design and forwards GET only. |

The pattern worth internalising: **AxisCare knows identity, status, location,
tags and what happened on each visit. It does not know derived judgements about a
caregiver.** Anything evaluative has to be computed from visit history.

---

## Checking what AxisCare really returns

Rather than guessing, look. Open this in a browser on the live site — it is one
URL, and the answer is in the response:

```
https://<the-site>.netlify.app/.netlify/functions/axiscare?action=ping
https://<the-site>.netlify.app/.netlify/functions/axiscare?action=status
https://<the-site>.netlify.app/.netlify/functions/axiscare?action=get&path=/api/caregivers&q_limit=1
```

Query parameters are passed with a `q_` prefix — `q_limit=25`,
`q_startDate=2026-08-21`. Then read down this list; the first match is the answer:

| What comes back | What it means |
|---|---|
| `"ok": true` with data | Working. If a field is missing from the response, AxisCare doesn't have it — check the tables above. |
| `503 "not configured"` | Environment variables missing on Netlify. **Carlo.** |
| `400 "Unsupported version"` | `AXISCARE_API_VERSION` is wrong. **Carlo.** Rule this out before blaming the token. |
| `401` / `403` | Now it really is the token — wrong, expired, or lacking permission. **Carlo.** |
| `422` | Missing required query parameters. AxisCare says which, in `axisError`. Usually a missing date range on visits or schedules. Fixable here. |
| `400 "not in the allowlist"` | The path is deliberately restricted so the proxy can't be pointed at arbitrary URLs. Adding one is an environment variable. **Carlo.** |

`status` reports whether the token is present and how long it is; it never
returns the token itself.

---

## Known and accepted — don't re-flag these

**Claude: these are deliberate decisions, already reviewed. Mentioning them once
in context is fine; treating them as bugs to fix is not.**

- **The dashboard has no login.** Anyone with the link can open it. Accepted for
  an internal MVP.
- **The AxisCare proxy does not check who is calling.** Someone with the site
  URL could pull real client data from it directly. Reviewed and accepted on
  2026-08-21 while the app is in development and the URL is known only to the
  team. It is written up in `README.md` under *Security posture*, with the
  trigger for revisiting it and the ten-minute fix.

Neither is an oversight, and neither needs raising again unless the situation
changes — the app starts showing real AxisCare data, the URL gets shared more
widely, or it goes into daily scheduling use. If one of those happens, mention
it once, plainly, and point at the README. It is **Carlo's** call and Carlo's
side to implement.

---

## Things that look like fixes but aren't

- **Redeploying doesn't refresh AxisCare data.** There is no cached copy to
  clear — every call goes to AxisCare live (with a 60-second cache inside the
  function). If a value looks stale, it is stale *in AxisCare*.
- **Editing `netlify/functions/axiscare.js` won't make a new field appear.** The
  proxy is deliberately generic and passes through whatever AxisCare returns. If
  a field isn't in the response, AxisCare doesn't have it.
- **Supabase isn't involved in AxisCare at all.** Supabase stores the
  scheduler's own work (tasks, handoff notes, care-note reviews). If an AxisCare
  question seems to need a Supabase change, the approach is off.
- **A blank field is usually empty data, not a bug.** Try a second record. One
  blank is usually genuinely empty; every record blank is usually a wrong key.

---

## Don't break these

`index.html` is safe to edit freely, with the exceptions below. Full detail is
in `README.md` under *How the data model works*.

1. **The `CLOUD` persistence module** (the block headed `CLOUD PERSISTENCE`).
   This is what saves the scheduler's work and shares it between the three
   schedulers. It works by saving only what a human changed, replayed over
   freshly generated demo data — which is why the "Today" clock stays correct
   instead of freezing at the first save.

2. **The boot order at the very end of the file.** `CLOUD.boot()` must be the
   last thing that runs. The sequence inside it is load-bearing and was arrived
   at by fixing two real bugs:

   ```
   primeLazy()
   render()                 paint on the demo roster
   ROSTER.hydrate()         real caregivers land HERE, before the snapshot
   -> finishBoot():
        render()            flush lazily-created ops fields FIRST
        BASE = snapshot()   baseline now includes them
        applyOverlay()      replay saved work
        ROSTER.reconcile()  the overlay can bring back deleted caregiver ids
        render()
   ```

   Snapshotting before that first `render()` put all 184 caregivers into the
   overlay (323KB written to Supabase as though a human typed them). Skipping
   `reconcile()` after `applyOverlay()` let a saved overlay resurrect a deleted
   caregiver id and crash the Today board. Both have regression tests.

3. **`ROSTER.reconcile()` must run after *every* overlay application** — the
   local one at boot and each Supabase pull. A saved overlay predates the roster
   swap and can reference caregivers who no longer exist.

4. **`config.js` is generated at deploy time** from Netlify environment
   variables. Editing it has no effect — the build overwrites it. The committed
   copy is intentionally empty.

5. **Caregiver visits must stay out of `state`.** `CGVISITS` keeps them in its
   own cache. Moving them into `state.shifts` looks like a tidy-up — it is a
   tracked CLOUD slice, so several hundred visits would be diffed into the
   overlay and written to Supabase as though a scheduler typed them. That is
   bug 2 above, again. `state.shifts` holds *open* (unassigned) shifts only.

Two smaller notes for anyone wiring real data later: several places derive values
from the numeric part of a demo id (`parseInt(c.id.slice(1))` on `'c7'`), which
AxisCare ids would break; and AxisCare city strings are dirty — `CAMARILLO`,
`Camarilllo`, `"Oxnard "` and `oxnard` are four distinct values today, and around
40% of active caregivers live outside Ventura County so they are absent from the
app's distance map.

---

## Sync status — what the pill in the top bar means

| Pill | Meaning |
|---|---|
| **Synced** | Saved and shared with the other schedulers |
| **Saving** | Write in flight |
| **Local** | No Supabase keys — saving to this browser only. **Carlo.** |
| **Offline** | Database unreachable. Work is still saved locally and pushed on reconnect. |
| **Sync error** | Hover it for the reason. If everyone sees it, **Carlo.** |
