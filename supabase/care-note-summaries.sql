-- Section 10b of supabase/schema.sql, extracted so it can be run on its own.
-- Safe to re-run: every statement is create-if-not-exists.

-- ==============================================================
-- 10b. Care note summaries  (the Care Notes day review, written on demand)
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

notify pgrst, 'reload schema';
