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
- **Supabase** — deciding what the tables, row-level-security policies and secrets should be. *Running* the deploy, the SQL or `secrets set` is Claude's (above)
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
| **Care notes** | Live — swept into Supabase on a schedule, read from there. The day review is **summarised** by `carenotes-summary` and saved in `public.care_note_summaries`; the caregiver’s own words stay one click away |
| **Communication Logs** | Live — every agency line read from Quo when a profile is opened. *Summary by Devi* is written when a conversation is opened and saved in `public.comm_summaries` |
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
environment variable. Since 2026-09-18 the anon key cannot even *read*
`care_notes`: the browser reads it through `app-gate` with the desk PIN (see
*The PIN gate*), so a stranger with the site URL can neither read nor forge
notes.

### The day review is SUMMARISED — `carenotes-summary`

Added 2026-09-23. The Care Notes page opens on one date and shows, per client,
an AM block and a PM block. Those blocks used to print the caregiver's raw
AxisCare note verbatim, under a card headed **Yesterday's Summary** — which is
the one thing a summary section is not. Measured on the live mirror: the raw
notes rendered there run to a **median of 610 characters and a maximum of
6,130**. The summaries that replaced them are **median 241, maximum 327**.

```
supabase/functions/carenotes-summary   POST {day:'YYYY-MM-DD'}
  -> reads public.care_notes ITSELF for that Pacific day
  -> one model call for the WHOLE date
  -> upserts public.care_note_summaries, one row per client x date x shift
  -> returns every summary the date has
CNSUM (index.html) reads it; careShiftSummaryHtml() draws it
```

`CNSUM.soon(day)` is called from `viewCareNotes()` — `load()` behind a 400ms
timer, because the day arrows re-render this view and paging back a week would
otherwise start a model call for every date passed through. It is only safe at
all because it is guarded: one request per date per session, and **an error is
never retried by a render**. `render()` runs on every save and every
20-second poll, so a failure that retried itself would send one request per
render for as long as the page stayed open — the same rule `comms-summary`
learned. Retry is a button.

#### One model call per DATE, not one per client

Measured across the 37 dates in `care_notes`, 2026-09-23:

| per date | |
|---|---|
| notes | avg 18.9, max 23 |
| clients | avg 13.3, max 17 |
| input tokens for one call covering the whole date | avg ~3,400, max ~5,000 |

So a date is **one small request**, not the "big charge per day" the design
was braced for: 2026-09-22 measured **7,737 in / 2,092 out, 22 blocks, 30
seconds** on Haiku 4.5 — about **1.8 cents**, and the entire history
backfills for under 50 cents.

Asking per client-shift would be ~26 requests for the same tokens and would
throw away the one thing a whole-date pass can see: **the same client's AM and
PM read together**, and one client's day beside the next.

#### Written once, read back forever

The first person to open a date pays for it; everybody else, in every browser,
reads the saved rows. Measured on 2026-09-22: **30s to generate, 0.68s on
every open after it**, with `generated: 0`. A date nobody opens is never
summarised. There is no cron and no backfill job.

A row records `source_sig` — a fingerprint of the **visit ids AND the note
text** behind it. `carenotes-sync` re-reads `FRESH_DAYS = 2`, so a caregiver
may still be correcting today's or yesterday's note; a changed note changes
the signature and **only that row** is rewritten. Verified by stamping one row
stale: `generated 1, reused 21`. `model` and `prompt_version` do the same for
a model switch or a prompt edit, exactly as `comm_summaries` does.

#### Only the DATE goes up — the function reads the notes itself

**Claude: do not "simplify" this into posting `state.careNotes`.** The browser
is already holding them and it would be less code. It would also let anyone
with the site URL save invented **clinical** summaries into the table and
spend the Anthropic key on any text they liked, because there is no
per-person login. The function reads `care_notes` with the service key, so a
summary can only ever describe notes AxisCare actually holds, and spend is
capped at one pass per date per model. Same argument as `comms-summary`, and
the stakes are higher here because the content is clinical.

`care_note_summaries` has RLS on and **no policies at all** — the anon key can
neither read nor write it. `app-gate` is untouched and needs no `ALLOW` line,
because the browser talks to the function directly, the way it talks to
`comms-summary`.

#### The fallbacks are the whole safety of the screen

Neither is a placeholder. The page must never be *less* useful than it was
before summaries existed:

| | on screen |
|---|---|
| summary ready | the summary, with the caregivers' names and times above it |
| still coming (~30s on a first open) | **the raw note**, under a strip saying it is summarising |
| failed, or not deployed | **the raw note**, under a red strip naming the reason, with Retry |
| the summary describes more notes than this browser holds | **the raw note** — see *A summary may only replace notes the page can still SHOW* |

A spinner for half a minute is worse than the text we already have, which is
why loading shows the note rather than a skeleton. Verified in the browser
both ways: 22 summaries and 0 raw notes when it lands, 0 summaries and 23 raw
notes when the call is refused — and `render()` fired no second request in
either case.

`escText()`, never `esc()`. These are written by caregivers in AxisCare —
people outside the desk — and the model's output is arbitrary text too.

#### It is labelled once, in the card header

Not on all ~26 blocks. The subtitle says *"Summarised by Devi from the
caregivers' AxisCare notes"* and **View Original Notes** was already on every
row, so the caregiver's own words stay one click away. That button is the
reason the summary can replace the note rather than sit above it — unlike the
Communication Logs dialog, where *Summary by Devi* sits over a thread the
scheduler still has to be able to read in place.

#### PHI, and what is still redacted

These are clinical shift notes and they go to Anthropic in full. Carlo,
2026-09-23: *"The Anthropic API that we have has the PHI contract."* That is
what makes this allowed; see *What leaves the browser*.

Phone numbers, email addresses and links are **still** replaced before the
notes leave the function, and again over the output. Not because of the BAA —
because they add nothing to a summary of somebody's shift, and `comms-summary`
already measured that a prompt rule alone does not hold: with the rule in
place the model still wrote an applicant's email address into a summary.

The prompt's other rules are load-bearing rather than style, and each is
pinned by what a scheduler would do with a wrong one:

- **Never infer a diagnosis, a cause, a severity or an outcome that was not
  written.** If the note is vague the summary is vague — do not improve it.
- **Never give medical advice**, and never suggest a treatment or a
  medication change.
- **Medication names only where the note is reporting what happened** with
  them (refused, vomited, ran out). A routine pass is "medications given".
- A note that says **essentially nothing** is reported as saying nothing. Do
  not invent a shift to describe.

#### `max_tokens` is 16000, and the answer is JSON

Both for reasons this repo has hit before. `max_tokens` **includes thinking**,
and a switch to Sonnet 5 or Opus 5 thinks by default — `care-brief`,
`devi-agent` and `comms-summary` all returned HTTP 200 with an empty text
block on a budget sized for the answer. 26 blocks of 45 words is ~1,500 tokens
of actual output; the rest is thinking room, and only what is used is billed.

The reply is a JSON array of `{id, summary}` and is **parsed defensively**: an
unknown id, a repeated id, an empty summary or one over `MAX_CHARS` is
discarded, and a block missing from the answer simply stays unsummarised — the
page falls back to its raw note for that block alone. Losing one entry is
better than losing the date.

#### Switching the model needs no code change and no redeploy

```
npx supabase secrets set CARENOTES_MODEL=claude-sonnet-5 --project-ref gdzgoyawavffjdjpjbfz
```

Default `claude-haiku-4-5`. `CARENOTES_EFFORT` (default `low`) is sent to every
model **except Haiku**, which answers `400` to it. **No `temperature`** — Sonnet
5 and Opus 5 reject it, so sending one would make the first switch fail on
every request. `GET …/carenotes-summary?action=status` reports the model in
force. No new secret is needed: `ANTHROPIC_API_KEY` and `ALLOWED_ORIGIN`
already exist on the project.

#### A COMMIT DOES NOT DEPLOY IT

```
npx supabase functions deploy carenotes-summary --project-ref gdzgoyawavffjdjpjbfz --no-verify-jwt
```

**Deployed 2026-09-23** and verified from the Netlify origin: `?action=status`
reports the model, and a POST for 2026-09-22 returns 22 units with
`generated: 0, reused: 22` — the saved rows, no spend.

If `index.html` lands first, every date shows the red strip and the raw notes —
which is the pre-summary page, so nothing breaks. The browser sees a bare
"Failed to fetch" rather than a 404 (the gateway answers the POST's preflight
with a 404 whose `access-control-allow-headers` omits `content-type`), so
`CNSUM` turns a `TypeError` into the deploy command. Same measurement as
`comms-summary`, 2026-09-15.

The table is created — `supabase/care-note-summaries.sql`, also section 10b of
`schema.sql`, run against the live database on 2026-09-23 (RLS on, 0 policies).

#### What an adversarial review changed, before it shipped

Reviewed 2026-09-23 by six independent reviewers over separate dimensions —
time, cost, data, browser, PHI and prompt — each finding then put to two
skeptics with opposite lenses (*does it reproduce?* and *is it already
handled?*), plus a completeness critic asked what all six had missed. **11
raised, 4 survived both skeptics**, and the critic added 5 more. Six of those
are now fixed; the rest are recorded below.

Four are worth knowing about because each was invisible on the happy path.

##### A summary may only replace notes the page can still SHOW

**The sharpest one, and it undercut the whole design.** The summary is read
from `care_notes` **as of now**; the caregivers' names, the times and the
**View Original Notes** button all come from `state.careNotes` **as of boot**.
`carenotes-sync` re-reads `FRESH_DAYS = 2` and this page opens on *yesterday*,
so a note filed after somebody's tab loaded is described by a summary whose
original text that tab cannot show. A summary leading with a fall, over a
button that opens only the other caregiver's note.

And it needs no timing at all to happen: `fetchCareNotes()` reads
`limit=400` against 701 rows, so the cut lands mid-date and one date **always**
holds a partial set in the browser and a complete one in the function.

The function already knew the answer and threw it away — it stored
`source_count` in a column nothing read back. It now **returns** it, and
`careShiftSummaryHtml()` shows the summary only when `sourceCount` equals the
number of notes this browser holds. Otherwise the block falls back to its raw
notes. **Claude: do not drop that comparison.** *View Original Notes* being
reachable is the entire licence for the summary replacing the note rather than
sitting above it, and without the check that promise is silently false.

Verified in the browser: bumping one block's `sourceCount` by one took the
page from 22 summaries / 0 raw notes to **21 / 1**, and restoring it put the
summary back.

##### An empty date is only an answer once the notes have LANDED

`CNSUM.load()` skips a date the browser holds no notes for. But
`state.careNotes` is filled inside `hydrate()`'s `Promise.all` and
`viewCareNotes()` paints well before that — so opening Care Notes during boot
cached `{status:'ready', units:{}}` **permanently**, and the page showed raw
notes under a subtitle promising summaries for the rest of the session.
Reproduced against the real module.

`careNotesLoaded()` is the guard: a date that looks empty while the boot is
still in flight caches **nothing**, and the next render asks again. A date that
is genuinely empty after the boot finished is still answered empty. Both pinned
by the page test.

##### The day arrows were one model call per date GLANCED AT

`viewCareNotes()` is a render function and the arrows re-render it, so paging
back a week started a ~30s, ~1.8¢ call for every date passed through.
`CNSUM.soon(dateStr)` arms a single 400ms timer instead and asks only for the
date still on screen when it fires. Measured: **paging back six dates fires one
call**, for the date actually landed on.

##### A PM block can hold TWO caregivers, and the 45-word cap lost one

The PM window runs 14:00 to 06:00, so an evening caregiver and an overnight
caregiver both write into it. `PROMPT_VERSION 1` described a block as one
caregiver's one visit and capped it at three sentences — and a two-note block
lost a caregiver's whole shift. Reproduced 4/4 and 3/3 against the live model.

`PROMPT_VERSION` is **2**: a block may hold more than one note, every note in
it must be covered, each caregiver named, and a multi-note block may run to
five sentences and 75 words. On the live board exactly one block on 2026-09-22
holds two notes, and it now reads to 544 characters covering both.

##### The smaller three

- **`String(item.summary)` on a non-string** stored the literal
  `"[object Object]"` — non-empty, under `MAX_CHARS`, so it *saved*, satisfied
  `current()`, and was served forever in place of the note. It is a `typeof`
  check now.
- **`sig()` depended on row order.** PostgREST promises none for equal
  `visit_at`, and two live client-days already tie (clients 335 and 342 on
  2026-09-18). Inside the `FRESH_DAYS` window a re-upsert can move a row and
  flip the fingerprint, paying for a regeneration that changes nothing. The
  sort now breaks ties on `visit_id`, the primary key.
- **`out.generated` was set BEFORE the write** and `dbPut()`'s boolean
  discarded, so a lost batch reported `generated: 22`. The cost claim attached
  to this was correctly refuted — the model call is paid for either way — but
  *report what happened, not what was attempted* is this repo's own rule, so
  the write is now awaited and `saveFailed` is returned.

##### Raised and deliberately NOT fixed

- **A failed read of `care_note_summaries` regenerates the whole date.**
  `savedForDay()` returns an empty map on any error, so every unit reads stale
  and is rewritten. The repro stands; it is deliberate, carries its own comment,
  and costs ~1.8¢. A failed read must not become a destructive write, and it
  does not — `orphans` is empty in that case, so nothing is deleted.
- **A partially summarised date looks like a fully summarised one.** Blocks the
  model dropped fall back to raw notes with no strip and no marker. Now that
  the `sourceCount` check makes fallback more common, this is worth a neutral
  strip naming the shortfall. Not built.
- **The first open re-renders ~30s in and moves the card under the reader.**
  Worth preserving the scroll position of the `.cd-crow` nearest the top.
  Not built.
- **Four findings were refuted outright** and are recorded here so nobody
  re-raises them: a discarded block does not cause runaway spend (the cost
  framing was an order of magnitude out); `dbPut()`'s return value cannot change
  what is spent; the "note that says essentially nothing" rule does not erase a
  short note reporting a real event; and "name people by first name" does not
  make the model invent one spouse of a couple client — tested on the exact
  client named, whose notes do not occur in the shape claimed.

#### KNOWN: the page's own note list is capped at 400 rows

`fetchCareNotes()` reads `care_notes` with `limit=400` against a table that
holds **701 rows**, so the oldest ~16 dates render "No AxisCare care notes
synced for this date" when the notes exist. `CNSUM.load()` deliberately
**skips a date the browser holds no notes for, once they have loaded** — summarising it would write
text nothing could display. So those dates stay unsummarised until the cap is
fixed, and this gate is not what stops them.

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

#### A pass never fits in one run, so the NEAR window is re-read every run

Measured 2026-09-03 against the live account: a full pass is **16 requests,
1,323 visits, 9,622ms**, against a `SOFT_DEADLINE_MS` of 6,000. **So a pass
always splits across runs — that is the steady state, not an edge case.**

Which meant a resumed run began at the cursor — chunk 3 or 4, out in late
October — and did not look at **chunk 0, today → +13 days**, until the pass
finished and a fresh one came round. Chunk 0 is where a scheduler adds an
unassigned visit. It was being read on every *other* run: **3 runs in 6**
skipped it, up to ~20 minutes on the ten-minute cron alone. `last_ok_at`
meanwhile stayed inside `MIRROR_COLD_MS`, so the browser went on trusting a
mirror that was missing the shift somebody had just created.

> **Reported by the desk 2026-09-03**: a newly added unassigned shift did
> not appear after a reload, or a hard reload. It was a straight regression
> against the live scan the mirror replaced — a live scan saw a new shift on
> the very next load, every time. The asymmetry that makes it obvious: a
> caregiver **name change shows instantly**, because the roster is still
> fetched live. Only open shifts are mirrored.

So a resumed run re-reads chunk 0 — **second, after its first cursor chunk,**
and that ordering is the whole safety argument. Four rules, all load-bearing:

- **The refresh goes AFTER the first cursor chunk, never before it.** The
  near re-read is *optional* — ground this pass already covered — while a
  cursor chunk is the run’s actual progress. An earlier version put the
  optional work first, and a run could then spend its whole budget on it,
  advance nothing, and repeat that forever: simulated at 3× AxisCare latency
  the pass never completed in 40 runs, so `last_ok_at` froze, the mirror aged
  out and every browser fell back to the live scan permanently. Ordering it
  second makes every run advance the cursor at least once before anything may
  stop it, so both deadlines can bound the run without starving the pass.
- **The refresh is best-effort, and that is the right thing to give up.** On
  a slow run it is skipped and freshness degrades to what it was before.
  Progress and boundedness are guaranteed; freshness is not.
- **Only a chunk at or beyond the cursor is progress.** The refresh must not
  advance `cursor_chunk` — doing that would skip a chunk nothing ever read
  and let `complete` lie to the sweep.
- **Skipping the refresh is NOT a failure.** Running out of time with only
  the optional read left still means every cursor chunk was read. Recording
  that as a failure denied `complete`, blocked the sweep and froze
  `last_ok_at` forever — the final run always had `[lastChunk, 0]` queued and
  stopped between them. Caught in simulation, not in production.
- **The sweep is untouched.** Absence is still evidence of nothing without a
  complete pass. Re-reading a chunk only ever *upserts*.

There are **two** deadlines. `SOFT_DEADLINE_MS` may only stop a run that has
advanced the cursor; `HARD_DEADLINE_MS` (9,000) fires regardless, because being
killed by the platform with `running_at` still held is worse than a pass that
has to wait for AxisCare to recover.

Verified by simulation across every budget from 20,000ms down to 1ms, AxisCare
up to 10× slower, and pathological chunk shapes: `complete` never true without
full coverage, no livelock anywhere, and the refresh still taken on every run
that had the budget for it. Then end to end with the real handler against live
AxisCare — a resumed run reads its cursor chunk at 654ms, the near window at
2,810ms, another cursor chunk, and finishes in 7.6s.

#### A cursor is an index, and the chunk list moves at midnight

**This one deleted real coverage, about once a day, silently.**
`cursor_chunk` indexes a chunk list rebuilt from `ymd(now)` every run, and
`from` moves forward at **local midnight** — so every boundary slides one day
while the saved index does not. A pass resuming across that boundary leaves a
one-day **hole** between the last chunk the previous run read and the chunk
this one resumes at, then reports `complete` and lets the sweep delete every
row on that date. Real open shifts, gone from the board, `last_ok_at`
advanced so the browser keeps trusting the mirror, no error anywhere.

Replaying the handler’s own window/chunk code: cursor 2 loses **2026-10-01**,
cursor 3 loses **2026-10-15**, cursor 4 loses **2026-10-29**, and a pass
straddling the month rollover loses **2026-10-28**. The comment in the source
used to claim the chunks are “recomputed identically every run so a cursor
saved by one invocation still means the same thing to the next” — that only
ever held *within a calendar day*.

The fix is one line: if the window this run computed is not the window the
cursor was saved against (`window_from`/`window_to`, already recorded on every
run), **start a fresh pass**. Costs redoing one partial run a day.

#### The cursor may not advance past rows that were never written

The sweep needs *“every row in the window carries this pass’s stamp”*, which is
strictly stronger than *“every chunk was read”*. `cursor_chunk` was advanced by
the scan loop alone, so a failed upsert — a Supabase 5xx, a socket timeout —
persisted a cursor claiming rows were stamped that were never written, and the
next run completed the pass and swept them. A run that scans chunks 0–2 and
then fails its upsert would take **28 days of the window** with it on the
following run. `stored` now gates the cursor: if the write did not land, the
cursor rewinds to where the run started. `pass_stamp` deliberately does not
roll — chunks below it were stamped by earlier successful runs of the same pass.

For the same reason the near refresh is wrapped in its own `try`: it is five
extra requests of failure exposure on ground already covered, and a 429 in it
must not cost the run its real work.

`SOFT_DEADLINE_MS` is **6,000, not 8,000**, for a related reason: it is checked
*between* chunks, so the real stop is always one chunk late. At 8,000 a run
measured **9,941ms** before its writes — over the 10s platform timeout, which
is the death the constant exists to prevent, and a run killed there strands
`running_at` without advancing the cursor. At 6,000 runs measure 7.1–7.9s.

The cost is one more run per pass, and **that is why `MIRROR_COLD_MS` moved from
45 to 90 minutes.** `last_ok_at` is the pass START stamp — only a whole window
earns it, and the earliest read in that window is the honest time to claim — so
it is already one full pass old the instant it is written. A 3-run pass at the
ten-minute cron starts at T, completes at T+20 stamping `last_ok_at = T`, and the
next does not complete until T+50: **the peak age in ordinary healthy operation
is ~50 minutes.** Against 45 the mirror would read cold for part of every cycle
and every browser would fall back to the 9.6s live scan — the mirror built, then
not used, which is the exact failure the whole design exists to avoid.

> The paragraph that used to sit here compared pass **duration** against the
> threshold. The browser compares `Date.now() - last_ok_at`, which is a
> different and always larger number. Caught in review, not in production.

What makes 90 safe rather than merely convenient: the **near window is re-read on
every run**, so the part of the mirror the coverage board actually shows is at
most one run old whatever `last_ok_at` says. The threshold now only governs
how stale a *whole-window* verification may be before the far end stops being
believed — and a shift that got filled is caught where it matters anyway, by
`verifyShiftStillOpen()` on the assign path.

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

**The revalidate half has to reach the session that triggered it.** The read
happens *before* the sync it kicks off, so on its own it shows the board as it
stood beforehand and nothing ever says otherwise — the scheduler reloads, sees
the shift still missing, and reloads again. `revalidateOpenShifts()` waits on
the sync **we** nudged and, if that run scanned anything, re-reads the mirror
and repaints. Nobody is blocked: the board is already up.

Three details in it are load-bearing:

- **It parses the body whatever the HTTP status.** A partial run is the
  normal outcome and the handler answers those `502`. Gating on `response.ok`
  would discard almost every real result.
- **It passes `mirrorOnly`, so the re-read never falls back to the live scan.**
  Without that, a load where the mirror happened to be cold would spend a full
  16-request, 9.6s AxisCare scan on a result the caller then discards.
- **It MERGES; it does not replace, and it must never call `CLOUD.relayer()`.**
  An earlier version assigned the mirror rows straight over `state.shifts` and
  then called `relayer(['shifts'])` to put the scheduler’s work back. That work
  comes from the **local overlay**, which is only written by the 900ms-debounced
  `doSave()` — and `doSave` returns early while a push is in flight, so the
  window is longer still. An assignment made inside it exists in memory and
  nowhere else, so the replace dropped it, the rebase folded the loss into the
  baseline, and the next save pushed the reversion to all three schedulers.
  `relayer()` re-applies **every** slice, so the blast radius was never limited
  to shifts either. Keeping the existing object for an id already held avoids
  all of it, and needs no rebase: an untouched object diffs clean against
  `BASE`, and adds and dels are refused by `patchOnly`. `retryAxis()` still
  needs `relayer()` because `ROSTER.hydrate()` rebuilds every record; this path
  rebuilds none.

  The cost, stated plainly: a shift **retimed** in AxisCare keeps its boot-time
  hours until the page is reloaded, because a visit id encodes the date but not
  the time. Not a regression — nothing refreshed shifts at all before — but not
  a complete answer either.

It compares by **id set**, not by count: one shift filled and another opened in
the same window is a real change a count misses.

**A `skipped` answer gets one bounded retry**, and that case matters more than
it looks: reloading straight after changing something in AxisCare is exactly
what a person does, and a reload inside `MIN_GAP_MS` (90s) — or while a run is
already in flight — is turned away by the debounce or the lock. Without the
retry the revalidate simply would not happen on the load that most needed it.
Two different refusals arrive as `skipped` and they need **opposite**
treatment, which the first version got wrong:

- **The lock** (`a run is already in flight`) carries `since` and **no**
  `lastRunAt`. A run is scanning right now, so re-nudging is pointless — the
  handler stamps `last_run_at` with that run’s *start*, so a nudge 10s later is
  certain to be debounced away in turn. Just wait ~12s for it and re-read.
- **The debounce** (`synced recently`) carries `lastRunAt` **and a
  server-computed `agoMs`**. Here a nudge is the point, once the debounce has
  expired. Use `agoMs`: deriving the age from `Date.now()` against a server
  timestamp puts the viewer’s clock in the loop, and an unsynced Windows desk
  running three minutes fast waits too little, gets debounced again and gives
  up.

Both then **re-read regardless of what the second nudge says** — another
session or the cron may have moved the mirror meanwhile, and a mirror read is
two cheap Supabase requests against no AxisCare calls at all. The wait is
clamped to 2–100s so a missing, stale or future timestamp can neither hang it
nor spin it. **One retry per page load**, and `lastNudge` is nulled when
consumed so there can never be a second.

