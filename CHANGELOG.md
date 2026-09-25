# Changelog

## 2026-08-24 — from static prototype to live AxisCare data

The dashboard began the day as a self-contained HTML prototype with invented
sample data and no deployment. It ended it reading live caregivers, clients,
open shifts and care notes from AxisCare, with a shared Supabase store and a
Netlify deployment.

---

### Deployment

- **Netlify + Supabase setup** — `netlify.toml`, `scripts/build-config.js`
  (generates `config.js` from environment variables at deploy time, so keys are
  never committed), `.env.example`, `404.html`.
- **`supabase/schema.sql`** — `scheduler_state` for the scheduler's own work,
  plus row-level security.
- **`scripts/dev-server.js`** — a zero-dependency local server that runs the
  *real* Netlify functions from `.env`. Added because `netlify dev` needs an
  account and a linked site, and opening `index.html` from disk can never reach
  `/.netlify/functions/…`.

### The AxisCare connection

The API was undocumented to us at the start of the day. Three things had to be
found before anything worked:

- **Auth is `Bearer`, always.** Every other scheme returns a 500 HTML page.
- **`X-AxisCare-Api-Version: 2023-10-01` is a required header.** Its absence
  returns `400 "Unsupported version"`.
- **That version check runs before authentication**, so a wrong version masks a
  bad token entirely — the token cannot be judged until the version is right.

The spec itself was found at `/api/documentation.html`, a Stoplight viewer over
a machine-readable OpenAPI file at `/api/stoplight/reference/api.yaml`.

`netlify/functions/axiscare.js` proxies reads so the token stays server-side —
a browser could not call AxisCare directly in any case.

### Data model — why the seed is not saved

Caregivers, clients and shifts were generated relative to `NOW` on every load.
Saving the whole state object would have frozen those clocks: "starting in 3
hours" would read as yesterday afternoon the next morning.

So the app saves a **thin overlay** — added, deleted and edited records only —
and replays it over freshly generated data. Demo timing stays live; real work is
durable.

Two bugs that cost real time, both now covered by regression tests:

- **Baseline snapshot taken too early.** Some `ops` fields are created lazily the
  first time a view touches them, so they read as human edits. The overlay grew
  to **323KB** — the entire roster written to Supabase as though someone had
  typed it. Fixed by rendering once before snapshotting: 323,303 → 63 characters.
- **A saved overlay resurrected deleted caregivers.** `applyOverlay` runs after
  hydration, so it put back ids that no longer existed and crashed the Today
  board. Fixed with `ROSTER.reconcile()` after every overlay application.

### Live data

| | Count | How |
|---|---|---|
| Caregivers | 184 active | `statuses=Active`, 2 requests, ~1.7s |
| Clients | 20 active | 4 requests |
| Open shifts | 3 | derived — see below |
| Care notes | ~111 | swept into Supabase on a schedule |

**Open shifts have no AxisCare record.** They are derived: *a visit that is not
removed, has no caregiver, and is scheduled in the future.* That returns exactly
the shifts the previous dashboard displayed.

**Care notes are swept, not fetched.** A caregiver's shift note exists only on
`/api/visits/{id}.careNote` — one request per visit, ~170 for a week. A live
fetch would be slow for one person and would put the team over AxisCare's
limits. `netlify/functions/carenotes-sync.js` sweeps them into Supabase on a
schedule; the dashboard reads the mirror and makes no AxisCare calls for notes.

### Honesty about gaps

Reliability, hours worked, call-off counts, verification history on caregivers;
`reqSkills`, `risk` and `hasBackup` on clients — none exist in AxisCare. They are
`null` and render **"Not tracked"** rather than a plausible number. Real names
beside invented reliability scores is how someone ends up staffing on fiction.

Two traps that had to be fixed for this to work: `null + '%'` renders `"null%"`,
and `null < 85` is **true** — which briefly flagged all 184 caregivers as
performance concerns on evidence that did not exist.

Sample data is cleared at boot and can be restored with `DEMO.on()`. Every
screen carries a banner saying where its data came from: live, sample, partially
failed, unreachable, or no AxisCare source at all.

### Documentation

- **`CLAUDE.md`** — written for Mitch's Claude, which has GitHub access but no
  backend. Lists every field AxisCare actually provides so nothing is guessed,
  names what does not exist, and marks the sample-data banners as deliberate so
  they are not "tidied away".
- **`README.md`** — setup, data model, local development, troubleshooting,
  security posture.

### Two corrections worth recording

**"Open shifts do not exist in AxisCare" — wrong.** That conclusion came from a
`/api/visits` window that silently truncated to three days *in the past*, where
every unassigned visit happened to be a cancellation. A biased sample, stated as
fact and written into both documents before Carlo questioned it. The truncation
behaviour is now documented as a trap in its own right.

**The care-note skip logic under-matched.** It compared a local calendar day
against `timestamptz` values carrying a `-07:00` offset, so evening visits landed
on the next UTC day and were re-fetched every run. Replaced with a single id-set
lookup: skips went 61 → 91 per run.

### Accepted risks

Recorded in `README.md` under *Security posture*, with triggers for revisiting:

- No login. Anyone with the URL can open the dashboard.
- The AxisCare proxy does not authenticate its caller, so anyone with the site
  URL can read client data through it.

Both were reviewed and accepted while the app is in development and the URL is
known only to the team.

---

## 2026-08-25 — the caregiver calendar shows real work

Each caregiver's month grid now plots **their own assigned client visits** from
AxisCare: one block per visit, labelled with the client and the scheduled times.
Until now `state.shifts` held only *unassigned* visits, so the block that was
built to show an assignment had nothing to show and every caregiver's month was
blank.

- Fetched on the first render of a caregiver's calendar, not at boot — nobody
  who never opens a profile should pay for it.
- One request set covers one month back to twelve forward, so the month arrows
  (clamped to that range) cost nothing after the first load.
- Cached outside `state`, so CLOUD never mistakes several hundred visits for
  work a scheduler typed.

**`caregiverIds` filters; nothing else does.** `caregiverId`, `caregiver`,
`employeeId` and `caregiverExternalId` are accepted with a 200 and silently
ignored — the sort of thing that looks like it works until a caregiver's
calendar shows somebody else's clients. Using the filter turned a month of
everyone's visits (932 records, 11 requests, ~7s) into one caregiver over
fourteen months (351 records, 4 requests, ~2.3s).

**An empty calendar arrives as a 404.** `{"errors":["No visits found"]}` means
zero results, not a failure — and it is the common case: 126 of 184 active
caregivers have no visits in the current month.

Two bugs found by testing rather than by reading:

- **Times lost their minutes.** `_h12()` did `hr = h % 12` on a decimal hour, so
  14.5 rendered as `2.5p`. Demo shifts were always on the hour; 64 real visits
  this month are not. Now `2:30p`.
- **A "date" that was a Date.** `fmtDateShort()` takes a `YYYY-MM-DD` string and
  appends the time itself, so passing it a `Date` produced *"Invalid Date –
  Invalid Date"* on the calendar. Only the live run caught it — the unit test
  had asserted the visit count and not the label beside it.

A third, reported by Carlo once real names were on screen: **long client names
pushed the month past the panel edge.** Three separate things each refuse to
shrink below their content and all three had to be undone — `1fr` is
`minmax(auto,1fr)`, a flex item defaults to `min-width:auto` (at both the cell
and the block), and `text-overflow:ellipsis` does nothing without
`overflow:hidden`. The name now truncates; the time never does, so a shift
always reads its hours. The full name is on hover — which is why the label had
to be escaped, since a real client here is `Raymond "Nacho" Banales Jr.` and an
unescaped quote would have ended the attribute early.

The whole calendar suite runs twice, on Pacific and on Asia/Manila, and must
agree. Visit times are read straight off the AxisCare string rather than through
`new Date()`, so a visit belongs to the day AxisCare says it does and not the
day the viewer's laptop thinks it is.

---

## 2026-08-25 — availability is edited where you see it

**Step one of a larger overhaul.** Editing a caregiver's availability used to
mean leaving the calendar: a header button, or an Edit button on one of two
summary cards, all landing on the same full-page *Calendar Availability* screen.
Now you click the day you care about and edit it in the side panel.

Removed: the header **Edit Availability** button, the **Regular Weekly
Availability** and **Time Off & Changes** summary cards, and the full-page screen
itself (`availCalForm`) along with its tile in the edit chooser. **Desired
Hours** stays, as do Preferences and Client Restrictions.

The three cards — weekly rules, vacation, one-off changes — moved into the
panel **keeping their element ids**. `saveAvailability()`, `ruleStatusChange()`,
`ruleWinChange()`, `addOverride()` and `removeOverride()` all address their
controls by id, so they work unchanged; only the layout is new. At 390px a day's
four dropdowns cannot share a line, so each row became a small grid with the
weekday in a fixed column and the rest stacked beside it.

Two things worth recording:

- **A crash waiting on an empty client list.** Both save paths open with
  `document.getElementById('blk_' + state.clients[0].id)` — a guard meant to
  detect whether the client-blocks form is on screen. With no clients loaded,
  `state.clients[0]` is `undefined` and it throws before the guard can help.
  Harmless while that code was only reachable from a screen that listed clients;
  now Save is reachable from any caregiver's panel. Guarded in both places.
- **`render()` does not touch the panel**, which is written straight into
  `#sidepanel`. Adding or removing a one-off left the list stale until the panel
  was reopened. `spRefresh()` keeps them in step.

**Left alone deliberately:** `dayPanelEdit`, `dayPanelPick`,
`dayPanelEditBody`, `buildDayEntry`, `saveDayAvail` and `clearDayAvail` form a
complete, working per-day editor — status, time window, note, and a repeat
pattern of one day / every week / every 2 weeks / monthly — that nothing
currently reaches. It was flagged as dead code and nearly deleted. It is exactly
the feature the next step wants, so it stays until that step decides.

---

## 2026-08-25 — the calendar says one thing per day

**Step two.** The grid carried four explanatory strips and a nine-item legend
around what should be glanceable. All of it is gone: the "generated from
Availability Management" heading, the "View only" tag, the visit-count line, the
verification warning and both legends. The header is now an icon and the word
**Availability**.

Nothing was simply deleted. The AxisCare load state moved out of the card entirely, into its own banner above it
(`cgCalMeta`), in the same shape as the roster banner on the Caregivers screen — it still has to show a failure and a retry, so it could not just
go. The stale-availability warning moved into the **Availability Verification**
card, which was already stating the same status; only the useful sentence
travelled.

**Three states replace nine.** Green is Open, blue is a Devoted visit, red is
everything else, and the colour is the legend. The block label still names which
kind of red.

The important part is that this is not a paint job. **School and Childcare used
to count as availability** — they produced an open time window and set
`c.avail[day] = 1`, so Find Coverage would offer someone who was in class. They
are commitments, and now read as unavailable everywhere: no window in the
editor, no hours on the block, and the day is not marked available on save.
`OFF_TYPES` and `NOT_OPEN` hold that judgement in one place.

**A day with nothing recorded now draws nothing.** It used to say "Needs update"
— which is every day of every one of the 184 live caregivers, since no
availability has been entered for anyone, and it buried the visits that do
exist.

Two small things: the day you click keeps an outline, and today is a filled
circle on the date rather than a box round the cell.

---

## 2026-08-26 — a quarter of the roster was under the wrong name

Carlo reported caregiver 312 missing from the list. She was never missing: all
184 arrive, and she was on screen the whole time as **Yheen Federis**. AxisCare
has her as **Lorilyn Federis** with `goesBy: "Yheen"`.

Two mappers had opposite rules. The client mapper preferred `firstName`, with a
comment explaining why. The caregiver mapper preferred `goesBy`. So **46 of the
184** active caregivers displayed under a nickname — *Orlando Matias* as "Orly",
*Purisima Villano* as "Emma", *Bienvenida Crockett* as "Annie" — and since the
directory searched `c.name` only, typing the name you knew returned nothing.

Caregivers now follow the same rule as clients: `firstName`, with `goesBy` only
as a guard (no active caregiver lacks a `firstName`, so it never fires). The
nickname is kept on the record, `cgNameMatch()` searches both, and the profile
shows a *goes by* chip when they differ — losing the nickname entirely would
just invert the problem for whoever knows her as Yheen.

Worth remembering: **"missing" was really "renamed"**. The roster count was
right, the fetch was right, and the id was present at every stage of the
pipeline. Only printing the name at each step found it.

---

## 2026-08-26 — audit: what the roster wiring got wrong

Carlo asked whether the cleanups had left bugs or dead code. Static attribution
against the pre-session tree says the cleanups themselves were clean: **0
functions became dead**, **0 handlers newly broken**, one function removed
deliberately (`availCalForm`), 24 added and all of them reachable. The 82 dead
functions in the file are unchanged — they predate this work.

The real defects were of a different kind — a plausible field choice that is
wrong — and both were mine.

**Names came from `goesBy`.** Written up above.

**"We were not told" was recorded as "Off".** `deriveOps` filled every weekday
with `{type:'Off'}` when AxisCare had no availability tag. On live data that is
**93 of 184** caregivers, every one of them drawing a solid red *Unavailable* on
every day of every month — an assertion AxisCare never made, on real people a
scheduler might therefore skip. `availKnown` had recorded the distinction since
the roster first landed and a comment promised the UI would honour it; nothing
ever read it. Untagged caregivers now carry no weekly rule at all, so the month
renders empty, which is what Carlo asked for when he said an unknown day should
show a blank calendar. Tagged caregivers are unaffected.

Worth noting how it stayed hidden: an earlier check of "what does a real
caregiver's calendar show" cleared `c.ops` in the test harness, so it reported
*Needs update* everywhere and concluded red would never appear on live data. The
harness was wrong, not the app, and the wrong conclusion was reported. Running
`ROSTER.hydrate()` untouched is what showed it.

**Still open:** `hours: m.hours || 'Days'` invents a working pattern for the 92
caregivers with no hours tag, and `hoursKnown` is read nowhere. Same shape, not
yet fixed — it feeds matching rather than the calendar, so it needs its own look.

---

> The entries from 2026-08-27 onwards were reconstructed on 2026-09-24 from
> [docs/HISTORY-2026-09.md](docs/HISTORY-2026-09.md) — the project documentation as it
> stood that day — and from the 214 commits in the window. Until then this history was
> being written into `CLAUDE.md`, which is loaded into context on every session and had
> reached 337KB as a result. **New history belongs here.**

## 2026-08-27 — availability becomes per-date rows

The weekly availability rule was replaced by rows keyed to a date. The table was
seeded with a year of the old app's overrides, an `Open` block was allowed to be
whole-day, AxisCare visits began carving the hours a scheduler types, and Find
Coverage stopped listing the roster and started ranking it.

- **Per-date rows replace the weekly rule** — `ops.avail2` (keyed `Mon`..`Sun`)
  plus the dated overrides derived from class tags were removed in full, along
  with `OFF_TYPES`, `NOT_OPEN`, `RULE_STATUS`, `dayAvail`, `availDayLabel`,
  `windowsForDay` and the day panel that wrote them. Find Coverage asked about
  **weekdays**; it now asks about **dates**, because per-date rows cannot answer
  "who works Mondays" without inferring a pattern — which is the weekly rule
  coming back through the side door.
- **`caregiver_availability` seeded from the old app — 6,693 rows, 138
  caregivers, 2026-03-04 → 2026-12-31** — taken from the previous app's
  `caregiver_availability_overrides` so schedulers did not have to retype a year
  of availability. `updated_by` carries the original author across — Mae,
  Beatrice, Angelica, Sunshine, Tine, Jen — because the day panel's history line
  should say who actually made the call. The old table had no unique constraint,
  so an edit left its predecessor behind: **6,628 of 6,692 days held one row**
  and the rest were resolved newest-wins, with one day genuinely holding two
  segments (caregiver 1176 on 2026-08-08) keeping both. 24 `Devoted Shift` rows
  were dropped — AxisCare is the system of record for visits.
- **Whole-day `Open` allowed; the timed-only CHECK constraint dropped** —
  `caregiver_availability_open_timed_ck` had forbidden it, on the reasoning that
  an untimed Open claimed hours nobody had stated. The desk decided the
  opposite: "free all day" is a real answer a scheduler gives. The **506**
  migrated rows reading `Open 00:00—24:00` — the old app's `Anytime` label —
  were converted to whole-day rows, which is what they always meant. The
  calendar draws a whole-day Open with no time at all, because no time *is* the
  statement.
- **AxisCare visits carve, at save time** — entering `Open 9a–5p` on a day
  AxisCare has a `1p–2p` visit now stores *two* rows, `Open 9a–1p` and
  `Open 2p–5p`. The visit itself is never stored, so AxisCare stays its own
  system of record and Find Coverage needs no AxisCare call. **Only `Open` is
  carved**: a visit landing on Vacation, Unavailable, School or Other Agency is
  a disagreement between two systems rather than something to resolve silently,
  so `calDayStatus()` sets `conflict` and the day panel says so.
- **A whole-day `Open` is carved too, and loses its whole-day shape doing it** —
  the table has no way to say "all day except 1–2pm", so it stores
  `00:00—13:00` and `14:00—24:00`. Leaving it uncarved would hand Find Coverage
  a caregiver already on a visit, which is the single failure the carve exists
  to prevent. A deferred trigger, `caregiver_availability_day_shape_t`, enforces
  the rest — a day is one whole-day entry *or* timed segments, never both.
- **`dpSave()` refuses to save until the visits have landed** —
  `CGVISITS.status(c.id) === 'ready'`, because `forDay()` answers `[]` for a
  *failed* fetch exactly as it does for a day with no visits, and storing
  uncarved availability is worse than storing nothing. A visit of 24 hours or
  more is treated as a mapping artefact and is not carvable.
- **KNOWN, left open: the migrated rows were never carved** — all 6,693 seeded
  rows predate the carve, so a migrated `Open` can read as free across hours the
  caregiver is already booked for. Not bulk-fixed; re-saving the day in the
  panel carves it correctly. Worth knowing before trusting one: the old table
  stored a **window label** (`Anytime`, `Morning`, `Afternoon`, `Evening`,
  `Overnight`) resolved through the old app's `TYPE_WIN`, so a migrated `Open`
  is often exactly 0–1440 or 1320–1800 — a label, not hours anyone typed.
