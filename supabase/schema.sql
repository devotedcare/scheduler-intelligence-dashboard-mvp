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
-- down policies in section 3.
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
-- 3. When you are ready to require a login
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
-- 4. Handy checks
-- --------------------------------------------------------------
-- Confirm RLS is on and see the active policies:
--   select relname, relrowsecurity from pg_class where relname = 'scheduler_state';
--   select policyname, cmd, roles from pg_policies where tablename = 'scheduler_state';
--
-- See the current save:
--   select id, rev, updated_by, updated_at,
--          pg_size_pretty(length(overlay::text)::bigint) as overlay_size
--     from public.scheduler_state;