So a brand-new shift now appears **on the load that triggered the sync**,
without anybody reloading again — a few seconds later, or ~90s later if the
debounce was in the way. It was up to ~20 minutes.

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

### The list is refreshed ONCE per load; the ASSIGNMENT is re-checked

`fetchOpenShifts()` is reached through `fetchOpenShiftsMirrored()`, whose call
site is inside `hydrate()`’s `Promise.all`, and `hydrate()` runs only from
`boot()` and `retryAxis()`. `revalidateOpenShifts()` then re-reads the mirror
once, a few seconds after boot — see *Stale-while-revalidate* above.

After that there is **no timer and no poll**, so the open-shift list is as old
as the tab minus that one refresh. Four hours open, four-hour-old coverage
gaps — which is why the assignment is still re-checked below.

Observed on 2026-09-03: the Brenda Janowski 8a–8p visit
(`v=56967:s=0:d=2026-09-03`) read `caregiver: null` in the morning and
`caregiver: 1104` by the afternoon — filled in AxisCare while every open session
went on offering it and ranking caregivers for it.

Re-scanning the window costs what the boot costs — 14 requests, 1,321 visits,
9.1s, measured above, not the "8 requests / ~640 visits / ~5s" this line used to
claim, which contradicted the table 200 lines earlier.
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

> **The same one-hour trap sat in `coverageMatches()` until 2026-09-21**, on the
> shift side this time. It handed `covClash()` `start + 1` for any shift whose
> end was not after its start, so on every **overnight** shift the double-booking
> check covered the first hour alone — somebody booked from 9pm was cleared for
> a 7pm–1am shift. It now passes the real end, which `covClash()` already turns
> into end + 24 — an end *equal* to the start included, which is a 24-hour
> live-in shift and is how `coverageDetail()` reads it too — and keeps
> `start + 1` only for an end AxisCare did not give. The date search always
> passed the real end. Still not covered, on either screen: a visit that
> *starts* after midnight, because it is filed on the next date.

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
| the table has not loaded | **everyone**, and the shift card says the preference was not applied |

That last row is what `genderKnown` exists for. **Claude: do not collapse it
into `genderPref === null`.** A missing preference and an unread one are
different answers, and silently treating “could not read it” as “nobody
minds” would put male caregivers in front of a client who asked for a woman
with nothing on screen to explain it. `covMatchNote()` states the rule in
force on every shift, in four values — *Female only* / *Either* / *Still
loading — not applied* / *Couldn’t read — not applied* (“not yet” reads
differently from “not at all”). See *What the client asked for sits IN the
shift card*.

**A caregiver whose gender AxisCare does not record is held back** when a
preference exists, because they are not *known* to be the gender asked for.
It applied to exactly one caregiver, Angelina Dela Cruz (id 613); her gender
was recorded in AxisCare on 2026-09-01 and **every active caregiver now has
one**, so the rule currently excludes nobody. It stays as a guard for a future
hire, and the fix is always to record the gender rather than loosen the rule.

**Driving is wired now** — corrected 2026-09-08. This line used to say it was
"deliberately not wired… a ranking signal until the desk asks for it", which
described an intention rather than the code: `covClientPrefs()` read
`cl.drivingRequired`, **a property nothing in `index.html` ever assigned**, so
`prefs.drivingRequired` was permanently `null` and the `+10 / −20` branch in the
ranker could not execute at all. Worse, `covMatchNote()` used that same null to
tell the desk *"No driving requirement is recorded either"* — on two active
clients (Mary Lou Brown, Ziad Niazi) where Concierge plainly records that one is.

It now reads `client_match_prefs.driving_required` through `CLMATCH`, with
`cl.drivingRequired` left underneath for seed clients. 10 clients require a
driver, 6 explicitly do not — **12 and 7 of the 24 active clients** when
re-measured on 2026-09-21. What a caregiver who cannot drive them looks like on
the list is under *The calling list shows warnings only*.

### How Find Coverage ORDERS the list — the client first, then the caregiver

The gates above decide **who can be called**. This decides **who to call first**,
and it was rewritten with Carlo on 2026-09-08. `coverageMatches()` is the only
place it happens.

The rule the desk asked for: *what the client wants decides the top of the list,
what the caregiver wants decides within that, and geography breaks what is left.*

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

None of these points is shown. The scheduler sees the order, the client's own
reason for a caregiver as grey text, and amber or red warnings — see *The
calling list shows warnings only*.

**The magnitudes are load-bearing, not taste.** Everything on the caregiver's
side tops out at **+26** and drive time adds at most **+20**, so **46** is the most
the caregiver's side and the geography can ever contribute. The three terms that
say *the client asked for this person* — Concierge list, AxisCare preferred,
worked here recently — are each worth more than 46 on their own, so none can be
overturned by preferences and geography. That is what makes "the client first"
arithmetic rather than an average. **Change one of those three and re-check it
still holds.**

The driving term (+10) is deliberately *not* in that group: it is a
requirement of the placement, not a request for a person.

#### Weekly hours — what ranks, and what does not

Asked on 2026-09-21 ("how does min hours per week affect the ranking?"), and the
answer is **it does not**. Nothing that ranks caregivers reads `ops.minHours`,
`ops.maxHours`, `ops.minShift` or `ops.maxShift`; they feed the Work Preferences
card, Needs Update, Recent Updates and the availability report only.

What ranks is the hours a caregiver is **already booked** in AxisCare in the
Monday–Sunday week of the shift, not counting the open shift itself
(`covWeekHours()` over `COVHIST`): 32–39 is −8, 40 or more is −25, and since
2026-09-23 both chips describe **workload** rather than overtime, and name the
total the shift would produce — the agency pays DAILY overtime, so a weekly
figure is not a pay figure at all. See *It is a WORKLOAD chip, not an overtime
one*. Every other hours term in the file reads `c.weekHrs`, which is
`null` on every live caregiver, so none of them runs. The "N h this week" text
came off the row on 2026-09-21 at Mitch's request — it read "0 h this week" on
most rows and helped nobody choose who to ring — and the scoring did not
change. The 32–39 chip was added the same day, because with the text gone that
−8 had become invisible.

**Do not give the min/max a reader without cleaning the data first.** Measured
2026-09-21 on the 109 schedulable caregivers: the minimum is exactly **20** on
104 of them, the old demo default, re-saved by the Work Preferences editor on
every save because it writes back what the form showed; there is no
`min_hours` column anywhere, so no real minimum exists outside the overlay. The
maximum is a leftover **40** in the overlay that hides the real
`caregiver_profile.max_hours` on 43 of them (so the card reads "20–40 hours"),
and four records hold a minimum above the maximum. Even with clean data, a
minimum-hours boost has about **+3** of room before it could outrank a caregiver
the client asked for.

#### `match_state` is NAME RESOLUTION, not strength of preference

**Claude: do not score `confirmed` above `auto`.** The first version of this
change did exactly that — +60 "Client's chosen caregiver" against +22 "Suggested
for this client" — and both labels were false.

`matching-sync.js` says it plainly: **Concierge owns which names are on a
client's list; this app owns only which caregiver a name resolves to.** So
`confirmed` means a person fixed a *name-to-record* resolution the matcher could
not make confidently — typically a nickname — and `auto` means the name matched
first time. `unmatched` means it could not be resolved at all.

Client 217 lists five names, all equally asked for. Exactly one is `confirmed`,
and only because Concierge spells her differently. Ranking that one 38 points
above the other four would have been an artefact of spelling.

So **every resolved name carries the same weight**, and `sort_order` — Concierge's
own ordering of the list — separates them. `unmatched` rows carry
`caregiver_id: null` and are skipped: we do not know who they are, and guessing
is what the confirmed guard exists to prevent.

#### Concierge's matched caregivers were display-only until now

`CLMATCH.matches()` had exactly **one** reader in the whole file — the read-only
card on the client schedule page. So a caregiver the desk had explicitly matched
to a client in Client Concierge got **no ranking weight at all**. Measured: 53
rows, every one resolving to an Active caregiver, and only **6** coincide with
the AxisCare `preferredCaregiver` the ranker was reading instead. Ten active
clients have Concierge matches and no AxisCare preferred caregiver, so for them
the ranker believed nobody was preferred.

#### What was removed, and why none of it changed an order

- **`+25` for availability** — availability is a hard gate, so every surviving
  row scored it and nobody moved.
- **`+12` for matching the gender preference** — likewise a hard gate. Its `−25`
  branch was unreachable for the same reason.
- **`±500` for a previous contact** — `renderCoverageCommand()` filters everybody
  in the contact log out of the queue *before* the order is drawn, so it could
  never reach the screen. **If that filter ever goes, this has to come back.**
- **The blanket "Driver" chip** — pushed onto every driver (69% of rows) and
  worth exactly zero unless the client needs one. It filled a chip slot while
  explaining nothing. The grey "Driver" fact that replaced it went on
  2026-09-21 with the green chips.

#### The calling list shows warnings only — 2026-09-21

Mitch's call: the green chips were noise, and only amber and red warnings
should show. **Claude: do not bring a green chip back.** Every positive term
still scores exactly as before; only its chip went — *On this client's list*,
*Preferred caregiver*, *Worked N visits here in 30 days*, *Drives — this client
needs it*, *Wants to work in X*, *Hours they prefer* and *Closest available*.

On the live board **every #1 row was explained by green chips alone**, so
removing them outright would have left *Call in this order* with no reason on
screen. The facts that say the client asked for this person therefore moved
into `covMatchRow()`'s grey line rather than vanishing:

```
Erma Delassio
Preferred · Port Hueneme · ~10 mins away · 8 recent visits

Elizabeth Galang
Oxnard · Same city
```

The order is Mitch's, 2026-09-22: **why this row is here, then where they
are, then how well they know the client.**

- ***Preferred*** covers both sources — on this client's Concierge list
  (+60) and AxisCare's `preferredCaregiver` (+50). They say the same thing to
  a scheduler, so they read the same, and the tooltip names which record it
  came from.
- **The home city** then the drive: a scheduler knows the county, so
  "Camarillo · ~15 mins away" says more than the minutes alone, and it is the
  one fact on the row needing no tooltip. It is dropped only when AxisCare has
  no city, where *Drive time not known* stands alone.
- ***N recent visits*** replaced *Worked 13 visits here in 30 days*, which was
  the longest thing on the row for the caregivers who most deserve a short
  one. The thirty-day window is in the tooltip; see `COVHIST` for why it is
  thirty days and not their whole history with the client.

*Asked to work in X* was there for one day. It is the largest caregiver-side
term (+12) and it explains a row ~50 mins away sitting above one ~30 mins
away — Carlo asked exactly that about Patricia McGrath's shift on 2026-09-21,
where the answer was that +12 plus −8 on the nearer caregiver for 36 hours
already booked. Mitch read it as noise and it came off on 2026-09-22; the
hours chip still explains that row, the city term no longer explains itself.
Also unshown by choice: the drive term (the minutes say it), preferred hours
(+6), client-gender comfort (+8) and the driving bonus (+10). **A row can sit
a few points above another for a reason not on screen** — that is the accepted
cost of chips-as-warnings.

Also gone from that line: *Available for this shift* (true of every row —
availability is a hard gate), *Driver*, and *N h this week* (see *Weekly
hours*).

What is left is warnings, never capped, red first:

| Chip | Colour | When |
|---|---|---|
| Doesn't drive clients | **red** (`.cvm-tag.crit`) | `covDrives()` says no — see *Three places where absence…* |
| Driving records disagree | amber | the driving records contradict each other |
| Driving not recorded | amber | nobody has recorded anything |
| Long drive — ~20 min past their limit | amber | the drive is more than 20% past their `maxMiles`, and the chip states the MINUTES PAST |
| Prefers female / male clients | amber | a *typed* client-gender preference the client does not fit |
| Heavy week — 44 h with this shift | amber | the shift would take them to 40 h or more that week (−8 at 32–39 booked, −25 at 40+) |
| 39 h that week with this shift | amber | 32–39 booked, but a short shift keeps the total under 40 (−8) |

Every chip carries its evidence in a tooltip (`why[].tip`): which records said
what, the caregiver's own limit in miles, their typed preference, or where the
hours come from. The red class is new and built on the existing `--crit-tx` /
`--crit-bg` tokens.

##### It is a WORKLOAD chip, not an overtime one — 2026-09-23

**Claude: do not put the word "overtime" back on this chip.** It was there for
a day, it was wrong, and the reason is a fact about the agency rather than a
matter of wording.

**This agency pays DAILY overtime — hours over 8 in a shift — not weekly
overtime over 40.** Carlo, 2026-09-23. His own example settles it:

```
4 × 10 h shifts  ->  40 h worked,  2 h over 8 on each  =  8 h at the OT rate
1 ×  4 h shift   ->   4 h worked,  none
                      ──────────────────────────────────────
                      44 h worked,  8 h of overtime
```

The weekly-40 reading calls that **"4 h over 40"** — half the real figure,
from a rule this agency does not use. So the chip was not merely unclear, it
was **describing the wrong quantity**, which is why Mitch kept rejecting every
rewording of it.

It matters more here than it would elsewhere. Measured on the live account
(2026-09-01..22, 497 visits, removed ones excluded): the dominant shift is
**twelve hours — 265 of 497** — and **71% of all visits exceed 8 h**, 66%
exceed 9 h. Under daily overtime almost every shift the desk fills generates
some. A weekly threshold was never going to describe that.

So the chip now claims only what the app can stand behind: **how loaded
somebody already is, and what this shift would make it.**

| booked | the shift | chip |
|---|---|---|
| 32 h | 12 h | `Heavy week — 44 h with this shift` |
| 42 h | 12 h | `Heavy week — 54 h with this shift` |
| 36 h | 3 h | `39 h that week with this shift` — under 40, so no judgement word |
| any | no end from AxisCare | `36 h booked that week` |

**One rule, not two.** The score still bands on the hours already booked —
−8 at 32–39, −25 at 40+, **unchanged** — but the wording keys on the total the
shift would produce, so a scheduler reads one sentence whichever band it came
from. The tooltip says the hours are **scheduled, not clocked**: `absorbHours()`
reads `scheduledStartDate || startDate`.

###### Why this app may not talk about pay at all

Verified against the live account on 2026-09-23, so nobody has to re-litigate
it. AxisCare's API is silent on pay computation:

- `payrollId` is **null on all 185 active caregivers**
- `payRate` is one flat string, **5 distinct values**, 167 of them `20.000` —
  no overtime variant, no rate table, no effective dates
- no caregiver, visit or schedule field matches `overtime` or `ot_`, and the
  **496 KB OpenAPI spec contains "overtime" zero times**. There is no payroll
  or timesheet path
- AxisCare's only overtime concept is the **service code on the CLIENT's
  schedule** — `STDOT40`, `STDOT42`, `SROT36` against `STD40`, `STD41`, `SR38`.
  That is a per-client contract somebody chose, not a per-caregiver
  calculation: 13 clients had September schedules, **3 use an OT code and 0
  mix**. It is not even a premium — `SROT36` bills **36**, *lower* than
  `SR38`'s 38. It reads as "overtime is included in this client's rate"
- `chargeRate` appears **zero times** in `index.html` and `payRate` has **no
  readers**, so none of it reaches a scheduler anyway

Whether AxisCare's payroll module applies an OT rule for this tenant is a
question only its payroll screen answers — one screenshot from Mitch settles
it. Either way the app has no evidence of cost, so a chip may not claim one.

###### KNOWN BETTER, NOT BUILT: the real overtime figure is derivable

Now that the rule is known, `COVHIST` already holds what it needs — it walks
every visit in the shift's week with its start and end:

```
overtime hours = Σ over each DAY of the week: max(0, that day's hours − 8)
```

That returns **8** for the example above, correctly, and this shift's own
contribution is knowable too (a 12 h shift adds 4 h). Three reasons it was not
smuggled in with a rewording:

- it must group by **day**, not by visit — two 5 h visits in one day is 10 h,
  so 2 h of OT. By visit it would undercount
- the scoring bands would want revisiting: is "8 h of OT" worse than "44 h
  booked"? Probably, but that is a ranking decision, not a wording one
- **the 8 must be confirmed with payroll.** California uses 8 h/day for
  household employees under Wage Order 15, but **9 h/day (and 45 h/week) for
  personal attendants** under the Domestic Worker Bill of Rights, and which
  applies turns on the duty mix — the share of time on non-caregiving work.
  Nothing in AxisCare records the mix. Carlo states 8, which is authoritative
  for this payroll; it should not be hard-coded on one sentence in a chat

###### The daily line is also not checked ANYWHERE

`covWeekHours()` returns a Mon–Sun total and nothing in the ranker looks at a
single day. With 71% of visits over 8 h, the rule that actually binds fires
several times a week and the board never mentions it. Its own piece of work,
not started.

#### What the client asked for rides the HEADER LINE — 2026-09-23

`covMatchNote()` has been three shapes in two days, and the reasons are worth
keeping because the third is not obviously better than the second until you
know what went wrong with it.

| | shape | why it went |
|---|---|---|
| until 09-22 | four sentences of prose in its own grey panel | grey block between a white card and a grey list header — clutter |
| 09-22 | a label/value table **inside** the shift card | see below |
| 09-23 | **chips on the client's own line**, beside the care type | — |

The table was `.emp-row`, which is `justify-content:space-between`. The page
went **full width** on 09-22 (see *The chat is FULL WIDTH*), so from that
moment the label sat at the far left of the card and the value at the far
right — **up to 1,600px apart on a wide monitor**. Three rows of that is a lot
of eye travel for six words, and it pushed *Call in this order* most of a
screen further down. Mitch: *"it is still hard to read, the table is so big and
not instantly read."* Her fix, and it is the right one: put the facts where the
care-type chip already is.

```
Patricia McGrath  [FULL ASSISTANCE WITH ADLS] [FEMALE ONLY] [NO DRIVING REQUIRED]
                  PREFERS [Cristal Zambrano · not available] [Dummy Caregiver Test · not available]
Simi Valley · Tue, Sep 29 12:00 PM–9:00 PM
```

Measured on the live board: the card went **~190px → 72px**, and it wraps with
no overflow at 1600, 1280, 1024 and 820.

`.cv-fact` is deliberately **grey, not amber**. It is the same pill as
`.cc-part` so the line reads as one run, but the care type is what a scheduler
looks for first and has to keep the only colour on the line.

##### The three states are told apart by SHAPE now, not by wording

This is the part that must not be lost, and it is easy to break by "tidying".
Concierge owns all three facts, and they are the largest terms in the order, so
*could not read it* means the list below was built without them:

| | on screen |
|---|---|
| recorded, and it constrains the search | a chip with the value |
| recorded, constrains nothing (*Either*, no driving requirement) | **no chip** |
| Concierge unreadable or still loading | a **red** chip saying which |

So an absent chip always means *asked, and nothing to apply*, and red always
means *not asked*. **Claude: do not add a neutral chip for the not-recorded
case.** It would make absence ambiguous and put us back where the table
started — which is the whole reason the table carried so many words.

Verified by stubbing `CLMATCH.status()` to `error`: three red chips, one per
fact, each naming what was not applied.

The asked-for caregivers keep the `.clm-cg` chips they already had, still
marked `· not available` when they are not on the calling list, behind one
`PREFERS` label — Mitch's own word. They still wrap, so a six-name client
(Ziad Niazi) runs onto a second line rather than truncating.

> **One rule was doing live work and nearly went with the dead ones.**
> `.cv-match .emp-v[title], .cv-match .clm-cg{cursor:help}` was the **only**
> `cursor:help` the name chips had. There is no standalone `.clm-cg{cursor:help}`
> rule — a `grep -o` makes it look like there is, by matching the tail of that
> compound selector. It moved to `.cv-client .clm-cg` rather than being
> deleted. Five `.cv-match` rules went; the `.clm-*` rules themselves stayed,
> because the client schedule page's read-only Caregiver Matching card still
> uses them.

The **AxisCare double-booking check** is a chip too now, and still appears only
while it is running or when it failed.

`renderCoverageCommand()` still returns **`{match, html}`** rather than a
string: the facts have to name which of the asked-for caregivers are on the
calling list, which is only known once that list is built, and `viewCoverage`
hands `match` to `renderShiftSummary(q, match)`. One `coverageMatches()` run,
not two — `renderShiftSummary` now drops it onto the client’s line instead of
under the card.

#### Drive time comes from `DRIVE_TIMES`, not the `CITY` grid

Added 2026-09-21: Mitch asked for time instead of distance, because a scheduler
reads "~20 mins away" faster than a mileage. Both Find Coverage screens now show
drive time, and neither reads `miles()` or `CITY` for it.

`DRIVE_TIMES` (beside `CITY` in `index.html`) holds **[minutes, road miles]**
between two city centres — free-flow, **no traffic**, the mean of both
directions — generated once from OpenStreetMap routing by
`scripts/drive-times.js` and pasted in. The page never calls a routing service,
no address ever leaves the browser, and there is no key. Read it through
`driveBetween(a, b)`, which returns `{same, min, mi}` or `null`; format with
`fmtDrive()`, which rounds to 5 minutes because city-centre data cannot
honestly say 17.

**Why a table and not a formula over the grid.** `CITY` is a proximity grid,
not a road map, and turning its miles into minutes keeps its mistakes. Measured
2026-09-21 against real routes: across its 66 pairs the grid reads about
two-thirds of the road miles and is up to 27 minutes out, and for a Camarillo
client — 10 of the 24 active clients — it put Ventura caregivers closer than
Oxnard ones when the drives are 20 and 15 minutes. `driveMin()` (miles × 1.6 +
2) was already in the file, and only on screens nothing opens any more.

What a row says, and why:

| Row | Means |
|---|---|
| `~15 mins away` | the table has the pair; the tooltip gives road miles and "without traffic" |
| `Same city` | both in one city, which the row has just named. Not a number: inside Oxnard (10 × 12 miles) it could be 5 minutes or 20 |
| `Drive time not known` | a city is missing, blank, or not in the table. It scores nothing, exactly as the old unknown city did |

**Adding a city** is a line in `scripts/drive-times.js` and a regeneration.
The table holds every home city on the roster **and every city in the part of
AxisCare's address dropdown we have seen** — a screenshot of it from
[None Set] to Reseda — so a record the desk changes tomorrow probably already
has a drive time. **The rest of that list, S to Z, has never been looked at**,
so a selection from it can still read "not known"; send a screenshot of the
rest and it is one regeneration. Lemoore is in: it is where AxisCare says one caregiver lives, and a
four-hour drive on the row is how that address gets noticed. **The point that
stands for a city matters** (moving Simi Valley's shifted its pairs by 3–4
minutes), so the script keeps them fixed.

> That dropdown spells Chatsworth **"Chattsworth"**, so `CITY_FIX` carries the
> misspelling. It also omits cities already on records (Canoga Park, Granada
> Hills, Agoura Hills, Lancaster…), so AxisCare holds values from outside its
> own list — probably an import. Do not read the dropdown as the full set.

#### When the city cannot be placed but the postcode can — `DRIVE_ZIP`

*Los Angeles* is left out of the table on purpose: 47 miles across, so no one
point answers for it. Three schedulable caregivers are recorded that way, plus
one parked and the desk's test record, and they are nowhere near each other —
**Reseda and Encino are both 60 minutes from Ventura, MacArthur Park is 81**,
and Pico-Union 82. One "Los Angeles" figure would be wrong for most of them,
and they used to read "Drive time not known".

So when the city is not in the table, **the postcode decides where to measure
from** (`DRIVE_ZIP`, read through `drivePlace()`). A ZIP is small enough to
place: 90057 covers about 0.9 square miles (Census ZCTA), against Oxnard's
27. The row still
shows the city AxisCare records, and the tooltip says the postcode was used:

```
Los Angeles · ~1 hr away
  About 49 road miles, Reseda to Ventura — city centre to city centre,
  without traffic. Measured from postcode 91335 (Reseda), because
  "Los Angeles" is too wide to place on a map.
```

**Fix the record where AxisCare offers the right city.** Its dropdown has
Reseda, so caregiver 1254 belongs there rather than in this map; it has no
Encino, which is why 91316 is in it. `'Los Angeles 90057'` is a ZIP centroid
rather than a place, because 90057 has no neighbourhood name of its own — it
is *Westlake* locally, and `CITY_FIX` already reads "Westlake" as **Westlake
Village**, in Ventura County, 40 miles the other way.

> **`zip` has to be added to BOTH mappers.** `AxisRoster.mapCaregiver()` reads
> `mailingAddress.postalCode`, and `toAppCaregiver()` rebuilds the app record
> field by field — a value added to the first alone never reaches `state`, and
> the row goes on reading "not known". Caught by the live page test, not by
> reading. It is derived from AxisCare on every boot exactly as `base` is, so
> it is in the baseline snapshot and diffs clean.

