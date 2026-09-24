-- Section 10e of supabase/schema.sql, extracted so it can be run on its own.
-- Safe to re-run: every statement is create-if-not-exists.

-- ==============================================================
-- 10e. Caregiver "About" summaries  (written on demand)
--
-- The caregiver profile's "About [Name]" section used to be one computed
-- sentence built from three or four fields. This holds the AI-generated
-- replacement: a structured judgement read from everything on file about
-- one caregiver -- profile, skills, assignment history, care notes,
-- feedback, complaints, incidents, attendance, shift declines,
-- availability, work preferences, driving, and ratings.
--
-- ONE ROW PER CAREGIVER, keyed by the caregiver's id, overwritten on every
-- regeneration -- unlike care_note_summaries / care_alert_summaries (one
-- row per note/block), there is exactly one current "About" per caregiver.
--
-- WHO ASSEMBLES THE INPUT. Unlike the sibling summary functions, the
-- caregiver-about-summary Edge Function does NOT read its own source data
-- for the dossier it summarises: assignment history comes from AxisCare
-- visits, fetched by the browser through the Netlify proxy, which a
-- Supabase function cannot reach at all. The browser assembles the whole
-- dossier (cgAiDigestText() in index.html) and sends it -- the same
-- accepted trade-off devi-agent already makes for the whole scheduling
-- board. See the long comment at the top of
-- supabase/functions/caregiver-about-summary/index.ts.
--
-- source_sig is computed SERVER-SIDE from the dossier text the request
-- actually carries, never trusted from the caller -- so the cache is
-- trustworthy even though the CONTENT is browser-assembled: two requests
-- with a byte-identical dossier always hash the same.
--
-- model / prompt_version are how a model switch or a prompt change
-- rewrites an old summary on its next open. Same rule as
-- comm_summaries / care_note_summaries / care_alert_summaries.
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

-- The only query the function makes: one row by id -- the primary key
-- already serves it.

-- --------------------------------------------------------------
-- Security -- NO anon access at all, the same as the sibling summary
-- tables. RLS is on with no policies: the anon key can neither read nor
-- write this table. The browser reaches it only through
-- caregiver-about-summary, which reads and writes with
-- SUPABASE_SERVICE_ROLE_KEY.
-- --------------------------------------------------------------
alter table public.caregiver_about_summaries enable row level security;
revoke all on public.caregiver_about_summaries from anon, authenticated;

notify pgrst, 'reload schema';
