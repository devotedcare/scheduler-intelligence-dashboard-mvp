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
| **Open shifts** | **Mirrored** — derived by `openshifts-sync` into `public.open_shifts`, read from there. Falls back to the live scan when the mirror is cold |
| **Caregiver calendar** | Live — each caregiver’s own scheduled client visits |
| **Care notes** | Live — swept into Supabase on a schedule, read from there |
| Medication lists | Cannot be fetched. AxisCare API limitation |
| Attendance history | No AxisCare source. Derivable from visit clock-ins, not built |
| Tasks, handoff notes, contact log | The dashboard's own records, entered by schedulers |

**There is no sample data, and no way to bring it back.** `state` ships
`caregivers: []`, `clients: []` and `shifts: []`, and `hydrate()` fills them from
AxisCare. If a screen is empty it is because AxisCare genuinely has nothing, or
because the fetch failed — and the banner says which.

> **Corrected 2026-09-03.** This section used to describe a `purgeDemo()` that
> cleared seed records at boot, and a console recipe — `DEMO.on()` / `DEMO.off()`
> / `DEMO.isOn()` — for restoring them. **None of it exists.** `purgeDemo` appears
> nowhere in the repo, and there is no `DEMO` object: every occurrence of the
> token in `index.html` is inside a comment, so `DEMO.on()` throws
> `ReferenceError`. The seed records went with the toggle. Anyone following the
> old instructions got an error and, worse, may have believed what was on screen
> was sample data. It is live.

### The banner tells you where the data came from

`demoNotice()` renders exactly one of these, in priority order:

1. **Couldn't reach AxisCare** (red) — names the reason, offers Retry, and says
   plainly that nothing is shown rather than something invented
3. **Some AxisCare data didn't load** — a partial failure, naming what failed
4. **This screen has no AxisCare source** — `NO_AXIS_SOURCE` holds exactly two
   entries: **medications** and the **contact log**. Each explains *why*, because
   "empty" and "not available" are different messages
4b. **Care notes** — a note about the sync mirror, on that screen only

> The numbering skips 2 because the source does. There is no sample-data banner
> (there is no sample data), and the green **live confirmation** on Open Shifts
> was removed on request — `demoNotice()` says so in place of the branch.
> Attendance had a `NO_AXIS_SOURCE` entry and it was removed on request too, so
> the list above named four screens where the code has two.

Do not remove these. If a request sounds like "clean up the banners", the honest
fix is to wire the missing data, not to hide the label.

### Figures that read "Not tracked"

Reliability, call-off counts, decline counts and availability-verification
history have **no AxisCare source**. On a real caregiver they are `null` and
render as "Not tracked".

> **Hours worked is no longer one of them.** `CGWORK` derives real hours from
> AxisCare visits and renders a figure. The `weekHrs` field on the caregiver
> record is still `null` and still reads "Not tracked" — the two are different
> things, and it is `CGWORK` that has the answer.

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

**Each run stops at a 5-second soft deadline** (`SOFT_DEADLINE_MS = 5000`,
carenotes-sync.js:55 — this line said 7 seconds and contradicted the tuning
table 25 lines below it) and saves a cursor
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

`AxisLive.fetchOpenShifts()` scans from **today to the end of NEXT month**, so
a scheduler filling next month’s gaps sees all of them rather than a rolling
window that cuts the month in half. `opts.days` still overrides it.

Measured 2026-09-03, which is what that window actually costs:

| | |
|---|---|
| window | 2026-09-03 → 2026-10-31 (58 days) |
| requests | **14** |
| visits scanned | **1,321** |
| open shifts found | **12** |
| elapsed | **9.1s** |

Fourteen requests and over thirteen hundred visits, on every page load, to
produce twelve rows. That is the single most expensive thing the boot does
and the reason the caregiver list no longer waits for it (see 3b in
*Don’t break these*), and it is the strongest argument for mirroring open
shifts into Supabase rather than deriving them in the browser.

> An earlier version of this section said "a 28-day window: ~700 visits, 8
> requests, about 4 seconds". Every one of those numbers was stale — the
> window was widened to end-of-next-month and the doc was not updated.

### Open shifts are MIRRORED, not scanned in the browser

Added 2026-09-03. The rule is unchanged — it just runs in
`netlify/functions/openshifts-sync` now, once for the whole desk, instead of
in every session on every page load.

```
openshifts-sync (*/10, and on read)  ->  public.open_shifts
the dashboard reads that table       ->  2 requests, ~0.7s
```

Measured against the live account, both paths run back to back:

| | live scan | mirror |
|---|---|---|
| requests | 14 | **2** |
| visits scanned | 1,321 | — |
| elapsed | 9,085ms | **666ms** |

**13.6× faster, and the records are byte-identical** — verified by running both
paths in the same process and comparing every field of every shift. That
identity is load-bearing, not cosmetic: `shifts` is a tracked CLOUD slice, so a
mirrored record that differed from the scanned one in any field would be diffed
into the overlay and written to Supabase as though a scheduler had typed it.
`mirrorRowToShift()` reproduces `mapOpenShift()` exactly, including building
`end` from `new Date(undefined)` when AxisCare gave no end — an Invalid Date,
copied rather than improved, because a `null` there would be a different value
in the diff.

#### It falls back to the live scan, and that is the point

If the sync has never completed a scan, or the heartbeat is cold, or Supabase
is unreachable, `fetchOpenShiftsMirrored()` returns the live scan instead. Both
paths were tested by ageing the heartbeat:

```
heartbeat aged 2h   -> "live scan - mirror is 120m old"        9 shifts, identical
last_ok_at null     -> "live scan - the sync has not ..."      9 shifts, identical
```

So the first deploy is a non-event — schema, function and `index.html` can land
in any order — and a dead sync degrades to exactly the app we had yesterday
rather than to a blank coverage board. Slow and right beats fast and wrong.

**Ageing out reads `last_ok_at`, never `last_run_at`.** Only a run that scanned
the WHOLE window is evidence that a shift missing from the results is no longer
open. A partial run updates `last_run_at` and must not make the mirror look
fresh.

#### The deletion rule

A shift leaves the table for two reasons and they are **not** equally safe:

- **evidence** — we looked at that visit and it now has a caregiver, is removed,
  or is in the past. Safe on any run.
- **absence** — we did not see it at all. Safe **only** after a complete scan.

A run that dies half way, hits the page cap, or takes a 429 on page 9 has not
observed the back half of the window, and deleting on that would empty the
coverage board with no error anywhere. So the sweep runs only when the scan
completed. That is the whole reason `last_ok_at` exists separately.

#### Stale-while-revalidate

The dashboard reads the mirror and then POSTs to the sync **without awaiting**
it. AxisCare load therefore follows real usage: a quiet weekend costs nothing, a
busy desk keeps the mirror sharp. A fixed 5-minute cron would burn roughly 4,000
AxisCare requests a day whether or not anyone was working.

That only works because the function holds a **lock** and a **debounce**. Three
schedulers opening at 9am would otherwise fire three concurrent scans of 14
requests each, and CLAUDE.md already records the Client Concierge dashboard
collecting `429`s learning exactly that. Verified: a second run 41 seconds later
returned `skipped: "synced recently"` in 317ms.

The `*/10` cron in `netlify.toml` is a **floor**, not the mechanism — it exists so
the first person in each morning is not the one who eats the staleness.

#### `shift_date` is sliced textually, never cast

AxisCare stamps its own offset. `2026-09-18T20:00:00-07:00` is the **18th** where
the visit happens and the **19th** in UTC. Measured on the live mirror: **2 of 9**
rows would have landed on the wrong day under a naive cast, and both matched the
date AxisCare itself puts in the visit id (`d=2026-09-18`). The care-notes sync
and the caregiver calendar each had to fix this same bug; the mirror avoids
inheriting it by taking the leading `YYYY-MM-DD` from the string.