**Placing them starts the travel-limit chip firing**, because they finally have
real miles: Fitri Syam's stated 15 against a 49-mile drive to Ventura, Cindy
Vera Cruz's 30 against the 38 to her own two clients. Those limits are worth
re-confirming with the desk rather than assuming the chip is wrong — Cindy has
twice accepted 38-mile work.

The date search says `~15 mins from Camarillo` / `In Camarillo` against the city
the search was **run** with, and nothing at all under *Any city* — it used to
print "0mi" on every row, and "30mi" for anyone the grid did not know.

`milesOrNull()` is gone. `miles()` stays, still answering a made-up 30 for an
unknown city, because its remaining callers (Auto-offer, the old match cards,
the manual and recurring searches) sit on screens no navigation reaches.
**Do not give it a new caller.** An unknown city still scores 0 on the drive
term — the same as the furthest drive — which is an old decision this change
did not revisit.

#### The caregiver's own preferences — `cgWants()`

Read from `c.prefCities` (111 caregivers, via `caregiver_profile.pref_cities`),
`ops.maxMiles` (115), `prefVal(c,'clientGender')` (44 recorded, plus the CFC/CMC
tag fallback), and `ops.prefTimes` (44).

> `ops.maxMiles` **is real data.** It looks like it might be the `deriveOps()`
> default `[15,20,25,30][id % 4]`, and it is not — only 25 of 115 match that
> formula, which is chance, and the distribution holds values (10, 11, 13, 14,
> 16, 18, 19, 23, 29, 35, 40, 50) the formula cannot produce.
>
> **`ops.minHours` by contrast IS fabricated** and must not be given a reader.
> All 181 are exactly `20`, from `deriveOps()`'s `c.weekHrs < 25 ? 20 : 24`
> firing on a `null` — the documented `null < 85` trap. Three records read
> `20/16`, `20/12`, `20/8`, a minimum above the maximum, which nobody typed.
> Live caregivers take `axisOps()`, which sets both to `null`; the values
> survive only because `CARRY` faithfully re-emits patches from a code path
> the roster no longer takes. Still true on 2026-09-21 — 104 of 109
> schedulable caregivers read `20`, and **four** records (not three: 413,
> 617, 628, 997) now hold a minimum above the maximum — and the Work
> Preferences editor re-saves it too; see *Weekly hours — what ranks, and
> what does not*.

**`maxMiles` is a penalty, not a gate** — Carlo's call, 2026-09-08. The hard
gates already decided who can genuinely be called, and somebody who said 15
miles may still say yes to 18 for a client who asked for them.

**Nothing in `cgWants()` excludes anybody, and it must stay that way.** It also
stays silent when either side is unrecorded: "nobody asked" is not a preference,
and scoring it as one would rank a caregiver on a question never put to them.

#### Three places where absence must never be read as a "no"

All three were caught in review, and all three would have docked a real person
points — and printed a red chip asserting it — on evidence nobody entered.

- **Driving is a bonus and never a penalty.** `cg.driver` is `false` whenever
  the `DL`/`OC` tags are simply absent — **18 of the 104** schedulable
  caregivers, 11 of whom `caregiver_profile` records as owning a vehicle. A
  first attempt kept a `−20` by requiring an explicit `ops.prefs.driver ===
  false`, and **that guard does not hold**: both work-preference editors seed
  their driver control from `c.driver` (the tag guess) and write it back on
  every save, so a scheduler editing only the travel miles launders "never
  asked" into a recorded No. A penalty can come back only when a real
  "does not drive" answer gets a field no editor can write by omission.

  **Since 2026-09-21 it is a warning** — still no penalty (Carlo). For a client
  Concierge says needs a driver, `covDrives()` answers *can this caregiver
  drive the client?* from stated answers only: these are elderly clients who
  need to be driven, so **"can drive clients"**
  (`caregiver_profile.can_transport_clients`) decides first, and the licence
  (`can_drive`, the AxisCare `DL` / `WDL` tags) only when that is silent. A
  value counts as a change made on this dashboard when Recent Updates recorded
  a change to **that field** (`covDriveAudit()`) or it now differs from the
  profile row; such a change is the latest word and stands alone, over the
  profile and the tags — the same rule as a typed CNA answer over the CNA tag.
  The raw row comes from `ROSTER.profileOf()`, because `applyProfile()` folds
  it into `c.driver`.

  **Only these Recent Updates labels count:** *Driving status updated* (Work
  Preferences) and *Driving updated* (Ask Devi) for the licence, and *Can drive
  clients updated* (both) for driving clients. **Not *Transportation updated*.**
  That CG_WATCH key covered "Has own vehicle" and "Can drive clients" together,
  so a vehicle-only edit logged it while the editor quietly saved its seeded
  guess for "Can drive clients" — and reading it gave Puspa Sari (a1161) a red
  chip from a value nobody typed. It was split into *Has own vehicle* and *Can
  drive clients* on 2026-09-21; the second watches the **effective**
  `canDriveClients(c)`, so an untouched save logs nothing. Old *Transportation
  updated* entries cannot say which half changed, so they count for nothing.
  Ask Devi's `DV_PREF_FIELDS` now tries *Can drive clients* before *Driving*,
  because the driving regex also matched "can drive clients" and recorded a
  licence instead.

  | `covDrives()` | Chip | Score |
  |---|---|---|
  | yes | none | +10 |
  | no | red *Doesn't drive clients* | nothing |
  | conflict — can drive clients but no licence, or the licence sources disagree | amber *Driving records disagree* | nothing |
  | nothing recorded | amber *Driving not recorded* | nothing |

  **Never read `ops.prefs.driver` as evidence.** The laundering above is not
  hypothetical: on 2026-09-15 one pass through Work Preferences stamped the
  tag guess into `ops.prefs.driver` for all 105 schedulable caregivers, 35
  seconds apart, with **zero** *Driving status updated* entries in Recent
  Updates — no value changed, and every one now looks answered. Needs Update
  counts that stamp as an answer, so it has stopped asking anyone about
  driving; the editor still offers only Yes / No and starts on the guess. Both
  are known and **not** fixed by this change.

  The +10 follows `covDrives()`, not `c.driver`, so a caregiver recorded as a
  driver (a licence tag, or the profile's `can_drive`) whose profile says they
  do not drive clients no longer earns points for driving while wearing a red
  chip. On the live board of 2026-09-21 that was Rosalie Cruz (profile), and
  Bernadette Lazaro and Angela Zuniga (DL tag).
- **Client gender.** `prefVal()` falls back to the AxisCare `CFC`/`CMC` tags and
  reads a present `CFC` with an absent `CMC` as *"Female clients"* — but nobody
  ever ticked `CMC`, so that absence is silence. **A tag may earn the bonus and
  never the penalty**; only a typed `ops.prefs.clientGender` can hold somebody
  back. Two active caregivers (AxisCare 248, 321) are in exactly that state.
- **Preferred cities.** `c.prefCities` falls back to **the caregiver's own
  mailing city** when nothing was recorded, so "Wants to work in Oxnard" would be
  claimed for anyone who merely lives there — and would double-count, since
  living there already earns the full distance score. `c.prefCitiesRecorded` is
  the flag that tells the two apart; `cgWantsCity()` requires it.

  > **The flag is hard-`false` in the mapper, and `applyProfile()` is its only
  > writer.** The first version derived it as `!!(m.prefCities &&
  > m.prefCities.length)` — but `AxisRoster.mapCaregiver` has *already* filled
  > `prefCities` with the mailing address by that point, so the flag was `true`
  > for exactly the caregivers it existed to exclude. A no-op guard that reads
  > like a working one is worse than no guard; it survived one review pass.

> The pattern is the same one `hasVal()` and `nt()` exist for, arriving through
> a different door: a boolean `false` that means "never asked" is exactly as
> dangerous as `null < 85`.

#### The travel limit is checked against ROAD miles, with 20% leeway

Until 2026-09-21 a caregiver's stated `maxMiles` was measured against the
`CITY` grid, whose ceiling is **25**, so a limit of 25 or more (31 of the 104
schedulable caregivers then) could never fire. It is now measured against the
road miles in `DRIVE_TIMES`.

> This section used to say the grid's widest span, Port Hueneme → Simi Valley,
> is "roughly double" in reality. It is not: that drive is **30.1 road miles,
> about 47 minutes**. The grid's worst errors are elsewhere — Westlake Village →
> Simi Valley reads 4 grid miles against 15 road miles.

**The 20% leeway is deliberate — Carlo, 2026-09-21.** Against road miles with
none, the −25 fired on 2.4× as many caregiver-client pairs as on the grid, and
most of the new ones were within 20% of the limit — inside the noise of where
each city's point sits (a stated 10 miles against the 10.6-mile
Oxnard → Camarillo drive). So it fires only when the drive is more than 20% past
what they said.

**The chip states the EXCESS** — *Long drive — ~20 min past their limit*.
Carlo, 2026-09-23, matching the workload chip: a two-word verdict, then the
evidence. The row beside it already says how long the drive is, so the minutes
PAST what they agreed to is the one number the chip can add. It showed the
limit itself for two days (*Past their ~20 min travel limit*).

**The excess is computed from the RAW values and rounded once.** Subtracting
the two rounded figures on screen disagrees with the truth on **19 of the 149**
caregiver-client pairs that fire on the live roster: Lorilyn Federis to
Patricia McGrath reads a ~45 min drive against a ~20 min limit, which looks
like 25, where the real excess is 21.8 and rounds to **20**. The old wording
needed a `lim >= shown` fudge for exactly this reason; computing the excess
directly removed it.

`fmtDrive()` carries the hours form, which one caregiver genuinely needs:
Lemoore to Ventura County is a 247-minute drive against a stated 30 miles, so
it reads *~3 hr 30 min past*. And `driveRound()` floors at 5, so the shortest
firing drive on live data — **17 minutes** against a stated 10 miles, a true
excess of 3.7 — reads *~5 min past* rather than a number this data cannot
honestly give.

> **"Long drive" is an absolute word on a relative test, and that was
> weighed.** **25 of the 149** firings are on drives of 25 minutes or less;
> the shortest is 17. Carlo chose it anyway on 2026-09-23 over the relative
> alternative (*Past their limit — ~20 min further*), for punchiness. Read it
> as "long **for them**". If it ever reads wrong on a short drive, that is the
> known trade rather than a bug.

What the caregiver actually said, in miles, stays in the tooltip — the minutes
are our conversion of their miles at this route’s own speed, and must never
read as something they stated in minutes.

The same city, or a city not in the table, never fires it.

#### Preferred cities must go through `normCity` too

`caregiver_profile.pref_cities` is typed by a person and never cleaned, while
`cl.city` has already been through `AxisRoster.normCity`. A raw string compare
therefore made **"Westlake"** — which 9 caregivers record — a different place
from the **"Westlake Village"** clients normalise to, so the preference matched
nobody and looked like it was simply unpopular. `cgWantsCity()` now normalises
both sides, and `CITY_FIX` gained `Westlake`, `Westlake Vlg` and
`Westlake Village Ca`.

> Worth knowing: `milesOrNull()` (since replaced by `driveBetween()`)
> **surfaced** this rather than causing it. The old fabricated 30 quietly
> absorbed every unmapped city, so nobody could see which ones were missing.
> Expect more of these to become visible — each one is a one-line `CITY_FIX`
> entry, or a city added to `scripts/drive-times.js`.

`cgWantsHours()` requires **every** band the shift touches to be one they asked
for. A caregiver who picked *Morning* has not volunteered for an 8a–8p shift
just because it starts in the morning.

### Adding a Work Preference touches SEVEN lists, not one

**Claude: `WP_TRI` is not the list. It is one of seven, and adding a field to
it alone gets you a control that saves, displays, and is then invisible to
every screen that is supposed to chase it.**

Learned on 2026-09-14. A **CNA** Yes/No field was added to Work Preferences,
correctly, by adding `'cna'` to `WP_TRI` — whose commit message reasonably
concluded *"picked up automatically by the existing generic read/save logic
— no other handling needed."* That is true of the **editor**. It is not true
of anything downstream, because none of the other lists are derived from
`WP_TRI`; they are all written by hand. Mitch reported it the obvious way:
*"the newly added CNA is not appearing for every Caregiver in Needs Update."*

| # | Where | What it drives | Derived from `WP_TRI`? |
|---|---|---|---|
| 1 | `WP_TRI` | what the editor saves and reads back | — |
| 2 | the read rows (`row('CNA', yn('cna'))`) | the Work Preferences card | no |
| 3 | the edit selects (`sel('cna', …)`) | the Work Preferences modal | no |
| 4 | **`CG_REQUIRED`** | **Needs Update** — "Missing profile information" | **no** |
| 5 | **`CG_WATCH`** | **Recent Updates** — the change audit | **no** |
| 6 | **`prefVal()`** | the AxisCare class-tag fallback | **no** |
| 7 | **`DV_PREF_FIELDS`** (+ the `wantsCg` regex) | recording it through Ask Devi | **no** |

Four of the seven were missed, and 4, 5 and 7 are each a separate visible
failure: the desk is never prompted for the field, answering it leaves no
audit entry, and Devi cannot record it.

#### 6 is the one that has to land in the SAME change as 4

`CG_REQUIRED` and `prefVal()` are a pair. Adding a field to `CG_REQUIRED`
without a `prefVal` branch chases **everybody**, including the caregivers
AxisCare already answers for. On CNA that was **4 active caregivers** — Erlinda
Smith, Mary Joy Barrios, Wilma Escolano, Terry Consuelo Queyquep — who carry
the `CNA` class tag and would have been rung about a certification already on
file.

The rule is the one this file states everywhere else: **a tag is a Yes;
silence is silence.** `cgTag(c,'CNA')` returns `true`; no tag returns `null`,
never `false`; and `ops.prefs.cna` is checked first, so a scheduler's typed
No is never overruled by the tag. Same shape `OWP` has for pets and `NOVRN`
for overnight.

> **Not every field has a tag**, and inventing one is worse than leaving the
> branch out. Check the class-tag table under *Caregiver `classes[]`* first:
> if AxisCare records the fact, seed from it; if it does not, `prefVal`
> correctly falls through to `null` and the desk is asked.

#### The approval card shows the EFFECTIVE value, not the stored one

Fixed in the same pass. `dactPrefProposal` read `ops.prefs[k]` directly, so a
caregiver whose answer comes from a class tag was described as *"currently
not recorded"* while their profile plainly read **Yes**. Telling somebody
they are filling a blank, at the moment they click the button that writes, is
wrong when they are actually overwriting a recorded answer. It now reads
through `prefVal()` and says *"(from the AxisCare tag)"* when that is where
the value came from. This affected pets and overnight exactly as much as CNA,
so it was fixed for all three rather than special-cased.

#### Devi's grammar is narrow on purpose — that is not a bug to "fix"

`"record that Maria Lopez does not drive"` prepares a proposal.
`"Maria Lopez does not drive"` does **not** — it is read as a question about
her and falls through to her profile. That is `dactCommand()` requiring an
opening verb or a reporting verb, and it is the guard that keeps read
questions out of the write path. See *The instruction grammar is deliberately
narrow*.

One thing does have to be added alongside `DV_PREF_FIELDS`: the field's words
belong in the **`wantsCg`** regex a few lines above the loop. Without that, an
instruction naming a caregiver Devi cannot resolve — a typo — returns `null`
and Devi says **nothing at all**, instead of *"I could not find that
caregiver."*

### "Availability missing" counts EVERY status, not just Open

Needs Update's *Availability missing* answers one question: **has anybody told
us anything about this caregiver's current month?** `AVAIL.monthCoverage()` is
the only reader, and it counts rows of any status.

It did not always. The query behind it hard-coded `status=eq.Open`, so a
caregiver whose September was fully recorded as **Vacation**, **Unavailable**,
**Sick**, **School**, **Childcare**, **Appointment** or **Other Agency** — every
status in `AV_STATUSES` except Open — read as zero rows and was chased for
availability they had already given. Reported by the desk on Alejandra Gibbs
and Aliyah Moran; reproduced, and the difference is one row of the fixture:

| | days | openDays | flagged before | flagged now |
|---|---|---|---|---|
| 4 Open days in September | 4 | 4 | no | no |
| 4 days, all Vacation/Unavailable | 0 → **4** | 0 | **YES** | no |
| nothing in September (October only) | 0 | 0 | YES | YES |

`coveragePage(from, to, offset, openOnly)` now carries the distinction:

- **`openOnly: true`** — *which dates can somebody actually work.* Used by
  `primeCoverage`, which feeds "who has open availability" and Find Coverage.
- **`openOnly: false`** — *has anybody told us anything.* Used by
  `primeMonthCoverage`, which feeds this warning.

`monthCoverage()` returns both counts — `days` (any status) and `openDays` —
so the two questions can never be confused again. `state: 'none'` means no rows
at all, and that is the ONLY thing that is honestly "Availability missing".
Somebody down as Vacation all month is `has` with `openDays: 0`: an answer, not
a gap, and chasing them wastes the call.

The month window is the 1st to the last day of the current month, re-derived on
every call, and `monthCovKey` forces a refetch when the month turns over.
`forgetCov()` drops both caches, and the exported `forgetCoverage` is now that
same function — it used to clear only the wide one, so a roster re-sync left the
month cache stale.

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

### NEVER ask Supabase to transform these images

`cgPhotoUrl(c, px)` returns the **plain object URL**, always. It still takes
`px` because every call site passes it and it says how big the slot is, but
the browser does the scaling — `object-fit:cover` on `.cgh-photo img` and on
the list row already handles it.

**Claude: do not "optimise" this back to `/storage/v1/render/image/...`.**
It looks like the obvious win and it is a billed one. Supabase counts the
number of **distinct origin images transformed** in a billing period — not
the number of transformations — and the Pro plan includes 100. There are 177
photos, so a single paint of the caregiver list puts the account over on its
own. That is exactly what happened: **167 against an allowance of 100 by
2026-09-06**, discovered when the desk hit the overage warning.

It used to do exactly that, for a reason that was true when it was written:
a third of the bucket was PNGs over 1MB being shipped to a 44px slot.

### The size problem was the FORMAT, and it is fixed

Measured 2026-09-07: **every object over 500KB was a PNG, and every PNG was
over 500KB.** 33 files, 57.4MB of a 64.9MB bucket, against 144 JPEGs
averaging 53KB. PNG is lossless and the wrong container for a photograph.

Those 33 were re-encoded to JPEG at their **exact pixel dimensions** — no
resize, nothing cropped, the conversion asserted the dimensions were
unchanged on every file and would have aborted otherwise:

| | |
|---|---|
| bucket | 64.9MB → **11.0MB** |
| the 33 PNGs | 57.4MB → **3.5MB** (−94%) |
| largest object | 2268KB → **432KB** |
| objects over 500KB | 33 → **0** |
| transformations needed | **none** |

So the resize buys nothing now: the stored bytes are already smaller than
most of the transformed renditions were, and they cache properly
(`public, max-age=3600`). The originals are backed up outside the repo.

> The overage is a **billing-period total**. The fix stops it climbing; it
> does not refund what was already spent, and the number will not drop until
> the period resets.

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

## Uploading and removing a photo

`CGPHOTO` (beside `cgPhotoFail` in `index.html`) owns this. Clicking the
profile photo — or the small camera badge on it — opens a menu with **Upload
photo** and **Remove photo**. Upload opens the machine’s own file explorer,
filtered to JPEG and PNG.

**Claude: the UI here is yours to restyle. These seven rules are not.**
Each one is either a billing decision, a data-integrity rule, or something
that already went wrong once.

1. **The object key is `c.axisId`, bare, with no file extension.** Not
   `c.id` — that is `a312`, and the bucket is keyed `312`. All 177 existing
   objects follow this and `cgPhotoUrl()` reads it, so an upload simply
   overwrites the key. Getting this wrong writes a second orphan object that
   nothing ever displays.
2. **Never the transform endpoint.** See above — it is metered per origin
   image and there are more photos than the plan allows.
3. **Check the MIME type again after the file dialog.** `accept=` is
   advisory on some platforms, so a renamed file would otherwise be stored
   with a content-type that does not match its bytes.
4. **Always store a JPEG, capped at `MAX_EDGE` (512) on the longest edge.**
   Nothing in the app displays above **160px** — the profile header is 160,
   the list row 44 — so 512 is already three times the largest slot.

   It was 1433 (the biggest photo then in the bucket) until 2026-09-08. That
   stopped making sense the moment the transform endpoint had to go: with no
   server-side resize the list downloads **originals**, and at 1433px that
   meant a median avatar of 64KB, a worst case of 432KB, and about **1.6MB
   for twenty-five visible rows**. Re-encoding the 104 photos over 512 took
   the bucket **11.3MB → 3.7MB**; the 75 already under it were left alone.

   **Keep this number and the stored photos in step.** Raising it without
   re-encoding what is already there just makes every new upload the largest
   object in the bucket.
   - A **JPEG that already fits passes through byte for byte** — no
     re-encode, no quality lost to a conversion nobody asked for.
   - A **PNG is always converted**, even when it fits. Every one of the 33
     oversized objects was a PNG and every PNG was oversized: 1.74MB
     average against 53KB for the 144 JPEGs. The schedulers upload straight
     from a phone or a download — the old app's audit log has Angelica
     uploading a **2.28MB PNG** for caregiver 1264 on 2026-09-03 — so
     without this the bucket refills at roughly 2MB a time and the storage
     and transformation costs come back one upload at a time.
   - Fill the canvas **white before drawing**. PNG can be transparent and
     JPEG cannot, and every transparent pixel otherwise encodes black.

   The pixels are untouched either way; only the container changes.
5. **The cache-buster is only for the session that made the change.**
   `CGPHOTO.stamp()` returns 0 for everyone else, so the normal case still
   gets a plain, cacheable URL. Without it an upload appears to do nothing
   until `max-age` expires; with it on every URL, nothing would ever cache.
6. **Nothing here touches a CLOUD slice.** The filename *is* the id, so
   there is no database row and no `caregiver_profile` column. That is why
   none of the overlay hazards in *Don’t break these* apply to photos —
   keep it that way, and keep the per-caregiver state (`ver`, `menuFor`,
   `busyFor`) module-level rather than in `state`.
7. **Only a genuine not-found counts as “already gone” on delete.** Storage
   answers a missing public object with **400**, so 400 was originally
   treated as success — but it also returns 400 for a bad request and, on
   some versions, an RLS refusal with the real 403 buried in the body. That
   reported “Photo removed” while the photo reappeared in the same frame.
   Read the body and accept only a not-found payload.

### Writes go through `app-gate` (since 2026-09-18)

From 2026-09-07 `storage.objects` carried INSERT / UPDATE / DELETE / SELECT
policies for `anon` on this bucket — Mitch's call, for consistency with how
the rest of the app wrote then (`anon` could write `scheduler_state`). That
reason went away with the PIN gate: the rest of the app no longer writes with
the anon key, so neither do photos. `CGPHOTO` uploads and removes through
`GATE.fetch`, which `app-gate` turns into `photo.put` / `photo.del` with the
service key, and the four anon policies are dropped by the lock.

`app-gate` enforces rules 1, 3 and 4 above on the server as well: the key must
be digits, and the bytes must start `FF D8 FF` (a JPEG) whatever content type
the page claims. It still sends `x-upsert: true` and `cache-control:
max-age=60` itself.

**Reads are unchanged and still public.** The bucket stays public and the
`<img>` URL carries no key — the public route does not consult the policies —
because an image tag cannot send a PIN.

### A trap that cost a round of UI bugs

**This app has no `--panel` and no `--bad-tx` CSS variable.** The white is
`--surface` and the danger red is `--crit-tx`. An invalid custom property
makes the whole declaration compute to `unset`, so the first version of the
photo menu had an icon that inherited the dark body colour and vanished into
its own dark circle, and a menu with no background at all that the card
showed straight through. Check a variable exists before using it — the
palette is defined once, near the top of the `<style>` block.


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

---

## Quo — the phone system. Reads the Communication Logs, and sends texts

Added 2026-09-11 as read-only plumbing with no reader, the same stage AxisCare
went through. The **Communication Logs** card on the Caregiver Overview was
built on it the same day, and on **2026-09-14** it gained the one thing it
could not do: sending a text, from Find Coverage. Two consumers now — see
*Read-only — except `action=send`* and *Texting a caregiver from Find
Coverage*. See
*Communication Logs* below.

Quo was called **OpenPhone** until it rebranded in 2026. Every older doc, SDK,
blog post and Stack Overflow answer you find under that name describes this
same API. The OpenAPI spec is still served from an `openphone-public-api-prod`
S3 bucket and is current.

**The API key sees TWELVE inboxes, not the four the Quo app shows a signed-in
user.** That gap matters — it is why the card sweeps every line rather than
the one it was first asked for. Confirmed live 2026-09-11:

