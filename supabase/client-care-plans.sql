-- ==============================================================
-- client_care_plans  —  the Care Plan Agent's output, one row per client
--
-- Mitch's spec, 2026-09-25: a living care plan per active client, maintained
-- rather than regenerated, that tells a caregiver what they need to know to
-- care for this client TODAY. Two outputs: the plan itself, and a separate
-- list of things that genuinely need office review.
--
-- ── WHY THIS TABLE IS A DEPARTURE, STATED PLAINLY ───────────────────────────
--
-- care-brief's header says: "The raw clinical record never crosses into the
-- browser and is never stored in the Scheduling database." That rule was
-- written for a function whose whole output is ONE SENTENCE in an outbound
-- text, and it is the right rule for that.
--
-- A care plan cannot work that way. It has to persist to be a living
-- document, and it has to reach the browser to be read by the desk. So this
-- table stores clinical content derived from Concierge, which nothing in this
-- project did before. Three things keep that as narrow as it can be:
--
--   1. RLS is ON with NO POLICIES. The anon key in config.js can neither read
--      nor write it. Only the care-plan Edge Function, on the service key,
--      touches it -- the same posture as care_alert_summaries and
--      comm_summaries.
--   2. The SAME field whitelist care-brief uses. medManage, medInstr,
--      routineAM, routinePM, routineDay, feeding and `other` are never read,
--      because every one of them holds drug names on this account. The plan
--      therefore does NOT state who administers a medication -- see the note
--      in the function header, because Mitch's spec does ask for that and
--      opening those fields is Carlo's call, not a code change.
--   3. Every field read is filtered by care-brief's medication detector,
--      per sentence, and the model's output is filtered again.
--
-- The dashboard has no per-person login -- one shared desk PIN -- so anybody
-- who can open the site can read any plan. That was already true of care
-- notes and their summaries; it is worth knowing that it is now true of the
-- care plan too.
--
-- ── SHAPE ───────────────────────────────────────────────────────────────────
--
-- One row per client, keyed by the AxisCare numeric id (the same id the rest
-- of this app keys clients by). The plan is regenerated only when its inputs
-- change: source_sig fingerprints the Concierge record AND the care notes it
-- was built from, so a new note that says nothing new costs nothing, and
-- model / prompt_version rewrite it the way they do everywhere else here.
--
-- Safe to re-run: every statement is create-if-not-exists.
-- ==============================================================

create table if not exists public.client_care_plans (
  client_id      bigint      primary key,          -- AxisCare numeric client id
  client_name    text,                             -- for a readable row; the app resolves names itself
  sections       jsonb       not null,             -- [{title, items:[string]}] -- the caregiver-ready plan
  attention      jsonb       not null default '[]'::jsonb,
                                                   -- [{issue, found, whyItMatters, action, source}]
  skipped        text[]      not null default '{}',-- what the medication filter held back, so a thin
                                                   -- plan can be explained rather than wondered about
  notes_seen     int         not null default 0,   -- how many care notes it reasoned over
  source_sig     text        not null,             -- Concierge record + the notes behind this plan
  model          text        not null,
  prompt_version int         not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.client_care_plans enable row level security;
-- deliberately NO policies: service-role only, through the care-plan function
