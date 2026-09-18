-- ==============================================================
-- app-gate · THE LOCK.  Drops every anon/authenticated policy, so the
-- browser can no longer reach a single table with the public anon key.
--
-- >>> RUN THIS ONLY AFTER THE PIN-GATED index.html IS LIVE <<<
--
-- The moment it runs, any build still calling /rest/v1 directly stops
-- working for everyone. Deploy first, lock second. Always. Check that the
-- live site serves the new build (view-source has `var GATE = (function`)
-- before running a single line of this.
--
-- After it: every read and write goes through the app-gate Edge Function,
-- which checks APP_PIN on every request and then works with the service
-- role key. The Netlify sync jobs and comms-summary already use the
-- service role and are unaffected (confirmed in code and in the API logs,
-- 2026-09-18).
--
-- Reverse with supabase/app-gate-unlock.sql.
--
-- RESTORING A DATABASE BACKUP ROLLS THIS BACK TOO. If one is ever
-- restored, re-run this file and re-check with the query at the end.
-- ==============================================================
begin;

-- --- the shared scheduler row ------------------------------------------
drop policy if exists "anon read scheduler state"   on public.scheduler_state;
drop policy if exists "anon insert scheduler state" on public.scheduler_state;
drop policy if exists "anon update scheduler state" on public.scheduler_state;

-- --- availability, day notes, profiles ---------------------------------
drop policy if exists "anon read availability"   on public.caregiver_availability;
drop policy if exists "anon insert availability" on public.caregiver_availability;
drop policy if exists "anon update availability" on public.caregiver_availability;
drop policy if exists "anon delete availability" on public.caregiver_availability;

drop policy if exists "anon read day notes"   on public.caregiver_day_notes;
drop policy if exists "anon insert day notes" on public.caregiver_day_notes;
drop policy if exists "anon update day notes" on public.caregiver_day_notes;
drop policy if exists "anon delete day notes" on public.caregiver_day_notes;

drop policy if exists "anon read profile"   on public.caregiver_profile;
drop policy if exists "anon insert profile" on public.caregiver_profile;
drop policy if exists "anon update profile" on public.caregiver_profile;
drop policy if exists "anon delete profile" on public.caregiver_profile;

-- --- the read-only mirrors ---------------------------------------------
drop policy if exists "anon read care notes"      on public.care_notes;
drop policy if exists "anon read open shifts"     on public.open_shifts;
drop policy if exists "anon read open shift sync" on public.open_shifts_sync;
drop policy if exists "anon read match prefs"     on public.client_match_prefs;
drop policy if exists "anon read matches"         on public.client_caregiver_match;
-- No browser code ever wrote this table; matching-sync writes it with the
-- service role. The policy let anyone with the anon key rewrite matches.
drop policy if exists "anon update matches"       on public.client_caregiver_match;

-- --- the one table that never had RLS ----------------------------------
-- availability_copy_sync is the cursor of the hourly availability-copy
-- job (service role). With RLS OFF the anon key could read and rewrite it.
alter table public.availability_copy_sync enable row level security;

-- --- functions the anon key could call ---------------------------------
-- prune_caregiver_availability is SECURITY DEFINER: anyone with the anon
-- key could delete every availability row older than last month. Nothing
-- calls it (the pg_cron schedule for it is only a comment).
revoke execute on function public.prune_caregiver_availability() from public, anon, authenticated;
grant  execute on function public.prune_caregiver_availability() to service_role;
-- set_availability_days is SECURITY INVOKER, so with no policies it could
-- do nothing for anon anyway; revoked so the intent is explicit. The
-- browser reaches it through app-gate, and availability-copy with the
-- service role.
revoke execute on function public.set_availability_days(bigint, date[], jsonb, text) from public, anon, authenticated;
grant  execute on function public.set_availability_days(bigint, date[], jsonb, text) to service_role;

-- --- caregiver photos --------------------------------------------------
-- Uploads and removals now go through app-gate (photo.put / photo.del).
-- The bucket stays PUBLIC, so <img> reads of
-- /storage/v1/object/public/caregiver-photos/<id> keep working: the public
-- route does not consult these policies at all. Listing the bucket, and
-- writing to it, stop.
drop policy if exists "anon read caregiver photos"   on storage.objects;
drop policy if exists "anon upload caregiver photos" on storage.objects;
drop policy if exists "anon update caregiver photos" on storage.objects;
drop policy if exists "anon delete caregiver photos" on storage.objects;

-- --- say so on every table ---------------------------------------------
comment on table public.scheduler_state is
  'RLS on with NO policies on purpose: only the service role reaches this. Every read and write goes through the app-gate edge function, which checks APP_PIN first.';
comment on table public.caregiver_availability is
  'RLS on with NO policies on purpose: the browser reaches this only through the app-gate edge function (APP_PIN). availability-copy writes with the service role.';
comment on table public.caregiver_day_notes is
  'RLS on with NO policies on purpose: the browser reaches this only through the app-gate edge function (APP_PIN).';
comment on table public.caregiver_profile is
  'RLS on with NO policies on purpose: the browser reaches this only through the app-gate edge function (APP_PIN), which lets it write employment_status and nothing else.';
comment on table public.care_notes is
  'RLS on with NO policies on purpose: carenotes-sync writes with the service role; the browser reads only through the app-gate edge function (APP_PIN).';
comment on table public.open_shifts is
  'RLS on with NO policies on purpose: openshifts-sync writes with the service role; the browser reads only through the app-gate edge function (APP_PIN).';
comment on table public.open_shifts_sync is
  'RLS on with NO policies on purpose: openshifts-sync reads and writes with the service role; the browser reads only through the app-gate edge function (APP_PIN).';
comment on table public.client_match_prefs is
  'RLS on with NO policies on purpose: matching-sync writes with the service role; the browser reads only through the app-gate edge function (APP_PIN).';
comment on table public.client_caregiver_match is
  'RLS on with NO policies on purpose: matching-sync writes with the service role; the browser reads only through the app-gate edge function (APP_PIN).';
comment on table public.availability_copy_sync is
  'RLS on with NO policies on purpose: the cursor of the availability-copy job, which uses the service role. Nothing else reads it.';

-- --- refuse to commit a half-locked database ---------------------------
do $$
declare n int;
begin
  select count(*) into n from pg_policies
   where (schemaname = 'public' or (schemaname = 'storage' and tablename = 'objects'))
     and roles && array['anon','authenticated','public']::name[];
  if n <> 0 then
    raise exception 'app-gate lock: % anon/authenticated/public policies remain - rolled back', n;
  end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if n <> 0 then
    raise exception 'app-gate lock: % public tables still have RLS off - rolled back', n;
  end if;
end $$;

commit;

notify pgrst, 'reload schema';

-- Check (should return no rows):
--   select schemaname, tablename, policyname, roles from pg_policies
--    where roles && array['anon','authenticated','public']::name[];