#### What the mirror does NOT know

An assignment made inside this dashboard never reaches AxisCare — the proxy
forwards GET only — so a shift filled here stays in the table until somebody
types it into AxisCare. That blind spot is not new (the live scan had it too),
but it means these rows are **open in AxisCare**, not **needs coverage**.

### The list is loaded once; the ASSIGNMENT is re-checked

`fetchOpenShifts()` has exactly one call site — inside `hydrate()`’s
`Promise.all` — and `hydrate()` runs only from `boot()` and `retryAxis()`.
Nothing else refreshes it, no timer, no poll. **So the open-shift list is as old
as the tab.** Four hours open, four-hour-old coverage gaps.

Observed on 2026-09-03: the Brenda Janowski 8a–8p visit
(`v=56967:s=0:d=2026-09-03`) read `caregiver: null` in the morning and
`caregiver: 1104` by the afternoon — filled in AxisCare while every open session
went on offering it and ranking caregivers for it.

Re-scanning the window costs what the boot costs: 8 requests, ~640 visits, ~5s.
Re-checking **one** visit costs **1 request, ~890 bytes, ~1s**:

```
GET /api/visits?visitIds=v=56967:s=0:d=2026-09-03
```

And the only moment the answer has to be right is the moment somebody assigns.
So `verifyShiftStillOpen()` runs there instead, and both assign paths funnel
through `guardAssign()`: `assignShift` → `assignShiftNow`, and `doAssign` →
`doAssignNow` (which also covers `dispAccept` and `confirmBlockOverride`).
Every existing call site keeps its old name and gets the check for free.

Three rules in it, all deliberate:

- **A shift with no `axisVisitId` is not checked.** It is an in-app record; there
  is nothing upstream to disagree with.
- **AxisCare unreachable does NOT block the assignment.** The proxy is read-only,
  so this record is the desk’s own work, and refusing to let them work because a
  third-party API is down is worse than proceeding. It says it could not check —
  the same distinction `genderKnown` draws in Find Coverage. A 404
  (“No visits found”) is ambiguous and lands here too.
- **A refusal rewrites nothing.** `openStaleShiftWarn()` explains and offers a
  reload. Silently setting `s.assigned` to whoever AxisCare now shows would be an
  edit to a tracked CLOUD slice, made on one scheduler’s behalf, that they never
  asked for and the other two would inherit.

**Claude: do not optimise this into a check against `state.shifts`.** The whole
point is that `state.shifts` is the stale thing. It has to be a live call.

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
child, cannot take a shift. If a caregiver is free, the day says Open.
`availTone()` — right beside the `AVAIL` module at the bottom of the file — is
the single place that judgement is made; change it, not the individual call
sites. It is deliberately one line: **Open is green, every other status a
scheduler can record is a reason they cannot work, and reads red.**

> An earlier version of this section pointed at `OFF_TYPES` and `NOT_OPEN`,
> next to `RULE_STATUS`. Those constants belonged to the weekly-rule model and
> were deleted with it — editing them would have done nothing.

A day with nothing recorded draws **nothing at all**. It used to say "Needs
update", which is true of every day of every live caregiver — no availability
has been entered for anyone — and papered over the visits that matter.

That is also why green and red are rare on real data today: only assigned visits
come from AxisCare. Availability is entered by schedulers, in the day panel.

## How availability works

**A caregiver is available only on dates where a scheduler logged an `Open`
block.** A date with nothing recorded means not available. AxisCare class tags
never count. This is Carlo's rule, decided 2026-08-26, and it is deliberately
strict: Find Coverage should never offer somebody the desk has not confirmed.

**An `Open` block may be timed or whole-day.** Whole-day means free the whole
of *that date*, 00:00—24:00, and Find Coverage reads it as covering any shift
inside the day. The calendar draws it with **no time at all**, because no time
*is* the statement — `dayBlocks()` sets `full` and `blkTime()` returns `''`.

It covers that date and stops at midnight. A 10pm—2am shift is **not** matched
by a whole-day Open, because somebody free "all day Tuesday" has said nothing
about Wednesday. A caregiver who genuinely works overnight is entered as a
timed block, which is stored past 1440 and carries — see *An overnight answers
for the morning it runs into*.

> This changed on **2026-08-27**. Until then a CHECK constraint
> (`caregiver_availability_open_timed_ck`) forbade it, on the reasoning that an
> untimed Open claimed hours nobody had stated. The desk decided the opposite:
> "free all day" is a real answer a scheduler gives. The constraint is dropped
> in `schema.sql`, and the 506 migrated rows that were `Open 00:00—24:00` — the
> old app’s `Anytime` label — were converted to whole-day rows, which is what
> they always meant.

**A tag paints no further than the day it was typed on.** Every status behaves
the same way: one day tagged is one day tagged.

### The day panel has five tabs

The panel that opens on a calendar day keeps its date header and ×, and
carries a navbar beneath it. Every day opens on **Availability**; the tab is
not remembered between days.

| Tab | Icon | What it holds |
|---|---|---|
| **Availability** | `calendar` | The editor described above — status, Apply to, Time. The only tab that writes `caregiver_availability`. |
| **Notes** | `forms` | One note for the day. Its own Save. |
| **Delete** | `trash` | The same month picker as *Selected days*, and a Delete that clears the chosen days’ availability. |
| **Cadence** | `refresh` | Placeholder. The existing review cadence (`availCheckFreq`) is edited elsewhere and was not touched. |
| **History** | `history` | Placeholder. |

**Only Availability has a Save that writes availability.** Notes has its own
Save, Delete has a red Delete, and Cadence and History have no footer at all —
a Save button on a tab with nothing to save is a lie.

**Delete keeps its own date selection** (`modalState.delPicked`), separate
from the Availability tab’s `picked`. The grid behaves identically; the sets
are separate so a multi-day availability pick can never become a multi-day
delete by accident.

### The day note is NOT part of the availability

**Claude: do not move it back onto the availability row.** It lived there
until 2026-08-28 and every one of these was broken by it.

A note is about the **date**, not about a block of hours. It lives in its own
table, `public.caregiver_day_notes`, one row per caregiver per date:

- it can be written on a day with **no availability at all**
- **replacing** the day’s hours leaves it alone
- **clearing** the day’s availability (the Delete tab) leaves it alone
- an **empty** note deletes the row rather than storing a blank, so “has a
  note” is simply “a row exists”. A CHECK constraint refuses `''`.

While it was a column on `caregiver_availability`, none of that held: every
save carried `modalState.note` onto the new segments, so editing the hours
rewrote the note, and clearing the day deleted it with the rows. `dpDraft()`
now sends `note: null` on every entry, and the column is legacy — nothing
writes it any more.

The **1,182 notes already written** — real sentences from Mae, Angelica,
Beatrice, Joan and Tine, like “Family Reunion” and “Dropping off her daughter
at LAX for a trip.” — were moved across on 2026-08-28 with their authors and
timestamps intact. No day held two different notes, so it was a 1:1 move.

`NOTES` (beside `AVAIL` at the bottom of the file) loads one caregiver’s notes
over the same 13-month window the calendar arrows reach, and `calDayStatus()`
reads it for the note marker on the grid — not the availability rows.

> The panel can open before the notes land. `openDayPanel` seeds the box from
> the cache if it is warm, `NOTES.load()` re-renders when the fetch resolves,
> and the Notes tab adopts the stored note then — unless the scheduler has
> already typed, which `modalState.noteTouched` records. Without that flag a
> slow fetch would overwrite what somebody was in the middle of writing.