| Number | Inbox | | Number | Inbox |
|---|---|---|---|---|
| +1 805 312 7736 | **Scheduling Department** | | +1 805 586 6886 | Emergency Hotline |
| +1 805 427 8644 | **Recruitment** | | +1 805 910 1371 | Billing Department |
| +1 805 419 6909 | Client Support Line | | +1 478 606 6282 | (Finance) |
| +1 805 246 7002 | Client Inquiry Line | | +1 607 800 4842 | CEO Direct Line |
| +1 507 417 8132 | Primary | | +1 256 408 5310 | Marketing Direct Line |
| +1 405 809 8456 | Primary | | +1 901 370 8874 | Primary |

Nine users: five owners, two admins, two members.

### It lives in SUPABASE, not Netlify — and that has a cost

The AxisCare-facing backends are Netlify functions. Quo is one of six Supabase
Edge Functions — `devi-agent`, `quo`, `care-brief`, `comms-summary`,
`carenotes-summary` and, since 2026-09-18, `app-gate` (see *The PIN gate*) — and it is there for the same
reason as the others: **the key is there.**
`QUO_API_KEY` was put in the Supabase project secrets, so the function that
reads it has to be a Supabase Edge Function.

**A commit does not deploy it.** `index.html` auto-deploys to Netlify;
`supabase/functions/` does not. After any change to `supabase/functions/quo/`:

```
npx supabase functions deploy quo --project-ref gdzgoyawavffjdjpjbfz --no-verify-jwt
```

**`--project-ref` is not optional**, and `supabase/config.toml` does not spare
you it: `functions deploy` does **not** read `project_id` from that file — it
wants a prior `supabase link` or the flag, and answers *"Cannot find project
ref. Have you run supabase link?"* otherwise. The ref is pinned in
`config.toml` so it is always to hand; pass it.

`--no-verify-jwt` because the dashboard sends no JWT, exactly as with
`devi-agent`.

Auth is a **personal access token** (`sbp_…`), not the anon or service-role
key — `supabase login`, or `SUPABASE_ACCESS_TOKEN` **exported into the shell**;
`.env` carries the value and `.env.example` documents it, but the CLI does not
read `.env` itself (see the box below). An expired one fails late and confusingly: the
upload starts, then `unexpected deploy status 401: Unauthorized`.

Deployed and verified live on 2026-09-11, and again on **2026-09-14** with the
send path. That second deploy was checked against the DEPLOYED function rather
than a local build — 22 probes, every one of them designed to be refused (an
off-roster number, a spoofed sending line, an empty message, 27 recipients, an
over-long body, a send over GET, a POST to a non-send action, PUT/PATCH/DELETE,
and a test-mode destination that is not one of our own lines). All refused, and
no text was sent to anybody.

> **THE CLI DOES NOT READ `.env`.** This is the first thing to rule out, and it
> cost a wrong diagnosis on 2026-09-23. `SUPABASE_ACCESS_TOKEN` lives in `.env`,
> but `npx supabase` reads the token from the **environment** or from a prior
> `supabase login` — so a perfectly good token answers `Unauthorized`, which is
> byte-identical to what an expired one answers. Export it first:
>
> ```
> export SUPABASE_ACCESS_TOKEN=$(grep ^SUPABASE_ACCESS_TOKEN= .env | cut -d= -f2-)
> npx supabase projects list        # NOW it is a token test
> ```
>
> **Only call the token expired if it still fails after that.** It genuinely has
> expired twice (2026-09-11, 2026-09-14), so both causes are real — but telling
> the owner a live credential is dead sends them to a dashboard for nothing. Same
> shape as the AxisCare rule: rule out the version header before blaming the
> token.
>
> A genuinely expired token fails late and confusingly on a deploy — the upload
> starts, then `unexpected deploy status 401`. Only Mitch can mint a replacement
> (Supabase dashboard → Account → Access Tokens).

> **The "not deployed" message had to be fixed to say so.** Supabase answers a
> missing function with perfectly valid JSON — `{"code":"NOT_FOUND","message":
> "Requested function was not found"}` — which has **no `error` key**, so the
> module's generic `body.error || 'HTTP '+status` reported a bare *"HTTP 404"*
> and buried the only useful sentence. The 404 test now runs first and does not
> depend on the body parsing. Reported by the desk off the Communication Logs
> card; the diagnostic had been written for exactly this case and sat in a
> branch that could never run for it.

This is worth knowing before diagnosing anything: **a Quo fix can look
deployed and not be.** Netlify going green says nothing about this function.

### Read-only — EXCEPT `action=send`, added 2026-09-14

AxisCare's API is a read API — if its token leaked, a stranger could read.
**Quo's API can act.** Roughly half its ~45 endpoints mutate:

```
POST   /v1/messages               sends a real text, from a real agency
                                  number, to a real person, billed to the
                                  agency. Returns 202, and it is irreversible.
DELETE /v1/contacts/{id}          deletes a contact
PATCH  /v1/contacts/{id}          a destructive REPLACE, not a merge — omitted
                                  emails/phoneNumbers/customFields are deleted
POST   /v1/tasks/{id}/complete    and a dozen more state changes
```

Until 2026-09-14 the **method gate** was the whole security argument of
`supabase/functions/quo/index.ts`: GET in, GET out, no reachable path to a
mutation. That is no longer literally true, and the honest statement is
narrower:

> The proxy accepts **GET, plus POST for exactly one action — `send`** — and
> `send` is the only mutation it can perform. It still cannot delete a
> contact, patch a contact, complete a task or mark a conversation read, and
> no parameter makes it able to.

**This section used to say "Claude: do not add a POST branch… wiring one
starts with that conversation." That conversation happened.** Mitch asked for
texting from Find Coverage on 2026-09-14, the guards below were described and
agreed *before* any code was written, and the backstop he named is real: the
API key can be deleted in Quo at any moment, which stops everything instantly.

It is worth being precise about what was decided, because the next request
will be the second mutation and that is **a new decision, not a precedent**:

- what was agreed is *sending a text to a caregiver already on the roster*
- the four guards are the terms it was agreed on, not implementation detail
- nothing about PHI, the missing login, or the billing exposure changed; they
  were weighed and accepted for this one capability

#### The four guards, and which ones actually matter

The dashboard has **no login**, the function is deployed `--no-verify-jwt`, and
CORS is enforced by browsers and does nothing against `curl`. So anyone who
learns the URL can reach this endpoint. Two of the four guards are real
protection and two are blast-radius limits:

| | Guard | What it buys |
|---|---|---|
| **1** | **The destination must be on the active AxisCare roster** | The one that matters. Turns "a stranger can text anyone on earth from the agency's number" into "a stranger could annoy our own caregivers". |
| **2** | **`from` must be one of our real Quo lines**, matched against live `/v1/phone-numbers` | The browser picks *which* line; it cannot invent one and cannot spoof a number the agency does not own. |
| 3 | A hard hourly cap (`SEND_HOURLY_CAP`, 200) | Per isolate, so a brake rather than a guarantee — the same honest limit `devi-agent`'s rate limiter has. Bounds the worst case. |
| 4 | `SEND_MAX_RECIPIENTS` 25, `SEND_MAX_CHARS` 1600 | One request cannot become a bulk campaign. |

**Guard 1 fails CLOSED and must stay that way.** If the roster cannot be read,
or comes back empty, or comes back *truncated*, the send is refused and
nothing is cached. An incomplete allowlist refuses caregivers who really are
on the roster — annoying, and the safe direction; caching one would make that
wrongness last ten minutes instead of one request.

> **The roster is read through the app's own PUBLIC Netlify AxisCare proxy**
> (`QUO_ROSTER_URL`), not through a second copy of the AxisCare token. That
> endpoint is already world-readable, which is exactly why it can be used here
> without duplicating a secret into Supabase. If `QUO_ROSTER_URL` is unset,
> **sending is refused entirely** — the safe path is the default, not a
> fallback.

Measured against the live account 2026-09-14: **1 request, 1.45s, 183 active
caregivers, 188 distinct E.164 numbers, and every active caregiver has at
least one usable number.** All three of `mobilePhone`, `homePhone` and
`otherPhone` are collected, because `c.phone` in the browser collapses to
`mobilePhone || homePhone || otherPhone` and the scheduler may well be texting
the one AxisCare lists second.

> **`nextPage` is a FULL URL, not a bare id.** AxisCare answers
> `https://7060.axiscare.com/api/caregivers?statuses=Active&startAfterId=37&limit=3`,
> so passing it straight back as `startAfterId` reads page one forever — and
> the proxy would then have "verified" the whole roster against its first 200
> names. `index.html` carries `axPageCursor` for exactly this reason, with a
> comment recording that it already truncated the roster once. `rosterCursor()`
> in the Edge Function is the same rule. This was written wrong first and
> caught by testing against the live proxy rather than by reading.

#### Four things an adversarial review found, all now guarded

Reviewed 2026-09-14, before the first deploy, by a fan-out of reviewers whose
findings were each put to a separate verifier trying to refute them. 28 raised,
12 survived. The four worth knowing about:

- **A recipient's NAME could inflate the message past every length check.**
  `personalise()` used `String.replace` with a **string** replacement, and a
  string replacement honours `$&`, `` $` `` and `$'` as substitution patterns —
  `$'` re-inserts everything *after* the match. Measured on this function: a
  1,524-character template (under the 1,600 limit) plus a 10,000-character name
  of repeated `$'` produced a **7.5 million character** body, roughly 49,000
  billable SMS segments, from one request that passed every guard.

  Three fixes, and all three are needed. The replacement is now a **function**
  (never scanned for `$` patterns), the first name is **capped at 40
  characters**, and the length is **re-measured after substitution** — the
  original check ran on the template, which is not the string that gets sent.

  > It also misfired with no attacker at all: a caregiver whose first name
  > contained a `$` would have had their own message quietly mangled.
  > `personalise("Hi {name}, shift open.", "Jo$'seph")` returned
  > *"Hi Jo, shift open.seph, shift open."*

- **A tick could outlive the shift it was made on.** `covSelBar()` *counted*
  the ticks in the queue on screen, while the button *opened* on every tick in
  the tab. Tick four caregivers for Brenda Janowski, move to Ziad Niazi, tick
  one more, and the bar read **Text 1** while the composer opened with **five**
  — and the draft is built from the *current* query, so four people would have
  received a real, irreversible text about a client, date and time they were
  never considered for.

  Closed at both doors: the bar now derives **one** list and hands it to the
  button (`openCoverageTextSel(ids)` takes the list rather than re-deriving
  it), and `seedQueryFromShift()` clears `state.covSel` whenever the shift
  changes. **Claude: do not "simplify" the button back to a no-argument call.**
  A label that disagrees with what the button does is how the wrong person gets
  texted.

  > The same root cause caught anyone already rung: the queue drops contacted
  > caregivers, but their tick stayed in `state.covSel`, so a bulk send reached
  > people with no row on screen to show it.

- **The rate limiter never drained.** It pushed the timestamp *before*
  comparing, so a caller who kept hammering after a 429 kept topping the window
  up — one burst latched the proxy shut for a full hour, and a client that
  retries on 429 (the natural thing to write) held itself out indefinitely.
  Only an **allowed** request is counted now.

  `RATE_MAX` also moved **120 → 720**, because 120 was arithmetic nobody had
  done: one Communication Logs card is 24 requests, so the old ceiling was
  **five caregiver profiles an hour** per scheduler, and the failure surfaced
  as an unexplained error on the card. This is not the control on sending —
  `SEND_HOURLY_CAP` and the roster allowlist are.

- **A stuck roster cursor was recorded as a complete read.** If AxisCare kept
  claiming a next page while returning nothing new, the sweep called the roster
  complete and cached a partial allowlist for ten minutes. `index.html`'s
  `fetchClients` treats a stuck cursor as "done", which is right for a list and
  wrong here: this one decides **who may be texted**. It now refuses.

Smaller ones from the same pass: an empty `/v1/phone-numbers` result is no
longer cached for ten minutes (it would disable sending with an empty
dropdown); a failed *send* gets send-specific advice instead of the read
routes' *"maxResults is REQUIRED"* hint, which was advice about a call nobody
made attached to a message that never arrived; removing recipients down to one
rebuilds the draft so no literal `{name}` is left on screen, **unless the
scheduler has edited it**, in which case their words stand.

#### Test mode is STRICTER here than in the old app

The old Scheduling app let a scheduler type any number as the test
destination. This one requires it to be **one of the agency's own Quo lines**
— otherwise "test mode" is just an unrestricted send-to-anywhere with a
friendlier label. A line may not text itself, and **the roster check still
reads the caregiver's number, never the test destination**, so test mode
cannot be used to reach somebody off-roster.

#### A send is never retried

`callQuo()` retries a 429 and a 5xx, which is right for a read and wrong for a
send: a request that timed out or 502'd **may well have reached Quo**, and
retrying it texts the caregiver twice. `sendOne()` therefore deliberately does
not use `callQuo` — one attempt, and the per-recipient result says honestly
that it is unknown ("this one may or may not have been sent").

For the same reason the endpoint answers **200 with per-recipient verdicts**
even when some failed, rather than a 4xx/5xx for the batch. A partial send is
a normal outcome the scheduler has to *see*; a status code that invites a
blind retry would text the people who already got it a second time.

#### `to` carries exactly one number, always

Quo accepts `to` as an array, and a multi-element array creates a **group
thread where every caregiver sees every other caregiver's number**. That is a
different feature and nobody asked for it. The Edge Function loops and POSTs
once per recipient, so ticking six caregivers sends six private messages.

Verified 2026-09-14: **78 tests against the real handler**, Quo and AxisCare
both stubbed so nothing was sent and nothing was billed. Every non-GET verb
except `POST ?action=send` is refused 405; `send` over GET is refused (a GET
lands in browser history, a prefetch and a crawler queue, and none of those may
cost money); an off-roster number, an unreachable roster, an empty roster and a
truncated roster all refuse; test mode cannot reach an off-roster number; and a
5xx send is attempted exactly once.

### The key has no scopes

One key does everything — the same value that lists messages can send them and
delete contacts. There is no read-only key to issue instead. That is precisely
why the boundary has to live in our code rather than in the credential, and
why the gate has to be narrow and explicit. It is now "GET, plus `send`",
and that list is the whole boundary — see above.

Generated in Quo under **workspace settings → API**. Needs workspace Owner or
Admin rights, and the key *name* may not contain spaces.

### Authentication — no Bearer prefix, but it tolerates one

```
Authorization: <the key>
```

The raw key. Quo's docs say plainly *"The Quo API does not use a Bearer token
for authentication."*

**Measured 2026-09-11: `Bearer <key>` also returns 200.** Quo appears to strip
the prefix, so this is more forgiving than the docs suggest and code copied
from the AxisCare proxy would not actually break here. We send the documented
raw form anyway — relying on undocumented leniency is how a working
integration breaks during somebody else's refactor.

There is **no version header**, and that is one place Quo is kinder than
AxisCare: the version is in the path (`/v1/...`). The
`X-AxisCare-Api-Version` trap — a wrong version returning 400 *before* auth is
checked, masking every other error — has no equivalent here. Do not invent a
`QUO_API_VERSION`.

> The beta **webhooks** surface is the exception: it pins a payload version
> with a `Quo-Api-Version` header at subscription time. Not used today.

### `maxResults` is REQUIRED on the list routes, despite documenting a default

This is the trap that will cost somebody an afternoon, because the docs show a
default of 10 and the API rejects the call without it anyway — and the 400
reads like a bug in our proxy.

| Route | Required query params |
|---|---|
| `/v1/messages` | `phoneNumberId` (`PN…`), `participants`, `maxResults` |
| `/v1/calls` | `phoneNumberId`, `participants` — **exactly one**, 1:1 only — `maxResults` |
| `/v1/conversations` | `maxResults` |
| `/v1/contacts` | `maxResults`, capped at **50** here, not 100 |
| `/v1/phone-numbers` | none, and **not paginated** — no `maxResults`, no cursor |
| `/v1/users` | none |

`phoneNumberId` comes from `/v1/phone-numbers`, which is what `ping` reads.
Paging is `pageToken`, never a page number; `since` is deprecated in favour of
`createdAfter` / `createdBefore`.

#### An array is a REPEATED parameter, and `name[]` is a silent trap

**This is the `caregiverIds` trap again, in a different API.** Measured
against the live account 2026-09-11:

```
?phoneNumbers=PN0T9aATba      25 rows, ALL from that one inbox
?phoneNumbers[]=PN0T9aATba    25 rows from SIX different inboxes — HTTP 200,
                              filter silently ignored, byte-identical to
                              sending no filter at all
?participants[]=%2B1805…      HTTP 400 "Expected array"
```

So `[]` either fails loudly or, far worse, succeeds while doing nothing. The
correct form everywhere is plain repetition:

```
participants=%2B18055551234&participants=%2B18055559999
```

The **`+` must be percent-encoded as `%2B`** — a raw `+` in a query string
decodes to a space, which is a different phone number and not an error.

The proxy uses `params.append`, never `params.set`, for the same reason: `set`
would keep only the last of a repeated parameter and turn a group lookup into
a one-person lookup with no error anywhere.

> `participants` on `/v1/conversations` is **also silently ignored** — a
> number with no conversations returns the same 50 rows as no filter. There is
> no way to find one person's conversations across lines in a single call,
> which is why the card queries per inbox.

Other limits worth knowing: **10 requests per second per API key**, shared by
everything pointed at that key, `429` on exceeding it. Phone numbers are E.164
everywhere (`+18053127736`).

> **Corrected 2026-09-11. Call summaries and transcripts DO work on this
> account.** This paragraph used to say they were "Business/Scale plans only
> and answer `403` otherwise" — which came from reading Quo's docs and was
> never tested here. Measured against the live key, all three answer **200**:
>
> ```
> GET /v1/call-summaries/{callId}    {callId, summary[], nextSteps[], status, jobs}
> GET /v1/call-transcripts/{id}      {callId, dialogue[], duration, status, createdAt}
> GET /v1/call-recordings/{callId}   an array, empty on this account
> ```
>
> And the summaries are real: **14 of 14** answered calls longer than 45
> seconds came back `status: "completed"` with bullets and next steps. The
> Communication Logs detail pane is built on them — see below. A short call
> genuinely has nothing to say and Quo returns the sentence *"This call had no
> actionable details to summarize."*, which is an answer rather than an error.
>
> The lesson is the repo's own first rule: **check what the data actually
> does before writing it down.** A documented limitation that is not real is
> as expensive as an invented field — it stopped a working feature from being
> built for half a day.

**404 is ambiguous and is not laundered into success.** AxisCare returns 404
for an empty `/api/visits` and `openshifts-sync` treats that as empty. Quo's
behaviour on an empty list is **undocumented** — do not copy that reflex here.
The proxy returns the 404 with Quo's body intact.

### The secrets

These are **Supabase** project secrets (Project Settings → Edge Functions →
Secrets), not Netlify environment variables. Only the first is required; the
last is shared with `devi-agent` and already exists.

| Name | Required | Default |
|---|---|---|
| `QUO_API_KEY` | **yes** | — |
| `QUO_API_BASE` | no | `https://api.quo.com` — no trailing slash, and **no `/v1`**; every allowlisted path already starts `/v1/`, and doubling it gives `/v1/v1/…` and a 404 |
| `QUO_ALLOWED_PATHS` | no | the built-in read-only list |
| `QUO_ROSTER_URL` | **for texting** | unset — and **sending is refused while it is unset**. Point it at the app's own public Netlify AxisCare proxy: `https://<site>.netlify.app/.netlify/functions/axiscare` (no trailing slash, no query string). It needs no AxisCare token of its own because that endpoint is already public |
| `QUO_SHARED_SECRET` | no | unset |
| `ALLOWED_ORIGIN` | — | **reused from `devi-agent`**, not a new variable |

**`QUO_SHARED_SECRET` buys less than it looks like it does, and it is worth
being honest about.** CORS is enforced by the browser, not the server, so
`ALLOWED_ORIGIN` stops another *website* reading replies in a visitor's
browser and does nothing whatever about curl. Deployed `--no-verify-jwt`, this
endpoint is reachable by anyone who knows the URL. But the dashboard has no
login, so any secret the *browser* would have to send would ship in
`config.js` and be public too. It is real protection only for a
server-to-server caller. It is supported, and it is not a substitute for the
method gate or, on the send path, for the roster allowlist.

> **Since 2026-09-14 this endpoint can spend money**, which raises the stakes
> on the paragraph above without changing a word of it. The answer is not a
> browser secret (there is nowhere to keep one); it is that a send can only
> reach a number already on the active AxisCare roster, and that the API key
> can be deleted in Quo at any moment.

What this endpoint reads back — message bodies, call transcripts, client
contact details — is **materially more sensitive than the roster**. That is
not a new decision (the no-login posture is reviewed and accepted, see
*Known and accepted*), but it is a larger surface than AxisCare's, and it
should be weighed before the allowlist is widened or a feature is built.

### Communication Logs — the caregiver card, live from Quo

Added 2026-09-11, replacing the **Call Log** card on the Caregiver Overview.

`CGCOMMS` fetches; `cgCommsPanel` draws. Both are live — there is **no table,
no sync job and nothing scheduled.** Opening a profile asks Quo, exactly as
opening one asks AxisCare for the calendar.

#### It sweeps EVERY line, and that is measured, not a preference

Measured against the live account over the 600 most recent conversations:

| Line | Caregiver conversations |
|---|---|
| Scheduling Department | 110 |
| Recruitment | 43 |
| Client Support | 30 |
| Client Inquiry | 9 |
| the other 8 lines | **0** |

**111 of 181 caregivers appear.** A Scheduling-only card — which is what was
first asked for — would have been missing 82 conversations, most of them
Recruitment, which is exactly where a new caregiver's first contact lives.

There are **12 inboxes on the account, not the 4** the Quo connector shows a
signed-in user. The API key sees Finance, Billing, CEO Direct and Marketing
too. `lineList()` reads `/v1/phone-numbers` once per session, so a new line
appears on the next reload with nobody editing `index.html`.

> **No secret names the line.** An earlier plan had `QUO_SCHEDULING_INBOX_ID`
> and it is not used by anything — the sweep discovers the lines instead. If
> the desk ever wants to restrict it (the four lines above would cut the sweep
> from 24 requests to 8), that is a constant in `CGCOMMS`, not an env var.

#### Cost, and why it is still a live fetch

| | |
|---|---|
| requests, per caregiver | 12 lines × 2 (messages + calls) = **24** |
| plus, once per session | `/v1/phone-numbers` + `/v1/users`, both cached in the module |
| typical | **2.3s** (light caregiver) |
| measured worst seen | **4.2s** — Edna Arma, 110 items, 78 entries |
| concurrency | **4** |

So the first profile opened in a session costs 26 requests and every one after
it 24. `lineList()` and `userList()` each resolve once and are shared by every
caregiver; `userList()` deliberately **never rejects** — it degrades to an
empty map — so a failure there costs the staff names and not the sweep.

`CONC` is 4 because Quo's ceiling is **10 requests a second for the whole API
key**, and all three schedulers share that key because they share the function.
Measured: 24 requests at concurrency 5 ran at 10.6 req/s and took **four 429s**.
The Edge Function retries a 429 with backoff on top of this. Both halves are
needed — the pool keeps one browser polite, the retry covers two browsers
colliding.

The card paints "Reading calls and texts from Quo…" first and fills in when the
sweep lands, so nobody is blocked. Cached per caregiver for the session.

#### `toE164()` is deliberately strict, and that is the safety property

AxisCare gives one phone string per caregiver, collapsed from
`mobilePhone || homePhone || otherPhone`. Measured across the 183 active
caregivers: **182 have a number, every one in the single format
`999-999-9999`**, and one has none at all.

So the normaliser accepts the shape the data actually has, tolerates a leading
`1`/`+1`, and returns **null** for everything else — including extensions and
non-NANP numbers. It also rejects an area code or exchange starting `0` or `1`,
which a bare ten-digit length test would wave through.

**A loose match here would show one caregiver ANOTHER caregiver's private
messages.** That is the worst thing this card could do, so there is no fuzzy
matching, no last-7-digits fallback, and no "close enough". Null just means the
card says it cannot look them up.

**Nothing is written back onto `c`.** The E.164 form is derived on demand and
never assigned to the caregiver record — `c.phone` rides the `caregivers` CLOUD
slice, so normalising in place would diff into the shared overlay and replay for
all three schedulers. Same hazard as everywhere else in *Don't break these*.

#### Nothing goes into `state`

`CGCOMMS` keeps its cache in the module, for the same reason `CGVISITS` does: a
few hundred messages in a tracked CLOUD slice would be written to Supabase as
though a scheduler had typed them. That is the 323KB overlay bug arriving
through a new door.

