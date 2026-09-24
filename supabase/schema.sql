-- ==============================================================
-- Devoted Care · Scheduler Intelligence — Supabase schema
--
-- Run this ONCE in your Supabase project:
--   Supabase dashboard > SQL Editor > New query > paste > Run
--
-- Safe to re-run: everything is idempotent. Re-running it KEEPS the
-- tables locked (section 11 checks), so it is safe after the PIN gate
-- too. Do not run it before the PIN-gated index.html is live - see
-- CLAUDE.md, "The PIN gate", for the order.
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
-- RLS on, and NO policy for anon or authenticated - on this table and
-- on every other table in this file. The browser does not reach any
-- table with the anon key. Every read and write goes through the
-- app-gate Edge Function (supabase/functions/app-gate), which checks
-- the desk PIN (secret APP_PIN) on EVERY request and then works with
-- the service-role key. See CLAUDE.md, "The PIN gate".
--
-- Until 2026-09-18 this section created anon read/insert/update
-- policies, so anyone who found the site URL could read and overwrite
-- this row with the public key. The drops below are what is left of
-- them: re-running this file keeps the table locked, it does not
-- re-open it.
-- --------------------------------------------------------------
alter table public.scheduler_state enable row level security;

drop policy if exists "anon read scheduler state"   on public.scheduler_state;
drop policy if exists "anon insert scheduler state" on public.scheduler_state;
drop policy if exists "anon update scheduler state" on public.scheduler_state;
-- No anon or authenticated policy - see section 2 and section 11.




-- Nothing deletes the row. CLOUD.reset() ("clear all data") blanks the
-- overlay through app-gate with force:true - the one save app-gate
-- lets write an empty overlay over a full one.


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
-- The dashboard reads these through app-gate (desk PIN), never with
-- the anon key. Only the sync function writes, using the service-role
-- key, which lives in a Netlify environment variable and never
-- reaches a browser.
-- --------------------------------------------------------------
alter table public.care_notes      enable row level security;
alter table public.care_notes_sync enable row level security;

drop policy if exists "anon read care notes" on public.care_notes;
-- No anon or authenticated policy - see section 2 and section 11.

-- The service-role key bypasses RLS, which is what the sync function
-- and app-gate use.


-- --------------------------------------------------------------
-- 4. Anonymous access - revoked 2026-09-18
--
-- This section used to hold the commented-out block for revoking
-- anonymous access "when you are ready to require a login". The PIN
-- gate did that instead (section 11), without per-user logins: the
-- desk shares one PIN, app-gate checks it on every request, and
-- changing APP_PIN locks out every open tab at once.


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
-- The browser reads this table and writes it (through set_availability_days)
-- via app-gate, with the desk PIN - never with the anon key.
alter table public.caregiver_availability enable row level security;

drop policy if exists "anon read availability"   on public.caregiver_availability;
drop policy if exists "anon insert availability" on public.caregiver_availability;
drop policy if exists "anon update availability" on public.caregiver_availability;
drop policy if exists "anon delete availability" on public.caregiver_availability;
-- No anon or authenticated policy - see section 2 and section 11.





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

-- The browser calls this through app-gate and availability-copy calls it with
-- the service role; the anon key has no business with it.
revoke execute on function public.set_availability_days(bigint, date[], jsonb, text) from public, anon, authenticated;
grant  execute on function public.set_availability_days(bigint, date[], jsonb, text) to service_role;

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

-- Read and written through app-gate (desk PIN), like caregiver_availability.
alter table public.caregiver_day_notes enable row level security;

drop policy if exists "anon read day notes"   on public.caregiver_day_notes;
drop policy if exists "anon insert day notes" on public.caregiver_day_notes;
drop policy if exists "anon update day notes" on public.caregiver_day_notes;
drop policy if exists "anon delete day notes" on public.caregiver_day_notes;
-- No anon or authenticated policy - see section 2 and section 11.





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

-- Both are written by matching-sync with the service role and read by the
-- browser through app-gate (desk PIN). No browser code writes either one;
-- the old "anon update matches" policy had no user.
alter table public.client_match_prefs     enable row level security;
alter table public.client_caregiver_match enable row level security;

drop policy if exists "anon read match prefs" on public.client_match_prefs;

drop policy if exists "anon read matches"   on public.client_caregiver_match;
drop policy if exists "anon update matches" on public.client_caregiver_match;
-- No anon or authenticated policy - see section 2 and section 11.

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

-- Only availability-copy (service role) touches this. It had RLS OFF until
-- 2026-09-18, which let the anon key read and rewrite the cursor.
alter table public.availability_copy_sync enable row level security;

