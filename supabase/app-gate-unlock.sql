-- ==============================================================
-- app-gate · UNDO THE LOCK. Puts back exactly the anon policies that
-- supabase/app-gate-lock.sql removed, as they stood on 2026-09-18 (generated
-- from the pre-change backup, policies.json), and the function grants.
--
-- This RE-OPENS every table to anyone holding the public anon key. Use it
-- only to roll back to a build that still calls /rest/v1 directly.
-- availability_copy_sync is deliberately left with RLS ON: it was off by
-- mistake, nothing but the service role uses it, and turning it back off
-- would only re-open a hole.
-- ==============================================================
begin;
drop policy if exists "anon read care notes" on public.care_notes;
create policy "anon read care notes" on public.care_notes as permissive for select to anon, authenticated using (true);
drop policy if exists "anon delete availability" on public.caregiver_availability;
create policy "anon delete availability" on public.caregiver_availability as permissive for delete to anon, authenticated using (true);
drop policy if exists "anon insert availability" on public.caregiver_availability;
create policy "anon insert availability" on public.caregiver_availability as permissive for insert to anon, authenticated with check (true);
drop policy if exists "anon read availability" on public.caregiver_availability;
create policy "anon read availability" on public.caregiver_availability as permissive for select to anon, authenticated using (true);
drop policy if exists "anon update availability" on public.caregiver_availability;
create policy "anon update availability" on public.caregiver_availability as permissive for update to anon, authenticated using (true) with check (true);
drop policy if exists "anon delete day notes" on public.caregiver_day_notes;
create policy "anon delete day notes" on public.caregiver_day_notes as permissive for delete to anon, authenticated using (true);
drop policy if exists "anon insert day notes" on public.caregiver_day_notes;
create policy "anon insert day notes" on public.caregiver_day_notes as permissive for insert to anon, authenticated with check (true);
drop policy if exists "anon read day notes" on public.caregiver_day_notes;
create policy "anon read day notes" on public.caregiver_day_notes as permissive for select to anon, authenticated using (true);
drop policy if exists "anon update day notes" on public.caregiver_day_notes;
create policy "anon update day notes" on public.caregiver_day_notes as permissive for update to anon, authenticated using (true) with check (true);
drop policy if exists "anon delete profile" on public.caregiver_profile;
create policy "anon delete profile" on public.caregiver_profile as permissive for delete to anon, authenticated using (true);
drop policy if exists "anon insert profile" on public.caregiver_profile;
create policy "anon insert profile" on public.caregiver_profile as permissive for insert to anon, authenticated with check (true);
drop policy if exists "anon read profile" on public.caregiver_profile;
create policy "anon read profile" on public.caregiver_profile as permissive for select to anon, authenticated using (true);
drop policy if exists "anon update profile" on public.caregiver_profile;
create policy "anon update profile" on public.caregiver_profile as permissive for update to anon, authenticated using (true) with check (true);
drop policy if exists "anon read matches" on public.client_caregiver_match;
create policy "anon read matches" on public.client_caregiver_match as permissive for select to anon, authenticated using (true);
drop policy if exists "anon update matches" on public.client_caregiver_match;
create policy "anon update matches" on public.client_caregiver_match as permissive for update to anon, authenticated using (true) with check (true);
drop policy if exists "anon read match prefs" on public.client_match_prefs;
create policy "anon read match prefs" on public.client_match_prefs as permissive for select to anon, authenticated using (true);
drop policy if exists "anon read open shifts" on public.open_shifts;
create policy "anon read open shifts" on public.open_shifts as permissive for select to anon, authenticated using (true);
drop policy if exists "anon read open shift sync" on public.open_shifts_sync;
create policy "anon read open shift sync" on public.open_shifts_sync as permissive for select to anon, authenticated using (true);
drop policy if exists "anon insert scheduler state" on public.scheduler_state;
create policy "anon insert scheduler state" on public.scheduler_state as permissive for insert to anon, authenticated with check (true);
drop policy if exists "anon read scheduler state" on public.scheduler_state;
create policy "anon read scheduler state" on public.scheduler_state as permissive for select to anon, authenticated using (true);
drop policy if exists "anon update scheduler state" on public.scheduler_state;
create policy "anon update scheduler state" on public.scheduler_state as permissive for update to anon, authenticated using (true) with check (true);
drop policy if exists "anon delete caregiver photos" on storage.objects;
create policy "anon delete caregiver photos" on storage.objects as permissive for delete to anon using ((bucket_id = 'caregiver-photos'::text));
drop policy if exists "anon read caregiver photos" on storage.objects;
create policy "anon read caregiver photos" on storage.objects as permissive for select to anon using ((bucket_id = 'caregiver-photos'::text));
drop policy if exists "anon update caregiver photos" on storage.objects;
create policy "anon update caregiver photos" on storage.objects as permissive for update to anon using ((bucket_id = 'caregiver-photos'::text)) with check ((bucket_id = 'caregiver-photos'::text));
drop policy if exists "anon upload caregiver photos" on storage.objects;
create policy "anon upload caregiver photos" on storage.objects as permissive for insert to anon with check ((bucket_id = 'caregiver-photos'::text));
grant execute on function public.prune_caregiver_availability() to public, anon, authenticated;
grant execute on function public.set_availability_days(bigint, date[], jsonb, text) to public, anon, authenticated;
commit;
notify pgrst, 'reload schema';
