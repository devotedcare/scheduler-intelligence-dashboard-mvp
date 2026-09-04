-- Section 8 of supabase/schema.sql, extracted so it can be run on its own.
-- Safe to re-run: every statement is create-if-not-exists / drop-if-exists.

-- ==============================================================
-- 8. Open shifts  (MIRRORED from AxisCare, not scanned on load)
--
-- An open shift is DERIVED, never fetched: a visit that is not
-- removed, has no caregiver, and is scheduled in the future.
-- Deriving it in the browser meant scanning every visit from today
-- to the end of next month. Measured 2026-09-03: 58 days, 14
-- SEQUENTIAL requests (AxisCare pages on nextPageToken, so each
-- page waits for the one before), 1,321 visits scanned, 9.1s -- to
-- produce 12 rows. Every scheduler paid that on every page load,
-- and it was the slowest of the five boot calls.
--
-- netlify/functions/openshifts-sync runs the identical rule and
-- writes the answer here. AxisCare stays the source of truth; this
-- is a cache with a timestamp on it, and the timestamp is shown.
--
-- WHAT THIS TABLE DOES NOT KNOW: an assignment made inside the
-- dashboard never reaches AxisCare -- the proxy forwards GET only
-- -- so a shift filled here stays in this table until somebody
-- types it into AxisCare. That blind spot is not new (the live scan
-- had it too), but it means these rows are "open in AxisCare", NOT
-- "needs coverage".
--
-- shift_date is sliced TEXTUALLY from the leading YYYY-MM-DD of
-- scheduledStartDate, never cast from starts_at. AxisCare stamps
-- its own offset, so a -07:00 evening visit casts to the NEXT day
-- in UTC. The care-notes sync and the caregiver calendar both had
-- to fix that same bug; this avoids inheriting it.
-- ==============================================================
create table if not exists public.open_shifts (
  visit_id     text        primary key,   -- AxisCare visit id, e.g. v=56967:s=0:d=2026-09-03
  shift_date   date        not null,      -- wall date of the visit, sliced from the string
  client_id    bigint      not null,      -- AxisCare client id (342), not k342
  starts_at    timestamptz not null,      -- scheduledStartDate, offset intact
  ends_at      timestamptz,               -- scheduledEndDate; null if AxisCare gave none
  service      text,
  synced_at    timestamptz not null       -- ONE stamp per run; the sweep key
);

create index if not exists open_shifts_start_idx on public.open_shifts (starts_at asc);
create index if not exists open_shifts_sweep_idx on public.open_shifts (shift_date, synced_at);

-- Freshness heartbeat. It exists because ZERO OPEN SHIFTS IS A
-- LEGITIMATE ANSWER: with no rows in open_shifts there is no
-- synced_at to read, so "nothing is open" and "the sync has never
-- run" would be indistinguishable on screen.
--
-- This is the only sync-state table the BROWSER reads, which is why
-- -- unlike care_notes_sync and availability_copy_sync -- it carries
-- a select policy. It holds a timestamp, a status string and two
-- counts. No PHI. last_status is built from an AxisCare error, so
-- the sync truncates it and redacts the token before writing.
--
-- last_ok_at advances ONLY on a run that scanned the whole window.
-- That is the freshness contract: a partial run may close a shift it
-- positively saw taken, but may never close one merely because it
-- did not look there.
create table if not exists public.open_shifts_sync (
  id           text        primary key,
  last_run_at  timestamptz,               -- last attempt, successful or not
  last_ok_at   timestamptz,               -- last run that scanned the WHOLE window
  last_status  text,                      -- ok | partial: ... | error: ...
  running_at   timestamptz,               -- lock: set when a run starts, cleared at the end
  window_from  date,
  window_to    date,
  scanned      int         not null default 0,
  shifts_open  int         not null default 0   -- open in AXISCARE; see above
);

insert into public.open_shifts_sync (id) values ('openshifts')
on conflict (id) do nothing;

-- --------------------------------------------------------------
-- 8a. Open-shift security -- the same shape as care_notes.
--
-- The dashboard READS with the anon key. Writing is deliberately NOT
-- granted: only the sync writes, with SUPABASE_SERVICE_ROLE_KEY,
-- which lives in a Netlify environment variable and never reaches a
-- browser. So a stranger with the site URL can read open shifts --
-- the exposure already accepted for the AxisCare proxy, written up
-- in README.md under "Security posture" -- but cannot forge a shift
-- or empty the coverage board.
-- --------------------------------------------------------------
alter table public.open_shifts      enable row level security;
alter table public.open_shifts_sync enable row level security;

drop policy if exists "anon read open shifts" on public.open_shifts;
create policy "anon read open shifts"
  on public.open_shifts for select
  to anon, authenticated
  using (true);

drop policy if exists "anon read open shift sync" on public.open_shifts_sync;
create policy "anon read open shift sync"
  on public.open_shifts_sync for select
  to anon, authenticated
  using (true);

-- No anon insert/update/delete on either table.

notify pgrst, 'reload schema';