#### What replaced what

The old card was **derived from `state.contactLog`** — a scheduler's own note
that they had rung somebody about an open shift. Its comment was right at the
time: direction is always outgoing, and no call duration is recorded anywhere,
so neither was shown rather than invented. Quo has all three, plus the inbound
half the desk never logged.

**The whole database held exactly ONE hand-logged entry** (2026-08-23,
"accepted", one caregiver), so nothing of substance was displaced.
`state.contactLog` is **untouched** — still written on the assign path, still
read by the coverage screens. It is only no longer the source of this card.

#### The shape is borrowed from the old Scheduling app, on purpose

Redesigned 2026-09-11 after the first version was reported as ugly. The first
attempt was a flat list whose most prominent slot held one long dot-separated
meta line — `Sep 10 · 1:52 PM · Outgoing · 2 messages · Scheduling Department`
— which wrapped, and repeated "Scheduling Department" down the entire column.

**ONE row shape now serves the card and the modal's rail**, so moving from one
to the other is continuous rather than a different screen. It is the old app's
rail row: glyph · bold heading · timestamp pushed right · a two-line gist
underneath.

```
(○) Ruffa    Scheduling Department              Sep 10 · 1:52 PM
    “Good afternoon! We're currently updating our caregiver profiles…”
```

**The bold slot holds WHO AT THE OFFICE handled it, not the line.** That is the
old app's choice and it was right: the line is usually the same word repeated,
while "Ruffa" and "Marivic" vary and are what a scheduler scans for. Resolved
through `/v1/users` — Quo stamps `userId` on anything the desk sent and leaves
it null on an inbound message, so a row with no staff falls back to the
caregiver's own first name, which correctly marks the entries **they** started.
**Corrected 2026-09-15 — `userId` may not be the person who took the call.**
This used to say `answeredBy` and `initiatedBy` were null on every call measured
and that `userId` was the only field carrying a person. Over 226 calls on the
Scheduling, Recruitment and Client Support lines, `userId` is set on all of
them and `initiatedBy` on none, but `answeredBy` is set on 65 — 60 of them a
workspace member — and on **54 of those 60 it names somebody other than
`userId`**. In 9 of the 20 transcripts that stamp speakers, the office person
who spoke most was not `userId` either.

So the rail's `userId || answeredBy || initiatedBy` very likely names the wrong
member of staff on a real share of calls. *Summary by Devi* names who spoke
instead. **The rail is unchanged**: which field it should trust is a decision,
not a typo, and `answeredBy` is absent on most calls.

The line name stays, quietly, in `--ink-faint` beside the name — "Recruitment"
among a run of "Scheduling" is exactly what you want to catch.

The gist names the sender of the last message (`Edna: "Yes I can do Tuesday"`
says she replied; no prefix means the heading already said who spoke last).

#### View Details is master / detail, not a longer list

A **330px** scrolling rail of the same rows against a detail pane, following
the old app's `.chlog-modal` — which was a 288px rail in an 860px dialog.

**This modal is `min(875px, 94vw)` where the other three expanded cards are a
flat `.mwide`.** It is the only one that is master *and* detail rather than a
single column, so it has two things to fit.

**The `min()` is doing two different jobs, and only one of them is a size
choice.** 875px is what Mitch settled on after seeing 1340 and finding it too
big — a dialog taking most of a monitor to show one phone thread. `94vw` is not
a second opinion about width, it is the **fit-to-screen guard**: below a ~931px
window the fixed number would overflow, and the vw takes over. Measured across
viewports: 1600 → 875, 1280 → 875, 931 → 875, 900 → 846, 720 → 677.
**Change the px; leave the vw alone.**

The bubbles cap separately at `min(80%, 560px)`, which at this dialog resolves
to 377px — the 560 only bites if the dialog is ever widened again.

##### The 330px rail is the measured floor, not a guess

Swept in Chromium at the 875px dialog (839px of split), against the longest
staff list that actually occurs — three first names:

| rail | detail | bubble | clips |
|---|---|---|---|
| 300 | 537 | 401 | "Deprise, Kristine, Marivic" |
| 316 | 521 | 388 | "Deprise, Kristine, Marivic" |
| **330** | **507** | **377** | **none** |
| 372 | 465 | 343 | none |

330 is the smallest rail that still shows a real staff list in full, so the
conversation keeps everything else. Under it names start being eaten; over it
width is taken from the messages for no gain. Re-run the sweep if the rail row
ever grows a fourth element.

It gets there through its own **`.mcomms`** class, added in `openCgAll`,
**re-asserted in `renderCgAllModal`** so a re-render from `cmPick` cannot lose
it, and removed in `closeModal` beside `mwide`. `renderCgAllModal` also
*removes* it for any other `which`, so switching card type in place cannot
leave a Notes modal oversized. Nine assertions cover that lifecycle, including
"open Comms, close, open Notes" — the leak that scoping exists to prevent.

##### `.mwide` IS 680px, NOT 880 — there is an `!important` you cannot see

**Every wide modal in this app is 680px**, and `.modal.mwide{max-width:880px}`
has been dead for as long as this has been true:

```
.mwide{max-width:680px!important}
```

It sits ~70,000 characters further down the stylesheet, wedged between
`.qs-customtog` and `.rv-grid`, with no comment. Nothing in the 880 rule hints
that it is overridden.

This is why the first two attempts at widening this dialog **changed nothing on
screen** while looking correct in the source. Measured in Chromium: plain 460,
`mwide` 680, and `.mcomms` also 680 until it was marked `!important` too. An
`!important` can only be outranked by another, and `.modal.mwide.mcomms`
(0,3,0) beats `.mwide` (0,1,0) — so the scoped rule wins and nothing else
moves.

> **Do not "clean this up" by deleting the bare rule.** It would resize every
> wide modal in the app at once — Notes, Client Feedback, Client Complaint, the form studio,
> the history sheets — which is a far bigger change than any one card should
> make. If the 680 is wrong, that is its own decision, taken deliberately and
> looked at everywhere.

##### The row's shrink factors are load-bearing

`.cm-lineq` is `flex:0 **100** auto`, not `0 1 auto`. Flex shrinks each item in
proportion to *factor × base width*, so with both at 1 the **name** — the wider
of the two — gave up more than the agency line and ellipsised first: exactly
backwards, since the name is the thing being scanned for. Measured: "Jenn,
Ruffa, Marivic" was still clipped at a 340px rail until the factor was raised.
At 100 the line collapses almost entirely before the name loses a character,
and the full line name stays in the `title`.

`cmLine()` also strips the category suffix — "Scheduling Department" renders as
"Scheduling" — because on a row that carries a name, a line and a timestamp,
those eleven characters come straight out of the name. The detail pane still
shows the full value under *Agency line*.

The detail pane is **one heading, one quiet meta line, then the content** — with
the *Summary by Devi* card above the heading on an answered call or a text day
(see *Summary by Devi* below).

> **The grey facts box is gone (2026-09-11).** It held direction, outcome,
> duration, agency line and who handled it in a boxed `<dl>` — every one of
> which is already on the rail row the scheduler just clicked, so it was
> furniture around a repeat. Reported as "redundant information"; removed, and
> the same facts now run as one dot-joined line under the heading, the grammar
> the rest of this card uses. `cmFact()` and `.cm-facts` went with it. **Do
> not put the box back.**

- **A text day** shows the whole thread directly, with **no heading over it**.
  The old app folded its thread behind "View messages" because its pane led
  with an AI summary; here the messages *are* the content. A "MESSAGES" label
  over the only thing in the pane tells the reader nothing, so it went too.
- **A call** shows **Quo's own summary**, fetched on demand. This is the
  reason the endpoint correction above matters: a call has no text to read, so
  before it the pane simply ended after the facts.

##### The call summary is lazy, one request, and labelled as Quo's

`CGCOMMS.loadSummary(callId)` fires the first time a call is opened, caches by
call id for the session, and re-renders the dialog when it lands. **Not during
the sweep:** a caregiver has ~50 calls, and fetching every summary up front
would be 50 more requests against a 10/s ceiling for content nobody asked to
see.

Four states, and three of them are not failures: `loading`, `ready` (bullets,
plus a *Next steps* list when Quo produced one), **`none`** — Quo's own
"This call had no actionable details to summarize.", shown as *"Quo found
nothing to summarise on this call."* — and `error`.

It carries a **"from Quo"** label. The text is machine-written and a scheduler
should know that before acting on it; the old app put an "AI Summary" chip on
its equivalent block for the same reason.

##### Quo 404s when a call has no summary — that is NOT an outage

Measured on Alejandra Gibbs: **4 of 14** calls answer `404` from
`/v1/call-summaries`, every one of them short or unanswered. Quo has no summary
row for those and says so with a status code rather than an empty body.

Two things had to learn the difference:

- `loadSummary` maps a **404 to `none`**, not `error` — *"Quo found nothing to
  summarise on this call."* A red diagnostic on an ordinary 31-second call is
  worse than no summary at all.
- The `Quo` module's 404 branch now checks **whose 404 it is.** Our proxy
  forwards Quo's status verbatim inside its own envelope
  (`{ok:false, status:404, error}`), while the Supabase gateway answers a
  missing function with `{code:"NOT_FOUND", message}` and no `ok`. Testing the
  status alone told the desk *"The Quo function is not deployed… npx supabase
  functions deploy quo"* **while the function was serving that very request**.
  Reported from a screenshot, 2026-09-11.

> Both halves were introduced by the fix that made 404 say something useful.
> The lesson is narrow and worth keeping: once a proxy forwards upstream
> statuses, a status code alone no longer identifies who answered.

##### The detail meta line does NOT repeat the rail row

`Sep 10 · 3:15 PM · 1 day ago · Outgoing · 31 sec` — and deliberately **not**
the agency line or the staff name. Both are already bold at the top of the row
the scheduler clicked to get here, so repeating them two inches to the right is
the same redundancy the grey box was removed for. What is left is what the row
does *not* say: exactly when, how long ago, and how the call went.

##### `renderCgAllModal` preserves the rail and detail scroll positions

It replaces `innerHTML` wholesale, so every pane inside is destroyed and
recreated at `scrollTop` 0. Clicking a row near the bottom of a 78-row rail
therefore threw the list back to the top and scrolled the chosen row out of
sight — the one thing a master/detail must not do — and the summary landing a
second later did it again. Read before, restore after, guarded so a fresh open
still starts at the top and the other three cards (which have no rail) are
untouched.

##### The call icon carries direction

`callout` and `callin` — a handset with an arrow pointing away or back. Added
to `I` beside `chat`. Direction stops being a word to parse in the meta line
and becomes something the eye catches scanning the rail. A text entry keeps the
neutral `chat` bubble, because a day's thread can legitimately run both ways.

#### The thread IS chat bubbles — reversed on purpose, 2026-09-11

The old app deliberately avoided bubbles, and the first version here followed
it: a flat run with a 2px left accent for direction. **Mitch asked for
"messenger vibes" having seen both**, so this is a decision rather than drift.
Do not quietly revert it to the old app's shape on the grounds that the old app
did it differently — that is the question that was already asked and answered.

Caregiver left, the desk right; the attribution (`Ruffa · 8:31 AM`) sits
*under* the bubble, the way a messenger app does it — the bubble is what you
read, the attribution is what you check. `white-space:pre-wrap` keeps the line
breaks people actually typed, because a shift offer laid out over three lines
is unreadable reflowed into a paragraph.

**An undelivered text gets a red bubble and "Not delivered" in its caption.**
Worth more than it sounds: on the live account one caregiver's thread shows the
same CARE GOALS message sent twice at 3:00 PM, both undelivered, before a third
attempt got through at 3:01 — which the sender had no way of knowing at the
time.

**The RAIL stays a flat list.** Bubbles are for reading one conversation, not
for scanning fifty.

`cmSel` holds which entry the modal is showing. It is module-level and keyed by
caregiver, **not** in `state`: it is one person's cursor inside one open dialog,
and a slice would share it with the other two schedulers on the next poll.

#### The card leads with the one fact worth a glance

`Last contact 21 hours ago · 50 calls · 60 texts`, then as many rows as fit.
"When did we last reach them" is the question the Overview is actually being
asked; the exact stamp is still on every row. The card clips at 260px like its
neighbours and `pfxFit()` raises *View Details* — no scrollbar inside the card,
so it stays consistent with Notes, Client Feedback and Client Complaint.

#### Three layout rules that each fixed a reported wart (2026-09-11)

All three look like tidying and are not. Reported from screenshots of the live
card.

- **Row separators are a TOP border on every row but the first, never a bottom
  border.** The card clips at a fixed height, so the row that is *visually*
  last is almost never `:last-child` and CSS cannot reach it — a bottom border
  left a stray hairline hanging a few pixels above the *View Details*
  separator. Drawn as a top border the trailing line cannot exist, in the card
  or at the foot of the modal rail.
- **`cmFit()` trims the card list to a WHOLE number of rows, and it must run
  AFTER `pfxFit()`.** Whichever row the 260px clip landed in was being sliced
  through its text, leaving a sliver of letters that reads as broken.

  > A bottom fade was tried first and **made it worse** — a gradient over text
  > that is perfectly readable reads as broken rather than as "there is more".
  > Removed the same day. Do not reintroduce it: cutting on a row boundary
  > means there is no partial row to disguise.

  The ordering is the whole trick. `pfxFit()` decides whether *View Details*
  appears by measuring the **full** list against the body; capping first would
  make the content fit and the button would vanish along with the only way to
  reach the other 46 entries. Measured first, trimmed second.

  This is why **the gist is clamped to one line in the card** (two in the
  rail, which has room): uniform row height is what makes one measurement
  answer for every row. Every guard in `cmFit` — no rows, zero height, nothing
  laid out yet, they all already fit — leaves the card exactly as it was, so
  the worst case is the old clipping rather than a broken card.

  The cap is `n*rowH − 1`. Row heights are fractional and the **next** row's
  top border begins exactly at `n*rowH`, which on a fractional device-pixel
  ratio can round back into view as the stray hairline this exists to remove.
  The cost is 1px off the last row's 9px of bottom padding.

- **`.pfx-more` loses its `border-top` on this card, and only this card.**
  That rule separates *View Details* from the body, which is right on Notes,
  Client Feedback and Client Complaint — they run text straight into the
  footer. This card
  already ends in its own row separators and sits just above the card's own
  bottom edge, so the rule read as two hairlines a few pixels apart.

  It is cleared in `cmFit` rather than in CSS so it cannot depend on `:has()`,
  and **before** the guards, so a card that cannot be measured still loses the
  rule. `document.querySelectorAll('.ws-card.pfx .cm-list')` is what scopes
  it — no card without a `.cm-list` is ever touched.
- **`.cm-split` is `calc(62vh - 148px)`, not a round `vh`.** The expanded card
  sits inside `.mb`, which is `max-height:62vh; overflow:auto`. A split taller
  than that minus the chrome above it put a **third** scrollbar on the outside
  of the dialog, so the rail was scrolling inside a pane that was itself
  scrolling. The 148px is `.mb` padding (32) + `.ws-card` padding and border
  (32) + the tinted header (~34) + the summary strip (~31), rounded up so a
  rounding error costs a few blank pixels rather than bringing the outer
  scrollbar back. **If the summary strip or the header changes height, this
  number has to move with it.**

#### It shows unanswered calls and undelivered texts — the old app hid them