notify pgrst, 'reload schema';


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
  shifts_open  int         not null default 0,  -- open in AXISCARE; see above
  -- A full pass costs ~9.6s against a 6s budget, so it ALWAYS spans runs.
  -- These two carry it. Written on every single invocation, so a rebuild that
  -- omitted them made the sync 500 before it scanned anything.
  cursor_chunk int         not null default 0,  -- next chunk index to read
  pass_stamp   timestamptz                      -- the in-flight pass, null when idle
);


-- Added after the table shipped: a resumable pass needs somewhere to keep
-- its place. Safe to re-run.
alter table public.open_shifts_sync add column if not exists cursor_chunk int not null default 0;
alter table public.open_shifts_sync add column if not exists pass_stamp   timestamptz;

insert into public.open_shifts_sync (id) values ('openshifts')
on conflict (id) do nothing;

-- --------------------------------------------------------------
-- 8a. Open-shift security -- the same shape as care_notes.
--
-- The dashboard reads these through app-gate (desk PIN), never with
-- the anon key. Only the sync writes, with SUPABASE_SERVICE_ROLE_KEY,
-- which lives in a Netlify environment variable and never reaches a
-- browser.
-- --------------------------------------------------------------
alter table public.open_shifts      enable row level security;
alter table public.open_shifts_sync enable row level security;

drop policy if exists "anon read open shifts" on public.open_shifts;

drop policy if exists "anon read open shift sync" on public.open_shifts_sync;
-- No anon or authenticated policy - see section 2 and section 11.


notify pgrst, 'reload schema';


