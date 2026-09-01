-- ==============================================================
-- Devoted Care · Scheduler Intelligence — Supabase schema
--
-- Run this ONCE in your Supabase project:
--   Supabase dashboard > SQL Editor > New query > paste > Run
--
-- Safe to re-run: everything is idempotent.
-- ==============================================================

-- --------------------------------------------------------------
-- 1. The table
--
-- One row per workspace. `overlay` holds ONLY what a human changed
-- (added / deleted / edited records) — not the whole app state.
-- Caregivers, clients and shifts are demo data regenerated in the
-- browser on every load so their clocks stay live.
--
-- `rev` powers optimistic concurrency: the app updates
--   ... WHERE id = :workspace AND rev = :rev_it_last_saw
-- so when two schedulers save at the same moment the loser is told
-- to re-read and re-apply instead of silently overwriting.
-- --------------------------------------------------------------
create table if not exists public.scheduler_state (
  id          text primary key,
  overlay     jsonb       not null default '{}'::jsonb,
  rev         bigint      not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

comment on table  public.scheduler_state is 'Scheduler Intelligence — one row per workspace. Holds the user-edit overlay, not full app state.';
comment on column public.scheduler_state.overlay    is 'adds / dels / patches / maps / scalars produced by the browser.';
comment on column public.scheduler_state.rev        is 'Optimistic-concurrency counter. Incremented on every successful save.';
comment on column public.scheduler_state.updated_by is 'Which scheduler was on shift for the last save.';

-- Seed the workspace row so the very first visitor does not have to.
insert into public.scheduler_state (id, overlay, rev, updated_by)
values ('devoted_care', '{}'::jsonb, 0, 'setup')
on conflict (id) do nothing;


-- --------------------------------------------------------------
-- 2. Row-level security
--
-- >>> READ THIS BEFORE REAL CLIENT DATA GOES IN <<<
--
-- This MVP has no login by design: anyone with the site link can use
-- it. That means the browser talks to Supabase using only the anon
-- key, which is public and visible in view-source. So the policies
-- below allow anonymous read and write.
--
-- Consequence, stated plainly: ANYONE WHO HAS THE SITE URL CAN READ
-- AND WRITE THIS ROW. That is an accepted trade-off while the data
-- is fictional demo data. Before real caregiver names, client names,
-- care notes or medication lists are entered, switch to the locked
-- down policies in section 4.
-- --------------------------------------------------------------
alter table public.scheduler_state enable row level security;

drop policy if exists "anon read scheduler state"   on public.scheduler_state;
drop policy if exists "anon insert scheduler state" on public.scheduler_state;
drop policy if exists "anon update scheduler state" on public.scheduler_state;

create policy "anon read scheduler state"
  on public.scheduler_state for select
  to anon, authenticated
  using (true);

create policy "anon insert scheduler state"
  on public.scheduler_state for insert
  to anon, authenticated
  with check (true);

create policy "anon update scheduler state"
  on public.scheduler_state for update
  to anon, authenticated
  using (true)
  with check (true);

-- Note: there is deliberately NO delete policy. Nothing in the app
-- deletes the row, so nothing on the internet can either. "Reset
-- demo data" blanks the overlay via an UPDATE instead.


-- --------------------------------------------------------------
-- 3. Care notes  (synced from AxisCare, not fetched live)
--
-- A caregiver's shift documentation lives ONLY on the per-visit
-- detail call, /api/visits/{visitId} -> careNote. There is no bulk
-- endpoint. At ~170 worked visits a week that is 170 requests per
-- sweep — far too slow for a page load, and the same shape that
-- caused repeated 429s on the Client Concierge dashboard.
--
-- So they are swept into this table on a schedule and the dashboard
-- reads them from here, making zero AxisCare calls.
-- --------------------------------------------------------------
create table if not exists public.care_notes (
  visit_id     text primary key,          -- AxisCare visit id, e.g. "s=1543:d=2026-08-21"
  client_id    bigint,
  client_name  text,
  caregiver_id bigint,
  caregiver_name text,
  visit_at     timestamptz,               -- scheduled start of the visit
  note         text not null,
  synced_at    timestamptz not null default now()
);

comment on table public.care_notes is
  'Caregiver shift notes swept from AxisCare /api/visits/{id}.careNote. Read-only mirror; AxisCare stays the source of truth.';

create index if not exists care_notes_visit_at_idx on public.care_notes (visit_at desc);
create index if not exists care_notes_client_idx   on public.care_notes (client_id, visit_at desc);

-- Sync progress, so a run that hits its time limit can be resumed by
-- the next one instead of starting over.
create table if not exists public.care_notes_sync (
  id           text primary key,
  cursor_date  date,                      -- day currently being swept
  cursor_index int  not null default 0,   -- position within that day
  last_run_at  timestamptz,
  last_status  text,
  notes_written int not null default 0
);

insert into public.care_notes_sync (id, cursor_date, cursor_index)
values ('carenotes', null, 0)
on conflict (id) do nothing;


-- --------------------------------------------------------------
-- 3a. Care-notes security
--
-- The dashboard READS these with the anon key, exactly like
-- scheduler_state. Writing is deliberately NOT granted to anon:
-- only the sync function writes, using the service-role key, which
-- lives in a Netlify environment variable and never reaches a
-- browser. So a stranger with the site URL can read care notes
-- (the same exposure already accepted for the AxisCare proxy) but
-- cannot forge or destroy them.
-- --------------------------------------------------------------
alter table public.care_notes      enable row level security;
alter table public.care_notes_sync enable row level security;

drop policy if exists "anon read care notes" on public.care_notes;
create policy "anon read care notes"
  on public.care_notes for select
  to anon, authenticated
  using (true);

-- No anon insert/update/delete policy, and none for care_notes_sync
-- at all. The service-role key bypasses RLS, which is what the sync
-- function uses.


-- --------------------------------------------------------------
-- 4. When you are ready to require a login
--
-- Run this block to revoke anonymous access. You must also add a
-- sign-in screen to the app first, or nobody will be able to save.
-- --------------------------------------------------------------
-- drop policy if exists "anon read scheduler state"   on public.scheduler_state;
-- drop policy if exists "anon insert scheduler state" on public.scheduler_state;
-- drop policy if exists "anon update scheduler state" on public.scheduler_state;
--
-- create policy "signed-in read"   on public.scheduler_state for select to authenticated using (true);
-- create policy "signed-in insert" on public.scheduler_state for insert to authenticated with check (true);
-- create policy "signed-in update" on public.scheduler_state for update to authenticated using (true) with check (true);


-- --------------------------------------------------------------
-- 5. Handy checks
-- --------------------------------------------------------------
-- Confirm RLS is on and see the active policies:
--   select relname, relrowsecurity from pg_class where relname = 'scheduler_state';
--   select policyname, cmd, roles from pg_policies where tablename = 'scheduler_state';
--
-- See the current save:
--   select id, rev, updated_by, updated_at,
--          pg_size_pretty(length(overlay::text)::bigint) as overlay_size
--     from public.scheduler_state;
--
-- Care-note sync health:
--   select * from public.care_notes_sync;
--   select count(*), min(visit_at), max(visit_at) from public.care_notes;

-- ==============================================================
-- 6. Caregiver availability  (scheduler-entered, one row per segment)
-- --------------------------------------------------------------
-- WHAT THIS REPLACES. The dashboard used to hold a weekly rule per
-- caregiver plus a list of date overrides, generated from sample data and
-- kept in the shared overlay blob. Both are gone. A caregiver's
-- availability is now exactly what a scheduler typed against a DATE, and
-- nothing else. A date nobody has filled in is BLANK, which honestly means
-- "we have not been told" rather than "unavailable".
--
-- AxisCare visits are NOT stored here. They are fetched live per caregiver
-- and painted on top. Storing them would create a second copy that goes
-- stale the moment a visit moves.
--
-- WHAT A ROW IS. One segment of one caregiver's one day. The browser
-- computes the segments before saving, so what is in this table is what is
-- drawn:  "Open 8a-5p" then Add "Unavailable 12p-1p"  is stored as
--     Open 08:00-12:00 | Unavailable 12:00-13:00 | Open 13:00-17:00
-- and reading a day is a plain select with no merge logic on top.
--
-- WHY THE CHECKS ARE STRICT. The predecessor table in the other system
-- allowed any status with any time shape, and accumulated malformed rows -
-- untimed "Open" claiming 24 hours, part-of-day words nobody set. Those
-- rows are why this is a fresh table rather than a shared one. The rules
-- live in the DATABASE so a browser bug cannot write a shape the calendar
-- then has to guess at.
-- --------------------------------------------------------------

-- Needed for the no-overlap guarantee below.
create extension if not exists btree_gist;

create table if not exists public.caregiver_availability (
  id           bigint      generated always as identity primary key,
  caregiver_id bigint      not null,          -- AxisCare id (312), not the app's 'a312'
  on_date      date        not null,          -- the day this segment belongs to
  status       text        not null,
  all_day      boolean     not null default false,
  -- Minutes from midnight on on_date. An overnight segment runs PAST 1440:
  -- 8pm-8am is 1200 -> 1920. It belongs entirely to its START date, which is
  -- the same rule the calendar already uses for AxisCare visits, so overnight
  -- looks identical whoever recorded it.
  start_min    smallint,
  end_min      smallint,
  note         text,
  updated_by   text        not null default 'Carlo',   -- placeholder until there are logins
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- 'Devoted Shift' is deliberately absent: those come from AxisCare.
  -- 'Custom' is absent too - in the old table it was both a status and a
  -- time mode, which is how half the bad rows happened.
  constraint caregiver_availability_status_ck check (status in (
    'Open', 'Unavailable', 'Vacation', 'Sick',
    'School', 'Childcare', 'Appointment', 'Other Agency'
  )),

  -- All-day carries no hours; a timed segment carries both.
  constraint caregiver_availability_shape_ck check (
    (all_day and start_min is null and end_min is null)
    or (not all_day and start_min is not null and end_min is not null)
  ),

  -- Open MAY be all-day: that is a caregiver free the whole of that date,
  -- 00:00-24:00, and Find Coverage reads it as covering any shift inside the
  -- day. It used to be forbidden (open_timed_ck) on the reasoning that an
  -- untimed Open promised hours nobody had stated; the desk decided the
  -- opposite - 'free all day' is a real answer a scheduler gives, and the
  -- calendar shows no time because no time IS the statement. The drop is
  -- applied below so databases created before 2026-08-27 pick it up.
  -- Vacation is a whole-day state. Nobody takes two hours of vacation.
  constraint caregiver_availability_vacation_allday_ck check (
    status <> 'Vacation' or all_day
  ),
  -- Being somewhere at a time is what these mean, so they need the time.
  constraint caregiver_availability_timed_only_ck check (
    status not in ('School', 'Childcare', 'Appointment') or not all_day
  ),

  -- Within the day, and forward. end_min may pass 1440 (overnight) but a
  -- segment can never be longer than 24 hours.
  constraint caregiver_availability_range_ck check (
    all_day or (
      start_min >= 0 and start_min < 1440
      and end_min > start_min and end_min <= 2880
      and end_min - start_min <= 1440
    )
  )
);

-- A day is either one all-day statement or a set of timed segments, never
-- both, and the timed ones never overlap. The browser already computes
-- non-overlapping segments; this is the seatbelt, and it is the single
-- constraint that would have prevented the old table's mess.
create unique index if not exists caregiver_availability_allday_uq
  on public.caregiver_availability (caregiver_id, on_date)
  where all_day;

-- Open became a whole-day state on 2026-08-27. Dropping a check only ever
-- widens what is allowed, so no existing row can be invalidated by this.
alter table public.caregiver_availability
  drop constraint if exists caregiver_availability_open_timed_ck;

alter table public.caregiver_availability
  drop constraint if exists caregiver_availability_no_overlap;
alter table public.caregiver_availability
  add constraint caregiver_availability_no_overlap
  exclude using gist (
    caregiver_id with =,
    on_date with =,
    int4range(start_min::int, end_min::int) with &&
  ) where (not all_day);

-- The two reads this table gets, and nothing else:
--   one caregiver's calendar   caregiver_id = X and on_date between A and B
--   Find Coverage for a date   on_date = D  (across the whole roster)
create index if not exists caregiver_availability_cg_date_idx
  on public.caregiver_availability (caregiver_id, on_date);
create index if not exists caregiver_availability_date_idx
  on public.caregiver_availability (on_date);

comment on table public.caregiver_availability is
  'Scheduler-entered availability. One row per segment per caregiver per day. AxisCare visits are NOT stored here.';
comment on column public.caregiver_availability.caregiver_id is
  'AxisCare caregiver id, so the data transfers to the release app unchanged.';
comment on column public.caregiver_availability.start_min is
  'Minutes from midnight on on_date. end_min > 1440 means the segment runs into the next morning.';

-- Keep updated_at honest without the browser having to remember.
create or replace function public.touch_caregiver_availability()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists caregiver_availability_touch on public.caregiver_availability;
create trigger caregiver_availability_touch
  before update on public.caregiver_availability
  for each row execute function public.touch_caregiver_availability();

-- --------------------------------------------------------------
-- Row-level security
-- --------------------------------------------------------------
-- The browser writes this table directly with the anon key, including
-- DELETE - "Clear" empties a day and "Set day" replaces one. That is the
-- same posture already accepted for scheduler_state, and it is reviewed in
-- README.md under Security posture. It is an MVP on an unlisted URL; when
-- logins arrive these become `to authenticated`.
alter table public.caregiver_availability enable row level security;

drop policy if exists "anon read availability"   on public.caregiver_availability;
drop policy if exists "anon insert availability" on public.caregiver_availability;
drop policy if exists "anon update availability" on public.caregiver_availability;
drop policy if exists "anon delete availability" on public.caregiver_availability;

create policy "anon read availability"
  on public.caregiver_availability for select
  to anon, authenticated using (true);

create policy "anon insert availability"
  on public.caregiver_availability for insert
  to anon, authenticated with check (true);

create policy "anon update availability"
  on public.caregiver_availability for update
  to anon, authenticated using (true) with check (true);

create policy "anon delete availability"
  on public.caregiver_availability for delete
  to anon, authenticated using (true);

-- --------------------------------------------------------------
-- Pruning - keep only what the calendar can reach
-- --------------------------------------------------------------
-- The caregiver calendar shows last month through the same month next
-- year. Once September arrives, July of last year can no longer be opened,
-- so its rows are unreachable and are deleted. Nothing is written for
-- empty months, so the table only ever holds days somebody filled in.
create or replace function public.prune_caregiver_availability()
returns integer language plpgsql security definer set search_path = public as $$
declare
  -- cast AFTER the subtraction: date - interval yields a timestamp, and
  -- letting it coerce back to date on assignment is the kind of implicit
  -- step that quietly shifts by a day under a non-UTC server timezone.
  cutoff date := (date_trunc('month', current_date) - interval '1 month')::date;
  removed integer;
begin
  delete from public.caregiver_availability where on_date < cutoff;
  get diagnostics removed = row_count;
  return removed;
end $$;

comment on function public.prune_caregiver_availability() is
  'Deletes availability older than the first day of last month - the earliest date the calendar can open.';

-- Run it monthly. pg_cron has to be enabled once, under
-- Database > Extensions in the Supabase dashboard; until then, calling the
-- function by hand does the same job.
--   create extension if not exists pg_cron;
--   select cron.schedule('prune-caregiver-availability', '0 3 1 * *',
--                        $$select public.prune_caregiver_availability()$$);
--
-- By hand:  select public.prune_caregiver_availability();

notify pgrst, 'reload schema';

-- --------------------------------------------------------------
-- Handy checks
-- --------------------------------------------------------------
--   select count(*), min(on_date), max(on_date) from public.caregiver_availability;
--   select status, count(*) from public.caregiver_availability group by 1 order by 2 desc;
--
-- One caregiver's month, the way the calendar reads it:
--   select on_date, status, all_day, start_min, end_min, note
--     from public.caregiver_availability
--    where caregiver_id = 312 and on_date between '2026-09-01' and '2026-09-30'
--    order by on_date, start_min;
--
-- Prove the guards work (each of these should FAIL):
--   insert into public.caregiver_availability (caregiver_id, on_date, status, all_day, start_min, end_min)
--     values (312, '2026-09-01', 'Vacation', false, 540, 1020);    -- Vacation is whole-day
--
-- (An all-day Open used to belong in that list. Since 2026-08-27 it is
--  LEGAL and means the caregiver is free the whole of that date.)
--   insert into public.caregiver_availability (caregiver_id, on_date, status, all_day, start_min, end_min)
--     values (312, '2026-09-02', 'Open', false, 540, 1020),
--            (312, '2026-09-02', 'Open', false, 600, 1080);        -- segments may not overlap

-- ==============================================================
-- 6b. Writing a day  (run once, after section 6)
-- --------------------------------------------------------------
-- WHY A FUNCTION AND NOT TWO REQUESTS. Saving a day means "this date now
-- holds exactly these segments", which is a DELETE followed by an INSERT.
-- Done from the browser that is two round trips, and a dropped connection
-- between them leaves the day EMPTY - the scheduler's work deleted and
-- nothing put back. Inside a function the pair is one transaction: it
-- either replaces the day or changes nothing.
--
-- It also takes an ARRAY of dates, so "apply to selected days" is one call
-- that either writes all of them or none, instead of thirty writes that can
-- half-fail.
-- --------------------------------------------------------------

-- A day is EITHER one whole-day statement OR a set of timed segments.
-- The unique index already stops two all-day rows, and the exclusion
-- constraint stops two timed rows overlapping, but nothing stopped an
-- all-day row sitting alongside timed ones - which reads as a day that is
-- both "Unavailable all day" and "Open 9-5", and the calendar would have to
-- guess. The browser never writes that shape; this is the seatbelt.
create or replace function public.caregiver_availability_day_shape()
returns trigger language plpgsql as $$
declare
  n_allday integer;
  n_timed  integer;
begin
  select count(*) filter (where all_day),
         count(*) filter (where not all_day)
    into n_allday, n_timed
    from public.caregiver_availability
   where caregiver_id = new.caregiver_id and on_date = new.on_date;

  if n_allday > 0 and n_timed > 0 then
    raise exception
      'a day is either one whole-day entry or timed segments, not both (caregiver % on %)',
      new.caregiver_id, new.on_date
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

drop trigger if exists caregiver_availability_day_shape_t on public.caregiver_availability;
create constraint trigger caregiver_availability_day_shape_t
  after insert or update on public.caregiver_availability
  deferrable initially deferred
  for each row execute function public.caregiver_availability_day_shape();

-- --------------------------------------------------------------
-- Replace one or more days with exactly these segments.
--
--   select public.set_availability_days(
--     1108, array['2026-09-03','2026-09-04']::date[],
--     '[{"status":"Open","all_day":false,"start_min":540,"end_min":1020,"note":null}]'::jsonb,
--     'Carlo');
--
-- An empty array of segments CLEARS the days, which is what the panel's
-- Clear does. Returns how many rows it wrote.
-- --------------------------------------------------------------
create or replace function public.set_availability_days(
  p_caregiver_id bigint,
  p_dates        date[],
  p_segments     jsonb,
  p_updated_by   text default 'Carlo'
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  written integer := 0;
  n       integer;          -- GET DIAGNOSTICS needs its own target
  d date;
begin
  if p_caregiver_id is null then
    raise exception 'caregiver_id is required' using errcode = 'null_value_not_allowed';
  end if;
  if p_dates is null or array_length(p_dates, 1) is null then
    return 0;
  end if;

  -- One transaction for every date named. The deferred shape trigger fires
  -- at COMMIT, so a day passes through an intermediate state mid-statement
  -- without tripping it.
  foreach d in array p_dates loop
    delete from public.caregiver_availability
     where caregiver_id = p_caregiver_id and on_date = d;

    insert into public.caregiver_availability
      (caregiver_id, on_date, status, all_day, start_min, end_min, note, updated_by)
    select p_caregiver_id, d,
           s->>'status',
           coalesce((s->>'all_day')::boolean, false),
           nullif(s->>'start_min', '')::smallint,
           nullif(s->>'end_min', '')::smallint,
           nullif(btrim(coalesce(s->>'note', '')), ''),
           coalesce(nullif(btrim(p_updated_by), ''), 'Carlo')
      from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) s;

    -- GET DIAGNOSTICS assigns a diagnostic ITEM to a variable; it cannot
    -- take an expression, so the running total is added separately.
    get diagnostics n = row_count;
    written := written + n;
  end loop;

  return written;
end $$;

comment on function public.set_availability_days(bigint, date[], jsonb, text) is
  'Replaces each named date with exactly the given segments, in one transaction. Empty segments clears the days.';

grant execute on function public.set_availability_days(bigint, date[], jsonb, text) to anon, authenticated;

notify pgrst, 'reload schema';

-- --------------------------------------------------------------
-- Handy checks
-- --------------------------------------------------------------
-- Write a day, read it back, then clear it:
--   select public.set_availability_days(999999, array['2026-09-03']::date[],
--     '[{"status":"Open","all_day":false,"start_min":540,"end_min":720,"note":null},
--       {"status":"Unavailable","all_day":false,"start_min":720,"end_min":780,"note":null},
--       {"status":"Open","all_day":false,"start_min":780,"end_min":1020,"note":null}]'::jsonb);
--   select on_date, status, all_day, start_min, end_min from public.caregiver_availability
--    where caregiver_id = 999999 order by start_min;
--   select public.set_availability_days(999999, array['2026-09-03']::date[], '[]'::jsonb);
--
-- The shape trigger should REFUSE this (all-day beside a timed segment):
--   select public.set_availability_days(999999, array['2026-09-04']::date[],
--     '[{"status":"Unavailable","all_day":true},
--       {"status":"Open","all_day":false,"start_min":540,"end_min":1020}]'::jsonb);

-- ==============================================================
--  caregiver_day_notes  -  what a scheduler wrote about ONE DAY
-- ==============================================================
-- Deliberately its OWN table rather than a column on
-- caregiver_availability. A note is about the DAY, not about a block of
-- hours: it can exist on a day with no availability at all, replacing the
-- day's hours must not rewrite it, and clearing the day's availability must
-- not delete it. None of that held while it lived on the availability row -
-- every save carried modalState.note onto the new segments, and a Clear
-- took the note with them.
--
-- One row per caregiver per date. An empty note is not stored; the panel
-- deletes the row instead, so "has a note" is simply "a row exists".

create table if not exists public.caregiver_day_notes (
  id           bigint      generated always as identity primary key,
  caregiver_id bigint      not null,          -- AxisCare id (312), not 'a312'
  on_date      date        not null,
  note         text        not null,
  updated_by   text        not null default 'Carlo',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- blank is not a note. Clearing the box removes the row.
  constraint caregiver_day_notes_note_ck check (btrim(note) <> ''),
  -- the browser caps typing far below this; the table only stops absurdity
  constraint caregiver_day_notes_len_ck  check (length(note) <= 2000),
  -- one note per day, which is what makes an upsert on (caregiver, date) work
  constraint caregiver_day_notes_uq unique (caregiver_id, on_date)
);

-- the roster-wide read: every caregiver's notes over a window of dates
create index if not exists caregiver_day_notes_date_idx
  on public.caregiver_day_notes (on_date);

-- keep updated_at honest without the browser having to send it
create or replace function public.touch_caregiver_day_notes()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists caregiver_day_notes_touch on public.caregiver_day_notes;
create trigger caregiver_day_notes_touch
  before update on public.caregiver_day_notes
  for each row execute function public.touch_caregiver_day_notes();

-- Same posture as caregiver_availability: anon may read and write, because
-- there are no logins yet and the schedulers are the only people with the
-- URL. Reviewed in README.md under Security posture; when logins arrive
-- these become `to authenticated`.
alter table public.caregiver_day_notes enable row level security;

drop policy if exists "anon read day notes"   on public.caregiver_day_notes;
drop policy if exists "anon insert day notes" on public.caregiver_day_notes;
drop policy if exists "anon update day notes" on public.caregiver_day_notes;
drop policy if exists "anon delete day notes" on public.caregiver_day_notes;

create policy "anon read day notes"
  on public.caregiver_day_notes for select
  to anon, authenticated using (true);

create policy "anon insert day notes"
  on public.caregiver_day_notes for insert
  to anon, authenticated with check (true);

create policy "anon update day notes"
  on public.caregiver_day_notes for update
  to anon, authenticated using (true) with check (true);

create policy "anon delete day notes"
  on public.caregiver_day_notes for delete
  to anon, authenticated using (true);

notify pgrst, 'reload schema';


-- ===============================================================
--  CLIENT MATCHING  -  synced from the Client Concierge project
-- ===============================================================
-- Concierge (abotpetigotopedfuvbc) is where the desk records what a
-- client needs in a caregiver. netlify/functions/matching-sync.js reads
-- it and fills these two tables; the dashboard reads only from here, so
-- Concierge's key never reaches a browser. That matters: that key can
-- read the whole of concierge_records, including 179 care notes.

-- One row per client. Every column is Concierge's; nothing here writes them.
create table if not exists public.client_match_prefs (
  client_axis_id   bigint      primary key,          -- AxisCare client id (327), not 'k327'
  gender_pref      text,                             -- 'F' | 'M' | null. null IS "No Preference".
  driving_required boolean,
  language         text,
  raw_prefs        jsonb       not null default '[]'::jsonb,
  concierge_rid    text,
  synced_at        timestamptz not null default now(),

  constraint client_match_prefs_gender_ck check (gender_pref is null or gender_pref in ('F','M'))
);

-- One row per (client, caregiver name) as Concierge stores it.
--
-- TWO OWNERS, deliberately. Concierge owns WHICH NAMES are on a client's
-- list, so the sync adds and removes rows freely. This app owns WHICH
-- CAREGIVER a name resolves to, so once match_state is 'confirmed' the
-- sync never touches caregiver_id again - the same guard the availability
-- copy uses with 'Auto-copy', and for the same reason.
--
-- Concierge stores names, not ids. 49 of 53 resolve automatically; the
-- rest are a typo (Brahser/Brasher) and nicknames (Marge/Margarita,
-- Marge/Margie) that a matcher must NOT guess - getting one wrong either
-- offers a caregiver the family did not ask for, or hides one they did.
create table if not exists public.client_caregiver_match (
  id             bigint      generated always as identity primary key,
  client_axis_id bigint      not null,
  caregiver_name text        not null,               -- VERBATIM from Concierge
  caregiver_id   bigint,                             -- resolved AxisCare id, null until matched
  match_state    text        not null default 'unmatched',
  sort_order     integer     not null default 0,     -- Concierge's order; first is most preferred
  concierge_rid  text,
  updated_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),

  constraint client_caregiver_match_state_ck
    check (match_state in ('unmatched','auto','confirmed')),
  constraint client_caregiver_match_resolved_ck
    check (match_state = 'unmatched' or caregiver_id is not null),
  constraint client_caregiver_match_name_ck check (btrim(caregiver_name) <> ''),
  constraint client_caregiver_match_uq unique (client_axis_id, caregiver_name)
);