This is a **deliberate divergence**. The old app filtered them out on Mitch's
own instruction (Jul 10: *"should not show calls without responses, inbound or
outbound"*), in a card that was about client conversation summaries.

Here the log is for a scheduling desk, where "we rang her three times and she
never picked up" is the point rather than noise. Measured in a 14-caregiver
sample: **30 of 271 calls went unanswered** (12 `no-answer`, and 18 `completed`
that nonetheless carry no `answeredAt`), and **9 of 314 texts were
`undelivered`** — a shift offer that never arrived, which the sender had no way
to know. Undelivered reads in `--crit-tx`.

`answeredAt` is the only reliable mark. A call can read `completed` and still
never have been picked up, so status alone is not enough.

#### Timestamps are pinned to US/Pacific

Quo stamps UTC. The agency and every visit are in Ventura County, so the log is
formatted with an explicit `America/Los_Angeles`, and the **text-day grouping
uses Pacific days too**. A scheduler on a laptop set to UTC would otherwise see
yesterday evening's texts filed under today, and the day buckets would split in
the wrong place. The old app pinned Pacific for the same reason, and CLAUDE.md
already records this class of bug biting the care-notes sync and the caregiver
calendar.

#### Six states, and three of them must never read as "no communications"

`nophone` / `idle` / `loading` / `error` / partial / ready. A caregiver we could
not look up and a caregiver with a genuinely empty log are different facts, and
only one of them is "No calls or texts with this caregiver on any agency line."

A **partial** sweep — some lines answered, some did not — says so above the list
and offers Retry, rather than passing a short list off as the whole log. If
*every* read fails, that is an error, not an empty log: reporting it as "nothing
on file" would be a confident lie about a caregiver we learned nothing about.

#### Message text goes through `escText()`, never `esc()`

`esc()` replaces `"` and nothing else — it is an attribute escaper, useless in a
text position. Message bodies are arbitrary text typed by real people and land
in `innerHTML`. This is the same trap the Devi reply path hit; see *Three traps*
under Ask Devi.

### Summary by Devi — one or two sentences on top of a conversation

Added 2026-09-15. The Communication Logs dialog shows a short summary **above
the heading** of whichever call or text day is open, labelled *Summary by
Devi* so nobody mistakes it for Quo's. **Quo's own call summary stays exactly
where it was, underneath**, so the two can be compared; that was the decision,
not an oversight. The rail rows are unchanged.

`supabase/functions/comms-summary` writes it with Claude. `CGCOMMS.loadDevi()`
asks for it, `cmDevi()` draws it, and `cmDetail()` puts it above the heading.
The model has **no tools**, the same argument as `devi-agent`: it reads a
conversation and returns text, and the only thing that text reaches is its own
summary row.

#### Written once, when opened — never swept

A summary is written the first time **anybody** opens that conversation and
saved in `public.comm_summaries`. Every later open, by anybody, reads the saved
row. A conversation nobody opens is never summarised.

| | key | rewritten when |
|---|---|---|
| a call | `call:<callId>` | never, unless the model or prompt changes |
| a day of texts | `text:<lineId>\|<YYYY-MM-DD>\|<+1…>` | the day gains a message |

- **A text entry is one line's texts for one Pacific day**, so today's keeps
  growing while people reply. Its row stores `source_count` and
  `source_last_id`, and a mismatch regenerates it. **Quo's count decides, not
  the browser's**: the sweep reads only 50 messages per line, so an older day
  at that edge can show a different count with nothing having changed.
- **The phone number is in the text key.** The dialog's own entry id is only
  `<lineId>|<day>`, which two caregivers texted on one line on one day share.
  Keying on that would show one caregiver the other's summary.
- **An unanswered call gets no box and no request.** A call Quo has no
  transcript for (404) gets no box either. A transcript still processing says
  so and offers *Check again*.

#### Only ids go up — the function reads Quo itself

**Claude: do not "simplify" this into posting the messages from the browser.**
The browser already holds them, and it would be less code. It would also let
anyone with the site URL save invented summaries into the table and spend the
Anthropic key on any text they liked, because there is no login. The browser
sends `{kind:'call', callId}` or `{kind:'text', lineId, day, phone, count,
lastId}` and nothing else. The function reads the conversation from Quo, so a
summary can only describe a real conversation and spend is capped at one per
conversation per model. A `GEN_HOURLY_CAP` of 400 model calls per isolate is
the brake on top.

`comm_summaries` has RLS on and **no policies at all**. Verified: the anon key
gets `401` on both select and insert. Only the function touches it, with the
service key. This is deliberately stricter than `care_notes`, which anon can
read, because these rows describe conversation content.

The caregiver's and the clients' names come from the roster through
`QUO_ROSTER_URL`, the same public proxy `quo` uses for its send allowlist. **If
that read fails, the summary is shown but not saved**, so the next open can name
the caregiver rather than leaving "the caregiver" in the table forever.

#### Contact details are redacted in code — a prompt rule did not hold

The first prompt let a call summary run to three sentences, close by repeating
its own last point, and carry an applicant's email address. Version 2 capped it
at two sentences under 40 words and **told** the model to leave out contact
details. It kept to the length on all four rows it rewrote, and **still wrote
the email address into one of them.**

So `redact()` replaces email addresses, phone numbers and links in the
transcript and the messages with `[email address]`, `[phone number]` and
`[link]` **before they leave the function**, and runs again over the output.
That also means those details are never sent to Anthropic at all. Street
addresses have no reliable pattern and are left to the prompt. **Claude: do not
remove `redact()` on the grounds that the prompt already says it.** That is the
exact reasoning it replaced.

#### Office staff are named from who SPOKE, not from `call.userId`

Measured 2026-09-15 on one call. Its `userId` was **Marivic** and its
`answeredBy` was **Patty**, and every office turn in the transcript was stamped
**Patty** (14 turns) or **Ruffa** (9). The first version passed `userId` as
"office staff on the call" beside turns labelled Patty. Given two answers, the
model named Marivic on two runs and Patty on the third. The details now list
the staff whose `userId` is on transcript turns, most turns first, and fall back
to `answeredBy` and then `userId`.

> The rail row still names `userId || answeredBy || initiatedBy`, so this same
> call's row reads **Marivic** while its summary says **Patty** — and a wider
> sample says that disagreement is common. The measurement is under *The shape
> is borrowed from the old Scheduling app*.

`PROMPT_VERSION` is 4. Rows written under an earlier version are rewritten on
their next open, and each of today's bumps was checked that way against the
rows already saved.

#### Switching the model needs no code change and no redeploy

```
npx supabase secrets set COMMS_MODEL=claude-sonnet-5 --project-ref gdzgoyawavffjdjpjbfz
```

The default is `claude-haiku-4-5`. `GET …/comms-summary?action=status` reports
the model in force. Four details make the switch safe:

- **Every row records `model` and `prompt_version`, and a row written by
  anything else is rewritten on its next open.** That is what makes a switch
  visible to the desk. Bumping `PROMPT_VERSION` after editing the prompt does
  the same. Summaries are rewritten gradually as conversations are opened, not
  all at once.
- `COMMS_EFFORT` (default `low`) is sent to every model **except Haiku**, which
  answers `400` to the effort parameter.
- **No `temperature` is sent.** Sonnet 5 and Opus 5 reject it, so sending one
  would make the first switch fail on every request.
- **`max_tokens` is 4096, not something sized for two sentences.** It includes
  thinking, which Sonnet 5 and Opus 5 do by default, and a small budget returns
  HTTP 200 with an empty text block. That is the trap `care-brief` and
  `devi-agent` both hit.

The model that wrote a summary is in the tooltip on the *Summary by Devi*
label, and every generation logs `[comms-summary] <model> in=… out=…` in the
function logs.

Measured 2026-09-15, with the function run locally against live Quo, Claude and
the real table:

| | Haiku 4.5 (default) | Sonnet 5 |
|---|---|---|
| tokens in / out, per summary | 750–1,440 / 28–74 | 1,251 / 63 (same call as Haiku's 885 / 29) |
| cost per summary | about $0.001–0.002 | about $0.003 |
| first summary, cold function | 7–9.5s | ~7s |
| first summary, warm function | 2.1–2.6s | |
| any later open (saved row) | 0.25–0.6s | |

The cold 7–9.5s is mostly the roster read through Netlify. The three context reads
start in parallel with the Quo reads (`context()`) and are cached for ten
minutes, so only the first summary in a fresh isolate pays it.

#### A deleted conversation's summary is removed only when noticed

There is no background job; that was agreed on 2026-09-15. Checking every saved
summary against Quo is exactly the sweep this design avoids, and the dialog's
list comes live from Quo, so a deleted conversation's summary is never shown.
The row is deleted when the function notices: Quo `404`s the call, or the day
holds no messages. For calls that almost never happens, because a saved call is
served without asking Quo. An orphaned call summary simply sits unread.

#### An error is never retried by a render

The summary landing re-renders the dialog, and the render is what asks for it.
So a failure that retried itself would send one request per render for as long
as the dialog stayed open. **An error or a *pending* state holds until somebody
clicks Retry or Check again.** A day that gains a message still refreshes on its
own, once, because its `gen` (count and last id) has changed.

Nothing here goes into `state`. `devis` is a module cache inside `CGCOMMS`, for
the same reason the rest of that module keeps its data there.

#### Deploy the function BEFORE `index.html` goes live

A commit does not deploy it. If `index.html` lands first, every answered call
and every text day shows an error in the box until it is. **The browser only
ever sees "Failed to fetch", never the 404.** Measured 2026-09-15: the gateway
answers the POST's CORS preflight with a 404 whose
`access-control-allow-headers` omits `content-type`, so the request is blocked
before its body can be read. `loadDevi()` therefore turns a network
`TypeError` into "Could not reach the comms-summary function. It may not be
deployed yet…" with the deploy command.

```
npx supabase functions deploy comms-summary --project-ref gdzgoyawavffjdjpjbfz --no-verify-jwt
```

**Deployed 2026-09-15** and checked live from the Netlify origin.
It needs no new secrets: `ANTHROPIC_API_KEY`, `QUO_API_KEY`, `QUO_ROSTER_URL`
and `ALLOWED_ORIGIN` already exist on the project, and Supabase supplies the
service key. The table is created (`supabase/comm-summaries.sql`, also section 9
of `schema.sql`).

### Texting a caregiver from Find Coverage

Added 2026-09-14. The Text button on a Find Coverage row now **sends**, through
Quo, from an agency line. It used to be an `sms:` deep link that opened the
scheduler's own phone app with the message pre-filled, and the only thing that
actually worked was Copy.

`QUOSEND` resolves who and which line; `renderCoverageTextModal` draws; the
Edge Function does everything that matters. See *Read-only — except
`action=send`* above for the guards.

#### The scheduler picker maps to Quo BY EMAIL

`state.onShift` holds a short name from `SCHED_PEOPLE`. Quo holds nine
workspace members under different ones. The map is by **email**:

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

Mitch confirmed the first and last by hand ("Marivic is Mitch, Tine is
Kristine"); the rest are the same person under a shorter name.

**Not by name**, because the two lists genuinely disagree and always will —
and Quo records Jen as `"Jenn "`, with a trailing space. **Not by Quo user
id**, because an id is opaque: nobody reviewing the file can tell whether
`USpODQ2ABD` is still Marivic, and a member removed and re-added gets a new
one. An email is stable and checkable by eye against the Quo member list.

`QUOSEND.who()` prints the resolved mapping from the console, which is the
only way to check it without reading the source.

**A name with no mapping is not an error.** It sends with no `userId`, Quo
applies its own default, and the caregiver sees the same line number either
way — attribution is internal to Quo. Guessing a colleague would be worse.

#### Send as depends on Send from, and is re-derived when the line changes

Quo requires the sender to be a **member of the line being sent from**, and
the lines differ sharply — Scheduling Department carries all nine members,
Recruitment carries two (Patty and Tine). So changing the line re-derives the
sender rather than keeping it. Silently sending as somebody who is not on the
new line would have Quo reject it for a reason the screen never mentioned.

When the person on shift is not on the chosen line, the modal says so in a
sentence rather than quietly picking somebody else, and *"Quo's default
sender"* is an explicit option rather than a hidden fallback.

#### One recipient reads their own name; several read `{name}`

The templates greet by first name. With one recipient that first name is baked
in, because the scheduler should read the exact words that will arrive. With
**several**, the draft carries the literal token `{name}` and the Edge
Function replaces it per recipient as each message goes out.

> Without that, a batch built from the first ticked caregiver greets
> **everyone** by that one person's name — Maria Lopez receiving *"Hi Edna,
> this is Devoted Care"*. Worse than no greeting, and exactly what the desk
> would be blamed for. It was written wrong first and caught by the browser
> test, not by reading. `buildCoverageText(cgId, key, multi)` takes the flag,
> and **both** call sites pass it.

`personalise()` runs server-side and deletes every **other** `{token}` rather
than transmitting it: a literal `{client}` arriving on a caregiver's phone is
worse than a gap.

#### The checkboxes, and what they are not

Every row in *Call in this order* has a tick box, and a bar above the list
offers **Text N**. Ticking several sends each of them their **own private
message** — it is explicitly **not** a Quo group thread, which would show every
caregiver every other caregiver's number. Mitch asked for the checkboxes and
said group texting was not wanted yet; individual multi-send is what the
checkboxes do, and the modal says so on screen.

A caregiver with no phone number gets **no checkbox at all**, because a tick
that cannot become a text is a promise the screen does not keep.

**`state.covSel` is per-browser and must never go into `SLICES`** — the same
rule as `state.openSel` beside it, and for the sharper of the two reasons:
anything in `SLICES` is diffed into the shared overlay and applied to the other
desks on their next 20-second poll, so Mae's ticks would appear under Jen's
cursor mid-sentence and Jen's would replace Mae's. That is the failure
`state.onShift` had before it moved to `localStorage`. It is not in
`localStorage` either: a selection should not outlive the tab.

After a send, **only the recipients who actually received it are unticked**. A
failure stays ticked so the retry is one click rather than a hunt back through
the list.

#### Nothing is written to `state.contactLog`

A sent text does **not** create a contact-log entry, and that is deliberate
rather than an omission. `renderCoverageCommand()` drops anybody in the contact
log out of the calling queue, so logging a text would make the caregiver
disappear from the list the moment the message went out — before they have had
a chance to reply. The record exists where it belongs: **sent texts appear on
that caregiver's Communication Logs card**, live from Quo, which is what that
card was built for.

#### The Assign button is gone from Find Coverage

Removed 2026-09-14 at Mitch's request: it had no working behaviour behind it on
this screen. `dispAccept` and `assignShift` are **untouched** and still reached
from the Today board, the Auto-offer modal and the quick-contact modal — the
coverage row was one of five call sites, not the only one, so nothing about
assigning a shift changed anywhere else.

`covCandRow()` went with it. That function had been **dead since the coverage
rewrite** — zero callers, and it carried the only `multi` parameter left in the
coverage screens.

#### A client's name in an outbound text is the GIVEN NAME ONLY

`shortClientName()` — "Brenda Janowski" becomes **"Brenda"**. Mitch's call,
2026-09-14. A caregiver being offered a shift does not need the client's legal
name, and a text is forwarded, screenshotted and read on a lock screen.

It went in that morning as "Brenda J." and lost the initial the same day,
across **every** template. Do not reinstate it for one and not the others:
the point is that a caregiver sees the same form of a name wherever it reaches
them.

**The given name is kept whole.** "Mary Lou Brown" is *Mary Lou*, "Helen Jean
Kelly" is *Helen Jean*, and "Duane & Lynne Georgeson" is *Duane & Lynne* — a
couple, so dropping half would be wrong rather than brief. Trimming to one
word renames somebody instead of shortening them.

**A suffix is not a surname.** AxisCare stores `"Calvin George"` / `"Miller
Jr"`, which joins to "Calvin George Miller Jr" — take the last word off and
you keep *Miller*, the very thing this exists to remove. The suffix is
stripped first. Verified against all 21 active clients.

`mapClient()` keeps only the joined `name`, not firstName/lastName, which is
why this works on the string. Adding fields to the mapper would change the
shape of a patchOnly CLOUD slice for a cosmetic gain.

**Outbound only.** The activity log, attendance records, the coverage board
and every screen the desk reads keep the full name — a scheduler needs to know
exactly whose shift it is.

#### ONE non-GSM-7 character doubles what a message costs to send

Measured 2026-09-14. An SMS is GSM-7 until it contains a character outside
that set — an **en dash, em dash, curly quote or ellipsis** — at which point
the whole message becomes UCS-2 and a concatenated segment drops from **153
characters to 67**.

**12 of the 14 outbound templates were paying that, for a single en dash in
the time range.** One send of each cost **45 segments; with plain ASCII it is
25.** Same words, 44% cheaper, on every message the desk ever sends.

Use `-`, `'` and `...`. They read identically on a phone. There is a note
above `TEXT_TEMPLATES` and a regression test that renders every template and
asserts it stays GSM-7.

### The care-needs line — `care-brief`

Added 2026-09-14. The **Weekend availability** template carries one line
describing what the caregiver would be taking on, so they know before they say
yes. Mitch wrote the structure and the rules; only the shift details and the
care needs change.

```
Hi Maria, are you available for weekend coverage with Brenda?

Saturday, 8:00 AM-8:00 PM - Camarillo

Care needs: Wheelchair dependent, hands-on for all transfers, help with
toileting, bathing and dressing, reposition every 2 hours, high fall risk.

Please reply YES if you're available and comfortable with these care needs.
Thank you.
```

Four blocks separated by blank lines. When there is no care-needs line the
block is **dropped entirely** so the blanks close up, rather than leaving a gap
where the care needs should have been.

#### The data is CONCIERGE'S, and AxisCare has none of it

**Claude: do not go looking for care needs in AxisCare.** There are none.
`triageLevel` and `priorityNote` are null on this account, client `classes[]`
are payment type only, and `/api/adls` returns the global CATALOGUE of ADL
types — its `clientIds` filter is silently ignored, the same trap as
`caregiverIds`.

Client Concierge holds it, in `concierge_records.data.careNeeds` plus the
`fallRisk` / `cognitive` / `hospice` columns. **18 of 18 active clients** have
usable content there.

> Concierge also has a `caregiverBrief` written by its own agent, and copying
> that was the first plan — one source of truth, one AI. It was abandoned on
> measurement: `caregiverBrief` exists for **1 of 18** clients, and its
> `shift.must_know` is five full sentences (~600 characters) rather than a
> line. Summarising here works today; copying would have needed somebody to
> run 17 more briefs first.

#### The function fetches its own data — that is the PHI design

`supabase/functions/care-brief/index.ts` reads Concierge **itself** and returns
only the finished sentence. The obvious design — browser reads the record,
posts it up to be summarised — would make every client's mobility, continence
and cognition readable by anyone with the site URL, because there is no login.

**The raw clinical record never reaches the browser and is never stored in the
Scheduling database.** There is no `fields` parameter either: a caller passes a
client id and gets a sentence. Mitch confirmed on 2026-09-14 that the Anthropic
key has PHI handling in place.

#### "Do NOT include medications" — an absolute rule, and how it is actually held

Three layers, because a prompt instruction alone is a request:

1. **A narrow set of fields is read.** `mobility`, `personal`, `adl`,
   `transferAssist`, `ambulation`, `standLong`, `safety`, and the structured
   `fallRisk` / `cognitive` / `hospice` columns. `medManage`, `medInstr`,
   `routineAM`, `routinePM`, `routineDay`, `feeding` and `other` are **never
   read** — every one of them holds drug names on this account.
2. **Every field read is filtered, per SENTENCE.** A medication sentence is
   dropped and the rest of the field kept.
3. **The output is filtered by the same detector, then read by a second
   model** asked one question. A YES, an unparseable answer, or a failed check
   all discard the line.

> **`skipped` in the response says exactly what was held back** —
> `["personal (1 sentence)", "cognitive"]` — so a scheduler can see that
> something was removed rather than wondering why a line reads thin.

##### What an adversarial review found, and why the detector looks the way it does

**The first version was a 25-name denylist and it missed 48 of 51 realistic
home-care medication strings.** Measured, not estimated. Two of its own entries
could never fire: `\bmg\b` cannot match `"10mg"` — there is no word boundary
between a digit and a letter, so it only caught `"10 mg"` — and `\bstatin\b`
cannot match `atorvastatin`. Xarelto, Seroquel, morphine, Ativan, oxygen,
patches, inhalers, eye drops and barrier cream all sailed through. **And
`SAFE_FIELDS` had no filter at all**, exempted on the strength of one
measurement of 18 records on one Tuesday.

**A LIST OF DRUG NAMES CANNOT WORK.** The name space is open-ended and
commercial. So the regex now covers only the parts that are **closed** —
dose amounts with or without a space, sig abbreviations, forms/routes/devices,
and generic-name **suffix families** (`-statin`, `-sartan`, `-xaban`,
`[aeiou]lol`, `-prazole`) — and the model handles the rest. That took it from
**94% missed to 8%**, with zero false positives on real care text.

Two suffix details worth keeping: `{2,}` not `{3,}`, because *losartan* is
lo+sartan; and `[aeiou]lol` not `olol`, because only metoprolol and atenolol
actually end "olol" — *carvedilol* ends "ilol".

`iv` is deliberately **not** in the sig list: case-insensitively it matches the
"IV" in *Calvin Miller IV*, and a client's own name must not trip this.

##### The checker runs at temperature 0, and knows equipment is not medication

Both from one client. **Duane & Lynne Georgeson (331)** lost their line about
one run in three, and diagnosing it took six generations put to the checker:

- it called **"Velcro compression wraps"** and **"soft neck brace"**
  medication — a garment and an orthotic, neither a substance anyone is given.
  The prompt now lists explicit negatives.
- the **same sentence** got YES three times and NO twice. A client keeping or
  losing their care line on a coin flip is worse than either answer, because
  nobody can reproduce it. It is a yes/no classifier, so **`temperature: 0`**.

The same client exposed the gap that made filtering per-sentence necessary.
Their `personal` field reads *"Assist with dressing. Velcro compression wraps.
Changing briefs about 2-5x daily. Wipe his eyes after glaucoma drops. Soft neck
brace at times."* — one medication sentence among four things a caregiver needs.
Dropping the field lost all five and left the line reading *"walker, stand-by
assist, high fall risk"* for a client whose briefs need changing five times a
day. **"glaucoma drops" also had to be added** to the pattern, which only knew
`eye drops`; a bare `\bdrops\b` would fire on "he drops things", so the
qualifiers are listed instead.

#### Two prompt rules that are not style

- **`max_tokens` includes thinking**, and 1024 was not enough over a care
  record of several thousand characters: **4 of 18 clients returned empty and
  3 more were cut off mid-sentence.** 4096 fixed it. Same trap CLAUDE.md
  records on `devi-agent`, arriving at a different scale.
- **No umbrella terms.** Asked for a shorter line, the model wrote *"full
  personal care at bedside"* instead of naming toileting and bathing. A
  caregiver cannot decide whether they can take a shift from a category name.
  `personal care`, `ADLs`, `full care` and `assistance as needed` are
  forbidden, and a test asserts none appear.

`TARGET_LINE` (170) and `MAX_LINE` (200) are deliberately different: asking for
the number you will enforce leaves no room to finish a sentence, and the first
run produced a line ending *"...stay in"*.

#### Send is disabled until the line has generated

Sending a weekend offer with the Care needs section still missing is the one
mistake this feature exists to prevent — the caregiver would be asked to
confirm they are "comfortable with these care needs" without having been shown
any. The button reads *"Reading care needs…"* while it waits.

**Only "still coming" blocks Send.** Nothing recorded, or a line written and
discarded, are *finished* answers: the message is correct without the section
and `ctCareWarn()` explains which of the three happened, so the desk is never
stuck. Other templates never wait.

`CARE` caches per client per session. An edited draft is **never** overwritten
when the line lands — `buildCoverageTextWithout()` is what tells an untouched
draft from the scheduler's own words.

#### `.q-b` must set font-family and line-height

Reported by Mitch: *"the Call button is bigger than the Text button."*
Measured — **Call 28.09px, Text 24px**. A `<button>` inherits neither
`font-family` nor `line-height`, so the Text BUTTON rendered in **Arial at
line-height:normal** beside the Call ANCHOR in **Inter at 16.1px**. Same class,
same padding, two typefaces.

`.q-b` now pins both. `1.4` is exactly what the anchor already computed
(11.5 × 1.4 = 16.1), so buttons grow to match and nothing else moves. It is a
shared class, so this also squares up Skip, Decline, No answer and Callback.

### The browser module

`Quo` in `index.html`, deliberately a near-clone of `AxisCare` so the mental
model transfers. It sits after every other module and five lines above
`CLOUD.boot();`, where it cannot disturb the boot order.

```js
await Quo.status()      // configured? deployed? never returns the key
await Quo.ping()        // does the key actually work, end to end
await Quo.inboxes()     // all twelve phone numbers
await Quo.users()       // the nine workspace members
await Quo.get('/v1/conversations', { maxResults: 10 })
await Quo.lines()      // the lines WITH each line's members inline
await Quo.send({ from, userId, content, to:[{id,name,phone}] })
await CARE.load(342)   // the care-needs line for one client, via care-brief
```

`Quo.send` is the only write path in the module, and it is deliberately not a
generic `post(method, path)`: a helper that could post anything would invite a
second mutation to be added without re-opening the decision that allowed the
first.

Query params go through the `q_` prefix, same convention as the AxisCare
proxy. Quo wraps list results in `data`, so a raw `get()` reads
`r.data.data`; `inboxes()` and `users()` unwrap it for you.

**`CGCOMMS` is its only caller in the UI** — see *Communication Logs* above.
Nothing Quo returns goes into `state`. It is not a `SLICES` entry and must not
become one: a few hundred messages diffed into the CLOUD overlay is the 323KB
bug in *Don't break these*, arriving through a new door. If Quo data ever
needs to persist, it gets its own table and its own module cache, the way
`CGVISITS` does.

Console helpers for the card itself:

```js
CGCOMMS.status('a731')       // idle | loading | ready | error | nophone
CGCOMMS.info('a731')         // { e164, entries, calls, msgs, lines, requests, ms, partial }
CGCOMMS.toE164('805-555-0123')
CGCOMMS.retry('a731')        // drop the cache and sweep again
CGCOMMS.deviRetry('call:AC…') // drop one Summary by Devi from this session and ask again
```

## The Caregiver Overview — four cards

Rearranged 2026-09-15 at Mitch's request. Under the calendar:

```
Communication Logs     Notes
Client Feedback        Client Complaint
```

The Updates card is gone, and the old combined **Client Feedback & Concerns**
card is now two.

### Client Feedback and Client Complaint are ONE store

Both cards read and write `state.cgConcerns`, the slice the combined card
used. **There was no backend change.** Entries live in the `scheduler_state`
overlay JSON like every other desk record, so the split is `index.html` only.

Two slices was the alternative, and it costs more than it looks. A new slice
path means the shared overlay has to be migrated and every open tab refreshed
at the same moment, or a tab still running the old code writes the entries
back under the old path (see *A deploy does not reach an open tab*).

`fbKind(f)` is the only place that decides which card an entry sits on:

| Entry | Card |
|---|---|
| `kind: 'feedback'` or `kind: 'complaint'` | that card. A saved kind always wins |
| no kind, `type` Concern or Complaint | Client Complaint |
| no kind, `type` Positive Feedback, or no type | Client Feedback |

New entries are saved with `kind`. **Client Feedback has no type**: it is a
note, and saving an old entry there drops its `Positive Feedback` label.
**Client Complaint requires Concern or Complaint**, with nothing pre-selected,
and the type picker comes before Notes.

**Claude: do not bring back a Positive Feedback type, and never infer a type
from the words.** Only the person who took the call knows whether an entry is
a concern or a complaint.

Entry text on both cards goes through `escText()`. The Notes card beside them
still uses `esc()` in its text position, which does nothing about a `<` typed
into a note. That is the trap described under *Three traps*, and it was left
alone here because it is outside this change.

### The Reliability concern badge counts Complaint, not Concern

Mitch's call, 2026-09-15. An entry typed **Complaint** raises the red
*Reliability concern* badge on the Overview; a **Concern** does not. The filter
is `fbKind(f)==='complaint' && f.type==='Complaint'`. The persona summary
counts all three kinds of entry, so a Concern is still mentioned there.

### The Updates card is gone

Removed along with its composer, `state.cgUpdates`, its `SLICES` entry and the
`.cgp-scroll` CSS that only it used. The slice held **0 records** when it went,
so nothing was lost, and any `cgUpdates` key left in an old overlay is inert.

`{ path:'updates' }` in `SLICES` is **a different feature**: Operations
Updates, which Devi posts internal scheduling notes to. It is untouched.

### The live data on the day of the split

Three entries. Mae's complaint about Mireya Sanchez (`a874`) had been saved
twice on 2026-08-29: once before the type field existed, so untyped and bound
for Client Feedback, and again typed Complaint with the date pasted onto the
end of the text. With Mitch's approval the untyped copy was deleted and the
pasted date trimmed. Jen's note about Don (`a1256`, filed as Positive
Feedback) moved to Client Feedback.

> **Editing a shared record takes a PATCH, not just a corrected add.** On a
> slice like `cgConcerns`, `applyOverlay()` skips any add whose id the tab
> already holds, so a rewritten add never reaches an open tab, and that tab
> pushes the old copy back on its next save. The fix therefore went out as
> the corrected add, a `dels` entry for the duplicate, **and** a `patches`
> entry carrying the trimmed text, which `applyOverlay()` does apply to a
> record already held. No tab re-emits a del or a patch on a slice with no
> baseline records, so both cleared themselves: rev 6374 carried them, and
> Mae's open tab applied them and saved rev 6375 two minutes later with the
> entry correct and both gone.
>
> **A del no longer behaves that way — see 3g under *Don't break these*.**
> Since 2026-09-15 every del on these slices is learned as a permanent
> tombstone and re-sent on every save, so it never clears itself. The
> `patches` half of this recipe still works; a hand-written del now deletes
> the record for good.

## The Caregiver Profile — Skills and Experience

Split 2026-09-15 at Mitch's request. The Profile grid reads:

```
Work Preferences                       (full width)
Employment Summary     Client Blocks — Do Not Assign
Skills                 Experience
Personality            Hobbies & Interests
```

| Card | Options | Free text |
|---|---|---|
| **Skills** | Mobility & Safety, Personal Care, Daily Living Support — 19 options | Anything else (`skillsNote`) |
| **Experience** | Dementia / Alzheimer’s, Parkinson’s, Stroke, Diabetes, Hospice, Post-hospital recovery, **Others** — listed flat | Anything else (`experienceNote`) |

Experience has no group heading. These are the options that sat under *Care
Experience* on the combined card, but a lone "Care Experience" heading under a
card titled Experience told the reader nothing and made a ticked Others read
as "Care Experience: Others" — the same redundancy the "MESSAGES" label on
Communication Logs was removed for.

**No backend change.** Both are fields on the caregiver's `cgProfiles` record
in the `scheduler_state` overlay; Experience adds `experience` and
`experienceNote`.

### One stored list became two, and the first save must write both

Until the split, every tick on either card lived in `cgProfiles[].skills`. On
the day, **61 of the 68 filled-in profiles** held Care Experience ticks there.
Nothing was migrated. Instead:

- **Experience reads `p.skills`** until it has an `experience` list of its
  own, and reads the same legacy seed Skills does when neither exists.
  `cgChips()` keeps only each card's own options, so the two cards never
  show the same tick. Both share `CG_CHIP_RENAME.skills`.
- **The first Skills save also writes Experience's list** (`pair` on the
  Skills field, applied in `chipSave()`). Once `p.experience` exists it does
  nothing. **Only Skills carries `pair`.** An earlier version put it on
  Experience too, so saving Experience froze a copy of a seeded Skills card
  and it stopped following the AxisCare tags — caught in review and removed.

**Claude: do not remove the `pair` write.** Saving Skills rewrites `p.skills`
with Skills options only. Without it, every Dementia, Hospice and Parkinson's
tick disappears from Experience the moment somebody saves Skills — on 61
real caregivers. `skills-exp-test` and `skills-exp-ui-test` both pin it.

> **One rollout race, accepted.** For up to a minute after this deploys (and
> until a stale tab is reloaded), a tab still running the old code shows the
> combined card. On a caregiver whose record the new code has already split,
> a Care Experience tick added there lands in `p.skills`, where Experience no
> longer looks, and the next Skills save drops it. It needs an old tab, a
> caregiver who had no profile record before the split, and an edit inside
> that window — so the desk hard refreshes after the deploy, as always.

### Needs Update requires both — Mitch's call

`CG_REQUIRED` has a **Skills** row and an **Experience** row, replacing
*Skills & experience*. A tick or the "Anything else" line answers either one.

**Others** exists because Experience is required. Without it a caregiver who
has never cared for any of the six named conditions would stay on Needs
Update with nothing they could honestly tick. On the day, 7 of the 68 stored
profiles had skills but no Care Experience tick, so those caregivers now
appear for Experience until somebody answers it.

### What else reads them

- **Recent Updates** logs *Skills updated* and *Experience updated* — including
  when only the "Anything else" line changed, because that line now answers
  Needs Update and a cleared row must say who cleared it. Entries written
  before the split still read *Skills & experience updated*.
- **The persona sentence** (`cgAbout`) reads Experience first, then Skills —
  the order the combined list used — and never names "Others", which says
  there is more without saying what.
- **The resume does not read these cards.** It still reads `c.skills` (the
  AxisCare class tags), so neither card, nor "Others", reaches a client.

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

### Ask Devi is ONE page — the dock was removed 2026-09-22

There was a sticky strip at the bottom of every page (`renderDock()`,
`#devidock`): a composer, and the last six exchanges above it when opened.
Mitch had it removed — a bar pinned to the bottom of every screen is a cost
every page pays for something the desk opens occasionally.

**What it bought, stated plainly, because rebuilding it is a real option:** a
question could be asked *without leaving the page it was about*. That was the
original request, and giving it up is the whole trade. Ask Devi is in the nav;
`viewAssistant()` is now the only place the composer exists.

The page keeps the shape the dock had — **the conversation reads downward into
the box that produced it**, composer at the foot rather than above its own
output — and `state.aiLog` is unchanged, so nothing about the thread, the
router or the action cards moved.

#### The composer is the sibling apps', not its own thing

Mitch put the three Ask tabs side by side on 2026-09-22 and this one was the
odd file out: a one-line pill with a caret-toggle underneath, where Client
Concierge and Finance both have a roomy multi-line box and a button beneath it.
Three apps the same desk uses all day should not each have their own idea of
what asking looks like, so this one follows them.

```
+-------------------------------------------------+
|  Ask Devi anything - or ask it to record        |   <- textarea, 3 rows
|  availability, a work preference or a task...   |
+-------------------------------------------------+
  [ * Suggested questions ]  Changes need your approval     [Clear] [Ask]
```

- **A `<textarea>`, not an `<input>`.** Somebody writing *"record that Maria
  does not drive on Tuesdays and Thursdays"* should see the whole sentence.
  Instructions are the longest thing typed here and they were the thing the
  one-line box hid.
- **Enter sends, Shift+Enter is a newline.** That is what every chat box does,
  and it is what people type without thinking.
- **Every example sits behind the one button.** An empty thread briefly showed
  six of them as cards above the box; that went the same day, because the other
  two apps put all of theirs behind a single *Suggested prompts* control and a
  scheduler moving between the three should not have to learn two places to
  look. All 26 `AI_EXAMPLES` are in the one list, including the two instruction
  shapes — nothing else tells a scheduler that Devi can be *told* to do
  something.
- **"Changes need your approval" is Finance's line**, and it is true here for
  the same reason: nothing Devi proposes is written until somebody clicks
  Approve on the card. See *Devi actions*.

##### The composer is at the FOOT of the page, on an empty thread too

The page is a full-height flex column: the thread takes the slack and scrolls,
the composer is the last row. On an empty thread that leaves the box at the
bottom of the viewport with a screen of white above it, which **looks** like a
defect and is not one — it is what Client Concierge and Finance do, and it is
where this page's own box sits the moment there is a conversation.

**Claude: do not "fix" that white space.** It was fixed once, on 2026-09-22,
with an `.ai-wrap.start` class that turned the stretch off so the box opened at
the top of an empty page. Carlo reported it within the hour — *"why is it in
the upper left corner and not in the bottom similar to Concierge and
Finance?"* — and it was reverted the same day. A composer that moves depending
on whether you have asked anything yet is worse than one that sits still in a
wrong-looking place, and it made this Ask tab the odd one out again, which is
the exact thing the restyle was for.

The suggestions stay **collapsed** behind their button. Opening all 26 of them
on the empty page was the other attempt to fill that space, and it was
reverted too: a wall of chips *above* the box, which neither sibling app has.

##### The chat is FULL WIDTH, and it took a scoped rule — `.ai-wrap` is two screens

Carlo, an hour later: *"why is the chat not full width?"* Because the width on
screen was never this page's own rule. **`.ai-wrap` is used by two unrelated
screens** — `viewAssistant()` here, and `guideAiForm()`, the guide library's
AI-assisted draft form:

| where | rule | |
|---|---|---|
| the Ask Devi CSS block | `.ai-wrap{max-width:880px}` | looks authoritative |
| the guide library CSS block, ~1,100 lines lower | `.ai-wrap{max-width:620px}` | **wins** — equal specificity, later in the file |

So the chat was capped at 620px and left-aligned, leaving ~280px of white
beside it on a 1150px window and over 1,000px on a 1920 one, with nothing near
either rule to say why. **This is the `.mwide{max-width:680px!important}` trap
again** — a rule far down the stylesheet quietly overriding the one that reads
like the answer. When a width on this page does not match its rule, look for a
second owner of the class before touching the rule you found first.

The fix is scoped rather than global, because the guide form genuinely wants to
stay narrow — it is a short form, not a conversation:

```
.v-assistant .ai-wrap{max-width:none}     /* (0,2,0) beats the guide's (0,1,0) */
```

Measured after, chat against the view's inner width, and the guide form beside
it:

| window | chat | gap | guide form |
|---|---|---|---|
| 1150 | 874 | **0** | 620 |
| 1440 | 1164 | **0** | 620 |
| 1920 | 1644 | **0** | 620 |

**Renaming the class on one of the two screens is the tidier fix** and a much
larger diff — every rule in both blocks, plus `.ai-card` / `.ai-h` / `.ai-sub` /
`.ai-go`, which the guide form also owns and which the composer must not reuse.
Worth doing if either screen is touched again in earnest.

> The cost, stated plainly: on a wide monitor an answer's text now runs the
> full width of the content area, which is a long line to read. `.ai-ask`
> (the question bubble) still caps at 80%. If the desk finds the answers too
> wide, the fix is a max-width on `.ai-ans` — not on `.ai-wrap`, which would
> narrow the composer again and put back what this change removed.

##### `render()` carries what is half-typed — the dock used to

`render()` runs on every save and on every 20-second poll, and it rewrites the
view wholesale. The dock read `#aiq` before it repainted and put the value,
focus and selection back; when the dock went, nothing did, so a poll landing
mid-sentence silently emptied the box. `render()` itself now does it, which is
the right home for it — the page is re-rendered from about a dozen places and
only one of them was ever the dock.

`askAI()` clears the box itself after reading it (`preset == null` only, so a
suggestion chip does not wipe something already typed). Leaving the clear to
the re-render would now be undone by the carry.

> **`.ai-card` is taken.** The guide-draft form uses `.ai-card`, `.ai-h`,
> `.ai-sub` and `.ai-go`. The starter cards reused the name for an hour and
> restyled that form as a side effect. The composer's own classes are
> `.ai-ta`, `.ai-tools`, `.ai-sugbtn` and `.ai-approve`.

### The four-part answer, and its honest limit

`deviSystem()` asks for **WHAT I FOUND / WHAT I CAN DO / WHAT THE SCHEDULER
NEEDS TO DO / PRIORITY** on a *review* — a sweep of the board, several
caregivers at once. A one-fact lookup gets the plain answer; a heading on a
single row of data is noise.

**"WHAT I CAN DO" may never list an action that writes to a record.** Devi has
no tools (above), so compiling, ranking, cross-checking and drafting are real
and "I'll update her availability" is a lie. The prompt says so explicitly, and
that sentence has to stay as long as the tools array is empty.

### What Devi can and cannot do

**THE MODEL has no tools. It can only produce text.** Nothing Claude says
reaches the availability table, the roster, a shift or AxisCare — the browser
renders the words and stops. That is the entire safety argument for showing it
real data, and it is why `supabase/functions/devi-agent/index.ts` forwards no
`tools` array. **Claude: adding a tool invalidates that argument and has to be
re-made from scratch.**

**THE BOARD can write, through the action layer below** — but only from
proposals the *router* built in code, never from anything the model wrote, and
never without somebody clicking Approve. The two are separate paths and they
never meet: a proposal attaches to a router answer, and a router answer is by
definition one the model was not asked about.

`state.aiLog` is **not** a tracked CLOUD slice, so the conversation stays in the
browser that asked it and is never written to Supabase or shared.

### Devi actions — verify, prepare, approve, write

The block headed `DEVI ACTIONS` in `index.html` is the only place Ask Devi
changes anything. The flow is fixed and there is no way round it:

```
verify   the builder reads the live tables
explain  the answer says what it found, with the numbers
prepare  a proposal naming every record it would touch
APPROVE  a person clicks
write    through the SAME function the matching screen uses
```

`dactPrepare()` returns null when there is nothing to do, so a card only ever
appears when there is a real change behind it. `e.act` rides the turn, so Clear
takes proposals with the thread and an old card can never attach itself to a
new question. `dactCards()` renders them, once, on the Ask Devi page (it
served the bottom dock too, until that was removed).

**Five rules, each of which cost something to learn:**

- **Re-verify at approve.** `pull()` runs every 20 seconds, so a colleague can
  change the named record between the preparing and the clicking. `approve()`
  rebuilds from the live tables and, if the set moved, shows the new one and
  asks again rather than replaying a stale write over somebody's newer work.
- **A build that THREW is not a build that came back empty.** Both write
  nothing; only one is good news. Reporting a thrown re-verify as "already
  handled" would be a false success, which is the one outcome this block exists
  to prevent.
- **Hold an ID, never a caregiver object.** `ROSTER.hydrate()` reconstructs
  every caregiver on a Retry, so an object captured at prepare time can be an
  orphan by the time Approve is clicked — and writing to an orphan changes
  nothing the app reads while reporting Done. `dvLive(id)` resolves through
  `cgById()`, the lookup every screen uses, at build **and** at apply time, and
  throws if the caregiver has gone. The pref and miles actions also read the
  value back through it rather than trusting the write.
- **Report what happened, not what was attempted.** done / partial / failed
  comes from the result. `AVAIL.saveDays()` rejects with the database's own
  words and those are what the card shows — "HTTP 400" tells a scheduler
  nothing, "day shape rule violated" tells them what to change.
- **No write path means say so.** `DEVI_NO_WRITE` — *"I can prepare this for
  you, but I cannot save it yet."* — in those words, every time.

**What is wired to a real write:**

| Action | Writes through |
|---|---|
| Correct the availability warnings the calendar disproves | `devStampConfirmed()` → `c.ops`, the same stamp `confirmAvail()` writes |
| Re-read the tables and recalculate Needs Update | `AVAIL.forgetCoverage()` + re-prime (a recompute; writes nothing) |
| Create follow-up tasks | `state.tasks` |
| Mark a task complete | `setTaskStatus()` |
| Add a shift handoff note | `state.handoff.opener` / `.closer` |
| Post an internal scheduling note | `state.updates` |
| Record availability for given dates | `devAvailWrite()` → `carveSegs()` → `AVAIL.saveDays()` |
| Record a work preference / travel distance | `devSetPref()` → `ops.prefs` + its mirrors |

**What is deliberately prepare-only:** caregiver and family messages. Devi
drafts the wording and offers to save it as a handoff note or a task; it says
`DEVI_NO_WRITE` and does not pretend otherwise.

> **This changed shape on 2026-09-14 and the distinction now matters more, not
> less.** There IS an SMS channel in the dashboard — Find Coverage texts
> caregivers through Quo (see *Texting a caregiver from Find Coverage*). So the
> old reason ("there is no vendor and no secret") has gone, and the reason that
> remains is the stronger one: **Devi has no tools.** Nothing the model writes
> may reach a record, and a send is the most irreversible write in the app —
> a text cannot be unsent, it costs money, and it lands on a real person's
> phone. Every text this app sends is composed by a person, in a modal, with a
> named recipient list in front of them, and sent by them clicking Send.
>
> **Claude: do not wire Devi to `Quo.send`.** Handing a tool-less model its
> first tool, and making that tool an irreversible outbound message, is not a
> plumbing change. It is Carlo's, and it re-opens the whole safety argument
> under *What Devi can and cannot do*.

#### The warning that can actually be false

"Availability missing" is raised only when the month read says `none`, so it is
wrong only if that read is stale — which is what the refresh action is for.
The one that can be genuinely false is the **cadence** warning: "nobody has
checked in with this caregiver since X" is disproved whenever a *person* entered
rows for them after X. `monthCoverage().lastHuman` is that evidence, and it
**skips `Auto-copy`** — the monthly copy and the hourly re-carve write rows too,
and neither is somebody answering the phone. Without that filter this would
"confirm" a caregiver nobody had spoken to.

`devStampConfirmed()` deliberately does **not** set `ops.archived` / `ops.inPool`,
which `confirmAvail()` does. That is a scheduler saying "I spoke to them and they
are working"; an availability row is only evidence that somebody recorded their
hours. Claiming the stronger fact from the weaker one is the quiet overreach the
whole block exists to avoid.

#### Availability writes carve, exactly as the day panel does

**Claude: do not simplify `devAvailWrite()` into an `AVAIL.saveDays()` call.**
The carve is what stops Find Coverage offering somebody already on a Devoted
visit, and `dpSave()` refuses to write at all when the visits have not loaded —
`forDay()` answers `[]` for a FAILED fetch exactly as it does for a day with no
visits. This path loads `CGVISITS` first and gives up if they will not come,
for the same reason.

#### The instruction grammar is deliberately narrow

`dactCommand()` runs before the read router and answers only what is shaped like
an instruction: an opening verb, a message verb, or a named caregiver plus a
reporting verb. Everything else returns null, which is what keeps "which
caregivers have missing availability" — a question containing the word
availability — out of the write path. Verified: all fifteen daily read questions
still reach their own builders unchanged.

Everything it cannot read with confidence is **refused with the shape it does
understand**, never approximated — an unparseable date, a name matching two
people, a block under `AV_MIN_MIN`. Guessing which caregiver or which date was
meant is how the wrong record gets changed. `dvFindCg()` deduplicates by id
before calling a match ambiguous, because `state.caregivers` can hold one person
twice (a saved overlay outliving a roster swap is why `ROSTER.reconcile()`
exists) and two rows for one person is not a question worth asking.

### The key lives in a Supabase Edge Function

The first of the five in this repo — `quo`, `care-brief`, `comms-summary`
and `carenotes-summary`
followed; the AxisCare-facing backends are Netlify functions. It is there
because the `ANTHROPIC_API_KEY` secret is there.

| secret | note |
|---|---|
| `ANTHROPIC_API_KEY` | the local `.env` calls the same value `CLAUDE_API_KEY` |
| `CONCIERGE_MODEL` | `claude-opus-5`. `DEVI_MODEL` overrides it |
| `ALLOWED_ORIGIN` | see below — `null` is not what it looks like |
| `DEVI_EFFORT` / `DEVI_MAX_TOKENS` / `DEVI_SHARED_SECRET` | optional |

**A commit does not deploy it.** `index.html` auto-deploys to Netlify;
`supabase/functions/` needs `npx supabase functions deploy devi-agent
--project-ref gdzgoyawavffjdjpjbfz --no-verify-jwt` (the ref is not optional —
see *It lives in SUPABASE*). `deviAsk()` therefore falls back to the router's own answer
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

**Widened 2026-09-03**, because the old snapshot was three sections and Devi
kept answering "I can't see the availability table" — which the prompt was
literally instructing it to say. `deviContext()` now sends, on every Devi
question:

- today's date, the roster count, client **names and cities**
- the Today board's critical queue and its warnings (`buildWorkQueue`)
- open shifts (40) with client, city, times and how soon each starts
- the 20 most recent **attendance entries** — call-offs, no-shows, late, with
  caregiver, client and whether coverage is still needed
- the availability picture: who is due an update and when they last confirmed,
  who has Open days and how many, plus who has incomplete profile fields
- active caregivers with no assigned shift, and anyone at 38h+
- the 15 most recent schedule changes
- **care-note alerts** — missing/incomplete notes with client, caregiver and
  AM/PM, and the open critical/high alerts with a 110-character excerpt
- every active caregiver as name · base · open-day count · skills

Every section reads the SAME function the matching screen reads, so Devi and
the dashboard cannot disagree. Each list is capped (`DV_CAP`, 25 by default)
and says how many were cut — **an uncapped list is how this becomes a
100k-token request.** On the live roster the snapshot is roughly 30–40KB.

**This is a materially larger PHI surface than before.** It now includes care
note excerpts and attendance history alongside the names and cities it already
carried. The BAA question below has not moved; it got bigger.

**It is PHI, and the BAA question is SETTLED.** Carlo, 2026-09-23: *"The
Anthropic API that we have has the PHI contract."* That is the answer to the
question this section carried open for three weeks, and it covers the whole
key — `devi-agent`, `care-brief`, `comms-summary` and anything added after.
Mitch had already said the same on 2026-09-14 under *The care-needs line*; the
two statements disagreed and this is the one that stands.

**It does not make the snapshot free.** Everything else in this section still
applies: each list is capped, an uncapped one is how this becomes a 100k-token
request, and a router builder is always better than widening the snapshot. The
sibling Client Concierge function’s header still says *"point this at invented
data only"* on the grounds that adaptive thinking is not a BAA-covered feature
— that note predates the contract and is no longer the position here.

> Blanking `CONCIERGE_MODEL` or the function URL is **not** an off switch:
> `deviAsk()` degrades to the router’s own answer when the call fails, so the
> local router keeps working with nothing leaving the browser.

**The router is what makes that tolerable.** `aiNeedsAvail`, `aiOpenAvail`,
`aiLate`, `aiConflicts`, `aiMissingNotes` and `aiTodayFocus` answer the
questions the desk asks daily from the tables directly — exact, instant, free,
and nothing leaves the browser. Devi only sees a question the router could not
match. Adding a builder is always better than widening the snapshot.

Five more were added for the daily sweep: `aiCoverFirst` (which gap to work
first), `aiRepeatCallOffs`, `aiAvailNotScheduled` (open availability, no shift),
`aiFollowUp`, and `aiBadWarnings` — which re-derives every *Availability
missing* flag against `AVAIL.monthCoverage()` and names any it cannot
substantiate. That last one is the "verify before saying something is missing"
rule made answerable: the desk can ask the board to check its own warnings, and
the answer comes from the same function the screen reads.

`c.base`, not `c.city`: a caregiver record has no `city`. Getting that wrong
produced a dash on every line and Devi correctly reporting that nobody has a
city recorded.

## The PIN gate — `app-gate` is the only way to Supabase

Added 2026-09-18. **Claude: read this before touching any Supabase request.**

The dashboard opens on a PIN screen. Every table read and write, and every
photo upload or removal, is a POST to the `app-gate` Edge Function carrying the
desk PIN. `app-gate` checks it against the `APP_PIN` secret on **every** request
and only then does the work with the service-role key. The tables have RLS on
and **no anon policies**, so the anon key in `config.js` reads and writes
nothing by itself — it only gets a request past the Supabase gateway (`app-gate`
is deployed with JWT verification **on**, unlike the other five functions).

### The PIN is the credential, and it is sent every time

On a sibling app a browser with an empty local store pushed it over the shared
row and erased everything — 369 kB to 17 kB — with no way to tell which machine
it was and no way to stop it, because the key in the page was all it needed. A
PIN checked once at load would not have helped: that tab was already past the
gate. So:

- the PIN is remembered in `localStorage`, **once per computer**, and **sent
  with every request**. There is no session, no token and no "verified" flag.
  Somebody types it only the first time on a computer, and when it is wrong;
- **changing `APP_PIN` locks out every open tab on its next request** — the
  20-second poll at the latest — including one left open for days.

**Claude: do not replace this with a token, a cookie or a check at load.** A tab
past such a check could never be cut off, which is the whole point.

> **Once per computer since 2026-09-21**, at Mitch's request: it was
> `sessionStorage` (once per tab), and typing it in every new tab was the
> annoyance. Nothing about the check changed — it is still sent with every
> request, so a PIN change still locks out every computer. The tabs of one
> computer move together through a `storage` listener: a PIN accepted in one
> tab unlocks every tab on the lock screen, a stored PIN the server refuses is
> forgotten and locks the rest at once, and a refusal only ever forgets the PIN
> it actually sent, so a tab still carrying the old PIN cannot wipe the new one.
> A tab from before the change has its `sessionStorage` PIN moved across on
> reload. The trade-off is plain: anybody using that browser on that computer
> gets in until the PIN changes. Clearing the site data forgets it.

> **The PIN page appears only when it has something to say** (also
> 2026-09-21): no PIN on this computer yet, a PIN the server refuses, a
> network lockout, or a server that cannot be reached. A PIN already held is
> checked **silently** at load — a tiny script in `<head>` adds `pg-held` to
> `<html>`, which hides `#pingate` from the first paint, and `GATE.show()`
> removes it. The check itself is unchanged and still runs **before** anything
> starts, so this is fail closed exactly as before; it only stopped a PIN page
> saying "Checking…" flashing up on every refresh. Measured in the page test
> by counting every animation frame from the first: zero frames of the lock
> screen on a refresh with a good PIN. **Claude: keep the `<head>` key and
> `GATE`'s `KEY` the same** (`dcs_gate_pin_v1`).

```
npx supabase secrets set APP_PIN=<new pin> --project-ref gdzgoyawavffjdjpjbfz
delete from public.auth_throttle;      -- in the SQL editor: clears every lockout
```

Setting any secret restarts every function in the project (their version
numbers tick over; the code does not change). `APP_PIN` is also read per
request, so nothing can hold an old value.

> **A test PIN was set on 2026-09-18.** Change it before the desk relies on it,
> and use at least six digits — see the throttle below. Never write the PIN into
> this file or any other in the repo.

### How the page reaches it — `GATE`, at the top of the script

| | |
|---|---|
| `GATE.fetch(url, init)` | Drop-in for the old direct `fetch()` to `/rest/v1/…` and `/storage/v1/object/caregiver-photos/…`: same URL, same init. The answer is PostgREST's own status and body, relayed, so `r.ok`, `r.json()` and `r.status === 404` read exactly as before |
| `GATE.call(action, payload)` | Everything else. CLOUD's `dbHead` / `dbLoad` / `dbSave` / `dbCreate` use `state.head` / `state.load` / `state.save` / `state.create`, and return the `{data, error}` shape supabase-js did — the page no longer loads supabase-js at all |
| `GATE.start(fn)` | The last lines of the script. `CLOUD.boot()` and `AVNOTECLEAN.auto()` run inside it, **only once a PIN is accepted**: boot reads profiles, care notes and the open-shift mirror before its baseline snapshot |
| `GATE.onUnlock(fn)` | Re-sync after a lock: CLOUD's `resume()`, and AVAIL and NOTES dropping reads that failed only because the tab was locked |

The lock screen (`#pingate`) is the first thing in `<body>`, visible from the
first paint. With **no Supabase config** there is no gate and the app runs
locally exactly as before. `GATE.status()` in the console says what the tab is
doing; it never returns the PIN.

**A 401 or 403 from `app-gate` always means the PIN** (or the page's key). The
tab forgets the PIN it sent, the lock screen comes back, and nothing syncs:
`GATE.call` refuses without touching the network, and CLOUD's poll and saves go
quiet. For that to stay true `app-gate` reports an upstream 401/403 as 502 and
an upstream 429 as 503, and refuses a request it does not allow with **400 —
never 401, 403 or 404** (NOTES and CGPHOTO read a 404 as "already gone").

### Rules that each fixed something real

- **Unlock is IN PLACE, never a reload.** The first version reloaded, and a
  reload loses exactly what the lock interrupted: an open editor, a save refused
  at the moment of the change, and — silently — a CLOUD *patch* whose push hit
  the 401. `finishBoot()` seeds `lastSent` from the local cache, so the unpushed
  edit counts as already agreed and the server's older copy overwrites it.
  Caught in adversarial review; the page test now edits a caregiver's cadence to
  Weekly over the server's Monthly, lets the PIN change refuse it mid-flight, and
  checks Weekly lands after the unlock.
- **429 is the network, not the PIN.** A tab that holds a PIN keeps it and
  re-checks it when the lockout runs out. Only a 429 saying `locked` locks.
- **An empty copy is refused — but the rev comes first.** `state.save` refuses
  an overlay with no records over one that has them (`422 empty_refused`) unless
  `force` is set, which only `CLOUD.reset()` sends. A fresh tab's first save,
  900 ms after boot, is an empty overlay on rev 0; that must stay the harmless
  conflict it always was, so a stale rev answers 409 before the emptiness is
  looked at. The page maps 422 to the conflict path too, so a tab that somehow
  holds nothing reads the board before it writes.
- **`scheduler_state` is not reachable through the relay.** Its writes must pass
  the empty-copy guard and the rev check, and a generic relay would go round
  both.
- **The relay is an allowlist of exactly the requests `index.html` makes** —
  table, method and body columns (`ALLOW` in `supabase/functions/app-gate/index.ts`).
  No embedded `select`; a PATCH or DELETE needs a filter; `caregiver_profile`
  takes only `employment_status`; the `caregiver_availability` PATCH takes only
  `{note: null}`. **A new Supabase request in `index.html` needs a line in
  `ALLOW` too**, or it fails with `400 not_allowed`. That is the *seven lists*
  lesson again, and here it is the point.
- **The dashboard is `inert` while locked**, so nobody types into a hidden note
  or presses a button they cannot see.
- **A tab left on the lock screen through a deploy boots the NEW build.** The
  first unlock compares the page's ETag with the one it loaded and reloads if it
  moved; otherwise CLOUD's stale-build guard would take the new build as its
  baseline and never notice. (CLOUD's own check still runs after boot.)
- **Care-note text goes through `escText()`.** It is written by caregivers in
  AxisCare — people outside the desk — and three places drew it with `esc()`,
  which only escapes `"`. A note carrying markup ran as script in every tab that
  opened the alert, and since the gate that script could read the PIN. Fixed in
  the alert list, the alert detail and the related notes, with a page test.

### The throttle — distinct wrong PINs, decided in one atomic call

`public.auth_throttle` and `gate_check()` (`supabase/app-gate.sql`, section 10 of
`schema.sql`). Eight **distinct** wrong PINs from one IP in 15 minutes lock that
IP out for 15 minutes — a right PIN included, so a locked caller learns nothing.

- **Distinct, not requests.** The desk shares one office IP, and a PIN change
  makes every open tab fail several requests at once. Counting requests (the
  reference design) locked the whole office out, including whoever typed the new
  PIN. The stored keys are HMACs keyed with the service key.
- **One SQL call decides, under the IP's row lock.** Reading the lock and
  recording the failure as two calls let a burst of simultaneous guesses all pass
  the read. Measured against the deployed function: 40 simultaneous guesses, the
  right PIN among them — **8 compared, 32 answered 429**, the right PIN included.
- **A right PIN does not clear earlier failures** (the reference did): the
  desk's polls would reset the count for anybody else on that network three
  times a minute. Failures age out with their window.
- **The IP is `cf-connecting-ip`.** Measured 2026-09-18 with a throwaway echo
  function: the edge *replaces* a forged `X-Forwarded-For` and refuses a forged
  `cf-connecting-ip` (Cloudflare error 1000). `Forwarded` passes through
  untouched and is never read. A request without `cf-connecting-ip` shares one
  bucket. (The other five functions' comments say `X-Forwarded-For` is
  caller-written; on this project's edge it is not.)

### What it costs

Every Supabase read now goes browser → Edge Function → PostgREST: measured
0.6–1.6 s a request against ~0.2 s direct, and `state.load` of the 1.34 MB row
1.5–4 s. The 20-second poll is one small `state.head`. Every request is one
function invocation — well inside the Pro plan's included 2 M a month at the
desk's volume.

### The lock — deploy first, lock second

1. `app-gate` deployed, `APP_PIN` set, throttle created — **done 2026-09-18**.
2. The owner deploys `index.html` (commit → Netlify).
3. Confirm the live site serves it: view-source contains `var GATE = (function`.
4. **Every desk browser reloads.** A tab still on the old build reads `[]` once
   the lock is on — Find Coverage would say nobody is available — so before
   locking, check the Supabase API logs show **no anon `/rest/v1` traffic** for
   ten minutes.
5. Run `supabase/app-gate-lock.sql`. It is one transaction, and it refuses to
   commit while any anon policy remains or any table has RLS off.
6. Verify with the anon key: a read returns `[]`, a write 401.

`supabase/app-gate-unlock.sql` reverses it exactly (generated from the
pre-change backup of the policies). **Restoring a database backup rolls the lock
back too** — re-run the lock after any restore. `schema.sql` is now safe to
re-run: it creates no anon policy, and its section 11 fails loudly if one exists.

### What the PIN does not cover — yet

- **The AxisCare proxy** (`/.netlify/functions/axiscare`) and the other four
  Edge Functions still answer anyone with the URL, exactly as before. The PIN is
  the credential they were missing — the page already holds it — so putting them
  behind it is the natural next step. The proxy is Carlo's (see *Who does what*).
- **Caregiver photos are read from a public URL**: an `<img>` cannot send a PIN.
- **The PIN sits in `localStorage`** (once per computer), so any script injected
  into the page can read it. Text from outside the desk must go through `escText()`, never
  `esc()` — see *Three traps* under Ask Devi.

---

## Known and accepted — don't re-flag these

**Claude: these are deliberate decisions, already reviewed. Mentioning them once
in context is fine; treating them as bugs to fix is not.**

- **The dashboard has no per-person login.** Since 2026-09-18 it opens behind
  one shared desk PIN (see *The PIN gate*), which is the credential for every
  Supabase read and write. Per-person logins are still not built — accepted for
  an internal MVP.
- **The AxisCare proxy does not check who is calling.** Someone with the site
  URL could pull real client data from it directly. Reviewed and accepted on
  2026-08-21 while the app is in development and the URL is known only to the
  team. It is written up in `README.md` under *Security posture*, with the
  trigger for revisiting it and the ten-minute fix.
- **Caregiver photos are readable by anyone with a photo URL.** The bucket is
  public because an `<img>` cannot send a PIN. Replacing or deleting one used to
  be open to anyone with the link too (anon write policies, 2026-09-07); since
  the PIN gate those go through `app-gate`. See *Uploading and removing a
  photo*.

None of these is an oversight, and none needs raising again unless the situation
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
- **Supabase never talks to AxisCare.** It stores the scheduler's own work and
  two mirrors of AxisCare data (`care_notes`, `open_shifts`), which Netlify
  functions write. The Edge Functions reach the roster only through the public
  Netlify proxy, and no Supabase secret is an AxisCare token. If an AxisCare
  question seems to need a Supabase change, the approach is off — unless it is
  one of those two mirrors.
- **A blank field is usually empty data, not a bug.** Try a second record. One
  blank is usually genuinely empty; every record blank is usually a wrong key.

---

## Don't break these

`index.html` is safe to edit freely, with the exceptions below. Full detail is
in `README.md` under *How the data model works*.

0. **`GATE` (top of the script) and `app-gate` are the only way to Supabase.**
   No `fetch` to `/rest/v1` or `/storage/v1` anywhere else, no Supabase client
   library, no anon policy on any table. A new Supabase request goes through
   `GATE.fetch` **and** needs a line in `app-gate`'s `ALLOW`. The PIN is sent
   on every request and is never replaced by a token. See *The PIN gate*.

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

    **The ICON is part of the claim.** Both said "Loading open shifts…" under
    `emptyState()`'s green tick, which means "we looked, and there is nothing
    to do" — the one thing a loading screen has not established. Reported by
    Carlo on 2026-09-22; `loadingState()` is the same card with a spinner and
    no green. Use it wherever the answer is still arriving.

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

3c-2. **A record AxisCare did not return this load must not lose the desk's
    work — `CARRY`, and no `dels` on a patchOnly slice.**

    `buildOverlay()` rebuilds the overlay WHOLE on every save: it is a diff
    of current state against `BASE`, never an increment on what is stored.
    So a caregiver who is not in `state.caregivers` when a save runs emits
    no patch, and that save writes a shared row without one. Their review
    cadence, work preferences, notes, flags and client blocks are gone, for
    every scheduler, with no per-field tombstone to recover from.

    `state.caregivers`, `state.clients` and `state.shifts` are assigned in
    exactly one place — `ROSTER.hydrate()` — and nothing in the app removes
    a record by hand, so "not in front of us" ALWAYS means AxisCare did not
    return it on this load. Three ordinary ways that happens:

    - the roster fetch failed, and the boot kept the seed roster
    - it came back short, so the 3c plausibility guard threw and did the same
    - AxisCare stopped listing that caregiver as Active

    One scheduler with a bad fetch, whose tab then autosaved — which every
    tab does — was enough to wipe the desk's work for everyone missing from
    that read. **That is why some caregivers kept their cadence and others
    lost it: the survivors were the ones present on the load that saved.**

    Two halves, and both are needed:

    - **`CARRY`** holds the last patch known for each record on a patchOnly
      slice, seeded by `applyOverlay()` from every overlay that arrives —
      including patches it could not apply because the record was absent.
      `buildOverlay()` re-emits a carried patch for any id not currently in
      state. A record it CAN diff always wins and corrects the carry, so
      this never resurrects a value somebody has since changed: setting a
      cadence back to No Cadence still saves as null.
    - **`dels` are refused on patchOnly slices**, on the way out and on the
      way in, exactly as stray adds already were. "In BASE, not in state"
      means the same short read, and writing it as a deletion told every
      other browser to drop that caregiver from the roster at boot,
      permanently. Refusing them on the way in is what repairs a row that
      already carries some, and it self-cleans: with the dels ignored, state
      matches BASE and the next save writes an overlay without them. It also
      closes the `dels.shifts` half of the 2026-09-03 leak, where a real
      coverage gap was silently hidden.

    Measured before and after, on a boot where the caregiver was absent
    before `BASE` was taken (a failed read, exactly):

    ```
    before   patch survived the save: NO    -> "No review cadence" / "Not scheduled"
    after    patch survived the save: YES   -> "Monthly" / next 2026-10-07
    ```

    **The review cadence has no database column of its own.** It is
    `ops.availCheckFreq` (plus `ops.customCadenceDays`) inside the
    `scheduler_state.overlay` JSON, like every other scheduler-entered
    caregiver field. **The next review date is not stored at all** — it is
    derived by `nextReview()` from `availLastConfirmed` plus the cadence,
    deliberately, so there is no second field to drift. `applyCadence()`
    stamps both, and they ride the one patch; fixing the patch fixes both.

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

3g. **A person's delete must record a tombstone — `cloudForget()`.**

    **Reported by the desk 2026-09-15:** a deleted Note, Client Feedback and
    Client Complaint came back about a second later, and deleting them again
    made them stay. Not a glitch.

    On the keyed, non-`patchOnly` array slices (`cgNotes`, `cgConcerns`,
    `attendance`, `guides`, `offerTemplates`, `tasks` and the rest), every
    record the desk creates is **never in `BASE`** — those slices start empty
    and `BASE` is taken before the overlay is applied. So `buildOverlay()`
    never emitted a `del` for one: a delete travelled **only by omission**,
    and `applyOverlay()` adds any id a tab does not hold. Measured by running
    the real module in simulated tabs:

    - **~250ms** — the delete's push hit a rev conflict (another tab had
      saved), `push()`'s `pull(true)` re-added the record, and the retry
      pushed it back. The retry left `serverRev` current, which is exactly
      why the second delete stuck.
    - **20–40s** — any other open tab still holding the record pushed it back
      on its next save, and a background tab did it on focus.

    **The fix is tombstones.** `CLOUD.forget(path, ids)` — reached through
    the global `cloudForget()` — records the id in a module-level `GONE` store.
    `buildOverlay()` emits **every** tombstone in `dels` on **every** save;
    `applyOverlay()` learns every incoming del, filters held records by all of
    `GONE`, and refuses any add whose id is in it. Tabs still on the old code
    already honour `dels` on these slices, so they drop the record on their
    next poll without a refresh.

    **Wired at every place a person deletes a record from these slices** — an
    audit of the whole file on 2026-09-15 found exactly four, and no archive
    move or size cap anywhere:

    | Delete | Slice | Function |
    |---|---|---|
    | Note, Client Feedback, Client Complaint | `cgNotes`, `cgConcerns` | `cgEntryDel` |
    | Attendance row | `attendance` | `delAttEntry` |
    | Guide / infographic | `guides` | `deleteGuide` (reads the id before it is cleared) |
    | Auto-Offer template | `offerTemplates` | `aoDeleteTemplate` |

    **Claude: a new delete button must call `cloudForget()`.** This is the
    *seven lists* lesson again: miss it and that delete comes back, with no
    error anywhere.

    Six rules, all load-bearing:

    - **Only from intent, never from absence.** A tombstone is permanent. Do
      NOT call it where a record is removed and re-added under the same id —
      `cgProfSet`, `ratingSave`, `saveAttEntry`, `saveGuide` — or the caregiver
      becomes permanently unratable or unprofileable on every tab.
    - **Never pruned.** Every tab must emit the identical set, or `lastBody`
      (3d) never matches and idle tabs trade revisions forever. Pruning by
      each tab's clock is exactly that. Ids are unique and short.
    - **Keyed, non-`patchOnly` arrays only** (`tombSlice()`). `patchOnly`
      slices still refuse dels both ways (3c-2); maps, scalars and `sig`
      slices take none.
    - **No id-less tombstones** (`tombId()`). Escalations have no id, so every
      one reads as `'undefined'` — a tombstone on it would delete them all and
      refuse every future one. `'undefined'`, `'null'` and `''` are refused
      when recorded and when learned from an incoming del.
    - **Code must never remove an in-`BASE` record from these slices.**
      `applyOverlay()` learns every incoming del, including a base-diff del, so
      such a removal becomes a permanent tombstone. System tasks (`sys_…`) are
      in `BASE` with recurring ids — do not prune them that way.
    - **A record deleted here needs a STABLE id.** The 11 built-in guides took
      `gGid()`, a new random id on every load in every tab, so a delete could
      never be matched and came straight back. They now carry fixed
      `gseed-…` ids. Never change or reuse one. A future seed list that is
      deletable needs the same.

    #### Found in the adversarial review, and fixed before deploy

    - **`doSave()` does nothing before `finishBoot()`.** `CLOUD.save()` never
      checked `booted`; with `BASE` still null it built an EMPTY overlay and
      `saveLocal()` wrote it over the local cache finishBoot was about to
      replay — unpushed work gone. `deleteGuide` made that reachable from the
      guide library during boot. Every legitimate save runs after boot, and a
      tombstone recorded before boot goes out with the first save after it.
    - **An edit to a record another scheduler just deleted says so.** Deletes
      now reach an open editor's tab, so `cgNoteSave`, `cgFbSave`,
      `saveAttEntry` and `saveGuide` found nothing and still toasted "saved".
      They now say the entry was deleted and keep the editor open; a guide
      draft can be saved again as a NEW guide.
    - **Auto-Offer opens with zero templates.** The "keep at least one" guard
      counts only this tab, so two schedulers deleting the last two leave
      none anywhere — and `openAutoOffer` threw on `def.id`. It now opens with
      an empty message so a new template can be saved from inside it.

    #### What it does not cover — tell the desk

    - **Edits** to an existing record can still be reverted by another tab's
      stale copy. That is the planned follow-up (step 2) — likely by moving the
      busiest slices into their own tables, the way availability already is.
    - **Removing a sub-entry inside one record** — *Re-queue* in a shift's
      contact log (`dispReopen`), *Remove* on a medication (`removeMed`), a
      client block (`cbRemove`) — travels as a whole value, last writer wins.
      A tombstone cannot address it.
    - **Deletes made before this deployed** were never recorded. Delete again.
    - **A misclick is permanent.** The attendance, guide and template deletes
      have no confirm step (Notes and Feedback/Complaint do). The original id
      cannot come back: removing the del from the shared row is undone by any
      open tab within one poll, and by any browser whose local cache holds it
      when it next opens. **To restore a mistaken delete, re-add a copy of the
      record to `overlay.adds.<slice>` under a NEW id** and leave the del where
      it is; every tab picks it up on its next poll.
    - **A del written into the shared row by hand is a permanent tombstone.**
      Never repair a record with a del plus a same-id add — use a `patches`
      entry, or re-add it under a new id. (The 2026-09-15 cgConcerns repair
      under *The Caregiver Overview* predates this rule.)

    #### Deploying it — the old-tab exchange

    An old-code tab cannot emit a tombstone, so once one exists the old tab
    strips it from every row it writes, a new tab puts it back, and the two
    trade full-overlay writes (~1.3MB each) until the old tab stops. The
    stale-build guard normally stops it within ~60s — but NOT in a tab opened
    before the guard existed (2026-09-07), nor one whose first `checkBuild()`
    ran after the deploy landed. Measured with an unguarded old tab: 6 writes a
    minute from each side, indefinitely. So for this deploy:

    1. As soon as Netlify shows it live, **every desk browser reloads** — not
       "check for the banner": an unguarded old tab shows no banner.
    2. **Nobody deletes** a Note, Feedback/Complaint, attendance entry, guide
       or template until everyone has reloaded.
    3. If `rev` in `scheduler_state` climbs every ~10s with `updated_by`
       alternating between two people while nobody is working, an old tab is
       still open. Find it and reload it.

    Before deploying, the live row was checked read-only (rev 6417): **no dels
    on any slice**, so nothing already stored becomes an unexpected tombstone.

    **Verified** by `tombstone-harness.js` in the session scratchpad, which
    runs the real CLOUD module, state initialiser, delete and edit-save
    functions from the working tree and from the committed snapshot in one vm
    context per tab: **23 failures before the call sites were wired; 62
    passes after the review fixes** — the conflict path, another open tab, a
    hidden tab, three timing races, rapid deletes, a stale-cache boot, old and
    new tabs during rollout (before and after the stale guard), all four real
    delete buttons, id-less escalations, a save and a delete during boot, an
    edit to a deleted record, templates racing to zero, and two idle tabs
    making no writes.

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

> **Pausing Netlify does not stop this.** Netlify only serves the HTML;
> pausing it stops new page loads and does nothing about the already-open
> tabs, which are the ones writing.
>
> **Since 2026-09-18 there is an off switch that does: change `APP_PIN`.**
> Every open tab is refused on its next request and stops writing, whatever
> it holds in memory, and nobody gets back in without the new PIN. It still
> buys a window rather than a fix — a tab that holds bad records re-sends them
> once unlocked — but it stops an unidentified browser on the spot, which
> dropping the old anon policy never did cleanly. See *The PIN gate*.

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
  in the intervening hour → **`o.dels`**. At the time `dels` was **not**
  gated on `patchOnly`, so `clients` and `caregivers` produced them too

Both are then replayed by `applyOverlay()` on every future boot for everyone:
AxisCare-derived data written to the shared row as though a scheduler typed it,
and a real coverage gap silently hidden. Same family as the 323KB bug in 2.

> **Neither half of that is true any more.** `buildOverlay()` emits no `dels` for
> a `patchOnly` slice and `applyOverlay()` refuses any it is handed, which is
> what repairs a browser already carrying one — the local overlay is replayed
> at boot before any server pull. And `shifts`, `caregivers`, `clients` and
> `careNotes` are **all** `patchOnly`, so none of them can emit a del at all.
> `careNotes` was the last one added, on 2026-09-03; it was next in line to do
> exactly what `shifts` did.

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

6. **`state.onShift` is PER BROWSER and must never go back into `SLICES`.**

   It is the name stamped on everything the desk writes — caregiver notes,
   `ops.lastUpdatedBy`, availability confirmations, task completion, call-offs,
   ratings, client blocks — read in about 60 places. Until 2026-09-11 it was the
   literal string `'Mae'`, set once and **written by nothing**, so every
   scheduler's work was attributed to Mae whoever was actually typing.

   It was also a tracked CLOUD **scalar** slice, which was harmless *only*
   because nothing wrote it. A scalar is assigned straight onto `state` by
   `applyOverlay()` on every poll, so the moment a picker writes it the desk has
   **one** selected person: Mae choosing "Mae" while Carlo chooses "Carlo" means
   each selection is overwritten by the other within 20 seconds — the dropdown
   visibly flipping, and work stamped with whoever wrote last.

   So it now lives in `localStorage` under `dcs_on_shift_v1`, and the slice is
   gone. Any value still sitting in the shared row is inert (nothing reads a path
   absent from `SLICES`) and the next save drops it.

   The picker's list, `SCHED_PEOPLE`, is **deliberately separate from
   `state.schedulerNames`** — Mitch, Sean, Carlo, Mae, Jen, Angelica, Patty,
   Tine. `schedulerNames` is shared, still `['Mae','Sunshine','Kristine']`, and
   is what task assignment and the shift handoff read. Sunshine has left and
   Kristine is recorded as Tine here, but their past work is correctly stamped
   with the names they used, and rewriting that list would not change those
   records anyway. Carlo's call, 2026-09-11.

   > Two small rules in `whoamiLoad()` are worth keeping. A stored name that is
   > no longer in `SCHED_PEOPLE` **falls back to Mae** rather than being trusted —
   > the value outlives the list, and stamping work with somebody who has left is
   > the failure the picker exists to end. And every storage access is wrapped:
   > a private window throws on `localStorage`, and that must not take the app
   > down. **Mae stays the default** rather than an unset dash, because the dash
   > would land in the record as the author and mean nothing to whoever reads it
   > back months later.

Two smaller notes for anyone wiring real data later: several places derive values
from the numeric part of a demo id (`parseInt(c.id.slice(1))` on `'c7'`), which
AxisCare ids would break; and AxisCare city strings are dirty — `CAMARILLO`,
`Camarilllo`, `"Oxnard "` and `oxnard` are four distinct values today.

> **Corrected 2026-09-08.** This paragraph used to end "and around 40% of active
> caregivers live outside Ventura County so they are absent from the app's
> distance map." That is wrong by about four times, and it mattered, because it
> made the distance term look hopeless when it is nearly fine. `normCity()`
> already cleans the dirty strings *before* `miles()` sees them, so the dirt is
> not what moves anyone down the list. Measured on the live roster: **8 of the
> 104 schedulable caregivers** live in a city the 12-entry `CITY` map does not
> know — not ~40. Seven of the eight have Open availability typed, so it is a
> live problem, just a small and fixable one: add their cities to `CITY`.
>
> **Superseded 2026-09-21:** drive time comes from `DRIVE_TIMES` now, which
> already knows every home city on the roster except *Los Angeles* — and
> since 2026-09-22 those are placed by postcode, see *When the city cannot be
> placed but the postcode can* — (too broad
> to map) and one blank address. Add a new city to `scripts/drive-times.js`,
> not to `CITY` — that map is only the Location picker's list any more.

---

## A deploy does not reach an open tab — say "hard refresh"

**Claude: when a fix is deployed, it is not running for anybody who already
has the dashboard open. Tell Mitch to have the desk hard refresh, every
time. If a bug looks like it survived the fix, check this first.**

Netlify replaces what the server sends. It does not replace the JavaScript
already running in a scheduler's browser, and that tab keeps writing to the
shared `scheduler_state` row with its old logic.

This has cost real work twice, both on 2026-09-07:

- An import of 17 client blocks was wiped, twice, by a session that had been
  open since before the import.
- A fix to `pull()`'s re-layer went live at **15:21:40**. A tab opened
  beforehand was still reverting other schedulers' work at **15:24:59** — so
  the fix looked broken when it simply was not running yet. Three minutes,
  and it cost an afternoon of confusion.

The tell is always the same: **a change is saved, looks right, and comes back
a few seconds later**, on every machine, with no error and the sync pill
still reading Synced. Reloading the page that made the change does not help,
because the session undoing it is somebody else's.

### The guard

`checkBuild()` in the CLOUD block asks the server what it is serving now
(HEAD, ETag then Last-Modified) and compares it with what this tab loaded. On
a mismatch `markStale()` fires and the tab:

- **stops writing to Supabase** — `doSave()` returns after `saveLocal(o)`,
  so nothing typed is lost and `finishBoot()` replays the local cache on the
  next load, under the new code
- shows a fixed red banner naming the exact keystroke — **Ctrl+Shift+R** /
  **Cmd+Shift+R** — with a Hard refresh button
- reads **Refresh needed** on the sync pill

Stopping the write is the load-bearing half. A banner alone is advisory, and
the whole failure is that the tab keeps saving.

A host that answers neither ETag nor Last-Modified — `file://`, a failed
request, an offline laptop — leaves the guard **off** rather than guessing.
That is no worse than before.

### When a fix keeps coming back

If something is reverting and you cannot see why, the answer is almost always
an old session, not a bug in the fix. In order:

1. Have every scheduler hard refresh. One un-refreshed tab is enough.
2. Only then re-check whether the fix worked. Re-run any data import
   afterwards — an import written before the refresh can still be wiped.
3. `CLOUD.forceRefreshNotice()` raises the banner by hand for any reason,
   not only a new deploy, and `CLOUD.isStale()` reports whether this tab has
   already stopped writing.

**Never conclude a fix failed until the desk has refreshed.** That mistake
was made in this repo and led to a second "fix" being written for a bug that
was already fixed.

### The trap that fix itself fell into

`lastSent` — the overlay this browser and the database last agreed on — must
be a **detached snapshot**, never a reference. `buildOverlay()` writes the
live object straight into the patch (`diff[f]=r[f]`), and `applyOverlay()`'s
`revive()` mutates in place and returns the *same* object, so after a pull
`c.ops` and `overlay.patches.caregivers[id].ops` are one object. The app then
edits ops in place (`c.ops.maxMiles = …`), which silently edited `lastSent`
too — `unsentOnly()` compared a record against itself, found no difference,
dropped it from the re-layer, and the incoming overlay wrote the older copy
over the scheduler's edit. **The same silent loss the change existed to
stop, arriving through the drop side.** Caught in review before it did more
damage; `detach()` is the fix, and `BASE` has always taken the same
precaution by storing `sstr()` strings.

Anything that remembers a piece of overlay for later comparison has this
problem. Snapshot it.

## Sync status — what the pill in the top bar means

| Pill | Meaning |
|---|---|
| **Synced** | Saved and shared with the other schedulers |
| **Saving** | Write in flight |
| **Local** | No Supabase keys — saving to this browser only. **Carlo.** |
| **Offline** | Database unreachable. Work is still saved locally and pushed on reconnect. |
| **Sync error** | Hover it for the reason. If everyone sees it, **Carlo.** |
