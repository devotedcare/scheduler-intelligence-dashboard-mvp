-- Section 10d of supabase/schema.sql, extracted so it can be run on its own.
-- Safe to re-run: every statement is create-if-not-exists.

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
--   id   cn<visit_id, non-alphanumerics -> _>__<CARE_CATEGORIES key, e.g. falls>
--
-- NOTE: that is index.html's MUNGED note id, not the raw AxisCare visit_id --
-- fetchCareNotes() keeps no copy of the real one, so the browser can only ever
-- name a note by the munged form, and this key has to match what it looks up.
-- The real visit_id is in note_id.
--
-- the same id careConcernRowHtml()/buildCareAlerts() already use in
-- index.html for the tracked alert (assign/status/actions), so a row
-- here lines up with an alert one-to-one.
--
-- Written by the carealerts-summary Edge Function the first time
-- anybody opens Care Notes Review with that note flagged, and read
-- back from here on every later open, by anybody. A note nobody's
-- browser ever flags is never sent to the model and costs nothing.
--
-- WHICH note+category to extract is named by the browser (it already
-- runs the keyword categoriser in categorizeNote()/CARE_CATEGORIES and
-- knows which client is flagged and why) -- the same shape as
-- care-brief, which is told WHICH client and reads that client's own
-- record itself. The browser can only point at a real row in
-- care_notes; it cannot hand the function invented text, and the
-- function reads the note's own words with the service key. See the
-- long comment at the top of carealerts-summary/index.ts.
--
-- source_sig fingerprints the visit_id and the note text behind the
-- row, so a caregiver correcting a note (carenotes-sync re-reads
-- FRESH_DAYS = 2) rewrites the row on its next open.
--
-- model / prompt_version are how a model switch or a prompt change
-- rewrites old rows on their next open. Same rule as
-- comm_summaries (section 9) and care_note_summaries (section 10b).
-- ==============================================================
create table if not exists public.care_alert_summaries (
  id               text        primary key,   -- cn<munged visit_id>__<cat_key>, see above
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

-- The only query the function makes: an exact set of ids handed to it
-- by the browser, so the primary key already serves every read.

-- --------------------------------------------------------------
-- Security -- NO anon access at all, the same as care_note_summaries.
--
-- This describes a specific clinical incident, and the dashboard has
-- one shared desk PIN rather than per-person logins. RLS is on with no
-- policies: the anon key can neither read nor write this table.
--
-- The browser reaches it only through carealerts-summary, which reads
-- and writes with SUPABASE_SERVICE_ROLE_KEY and will only extract from
-- a note it has read from care_notes ITSELF, by an id the browser
-- named. The browser cannot post note text or a summary of its own.
-- --------------------------------------------------------------
alter table public.care_alert_summaries enable row level security;
revoke all on public.care_alert_summaries from anon, authenticated;

notify pgrst, 'reload schema';