- **Find Coverage becomes a ranked calling list** — `COVHIST` reads a single
  `/api/visits` window around the shift date (30 days of history plus the
  shift's week, **~5 requests**, cached per date) and gets three signals that did
  not exist on live data before: who has worked with this client, who is already
  booked at that hour, and how many hours each caregiver already has that week.
  `priorClients` and `weekHrs` are demo-only and `null` on a real caregiver.
  `coverageMatches()` drops whoever plainly cannot take the shift, then orders
  the rest by worked-with-this-client, preferred caregiver, availability,
  distance, gender, driving and weekly hours. The screen is a numbered calling
  list rather than the roster.
- **Availability nobody has recorded deliberately does not exclude** — no
  availability had been entered for the live roster, so excluding on it, which
  the old ranker did, emptied the list for every real shift. It ranks below a
  confirmed match and the row says which.
- **The client's gender preference and driving requirement have no source here
  yet** — both live in Client Concierge, a different Supabase project.
  `covClientPrefs()` is the single place they are read, so wiring Concierge is a
  change to that function alone; until then they come from what a scheduler
  entered here, are `null` when nobody has, and the screen says so rather than
  guessing.
- **Availability could repeat into future months** — *Apply to* gained Repeat
  weekly / every 2 weeks / monthly / until changed. Repeats **materialise** one
  row per date rather than storing a rule expanded at read time, which is what
  makes the exception rule free: a vacation saved later on one date writes only
  that date and the series stands. It also keeps the calendar, Find Coverage and
  the reports working unchanged, and lets the AxisCare carve run per date. The
  cost is a horizon at the eleventh month ahead, which the panel states, and a
  monthly repeat anchored on the 31st skips months with no 31st rather than
  sliding to the 1st and recording a day nobody asked for.
- **The repeat choices were then replaced by a read-time carry, the same day** —
  `carriedBlocks()` let a future date with nothing stored inherit the most
  recent same-weekday date holding `Open` hours: forward only, a stored row
  always winning, and a Vacation Monday stepped over so an exception never
  becomes the pattern. Read-time only, so nothing was written, there was no
  horizon and there were no rows to clean up. **It was reverted the next day** —
  see 2026-08-28.
- **The review cadence** — Weekly, Every 2 weeks, Monthly, Every 3 months, Every
  6 months, with Review Cadence and Next Review on the Caregivers list, due and
  overdue coloured. Next Review is derived from `availLastConfirmed` plus the
  cadence, so there is no second field to drift.
- **The Caregivers search stopped dying after one keystroke** — the box called
  `setDir()`, which calls `render()`, which replaces the whole view including
  the input the cursor was in. Typing now goes through `cgSearchInput()`, which
  repaints only the count and the rows; `render()` also restores focus and the
  caret, because the 8-second cloud poll would otherwise pull the cursor out
  mid-name. The box narrowed to 340px, Gender / Location / Driving moved inside
  More Filters, and Language / Skills / Pets were dropped.

---

## 2026-08-28 — the carry comes out, and the day note gets its own table

The read-time carry added the day before was removed after the desk reported
`Open` painting straight down a weekday column. The day note moved off the
availability row into a table of its own, the day panel became five tabs, and
177 caregiver photos landed in this project's own Supabase bucket.

- **REVERTED: the read-time availability carry** — `carriedBlocks()`,
  `CARRY_WEEKS`, the `carried` / `carriedFrom` flags, the faded
  `.cal-blk.carried` styling and the `dayAvail` branch that read it were all
  removed, one day after being added. Because the search skipped any day that
  was not *entirely* Open, **only Open carried**, and in a month grid one
  weekday is a vertical column: an Open block painted straight down it while
  Unavailable stayed put. That asymmetry is what the desk reported. It also
  contradicted the rule that a date with nothing recorded means not available,
  and Find Coverage acted on it — offering caregivers at 3am on dates nobody had
  confirmed.
- **Nothing had to be cleaned up afterwards** — the carry was read-time only, so
  no row was ever written by it. The one path that could have made a phantom
  real was `dpSave()`'s **Add** verb, which reads `AVAIL.forDay()` as "what the
  day already holds" and would have written carried blocks. The table was
  checked: every app-written day holds exactly one status.
- **The day note moved to `public.caregiver_day_notes`**, one row per caregiver
  per date. While it was a column on `caregiver_availability`, every save
  carried `modalState.note` onto the new segments, so editing the hours rewrote
  the note and clearing the day deleted it with the rows. A note is about the
  **date**, not a block of hours: it can be written on a day with no
  availability at all, and replacing or clearing the day's hours now leaves it
  alone. `dpDraft()` sends `note: null` on every entry and the old column is
  legacy.
- **1,182 existing notes moved across with their authors and timestamps
  intact** — real sentences from Mae, Angelica, Beatrice, Joan and Tine. No day
  held two different notes, so it was a 1:1 move. An empty note now deletes the
  row rather than storing a blank, so "has a note" is simply "a row exists", and
  a CHECK constraint refuses `''`.
- **The day panel became five tabs** — Availability, Notes, Delete, Cadence,
  History. Every day opens on Availability and the tab is not remembered between
  days; only Availability writes `caregiver_availability`. Notes has its own
  Save, Delete has a red Delete, and Cadence and History have no footer at all —
  a Save button on a tab with nothing to save is a lie.
- **Delete keeps its own date selection** — `modalState.delPicked`, separate
  from the Availability tab's `picked`, so a multi-day availability pick can
  never become a multi-day delete by accident.
- **The availability panel was redesigned compact, and two controls went with
  the old layout** — the date is context rather than a headline, and
  Availability / Apply to / Time became small segmented controls under one
  primary Save; the note sits behind a *+ Add note* link and stays open once it
  holds text, so a re-render cannot swallow something already typed. Both costs
  are stated deliberately: the status dropdown narrowed from eight values to
  **Open / Unavailable** — rows already stored under Vacation, Sick, School,
  Childcare, Appointment and Other Agency still read and draw everywhere, only
  the entry choice narrowed — and the Set day / Add toggle went, so a save
  replaces the day and split shifts (9–12 plus 2–5 on one date) cannot be
  entered from this panel.
- **177 caregiver photos copied into this project's own Supabase bucket** —
  public-read `caregiver-photos`, one object per caregiver named for the bare
  AxisCare numeric id (`312`, not `a312`), copied from `devoted-care-system` and
  every one verified byte-for-byte over the public URL afterwards. Coverage is
  **157 of the 173 Active caregivers (91%)**. Both systems key on the AxisCare
  id, so it was a straight copy, and it leaves this app depending on nothing
  outside its own Supabase — the source project and its keys can be deleted.
  AxisCare has no photo of any kind, so there is no sync job and never has been.
- **A missing photo falls back to a placeholder, not an error** — every row asks
  for a photo regardless and `onerror="cgPhotoFail(this)"` swaps in the camera
  placeholder, covering "never had one" and "could not load it" with one
  fallback. **Sixteen** Active caregivers have none. Supabase answers a missing
  public object with **400, not 404**, and the `<img>` fails either way; with
  `loading="lazy"` only visible rows ask, so the has-photo manifest the source
  project needed to avoid a 404 fan-out would be machinery with nothing to buy.
- **`cgPhotoUrl(c, px)` initially returned a Supabase image-transformation URL
  at 96px** — chosen because 33 PNGs over 1MB made up roughly 55MB of the 64.9MB
  bucket. That choice was itself reversed later, once the transform billing was
  understood.
- **The client's schedule opens from Find Coverage** — the client name in the
  shift header became a link to a new per-client month calendar, focused on the
  month of the open shift with the shift's date outlined, fed by a new
  `AxisLive.fetchClientVisits` over a four-month window. There was no client
  calendar in the app before this. `clientIds` is sent but never trusted —
  AxisCare accepts several visit filter names, answers 200, and silently ignores
  the ones it does not implement — so every returned visit is re-checked against
  the client id and the window is kept short so an ignored filter stays bounded.
  Blocks are labelled with the **caregiver**: the client's own name on every
  block of their own calendar says nothing.
- **Caregiver names on both Find Coverage screens link to the profile** —
  `openCgFromCoverage` records only where to return to, and the profile gained
  an X beside Edit Profile / Send Resume / Print plus a *Back to Find Coverage*
  link. Closing sets the view back to coverage and nothing else:
  `coverageQuery`, `coverageContext`, `covRun`, `searchQuery` and the contact log
  are untouched, so the screen re-renders with the same client, date, filters
  and ranked list in the same order. The first pass only reached `covMatchRow`,
  leaving nothing clickable on the search results; a follow-up applied the same
  link to `dsRow`.

---

## 2026-08-29 — the caregiver page splits into Overview and Profile

The biggest day of the period, almost all of it on the caregiver record. The
page split in two, notes stopped belonging to a calendar day, a rating went in
and then had to be fixed so that it saved at all, and a second attempt at
carrying the availability pattern landed with guards against the three faults
that killed the first.

- **The caregiver page split into Overview and Profile** — Overview is who the
  person is and what has happened with them: header card, the operational alert,
  the availability calendar, Notes and Client Feedback side by side, Call Log and
  Updates below. Profile is what the desk has decided: the eight editable
  sections, each with its own Edit. Nothing renders on both, checked by diffing
  the two section lists.
- **Client Feedback & Concerns is new** — `state.cgConcerns`, a tracked CLOUD
  slice so all three schedulers see the same list. Open / Resolved shipped on each
  entry and was **removed the same evening** — the badge, the Resolve/Reopen
  button and the status filter all went, because this is a record of what was said
  about a caregiver, not a queue somebody works down. Entries already stored keep
  their status in the data and nothing reads it.
- **The Call Log is derived from `state.contactLog`, not stored twice** — that
  is the real record of the desk ringing this caregiver about an open shift,
  keyed by shift, so it is read across every shift and filtered to this person.
  Every entry was placed by a scheduler, so direction is always outgoing, and
  nothing anywhere records call **duration**, so the outcome the scheduler
  logged is shown instead of an invented number.
- **Notes belong to the caregiver, not to a calendar day** — the Notes tab lists
  every note a caregiver has, newest first, stamped with the date written, and a
  new note is dated today rather than the open calendar date; `calDayStatus()`
  stopped reading `NOTES`. Clicking a different date used to swap the note out
  silently, and a note typed there was filed under that date. All **1,182**
  existing notes keep their rows and dates. The table still holds one row per
  caregiver per date, so a second note on one day is appended as a paragraph —
  lifting that would be a schema change.
- **Caregiver Rating, and the fix that made it save** — a strip at the top of
  Profile, edited through a pencil, recording the scheduler, the timestamp and
  the previous star count; stars show on the caregiver list and an unrated
  caregiver reads *Not rated*, never an implied zero. It is deliberately in none
  of the three profile sections, because a rating is not a fact about the job,
  it is an opinion somebody signed for.
- **The first version never saved at all** — the rating lived on `c.ops.rating`,
  and the `caregivers` slice is `patchOnly`, so a record absent from the boot
  baseline is skipped by the diff entirely. Confirmed against `CLOUD.overlay()`:
  no patch and no add. It looked saved because the in-memory object had it and
  the profile re-rendered; the next load rebuilt `ops` from AxisCare and it was
  gone. `state.cgRatings` is now its own slice keyed by caregiver id, so adds are
  saved outright and it survives the roster being rebuilt every boot. Anything
  already written to `ops.rating` still reads. Follow-ups made the reason
  optional, added a rating guide inside the popup, moved the picker to radios —
  clicking a star in a row of five reads as "at least this many" and had
  schedulers counting rather than choosing — and dropped the scheduler name from
  the display.
- **A poll no longer discards unsaved local work** — `pull()` applied the server
  overlay and then cached the **server's** copy over the local one, so anything
  entered locally that the debounced push had not sent yet was dropped from the
  cache as well as being absent from the server: save, let a poll land, refresh,
  gone from both. The cache now stores `buildOverlay()` — remote plus ours — and
  a pull re-arms the save rather than ending it. This affects every slice, not
  only ratings. `ratingSave` also flushes through `CLOUD.save()` rather than
  waiting out the debounce, so a refresh a second later cannot beat it.
- **Structured client-facing profile fields for the resume** — six chip fields
  (Caregiver Style, Communication Style, Personality, Strengths, Types of Care
  Experience, Hobbies & Interests) plus a *What Families Appreciate* summary, and
  years of experience became five bands rather than a typed number, with records
  written as a number reading into the band they fall in so nothing has to be
  retyped. Stored in `state.cgProfiles` with its own CLOUD slice — deliberately
  **not** on `c.ops`, which is `patchOnly` and is the path the rating was lost
  down.
- **`fmtDate(null)` was rendering January 1, 1970** — `ops.lastShiftWorked` is
  `null` on every real caregiver, so an absence was reading as a record.
- **A second attempt at carrying the availability pattern, calendar-only** — a
  future date with nothing typed shows that weekday's entries from a **complete**
  Sun–Sat pattern week, read-time only and confined to the per-caregiver store
  the calendar reads. Built to avoid the three faults that ended the read-time
  carry removed the day before: the whole week carries, Unavailable included, so no
  vertical Open column appears; `dpSave()`'s Add verb reads `storedForDay`, not
  `forDay`, so a projection can never become a real row; and the roster-wide
  index behind Find Coverage, `dayAvail` and `openDays` is untouched, so coverage
  still offers only confirmed dates.
- **The Cadence tab actually sets the cadence** — the placeholder gained eight
  choices (Weekly … Yearly, No Cadence) with Last Checked, Next Check Due and a
  Save. Every 9 months (270 days) and Yearly (365) are new intervals. Stored
  values keep their existing spelling — `Every 2 weeks`, not `Every 2 Weeks` —
  because caregivers are already saved on them and re-casing would orphan those
  records; only the on-screen labels are title case. No Cadence stores `null`
  rather than a zero-day interval, which would report everyone overdue.
  Companion commits made saving stamp today's check from both cadence controls
  and made due dates count in months.
- **An Updates page for operational announcements** — date, update, posted by,
  newest first, composed and edited in place, under Weekly Tasks in the sidebar;
  `state.updates` is a tracked CLOUD slice. Kept apart from Weekly Tasks
  deliberately: a task is something to **do**, with a due date and a done state;
  an update is something to **know**, with neither. An edit keeps the original
  date and author, because correcting wording is not a new announcement.
- **Feedback entries are typed by the scheduler, never inferred** — each entry
  carries a type chosen in the form, the warning triangle was dropped and the
  type reads as a label, which turns the section into a record rather than a
  queue. Nothing infers a type from the words: only the person who took the call
  knows whether an entry is a concern or a complaint. A companion commit made
  Reliability concern depend on something documented rather than on attendance
  data.
- **The Reports charts, over six commits** — Caregivers by City went from a
  plain list to a compact horizontal bar chart, then vertical bars, then pies for
  the three splits, then bigger pies with Port Hueneme grouped into Oxnard, then
  the city chart vertical on the left with a new Caregiver Age Range chart on the
  right, a soft multi-colour palette, and clicking a city bar to list its
  caregivers with the Other bucket dropped. Six iterations on one screen in one
  day, each superseding the last; only the end state is load-bearing.
- **Roughly thirty smaller refinements to the profile and the day panel** —
  compacting the Overview / Profile tabs, one Edit for Assignment & Client Rules
  with tinted headers, Transportation split into two Yes/No rows, the weight
  limit replaced by a transfers question, English proficiency's five real
  options, the note box opening on demand, stacked note rows, an auto-growing day
  note, an optional Reason on Unavailable that is hidden on *Selected days*,
  saving never closing the side panel, the note count moving to the Notes tab,
  posting times and within-day ordering on Updates, and system-generated
  caregiver updates dropped. Individually cosmetic; none changes a rule. The one
  with a stated cause is the **day-note limit raised to 2,000 characters** — the
  text was being cut off, not the box.

---

## 2026-08-30 — one height for every profile card

A day on card layout. The nine profile cards, then every card, then the Overview
cards were pinned to a single height with the overflow behind *View Details*, so
a row of cards matches whatever each one holds.

- **Every profile card is one fixed height, with View Details on overflow** —
  Languages, Skills & Experience, Caregiver Style, Communication Style,
  Personality, Strengths, Types of Care Experience, Hobbies & Interests and What
  Families Appreciate were first pinned at **172px**, then every card — all
  thirteen — settled at **260px** the same day, whatever they hold, so a caregiver with
  nine strengths no longer makes their row twice as tall as the card beside it.
  The body is clipped rather than scrolled — a scrollbar inside a card is its own
  kind of mess — and View Details appears **only** where content actually
  overflows, so a card that fits is not offering a popup showing the same thing
  again.
- **One registry and one card component replace three near-identical builders** —
  all nine come from `PFX_SECS`, so a tenth section is a row in it and the card,
  the popup and the measurement all follow from it. The popup renders the same
  body function uncapped, so the preview and the full view cannot drift apart.
- **`pfxFit()` hides every button, measures, then unhides** — measuring with a
  button left visible from the previous render would read the body in less space
  than it has and latch the card open, so the answer would depend on what the
  last render happened to leave behind. It reads the DOM and toggles one
  attribute — no data changes and nothing in it renders, so it cannot loop — and
  it returns immediately on every screen but the profile.
- **The same treatment reached the Overview cards**, and each Notes, Feedback and
  Updates entry there became individually editable and deletable.
- **Client blocks reduced to name, View Details, Remove** — the hard/soft
  explanation line, the per-row level badge and the Assignment Restrictions panel
  are gone. Remove asks in place first, the actions swapping to Remove / Keep,
  because a block is the record that stops an assignment and one stray click
  should not quietly clear it; removing stamps the caregiver's `lastUpdated` and
  flushes through `CLOUD.save` rather than waiting on the debounce. Nothing
  stored was dropped — the level, reason, notes, type, date and author all still
  show inside View Details, and the coloured left bar stays so hard and soft
  blocks still read apart at a glance.
- **Personality and Strengths option lists expanded to 26 and 33 entries**, the
  pickers became compact chips, *What Families Appreciate* was dropped from the
  Profile tab, and the caregiver's age was added to the roster beside the city.

---

## 2026-08-31 — seven matching sections become three

The matching vocabulary was cut back so that no word appears in two places,
schedule changes got a recorded history of their own, and the in-app monthly
availability copy arrived stamped `Auto-copy`.

- **Seven matching sections cut to three, with no shared vocabulary** — Caregiver
  Style, Communication Style, Strengths and Types of Care Experience were
  removed; **Personality** (16 traits), **Skills & Experience** (18 items, now a
  chip field) and **Hobbies** remain, and no word appears in two of them.
  *Patient* had four homes and dementia had two, which made a caregiver look
  thoroughly assessed while saying the same thing repeatedly, and made the resume
  repeat itself. Every retired name with an honest home in a surviving list folds
  into it and the first save writes the current word; names with no honest
  equivalent stay stored but unshown. Verified: a record carrying all four
  retired sections reads back as three personality traits and five skills, the
  old keys still on it.
- **Skills & Experience now seeds from `c.skills`** — so a live caregiver's
  AxisCare tags reach it: `ALZ`, `ELC` and `HLE` read as Dementia / Alzheimer's
  care, Hospice care and Hoyer lift. `cgCareSkills` only ever read
  `ops.strengths`, which no live record has, which is why the section had been
  empty for every real caregiver.
- **Schedule Updates — a recorded history of schedule changes** — a new left-nav
  item between Find Coverage and Shift Handoff, listing every recorded change
  across every client, newest first, from a new `state.schedChanges` CLOUD slice
  so all three schedulers see one history. It does not derive from the board,
  because the board cannot answer this question: open shifts and call-offs are
  live state, so a shift that gets covered stops looking like a call-off and
  yesterday's changes are gone from it entirely.
- **Recorded at the six points a scheduled shift actually changes** — the two
  call-off paths (reopened and cancelled), a replacement needed after a no-show,
  and the two assign paths. Each row carries the client, what changed, the
  caregiver it moved between, the shift's own date and time, the reason where one
  was given, and who did it. Caregiver and client names are **snapshotted**
  beside the ids: a saved overlay can outlive a caregiver id — `ROSTER.reconcile`
  exists for exactly that — and a history rendering `undefined` a month later
  would be worse than none. Nothing is inferred; a board with no history yet says
  so rather than showing a derived guess.
- **Marking a caregiver Inactive writes `caregiver_profile.employment_status`** —
  `vfInactive` and `vfArchive` now call `ROSTER.setEmploymentStatus` plus
  `saveEmploymentStatus`, with the previous status, active flag and pool flag
  captured and rolled back on a save failure. Setting `c.active` alone was no
  longer enough: `ROSTER.reconcile()` re-derives it from that column after every
  overlay application, so an unsaved flag was undone on the next poll and on
  every reload, leaving `ops.inPool` false on a caregiver back on the Active
  Roster.
- **The in-app monthly availability copy, stamped `Auto-copy`** —
  `AV_AUTO_AUTHOR = 'Auto-copy'` and the `copyOwns` ownership guard, so the copy
  may replace its own rows and never a person's. All **6,981** rows that existed
  before it carry a real name, so "did the copy write this?" is answerable with
  certainty and without a login. Change that string and `copyOwns` stops
  recognising the copy's own work, freezing every already-copied month. The same
  commit fixed the View Full Calendar popup's month arrows — `cgFullCalNav` now
  repaints both the page and the popup.
- **Every dated feed sorts by real timestamps, newest first** — Updates and the
  profile's Notes, Client Feedback and Updates were sorted with
  `String(b.at).localeCompare(String(a.at))`, which held up only while every
  record carried an ISO string. A record whose `at` is a `Date` object
  stringifies to `"Wed Sep 02 2026 …"` and one missing the field stringifies to
  `"undefined"` — both start with a letter, and a letter sorts above every
  `2026-…`, so a single odd record floated to the top whatever its real date
  said. One comparator now serves all four: it parses `at` to milliseconds, falls
  back to `created` so an entry showing no time stays in its right place, then to
  posting time and insertion order, so the order is total and stable rather than
  depending on however the cloud handed the array back.
- **Three smaller corrections** — the *no AxisCare source* banner came off
  Attendance, the dense profile sections now show in full with their View Details
  dropped, Driving was restored as its own row, and the fade was removed from the
  profile cards.

---

## 2026-09-01 — Find Coverage gates on availability, and the client's gender preference lands

Both Find Coverage screens stopped treating recorded availability as a ranking signal and started filtering on it, and the client's caregiver gender preference — which AxisCare has no field for — was wired through from Client Concierge. Two Netlify functions were added to feed and back up that work on a schedule. An early roster paint with a localStorage cache went in and came back out the same day.

- **Availability became a hard gate, not a score.** The shift-locked list built by `coverageMatches()` used to score availability — nothing recorded was worth +4 and stayed in the calling queue — and now decides who is on the list through the one `coverageDetail()` call, as the date search already did. On the Brenda Janowski 8a–8p shift of 2026-09-03, Meryll Austria came second on 11 previous visits with that client and a completely blank calendar. The comment that justified the old behaviour, *"nobody has entered any for the live roster yet"*, was true when it was written and is not now: **50 caregivers had an `Open` row for 2026-09-03 alone**. An empty calendar is a no, exactly as *Unavailable* is.
- **The client's caregiver gender preference now filters.** `covClientPrefs()` is the single place `client_match_prefs.gender_pref` (`'F' | 'M' | null`) is read, through `CLMATCH`, and both screens ask it — the shift list through `coverageMatches()`, the date search through `dateSearch()`. AxisCare has no such field, so the old `reqGender(cl.restrictions)` read could never fire on live data: `mapClient()` hard-codes `restrictions: []` for every real client, and the preference was going quietly unused. **16 of the 21 clients ask for a female caregiver; none ask for a male one.**
- **`genderKnown` keeps *unread* apart from *no preference*.** A missing preference means either gender; a table that has not loaded means everyone, and the shift card says the preference was not applied. `covMatchNote()` states the rule in force in four values — *Female only* / *Either* / *Still loading — not applied* / *Couldn't read — not applied*.
- **The last caregiver with no recorded gender got one.** A caregiver whose gender AxisCare does not record is held back when a preference exists, because they are not *known* to be the gender asked for. It applied to exactly one person, Angelina Dela Cruz (id 613); her gender was recorded in AxisCare on this date, so the rule now excludes nobody. It stays as a guard for a future hire — the fix is always to record the gender, never to loosen the rule.
- **`netlify/functions/matching-sync.js`** — a new hourly job at `:17` pulling the gender preference, the driving requirement and the matched caregivers out of Client Concierge into `client_match_prefs`. It is a sync rather than a live read for two reasons: Concierge's anon key can read the whole of `concierge_records` — **179 care notes and 42 family check-ins** — and this app has no login; and Concierge stores matched caregivers as **names**, of which **33 of the 45** distinct ones matched the AxisCare roster on the first pass, the other 12 being middle names, suffixes, one typo and one nickname. Resolved once into a table, that becomes a fact somebody can correct rather than a guess repeated on every page load.
- **`netlify/functions/availability-copy.js`** — a new hourly job at `:35` filling the current and next month for **every** caregiver. The in-browser copy is gated on `CGVISITS` being ready, which only happens when somebody opens a calendar, so on 2026-09-01 **101 of 140 caregivers had an empty September** — and an empty September becomes the empty source October is built from, which is permanently stuck rather than merely late. Chunked against a soft deadline with a saved cursor, the same shape as `carenotes-sync`.
- **Schedule Updates split into Recent Updates and Needs Update.** Tab 1 is a change audit recorded by snapshot-and-diff — the form's open takes a snapshot, its save compares — grouped by caregiver and editor within a **30-minute window**, so a scheduler who fixes five fields did one update, not five. Only *what* changed is kept, never previous → new: a change history holding a caregiver's former restrictions or rating is a second copy of their record. Tab 2 is worked out live on every render from three rules — the cadence, an empty availability calendar, and blank required profile fields — so completing the field is what clears the row.
- **Driving counts as recorded only when somebody said so.** `c.driver` is `false` both for *no licence* and for *never told*, so Needs Update treats driving as answered only when AxisCare states it either way (a `DL` tag, or the `WDL` tag that lands in restrictions) or the desk entered one. A missing tag is silence, not a No.
- **Tried: an early caregiver paint plus a localStorage roster cache** (`cd5b873`). `applyRoster()` became the single mapping path, the roster promise painted the moment it resolved instead of waiting on `Promise.all`, raw AxisCare records were cached under `dc.roster.v1` for 24h and painted before the fetch was issued, and a 12s timeout was added. The list had been showing a loading message for ~4s while the roster (2 requests, ~1.7s) sat behind a `fetchOpenShifts` window the list does not read.
- **Reverted the same day** (`913d9ad`). The early paint hit boot rule 3b: `applyProfile()` returns on its first line when `profiles[axisId]` is missing and the fetch asks `statuses=Active`, so the roster read **171 active instead of 100** for ~3s, on a cold load as well as a warm one — and `c.active` is what Find Coverage, Client Matching, the ranker and the review tasks filter on. The cache moved `cacheRoster()` ahead of the plausibility guard, so a truncated read was painted *and* stored for a day with no banner at all. The one that could not correct itself: a caregiver terminated in AxisCare stayed cached, and assigning them a shift had `reconcile()` → `remapDangling()` silently rewrite `s.assigned` to somebody else, into a tracked CLOUD slice shared by all three schedulers. The stored payload was **187KB of raw records** — date of birth on 180 people, home address on 179, pay rate on 146 — at rest on the device with no logout to clear it. `withTimeout()` was kept, and it **discards** a late answer rather than using it. Leftover `dc.roster.v1` entries are inert; clearing one needs DevTools or *Clear site data*, not a hard reload.
- **Ask Devi: white page, no hero, composer at the foot.** The heading, strapline and spark icon went, the suggested questions collapsed into a closed row beneath the input, and the nav item was renamed to *Ask Devi*. The page became a full-height column — the conversation scrolls, the composer is the last row — so answers read downward into the box that produced them. Measured: composer bottom at 634 of a 713px viewport when collapsed.

---

## 2026-09-02 — the carve corrects itself, after a caregiver read free on a day he was booked

The desk reported Alrenz Ellivera reading as whole-day `Open` on 2026-09-12 while assigned to a new client 8a–8p. Nothing was broken in `carveSegs()` — the availability was saved on the 1st, the visit assigned on the 2nd, and no code ever looked again. The day added an hourly re-carve, a browser twin of it, three bugs in what the carve can see, and a live AxisCare double-booking check on the date search. Separately, caregiver profile edits stopped being reverted by the sync layer.

- **`carvableVisits()` reads three dates, not one.** Carving date `D` now composes `D − 1` at `−1440`, `D` at `0` and `D + 1` at `+1440` into `D`'s own minute frame. The middle row was missing: because `CGVISITS.forDay()` keys strictly on the start date, a visit running Sep 7 8pm → Sep 8 6am was **invisible on Sep 8**, so a whole-day `Open` saved there stored midnight–6am as free while the caregiver was still on the visit. It affected **21 caregiver-days**, and neither Find Coverage screen catches it. `visitWins()` in `availability-copy.js` carries the same logic, and its visit pull is deliberately one day wider at each end — without that the `D − 1` source is empty for the first date of the window, which is *today*.
- **The hourly re-carve — `planRecarve()`, pass A of `availability-copy` at `:35`.** It re-derives every future day that already holds rows against the visits AxisCare has *now* and rewrites the day if the answer differs, before the monthly copy runs. **41 rows across 9 caregivers were wrong roster-wide**; the first sweep corrected **63 caregiver-days across 11 caregivers**. Four rules: it never changes a status (only `Open` is cut), never widens, never touches the past, and writes the day back under its existing author via `dayAuthor()` rather than as `Auto-copy`. It is idempotent, has **no cursor** — a reconciliation sweep must restart from the first caregiver or it skips exactly the ones whose visits just moved — and deliberately **no human-author guard**, because the row that prompted it was authored by a person.
- **`recarveOnOpen()` does the same correction the moment a calendar opens.** Run from `cgCalendar()` once `AVAIL.load()` and `CGVISITS.load()` have both settled, guarded by `recarveDone` and cleared by `cascadeReset()` after a human save. It earns its place twice: it is instant rather than up to an hour later, and `CGVISITS` holds **thirteen months** where the server sweep pulls 92 days, so days beyond December are corrected here and nowhere else — at no AxisCare cost, since the visits were already fetched to draw the calendar. `CGVISITS.load()` now returns a promise for this; it used to return nothing, so `cascadeNextMonth()` was chained on `AVAIL.load()` alone and usually found `CGVISITS.status()` still loading on the first open. `AVAIL.saveDays()` and `patchIndex()` took an optional `author`, because the re-carve narrows somebody else's row rather than making a statement of its own.
- **`copyClashes()` — the monthly copy may never contradict a real visit.** `AVAIL.copyOwns()` is `segs.length > 0 && every(Auto-copy)`, so a day with **no rows** passes nobody's ownership test. On this date the first re-carve sweep correctly emptied Alrenz Ellivera's 09-06 and 09-13, and the copy pass **in the same run** turned `Open 6a–9p` typed by Carlo into `Unavailable all day` stamped `Auto-copy`, on two dates AxisCare has him working 8a–8p; both were repaired by hand. The guard sits at the **write**, not at ownership, so it does not care how a day came to be empty. It is also the fix for a much larger mess of the same kind: one August vacation week had become `Unavailable` on **all 61 days** of September and October, taking an actively-working caregiver out of coverage entirely.
- **`AV_MIN_MIN` is applied to the whole carved result, not only the pieces this carve cut.** Scoped to fresh cuts, remnants became permanent — a sliver written on Monday no longer overlaps the visit that produced it, so Tuesday's carve passes it straight through. That was briefly the behaviour and it left **17 uncleanable rows**. Exactly 3:00 is kept, because 65 of one caregiver's rows are exactly 3–6pm, and a block somebody *types* too short is refused in `dpDraft()` with a message rather than silently dropped.
- **`dpSave` reads `existing` per target date** and writes one `saveDays` call per distinct carved result. Reading it once from the anchor day copied that day's holes onto dates with no such visit.
- **`covClash()` wired into the Find Coverage date search.** It asks **AxisCare**, through `COVHIST`, whether the caregiver is already on a visit at that hour, falling back to `assignedDuring()` for shifts assigned inside the dashboard. The date search had used `assignedOnDate()`, which only ever knew about in-app shifts, so a stale stored `Open` could offer somebody who was booked — that is the screen that would have offered Alrenz Ellivera for 09-12. The re-carve keeps the table right; this makes the answer right in the minutes before it runs. `dateSearch()` returns `clashChecked` and `unchecked` so the screen can say which, bounded at `COV_CLASH_MAX_DATES` (10), because each date costs a `COVHIST` window and a range search can name thirty.
- **Two things the clash check needed with it.** `COVHIST` caches the derived answer per **date** but the network pull per **window** (`fetchWindow`): keyed per date, ten concurrent loads opened ten thirteen-request pulls — **~45 requests in three seconds**, which AxisCare answered with **429 on every one**, account-wide, so the care-notes sweep and the roster hydrate wore it too. Ten consecutive dates now share two windows. And `absorb()` stopped reading an overnight as a **one-hour** visit (`e = s+1` whenever the end wall-hour was smaller than the start), which had `covClash()` clearing caregivers for the small hours they were actually working; it now runs past 24 and files last night's tail on the date it occupies.
- **KNOWN, OPEN: a cancelled visit leaves its hole.** Reported by the desk this date and deliberately not fixed. The carve only ever **subtracts**, so cancelling or moving a visit in AxisCare leaves the availability it cut still cut — `Open 6a–9p` carved to `Open 6a–8a` around an 8a–8p visit does not grow back. It cannot simply be reversed because **the uncarved intent is never stored**: `AVAIL` cannot tell a carved `Open 6a–8a` apart from one somebody typed. Of the four shapes a fix could take, the cheapest real one is a cancellation feed — `/api/visits` does return `removed`. Until then the workaround is the one that exists: re-save the day in the panel.
- **`CGWORK` derives real hours worked from AxisCare visits.** A new module beside `CGVISITS`, fetching `/api/visits?caregiverIds=<axisId>` over the hire date to today capped at three years, and re-checking `v.caregiver.id` on every record so a caregiver is matched by id and never by name. A visit counts as **worked** only on evidence it happened — a clock-in *and* a clock-out, or an actual `startDate` *and* `endDate` — because guessing from the scheduled times would turn every future booking into hours worked. Durations come off the wall-clock string, not `new Date()`. Verified on a fixture: **4.5 + 8 + 4 = 16.5 h over 3 of 8 scanned visits**, the other five correctly excluded. *Last shift worked* and *Last client served* now come from the most recent visit there is evidence was worked, and the row never reads "Not tracked" again.
- **Caregiver profile edits stopped being reverted by the sync layer.** Every save goes out keyed on `serverRev`, which only advances on a confirmed write, so two saves raised close together both sent the same rev — instrumented over one ordinary run of profile saves, **five of nine writes collided**. The conflict path then wrote the server's older copy of the caregiver over the newer one, and since a caregiver patch carries `ops` as a single field, **every preference, restriction and note reverted together**. `push()` is now serialised to one write in flight with anything raised meanwhile queued; `pull()` no longer overwrites work this browser is still holding; a conflict retries up to five times and then reports honestly; and each section's Save flushes immediately rather than waiting on `render()`'s 900ms debounce. The failure path had also been re-entering itself, putting **thirty writes a minute** on a database refusing all of them.
- **Needs Update stopped flagging people whose data was there.** A caregiver showed *Availability Missing* with a full calendar: the check called `AVAIL.openDays()`, which answers from the roster-wide index — a week back to the end of **next** month — and returns an empty array for *none entered*, *still loading* and *the fetch failed* alike. `AVAIL.coverage()` now asks its own question over `searchWindow()` and returns a **state**, so only a definite `none` is a finding, and when it cannot run the page says so. The field rules were rewritten to **25 checks, one per row**; a bare caregiver lists 19 of them, the same caregiver with every field answered No or 0 lists nothing, and every numeric check goes through `hasVal()` because 0 is an answer.
- **Work Preferences consolidated into one full-width card.** Client & Assignment Preferences merged in — 22 rows, one Edit button, ending the two-cards-one-question read. Preferred shift times are the desk's own record and are deliberately **not** seeded from the `WKDY` / `WKND` / `MRNNG` / `AFTRNN` / `NOVRN` / `AD` class tags, which are not availability and which **93 of 184** active caregivers carry none of. Absence is never read as a No: Overnight OK and Live-in OK used to read *No* for anyone nobody had asked, and now read *Not recorded*. A **Preferred days** field shipped here and was
  replaced by **Languages spoken** fourteen minutes later the same afternoon —
  which days somebody works is the availability calendar's answer, not a
  preference; the new field reads `c.languages`.
- **Skills & Experience became capability-only, and unbound from willingness.** Two changes earlier the five care rows in Work Preferences wrote through to these chips on the reasoning that they were one fact recorded twice; that is exactly what this overturns — *knows how to use a Hoyer lift* is not *will take a bedbound case*, and the write-through would have ticked a skill on somebody who had never done it. 23 options in four groups, an empty group is not drawn, and four retired names with no honest equivalent are deliberately left unmapped rather than given an invented one.
- **The rest of the profile tidy, all the same day.** English proficiency replaced Live-in OK in the same row, reading and writing the field the Languages card already edited; Hoyer lift was dropped from Work Preferences as the one capability question in a willingness section; *OK* came off six willingness labels in all three places a label appears; Assignment & Client Rules was renamed **Client Blocks — Do Not Assign**; and the Languages card itself was removed once both its fields were visible in Work Preferences, taking its editor with it. `LANG_OPTS` and `ENGLISH_ALIAS` stayed, and a stored value outside the new list — a legacy `'Good'` — is kept selected rather than silently rewritten on the next save.
- **`devi-agent` Edge Function added.** The Anthropic-backed answerer that takes whatever the local regex router could not match. Its key is a Supabase secret, so **a commit does not deploy it**, and `deviAsk()` falls back to the router's own answer whenever the call fails — an undeployed function degrades to the old wording rather than showing an error.
- **Attendance organised by month.** A compact month strip sits left of Filter and *+ Log attendance*, opening on the current month, with arrows stopping one month past the oldest and newest records. `state.attMonth` is UI state and not a CLOUD slice, so browsing months writes nothing. Two things the month view would otherwise have hidden were fixed with it: a Filter date range now lands on the month it starts in, and the Date field became required, because an entry with no date belongs to no month.

---

## 2026-09-03 — open shifts move to a mirror, and AxisCare data leaks into the shared row

The busiest day in the project so far. Open shifts stopped being derived in every
browser on every load and became a Supabase mirror written by a Netlify function;
the caregiver list stopped waiting for that scan and paints on the roster and
profiles alone. In the middle of it the desk reported three shifts still being
offered after AxisCare had assigned them — a re-hydrate writing AxisCare visits
into the shared overlay as though a scheduler had typed them, diagnosed in
production and fixed the same day. Devi's snapshot was widened from three
sections to the whole board.

- **Open shifts are mirrored, not scanned — `netlify/functions/openshifts-sync`**
  — the rule is unchanged (*not removed, no caregiver, scheduled in the future*);
  it now runs once for the whole desk on a `*/10` cron and on read, writing
  `public.open_shifts` (`supabase/open-shifts.sql`). The dashboard reads that
  table in **2 requests, 666ms** against the live scan's **14 requests, 1,321
  visits, 9,085ms** — **13.6× faster, and byte-identical**, verified by running
  both paths in the same process and comparing every field.
  `mirrorRowToShift()` reproduces `mapOpenShift()` exactly, including building
  `end` from `new Date(undefined)` — an Invalid Date, copied rather than
  improved, because a `null` there would be a different value in the diff, and
  `shifts` is a tracked CLOUD slice.
- **The live scan was measured, and the documented cost was stale** —
  `AxisLive.fetchOpenShifts()` scans today to the end of **next** month, so a
  scheduler filling next month's gaps sees all of them. Over 2026-09-03 →
  2026-10-31 that is **14 requests, 1,321 visits, 9.1s, to produce 12 rows** —
  the single most expensive thing the boot does. The previously documented "28-day
  window, ~700 visits, 8 requests, about 4 seconds" was stale in every number.
- **The mirror falls back to the live scan, and deletes only on evidence** — if
  the sync has never completed a scan, the heartbeat is cold or Supabase is
  unreachable, `fetchOpenShiftsMirrored()` returns the live scan; tested by
  ageing the heartbeat to 2h and by nulling `last_ok_at`, each returning 9 shifts
  identical to the scan, so the first deploy is a non-event. Staleness reads
  `last_ok_at` — set only by a run that scanned the *whole* window — never
  `last_run_at`. A row leaves the table on **evidence** (now assigned, removed or
  in the past) on any run, but on **absence** only after a complete scan.
- **A pass never fits in one run, so the near window is re-read every run** — a
  full pass is **16 requests, 1,323 visits, 9,622ms** against a
  `SOFT_DEADLINE_MS` of 6,000, so splitting across runs is the steady state. A
  resumed run began at the cursor out in late October and never looked at chunk 0
  (today → +13 days), where a scheduler adds an unassigned visit: **3 runs in 6**
  skipped it, up to ~20 minutes on the ten-minute cron, while `last_ok_at` stayed
  inside `MIRROR_COLD_MS` so every browser went on trusting the mirror. The desk
  reported a newly added unassigned shift not appearing after a reload or a hard
  reload — a straight regression against the live scan. The re-read now runs
  **second, after the first cursor chunk**, is best-effort, may not advance
  `cursor_chunk`, and skipping it is not recorded as a failure. Ordered first, a
  run spent its whole budget on optional work and advanced nothing — simulated at
  3× AxisCare latency the pass never completed in 40 runs; recording a skip as a
  failure denied `complete`, blocked the sweep and froze `last_ok_at` forever.
  Both caught in simulation, not in production.
- **Two deadlines bound a run** — `SOFT_DEADLINE_MS` dropped 8,000 → **6,000**
  because it is checked *between* chunks, so the real stop is always one chunk
  late: at 8,000 a run measured **9,941ms** before its writes, over the 10s
  platform timeout the constant exists to prevent. At 6,000 runs measure 7.1–7.9s,
  at the cost of one more run per pass. `HARD_DEADLINE_MS` (9,000) fires
  regardless, because being killed by the platform with `running_at` still held is
  worse than waiting for AxisCare to recover.
- **A cursor is an index, and the chunk list moves at midnight** — this one
  deleted real coverage, about once a day, silently. `cursor_chunk` indexes a list
  rebuilt from `ymd(now)` every run, so every boundary slid a day while the saved
  index did not; a pass resuming across midnight left a one-day hole, reported
  `complete`, and let the sweep delete every row on that date with no error
  anywhere. Replaying the handler's own code: cursor 2 loses 2026-10-01, cursor 3
  loses 2026-10-15, cursor 4 loses 2026-10-29. A run whose window differs from the
  one the cursor was saved against (`window_from`/`window_to`) now starts a fresh
  pass — the cost is redoing one partial run a day.
- **The cursor may not advance past rows that were never written** — `stored`
  gates it, so a failed upsert (a Supabase 5xx, a socket timeout) rewinds the
  cursor to where the run started rather than persisting a claim that rows were
  stamped. A run that scanned chunks 0–2 and then failed its write would otherwise
  have taken 28 days of the window with it on the next run. `pass_stamp`
  deliberately does not roll, because chunks below it were stamped by earlier
  successful runs of the same pass.
- **`MIRROR_COLD_MS` raised 45 → 90 minutes** — `last_ok_at` is the pass *start*
  stamp, so it is already one full pass old when written: a 3-run pass on the
  ten-minute cron peaks at **~50 minutes** of age in ordinary healthy operation.
  Against 45 the mirror would read cold for part of every cycle and every browser
  would fall back to the 9.6s live scan — the mirror built, then not used. What
  makes 90 safe is the near window being re-read on every run.
- **Stale-while-revalidate, through an `openshifts-sync-now` twin** — the
  dashboard reads the mirror and POSTs to the sync **without awaiting** it, so
  AxisCare load follows real usage and a quiet weekend costs nothing; a fixed
  5-minute cron would burn ~4,000 AxisCare requests a day regardless, and the
  `*/10` entry in `netlify.toml` is a floor rather than the mechanism. The
  function holds a lock and a debounce so three schedulers opening at 9am cannot
  fire three concurrent scans — verified, a second run 41 seconds later returned
  `skipped 'synced recently'` in 317ms. **Netlify answers 403 to an HTTP
  invocation of a scheduled function**, so posting to `openshifts-sync` itself did
  nothing at all; the browser posts to `openshifts-sync-now`, which carries no
  schedule and delegates to the same handler. `matching-sync` has exactly this
  shape and its browser refresh has therefore never run — its own `catch` hid it.
- **`revalidateOpenShifts()` repaints the session that nudged the sync** — it
  waits on that run and, if it scanned anything, re-reads the mirror and repaints,
  so a brand-new shift appears on the load that triggered the sync rather than up
  to ~20 minutes later. Three details are load-bearing: it parses the body
  whatever the HTTP status, because a partial run is the normal outcome and the
  handler answers those **502**; it passes `mirrorOnly`, so a cold mirror cannot
  spend a 16-request live scan on a result the caller discards; and it compares by
  **id set**, not by count, because one shift filled and another opened in the same
  window is a real change a count misses. A `skipped` answer gets **one bounded
  retry per page load**, with the two refusals treated oppositely — the lock
  (carries `since`) is waited out ~12s and re-read, the debounce (carries
  `lastRunAt` and a server-computed `agoMs`) is re-nudged once `MIN_GAP_MS` (90s)
  expires. `agoMs` keeps the viewer's clock out of the loop; both paths re-read
  regardless, with the wait clamped to 2–100s.
- **Reverted — the revalidate that replaced `state.shifts` and called
  `relayer(['shifts'])`** — it assigned mirror rows straight over the slice and
  re-layered to put the scheduler's work back. That work comes from the local
  overlay, written only by the 900ms-debounced `doSave()`, so an assignment made
  inside that window existed in memory and nowhere else: the replace dropped it,
  the rebase folded the loss into the baseline, and the next save pushed the
  reversion to all three schedulers. `relayer()` re-applies *every* slice, so the
  blast radius was never limited to shifts either. It now **merges**, keeping the
  existing object for any id already held. **Known open:** a shift *retimed* in
  AxisCare therefore keeps its boot-time hours until reload, because a visit id
  encodes the date but not the time.
- **`shift_date` is sliced textually from the timestamp, never cast** — AxisCare
  stamps its own offset, so `2026-09-18T20:00:00-07:00` is the 18th where the
  visit happens and the 19th in UTC. Measured on the live mirror, **2 of 9** rows
  would have landed on the wrong day under a naive cast. The care-notes sync and
  the caregiver calendar each had to fix this same bug.
- **`verifyShiftStillOpen()` re-checks one visit at assign time** — after boot and
  one revalidate there is no timer and no poll, so the list is as old as the tab.
  Observed this day: the Brenda Janowski 8a–8p visit `v=56967:s=0:d=2026-09-03`
  read `caregiver: null` in the morning and `caregiver: 1104` by the afternoon,
  filled in AxisCare while every open session went on offering it. Re-scanning the
  window costs what the boot costs; re-checking one visit costs **1 request, ~890
  bytes, ~1s**, and the only moment the answer has to be right is the moment
  somebody assigns. Both assign paths funnel through `guardAssign()`. A shift with
  no `axisVisitId` is not checked, an unreachable AxisCare or an ambiguous 404 does
  not block the assignment, and a refusal rewrites nothing — `openStaleShiftWarn()`
  explains and offers a reload.
- **The roster paints on roster + profiles, and never before `profiles` (3b)** —
  `applyProfile()` returns on its first line when `profiles[c.axisId]` is missing,
  so any paint before profiles land carries no `employment_status` and `c.active`
  falls back to the AxisCare label, which is `Active` for everybody because the
  fetch asks `statuses=Active`. Measured: **171 active instead of 100**, with all
  **82** parked caregivers offered for shifts. The paint now waits on that pair
  and nothing else instead of all five boot calls — `fetchProfiles` 2.0s,
  `AxisCare.roster` **2.1s**, `fetchClients` 3.3s, `fetchOpenShifts` 9.5s — taking
  it from **9.5s to 2.1s, a 7.4 second saving**. Three things keep it safe:
  `profiles` is assigned before `applyRoster()` in the early handler as well as
  the settled one, the plausibility guard is repeated in the early handler, and the
  paint cannot trigger a save because `booted` is still false.
- **A faster paint means the empty states have to be honest** — `viewOpen()` used
  to state "All shifts are covered" for the whole boot and then fill with the gaps
  it had just denied. It and the contact-log view check `rosterLoading()` first,
  and say they are still loading rather than asserting a fact the boot has not
  established.
  green tick, which claims we looked and found nothing to do.
- **`COVHIST` split into three questions, three windows, in parallel** — it used
  to get all three from one fetch: the shift's week *plus* thirty days of history,
  unfiltered, for every caregiver — 36 days nobody chose, just the union. Measured
  live, that cost **13 requests / 1,097 visits / 7.7s** to open Find Coverage on
  one shift and **72 requests / 6,015 visits / 42.2s** to work through the nine
  open shifts on the board. Asked separately each is cheap, and each caller asks
  only for what it reads — the date search reads `busy` alone. **Whole board 72 →
  26 requests, 42.2s → 2.6s; one shift 13 → 5, 7.7s → 2.6s.** Verified on this
  account the same day: `clientIds` really does filter server-side — the same 30
  days returned 925 visits across 28 clients unfiltered and 40 visits for 1 client
  with it set. That is the opposite of the `caregiverIds` trap.
- **AxisCare visits written into the shared overlay — in production** — Marjorie
  Willis (AxisCare client **345**) was added as a new client and her three visits
  appeared *after* a scheduler's page had loaded. A re-hydrate ran against the
  boot-time `BASE` and `buildOverlay()` emitted all three as **adds** on the
  `shifts` slice, `status=open, assigned=null`. The desk reported the shifts still
  being offered after AxisCare had assigned all three, and **reloading did not
  help** — `applyOverlay()` only ever assigns, so the stale adds replayed on every
  boot for every scheduler, frozen at the status they were captured with. Clearing
  it took the adds removed **and** the three ids written to `dels.shifts`, since
  `applyOverlay` filters dels before applying adds; end state `adds.shifts 0,
  dels.shifts 0`, verified stable over 80 seconds. Cleaning the shared row alone
  was undone within minutes three times, because `finishBoot()` replays the local
  overlay cache before any server pull.
- **Fixed at source by `rebaseSlices()`, and made self-healing by `patchOnly`** —
  `hydrate()` now reports which slices it actually reassigned
  (`lastResult.refreshed`), `retryAxis()` passes that list to `CLOUD.relayer()`,
  and the relayer retakes the baseline for exactly those slices **before**
  re-applying the overlay, the same order `finishBoot()` uses. Replaying the
  Marjorie Willis scenario against the real `snapshot`/`buildOverlay`/
  `rebaseSlices`: without the rebase `adds.shifts → 3` — the exact ids that bit the
  desk — with it `adds.shifts → 0`, while a slice not in `refreshed` kept its
  scheduler work. Only slices really reassigned may be retaken, and the rebase must
  run before `applyOverlay`, never after. Separately `shifts` was marked
  **`patchOnly`**, joining `caregivers` and `clients`, and `applyOverlay()` now
  refuses a stray add on such a slice — which is what repairs a browser already
  carrying them without anybody being told to do anything. `careNotes` was next in
  line to do exactly what `shifts` did; it was made `patchOnly`, and the matching
  refusal of stray **dels** added, four days later on 2026-09-07.
- **`lastBody` honest again, closing the two-tab write loop (3d)** — `pull()` used
  to set `lastBody=null` after an applying pull, disarming `doSave()`'s only no-op
  guard even when the merge reproduced exactly what the server had just sent. Two
  **idle** tabs held a revision roughly every 15 seconds — **90 in 21 minutes with
  byte-identical data**, each turn running `applyOverlay`, `ROSTER.reconcile()` and
  a full re-render. It is now `lastBody=bodyOf(res.data.overlay)`, so a push
  happens only if the merge left this tab differing from the database. `bodyOf()`
  is order-insensitive over `adds[]`/`dels[]` — verified on the live 387KB overlay,
  reversing all 8 adds arrays leaves the body unchanged — and the retry tick clears
  `lastBody` first so a retry still retries.
- **`CLOUD.relayer()` — re-layer the overlay after any roster rebuild (3e)** —
  `ROSTER.hydrate()` constructs every caregiver from scratch, so a post-boot
  refetch discarded everything `applyOverlay` had written; the rebuilt records then
  matched `BASE`, no patch was emitted, `buildOverlay` dropped `patches.caregivers`
  entirely and the next debounced save wrote that omission to the shared row —
  **all 180 caregiver patches gone, for all three schedulers**. `relayer()`
  re-applies the local overlay, then `ROSTER.reconcile()`, muted so it cannot
  schedule a save half-way, with `muted` restored in a `finally`.
- **The poll reads `rev` first, and the `overlay` column only when it moved (3f)**
  — `pull()` used to `select('overlay,rev,updated_by')` every time and discard the
  column two lines later: **418.8 KB per no-op poll**, ~1.1 MB a minute per
  session, **1.73 GB a day** across three schedulers, to learn one integer. The
  rev-only read is **14 bytes**. `serverRev` is still taken from the second read so
  the revision and the overlay it is recorded against come from the same row
  version, and a missing row falls through to the full read for the first-run
  insert branch.
- **Devi's snapshot widened from three sections to the whole board** — the old
  snapshot left her answering *"I can't see the availability table"*, which the
  prompt was literally instructing her to say. `deviContext()` now sends today's
  date and the roster count, client names and cities, the Today board's critical
  queue and warnings, 40 open shifts, the 20 most recent attendance entries, the
  availability picture, caregivers with no assigned shift and anyone at 38h+, the
  15 most recent schedule changes, care-note alerts with a 110-character excerpt,
  and every active caregiver as name, base, open-day count and skills. Every
  section reads the same function the matching screen reads, so Devi and the
  dashboard cannot disagree; each list is capped by `DV_CAP` (25 by default) and
  says how many were cut, because an uncapped list is how this becomes a
  100k-token request. The live snapshot is ~30–40KB.
- **Six capability rows moved out of Work Preferences into Skills** — transfers,
  bedbound, dementia, hospice, incontinence and errands were removed row by row,
  along with each editor field and Needs Update rule, leaving 15 rows; Skills &
  Experience gained Hospice care and Mobility assistance and widened Transportation
  / errands, reaching 25 options in four groups. Each of the six asked what a
  caregiver knows how to do, which is Skills' question. The stored willingness
  answers under `ops.prefs` are deliberately left on the record and nothing writes
  them into Skills: *"will take a bedbound case"* is not evidence of having worked
  one.

---

## 2026-09-04 — Devi gets a priority ladder and six router builders

The Ask Devi upgrade landed. The system prompt stopped being a list of what Devi could not see and became a description of how the desk actually works, and the local router took six more of the questions schedulers ask daily. No tools were added, and `devi-agent` still forwards no `tools` array — the model produces text and nothing else.

- **`deviSystem()` gained a role, the desk's priority ladder and a response shape** — uncovered today, no-show, call-off, late, then tomorrow, conflicts, availability, care notes; answer first in one line, then the list, URGENT in capitals; plus what to weigh when asked who can cover a shift. Without the ladder Devi listed problems in the order it found them, and a scheduler's first question is always which one first.
- **Six router builders** — `aiNeedsAvail`, `aiOpenAvail`, `aiLate`, `aiConflicts`, `aiMissingNotes`, `aiTodayFocus`. "How many need availability updates" has an exact answer and should never cost a model call to get it; a router answer is instant, free, and nothing leaves the browser. "Which shifts are still open" also fell through to Devi and now routes.
- **Open-day counts read `AVAIL.coverage()`, not `openDays()`** — the whole recordable span rather than a week back to the end of next month. That mismatch is exactly what made Needs Update accuse caregivers whose calendars were full. `openDays` supplies only the next date, which is all it is good for.
- **A count from an unloaded source is a false negative, not a zero** — "none in the next two months" is said only when the availability index is actually ready; otherwise the answer is "next date not loaded".
- **`aiLate` reads both sources** — the EVV alerts the Today board derives *and* the Late entries a scheduler typed on Attendance. Reading one missed every logged one.
- **`aiConflicts` checks overlapping assigned shifts and the overtime line, and says plainly that travel time is not checked** — the stated reason was that around 40% of active caregivers sit outside the distance map, a figure corrected on 2026-09-08 to 8 of 104.

---

## 2026-09-05 — "Availability missing" asks about the current month

Needs Update was checking availability over the whole recordable span, so a caregiver booked out through next spring but blank for September never appeared. The desk staffs one month at a time, so the check now asks about one month.

- **`AVAIL.monthCoverage()`** — a second coverage cache scoped to the 1st through the last day of the current calendar month, derived from `NOW`, with `monthCovKey` forcing a refetch when the month turns over. `cgNeedsUpdate()`'s calendar check points at it.
- **`coverage()` and `coverageInfo()` were left untouched** — `aiOpenAvail()` and Devi's snapshot depend on the whole-window behaviour, so the narrow question got its own cache rather than a narrowed shared one.
- **The warning names the window it checked** — "No availability entered for &lt;Month Year&gt;", so the next report from the desk can be settled off the screen.

---

## 2026-09-06 — Devi can write, behind an Approve button

The biggest day of the period: Ask Devi went from answering questions to preparing changes a person approves, a false "Availability missing" warning was traced to a hard-coded status filter, and the caregiver photo bucket turned out to have gone over its transformation allowance.

- **`DEVI ACTIONS` is the only place Ask Devi changes anything** — verify (the builder reads the live tables), explain, prepare (`dactPrepare()` names every record it would touch), a person clicks Approve, then write through the *same* function the matching screen uses. `dactPrepare()` returns null when there is nothing to do, so a card only appears when there is a real change behind it, and `e.act` rides the turn so Clear takes proposals with the thread.
- **Eight writes wired** — availability warning corrections (`devStampConfirmed`), recalculating Needs Update, creating tasks and completing them (`setTaskStatus`), shift handoff notes, internal scheduling notes, recording availability for given dates (`devAvailWrite` → `carveSegs` → `AVAIL.saveDays`), and recording a work preference or travel distance (`devSetPref`).
- **Proposals come from the router, in code — never from the model** — the two paths never meet: a proposal attaches to a router answer, and a router answer is by definition one the model was not asked about. Caregiver and family messages are deliberately prepare-only.
- **Five rules, each of which cost something** — re-verify at approve, because `pull()` runs every 20 seconds and a colleague can move the record in between; a build that *threw* is not a build that came back empty; hold an id, never a caregiver object, because `ROSTER.hydrate()` reconstructs every caregiver on a Retry; report what happened rather than what was attempted, in the database's own words; and say `DEVI_NO_WRITE` where there is no write path.
- **`dactCommand()` runs before the read router and answers only instruction-shaped input** — which is what keeps "which caregivers have missing availability", a question containing the word availability, out of the write path.
- **"Availability missing" now counts every status, not only `Open`** — reported on Alejandra Gibbs and Aliyah Moran, whose September was already filled in. The query behind the check hard-coded `status=eq.Open`, so a caregiver recorded as Vacation for the whole month came back as zero rows and was chased for availability they had already given. Roster-wide the count went 11 of 12 to 10 of 12: one wrong flag removed, every real one kept.
- **`coveragePage(from, to, offset, openOnly)` carries the two questions apart** — `openOnly: true` for which dates somebody can actually work (`primeCoverage`, Find Coverage), `openOnly: false` for whether anybody has told us anything (`primeMonthCoverage`, the warning). `monthCoverage()` returns both `days` and `openDays`, so the two can never be conflated again, and `state: 'none'` is the only thing that is honestly missing.
- **`forgetCoverage` became `forgetCov()` and drops both caches** — it cleared only the wide one, so a roster re-sync left the month cache stale.
- **Five more router builders for the daily sweep** — `aiCoverFirst` (which gap to work first), `aiRepeatCallOffs`, `aiAvailNotScheduled`, `aiFollowUp` and `aiBadWarnings`, which re-derives every *Availability missing* flag against `AVAIL.monthCoverage()` and names any it cannot substantiate. The desk can now ask the board to check its own warnings.
- **The four-part answer** — `deviSystem()` asks for WHAT I FOUND / WHAT I CAN DO / WHAT THE SCHEDULER NEEDS TO DO / PRIORITY on a *review*; a one-fact lookup still gets the plain answer, because a heading on a single row of data is noise. "WHAT I CAN DO" may never list an action that writes to a record — Devi has no tools, so "I'll update her availability" would be a lie.
- **A dashboard-wide dock — since removed** — `renderDock()` painted a sticky composer strip at the foot of `.main` on every page, hiding itself on the Ask Devi page, so a scheduler working Open Shifts could ask about it without leaving the board. **Taken out again on 2026-09-22**: a bar pinned to every screen is a cost every page pays for something opened occasionally.
- **The photo transform billing overage surfaced** — Supabase meters the number of **distinct origin images transformed** in a billing period, not the number of transformations, and the Pro plan includes 100. With 177 photos a single paint of the caregiver list puts the account over on its own: **167 against an allowance of 100**, found when the desk hit the overage warning.

---

## 2026-09-07 — the two ways a tab quietly destroys the desk's work

A day of data-loss fixes. A caregiver AxisCare did not return on one load was wiping that caregiver's record for every scheduler, and a browser tab left open through a deploy was undoing fixes minutes after they went live. Both now have guards; the photo bucket was measured and re-encoded, and open-shift freshness was fixed at the sync.

- **`CARRY` — a record AxisCare did not return no longer loses the desk's work** — `buildOverlay()` rebuilds the overlay WHOLE on every save, so a caregiver absent from `state.caregivers` emitted no patch and that save wrote a shared row without one: review cadence, work preferences, notes, flags and client blocks gone for every scheduler. `CARRY` holds the last patch known for each record on a patchOnly slice, seeded by `applyOverlay()` from every arriving overlay including patches it could not apply, and `buildOverlay()` re-emits a carried patch for any id not currently in state. A record it can diff always wins, so nothing somebody deliberately changed is resurrected. Reproduced by setting a cadence, booting once with that caregiver missing, and letting the tab autosave — one scheduler with a bad fetch was enough.
- **`dels` are refused on patchOnly slices, out and in** — "in `BASE`, not in state" is the same short read, and writing it as a deletion told every other browser to drop that caregiver from the roster at boot, permanently. Refusing them on the way in repairs a row that already carries some, self-cleans, and closes the `dels.shifts` half of the 2026-09-03 leak.
- **The stale-build guard** — `checkBuild()` asks the server what it is serving now (HEAD, ETag then Last-Modified) and compares it with what the tab loaded. On a mismatch `markStale()` stops writing to Supabase (`doSave()` returns after `saveLocal(o)`), raises a fixed red banner naming the exact keystroke with a Hard refresh button, and the sync pill reads *Refresh needed*. Stopping the write is the load-bearing half — a banner alone is advisory and the whole failure is that the tab keeps saving. A host answering neither header leaves the guard off rather than guessing.
- **Two work losses to old tabs, hours apart** — an import of 17 client blocks was wiped twice by a session open since before the import, and a fix to `pull()`'s re-layer that went live at 15:21:40 was still being undone by a pre-existing tab at 15:24:59. The tell is always the same: a change is saved, looks right, comes back a few seconds later on every machine, with no error and the pill still reading Synced. It cost an afternoon and produced a second "fix" for a bug that was already fixed.
- **`detach()` — `lastSent` must be a snapshot, never a reference** — `buildOverlay()` writes the live object straight into the patch and `revive()` mutates in place, so after a pull `c.ops` and the overlay's copy were one object. Editing ops silently edited `lastSent`, `unsentOnly()` compared a record against itself, dropped it from the re-layer, and the incoming overlay wrote the older copy over the scheduler's edit — the same silent loss the change existed to stop, arriving through the drop side. Caught in review.
- **`openshifts-sync` re-reads the near window every run** — measured: a full pass is **16 requests, 1,323 visits, 9,622ms** against a `SOFT_DEADLINE_MS` of 6,000, so a pass always splits across runs. A resumed run began at the cursor out in late October and did not look at chunk 0 (today → +13 days), where a scheduler adds an unassigned visit: **3 runs in 6** skipped it, up to ~20 minutes stale, while `last_ok_at` stayed fresh and every browser went on trusting the mirror. Reported by the desk on 2026-09-03.
- **Four rules on that refresh, all load-bearing** — it goes **second**, after the run's first cursor chunk (ordered first and simulated at 3× latency, the pass never completed in 40 runs and `last_ok_at` froze); it is best-effort; it must not advance `cursor_chunk`; and skipping it is not a failure, because recording it as one denied `complete`, blocked the sweep and froze `last_ok_at` forever. `HARD_DEADLINE_MS` (9,000) was added alongside, with `window_from`/`window_to` restarting a pass whose chunk list moved at midnight and `pass_stamp`/`stored` gating the cursor.
- **`revalidateOpenShifts()` — the revalidate half now reaches the session that triggered it** — the read happens before the sync it kicks off, so on its own the board showed the state beforehand and the scheduler just reloaded again. It parses the body whatever the HTTP status (a partial run is normal and answers 502), passes `mirrorOnly` so the re-read never falls back to a 16-request live scan, compares by **id set** rather than count, and **merges rather than replacing** — an earlier version assigned mirror rows over `state.shifts` and called `CLOUD.relayer(['shifts'])`, which dropped any assignment made inside the 900ms save debounce and pushed the reversion to all three schedulers.
- **The photo bucket's problem was the format** — measured: every object over 500KB was a PNG and every PNG was over 500KB. 33 files, 57.4MB of a 64.9MB bucket, against 144 JPEGs averaging 53KB. Re-encoded to JPEG at their exact pixel dimensions, asserting on every file that the dimensions were unchanged: bucket **64.9MB → 11.0MB**, the 33 PNGs 57.4MB → 3.5MB, largest object 2268KB → 432KB, objects over 500KB **33 → 0**.
- **Three smaller same-day fixes** — a saving bug, blocking added to client matching, and missing caregiver information (`bca1849`, `26ff6e0`, `c079e17`).

---

- **`caregiver-photos` gets `anon` write policies** — `storage.objects` was given INSERT / UPDATE / DELETE / SELECT for `anon` on the bucket, Mitch's call, for consistency with how the rest of the app wrote at the time. Those policies were dropped again with the PIN gate on 2026-09-18.

---

## 2026-09-08 — Find Coverage ranks the client first

The calling order was rewritten with Carlo around one rule: what the client wants decides the top of the list, what the caregiver wants decides within that, and geography breaks what is left. Along the way two ranking inputs turned out never to have run at all, and the photo bucket was resized to match the fact that the browser now downloads originals.

- **`coverageMatches()` rewritten — the only place the order happens** — client terms: on this client's Concierge list **+60**, AxisCare `preferredCaregiver` **+50**, worked with this client in the last 30 days **50 + (visits−1) × 1.5** capped at 70, and **+10 / −20** where the client needs a driver — the −20 became a warning with no penalty on 2026-09-21. Caregiver terms: +12 for a city they asked for, −25 past their stated `maxMiles`, +8 / −15 for client-gender comfort, +6 for hours they prefer. Logistics: drive time `max(0, 20 − 0.45 × minutes)`, and −8 / −25 at 32+ / 40+ hours already booked in the shift's Mon–Sun week.
- **The magnitudes are load-bearing, not taste** — everything on the caregiver's side tops out at **+26** and drive time adds at most **+20**, so **46** is the most preferences and geography can ever contribute. Each of the three terms that say *the client asked for this person* is worth more than 46 on its own, which is what makes "the client first" arithmetic rather than an average.
- **Concierge's matched caregivers got ranking weight for the first time** — `CLMATCH.matches()` had exactly one reader in the file, the read-only card on the client schedule page, so a caregiver the desk had explicitly matched got nothing. Measured: **53 rows**, every one resolving to an Active caregiver, and only **6** coincide with the AxisCare `preferredCaregiver` the ranker was reading instead. Ten active clients have Concierge matches and no AxisCare preferred caregiver, so for them the ranker believed nobody was preferred.
- **`match_state` is name resolution, not strength of preference** — the first version of this change scored `confirmed` at +60 "Client's chosen caregiver" against `auto` at +22 "Suggested for this client", and both labels were false. Client 217 lists five names, all equally asked for; exactly one is `confirmed`, and only because Concierge spells her differently — ranking her 38 points above the other four would have been an artefact of spelling. Every resolved name now carries the same weight, `sort_order` separates them, and `unmatched` rows are skipped.
- **The client driving requirement was reading a property nothing ever assigned** — `covClientPrefs()` read `cl.drivingRequired`, so `prefs.drivingRequired` was permanently `null` and the ranker's driving branch could not execute at all. Worse, `covMatchNote()` used that same null to tell the desk *"No driving requirement is recorded either"* on two active clients — Mary Lou Brown and Ziad Niazi — where Concierge plainly records that one is. It now reads `client_match_prefs.driving_required` through `CLMATCH`, with `cl.drivingRequired` left underneath for seed clients.
- **`maxMiles` is a penalty, not a gate** — Carlo's call: the hard gates have already decided who can genuinely be called, and somebody who said 15 miles may still say yes to 18 for a client who asked for them.
- **Four dead ranking terms removed, none of which changed an order** — +25 for availability and +12 for matching the gender preference (both hard gates, so every surviving row scored them and nobody moved, and the gender term's −25 branch was unreachable); the ±500 for a previous contact, which `renderCoverageCommand()` makes unreachable by filtering everybody in the contact log out of the queue before the order is drawn — **if that filter ever goes, this has to come back**; and the blanket "Driver" chip, pushed onto 69% of rows and worth exactly zero unless the client needs one.
- **`c.prefCitiesRecorded` is hard-`false` in the mapper, with `applyProfile()` its only writer** — the first version derived it as `!!(m.prefCities && m.prefCities.length)`, but `AxisRoster.mapCaregiver` has already filled `prefCities` with the mailing address by that point, so the flag was `true` for exactly the caregivers it existed to exclude. Without it, "Wants to work in Oxnard" is claimed for anyone who merely lives there, and double-counts against the distance score. A no-op guard that reads like a working one survived one review pass.
- **A client-gender class tag may earn the bonus and never the penalty** — `prefVal()` reads a present `CFC` with an absent `CMC` as "Female clients", but nobody ever ticked `CMC`, so that absence is silence rather than a stated preference; two active caregivers (AxisCare 248, 321) are in exactly that state. Only a typed `ops.prefs.clientGender` can hold somebody back.
- **A documentation correction: 8 of 104, not ~40%** — the claim that around 40% of active caregivers live outside the app's distance map was wrong by about four times, and it mattered, because it made the distance term look hopeless when it is nearly fine. Measured on the live roster: **8 of the 104 schedulable caregivers** live in a city the 12-entry `CITY` map does not know, and seven of the eight have Open availability typed.
- **`MAX_EDGE` dropped 1433 → 512 and 104 photos were re-encoded** — bucket **11.3MB → 3.7MB**, with the 75 already under the cap left alone. With no server-side resize the list downloads originals, and at 1433px that meant a median avatar of 64KB, a worst case of 432KB and about **1.6MB for twenty-five visible rows**, while nothing in the app displays above 160px. A JPEG that already fits passes through byte for byte; a **PNG is always converted** even when it fits, because PNGs average 1.74MB against 53KB and schedulers upload straight from a phone; and the canvas is filled white before drawing, because JPEG cannot be transparent and every transparent pixel otherwise encodes black.
- **The transform endpoint is out of the code** — `cgPhotoUrl(c, px)` returns the plain object URL, always, and the browser scales with `object-fit:cover`; `px` stays only because it says how big the slot is. The overage is a period total, so this stops the number climbing — it does not refund what was already spent.
- **Three small profile and sidebar corrections** — two sidebar items renamed and two reordered with the menu type taken down; ticking a Skills & Experience option no longer throws the modal to the top; and Assignment & Client Rules became a plain client checklist with no per-block dropdowns.

### Caregiver photos, the same day

- **`CGPHOTO` — upload and remove a caregiver photo** — a menu on the profile photo with Upload photo and Remove photo, the file dialog filtered to JPEG and PNG, the object key the **bare AxisCare numeric id with no extension** (`312`, not `a312` — the wrong key writes an orphan nothing displays), and the MIME type re-checked after the dialog because `accept=` is advisory on some platforms.
- **Delete treats only a genuine not-found as "already gone"** — Storage answers 400 for a missing public object, for a bad request, and on some versions for an RLS refusal with the real 403 buried in the body, so the first version reported "Photo removed" while the photo reappeared in the same frame. It reads the body now.
- **The photo menu used CSS variables that do not exist** — `--panel` and `--bad-tx`; this app's white is `--surface` and its danger red `--crit-tx`. An invalid custom property makes the whole declaration compute to `unset`, so the icon vanished into its own dark circle and the menu had no background at all.

---

## 2026-09-11 — Quo arrives, and the desk finally gets a name

Quo — the phone system, called OpenPhone until it rebranded in 2026 — landed as a read-only Supabase Edge Function with no reader, the same staged way the AxisCare proxy went through, and the **Communication Logs** card was built on it the same day. Most of what the day actually cost was measurement: which inboxes the key can see, what the list routes silently ignore, and which documented limitation turned out not to be real at all. Separately, `state.onShift` left the shared overlay, so work stops being stamped with somebody else's name.

- **`supabase/functions/quo` — a read-only proxy, plumbing first.** `QUO_API_KEY` is a Supabase project secret, so the function reading it has to be a Supabase Edge Function, which means **a commit does not deploy it**: `npx supabase functions deploy quo --project-ref gdzgoyawavffjdjpjbfz --no-verify-jwt`. Deployed and verified live the same day. A Quo fix can look deployed and not be — Netlify going green says nothing about it.
- **The API key sees TWELVE inboxes, not the four the Quo app shows a signed-in user.** Confirmed live: Scheduling, Recruitment, Client Support, Client Inquiry, Emergency Hotline, Billing, Finance, CEO Direct, Marketing Direct and three Primary lines, plus nine users (five owners, two admins, two members). That gap is the whole reason the card sweeps every line rather than the single Scheduling line it was first asked for.
- **Correction: call summaries, transcripts and recordings DO work on this account.** The docs said Business/Scale plans only, answering `403`, and that had been written down without ever being tested here. Measured against the live key, `/v1/call-summaries/{callId}`, `/v1/call-transcripts/{id}` and `/v1/call-recordings/{callId}` all answer **200**, and **14 of 14** answered calls longer than 45 seconds came back `status: "completed"` with bullets and next steps. A documented limitation that is not real is as expensive as an invented field — it stopped a working feature being built for half a day.
- **`name[]` is a silently ignored filter.** Measured: `?phoneNumbers=PN0T9aATba` returns 25 rows all from that one inbox, while `?phoneNumbers[]=PN0T9aATba` returns 25 rows from **six** inboxes — HTTP 200, byte-identical to sending no filter at all. The `caregiverIds` trap again in a different API. The proxy repeats the parameter instead, uses `params.append` and never `params.set` (which would turn a group lookup into a one-person lookup with no error), and percent-encodes `+` as `%2B`, because a raw `+` decodes to a space — a different phone number, not an error.
- **Auth is the raw key, and `maxResults` is required despite a documented default.** `Authorization: <the key>`, no `Bearer`; measured that `Bearer <key>` also returns 200 — Quo appears to strip the prefix, and the documented form is sent anyway — relying on undocumented leniency is how an integration breaks during somebody else's refactor. There is no version header, so **no `QUO_API_VERSION` to invent**. `/v1/messages`, `/v1/calls`, `/v1/conversations` and `/v1/contacts` all reject a call without `maxResults`, and the 400 reads like a bug in our proxy.
- **Communication Logs replaces the Call Log card on the Caregiver Overview.** `CGCOMMS` fetches, `cgCommsPanel` draws, both live — no table, no sync job, nothing scheduled. The old card was derived from `state.contactLog`, whose whole database held **exactly one** hand-logged entry, so nothing of substance was displaced; `state.contactLog` itself is untouched and still written on the assign path.
- **It sweeps every line, and that is measured rather than a preference.** Over the 600 most recent conversations: Scheduling **110** caregiver conversations, Recruitment **43**, Client Support **30**, Client Inquiry **9**, the other eight lines **0**. **111 of 181** caregivers appear, and a Scheduling-only card would have missed **82** conversations, most of them Recruitment — exactly where a new caregiver's first contact lives. `lineList()` reads `/v1/phone-numbers` once per session, so a new line appears on the next reload with nobody editing `index.html`. An earlier plan's `QUO_SCHEDULING_INBOX_ID` secret was dropped: nothing used it, and discovery is better than a name in an env var.
- **24 requests per caregiver, at concurrency 4.** 12 lines × (messages + calls), plus `/v1/phone-numbers` and `/v1/users` once per session; typically **2.3s**, worst seen **4.2s** (Edna Arma, 110 items, 78 entries). `CONC` is 4 because Quo's ceiling is **10 requests a second for the whole API key**, shared by all three schedulers: at concurrency 5 the 24 requests ran at 10.6 req/s and took **four 429s**. The Edge Function retries a 429 with backoff on top — the pool keeps one browser polite, the retry covers two colliding. `userList()` deliberately never rejects, so a failure there costs the staff names and not the sweep.
- **`toE164()` is deliberately strict, and that is the safety property.** A loose match here would show one caregiver **another caregiver's** private messages. Measured across 183 active caregivers, **182 have a number and every one is `999-999-9999`**; the normaliser accepts that shape, tolerates a leading `1`/`+1`, and returns null for everything else — extensions, non-NANP numbers, and an area code or exchange starting `0` or `1`, which a bare ten-digit length test would wave through. Nothing is written back onto `c`: `c.phone` rides the `caregivers` CLOUD slice, so normalising in place would diff into the shared overlay and replay for all three schedulers.
- **One row shape now serves both the card and the modal rail.** The first version was reported as ugly — a flat list whose most prominent slot held a long dot-separated meta line that wrapped and repeated "Scheduling Department" down the whole column. It is now glyph · bold heading · timestamp pushed right · a two-line gist, identical in both places, so moving between them is continuous. **The bold slot holds who at the office handled it, not the line**, because the line is usually the same word repeated while staff names vary and are what a scheduler scans for; `cmLine()` strips the category suffix so "Scheduling Department" renders as "Scheduling".
- **View Details became master / detail: a 330px rail against a detail pane, in a `min(875px, 94vw)` dialog.** 330 is a measured floor, not a guess — swept in Chromium at the 875px dialog against the longest staff list that occurs, 300 and 316 both clip "Deprise, Kristine, Marivic" and 330 clips nothing. 875 is what Mitch settled on after finding 1340 too big; **94vw is the fit-to-screen guard** below a ~931px window, not a second opinion about width. `.cm-lineq` is `flex:0 100 auto`, because flex shrinks in proportion to factor × base width and at 1 and 1 the name — the wider item — gave up more and ellipsised first, exactly backwards.
- **`.mwide` is 680px, not 880 — there is an `!important` nothing hints at.** `.mwide{max-width:680px!important}` sits ~70,000 characters further down the stylesheet, wedged between `.qs-customtog` and `.rv-grid` with no comment, silently overriding `.modal.mwide{max-width:880px}`. That is why two attempts at widening this dialog **changed nothing on screen** while looking correct in the source. The fix is the dialog's own `.mcomms` class, marked `!important` too, added in `openCgAll`, re-asserted in `renderCgAllModal` so a re-render cannot lose it, and removed in `closeModal` and for any other `which` so switching card type in place cannot leave a Notes modal oversized. Nine assertions cover that lifecycle.
- **Three card layout warts, each reported from a screenshot, plus the split height.** Row separators are a **top** border on every row but the first — the card clips at a fixed height, so the visually-last row is almost never `:last-child` and a bottom border left a stray hairline. `cmFit()` trims the list to a whole number of rows at `n*rowH − 1` and **must run after `pfxFit()`**, which measures the *full* list to decide whether View Details appears: cap first and the button vanishes along with the only way to reach the other 46 entries. `.pfx-more` loses its `border-top` on this card only, since the card already ends in its own separators. And `.cm-split` is `calc(62vh - 148px)` rather than a round `vh`, because `.mb` is itself `max-height:62vh; overflow:auto` and a taller split put a **third** scrollbar outside the dialog.
- **Reverted the same day: a bottom fade over the clipped card list.** It was tried before `cmFit()` and made things worse — a gradient over text that is perfectly readable reads as broken rather than as "there is more". Cutting on a row boundary means there is no partial row to disguise in the first place.
- **`renderCgAllModal` preserves the rail and detail scroll positions.** It replaces `innerHTML` wholesale, so every pane inside is destroyed and recreated at `scrollTop` 0: clicking a row near the bottom of a 78-row rail threw the list back to the top and scrolled the chosen row out of sight — the one thing a master/detail must not do — and the summary landing a second later did it again.
- **The call summary is lazy, and a 404 is not an outage.** `CGCOMMS.loadSummary(callId)` fires the first time a call is opened and caches by call id; a caregiver has ~50 calls, so fetching every summary during the sweep would be 50 more requests against a 10/s ceiling for content nobody asked to see. Four states, three of them not failures — `loading`, `ready`, `none` and `error` — and measured on Alejandra Gibbs, **4 of 14** calls answer 404, every one short or unanswered, so a 404 maps to `none`.
- **The "Quo function is not deployed" message was appearing while the function served the request.** Supabase answers a missing function with `{"code":"NOT_FOUND","message":…}`, which has no `error` key, so the module's generic `body.error || 'HTTP '+status` printed a bare "HTTP 404" and buried the only useful sentence. The 404 test now runs first and does not depend on body parsing, and the branch checks **whose** 404 it is — the proxy's envelope (`{ok:false, status:404, error}`) or the gateway's. Once a proxy forwards upstream statuses, a status code alone no longer identifies who answered.
- **The message thread is chat bubbles, reversing the old app.** Mitch asked for "messenger vibes" having seen both, so this is a decision rather than drift. Caregiver left, desk right, attribution *under* the bubble, `white-space:pre-wrap` to keep the line breaks people typed. **An undelivered text gets a red bubble and "Not delivered"** — one live thread shows the same message sent twice at 3:00 PM, both undelivered, before a third got through at 3:01, which the sender had no way of knowing. The **rail stays a flat list**: bubbles are for reading one conversation, not scanning fifty.
- **Unanswered calls and undelivered texts are shown — a deliberate divergence from the old app**, which filtered them out on Mitch's own July 10 instruction, in a card about client conversation summaries. Here the log is for a scheduling desk, where "we rang her three times and she never picked up" is the point. Measured in a 14-caregiver sample: **30 of 271 calls unanswered** (12 `no-answer`, and 18 reading `completed` while carrying no `answeredAt`) and **9 of 314 texts undelivered**. `answeredAt` is the only reliable mark, so status alone is not enough.
- **Timestamps and the text-day grouping are pinned to US/Pacific**, with an explicit `America/Los_Angeles` — Quo stamps UTC, and a scheduler on a laptop set to UTC would see yesterday evening's texts filed under today, the same class of bug that already bit the care-notes sync and the caregiver calendar. Six card states, three of which must never read as "no communications": `nophone` / `idle` / `loading` / `error` / partial / ready. A partial sweep says so and offers Retry rather than passing a short list off as the whole log.
- **The grey facts box came out of the detail pane.** Reported as "redundant information": the boxed `<dl>` held direction, outcome, duration, agency line and who handled it, every one of which is already on the rail row the scheduler just clicked. `cmFact()` and `.cm-facts` went with it, and what remains is one dot-joined line saying what the row does *not* — exactly when, how long ago, and how the call went.
- **`state.onShift` moved out of the shared slice and into `localStorage` under `dcs_on_shift_v1`.** Until today it was the literal string `'Mae'`, written by nothing, so every scheduler's work — caregiver notes, `ops.lastUpdatedBy`, availability confirmations, task completion, call-offs, ratings, client blocks, about **60 read sites** — was attributed to Mae whoever was typing. As a tracked CLOUD **scalar** it was harmless only because nothing wrote it: `applyOverlay()` assigns a scalar straight onto `state` on every poll, so the moment a picker wrote it the desk would have had one selected person, each choice overwritten by the other within 20 seconds. The picker's `SCHED_PEOPLE` — Mitch, Sean, Carlo, Mae, Jen, Angelica, Patty, Tine — is deliberately separate from the shared `state.schedulerNames`, still `['Mae','Sunshine','Kristine']`, which task assignment and the shift handoff read; past work is correctly stamped with the names people used. A stored name no longer in the list falls back to Mae rather than being trusted, and every storage access is wrapped because a private window throws on `localStorage`. Carlo's call.

---

## 2026-09-14 — Quo learns to send, and the care-needs line

The Quo proxy gained the first mutation in this codebase: `POST ?action=send`, one action and no other, behind four guards that were described and agreed before any code was written. Find Coverage's Text button stopped being an `sms:` deep link and started sending a real, billed, irreversible text from an agency line. A second Edge Function, `care-brief`, began writing the one-line care-needs summary the weekend template carries. And a three-line CNA field taught the rule that adding a Work Preference touches seven lists, not one.

- **`action=send` — the proxy's first and only mutation** — `supabase/functions/quo` now accepts GET, plus POST for exactly one action. Four guards: the destination must be on the active AxisCare roster; `from` must match a live `/v1/phone-numbers` line; `SEND_HOURLY_CAP` 200 per isolate; `SEND_MAX_RECIPIENTS` 25 and `SEND_MAX_CHARS` 1600. Guards 1 and 2 are the real protection, 3 and 4 bound the blast radius, and guard 1 **fails closed** — a roster read that fails, comes back empty or comes back truncated refuses the send and caches nothing. Test mode is stricter than the old Scheduling app's: the destination must be one of the agency's own lines, or "test mode" is an unrestricted send-to-anywhere with a friendlier label. The next request is the second mutation and a new decision, not a precedent.
- **The allowlist reads the app's own public Netlify AxisCare proxy** — `QUO_ROSTER_URL`, rather than a second copy of the AxisCare token in Supabase; that endpoint is already world-readable, and while the variable is unset sending is refused entirely. Measured live: **1 request, 1.45s, 183 active caregivers, 188 distinct E.164 numbers**, every active caregiver with at least one usable number. All three of `mobilePhone`, `homePhone` and `otherPhone` are collected. `rosterCursor()` follows `nextPage` as a **full URL** — written wrong first, and passing it back as `startAfterId` would have "verified" the whole roster against its first 200 names.
- **Fixed: a recipient's name could inflate a message 5,000-fold** — `personalise()` used `String.replace` with a string replacement, which honours `$&`, `` $` `` and `$'`. Measured: a 1,524-character template under the 1,600 limit plus a 10,000-character name of repeated `$'` produced a **7.5 million character** body, roughly **49,000 billable segments**, from one request that passed every guard. Three fixes, all needed — the replacement is a function, the first name is capped at 40 characters, and the length is re-measured after substitution. It also mangled the message of any caregiver whose own name contained a `$`.
- **Fixed: a tick could outlive the shift it was made on** — `covSelBar()` counted the ticks in the queue on screen while the button opened on every tick in the tab, so it read *Text 1* and the composer opened with five. The draft is built from the current query, so four people would have been texted about a client, date and time they were never considered for. The bar now derives one list and hands it to `openCoverageTextSel(ids)`, and `seedQueryFromShift()` clears `state.covSel` when the shift changes.
- **Fixed: the rate limiter never drained, and a stuck cursor read as a complete roster** — the limiter pushed its timestamp before comparing, so hammering after a 429 kept the window topped up and one burst latched the proxy shut for an hour; only an allowed request is counted now. `RATE_MAX` moved **120 → 720**: one Communication Logs card is 24 requests, so the old ceiling was five caregiver profiles an hour per scheduler. Separately, a roster sweep whose cursor stopped moving was being recorded as complete and cached as a partial allowlist for ten minutes — right for a list, wrong for the thing that decides who may be texted. From the same pass: an empty `/v1/phone-numbers` result is no longer cached, and a failed send gets send-specific advice instead of the read routes' *"maxResults is REQUIRED"* hint.
- **A send is never retried, and `to` carries exactly one number** — `sendOne()` deliberately does not use `callQuo()`, which retries 429s and 5xx: a request that timed out may well have reached Quo, and retrying it texts the caregiver twice. The endpoint answers **200 with per-recipient verdicts** even when some failed, because a status code that invites a blind retry would text people twice. A multi-element `to` array creates a group thread where every caregiver sees every other caregiver's number, so the function loops and POSTs once per recipient.
- **Verified — 78 handler tests, then 22 probes against the deployed function** — **78 tests** against the real handler with Quo and AxisCare stubbed, so nothing was sent and nothing was billed, plus **22 probes** against the deployed function: an off-roster number, a spoofed sending line, an empty message, 27 recipients, an over-long body, a send over GET, a POST to a non-send action, PUT/PATCH/DELETE, and a test-mode destination that is not one of our own lines. All 22 were designed to be refused and all were refused; no text reached anybody.
- **Texting a caregiver from Find Coverage** — `QUOSEND` resolves who and which line, `renderCoverageTextModal` draws, and the Edge Function does everything that matters. Every row in *Call in this order* gets a tick box and a **Text N** bar; ticking several sends each of them their own private message, explicitly not a group thread, which Mitch said was not wanted yet. A caregiver with no phone number gets no checkbox at all, and after a send only the recipients who actually received it are unticked, so a retry is one click. Nothing is written to `state.contactLog` — `renderCoverageCommand()` drops anybody in the contact log out of the calling queue, so logging a text would make the caregiver vanish from the list the moment the message went out; the record lives on their Communication Logs card, live from Quo. `state.covSel` is per-browser and must never reach `SLICES` or `localStorage`.
- **The scheduler picker maps to Quo by email** — eight names to nine workspace members. Not by name, because the two lists genuinely disagree and Quo records Jen as `"Jenn "` with a trailing space; not by Quo user id, because an id is opaque and a member removed and re-added gets a new one. `QUOSEND.who()` prints the resolved mapping. A name with no mapping is not an error — it sends with no `userId` and Quo applies its default. **Send as** is re-derived whenever **Send from** changes, because Quo requires the sender to be a member of the line and the lines differ sharply: Scheduling Department carries all nine members, Recruitment carries two.
- **One recipient reads their own name; several read `{name}`** — with one recipient the first name is baked into the draft so the scheduler reads the exact words that will arrive; with several the draft carries the literal token and the Edge Function replaces it per recipient. Without the flag a batch built from the first ticked caregiver greeted everyone by that one person's name. `buildCoverageText(cgId, key, multi)` takes it and both call sites pass it; `personalise()` deletes every other `{token}` rather than transmitting it. Written wrong first and caught by the browser test, not by reading.
- **The Assign button is gone from Find Coverage** — removed at Mitch's request; it had no working behaviour behind it on this screen. `dispAccept` and `assignShift` are untouched and still reached from the Today board, the Auto-offer modal and the quick-contact modal. Dead `covCandRow()` went with it — zero callers since the coverage rewrite, and it carried the last `multi` parameter in the coverage screens.
- **A client's name in an outbound text is the given name only** — `shortClientName()`, Mitch's call: "Brenda Janowski" becomes *Brenda*, because a text is forwarded, screenshotted and read on a lock screen. It went in that morning as "Brenda J." and lost the initial the same day across every template. The given name is kept whole — "Mary Lou Brown" is *Mary Lou*, "Duane & Lynne Georgeson" is *Duane & Lynne* — and a suffix is stripped first, since AxisCare stores `"Calvin George"` / `"Miller Jr"` and dropping the last word would keep *Miller*. Verified against all 21 active clients; outbound only.
- **Outbound templates forced to GSM-7 — 44% cheaper** — one character outside the set makes the whole message UCS-2 and drops a concatenated segment from **153 characters to 67**. **12 of the 14 outbound templates were paying that for a single en dash in the time range**: one send of each cost **45 segments where plain ASCII is 25**. En dashes, em dashes, curly quotes and ellipses replaced with `-`, `'` and `...`, with a note above `TEXT_TEMPLATES` and a regression test that renders every template and asserts it stays GSM-7.
- **`care-brief` — the care-needs line on the weekend template** — `supabase/functions/care-brief/index.ts` reads Client Concierge itself and returns one finished sentence describing what the caregiver would be taking on. AxisCare has none of this: `triageLevel` and `priorityNote` are null, client `classes[]` are payment type only and `/api/adls` is a catalogue. Concierge holds it in `concierge_records.data.careNeeds` plus the `fallRisk` / `cognitive` / `hospice` columns, with usable content for **18 of 18** active clients. The function fetching its own data is the PHI design — the raw clinical record never reaches the browser and is never stored in the Scheduling database, and there is no `fields` parameter: a caller passes a client id and gets a sentence. Send is blocked only while the line is **still coming**; nothing recorded, or a line written and discarded, are finished answers and `ctCareWarn()` says which happened. `CARE` caches per client per session, and `buildCoverageTextWithout()` tells an untouched draft from the scheduler's own words so an edit is never overwritten when the line lands.
- **Abandoned: copying Concierge's own `caregiverBrief`** — the first plan was one source of truth and one AI. Dropped on measurement: it exists for **1 of 18** clients and its `shift.must_know` runs five sentences (~600 characters) rather than a line, so copying would have meant running 17 more briefs first.
- **The medication denylist was replaced by a closed-set regex** — the 25-name list missed **48 of 51** realistic home-care medication strings, and two of its own entries could never fire (`\bmg\b` cannot match `"10mg"`; `\bstatin\b` cannot match `atorvastatin`), while `SAFE_FIELDS` had no filter at all. A drug-name list cannot work, so the regex now covers only the closed parts — dose amounts with or without a space, sig abbreviations, forms/routes/devices, and suffix families (`-statin`, `-sartan`, `-xaban`, `[aeiou]lol`, `-prazole`) — and the model handles the rest: **94% missed → 8%**, zero false positives on real care text. Filtering moved to per-sentence, so a medication sentence is dropped and the rest of the field kept. `{2,}` not `{3,}` because *losartan* is lo+sartan, `[aeiou]lol` not `olol` because *carvedilol* ends "ilol", and `iv` is left out because it matches the "IV" in *Calvin Miller IV*. The work landed inside the commit titled *fix btn size difference*, whose `index.html` half is a one-line button change.
- **The medication checker pinned to `temperature: 0`, and `max_tokens` raised 1024 → 4096** — diagnosed on Duane & Lynne Georgeson (331), who lost their care line about one run in three: the checker called *"Velcro compression wraps"* and *"soft neck brace"* medication, and the **same sentence got YES three times and NO twice**. A client keeping or losing their line on a coin flip is worse than either answer, so the checker is deterministic and the prompt now lists explicit equipment negatives; "glaucoma drops" was added to a pattern that only knew `eye drops`. Separately, `max_tokens` includes thinking and 1024 was not enough over a care record of several thousand characters — **4 of 18 clients returned empty and 3 more were cut off mid-sentence**. `TARGET_LINE` (170) and `MAX_LINE` (200) stay deliberately different, and umbrella terms — `personal care`, `ADLs`, `full care`, `assistance as needed` — are forbidden with a test asserting none appear, because a caregiver cannot decide whether they can take a shift from a category name.
- **`.q-b` given `font-family` and `line-height`** — reported by Mitch as *"the Call button is bigger than the Text button"*, and measured at **Call 28.09px against Text 24px**: a `<button>` inherits neither property, so the Text button rendered in Arial at `line-height:normal` beside the Call anchor in Inter. `1.4` is exactly what the anchor already computed, so buttons grow to match and nothing else moves. Shared class, so it also squares up Skip, Decline, No answer and Callback.
- **Adding a Work Preference touches seven lists, not one** — a CNA Yes/No field was added to Work Preferences by adding `'cna'` to `WP_TRI`, which is true of the editor and of nothing downstream. **Four of the seven were missed**, and `CG_REQUIRED`, `CG_WATCH` and `DV_PREF_FIELDS` are each a separate visible failure: the desk is never prompted for the field, answering it leaves no audit entry, and Devi cannot record it. Mitch reported it as *"the newly added CNA is not appearing for every Caregiver in Needs Update."* `prefVal()` has to land in the **same change** as `CG_REQUIRED`, or Needs Update chases everybody — on CNA that was **4 active caregivers** carrying the class tag who would have been rung about a certification already on file. A tag is a Yes, silence is silence: `cgTag(c,'CNA')` returns `true`, no tag returns `null` and never `false`, and a typed `ops.prefs.cna` is checked first.
- **Devi's approval card shows the effective value, not the stored one** — `dactPrefProposal` read `ops.prefs[k]` directly, so a caregiver whose answer comes from a class tag was described as *"currently not recorded"* while their profile plainly read **Yes**. Telling somebody they are filling a blank at the moment they click the button that writes is wrong when they are overwriting a recorded answer. It now reads through `prefVal()` and says *"(from the AxisCare tag)"*, fixed for pets and overnight as well as CNA rather than special-cased.
- **Devi stays prepare-only for messages, on a re-grounded reason** — the dashboard now has a real SMS channel, so the old justification ("there is no vendor and no secret") has gone. What remains is the stronger one: **Devi has no tools**. A send cannot be unsent, it costs money and it lands on a real person's phone, so every text this app sends is composed by a person in a modal with a named recipient list in front of them. Wiring Devi to `Quo.send` is Carlo's call and re-opens the whole safety argument.

---

## 2026-09-15 — Summary by Devi, the Overview splits in two, and a delete stays deleted

Four pieces of work landed. `comms-summary` puts one or two sentences on top of whichever call or text day is open in the Communication Logs dialog; the Caregiver Overview became four cards and the Profile's combined Skills card became two; and the desk reported that a deleted Note came back about a second later, which tombstones fix. Three of the four are `index.html` only — the Overview and Profile splits change no table at all.

- **Summary by Devi — `supabase/functions/comms-summary`** — a short summary above the heading of whichever call or text day is open, labelled so nobody mistakes it for Quo's, which stays underneath so the two can be compared. `CGCOMMS.loadDevi()` asks, `cmDevi()` draws, `cmDetail()` places it. Written once when anybody first opens the conversation and saved in `public.comm_summaries`; every later open, by anybody, reads the row. A call keys on `call:<callId>` and never regenerates; a day of texts keys on `text:<lineId>|<YYYY-MM-DD>|<+1…>` and regenerates when the day gains a message — **Quo's count decides, not the browser's**, because the sweep reads only 50 messages per line. **The phone number is in the text key** because the dialog's own entry id is `<lineId>|<day>`, which two caregivers texted on one line on one day share, and keying on that would show one caregiver the other's summary. Measured on Haiku 4.5: 750–1,440 tokens in / 28–74 out, about **$0.001–0.002 a summary**, 2.1–2.6s on a warm function and **0.25–0.6s on any later open**.
- **Only ids go up — the function reads Quo itself** — the browser sends `{kind:'call', callId}` or `{kind:'text', lineId, day, phone, count, lastId}` and nothing else. Posting the messages from the browser would be less code and would let anyone with the site URL save invented summaries into the table and spend the Anthropic key on any text they liked, because there is no login. `comm_summaries` has RLS on and **no policies at all** — verified, the anon key gets `401` on both select and insert, deliberately stricter than `care_notes`. `GEN_HOURLY_CAP` is 400 model calls per isolate. If the roster read through `QUO_ROSTER_URL` fails the summary is shown but not saved, so the next open can name the caregiver.
- **`redact()` — the prompt rule did not hold** — version 2 capped the summary at two sentences under 40 words and *told* the model to leave out contact details. It kept to the length on all four rows it rewrote and **still wrote an applicant's email address into one of them**. `redact()` now replaces email addresses, phone numbers and links before they leave the function and again over the output, which also means they never reach Anthropic at all. Street addresses have no reliable pattern and are left to the prompt. `PROMPT_VERSION` is 4.
- **Office staff are named from who SPOKE, not `call.userId`** — measured on one call: `userId` was Marivic, `answeredBy` was Patty, and every office turn in the transcript was stamped Patty (14) or Ruffa (9). Given both answers the model named Marivic on two runs and Patty on the third. The details now list the staff whose `userId` is on transcript turns, most turns first, falling back to `answeredBy` then `userId`.
- **KNOWN OPEN: the rail very likely names the wrong member of staff** — an earlier claim that `answeredBy` and `initiatedBy` were null on every call was corrected. Over **226 calls**, `userId` is set on all of them and `initiatedBy` on none, but `answeredBy` is set on **65** — 60 of them a workspace member — and on **54 of those 60** it names somebody other than `userId`. The rail is deliberately left at `userId || answeredBy || initiatedBy`, so the same call's row reads Marivic while its summary says Patty. Which field it should trust is a decision, not a typo.
- **`COMMS_MODEL` switches the model with no code change and no redeploy** — default `claude-haiku-4-5`, and `?action=status` reports the model in force. Four details make a switch safe: every row records `model` and `prompt_version` and is rewritten on its next open if either moved; `COMMS_EFFORT` is sent to every model **except Haiku**, which answers `400` to it; **no `temperature`**, which Sonnet 5 and Opus 5 reject; and `max_tokens` is 4096 rather than something sized for two sentences, because it includes thinking — the trap `care-brief` and `devi-agent` both hit. Sonnet 5 measured at about $0.003 a summary.
- **`loadDevi()` explains an undeployed function instead of "Failed to fetch"** — a commit does not deploy an Edge Function, so if `index.html` lands first every answered call and text day shows an error. The gateway answers the POST's CORS preflight with a 404 whose `access-control-allow-headers` omits `content-type`, so the request is blocked before its body can be read and **the browser only ever sees "Failed to fetch", never the 404**. A network `TypeError` now names the function and carries the deploy command. Relatedly, **an error is never retried by a render**: the summary landing re-renders the dialog and the render is what asks, so an error or pending state holds until somebody clicks Retry or Check again. Deployed 2026-09-15 and checked live from the Netlify origin; it needs no new secrets.
- **The Caregiver Overview became four cards** — Communication Logs and Notes over Client Feedback and Client Complaint, at Mitch's request, splitting the old combined Client Feedback & Concerns card in two. Both halves read and write the one `state.cgConcerns` slice and `fbKind(f)` is the only place that decides which card an entry sits on, so **there was no backend change**: two slices would have meant migrating the shared overlay and refreshing every open tab at the same moment, or a tab on old code writing entries back under the old path. Client Feedback has no type; Client Complaint requires Concern or Complaint with nothing pre-selected, and the type picker comes before Notes. The red *Reliability concern* badge counts Complaint only (`fbKind(f)==='complaint' && f.type==='Complaint'`) — Mitch's call; the persona summary still counts all three kinds, so a Concern is not lost.
- **The Updates card removed** — with its composer, `state.cgUpdates`, its `SLICES` entry and the `.cgp-scroll` CSS that only it used. The slice held **0 records**, so nothing was lost, and any `cgUpdates` key left in an old overlay is inert. `{ path:'updates' }` in `SLICES` is a different feature — Operations Updates, which Devi posts internal scheduling notes to — and is untouched.
- **Three live feedback entries repaired on the day of the split** — Mae's complaint about Mireya Sanchez (`a874`) had been saved twice on 2026-08-29, once before the type field existed and again typed Complaint with the date pasted onto the end of the text; with Mitch's approval the untyped copy went and the date was trimmed, and Jen's note about Don (`a1256`) moved to Client Feedback. `applyOverlay()` skips any add whose id a tab already holds, so the repair went out as the corrected add, a `dels` entry for the duplicate **and** a `patches` entry carrying the trimmed text: rev 6374 carried them and Mae's open tab applied them and saved rev 6375 two minutes later with both gone. **That recipe must not be reused as-is** — since tombstones landed the same day, a hand-written del on these slices is permanent; the `patches` half still works.
- **Skills and Experience split into two profile cards** — at Mitch's request: Skills (Mobility & Safety, Personal Care, Daily Living Support — 19 options, plus the `skillsNote` free-text line) and Experience (Dementia / Alzheimer's, Parkinson's, Stroke, Diabetes, Hospice, Post-hospital recovery and **Others**, listed flat, plus `experienceNote`). No backend change — both are fields on the caregiver's `cgProfiles` record. Experience carries no group heading, because a lone "Care Experience" heading under a card titled Experience told the reader nothing and made a ticked Others read as "Care Experience: Others".
- **The first Skills save must also write Experience's list** — nothing was migrated, and on the day **61 of the 68 filled-in profiles** held Care Experience ticks inside `cgProfiles[].skills`. Experience reads `p.skills` until it has an `experience` list of its own, `cgChips()` keeps each card to its own options so neither shows the other's ticks, and the `pair` write on the Skills field (applied in `chipSave()`) seeds Experience on the first Skills save, doing nothing once `p.experience` exists. Without it every Dementia, Hospice and Parkinson's tick would disappear from Experience the moment somebody saved Skills — on 61 real caregivers. `skills-exp-test` and `skills-exp-ui-test` both pin it.
- **Reverted before deploy: `pair` on Experience as well** — an earlier version of the split put the `pair` write on both cards, so saving Experience froze a copy of a seeded Skills card and it stopped following the AxisCare class tags. Caught in review and removed; only Skills carries `pair`.
- **Needs Update asks for Skills and Experience separately** — `CG_REQUIRED` gained a row each in place of the single *Skills & experience* row, and a tick or the "Anything else" line answers either. **Others** exists because Experience is required: without it a caregiver who has cared for none of the six named conditions would sit on Needs Update with nothing they could honestly tick. On the day, **7 of the 68** stored profiles had skills but no Care Experience tick, so those caregivers now appear for Experience. Recent Updates logs *Skills updated* and *Experience updated* separately, including when only the free-text line changed, because that line now answers Needs Update; `cgAbout` reads Experience first and never names Others; and the resume still reads `c.skills`, the AxisCare class tags, so neither card reaches a client.
- **KNOWN, ACCEPTED: one rollout race on the Skills split** — for up to a minute after the deploy, and until a stale tab is reloaded, old code shows the combined card. On a caregiver whose record the new code has already split, a Care Experience tick added there lands in `p.skills`, where Experience no longer looks, and the next Skills save drops it. It needs an old tab, a caregiver with no profile record before the split, and an edit inside that window.
- **Tombstones — `cloudForget()`, so a delete stays deleted (rule 3g)** — reported by the desk: a deleted Note, Client Feedback and Client Complaint came back about a second later, and deleting them again made them stay. On the keyed, non-`patchOnly` slices every record the desk creates is **never in `BASE`**, so `buildOverlay()` never emitted a `del` for one: a delete travelled only by omission and `applyOverlay()` adds back any id a tab does not hold. Measured at **~250ms** through the delete's own rev conflict and `push()`'s `pull(true)`, and **20–40s** from any other open tab. `CLOUD.forget(path, ids)` records the id in a module-level `GONE` store, `buildOverlay()` emits every tombstone in `dels` on every save, and `applyOverlay()` learns incoming dels, filters held records and refuses any add in `GONE`. Wired at the four places a person deletes a record — an audit of the whole file found exactly four: `cgEntryDel`, `delAttEntry`, `deleteGuide`, `aoDeleteTemplate` — and the 11 built-in guides took fixed `gseed-…` ids in place of `gGid()`, a new random id on every load in every tab, which a delete could never match. Verified with `tombstone-harness.js` running the real CLOUD module in one vm context per simulated tab: **23 failures before the call sites were wired, 62 passes after**; the live row (rev 6417) was checked read-only before deploy and carried no dels on any slice.
- **Three review fixes made before the tombstones deployed** — `doSave()` now does nothing before `finishBoot()`: `CLOUD.save()` never checked `booted`, so with `BASE` still null it built an **empty** overlay and `saveLocal()` wrote it over the local cache `finishBoot` was about to replay, and `deleteGuide` made that reachable from the guide library during boot. `cgNoteSave`, `cgFbSave`, `saveAttEntry` and `saveGuide` now say the entry was deleted and keep the editor open instead of toasting "saved", because deletes reach an open editor's tab. And `openAutoOffer` opens with an empty message rather than throwing on `def.id`, since the "keep at least one template" guard counts only this tab and two schedulers deleting the last two leave none anywhere.
- **KNOWN OPEN: what tombstones do not cover** — **edits** to an existing record can still be reverted by another tab's stale copy, the planned follow-up being to move the busiest slices into their own tables the way availability already is. Removing a **sub-entry** inside one record — `dispReopen`, `removeMed`, `cbRemove` — travels as a whole value, last writer wins. Deletes made before the deploy were never recorded and must be made again. And a misclick is permanent: the attendance, guide and template deletes have no confirm step, and the only repair is to re-add a copy under a **new** id and leave the del where it is.
- **KNOWN OPEN: old and new tabs trade overlay writes through the rollout** — an old-code tab cannot emit a tombstone, so it strips it from every row it writes, a new tab puts it back, and the two trade full-overlay writes of **~1.3MB each** until the old tab stops. Measured with an unguarded old tab: **6 writes a minute from each side, indefinitely**. The stale-build guard normally stops it within ~60s, but not in a tab opened before the guard existed (2026-09-07). The tell is `rev` climbing every ~10s with `updated_by` alternating while nobody is working. The rollout instruction is that every desk browser reloads as soon as Netlify shows it live, and nobody deletes anything until they have.
- **KNOWN, NOT FIXED: Work Preferences laundered the driving tag guess** — one pass through the editor stamped the `c.driver` class-tag guess into `ops.prefs.driver` for all **105 schedulable caregivers**, 35 seconds apart, with **zero** *Driving status updated* entries in Recent Updates. No value changed and every one now looks answered, so Needs Update counts the stamp as an answer and has stopped asking anyone about driving. The editor still offers only Yes / No and still starts on the guess. Neither the stamp nor the editor was cleaned up.

## 2026-09-18 — the desk PIN gate goes live and the database is locked

The dashboard now opens on a PIN screen, and every Supabase read and write — and every photo upload or removal — goes through the `app-gate` Edge Function carrying that PIN. The anon key in `config.js` was left able to do nothing on its own: RLS is on everywhere and every anon policy is dropped by a lock transaction that refuses to commit while one remains. One commit, 14 files (`c9e3f19`), plus the function, the throttle and the lock SQL run by hand.

- **`app-gate` is the only way to Supabase** — every table read and write is a POST carrying the desk PIN, checked against the `APP_PIN` secret on **every** request before the work is done with the service-role key. `GATE.fetch`, `GATE.call`, `GATE.start` and `GATE.onUnlock` replace the direct `/rest/v1` and `/storage/v1` calls, and the page no longer loads supabase-js at all. `app-gate` is deployed with JWT verification **on**, unlike the other five functions. The reason: on a sibling app a browser with an empty local store pushed over the shared row and erased everything — **369 kB to 17 kB** — with no way to tell which machine it was, because the key in the page was all it needed.
- **The PIN is the credential and it is sent every time** — there is no session, no token and no "verified" flag. A PIN checked once at load would not have helped, because that tab was already past the gate; sending it with every request means **changing `APP_PIN` locks out every open tab on its next request** — the 20-second poll at the latest — which is also the off switch the desk never had for a runaway tab. At this point it is remembered in `sessionStorage`, so once per tab.
- **The relay is an allowlist of exactly the requests `index.html` makes** — `ALLOW` in `supabase/functions/app-gate/index.ts`, by table, method and body columns: no embedded `select`, a PATCH or DELETE needs a filter, `caregiver_profile` takes only `employment_status`, and the `caregiver_availability` PATCH takes only `{note: null}`. A new Supabase request in `index.html` needs a line there or it fails with `400 not_allowed`. **`scheduler_state` is deliberately not reachable through the relay**, because its writes must pass the empty-copy guard and the rev check, and a generic relay would go round both: `state.save` answers `422 empty_refused` for an overlay with no records over one that has them unless `force` is set — which only `CLOUD.reset()` sends — and a stale rev answers 409 *before* the emptiness is looked at, so a fresh tab's first save 900 ms after boot stays the harmless conflict it always was.
- **Unlock is in place, never a reload** — caught in adversarial review. The first version reloaded, and a reload loses exactly what the lock interrupted: an open editor, a save refused at the moment of the change, and silently a CLOUD *patch* whose push hit the 401, because `finishBoot()` seeds `lastSent` from the local cache and the unpushed edit then counts as already agreed. `GATE.onUnlock` re-syncs instead — CLOUD's `resume()`, and AVAIL and NOTES dropping reads that failed only because the tab was locked. The page test edits a cadence to Weekly over the server's Monthly, lets a PIN change refuse it mid-flight, and checks Weekly lands after the unlock.
- **A 401 or 403 always means the PIN; 429 is the network** — so `app-gate` reports an upstream 401/403 as **502** and an upstream 429 as **503**, and refuses a request it does not allow with **400 — never 401, 403 or 404**, because NOTES and CGPHOTO read a 404 as "already gone". A tab that holds a PIN keeps it through a lockout and re-checks when it runs out; only a 429 saying `locked` locks. The dashboard is `inert` while locked, and a tab left on the lock screen through a deploy compares the page's ETag with the one it loaded and reloads if it moved, so it boots the new build rather than handing CLOUD's stale-build guard a wrong baseline.
- **The throttle — eight distinct wrong PINs per IP, decided in one atomic call** — `public.auth_throttle` and `gate_check()` lock an IP out for 15 minutes after eight **distinct** wrong PINs in 15 minutes, a right PIN included so a locked caller learns nothing. Distinct rather than requests, because the desk shares one office IP and a PIN change makes every open tab fail several requests at once: counting requests, as the reference design does, locked the whole office out including whoever typed the new PIN. Reading the lock and recording the failure as two calls let a burst pass the read, so one SQL call decides under the IP's row lock — measured against the deployed function, **40 simultaneous guesses gave 8 compared and 32 answered 429**, the right PIN included. A right PIN deliberately does not clear earlier failures, or the desk's polls would reset the count for anybody else on that network three times a minute. The IP is `cf-connecting-ip`: measured with a throwaway echo function, the edge *replaces* a forged `X-Forwarded-For` and refuses a forged `cf-connecting-ip`. Stored keys are HMACs keyed with the service key.
- **RLS locked down — `app-gate-lock.sql`** — one transaction that refuses to commit while any anon policy remains or any table has RLS off, with `supabase/app-gate-unlock.sql` reversing it exactly, generated from the pre-change backup of the policies. The sequence is deploy first, lock second: confirm the live site serves the new `index.html`, have every desk browser reload, then check the Supabase API logs show **no anon `/rest/v1` traffic for ten minutes** before locking. Verified afterwards with the anon key — a read returns `[]`, a write 401. `schema.sql` creates no anon policy and its section 11 fails loudly if one exists. **Restoring a database backup rolls the lock back**, so it must be re-run after any restore.
- **`care_notes` reads move behind the gate** — the browser no longer reads `public.care_notes` with the anon key; it reads through `app-gate` with the desk PIN, so a stranger holding the site URL can neither read nor forge caregiver shift notes. The sync itself still writes with `SUPABASE_SERVICE_ROLE_KEY`, a Netlify environment variable.
- **Photo writes move behind the gate and the four anon bucket policies are dropped** — `CGPHOTO` uploads and removes through `GATE.fetch`, which `app-gate` turns into `photo.put` / `photo.del` with the service key, sending `x-upsert: true` and `cache-control: max-age=60` itself. It re-enforces the rules server-side: the key must be digits and the bytes must start `FF D8 FF` whatever content type the page claims. The anon policies had been on `storage.objects` since 2026-09-07 for consistency with how the rest of the app wrote then, and that reason went away with the gate. **Reads are unchanged and still public**, because an `<img>` cannot send a PIN.
- **Care-note text goes through `escText()`, not `esc()`** — fixed in the alert list, the alert detail and the related notes, with a page test. Care notes are written by caregivers in AxisCare, people outside the desk, and `esc()` only escapes `"`: a note carrying markup ran as script in every tab that opened the alert — and since the gate, that script could read the PIN out of storage.
- **What it costs** — every read now goes browser → Edge Function → PostgREST: **0.6–1.6 s a request against ~0.2 s direct**, and `state.load` of the 1.34 MB row **1.5–4 s**. The 20-second poll is one small `state.head`. Every request is one function invocation, well inside the Pro plan's included 2 M a month at the desk's volume.
- **KNOWN OPEN: a test PIN is in force** — set when the gate went live, to be changed before the desk relies on it, and any replacement should be at least six digits, because the throttle's whole budget is eight distinct wrong PINs from one IP in 15 minutes. The PIN is never to be written into the repo. Changing it is one `supabase secrets set APP_PIN` call, and `delete from public.auth_throttle;` clears every lockout.
- **KNOWN OPEN: what the PIN does not cover** — the AxisCare proxy (`/.netlify/functions/axiscare`) and the other four Edge Functions still answer anyone with the URL, exactly as before; the page already holds the PIN, so putting them behind it is the natural next step, but the proxy is Carlo's. Caregiver photos are still read from a public bucket URL. And the PIN sits in browser storage, so any script injected into the page can read it — which is why text from outside the desk must go through `escText()`, never `esc()`.

---

## 2026-09-21 — distance becomes drive time, and the calling list shows warnings only

Both Find Coverage screens stopped measuring distance against the `CITY` proximity grid and started showing real road drive time. The calling list lost every green chip — the positives still score, they just no longer take up a slot — and the desk stopped typing the PIN into every new tab.

- **`DRIVE_TIMES` replaces the `CITY` grid** — a table of **[minutes, road miles]** between two city centres, free-flow, no traffic, the mean of both directions, generated once from OpenStreetMap routing by `scripts/drive-times.js` and pasted in. Read through `driveBetween(a, b)`, formatted by `fmtDrive()`, which rounds to 5 minutes because city-centre data cannot honestly say 17. The page never calls a routing service, no address leaves the browser and there is no key. Mitch asked for time rather than mileage: a scheduler reads "~20 mins away" faster.
- **Why a table and not a formula over the grid** — `CITY` is a proximity grid, not a road map. Across its 66 pairs it reads about **two-thirds** of the road miles and is up to **27 minutes** out, and for a Camarillo client — **10 of the 24 active clients** — it put Ventura caregivers closer than Oxnard ones when the drives are 20 and 15 minutes. A row now reads `~15 mins away`, `Same city`, or `Drive time not known`, which scores nothing exactly as an unknown city always did.
- **The travel limit is checked against ROAD miles, with 20% leeway** — the grid's ceiling is 25, so a stated `maxMiles` of 25 or more — **31 of the 104** schedulable caregivers — could never fire the −25 at all. Against road miles with no leeway it fired on **2.4×** as many caregiver-client pairs, and most of the new ones sat within 20% of the limit, inside the noise of where each city's point stands (a stated 10 miles against the 10.6-mile Oxnard → Camarillo drive). The leeway is Carlo's call.
- **Green chips off the calling list, warnings only** — Mitch's call: *On this client's list*, *Preferred caregiver*, *Worked N visits here in 30 days*, *Drives — this client needs it*, *Wants to work in X*, *Hours they prefer* and *Closest available* all went, along with *Available for this shift* and the grey *Driver* fact — the blanket *Driver* chip itself went with the 2026-09-08 rewrite. Every positive term still scores exactly as before; only the chip went. Because every #1 row on the live board was explained by green chips alone, the facts that say *the client asked for this person* moved into `covMatchRow()`'s grey line rather than vanishing.
- **`N h this week` came off the row, and the 32–39 h chip went on** — the text read "0 h this week" on most rows and helped nobody choose who to ring. With it gone the −8 at 32–39 booked had become invisible, so it needed a chip of its own. The scoring did not change.
- **Driving became a warning through `covDrives()`, and is still never a penalty** — for a client Concierge says needs a driver, it answers *can this caregiver drive the client?* from stated answers only: `caregiver_profile.can_transport_clients` decides first, the licence (`can_drive`, the `DL`/`WDL` tags) only when that is silent, and a change recorded on this dashboard stands alone over both. Yes earns +10 and no chip, no gets a red *Doesn't drive clients*, and conflict or nothing-recorded get amber — none of them a penalty. `cg.driver` is `false` whenever the `DL`/`OC` tags are simply absent: **18 of the 104** schedulable caregivers, **11** of whom the profile records as owning a vehicle.
- **The +10 follows `covDrives()`, not `c.driver`** — so a caregiver with a licence tag whose profile says they do not drive clients no longer earns driving points while wearing a red chip. On the live board that was Rosalie Cruz, Bernadette Lazaro and Angela Zuniga.
- **`CG_WATCH`'s *Transportation updated* split into two keys** — *Has own vehicle* and *Can drive clients*, the second watching the effective `canDriveClients(c)` so an untouched save logs nothing. The single key covered both facts, so a vehicle-only edit logged it while the editor quietly saved its seeded guess — which gave Puspa Sari (`a1161`) a red chip from a value nobody typed. Old *Transportation updated* entries cannot say which half changed and count for nothing. Ask Devi's `DV_PREF_FIELDS` now tries *Can drive clients* before *Driving*, because the driving regex also matched "can drive clients" and recorded a licence instead.
- **The one-hour overnight trap in `coverageMatches()`** — it handed `covClash()` `start + 1` for any shift whose end was not after its start, so on every **overnight** shift the double-booking check covered the first hour alone: somebody booked from 9pm was cleared for a 7pm–1am shift. It now passes the real end, which `covClash()` turns into end + 24 — an end *equal* to the start included, which is a 24-hour live-in shift — and keeps `start + 1` only for an end AxisCare did not give. The date search always passed the real end. Still not covered on either screen: a visit that *starts* after midnight, because it is filed on the next date.
- **Preferred cities go through `normCity` too** — `caregiver_profile.pref_cities` is typed by a person and never cleaned, while `cl.city` has been through `AxisRoster.normCity`, so a raw compare made **"Westlake"** — which 9 caregivers record — a different place from the "Westlake Village" clients normalise to, and the preference matched nobody while looking simply unpopular. `cgWantsCity()` normalises both sides and `CITY_FIX` gained `Westlake`, `Westlake Vlg` and `Westlake Village Ca`. `milesOrNull()` is gone, replaced by `driveBetween()`; `miles()` stays with its made-up 30 for an unknown city because its remaining callers sit on screens no navigation reaches — **do not give it a new caller**.
- **The PIN is remembered once per computer** — storage moved from `sessionStorage` (once per tab) to `localStorage`, at Mitch's request, because typing it into every new tab was the annoyance. A `storage` listener moves a computer's tabs together: a PIN accepted in one tab unlocks every tab on the lock screen, a stored PIN the server refuses is forgotten and locks the rest at once, and a refusal only ever forgets the PIN it actually sent, so a tab still carrying the old PIN cannot wipe the new one. A tab from before the change has its `sessionStorage` PIN moved across on reload. Nothing about the check changed — it is still sent with every request, so a PIN change still locks out every computer. The trade-off is plain: anybody using that browser on that computer gets in until the PIN changes.
- **The PIN page appears only when it has something to say** — no PIN on this computer yet, a PIN the server refuses, a network lockout, or a server that cannot be reached. A PIN already held is checked **silently** at load: a tiny script in `<head>` adds `pg-held` to `<html>`, which hides `#pingate` from the first paint, and `GATE.show()` removes it. The check is unchanged and still runs before anything starts, so this is fail closed exactly as before — it only stopped a "Checking…" page flashing up on every refresh. Measured by counting every animation frame from the first: **zero frames** of the lock screen on a refresh with a good PIN. The `<head>` key and `GATE`'s `KEY` must stay the same (`dcs_gate_pin_v1`).
- **The client driving requirement re-measured** — **12 of the 24** active clients require a driver and **7** explicitly do not, up from the 10 / 6 recorded earlier. Those counts are what the +10 term and the red chip actually reach.
- **KNOWN, OPEN: weekly min/max hours rank nothing and must not get a reader** — asked ("how does min hours per week affect the ranking?") and answered: `ops.minHours`, `ops.maxHours`, `ops.minShift` and `ops.maxShift` feed the Work Preferences card, Needs Update, Recent Updates and the availability report only. Measured on the 109 schedulable caregivers: the minimum is exactly **20** on **104** of them — the old demo default, re-saved by the Work Preferences editor on every save — and there is no `min_hours` column anywhere. The maximum is a leftover **40** in the overlay hiding the real `caregiver_profile.max_hours` on **43** of them, and four records (413, 617, 628, 997) hold a minimum above the maximum. Even with clean data, a minimum-hours boost has about **+3** of room before it could outrank a caregiver the client asked for.

---

## 2026-09-22 — the Devi dock goes, the chat goes full width, and the coverage row explains itself

Ask Devi stopped being a strip at the bottom of every page and became one full-width page with the sibling apps' composer. Find Coverage rows gained the grey line that replaced the green chips, and the postcode started placing caregivers the city table cannot.

- **The bottom dock was removed — Ask Devi is one page** — `renderDock()` and `#devidock`, a sticky composer on every screen with the last six exchanges above it when opened, deleted. `viewAssistant()` is now the only place the composer exists; `state.aiLog`, the router and the action cards were untouched. Mitch's call: a bar pinned to every page is a cost every page pays for something the desk opens occasionally. The trade is stated plainly, because rebuilding it is a real option — a question could previously be asked *without leaving the page it was about*, which was the original request. It shipped inside a commit whose subject reads only `fix overtime hour chip` (`ac67101`); the dock removal, the composer rewrite and the width fix are the larger part of it and are nowhere in the title.
- **The composer is the sibling apps', not its own thing** — the one-line pill with a caret toggle became a 3-row `<textarea>`, Enter sends and Shift+Enter is a newline, all **26** `AI_EXAMPLES` sit behind a single *Suggested questions* button, and Finance's "Changes need your approval" line runs beside Clear and Ask. Mitch put the three Ask tabs side by side and this one was the odd file out. The textarea is the point: instructions are the longest thing typed here and were exactly what the one-line box hid.
- **Reverted the same day: `.ai-wrap.start`** — a class that turned the flex stretch off so the composer opened at the top of an empty thread rather than at the foot. Carlo reported it within the hour — *"why is it in the upper left corner and not in the bottom similar to Concierge and Finance?"* A composer that moves depending on whether you have asked anything yet is worse than one that sits still in a wrong-looking place. The screen of white above an empty thread looks like a defect and is not one.
- **Reverted: starter example cards above the box** — an empty thread briefly showed six examples as cards, and a second attempt opened all 26. Both went and the suggestions stay collapsed, because the other two apps put all of theirs behind one control and a scheduler moving between three should not have to learn two places to look.
- **The starter cards had taken `.ai-card`** — a class the guide library's AI-assisted draft form already owns along with `.ai-h`, `.ai-sub` and `.ai-go`, so they restyled that form as a side effect for about an hour. The composer's own classes are `.ai-ta`, `.ai-tools`, `.ai-sugbtn` and `.ai-approve`.
- **The chat went full width, and it took a scoped rule** — Carlo: *"why is the chat not full width?"* `.ai-wrap` is used by two unrelated screens, `viewAssistant()` and `guideAiForm()`, and the guide library's `.ai-wrap{max-width:620px}` — ~1,100 lines lower in the stylesheet — beat the Ask Devi block's `max-width:880px` on equal specificity. The chat was capped at 620px and left-aligned, leaving over **1,000px** of white on a 1920 window. Fixed with `.v-assistant .ai-wrap{max-width:none}`, (0,2,0) against the guide's (0,1,0). Measured after: **874px** chat in a 1150 window, **1164** at 1440, **1644** at 1920, gap **0** at every width, guide form still 620. This is the `.mwide{max-width:680px!important}` trap again — when a width does not match its rule, look for a second owner of the class.
- **`render()` carries the half-typed question the dock used to** — the dock read `#aiq` before repainting and put the value, focus and selection back. When it went, nothing did, so a 20-second poll landing mid-sentence silently emptied the box. `render()` does it now, which is the right home: the page is re-rendered from about a dozen places and only one of them was ever the dock. `askAI()` clears the box itself after reading it, for `preset == null` only, so a suggestion chip cannot wipe something already typed.
- **Known open: a full-width answer runs a long line** — with `.ai-wrap` uncapped on this view an answer's text runs the whole content area; `.ai-ask`, the question bubble, still caps at 80%. If the desk finds it too wide the fix is a max-width on `.ai-ans` — **not** on `.ai-wrap`, which would narrow the composer again and put back what this change removed.
- **Known open: `.ai-wrap` should be renamed on one of its two screens** — the tidier fix for the two-owner collision, not done because it is a much larger diff: every rule in both CSS blocks, plus `.ai-card`, `.ai-h`, `.ai-sub` and `.ai-go`, which the guide form also owns and the composer must not reuse. Worth doing if either screen is touched again in earnest.
- **The grey reason line on a Find Coverage row** — `covMatchRow()` now reads `Preferred · Port Hueneme · ~10 mins away · 8 recent visits`. The order is Mitch's: **why this row is here, then where they are, then how well they know the client.** *Preferred* covers both sources, the Concierge list (+60) and AxisCare's `preferredCaregiver` (+50), because they say the same thing to a scheduler, with the tooltip naming which record it came from. The home city comes before the drive because a scheduler knows the county. *N recent visits* replaced *Worked 13 visits here in 30 days*, which was the longest thing on the row for the caregivers who most deserve a short one.
- **Reverted after one day: *Asked to work in X*** — the preferred-city fact, which Mitch read as noise. It is the largest caregiver-side term (+12) and it is what explains a row ~50 mins away sitting above one ~30 mins away — exactly what Carlo asked about Patricia McGrath's shift the day before, where the answer was +12 plus −8 on the nearer caregiver for 36 hours already booked. Also unshown by choice: the drive term, preferred hours (+6), client-gender comfort (+8) and the driving bonus (+10). The accepted cost of chips-as-warnings is that a row can sit a few points above another for a reason not on screen.
- **`covMatchNote()`'s grey prose panel became a label/value table inside the shift card** — four sentences in their own grey panel, wedged between a white card and a grey list header, were clutter. The table did not survive the day after: it is `.emp-row`, which is `justify-content:space-between`, and the page went full width the same day, so from that moment the label sat at the far left of the card and the value at the far right — up to **1,600px** apart on a wide monitor, and it pushed *Call in this order* most of a screen down. Mitch: *"it is still hard to read, the table is so big and not instantly read."* Replaced the next day by chips on the client's own line.
- **`DRIVE_ZIP` — the postcode decides where to measure from when the city cannot be placed** — *Los Angeles* is left out of `DRIVE_TIMES` on purpose: 47 miles across, so no one point answers for it. **Reseda and Encino are both 60 minutes from Ventura, MacArthur Park is 81** and Pico-Union 82, and those records used to read *Drive time not known*. A ZIP is small enough to place — 90057 covers about **0.9 square miles** against Oxnard's 27 — so `drivePlace()` falls back to `DRIVE_ZIP`. The row still shows the city AxisCare records, and the tooltip says the postcode was used.
- **`zip` had to be added to BOTH caregiver mappers** — `AxisRoster.mapCaregiver()` reads `mailingAddress.postalCode` and `toAppCaregiver()` rebuilds the app record field by field, so a value added to the first alone never reaches `state` and the row goes on reading "not known". Caught by the live page test, not by reading. It is derived from AxisCare on every boot exactly as `base` is, so it is in the baseline snapshot and diffs clean.
- **Known open: two stated travel limits need re-confirming** — placing the Los Angeles caregivers by postcode started the travel-limit chip firing for them, because they finally have real miles: Fitri Syam's stated 15 against a **49-mile** drive to Ventura, Cindy Vera Cruz's 30 against the **38** to her own two clients. Worth re-confirming with the desk rather than assuming the chip is wrong — Cindy has twice accepted 38-mile work.
- **`loadingState()` — a spinner, not a green tick, while the answer is still arriving** — `viewOpen()` and the contact-log view check `rosterLoading()` first. Both said "Loading open shifts…" under `emptyState()`'s green tick, which means *we looked, and there is nothing to do* — the one thing a loading screen has not established. **The icon is part of the claim.** Reported by Carlo the same day; use `loadingState()` wherever the answer is still coming.

---

## 2026-09-23 — the day review gets summarised, and the hours chip stops claiming overtime

Care Notes was rebuilt as a day review and then stopped printing raw notes as the default: a new `carenotes-summary` Edge Function summarises a whole date in one model call, and shipped only after an adversarial review — 11 findings raised, 4 surviving both skeptics, 5 more added by a completeness critic — whose four biggest were each invisible on the happy path. On Find Coverage the hours chip stopped saying *overtime* — a word describing a rule this agency does not use — and what the client asked for moved onto the client's own line as chips. Ask Devi got a typewriter, a thread that scrolls instead of the page, and a name match that no longer fires on the word *yesterday*.

- **Care Notes redesigned as a Yesterday day review** (`e3bd3c2`) — the *Immediate Actions Required Today* alert-group page became three sections: a per-client AM/PM summary from the synced note text, **Clients Needing Attention** for client-condition concerns, and a separate **Care Note Issues** panel for documentation quality, plus a day picker defaulting to Pacific yesterday and a read-only *View Original Notes* modal. No new persisted state and no schema change. The documentation flags come only from real measurements — word count against a fixed 8-hour window, wording overlap with the same caregiver's earlier notes for the same client, and this client's typical note length — and are worded as *review this* rather than as an accusation. A gap timeline and care-plan checks were deliberately not built: there is no per-entry timestamp inside a `careNote` and no care-plan source wired in.
- **`carenotes-summary` — the day review is now summarised, not reprinted** — a new Supabase Edge Function taking `POST {day:'YYYY-MM-DD'}`, reading `public.care_notes` **itself** for that Pacific day with the service key and upserting `public.care_note_summaries`, one row per client × date × shift; `CNSUM` reads it and `careShiftSummaryHtml()` draws it. Measured on the live mirror, the raw notes the page had been printing under a card headed *Yesterday's Summary* ran to a **median of 610 characters and a maximum of 6,130**; the summaries that replaced them are **median 241, maximum 327**. Only the date goes up — posting `state.careNotes` would be less code and would let anyone with the site URL save invented clinical summaries and spend the Anthropic key on any text they liked. The table was created by hand from `supabase/care-note-summaries.sql` (also section 10b of `schema.sql`) with **RLS on and no policies at all**, so the anon key can neither read nor write it. Deployed with `--no-verify-jwt` and verified from the Netlify origin — a commit does not deploy it.
- **One model call per DATE, not one per client-shift** — measured across the 37 dates in `care_notes`: avg 18.9 notes and 13.3 clients per date, ~3,400 input tokens (max ~5,000). 2026-09-22 measured **7,737 in / 2,092 out, 22 blocks, 30 seconds** on Haiku 4.5 — about **1.8¢**, with the whole history backfilling for under 50 cents. Per client-shift would be ~26 requests for the same tokens and would throw away the one thing a whole-date pass sees: the same client's AM and PM read together.
- **Written once, read back forever** — the first person to open a date pays for it and every later open, in any browser, reads the saved rows: **30s to generate, 0.68s on every open after**, with `generated: 0`. Each row carries `source_sig`, a fingerprint of the visit ids **and** the note text, plus `model` and `prompt_version`, so a note corrected inside `carenotes-sync`'s `FRESH_DAYS` window rewrites **only that row** — verified by stamping one row stale: `generated 1, reused 21`. There is no cron and no backfill job, so a date nobody opens is never summarised and costs nothing.
- **The fallbacks are the whole safety of the screen** — summary ready shows the summary; still coming (~30s on a first open) shows the **raw note** under a strip saying it is summarising; failed or not deployed shows the raw note under a red strip with Retry. A spinner for half a minute is worse than the text already in hand. The label sits once in the card header — *"Summarised by Devi from the caregivers' AxisCare notes"* — with *View Original Notes* already on every row. Verified both ways in the browser: 22 summaries and 0 raw notes when it lands, 0 summaries and 23 raw notes when the call is refused.
- **`max_tokens` is 16000, the reply is JSON, and the model is a secret** — `max_tokens` includes thinking, and `care-brief`, `devi-agent` and `comms-summary` have all returned HTTP 200 with an empty text block on a budget sized for the answer. The reply is a JSON array of `{id, summary}` parsed defensively: an unknown id, a repeated id, an empty summary or one over `MAX_CHARS` is discarded and that block alone falls back to its raw note. `CARENOTES_MODEL` (default `claude-haiku-4-5`) switches the model with no redeploy; `CARENOTES_EFFORT` is sent to every model **except** Haiku, which answers `400` to it, and no `temperature` is sent at all because Sonnet 5 and Opus 5 reject it.
- **Adversarial review before ship — 11 raised, 4 survived, the critic added 5** — six independent reviewers over separate dimensions (time, cost, data, browser, PHI, prompt), each finding then put to two skeptics with opposite lenses (*does it reproduce?* and *is it already handled?*) plus a completeness critic. Six were fixed before deploy, the rest recorded as known, and **four were refuted outright and written down** so nobody re-raises them. Every one of the four biggest findings was invisible on the happy path.
- **A summary may only replace notes the page can still SHOW** — the summary is read from `care_notes` as of now, while the names, times and *View Original Notes* button come from `state.careNotes` as of boot, and `fetchCareNotes()` reads `limit=400` against 701 rows, so one date **always** holds a partial set in the browser. The function already stored `source_count` in a column nothing read back; it now returns it, and the block falls back to its raw notes unless the count matches what this browser holds. Verified: bumping one block's `sourceCount` by one took the page from 22 summaries / 0 raw notes to **21 / 1**.
- **Two bugs in *when* a summary is asked for** — `CNSUM.load()` skipped a date the browser held no notes for, but `state.careNotes` is filled inside `hydrate()`'s `Promise.all` and `viewCareNotes()` paints well before that, so opening Care Notes during boot cached `{status:'ready', units:{}}` **permanently**; `careNotesLoaded()` now caches nothing for a date that looks empty mid-boot. And the day arrows re-render the view, so paging back a week started a ~30s, ~1.8¢ call **for every date passed through** — `CNSUM.soon()` arms a single 400ms timer instead, measured at one call for six dates paged back.
- **`PROMPT_VERSION` 2 — a block may hold more than one note** — the PM window runs 14:00–06:00, so an evening caregiver and an overnight caregiver both write into it. Version 1 described a block as one caregiver's one visit and capped it at three sentences, and a two-note block lost a caregiver's whole shift, reproduced 4/4 and 3/3 against the live model. Every note in a block must now be covered and each caregiver named, with five sentences and 75 words allowed; the one two-note block on the live board reads to 544 characters covering both.
- **Three smaller function fixes from the same review** — `String(item.summary)` on a non-string stored the literal `"[object Object]"`, which was non-empty and under `MAX_CHARS`, so it saved and was served forever in place of the note (a `typeof` check now); `sig()` depended on PostgREST row order and two live client-days already tie on equal `visit_at` (clients 335 and 342 on 2026-09-18), so the sort breaks ties on `visit_id`; and `out.generated` was set **before** the write with `dbPut()`'s boolean discarded, so a lost batch reported `generated: 22` — the write is awaited and `saveFailed` returned.
- **`carenotes-sync` `SOFT_DEADLINE_MS` corrected 7000 → 5000** — the constant contradicted the tuning table 25 lines below it. An earlier 7000 overshot to **8.19s**, uncomfortably close to a 10s platform limit; at 5000 a run stops with room for one more request.
- **Raised and deliberately NOT fixed** — a failed read of `care_note_summaries` regenerates the whole date, because `savedForDay()` returns an empty map on any error: deliberate, ~1.8¢, and a failed read must not become a destructive write (`orphans` is empty, so nothing is deleted). A **partly summarised date looks fully summarised** — dropped blocks fall back to raw notes with no marker, and the `sourceCount` check makes that more common. The first open **re-renders ~30s in and moves the card under the reader**. And `fetchCareNotes()`'s 400-row cap against 701 rows leaves the oldest ~16 dates reading "No AxisCare care notes synced for this date", unsummarised until the cap is fixed.
- **`SUMS` — Devi can read the summaries, GET only** — `care_note_summaries: { GET: true }` was added to `app-gate`'s `ALLOW` and `app-gate` redeployed (a commit does not deploy it); `SUMS` reads a 14-day window through `GATE.fetch` at boot, module-level and never in `state`, and `aiCareSummary()` answers from the table — exact, instant, free, nothing leaving the browser. No SQL change was needed because the relay uses the service key. **`SUMS` reads; `CNSUM` generates** — never call `CNSUM.load()` from `deviContext()` or a router builder, or every Devi question would risk ~30s, ~1.8¢ and a write to a clinical table. The snapshot carries **one date**: `devi-agent` caps the request at `MAX_BODY_BYTES = 64_000` against a ~55KB snapshot and a date is roughly 6KB, so one fits and a week `413`s. Verified against the live table: 44 rows over the two summarised dates, the builder answering *"15 clients summarised for yesterday"*, one `app-gate` request returning 200.
- **It is a WORKLOAD chip, not an overtime one** — the word *overtime* was on the chip for one day and was wrong: this agency pays **daily** overtime, hours over 8 in a shift, not weekly overtime over 40 (Carlo). His example settles it — 4 × 10 h plus 1 × 4 h is 44 h worked and **8 h of overtime**, where the weekly-40 reading calls it "4 h over 40", half the real figure. It matters here because, measured over 2026-09-01..22 across 497 visits, the dominant shift is **twelve hours (265 of 497)** and **71% of all visits exceed 8 h**. The chip now claims only how loaded somebody already is and what the shift would make it — *Heavy week — 44 h with this shift*, *39 h that week with this shift* under 40, *36 h booked that week* when AxisCare gave no end — with the score bands unchanged at −8 for 32–39 and −25 for 40+, and a tooltip saying the hours are scheduled, not clocked.
- **Verified the app has no evidence of pay, so a chip may not claim one** — audited against the live account so nobody re-litigates it: `payrollId` is **null on all 185 active caregivers**; `payRate` is one flat string with **5 distinct values**, 167 of them `20.000`, and no overtime variant; no caregiver, visit or schedule field matches `overtime` or `ot_`, and the **496 KB OpenAPI spec contains "overtime" zero times**. AxisCare's only overtime concept is the service code on the *client's* schedule (`STDOT40`, `SROT36` against `STD40`, `SR38`) — 13 clients had September schedules, 3 use an OT code and 0 mix — and it is not even a premium, since `SROT36` bills **lower** than `SR38`. `chargeRate` appears zero times in `index.html` and `payRate` has no readers.
- **KNOWN BETTER, NOT BUILT: the real overtime figure, and the daily line nobody checks** — `COVHIST` already holds what a true figure needs, `Σ over each DAY: max(0, that day's hours − 8)`, which returns 8 for the example above. It was not smuggled in with a rewording for three reasons: it must group by **day**, not by visit (two 5 h visits in one day is 2 h of OT, and by visit it undercounts); the scoring bands would want revisiting; and the 8 must be confirmed with payroll, because California uses 8 h/day under Wage Order 15 but 9 h/day and 45 h/week for personal attendants under the Domestic Worker Bill of Rights, on a duty mix AxisCare does not record. Separately, `covWeekHours()` returns a Mon–Sun total and **nothing in the ranker looks at a single day**, so the rule that actually binds fires several times a week and the board never mentions it.
- **What the client asked for rides the header line** — `covMatchNote()`'s third shape in two days. The 09-22 label/value table was `.emp-row`, which is `justify-content:space-between`, and the page had just gone full width, so the label sat at the far left and the value at the far right — **up to 1,600px apart** on a wide monitor. Care type, gender preference and driving requirement are now chips on the client's own line with the asked-for caregivers behind one `PREFERS` label: the card measured **~190px → 72px** and wraps with no overflow at 1600, 1280, 1024 and 820. `.cv-fact` is grey rather than amber so the care type keeps the only colour, and `renderCoverageCommand()` still returns `{match, html}` so one `coverageMatches()` run serves both. One rule nearly went out with the five dead `.cv-match` ones: `.cv-match .emp-v[title], .cv-match .clm-cg{cursor:help}` was the **only** `cursor:help` the name chips had — there is no standalone `.clm-cg{cursor:help}` rule, a `grep -o` only makes it look like there is — so it moved to `.cv-client .clm-cg`.
- **The three states are told apart by SHAPE, not by wording** — recorded and constraining shows a chip with the value; recorded and constraining nothing (*Either*, no driving requirement) shows **no chip**; Concierge unreadable or still loading shows a **red** chip naming what was not applied. So an absent chip always means *asked, and nothing to apply*, and red always means *not asked*; a neutral chip for the not-recorded case would make absence ambiguous again. Verified by stubbing `CLMATCH.status()` to `error`: three red chips, one per fact.
- **The travel-limit chip states the EXCESS, computed raw and rounded once** — *Long drive — ~20 min past their limit*, replacing the two days it spent showing the limit itself. The row beside it already says how long the drive is, so the minutes past what the caregiver agreed to is the one number the chip can add. Subtracting the two rounded figures on screen disagrees with the truth on **19 of the 149** caregiver-client pairs that fire — Lorilyn Federis to Patricia McGrath looks like 25 where the real excess is 21.8 and rounds to 20 — and computing it directly removed the old `lim >= shown` fudge. `fmtDrive()` carries an hours form, which Lemoore to Ventura County genuinely needs at 247 minutes against a stated 30 miles, and `driveRound()` floors at 5. *"Long drive"* is an absolute word on a relative test and was kept knowingly: **25 of the 149** firings are on drives of 25 minutes or less, the shortest 17, and Carlo chose it over *Past their limit — ~20 min further* for punchiness.
- **Devi's answers type out, copied from Finance** — both siblings were read first: Concierge has **real SSE streaming and zero `@keyframes` in 20,961 lines**, Finance streams *and* typewrites on top. Finance was copied because it is the only one with a typewriter, its `faiTypeTo()` is fed a complete string on its non-streaming path so this needed **no Edge Function change**, and Concierge's unconditional scroll pin is a defect. The counters `e.live` and `e.shown` live on the turn in `state.aiLog`, never in the DOM, so the 20-second poll destroying and recreating the node costs **one frame** — measured 104 → 114 characters across a mid-type `render()` — where DOM counters would restart the animation from zero. A module-level 16ms timer drives every live turn at once and stops rescheduling itself when none is left; `document.hidden` and `prefers-reduced-motion` jump straight to the end. It types the **raw text** and re-renders through `deviRender()` every frame, because slicing rendered HTML would bisect a tag or an entity and reopen the injection path `escText()` exists to close. **Only Devi's answers type** — a router answer is built markup computed in under a millisecond.
- **The page scrolled, not the thread** — `.ai-thread` has always been `flex:1 1 auto; overflow-y:auto`, but an element only overflows inside a **bounded** parent and `body.ai-white .main` was `min-height:100vh`, which grows: the column stretched with the conversation, the page scrolled, the composer slid out of reach, and `aiScrollToBottom()` was a no-op because `scrollHeight === clientHeight`. Three `body.ai-white` flex rules bound it with **no magic number**, unlike both siblings, because the topbar is a flex child — measured after, the app is 900px in a 900px viewport and ten more turns leave the composer at **731px, unmoved to the pixel**. Both answer paths called `window.scrollTo(0, document.body.scrollHeight)`, which moved nothing, and `render()` threw a long conversation back to the **top every 20 seconds** while somebody was reading it; it now carries the thread's scroll with Finance's 80px rule. `.ai-thread>*:first-child{margin-top:auto}` rests a new conversation just above the composer — **not** `justify-content:flex-end`, which clips overflow in a scroll container — and the thread got a slim `#DDE4EB` scrollbar scoped to the one element that scrolls.
- **"yesterday" returned Ester Siron's profile card** — reported from a live session: *"can you help me figure out the care plan of Brenda yesterday?"* came back twice as a caregiver nobody asked about. The router's caregiver branch matched a first name with `q.includes(first)`, and `"yesterday".includes("ester")` is **true** — measured against the live roster the same day, **4 of 10** ordinary scheduling questions were hijacked, on a desk whose care-note screen is literally titled *Yesterday's Summary*. The match is a whole word now, `(^|[^a-z0-9])name([^a-z0-9]|$)`, with the name regex-escaped because a real one can carry a dot or an apostrophe. Two limits were left deliberately: the branch still searches caregivers only, so a question about a client falls through to Devi, and two caregivers sharing a first name still resolve to whichever `find()` reaches first.
- **PHI settled for the whole Anthropic key** — Carlo: *"The Anthropic API that we have has the PHI contract."* That covers `devi-agent`, `care-brief`, `comms-summary`, `carenotes-summary` and anything added after, and closes a question that had been open for three weeks. It does not make the snapshot free — the caps and the prefer-a-router-builder rule still stand — and phone numbers, email addresses and links are **still** redacted in code before notes leave `carenotes-summary` and again over its output, because `comms-summary` already measured that a prompt rule alone does not hold.
- **Wrong diagnosis recorded: the Supabase CLI does not read `.env`** — `npx supabase` reads `SUPABASE_ACCESS_TOKEN` from the environment or a prior `supabase login`, never from `.env`, so a perfectly good token answers `Unauthorized`, byte-identical to an expired one. It cost a wrong diagnosis here; the token has genuinely expired twice (2026-09-11, 2026-09-14), so both causes are real, and export is now the first thing to rule out — the same shape as ruling out the AxisCare version header before blaming the token.
- **Covered By silently not saving on attendance entries** (`c6e099b`) — `cgpHTML` only committed a name when a suggestion row was clicked. On the required Caregiver field its own validation caught that, so the picker looked fine; *Covered by* is optional, so the same mistake saved silently with the field blank. Enter now confirms the top filtered match and Escape closes without picking, and `saveAttEntry()` reads both fields through `cgpVal()`, which falls back to an exact case-insensitive roster match when the hidden field is empty but text was typed. An ambiguous partial is left blank rather than guessed.

---

## 2026-09-24 — the care-note summary is rewritten twice, and the doc splits in two

The Care Notes day review was rewritten twice in one day: `PROMPT_VERSION 4` took its register from a sample Mitch supplied, and `PROMPT_VERSION 6` cut the length again and forbade numbers outright. The Care Notes Review page was rebuilt around it — a flat table, truncation, and *Clients Needing Attention* moved to the top — and Find Coverage's landing page became a weekly availability grid. Two new Edge Functions were written and **neither is deployed**. CLAUDE.md was trimmed and the evidence behind its rules moved into a frozen archive.

- **`PROMPT_VERSION 4` — the register from Mitch's sample, the caregiver kept as the subject.** Carlo, after holding our output beside a sample Mitch sent him: *"Edna (caregiver) blah blah is better than Caregiver blah blah."* The sample is **413 words for a whole day against our 1,039**, so the flowing-prose register was taken and the anonymity refused — the sample carries **zero caregiver names in 413 words**, and *"Transported to an outside facility"* cannot be rung up. The AM/PM split and the all-clear register (*"Routine day."*) were kept. v3 had already fixed the register (opens-with-a-name 19/20 → 21/21, passive voice 4/20 → 2/21) while losing ground on length and introducing two regressions — eight enumerated blood-pressure readings where v2 wrote *"ranging 155–187 systolic"*, and a block that told the desk about our plumbing (*"Reyna's note from a later shift (mislabeled in AM block)"*). v4 closed both: **21/21, passive voice 2/21, structure leaks 0**.
- **The PM window contradicted itself, in the prompt and in `blockFor()`.** `shiftOf()` files 14:00–06:00 as PM, but the prompt's opening line said *"PM is 2pm-10pm"* while a paragraph four lines later said it runs to 6am, and `blockFor()` stamped every block *"PM (2:00 PM - 10:00 PM)"* — a window that excludes the hours most PM blocks are about (Jose's ran to 7:00 AM, Ziad's ended 6:20 AM). Introduced on 2026-09-23 with the multi-note rule and caught only by comparing against somebody else's output.
- **The figure rule was made falsifiable.** *"Keep the times, dates and figures that matter"* is untestable, so anything numeric was copied: one-note blocks **with** a figure averaged 54 words and 11 of 15 broke the cap; without, 36 words and 1 of 4. It now reads that a figure earns its place only if a different value would change what the office does today, with a repeated-measurement clause beside it.
- **The caregiver's first name now comes from `care_notes.caregiver_name`.** It was being read out of the note body, so one caregiver was *"Aliyah"* in the AM block and *"Aaliyah"* in the PM block of the same household. It also cost fourteen words of identification against a 45-word cap — *"Donmar Erick Villanueva's shift with Jose Ortiz from 6:55 PM"* is now *"Donmar"*.
- **The summary may never characterise the caregiver.** *"Edna reports very minimal detail"* is a performance judgement, model-written and saved in a clinical table — the one line a family or a licensing reader would read as an accusation. The note may be thin; say that about the **note**.
- **`PROMPT_VERSION 6` — a general summary, and WRITE NO NUMBERS.** Carlo: *"still too wordy for the schedulers… Mitch just wants a summary of what generally happened."* No clock times, vitals, blood sugars, intake or output volumes, doses or counts of brief changes — describe the pattern instead, with one exception for a figure the note shows somebody reacting to, once, with what was done. Measured per client-day, the mean fell **77.8 → 53.2** and the median **68 → 59**; per 100 words, clock times **3.8 → 0.1** and numbers **8.7 → 0.0**, against a sample at 36.3 and 0.0. His reason held: the raw notes behind *View Original Notes* are 4,013 words for that day and v4 was reprinting **29%** of them.
- **Retired: the 45-word-per-BLOCK cap.** It was the wrong unit — 45 per block against a sample averaging ~36 per **client-day**, so a client with an AM and a PM block was licensed 90. It was also aspirational on Haiku: **41 of 65 saved blocks were over it, median 50 words**, and two prompt passes moved that 14/20 → 13/20, which is noise rather than a fix. `MAX_CHARS` 700 is what actually protects the page.
- **The word budget is split in CODE, because the model cannot divide.** `DAY_BUDGET_WORDS = 40` is the client's whole day. v5 said exactly that in the prompt and failed: one-block clients landed on a median 41, two-block clients on **83**, each block writing its own 40. `askClaude()` now counts each client's blocks and divides (nearest five, floor 15), and `blockFor()` stamps a `Budget: N words` line into each block header. Deterministic beats instructed.
- **Fabrication audit: one invented reading in 67 saved blocks, zero since v6.** A summary opened *"BP 128/81"* on a note recording only 142/79. One in 67 is small, but a figure we do not print is a figure we cannot get wrong, and a scheduling desk cannot act on a reading anyway — the second reason for the no-numbers rule.
- **Near-miss: the audit script itself had the UTC bucketing bug.** The first run reported wholesale invention — Brenda's *117/70*, Ziad's *Krissa* and *155–187*, Diann's *900cc* — and **all of it was real and correctly dated**. The script sliced the UTC timestamp, filing a 19:00 Pacific note under the next day. This is the trap already recorded against the care-notes sync, the caregiver calendar and the open-shift mirror, made this time in the checking tool: any script bucketing `care_notes` by day must use `toLocaleDateString('en-CA', {timeZone:'America/Los_Angeles'})`, exactly as `dayKey()` does.
- **The prompt's worked examples are invented people now.** v4's used real names and real readings off the live board — *Edna*, *Mary Lou*, *"Krissa called Leila"*, *155–187*. They are Rosa and Mr Alder, who do not exist, and the prompt says never to reuse a name, a reading or a time appearing in the instructions.
- **Three saved dates regenerated by hand.** `PROMPT_VERSION` rewrites a row on its next open, so nothing had to be done; it was done at Carlo's request so the desk saw the new wording immediately — 2026-09-16 (22 blocks), 2026-09-22 (22) and 2026-09-23 (21), **65 blocks, three model calls, about 5 cents**.
- **KNOWN, OPEN: Haiku overshoots a stated budget by about three quarters.** At v6 one-block clients land on a median 37 against a stated 40 — right — while two-block clients are told 20 each, write about 35 and land at a median 71. That is the whole remaining gap to the sample. Three passes moved the mean 77.8 → 59.9 → 53.2 and the next will not do much, so it is left alone; the levers are lowering `DAY_BUDGET_WORDS` (tuning against one model's behaviour) or `CARENOTES_MODEL=claude-sonnet-5` at ~5¢ a date against 1.8¢.
- **View More truncation on the summary blocks, and the sync-count banner dropped.** A busy client's AM/PM window holds several notes, or — before the summary generates — the raw fallback note, which runs to **6,130 characters**. Both truncate at ~220 characters with a *View more* that expands in place to the real text, never a CSS clamp; the per-block toggle lives in `state.cdExpanded`, UI-only and never synced. The *"N care notes synced from AxisCare"* banner went with it, since it duplicated the page's own summary strip and never described a specific date. Real failure and partial-load banners are untouched.
- **Yesterday's Summary became a genuine flat table.** The bordered, background-filled AM/PM boxes inside a nested two-column grid were replaced with one row per client across four aligned columns — Client / AM Shift / PM Shift / Action — sharing a single grid template with a new `.cd-thead`, and only a 1px divider between client rows. Below ~820px the header hides and rows stack, because the per-cell *"AM Shift 6:00 AM – 2:00 PM"* labels already say what a header would. Verified with headless Playwright: `.cd-col-shift` computes transparent background, no border, no radius, no padding.
- **Care Notes Review now leads with Clients Needing Attention.** It moved above Yesterday's Summary and Care Note Issues, and each row carries client, exact time, AM/PM window, caregiver, a priority-coloured category badge and a compact *Follow-up* line, so no click is needed to understand what happened. `careConcernsForDay()` carries `cgId` and the category's actions so the row needs no second lookup. The same change also printed the **full** note text inline, lifting `careConcernRowHtml()`'s 150-character cut — and that half was reversed within the day.
- **`carealerts-summary` — written, NOT deployed.** The section was still showing the caregiver's whole care note, routine shift content and all — meals, vitals, TV, toileting — none of which is why the client was flagged. The new Edge Function reads **one** flagged note at a time by an id the browser names, never text the browser supplies, and returns WHAT HAPPENED (1–3 bullets) and SCHEDULER ACTION (1–2), cached in a new `care_alert_summaries` table with RLS on and no anon policies. `careConcernRowHtml()` no longer renders `row.excerpt` at all, so no code path can print the raw note on this screen; loading shows *"Analysing…"* rather than the note, a deliberate departure from `CNSUM`'s fallback because here the raw note is the exact thing the screen was asked to stop showing. `tsc --noEmit` caught a real bug before commit — the assembly loop mixed the model-response shape `{whatHappened, schedulerAction}` with the DB-row shape `{what_happened, scheduler_action}` and would have thrown on every cached row. **Written but not yet deployed at the time of this commit**; both the SQL and the deploy
  landed later the same day — see *Clients Needing Attention is fixed and deployed* below,
  which also fixes the note-id bug that would have made it return nothing.
- **`caregiver-about-summary` — written, NOT deployed.** The one-sentence *About [Caregiver]* built from three fields is replaced by a six-section judgement — Overall, Strongest Experience, Best Fit, Scheduling Considerations, Reliability (facts only, never a bare "reliable") and Important History — read from profile, skills, AxisCare assignment history, care-note incidents, feedback, complaints, notes, both attendance sources, offer/decline history, availability, preferences, driving, travel limits and rating; empty sections are omitted rather than padded. It is a deliberate architectural departure from the three sibling functions: assignment history comes from AxisCare through the Netlify proxy, which a Supabase function cannot reach at all, so the browser assembles the dossier (`cgAiDigestText()`) and sends it — the trade `devi-agent` already makes. The cache signature is computed **server-side** from the digest actually received, never trusted from the caller, and `CGABOUT.soon()` fires only on a genuine change, debounced 500ms per caregiver. The old `cgAbout()` sentence stays as the fallback while loading, on error, or while the function is undeployed — never a blank box, never the raw dossier. **The SQL must be run and the function deployed before it does anything live.**
- **Find Coverage's generic landing page became a weekly availability grid.** The filter form that had to be filled in and searched before showing anything is now Monday–Friday against three fixed windows — Morning 6am–2pm, Afternoon 2pm–10pm, Night 10pm–6am — showing only counts until a bucket is clicked, with Previous/Next Week moving by 7 days. *Available* reuses `coverageDetail()` exactly, so the new view cannot disagree with the rest of the app, and it deliberately skips the `covClash`/`COVHIST` double-booking check because that is a real per-date cost and this is an overview to click into, not a calling queue. `wkEnsureWeek()` loads once per week shown — guarded the way `CNSUM` and `CALERT` are, because `render()` fires on every save and every 20-second poll — and fetches the Sunday before and Saturday after for the same overnight carry-in reason `runCoverageSearch()` does. The Coverage Planner's own Find Coverage shares this dispatch branch, so `viewCoverage()` now tells them apart on `searchQuery.clientId` and keeps the old detailed search intact for that path.
- **CLAUDE.md was trimmed and its history split out.** The file went from **6,090 lines to 3,781**; everything cut — the measurements behind a constant, the incident that produced a rule, the adversarial reviews, the approaches tried and reverted — is kept verbatim in `docs/HISTORY-2026-09.md`, ~346KB, frozen and deliberately **not** loaded into context. CLAUDE.md now carries the rules, the data reference and the commands, and points at the archive for the why.

---

## 2026-09-24 — Clients Needing Attention is fixed and deployed

Mitch reported the section failing on the live site with *"Could not reach the
carealerts-summary function"*. Two defects had been masking each other: the function
had never been deployed and its table never created, and — the one that mattered —
the browser sends a note id the function could never have matched.

- **`carealerts-summary` deployed, and `care_alert_summaries` created.** The SQL was run
  FIRST, deliberately: both database helpers swallow errors by design — `savedByIds()`
  returns an empty map on any failure and `dbPut()` only `console.warn`s — so a
  function deployed without its table looks perfect on screen while re-billing the
  Anthropic key on every open, forever, with nothing anywhere saying so. Seven Edge
  Functions are now live.
- **The note id contract was broken.** `fetchCareNotes()` is the only builder of
  `state.careNotes` and it keeps no copy of the AxisCare visit id, storing
  `id: "cn" + visit_id.replace(/[^A-Za-z0-9]+/g, "_")`. So `s=1626:d=2026-08-23`
  reached the function as `cns_1626_d_2026_08_23` while it looked the id up as
  `care_notes.visit_id`. **Zero rows matched** — every unit dropped, HTTP 200, an
  empty `units[]`, no model call. Deploying alone would have swapped a loud,
  correctly-worded error for five silent *"Could not analyse this note automatically"*
  rows with no strip and no Retry — strictly worse to debug from.
- **Fixed server-side, in `notesForDay()`.** The request already carries `day`, so the
  function now reads that Pacific day the way `carenotes-summary` already does and
  keys every note **both** ways: by the real `visit_id` and by `browserNoteId()`, which
  is byte-identical to the browser's munge. Munging all 719 rows in the live table
  gives 719 distinct keys, so there is nothing to collide.
- **Why not fix it in the browser.** `noteId + "__" + catKey` is also the key of
  `state.careAlertOverrides` — a tracked CLOUD map holding every scheduler's
  assign/status/action-tick state — and the `openAlertDetail()` argument. Re-keying it
  would have orphaned that work on all three desks, and needed a Netlify deploy plus a
  desk-wide hard refresh. Keying both ways means a later browser change still works.
- **Verified before deploying, then again after.** The patched function was run locally
  against the live database and the real Anthropic key, with the exact payload
  `index.html` builds for 2026-09-23 — `CARE_CATEGORIES` and `categorizeNote()` lifted
  out of `index.html` so the keys could not drift. Result: `generated=5, dropped=0` in
  7.5s for 2,202 in / 540 out tokens, about half a cent. Then against the deployed
  function from the live origin: `reused=5, dropped=0` in 1.1s, no spend.
- **The categoriser was over-flagging, and is now measured rather than guessed.**
  Reported the same day: a **critical** `falls` alert on a note whose only fall was
  *"Fell asleep on the couch"*. `categorizeNote()` matched with `indexOf` — no word
  boundaries, no negation, no sense. Every flagged note was labelled against the real
  table: **177 (note × category) pairs from all 719 notes, 41% correct**. Falls raised
  **39 alerts for 1 real fall**; family 23 for 1; 12 agitation alerts were notes saying
  *"no agitation noted"*; `hospital` matched *"if hospital bed comes"*.
- **Three mechanisms took it to 90%** — 94 false alerts removed across the corpus, one
  true alert lost. `CARE_BLANK` deletes a phrase before matching so a word in the
  wrong sense cannot fire (`fell|fall|fallen|falling + asleep` was 32 of the 39,
  plus *falling leaves* and *hospital bed*). `careNegated()` discards a hit whose
  nearest preceding negator is in the same clause, stopping at sentence punctuation and
  at `CARE_BREAK` — because *"Ed did not have PT today due to having chest pain"*
  negates the PT, not the pain, and without that break it ate a real alert. `CARE_HYPO`
  and `CARE_PREVENT` are two gates on purpose: risk-and-avoidance words apply to
  **falls only**, because "risky" in a safety note is a real hazard and the shared gate
  silently ate that one too.
- **Keyword corrections, each one the data's idea and not a guess** — bare `fall`
  (never once a real incident in 719 notes), `restless and` (a sentence conjunction),
  `during transfer` / `transfer from` (routine care), bare `safety` (a duty word,
  *"make sure the patient safety etc"*), bare `skipped` (matched oral care and a
  medication name) and bare `911` (a film the client was watching).
- **On the reported date, 2026-09-23: 5 flagged clients → 2**, and the two that remain
  are the two the summariser had produced useful text for. Falls across the whole corpus
  went **39 → 1**, and the survivor is the one real fall in the table — *"I was approached
  by Kim that she had fallen in front of her office"*.
- **A 14th category, Skin & Bleeding** (`prio: high`), after labelling 33 candidate
  notes. It fires on **6 of 719 notes and is right 6 times**, and it exists because the
  board showed nothing for three weeks of one client's pressure ulcer developing —
  *"pink colour like sore… hoping bed sore won't develop"* (23 Aug) through to *"pressure
  sore is bleeding, as it's fresh"* (11 Sep). **Every keyword is an event VERB, never a
  condition noun**, which is what makes an ongoing-care suppressor unnecessary: routine
  care talks in nouns (*"applied barrier cream on her bed sore"*) and never reaches a
  verb. Measured, the nouns are unusable — `blood` 61 fires for 1 real (it is "blood
  pressure"), `sore` 44/3, `bed sore` 13/1.
- **A PAIN category was measured and rejected**, and the decision is recorded so it is
  not revisited on a hunch. Bare `pain` fires on **41 of 719 notes for 5 real** — the
  Falls shape almost exactly. The reason is structural: pain here is a chronic managed
  fact about four clients, and what separates an alert from the care plan working is
  whether *this client* has said it before, which the note alone cannot tell you. The
  honest route is a per-client history suppressor, which is a feature rather than a word
  list. `migraine` shipped into changeCondition instead — 3 fires, 3 right.
- **Five keyword additions adopted, four rejected on measurement.** Adopted: `near-slip`,
  `trouble standing` and `not bearing weight` into **safety** (not falls — nobody fell,
  and not changeCondition either, so one sentence raises one row), plus `panic attack` and
  `migraine` into changeCondition. Rejected: `refused to have dinner` (5 fires, 0 real —
  every one the same client at the end of a shift with dinner prepared for later),
  `already took` (inverted: it catches only the routine confirmation and misses the real
  near-miss), and the ASCII `didn't eat` — already fixed by a better mechanism.
- **Apostrophe normalisation.** `careNorm()` folds curly apostrophes on **both** sides of
  the match. The keyword list was typed with `\u2019` and caregivers use both — 22 of the
  719 notes carry the curly form and 16 the ASCII one — so *"she didn't eat it"* had been
  missing on a character.
- **The Edge Function keeps its own category map, and that is a second list.** `skin` had
  to be added to `CATEGORIES` in `carealerts-summary/index.ts` and the function
  redeployed; an unknown `catKey` is dropped silently at HTTP 200, so the row would have
  read *"could not analyse"* forever. Verified live: 14 categories, and two real skin
  notes summarised end to end.
- **Net effect on the board: 177 alerts → 94**, across 146 notes → 84. Precision on the
  labelled set is unchanged at 90% with the same single loss, so nothing regressed.
- **KNOWN, accepted.** Bare `restless` is gone from agitation: it recovers one true
  alert and adds six false, every false one a note saying the client was *not* agitated.
  The 8 surviving false positives all need to know **who** the sentence is about ("it is
  the husband who is in hospital", "Elizabeth is the wife, not the client"), which keyword
  matching cannot do — that is what the summary is for, and it says so plainly.

---

## 2026-09-25 — the summaries stop naming anybody, and v7's regression is caught

Mitch read the live board and called both names redundant — *"Emelina helped Brenda
through her morning routine"* — because the row already prints the caregiver above the
text and the row itself is the client. He also named the opener *"Meryll cared for
Brenda through the evening and night"*, which spends its first clause on the shift
window the column header already gives. PR #17 had rewritten the register for exactly
this, but shipped untested — and run against the real notes it had regressed the number
discipline by an order of magnitude.

- **`PROMPT_VERSION 8`, deployed, and all 127 saved rows regenerated.** Head-to-head on
  one date (2026-09-23, 23 blocks), against v6 — what the desk was actually seeing —
  and v7, which sat in the repo and was never deployed:

  | | v6 | v7 | **v8** |
  |---|---|---|---|
  | words per block | 37 | 38 | **30** |
  | clock times per 100 words | 0.1 | 2.3 | **0.00** |
  | any digit per 100 words | 0.4 | 5.8 | **0.00** |
  | opens by naming the shift | 0 | most PM blocks | **0 of 23** |

  Across the whole board after regeneration — 127 rows, 6 dates, 19 clients: **33 words
  a block, 0.26 clock times and 0.38 digits per 100 words, 0 caregiver names, 0 of 117
  single-client blocks naming the client, and 10 of 10 couple blocks naming both.**
- **v7 was right about the register and wrong about everything it displaced.** Its own
  commit records that the session had no Anthropic key and no network, so it could not
  be run. WRITE NO NUMBERS was still in the prompt verbatim; it stopped working because
  ~25 lines of new register and priority material went in above it, and every worked
  example was a positive one with no number in it to strip. Exactly the v3 failure that
  v5 fixed the same way. **Deploying it as written would have regressed the live
  board.**
- **Three changes, no rewrite.** The number rule moved up beside the register with a
  NEGATIVE worked example showing a clock time being removed; opening with the shift
  window was banned outright; and a couple keeps both first names, because *"the
  client"* is wrong for two people — Mitch's caveat, pinned by its own example.
- **KNOWN, written but NOT shipped: v9.** 7 of the 127 rows still open *"Evening and
  overnight care included…"*, every one of them a quiet PM block where the model has no
  incident to lead with and reaches for the window to fill the gap. v9 bans that literal
  string and gives the quiet-shift case its own worked example, so the rule has
  something to fall back to. It was **reverted unshipped**: the Anthropic key hit its
  workspace budget mid-test, an untested prompt is what caused this entry, and bumping
  the version would mark all 127 rows stale and drop the whole board to raw notes until
  the budget resets.
- **The Anthropic key was out of budget for part of the day**, workspace-wide, and the
  error named 2026-10-01 as the reset. It **cleared the same day**, hours later, so do not
  trust a stated reset date — test the key. While it was out, every AI feature degraded to
  its designed fallback; saved rows were unaffected because reading one makes no model
  call, and texting kept working because `ctCareReady()` treats an error as a finished
  answer.

---

## 2026-09-25 (later) — the summaries say who did what again: `PROMPT_VERSION 9`

Mitch read the v8 board and rejected it: *"it is now too vague to understand the care
notes. It doesn't show what the caregiver did… we can use Caregiver help client."* He
was right, and v8 had over-read his earlier complaint: he objected to the two NAMES
being redundant, not to there being a subject at all.

- **Measured first.** Across the 127 live v8 rows, **80% of 663 sentences had no human
  subject** and **33% of blocks** carried an umbrella phrase — *"morning routine"*,
  *"household tasks"*, *"pet and home care completed"*. A run of transitive acts sharing
  one agent has no natural agentless English form, so banning the subject forces the
  model to nominalise. The vagueness was grammatical.
- **Two causes, not one.** The other half was a literal instruction to abstract, added
  with the brevity push on 2026-09-24: *"your job is what GENERALLY happened — not what
  happened"*, with a worked example (*"Morning routine completed, including a shower"*)
  modelling exactly the phrasing Mitch objected to.
- **v9 keeps the name ban and drops the subject ban.** Measured over the same six dates:

  | | mean | numbers | umbrella | dead opener | subject-less |
  |---|---|---|---|---|---|
  | v8 (was live) | 33.0w | 8% | 33% | 7 | 80% |
  | **v9 (shipped)** | **39.8w** | **13%** | **4%** | **0** | **37%** |

- **Six candidates were measured; the least-instructed one won.** Every richer variant
  was worse on number discipline — one that added a rule aimed squarely at spelled-out
  percentages **doubled** the leak it targeted, and a five-rule variant was worst of all.
  The three worked rewrites in the numbers block are what hold that rule; a candidate
  that cut them to one leaked on 7 of 23 blocks. **Never trade a rewrite for a rule.**
- **Two code fixes shipped with it.**
  - `blockFor()` was writing *"PM (2:00 PM - 6:00 AM, evening and overnight)"* into the
    **user** message, inches above the notes — handing the model the exact phrase the
    system prompt forbids. All 7 dead openers were PM blocks. Gloss removed; **0 now.**
  - `askClaude()` now asks **once per distinct note text** and copies the answer.
    13 of 215 two-block client-days carry byte-identical notes in both blocks, and the
    model was inventing an overnight to fit the PM heading — in one measured case
    contradicting the note it was given. A prompt rule held in one candidate and failed
    in the next; asking once cannot fabricate.
- **The card is now headed *Care Notes Summary*, not *Yesterday's Summary*.** Mitch's
  call: the page opens on yesterday but the day arrows reach any date, so the old name was
  wrong on every date but one. Renamed in the heading and in the two `index.html` comments
  that named the section.
- **Known residue, measured not guessed.** Numbers leak on 13% of blocks against v8's
  8%, concentrated in **spelled-out percentages** ("ate ninety percent") on two of six
  dates; the clock-time and digit rates are both *lower* than v8's. Blocks naming a
  relationship the note does not went 8/127 to 12/127, and several of those are fair
  generalisations the detector cannot see (one note says *"tatay Juan"* — Tagalog for
  father — which the summary renders as "a family member"). Mean length is up 33.0w to
  39.8w. All three were accepted as the price of the register fix.

---

## Still open

- Attendance, punctuality and the "Not tracked" caregiver metrics — all
  derivable from `clockIn` versus `scheduledStartDate` on visits already fetched.
- Care-note alert keywords have never been tuned against real notes. 111 real
  notes currently produce 0 alerts, because they are routine documentation
  rather than the emergencies the demo data was written to trigger.
- Authentication, before real client data goes any further.

Carried forward, and added since:

- **`caregiver-about-summary` is not deployed and `caregiver_about_summaries`
  does not exist.** Verified 2026-09-25: seven functions are deployed and it is the
  missing eighth. It is called by a live `index.html`, so the caregiver *About*
  summary falls back to its one-line sentence on the desk. It needs
  `supabase/caregiver-about-summaries.sql` run **first**, then
  `npx supabase functions deploy caregiver-about-summary --project-ref
  gdzgoyawavffjdjpjbfz --no-verify-jwt` — that order, because these functions swallow
  database errors by design and one deployed without its table looks perfect while
  re-billing the Anthropic key on every open. *Clients Needing Attention* is no longer
  in this state: `carealerts-summary` and `care_alert_summaries` both landed
  2026-09-24.
- **A cancelled AxisCare visit leaves its carve hole.** The uncarved intent is never
  stored, so availability the carve cut does not grow back when the visit is removed.
  Re-saving the day in the panel is the workaround.
- **`fetchCareNotes()` reads 400 rows against a table holding 701**, so the oldest ~16
  dates render as having no notes when the notes exist, and stay unsummarised.
- **Edits, unlike deletes, can still be reverted by another tab's stale copy.** The
  planned fix is moving the busiest slices into their own tables, as availability already is.
- **The daily overtime line — hours over 8 in a shift — is checked nowhere.** With 71%
  of visits over 8 hours, the rule that actually binds this agency fires several times a
  week and the board never mentions it.
- **Per-person logins.** The desk PIN is one shared credential; the AxisCare proxy and
  four of the eight Edge Functions still answer anyone with the URL.
- **Care-note summaries leak a number on 13% of blocks** (v8 was 8%), almost all of them
  **spelled-out percentages** — *"ate ninety percent of her breakfast"* — on two of the six
  dates. The clock-time and digit rates are both *lower* than v8's, so this is a narrow
  residue rather than a general regression. Every attempt to fix it in the prompt made it
  worse: a rule aimed squarely at percentages doubled the leak. The next thing to try is
  not another rule — it is a fourth worked rewrite, or a deterministic check.
- **Summaries name a relationship the note does not on 12 of 127 blocks** (v8: 8). Some
  are fair generalisations a detector cannot see — one note says *"tatay Juan"*, Tagalog
  for father, which the summary renders as "a family member" — but not all are.
- **A summary can still render a PLAN as a completed act.** Some notes are written as a
  to-do list (*"need to change her before I go"*, *"give her meds at night"*). A rule for
  this was drafted and left out, because every added rule measurably cost number
  discipline. It is the strongest candidate for the next change, and it should be
  measured over all six dates before shipping.