> Between **2026-08-26 and 2026-08-28** it did not. `carriedBlocks()` let a
> future date with nothing stored inherit the most recent SAME-WEEKDAY date
> that was entirely `Open`, for up to twelve weeks — a caregiver’s "normal
> week" answering for dates nobody had typed. Because the search skipped any
> day that was not entirely Open, **only Open carried**, and in a month grid
> the same weekday is a vertical column: an Open block painted straight down
> it while Unavailable stayed put. That asymmetry is what the desk reported.
>
> It also contradicted the rule directly above, and Find Coverage acted on it
> — offering caregivers at 3am on dates nobody had confirmed. Removed on
> 2026-08-28 along with `CARRY_WEEKS`, the `carried`/`carriedFrom` flags, the
> faded `.cal-blk.carried` styling and the `dayAvail` branch that read it.
>
> Nothing was ever written by the carry — it was read-time only — so no rows
> needed cleaning up. The one path that could have made a phantom real was
> `dpSave`’s **Add** verb, which reads `AVAIL.forDay()` as "what the day already
> holds"; `forDay` returned carried blocks, so an Add on a carried day would
> have written them. The table was checked and no such row exists: every
> app-written day holds exactly one status.

Rows live in `public.caregiver_availability`, one per segment, keyed by the
**AxisCare numeric id**. An overnight is stored on its **start date** with
`end_min` past 1440, so 8pm–8am is `1200..1920` and reads as `20..32` in the
decimal hours the calendar uses — the same shape an AxisCare overnight visit has.

### AxisCare visits carve, at save time

A Devoted visit outranks anything a scheduler types. Entering **Open 9a–5p** on
a day AxisCare has a visit **1p–2p** stores *two* rows — `Open 9a–1p` and
`Open 2p–5p`. The visit itself is never stored: AxisCare stays its own system
of record, and Find Coverage needs no AxisCare call because the table is
already correct.

**Only `Open` is carved.** A visit landing on Vacation, Unavailable, School or
Other Agency is a *disagreement between two systems*, not something to resolve
silently — `calDayStatus()` sets `conflict` and the day panel says so.

**A whole-day `Open` is carved too, and loses its whole-day shape doing it.**
The table has no way to say "all day except 1—2pm", so `Open all day` on a date
with a 1pm—2pm visit stores `Open 00:00—13:00` and `Open 14:00—24:00`. That is
not a wart: leaving it uncarved would hand Find Coverage a caregiver already on
a visit, which is the single failure the carve exists to prevent. A deferred
trigger (`caregiver_availability_day_shape_t`) enforces the rest — a day is one
whole-day entry *or* timed segments, never both — so there is no shape where a
whole-day Open sits beside a timed row.

A visit of **24 hours or more is not carvable** (`carvableVisits` treats it as a
`mapCgVisit` artefact) so the block is left standing and flagged, exactly as it
was before.

#### `carvableVisits()` reads THREE dates, not one

A visit and an availability block can each cross midnight, and both are stored
on the date they **start**. So carving date `D` composes three sources into
`D`'s own minute frame — minutes from *its* midnight, which means a window may
legitimately sit outside `0..1440`:

| source | shift | why |
|---|---|---|
| `D` | `0` | a normal visit, and the front half of an overnight |
| `D − 1` | `−1440` | **last night's visit running into this morning** |
| `D + 1` | `+1440` | tomorrow's visit, so an overnight *block* is cut by what it runs into |

The middle row is the one that was missing until 2026-09-02. Because
`CGVISITS.forDay()` keys strictly on the start date, a visit running Sep 7
8pm → Sep 8 6am was **invisible on Sep 8**: a whole-day Open saved there stored
midnight–6am as free while the caregiver was still on the visit. It affected 21
caregiver-days, and neither Find Coverage screen catches it. `AVAIL.carryWindows()`
had always understood that a block reaches into the next date; visits now do too.

The third row matters for Elizabeth Galang's shape — an `Open 8p–8a` block is
stored `1200..1920`, and without it no morning visit could ever cut it.

`netlify/functions/availability-copy.js` has the same logic in `visitWins()`, and
its visit pull is deliberately **one day wider at each end** — without that the
`D − 1` source is empty for the first date of the window, which is *today*, the
date the desk is actually looking at.

Consequences, all deliberate:

- The carve at save time is a **snapshot**, and an hourly **re-carve** is what
  keeps it honest. See *The re-carve* below. Enter availability before the visit
  exists and the save carves nothing; the sweep fixes it within the hour.
  Read-time carving would not drift at all, but costs an AxisCare call per
  search, which is why it is still not done that way.
- The re-carve only ever **subtracts** — see *A cancelled visit leaves its hole*
  below. Re-saving the day in the panel is the fix.
- `dpSave()` **refuses to save** unless `CGVISITS.status(c.id) === 'ready'`.
  `forDay()` answers `[]` for a *failed* fetch exactly as it does for a day
  with no visits, and storing uncarved availability is worse than storing
  nothing — Find Coverage would offer somebody already on a visit and nothing
  re-checks.
- Visits are **decimal hours**, availability is **minutes**; carve in integer
  minutes. A visit with `end: null`, a zero-length one, or one `mapCgVisit`
  inflated to 24h is *not carvable* — leave the block alone and flag it.
- A visit that merely **abuts** a block (ends exactly when it starts) carves
  nothing.
- Re-carving already-carved rows is a **no-op**, which is what makes Add safe.
- `dpSave` reads `existing` **per target date** and writes one `saveDays` call
  per distinct carved result. Reading it once from the anchor copied that
  day's holes onto dates with no such visit.

### The re-carve — the carve corrects itself hourly

**Claude: the save-time carve is no longer the only guard. Do not remove this
pass, and do not widen what it is allowed to touch.**

Added 2026-09-02, after the desk reported Alrenz Ellivera reading as **whole-day
Open on 2026-09-12** while assigned to a new client, Jose Ortiz, 8a–8p.
Nothing was broken in `carveSegs()`: the availability was saved on 09-01, the
visit was assigned on 09-02, and no code ever looked again. Sept 6 and Sept 13
were wrong the same way, and 41 rows across 9 caregivers were wrong roster-wide.

`planRecarve()` in `netlify/functions/availability-copy.js` re-derives **every
future day that already holds rows** against the visits AxisCare has *now*, and
rewrites the day if the answer differs. It runs as **pass A** of the hourly
`availability-copy` job (`:35`, `netlify.toml`), before the monthly copy.

Four rules, all load-bearing:

- it **never changes a status**. Only `Open` is cut. A visit on Vacation or
  Unavailable stays the disagreement it is, for a person to resolve.
- it **never widens**, so it cannot invent availability.
- it **never touches the past** — days before today are history.
- it writes the day back under **its existing author** (`dayAuthor()`), not as
  `Auto-copy`. The panel's history line should still say who decided the
  caregiver was available. Days are written whole, so a day carries one author
  in all but 1 of 11,704 cases.

It has **no human-author guard**, unlike `planMonth()`. That is deliberate and
is the whole point: the Alrenz row was authored by a person, and the copy's
guard would have skipped it.

It is **idempotent** — the second run changes nothing — which is what makes it
safe unattended. It has no cursor: a reconciliation sweep must restart from the
first caregiver, or it would skip exactly the ones whose visits just moved.

The first sweep ran 2026-09-02: **63 caregiver-days across 11 caregivers**.

### …and the same correction the moment a calendar is opened

`recarveOnOpen()` in `index.html` is the browser twin, run from `cgCalendar()`
once `AVAIL.load()` and `CGVISITS.load()` have both settled. It earns its place
twice over: it is **instant** rather than up to an hour later, and `CGVISITS`
holds **thirteen months** of that caregiver's visits where the server sweep
pulls 92 days — so days beyond December are corrected here and nowhere else.

It costs no AxisCare call: the visits were already fetched to draw the calendar.

`CGVISITS.load()` **returns a promise** for this reason. It used to return
nothing, so the only way to react to visits landing was to wait for a later
render — which is why `cascadeNextMonth()` was chained on `AVAIL.load()` alone
and usually found `CGVISITS.status()` still `'loading'` on the first open.

