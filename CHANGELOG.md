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

### Still open

- Attendance, punctuality and the "Not tracked" caregiver metrics — all
  derivable from `clockIn` versus `scheduledStartDate` on visits already fetched.
- Care-note alert keywords have never been tuned against real notes. 111 real
  notes currently produce 0 alerts, because they are routine documentation
  rather than the emergencies the demo data was written to trigger.
- Authentication, before real client data goes any further.