create index if not exists client_caregiver_match_client_idx
  on public.client_caregiver_match (client_axis_id);
create index if not exists client_caregiver_match_cg_idx
  on public.client_caregiver_match (caregiver_id) where caregiver_id is not null;

create or replace function public.touch_client_caregiver_match()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists client_caregiver_match_touch on public.client_caregiver_match;
create trigger client_caregiver_match_touch
  before update on public.client_caregiver_match
  for each row execute function public.touch_client_caregiver_match();

-- Same posture as every other table here, written up in README.md under
-- Security posture. Prefs are read-only to the app: they are Concierge's
-- answer. The match table takes updates, because resolving a name is this
-- app's job and a scheduler does it in the UI.
alter table public.client_match_prefs     enable row level security;
alter table public.client_caregiver_match enable row level security;

drop policy if exists "anon read match prefs" on public.client_match_prefs;
create policy "anon read match prefs" on public.client_match_prefs
  for select to anon, authenticated using (true);

drop policy if exists "anon read matches"   on public.client_caregiver_match;
drop policy if exists "anon update matches" on public.client_caregiver_match;
create policy "anon read matches" on public.client_caregiver_match
  for select to anon, authenticated using (true);
create policy "anon update matches" on public.client_caregiver_match
  for update to anon, authenticated using (true) with check (true);

notify pgrst, 'reload schema';

-- Resume point for netlify/functions/availability-copy.js.
--
-- The copy is chunked because filling a fresh month for the whole roster is
-- ~2,500 rows and a Netlify function is time-limited. A run works to a soft
-- deadline, saves the caregiver it reached, and the next run continues --
-- the same shape as care_notes_sync, and for the same reason: the design
-- does not depend on knowing the platform's limit.
create table if not exists public.availability_copy_sync (
  id            text primary key,
  cursor_cg     bigint,                     -- caregiver the last run stopped at
  last_run_at   timestamptz,
  last_status   text,
  rows_written  bigint not null default 0
);

insert into public.availability_copy_sync (id, cursor_cg)
values ('availcopy', null)
on conflict (id) do nothing;

notify pgrst, 'reload schema';