-- ==============================================================
-- 9. Communication summaries  ("Summary by Devi", written on demand)
--
-- One or two sentences on top of a call or a day of texts in the
-- Communication Logs dialog. Written by the comms-summary Edge
-- Function the FIRST time somebody opens that conversation, and
-- read back from here on every open after that. Nothing is swept:
-- a conversation nobody opens is never summarised.
--
--   key  call:<quo call id>                        written once
--        text:<quo line id>|<YYYY-MM-DD>|<+1...>   rewritten when
--                                                  the day gains a
--                                                  message
--
-- The phone number is in the text key because the dialog's own
-- entry id is only <line>|<day>, which two caregivers texted on the
-- same line on the same day share.
--
-- source_count / source_last_id are how a text day notices it has
-- grown. model / prompt_version are how a model switch or a prompt
-- change rewrites old summaries on their next open.
-- ==============================================================
create table if not exists public.comm_summaries (
  key            text        primary key,
  kind           text        not null check (kind in ('call','text')),
  phone          text,                      -- the caregiver's E.164 number, when known
  source_count   int         not null,      -- transcript turns for a call, messages for a text day
  source_last_id text,                      -- newest message id on a text day; null for a call
  summary        text        not null check (length(btrim(summary)) > 0),
  model          text        not null,
  prompt_version int         not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- --------------------------------------------------------------
-- 9a. Security -- NO anon access at all, unlike care_notes.
--
-- A summary of a caregiver's phone call is conversation content, and
-- the dashboard has no login. So RLS is on with no policies: the anon
-- key can neither read nor write this table. The browser reaches it
-- only through comms-summary, which reads and writes with
-- SUPABASE_SERVICE_ROLE_KEY and will only summarise a conversation it
-- has read from Quo itself -- so nobody can forge a summary or run up
-- the Anthropic bill with text of their own.
-- --------------------------------------------------------------
alter table public.comm_summaries enable row level security;
revoke all on public.comm_summaries from anon, authenticated;

notify pgrst, 'reload schema';

-- ==============================================================
-- 10. The PIN throttle (app-gate) - also supabase/app-gate.sql
--
-- Safe to re-run: every statement is create-if-not-exists or
-- create-or-replace. This file does NOT touch any anon policy -- the lock
-- is a separate, later step (supabase/app-gate-lock.sql) that must only
-- run once the PIN-gated index.html is live. See CLAUDE.md, "The PIN gate".
--
-- One row per caller IP that has presented a wrong PIN recently.
--
-- WHY IT COUNTS DISTINCT WRONG PINS, NOT WRONG REQUESTS
--
-- The reference design counted every wrong request. On this app that locks
-- the whole desk out: the schedulers share one office IP, and the moment the
-- owner changes APP_PIN every open tab fails several requests at once (the
-- poll, availability, notes, the profile read). Two tabs are past 8 within a
-- second, and then the person typing the NEW PIN is refused for fifteen
-- minutes too. A stale tab repeating the old PIN is not a guess; a
-- brute-forcer has to try different values. So `keys` holds an HMAC of each
-- distinct wrong PIN in the window and `fails` is how many there are. The
-- HMAC is keyed with a server secret, so a stored key says nothing about the
-- PIN it came from.
--
-- WHY THE WHOLE DECISION IS ONE SQL CALL
--
-- An earlier version read the lock first and recorded a failure afterwards,
-- as two calls. A burst of simultaneous guesses then all passed the read
-- before the 8th failure landed, and every one of them had its PIN compared
-- - the limit held for requests in sequence and not at all for a burst.
-- gate_check() takes the IP's row lock, so every verdict for one IP is
-- decided in turn: once 8 distinct wrong PINs are recorded, nothing after
-- them - right PIN or wrong - gets an answer but "locked".
-- ==============================================================
create table if not exists public.auth_throttle (
  ip           text        primary key,
  fails        int         not null default 0,
  first_fail   timestamptz not null default now(),
  locked_until timestamptz,
  keys         text[]      not null default '{}'
);
alter table public.auth_throttle add column if not exists keys text[] not null default '{}';

-- No anon access of any kind. Only app-gate, with the service key.
alter table public.auth_throttle enable row level security;
revoke all on public.auth_throttle from anon, authenticated;
comment on table public.auth_throttle is
  'RLS on with NO policies on purpose: only the service role reaches this. Written by the app-gate edge function to throttle wrong PINs per IP.';

-- The verdict for one request from p_ip.
--   p_key      HMAC of the PIN it carried (hex)
--   p_ok       whether that PIN was right (compared in the function)
--   p_max      distinct wrong PINs allowed per window; the p_max-th locks
--   p_window_s the counting window, in seconds
--   p_lock_s   how long a lock lasts, in seconds
-- Returns verdict 'ok' | 'bad' | 'locked', the distinct wrong PINs in the
-- current window, and the lock expiry when locked.
create or replace function public.gate_check(p_ip text, p_key text, p_ok boolean,
                                             p_max int, p_window_s int, p_lock_s int)
returns table (verdict text, fails int, locked_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  r      public.auth_throttle%rowtype;
  now_ts timestamptz := now();
  stale  boolean;
begin
  -- A right PIN from an IP with no recent failures is the common case (every
  -- poll): one indexed read, no write, no lock held.
  select * into r from public.auth_throttle where ip = p_ip for update;
  if not found and p_ok then
    return query select 'ok'::text, 0, null::timestamptz;
    return;
  end if;
  if not found then
    insert into public.auth_throttle (ip, fails, first_fail, locked_until, keys)
    values (p_ip, 0, now_ts, null, '{}')
    on conflict (ip) do nothing;
    select * into r from public.auth_throttle where ip = p_ip for update;
  end if;

  -- Locked: nobody from this IP gets any other answer, not even a right PIN.
  if r.locked_until is not null and r.locked_until > now_ts then
    return query select 'locked'::text, r.fails, r.locked_until;
    return;
  end if;

  -- The window has passed, or a lock has expired: the count starts again.
  stale := r.locked_until is not null or now_ts - r.first_fail > make_interval(secs => p_window_s);
  if stale then
    r.keys := '{}';
    r.first_fail := now_ts;
    r.locked_until := null;
  end if;

  if p_ok then
    -- Earlier failures are NOT cleared by a right PIN: the desk polls from one
    -- office IP every 20 seconds, so clearing would reset the count for
    -- anybody else on that network three times a minute.
    if stale then
      update public.auth_throttle set fails = 0, first_fail = r.first_fail, locked_until = null, keys = '{}'
       where ip = p_ip;
    end if;
    return query select 'ok'::text, coalesce(array_length(r.keys, 1), 0), null::timestamptz;
    return;
  end if;

  if not (p_key = any (r.keys)) then
    r.keys := r.keys || p_key;
  end if;
  r.fails := coalesce(array_length(r.keys, 1), 0);
  if r.fails >= p_max then
    r.locked_until := now_ts + make_interval(secs => p_lock_s);
  end if;
  update public.auth_throttle
     set fails = r.fails, first_fail = r.first_fail, locked_until = r.locked_until, keys = r.keys
   where ip = p_ip;
  return query select 'bad'::text, r.fails, r.locked_until;
end
$$;

-- SECURITY DEFINER, so nobody but the service role may call it.
revoke all on function public.gate_check(text, text, boolean, int, int, int) from public, anon, authenticated;
grant execute on function public.gate_check(text, text, boolean, int, int, int) to service_role;

-- Replaced by gate_check (it recorded a failure after a separate lock read,
-- which a burst could outrun). Nothing else ever called it.
drop function if exists public.gate_fail(text, text, int, int, int);

notify pgrst, 'reload schema';


-- ==============================================================
-- 10b. Care note summaries  (the Care Notes day review, written on demand)
--
-- LETTERED, not numbered: this block has to sit BEFORE the lock so the
-- lock's "RLS on everywhere, no anon policy" assertion covers it, and
-- eleven comments in this file, README.md and CLAUDE.md already point at
-- "section 11" meaning THE LOCK. Renumbering the lock to make room would
-- have silently invalidated every one of them.
--
-- The "Yesterday's Summary" section of the Care Notes page shows one
-- AM and one PM block per client. It used to print the caregiver's
-- raw AxisCare note there, which is what a summary section is not.
-- This holds the summarised version.
--
-- One row per CLIENT x DATE x SHIFT:
--
--   key   <YYYY-MM-DD>|<axiscare client id>|<am|pm>
--
-- Written by the carenotes-summary Edge Function the FIRST time
-- anybody opens that date, and read back from here on every open
-- after that, by anybody. A date nobody opens is never summarised
-- and costs nothing. Nothing is swept.
--
-- ONE MODEL CALL COVERS A WHOLE DATE, not one per row. Measured on
-- the live mirror 2026-09-23: a date is 18.9 notes over 13.3 clients
-- on average and 23 over 17 at its worst, which is ~3,400 input
-- tokens and ~5,000 at the worst -- comfortably one request. Asking
-- per client-shift would be ~26 requests for the same content and
-- would lose the one thing a whole-date pass can see, which is the
-- same client's AM and PM read together.
--
-- source_sig is how a row notices the note it describes has changed.
-- A caregiver can still be correcting a note for today and yesterday
-- (carenotes-sync re-reads FRESH_DAYS = 2), so the signature covers
-- the visit ids AND the note text of every note behind the row. Past
-- dates settle and are written once.
--
-- model / prompt_version are how a model switch or a prompt change
-- rewrites old summaries on their next open. Same rule as
-- comm_summaries (section 9).
-- ==============================================================
create table if not exists public.care_note_summaries (
  key            text        primary key,   -- <day>|<client_id>|<shift>
  day            date        not null,
  client_id      bigint      not null,
  shift          text        not null check (shift in ('am','pm')),
  summary        text        not null check (length(btrim(summary)) > 0),
  source_sig     text        not null,      -- fingerprint of the notes behind this row
  source_count   int         not null,      -- how many notes that was
  model          text        not null,
  prompt_version int         not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.care_note_summaries is
  'AI summaries of AxisCare care notes, one row per client per date per AM/PM shift. Written on demand by the carenotes-summary Edge Function; care_notes stays the source of truth.';

-- The only query the function makes: every row for one date.
create index if not exists care_note_summaries_day_idx
  on public.care_note_summaries (day);

-- --------------------------------------------------------------
-- 10c. Security -- NO anon access at all, the same as comm_summaries.
--
-- These summarise clinical shift documentation, and the dashboard has
-- one shared desk PIN rather than per-person logins. So RLS is on with
-- no policies: the anon key can neither read nor write this table.
--
-- The browser reaches it only through carenotes-summary, which reads
-- and writes with SUPABASE_SERVICE_ROLE_KEY and will only summarise
-- notes it has read from care_notes ITSELF. The browser sends a date
-- and nothing else -- so nobody with the site URL can save an invented
-- summary or spend the Anthropic key on text of their own.
-- --------------------------------------------------------------
alter table public.care_note_summaries enable row level security;
revoke all on public.care_note_summaries from anon, authenticated;


-- ==============================================================
-- 10d. Care alert summaries  ("Clients Needing Attention", written on demand)
--
-- "Clients Needing Attention" used to print the caregiver's raw AxisCare
-- note (cleaned, then cut at 150 characters with "...") under a heading
-- that says a scheduler should understand what happened without opening
-- anything. That is not what a flagged note looks like once read: most
-- of it is the routine shift (meals, vitals, chit-chat) and the actual
-- issue is a sentence or two inside it. This holds the extracted
-- version -- what happened, and what the scheduler needs to do about
-- it -- for the SPECIFIC issue that flagged the client, nothing else.
--
-- One row per NOTE x CATEGORY:
--
--   id   <care_notes.visit_id>__<CARE_CATEGORIES key, e.g. falls>
--
-- the same id careConcernRowHtml()/buildCareAlerts() already use in
-- index.html for the tracked alert (assign/status/actions), so a row
-- here lines up with an alert one-to-one.
--
-- WHICH note+category to extract is named by the browser (it already
-- runs the keyword categoriser in categorizeNote()/CARE_CATEGORIES and
-- knows which client is flagged and why) -- the same shape as
-- care-brief, which is told WHICH client and reads that client's own
-- record itself. The browser can only point at a real row in
-- care_notes; it cannot hand the function invented text, and the
-- function reads the note's own words with the service key. See the
-- long comment at the top of carealerts-summary/index.ts.
-- ==============================================================
create table if not exists public.care_alert_summaries (
  id               text        primary key,   -- <visit_id>__<cat_key>
  note_id          text        not null,      -- care_notes.visit_id
  cat_key          text        not null,      -- a CARE_CATEGORIES key, e.g. 'falls'
  client_id        bigint,
  what_happened    text[]      not null check (array_length(what_happened, 1) between 1 and 3),
  scheduler_action text[]      not null check (array_length(scheduler_action, 1) between 1 and 2),
  source_sig       text        not null,      -- fingerprint of the note behind this row
  model            text        not null,
  prompt_version   int         not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.care_alert_summaries is
  'AI-extracted "what happened / what the scheduler needs to do" for a single flagged care note, one row per note x category. Written on demand by the carealerts-summary Edge Function; care_notes stays the source of truth.';

-- Security -- NO anon access at all, the same as care_note_summaries.
alter table public.care_alert_summaries enable row level security;
revoke all on public.care_alert_summaries from anon, authenticated;


-- ==============================================================
-- 10e. Caregiver "About" summaries  (written on demand)
--
-- The caregiver profile's "About [Name]" section used to be one computed
-- sentence. This holds the AI-generated replacement: a structured judgement
-- read from everything on file about one caregiver. ONE ROW PER CAREGIVER,
-- keyed by caregiver id, overwritten on every regeneration.
--
-- Unlike the sibling summary functions, caregiver-about-summary does NOT
-- read its own source data: assignment history comes from AxisCare visits
-- the browser fetches through the Netlify proxy, unreachable from Supabase.
-- The browser assembles the whole dossier and sends it -- the same
-- trade-off devi-agent already makes for the whole board. source_sig is
-- still computed SERVER-SIDE from the dossier text the request carries,
-- never trusted from the caller. See
-- supabase/functions/caregiver-about-summary/index.ts.
-- ==============================================================
create table if not exists public.caregiver_about_summaries (
  id             text        primary key,   -- caregiver id
  sections       jsonb       not null,      -- {overall, strongestExperience[], bestFit[], schedulingConsiderations[], reliability[], importantHistory[]}
  source_sig     text        not null,      -- fingerprint of the dossier text behind this row
  model          text        not null,
  prompt_version int         not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.caregiver_about_summaries is
  'AI-generated "About [Name]" caregiver summary, one row per caregiver, overwritten on regeneration. Written on demand by the caregiver-about-summary Edge Function.';

-- Security -- NO anon access at all, the same as the sibling summary tables.
alter table public.caregiver_about_summaries enable row level security;
revoke all on public.caregiver_about_summaries from anon, authenticated;


-- ==============================================================
-- 11. The lock - no table is reachable with the anon key
--
-- The same statements as supabase/app-gate-lock.sql, kept here so a
-- re-run of this file can never leave a table open. The check at the
-- end FAILS THE RUN if any anon/authenticated policy survives, or any
-- table has RLS off - a loud error, not a silently re-opened table.
-- ==============================================================
revoke execute on function public.prune_caregiver_availability() from public, anon, authenticated;
grant  execute on function public.prune_caregiver_availability() to service_role;

-- Caregiver photos: uploads and removals go through app-gate. The bucket
-- stays PUBLIC, so <img> reads of /object/public/... keep working - the
-- public route does not consult these policies.
drop policy if exists "anon read caregiver photos"   on storage.objects;
drop policy if exists "anon upload caregiver photos" on storage.objects;
drop policy if exists "anon update caregiver photos" on storage.objects;
drop policy if exists "anon delete caregiver photos" on storage.objects;

do $$
declare n int;
begin
  select count(*) into n from pg_policies
   where (schemaname = 'public' or (schemaname = 'storage' and tablename = 'objects'))
     and roles && array['anon','authenticated','public']::name[];
  if n <> 0 then
    raise exception 'schema.sql: % anon/authenticated/public policies exist - the PIN gate expects none', n;
  end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if n <> 0 then
    raise exception 'schema.sql: % public tables have RLS off', n;
  end if;
end $$;

notify pgrst, 'reload schema';