> **Claude: this WRITES as a side effect of opening a page**, which is the shape
> of half of *Don't break these*. `recarveDone` is what stops it running on
> every render — do not remove it and do not make it depend on anything that
> changes between renders. `cascadeReset()` clears it after a human save.

`AVAIL.saveDays()` and `patchIndex()` take an optional `author` for this: the
re-carve is narrowing somebody else's row, not making a statement of its own,
so the day keeps the name already on it. One call writes one name, so callers
passing it must group their dates by author.

### KNOWN, OPEN: a cancelled visit leaves its hole

**Reported by the desk 2026-09-02. Not fixed — do not treat it as a bug to
quietly "solve" without checking, and do not paper over it.**

The carve only ever **subtracts**. Cancel or move a visit in AxisCare and the
availability it cut stays cut: `Open 6a–9p` carved to `Open 6a–8a` around an
8a–8p visit does not grow back to 6a–9p when that visit is removed. The
caregiver reads as less available than they are, and nobody is told.

Why it cannot simply be reversed: **the uncarved intent is never stored.** The
table holds what survived the carve, not what the scheduler originally typed,
so there is nothing to restore from. `AVAIL` cannot tell `Open 6a–8a` that was
cut from 6a–9p apart from `Open 6a–8a` somebody typed.

The shapes a fix could take, none of them free:

| approach | cost |
|---|---|
| store the **uncarved** block alongside the carved rows | a schema change and a second source of truth to keep in step |
| carve at **read** time instead | never drifts, but an AxisCare call per coverage search — the reason it is not done that way today |
| re-derive from the **monthly copy's** source shape | only works for days the copy owns, and only while the source month survives |
| a **cancellation feed** — re-widen when a visit turns `removed` | `/api/visits` does return `removed`, so this is probably the cheapest real fix: on seeing a visit go `removed`, restore the day from the copy source or flag it for a human |

Until then the honest workaround is the one that already exists: **re-save the
day in the panel** and it carves correctly against the visits as they now
stand. Worth surfacing on the calendar rather than leaving silent.

### The shortest block worth storing is three hours

`AV_MIN_MIN = 180`, **strictly under**, defined in *both* `index.html` and
`availability-copy.js` — **keep the two in step** or the copy proposes a shape
the browser would never write and re-proposes it every run.

Coverage is all-or-nothing (`coverageDetail()` returns `full` or `none`, never
`partial`), so a block shorter than the shortest real shift can never put
anybody on a visit. A 6a–9p Open cut around an 8a–8p visit leaves 6a–8a and
8p–9p; both are noise.

**`Open` and nothing else.** `Unavailable`, `School`, `Childcare` and
`Appointment` are real statements at any length — somebody genuinely can be
unavailable for an hour, and a two-hour appointment is a normal entry. Deleting
those would throw away the reason a caregiver cannot work. `Vacation` is
whole-day and never reaches the test. Only `Open` is ever carved, so this also
makes the rule exactly "what the carve produces".

**Applied to the whole result, not only the pieces this carve just cut.** A
sliver is a sliver however it got there, and scoping it to fresh cuts made them
permanent: a remnant written on Monday no longer overlaps the visit that
produced it, so Tuesday's carve passes it straight through and nothing ever
cleans it up. That was briefly the behaviour on 2026-09-02 and it left 17
uncleanable rows behind.

A block somebody **types** too short is refused in `dpDraft()` with a message
rather than silently dropped — they would otherwise leave the panel believing
it saved.

Exactly 3:00 is **kept**: 65 of Bianca Rivera's rows are exactly 3–6pm, and
rounding them away would empty a real calendar.

**The drop may leave the day with nothing, and that is the right answer.** A
caregiver whose only free hours are unusable has no availability worth
recording, and the visit on the grid explains the day.

### An empty day is owned by nobody — `copyClashes()`

**Claude: this is the guard that makes an empty day safe. Do not remove it.**

`AVAIL.copyOwns()` is `segs.length > 0 && every(Auto-copy)`, so a day with **no
rows** passes nobody's ownership test. `copyPlan`'s "leave a person's day
alone" guard never fires on it, and the monthly copy writes last month's
weekday pattern straight over a day somebody had deliberately cleared.

That is not hypothetical. On 2026-09-02 the first sweep correctly emptied
Alrenz Ellivera's 2026-09-06 and 09-13, and the copy pass **in the same run**
turned `Open 6a–9p` typed by Carlo into `Unavailable all day` stamped
`Auto-copy` — on two dates AxisCare has him with Jose Ortiz 8a–8p. Both were
repaired by hand.

`copyClashes()` fixes it at the **write**, not at the ownership, so it does not
care how the day came to be empty: *the copy may never write a statement that
contradicts a real visit.* Only `Open` is carved, so a `Vacation` /
`Unavailable` / `School` shape borrowed from last month lands on a date with a
visit completely untouched — the copy asserting the caregiver is off on a day
they are booked to work.

A **person** may record that: it is a genuine disagreement between two systems,
and `calDayStatus()` flags it for somebody to resolve. A job that copies last
month forward may not manufacture one.

It is also the fix for a much larger mess of the same kind: Wilma Escolano's
single August vacation week had become `Unavailable` on **all 61 days** of
September and October, taking an actively-working caregiver out of coverage
entirely.

### An overnight answers for the morning it runs into

Availability is stored on the date it **starts**, running past 24 — 8p–6a on
Aug 26 is `1200..1920`, read as `20..32`. So a search for **Aug 27, 2–3am**
must look back one day and subtract 24; `AVAIL.carryWindows()` does that, and
`runCoverageSearch` fetches the preceding date for exactly this reason. A block
ending at or before 24 carries nothing (9–5 shifts to `-15..-7`), which is what
stops every block becoming a two-day claim. A whole-day statement *on* the
morning date outranks the block that ran into it.

**Partial coverage is never shown.** A caregiver free 10–1 cannot take a 9–5
shift, and listing them costs a call that ends in no. `coverageDetail()` returns
`full` or it returns `none`; there is no `partial`. If nobody can take the whole
shift, the screen says so.

**Both Find Coverage screens gate on this, not just the date search.**
The shift-locked list — the one you reach from an Open Shifts row, built by
`coverageMatches()` — used to *score* availability rather than filter on it:
nothing recorded was worth +4 and stayed in the calling queue. So on the
Brenda Janowski 8a–8p shift of 2026-09-03, Meryll Austria came second on 11
previous visits with that client and a completely blank calendar.

Fixed 2026-09-01. Availability now decides **who is on the list**, on both
screens, through the one `coverageDetail()` call. Claude: do not soften this
back into a ranking signal. The comment that justified it — “nobody has
entered any for the live roster yet, so nothing recorded must NOT exclude” —
was true when it was written and is not true now: 50 caregivers had an `Open`
row for 2026-09-03 alone. **An empty calendar is a no, exactly as
“Unavailable” is** — the same rule as Active.

#### Both screens also check AxisCare for an existing visit

Wired 2026-09-02. `covClash()` asks **AxisCare** — through `COVHIST` — whether
the caregiver is already on a visit at that hour, and falls back to
`assignedDuring()` for shifts assigned inside this dashboard. The shift-locked
list has always used it; the **date search** used `assignedOnDate()`, which only
ever knew about in-app shifts, so a stale stored `Open` could offer somebody who
was booked. That is the screen that would have offered Alrenz Ellivera for
2026-09-12.

The hourly re-carve keeps the table right; this makes the **answer** right in
the minutes before it runs. `dateSearch()` returns `clashChecked` and
`unchecked`, and the screen says which — the same contract `covMatchNote()`
keeps for the gender preference, and for the same reason: *checked and clear*
and *could not check* are different answers.

Bounded at `COV_CLASH_MAX_DATES` (10), because each date costs a `COVHIST`
window and a range search can name thirty.

