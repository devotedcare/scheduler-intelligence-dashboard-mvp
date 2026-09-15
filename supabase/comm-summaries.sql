-- Section 9 of supabase/schema.sql, extracted so it can be run on its own.
-- Safe to re-run: every statement is create-if-not-exists.

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