> **`COVHIST` caches the derived answer per DATE but the network pull per
> WINDOW** (`fetchWindow`), and that distinction is load-bearing. Keyed per
> date, ten concurrent loads opened ten thirteen-request pulls — measured at
> ~45 requests in three seconds, which AxisCare answered with **429 on every
> one**, account-wide, so the care-notes sweep and the roster hydrate wore it
> too. Ten consecutive dates share two windows.

> `absorb()` also used to read an overnight as a **one-hour** visit
> (`e = s+1` whenever the end wall-hour was smaller than the start), so
> `covClash()` cleared caregivers for the small hours they were working. It now
> runs past 24, and files last night's tail on the date it actually occupies —
> the same three-source rule `carvableVisits()` uses.

The excluded simply disappear; there is no greyed-out section. The one place
they are described is `covEmptyReason()`, which runs **only when the list
comes back empty**, because that is the only time the difference matters:
“37 recorded unavailable” means the desk has asked and been told no, and
“74 with nothing entered” means it has not asked. It also separates *still
loading* from *failed to load* on `AVAIL.isLoaded(date)` — the first paint
lands before `openFindCoverage()`’s fetch does, and without that check the
screen accuses the whole roster of being unavailable for a second.

`openFindCoverage()` pulls the **day before** the shift as well, for the same
reason `runCoverageSearch` does: an overnight Open is stored on the date it
starts, so without it somebody working 8p–8a reads as having nothing entered.

### The client’s caregiver gender preference filters too

Wired 2026-09-01. It comes from **Client Concierge**, through `CLMATCH` —
`client_match_prefs.gender_pref`, `'F' | 'M' | null`, synced by
`netlify/functions/matching-sync.js`. **AxisCare has no such field**, so the
old `reqGender(cl.restrictions)` read could never fire on live data:
`mapClient()` hard-codes `restrictions: []` for every real client, and the
preference was going quietly unused on both screens. 16 of the 21 clients ask
for a female caregiver; none ask for a male one.

`covClientPrefs()` is the single place it is read, and both Find Coverage
screens now ask it — the shift list through `coverageMatches()`, the date
search through `dateSearch()`.

| Concierge says | The list holds |
|---|---|
| `F` or `M` | that gender only |
| `null`, or no row for the client | **either gender** — nothing recorded means nobody minds |
| the table has not loaded | **everyone**, and the note above the list says the preference was not applied |

That last row is what `genderKnown` exists for. **Claude: do not collapse it
into `genderPref === null`.** A missing preference and an unread one are
different answers, and silently treating “could not read it” as “nobody
minds” would put male caregivers in front of a client who asked for a woman
with nothing on screen to explain it. `covMatchNote()` states the rule in
force on every shift, in three versions — applied, not recorded, not loaded
(and “not yet” reads differently from “not at all”).

**A caregiver whose gender AxisCare does not record is held back** when a
preference exists, because they are not *known* to be the gender asked for.
It applied to exactly one caregiver, Angelina Dela Cruz (id 613); her gender
was recorded in AxisCare on 2026-09-01 and **every active caregiver now has
one**, so the rule currently excludes nobody. It stays as a guard for a future
hire, and the fix is always to record the gender rather than loosen the rule.

Driving is deliberately **not** wired, though `driving_required` sits in the
same synced row and 10 clients set it. It stays a ranking signal until the
desk asks for it.

### Two caches, one purpose each

| | |
|---|---|
| `AVAIL.load(c)` | one caregiver, the full 13-month calendar window. Fetched when a profile is opened, for the month grid. |
| `AVAIL.primeIndex()` | **every** caregiver, a week back to the end of next month. One paginated query at the end of `finishBoot()`. Warms the reports, the assistant and the profile. |
| `AVAIL.fetchDates([…])` | **every** caregiver, specific dates, on demand. Find Coverage calls this when you press Search, so any date in the recordable span can be searched even though boot never warmed it. |

What is loaded is tracked as a **set of dates**, not a range — that is what lets
an on-demand fetch answer like any other date. `AVAIL.searchWindow()` is the
span availability can exist for at all (one month back to eleven months on,
matching the calendar's month arrows); the date pickers are bounded by it,
because outside it there is nothing to find.

Saving a day marks that date loaded, since the app then knows exactly what it
holds. Without that a later `fetchDates` would pull the same rows in again and
double them — and a fetch clears its span before absorbing, for the same reason.

**Find Coverage runs on a button, not on every render.** `state.covRun` records
the dates, times and city that were actually searched, so the results always
describe the search that produced them rather than whatever the controls say now.

**A search always asks the database.** `fetchDates(dates, true)` re-reads even
dates already cached, so a scheduler who has just entered availability — or a
colleague who entered it in another browser — sees it without reloading. A stale
coverage search is the worst kind of wrong: it says nobody is free when somebody
is, and gives the reader no way to tell. The round trip is cheap; do not
"optimise" it back into a cache hit.

`dayAvail()` judges a date by whether **that date** is loaded, never by whether
the roster-wide prefetch has finished. Gating on the global status was a real
bug: a day the scheduler had just saved still answered `unloaded` until the
prefetch settled, so Find Coverage showed nobody and only a hard refresh fixed
it.

Keep them separate. `load()` returns early when its cache already has an entry,
so priming it from the narrower window would leave a profile calendar marked
`ready` with months that were never fetched — drawn blank, which reads as
"nothing recorded".

Neither belongs in `state`: they are not the scheduler's typed work, and a few
hundred segments there would be diffed into the CLOUD overlay and written to
Supabase. That is the 323KB bug in *Don't break these*.

### `AVAIL.dayAvail()` returns a state, not an array

**Claude: do not collapse these into a boolean.** Three of them mean "not
available" and three mean "no answer yet", and the difference is the whole
point — a failed fetch otherwise looks exactly like an empty agency.

| State | Means |
|---|---|
| `open` | an `Open` block; `wins` carries the hours — a whole-day Open reads as `[[0,24]]` |
| `blocked` | rows exist, none `Open` — `label` says which kind |
| `none` | in range, nothing recorded → **not available** |
| `outrange` | the date is outside the loaded window |
| `unloaded` | the index has not landed yet |
| `error` / `unconfigured` | it could not load, or there are no Supabase keys |

Every caller must render the last three as "not loaded" and never as a
negative. `AVAIL.openDays(cgId)` answers the same question over the whole
window, for the reports and the assistant.

`availTone()` is the single place the green/red judgement is made.

### Where the existing rows came from

The table was seeded on **2026-08-27** from the previous app's
`caregiver_availability_overrides`, so schedulers did not have to retype a
year of availability. **6,693 rows, 138 caregivers, 2026-03-04 → 2026-12-31.**

`updated_by` carries the original author across — Mae, Beatrice, Angelica,
Sunshine, Tine, Jen and others who never used *this* app. That is deliberate:
the day panel's history line should say who actually made the call.

Three things about the old data are worth knowing before trusting a row:

- The old table stored a **window label** (`Anytime`, `Morning`, `Afternoon`,
  `Evening`, `Overnight`) where this one stores minutes. They were resolved
  with the old app's own `TYPE_WIN` — `Anytime` 00:00–24:00, `Morning`
  06:00–12:00, `Afternoon` 12:00–17:00, `Evening` 17:00–22:00, `Overnight`
  22:00–06:00. So a migrated `Open` is often exactly 0–1440 or 1320–1800,
  which is a *label*, not hours anyone typed.
- The old table had **no unique constraint**, so an edit left its predecessor
  behind. 6,628 of 6,692 days held one row; the rest were resolved
  newest-wins. One day genuinely holds two segments (caregiver 1176 on
  2026-08-08) and kept both.
- **`Devoted Shift` was a status in the old table** and is deliberately not one
  here — 24 such rows were dropped. AxisCare is the system of record for
  visits; see *AxisCare visits carve, at save time* above.

These rows predate the carve, so a migrated `Open` was **never carved against
AxisCare visits**. A caregiver can therefore read as Open across hours they
are already booked for. Re-saving the day in the panel carves it correctly.

### What this replaced

Availability used to be a weekly rule (`ops.avail2`, keyed `Mon`..`Sun`) plus
dated overrides, derived from the class tags. The editor for it was removed in
full, along with `OFF_TYPES`, `NOT_OPEN`, `RULE_STATUS`, `dayAvail`,
`availDayLabel`, `windowsForDay` and the day panel that wrote them. Find
Coverage asked about **weekdays**; it now asks about **dates**, because per-date
rows cannot answer "who works Mondays" without inferring a pattern — which is
the weekly rule coming back through the side door.

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

**`goesBy` is a nickname, not a name.** Use `firstName` for display. On this
account **78 of the 184** active caregivers have a `goesBy`, and for **46** it is
not their first name at all — id 312 is *Lorilyn Federis*, recorded as
"Yheen". Naming from `goesBy` renames a quarter of the roster to something
schedulers cannot search for, and the previous dashboard showed the legal name.
Every active caregiver has a `firstName`, so it never needs a fallback.

Keep the nickname though: `cgNameMatch()` searches both, and the profile shows
a *goes by* chip when the two differ. Somebody who knows her as Yheen still has
to find her.

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

**The class tags are not availability, and nothing reads them as availability
any more.** On live data **93 of the 184** active caregivers have no
`WKDY`/`WKND`/`AD` tag. Treating that silence as a schedule was the source of a
whole family of bugs: every untagged caregiver was excluded from shift
suggestions as *"Unavailable today"*, and because `hours` defaulted to `'Days'`
and `c.win` to 8a–5p, the report tile *"Daytime Caregivers"* was arithmetically
guaranteed to equal the size of the roster.

Availability now comes from **`public.caregiver_availability`** — per-date rows
a scheduler typed. See *How availability works* below. The fields `c.avail`,
`c.win`, `c.today`, `ops.avail2` and `ops.availOverrides` still exist on the
caregiver record but no longer answer any availability question; they are due
for removal and should not be given new readers.

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
| A Mon–Sun availability grid | **Does not exist in AxisCare.** Only the coarse class tags above (`WKDY`, `WKND`, `MRNNG`, `NOVRN`…), and only for 60% of caregivers — and those are *not* read as availability. The dashboard keeps its own per-date availability in Supabase; see *How availability works*. |
| A clinical skills list | **Does not exist** as a field. Only class tags. |
| Caregiver photos | **AxisCare has none.** No field on `/api/caregivers`, no photo/document/attachment endpoint among the 17 that exist, and zero mentions of photo, image, avatar or headshot anywhere in its 559KB OpenAPI spec. The photos this app shows are its own — see *Where the caregiver photos come from*. |
| Client medications | **Cannot be fetched.** A limitation in AxisCare's own API, confirmed on the Client Concierge dashboard where the medications call returns `403` on every client. The Medication List screen here is demo data. Not fixable in code, and no re-sync or deploy would change it. |
| Caregiver availability | **AxisCare has none.** The calendar shows *assigned visits*, which are real. The open and unavailable blocks beside them are per-date rows a scheduler typed into this app's own Supabase table, and only those count. |
| Writing anything back to AxisCare | Not possible through this app. The proxy is read-only by design and forwards GET only. |

The pattern worth internalising: **AxisCare knows identity, status, location,
tags and what happened on each visit. It does not know derived judgements about a
caregiver.** Anything evaluative has to be computed from visit history.

---

## Where the caregiver photos come from

**Not from AxisCare.** It has no photo of any kind (see the table above), so
there is nothing to pull and nothing to keep in sync. Do not go looking for a
sync job — there has never been one, in this app or any other.

They live in this project’s own Supabase Storage bucket **`caregiver-photos`**,
public-read, one object per caregiver named for the **AxisCare numeric id**
(`312`, not `a312`). **177 photos, 157 of the 173 Active caregivers (91%)**, and
96 of Carlo’s Active 103.

They were copied on **2026-08-28** from `devoted-care-system`, which had been
collecting them through its own upload route — somebody uploaded each one by
hand; its `docs/DEFERRED_ITEMS_PLAN.md` records photos as Mitch’s to supply.
Both systems key on the AxisCare id, so it was a straight copy, and every one
was verified byte-for-byte over the public URL afterwards. **This app depends
on nothing outside its own Supabase** — that project and its keys can be
deleted.

### The list asks for a resized rendition, not the original

`cgPhotoUrl(c, px)` returns the plain object URL with no `px`, and a Supabase
**image-transformation** URL with one. The row asks for 96 (twice its 44px
slot).

That is not premature tuning. The 177 split in two: 144 JPEGs averaging well
under 100KB, and **33 PNGs over 1MB** — about 55MB of the 64.9MB total. The
largest, caregiver 38, is **2268KB as stored and 14KB at 96px**. Nothing extra
is stored and the originals are untouched; it is only which URL the browser
asks for.

### A missing photo is not an error

Sixteen Active caregivers have no photo. The row asks anyway and lets the
request fail — `onerror="cgPhotoFail(this)"` swaps in the plain camera
placeholder, which covers “never had one” and “could not load it” with the same
fallback. Supabase answers a missing public object with **400, not 404**; the
`<img>` fails either way.

> `devoted-care-system` needed a has-photo manifest endpoint to avoid a
> “150+ 404 fan-out” on every render. That was because its bytes were
> auth-gated, so each miss cost a gated round trip. Ours are public, a miss is
> a plain 400, and `loading="lazy"` means only visible rows ask at all — so
> the manifest would be machinery with nothing to buy.

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

## Ask Devi — the local router first, Claude for the rest

Ask Devi has two answerers and they are not interchangeable.

**`aiAnswer()` answers first.** It is a regex router over about twenty report
builders (`aiAvailable`, `aiCallOffs`, `aiOpenShifts`…). Its answers are
*computed from the real tables*, instant, and free. It is not a fallback — it
is the primary, and it should stay in front.

**`deviAsk()` takes what the router could not match.** `aiAnswer()` returns
`fallthrough:true` where it used to say *"Not sure I caught that"*, and that is
the signal. It is also, with no extra machinery, how **follow-ups** arrive:
"why?", "what about Saturday?", "who else?" match no pattern, so they land in
Devi with the whole conversation behind them.

### What Devi can and cannot do

**It has no tools. It can only produce text.** Nothing it says reaches the
availability table, the roster, a shift or AxisCare — the browser renders the
words and stops. That is the entire safety argument for showing it real data,
and it is why `supabase/functions/devi-agent/index.ts` forwards no `tools`
array. **Claude: adding a tool invalidates that argument and has to be
re-made from scratch.**

`state.aiLog` is **not** a tracked CLOUD slice, so the conversation stays in the
browser that asked it and is never written to Supabase or shared.

### The key lives in a Supabase Edge Function

The first one in this repo — everything else is a Netlify function. It is there
because the `ANTHROPIC_API_KEY` secret is there.

| secret | note |
|---|---|
| `ANTHROPIC_API_KEY` | the local `.env` calls the same value `CLAUDE_API_KEY` |
| `CONCIERGE_MODEL` | `claude-opus-5`. `DEVI_MODEL` overrides it |
| `ALLOWED_ORIGIN` | see below — `null` is not what it looks like |
| `DEVI_EFFORT` / `DEVI_MAX_TOKENS` / `DEVI_SHARED_SECRET` | optional |

**A commit does not deploy it.** `index.html` auto-deploys to Netlify;
`supabase/functions/` needs `supabase functions deploy devi-agent
--no-verify-jwt`. `deviAsk()` therefore falls back to the router's own answer
whenever the call fails, so an undeployed or broken function degrades to the
old wording rather than showing "Failed to fetch".

### Three traps, all already hit once

- **`max_tokens` includes thinking.** Opus 5 thinks by default and spends the
  budget on it first. Measured on this key: `max_tokens: 64` returned HTTP 200,
  `stop_reason: "max_tokens"` and an **empty** text block. `MIN_TOKENS = 1024`
  in the function is the floor that prevents it. A blank reply is this, not a
  broken chat.
- **`esc()` is an ATTRIBUTE escaper** — it replaces `"` and nothing else, which
  is useless in a text position. Devi's reply goes into `innerHTML` and is
  built from a snapshot containing AxisCare names, so `escText()` was added and
  is what `deviInline()` must use. Never `esc()`.
- **`ALLOWED_ORIGIN: null` is not "local only".** `null` is the origin of *any*
  sandboxed iframe, so any site on the internet can call the function from a
  visitor's browser. For local work use `http://localhost:8888` (`netlify dev`)
  — a local server sends a real origin, never `null`.

### What leaves the browser

`deviContext()` sends, on every Devi question: today's date, client **names and
cities**, up to 40 open shifts with times, and every active caregiver as
name · base · skills. No care notes, no contact details, no clinical fields.

**It is still PHI.** The sibling Client Concierge function's header records that
adaptive thinking is not on Anthropic's BAA-covered feature list and concludes
*"point this at invented data only"* — that note was written about the same API
and has not been cleared for this one. It is Carlo's call with Anthropic, not a
code question.

`c.base`, not `c.city`: a caregiver record has no `city`. Getting that wrong
produced a dash on every line and Devi correctly reporting that nobody has a
city recorded.

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

3b. **The roster paints on roster + profiles, and never before `profiles`.**

    `applyProfile()` returns on its first line when `profiles[c.axisId]` is
    missing, and `profiles` is only assigned inside the `Promise.all` handler
    in `hydrate()`. So **any** paint before that point carries no
    `employment_status` — and `c.active` then falls back to the AxisCare
    label, which is `Active` for everybody, because the fetch asks
    `statuses=Active`.

    Measured on live data: **171 active instead of 100**. The desk has parked
    **82** caregivers, and `c.active` is what Find Coverage, Client Matching,
    the shift ranker and the availability-review tasks filter on. Every one of
    the 82 is offered for shifts during such a window.

    **So the paint waits on the PAIR — roster AND profiles — and on nothing
    else.** Done 2026-09-03. It used to wait on all five boot calls, which
    made the caregiver list as slow as a shift scan it does not read:

    | call | lands |
    |---|---|
    | `fetchProfiles` | 2.0s |
    | `AxisCare.roster` | **2.1s** — the pair is complete here |
    | `fetchClients` | 3.3s |
    | `fetchOpenShifts` | 9.5s — today through the end of next month |

    Measured on that run: **9.5s → 2.1s, a 7.4 second saving**. Profiles land
    first anyway, so carrying them costs nothing and the roster is correct
    from the first frame.

    Three things make it safe, and all three must stay:

    - **`profiles` is assigned before `applyRoster()`**, in the early handler
      as well as the settled one. Reverse them and you get 171/0 again.
    - **The plausibility guard is repeated** in the early handler. It has to
      run before anything reaches `state.caregivers`, and the tail runs far
      too late to protect this paint.
    - **It cannot trigger a save.** `hookRender()` and `booted = true` are both
      set in `finishBoot()`, and `scheduleSave()` returns early while `booted`
      is false. The early `render()` therefore paints and nothing else.

    It also satisfies the boot-order rule rather than bending it: the roster
    is in `state` *earlier* than before, and `CLOUD.boot()` still snapshots
    after every call has settled.

    **A faster paint means the empty states have to be honest.** `boot()`
    renders before `hydrate()` resolves, so `viewOpen()` used to state "All
    shifts are covered" for the whole boot and then fill with the gaps it had
    just denied. It and the contact-log view now check `rosterLoading()` first
    and say they are still loading. Any view that asserts an AxisCare fact
    from an empty slice needs the same treatment.

3c. **Whatever fetches the roster, validate before assigning `state`.**

    `if (!list || list.length < 10) throw` guards against a truncated AxisCare
    read. It only works while it runs *before* `state.caregivers` is written.

### What was tried, and why it was reverted

Commit `cd5b873` (2026-09-01) added an early paint plus a **localStorage roster
cache** (`dc.roster.v1`, raw records, 24h) painted before the network was asked.
Reverted the same day. Both halves are worth knowing about:

- **The early paint** hit 3b — the Active roster read 171/0 for the ~3s before
  the boot settled, on a **cold load with an empty cache** as well as a warm one.
- **The cache** moved `cacheRoster()` and `applyRoster()` ahead of the
  plausibility guard (3c), so a truncated read was both painted and stored for a
  day. It also showed data with **no banner at all** — `demoNotice()` is guarded
  on `ROSTER.status()`, which is `null` until the boot finishes.
- **The one that could not correct itself:** a caregiver terminated in AxisCare
  stayed in the cache. Assign a shift to them inside the window and, when the
  live roster lands without them, `reconcile()` → `remapDangling()` rewrites
  `s.assigned` via `pickFrom(schedulingPool(), seed)` — silently reassigning the
  shift to Ana or one of six caregivers, into a tracked CLOUD slice shared by all
  three schedulers, in place and irreversibly.
- `retryAxis()` repainted the cache over live data *after* `CLOUD.boot()` had
  snapshotted, and `render()` schedules a save at 900ms while the refetch takes
  ~2.1s — so a save could diff cached-against-live into caregiver patches.
- The stored payload was **187KB of raw records** — date of birth on 180 people,
  home street address on 179, pay rate on 146, plus personal email and mobile —
  at rest on the device, surviving `CLOUD.reset()`, with no logout to clear it.

`withTimeout()` was kept: a hanging AxisCare now shows the banner instead of an
endless spinner. Note it **discards** a late answer rather than using it — an
earlier comment claimed otherwise. It must stay that way: anything reaching
`state.caregivers` after the baseline snapshot is bug 2 above by another door.

Leftover `dc.roster.v1` entries in schedulers’ browsers are inert — nothing
reads the key any more. Clearing one needs DevTools → Application → Local
Storage, or “Clear site data”; a hard reload does **not** remove it.

3d. **`lastBody` is what stops the two-tab write loop — keep it honest.**

    `doSave()`’s only no-op guard is `if(body===lastBody) return`. `pull()`
    used to set `lastBody=null` after an applying pull, which disarmed that
    guard even when the merge produced exactly what the server had just sent.
    Every applying pull therefore pushed back identical content, bumping the
    rev, which made the other session pull and push back. Two idle tabs held
    a revision roughly every 15 seconds — measured at 90 in 21 minutes with
    byte-identical data — and every turn ran `applyOverlay`,
    `ROSTER.reconcile()` and a full re-render in each open session.

    It is now `lastBody=bodyOf(res.data.overlay)`: push only if the merge
    left us differing from the database. Two things make that work, and both
    must stay:

    - **`bodyOf()` is order-insensitive over `adds[]` and `dels[]`.** `sstr()`
      sorts object keys but not array elements, and two sessions legitimately
      hold the same records in different order — whoever creates a record
      `unshift`s it, while `applyOverlay` `push`es what it receives. Without
      canonicalising, the bodies never match and the loop survives. Verified
      on the live 387KB overlay: reversing all 8 adds arrays leaves the body
      unchanged.
    - **The retry tick clears `lastBody` before calling `doSave()`.** A retry
      must actually retry. `unsent` and `failed` are cleared in exactly one
      place — `push()`’s success branch — and the tick nulls its own timer
      first, so an early return at the guard would strand both flags with
      nothing left to re-arm. Stuck `unsent` is the gate on `pull()`’s
      re-layer, which would then write this session’s older records over a
      colleague’s newer ones on every poll and push the reversion. This was
      introduced by the first version of the fix and caught in review.

3e. **Anything that rebuilds `state.caregivers` after boot must re-layer the
    overlay — `CLOUD.relayer()`.**

    `ROSTER.hydrate()` constructs every caregiver from scratch, so a post-boot
    refetch (`retryAxis`) discards everything `applyOverlay` wrote onto those
    objects. Nothing put it back, and because `buildOverlay()` diffs against
    `BASE` — snapshotted from the identical construction path — the rebuilt
    records match the baseline, no patch is emitted, and `buildOverlay` drops
    `patches.caregivers` entirely. The next debounced save wrote that omission
    to the shared row: **all 180 caregiver patches gone, for all three
    schedulers**, with no per-field tombstone to recover from.

    `relayer()` re-applies the LOCAL overlay (it carries anything the debounced
    push has not sent yet), then `ROSTER.reconcile()`, muted so it cannot
    schedule a save half-way, with `muted` restored in a `finally`.

3f. **The poll reads `rev` first and the `overlay` column only when it moved.**

    `pull()` runs every `POLL_MS` in every visible session and almost always
    finds nothing new. It used to `select('overlay,rev,updated_by')` every
    time and discard the column two lines later. Measured against the live
    workspace: **418.8 KB per no-op poll**, ~1.1 MB a minute per session,
    **1.73 GB a day** across three schedulers — to learn one integer.

    It now asks for `rev` alone first: **14 bytes**, a 99.997% reduction,
    0.1 MB a day for the whole desk. The full column is fetched only when the
    revision has actually moved, or when the caller passed `force` — boot,
    `CLOUD.sync()` and the `online` listener want it either way, so those skip
    the head read rather than paying for one they would discard.

    `serverRev` is still taken from the **second** read, so the revision and
    the overlay it is recorded against always come from the same row version
    even if somebody writes between the two calls. A missing row falls through
    to the full read as well, because the first-run insert branch needs it.

    The trade is one extra round trip on the rare path where something HAS
    changed. That is the right way round: the common case went from 418.8 KB
    to 14 bytes.

    This composes with 3d — `lastBody` stops the needless writes, this stops
    the needless reads. Neither makes the other redundant.

### FIXED 2026-09-03: a re-hydrate no longer writes AxisCare data into the overlay

> **THIS HAS NOW HAPPENED FOR REAL — 2026-09-03. CARLO owns the recovery, not
> Mitch.** Mitch works through Claude + GitHub on `index.html`; this failure
> lands in the **Supabase `scheduler_state` row**, which is Carlo’s side (see
> *Who does what*). Mitch cannot fix an instance of it by committing.

> **What happened.** Marjorie Willis (AxisCare client **345**, "Marj") was added
> as a new client, and her three visits appeared in AxisCare *after* a
> scheduler’s page had already loaded. A re-hydrate ran, `BASE` was still the
> boot-time snapshot, and `buildOverlay()` emitted the three visits as **adds**
> on the `shifts` slice — AxisCare data written to the shared row as though
> somebody had typed it:
>
> ```
> adds.shifts: vv_57309_s_0_d_2026_09_07  vv_57310_s_0_d_2026_09_09
>              vv_57311_s_0_d_2026_09_10     all status=open, assigned=null
> ```
>
> The desk reported the shifts still being offered after AxisCare had assigned
> all three to Ma Guadalupe Lemus. **Reloading did not help**, and that is the
> tell: boot fetches the correct list from AxisCare, and then `applyOverlay()`
> adds the stale ones straight back. `applyOverlay` only ever assigns — it
> never clears — so an add like this replays on every boot for every
> scheduler, frozen at whatever status it was captured with, forever.

> **How it was cleared, and why that shape was chosen.** Removing the adds
> alone would have been undone within ~20s: an open tab still held the shifts
> in `state.shifts` and would have pushed them back on its next save. So the
> adds were removed AND the three ids written to `dels.shifts` — `applyOverlay`
> filters dels *before* it applies adds, so every open tab dropped them on its
> next poll with nobody having to reload or close anything.
>
> The dels then cleared themselves: once a tab had dropped the shifts, its own
> `buildOverlay()` produced neither an add nor a del for them, because its
> baseline no longer contained them either. End state `adds.shifts: 0,
> dels.shifts: 0`, verified stable over 80 seconds. **No residue was left to
> strip.**

> **Pausing Netlify does not stop this.** The browser writes straight to
> Supabase with the anon key (`anon update scheduler state`); Netlify only
> serves the HTML. Pausing it stops new page loads and does nothing about the
> already-open tabs, which are the ones writing. Dropping the anon update
> policy *would* stop the writes, but tabs still hold the bad records in memory
> and re-add them the moment it is restored — it buys a window, not a fix.

> **It will happen again to the next new client** until the fix below lands.
> The tell is always the same: a shift that AxisCare says is filled keeps
> being offered, and reloading does not clear it. Check
> `overlay.adds.shifts` first.


**Fixed by `rebaseSlices()`.** `hydrate()` now reports which slices it actually
reassigned (`lastResult.refreshed`), `retryAxis()` passes that list to
`CLOUD.relayer()`, and the relayer **retakes the baseline for exactly those
slices before re-applying the overlay** — the same order `finishBoot()` uses.

Proved against the real `snapshot`/`buildOverlay`/`rebaseSlices`, replaying the
Marjorie Willis scenario (boot sees 2 shifts, a new client adds 3, a re-hydrate
replaces the slice):

```
without the rebase   adds.shifts -> 3   the exact ids that bit the desk
with the rebase      adds.shifts -> 0
guard: a slice NOT in `refreshed` keeps its scheduler work   PRESERVED
```

Two things must stay:

- **Only slices `hydrate()` really reassigned may be retaken.** A slice whose
  fetch FAILED still holds overlay-applied work; retaking that baseline would
  fold the scheduler’s own edits into it and delete them on the next save — the
  same silent loss in the opposite direction. That is why `hydrate()` reports
  the list instead of the caller guessing.
- **Rebase BEFORE `applyOverlay`, never after.** After, and the overlay is
  folded into the baseline and vanishes on the next save.

> **This fix does NOT clean up an existing leak, and does not cover the boot
> path.** `finishBoot()` applies the LOCAL overlay cache
> (`dcs_scheduler_overlay_v1`) before any server pull, so a browser that
> already holds leaked adds will replay them on every boot and push them back,
> whatever the server says. That is why cleaning the shared row three times on
> 2026-09-03 kept being undone within minutes, and why reloading made no
> difference. Clearing an affected browser is the only deterministic cure:
>
> ```js
> localStorage.removeItem('dcs_scheduler_overlay_v1'); location.reload();
> ```
>
> It discards anything saved locally but not yet pushed — at most the last
> ~900ms of edits. **Carlo owns any repeat**, per the note above.

`hydrate()` replaces `state.clients`, `state.shifts` and `state.careNotes` as
well as the caregivers, but `BASE` is still the boot-time snapshot and nothing
refreshes it. So the save after a Retry diffs freshly-fetched AxisCare records
against a stale baseline:

- a care note or shift that arrived since boot is not in `BASE` → **`o.adds`**
- one that was in `BASE` and AxisCare no longer returns — an open shift filled
  in the intervening hour → **`o.dels`**, and `dels` is **not** gated on
  `patchOnly`, so `clients` and `caregivers` produce them too

Both are then replayed by `applyOverlay()` on every future boot for everyone:
AxisCare-derived data written to the shared row as though a scheduler typed it,
and a real coverage gap silently hidden. Same family as the 323KB bug in 2.

The fix is to re-snapshot `BASE` for exactly the slices `hydrate()` actually
reassigned, before `relayer()` re-applies the overlay — mirroring `finishBoot`.
It must be exactly those: a slice whose fetch FAILED still holds overlay-applied
data, and re-snapshotting that one would bake the scheduler’s own work into the
baseline and delete it from the overlay on the next save. `hydrate()` therefore
has to report which slices it assigned rather than the caller guessing.

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
