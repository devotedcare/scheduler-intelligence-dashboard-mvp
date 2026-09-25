-- ==============================================================
-- care_alert_triage  —  "this date has been reasoned over already"
--
-- WHY THIS EXISTS
--
-- "Clients Needing Attention" was gated by a keyword screen. categorizeNote()
-- in index.html decides which notes are flagged, and carealerts-summary is
-- handed ONLY those — so the model never saw anything the word list missed.
-- Measured on the live mirror, 2026-09-25: of 747 care notes, 90 fire a
-- keyword and 657 (88%) fire nothing. A note like
--
--   "She has a lot of pain in her ankle and leg! Her ankle is swollen,
--    I applied pain cream!"
--
-- raised nothing and was never read by anything. CLAUDE.md already records
-- that a PAIN category was measured and REJECTED (41 fires, 5 real) because a
-- word list cannot separate new pain from four clients' chronic managed pain.
-- That distinction is a judgement, which is what the triage pass is for.
--
-- So the function now also reads the WHOLE day and reasons about every note,
-- keeping the keyword screen as a floor rather than a gate.
--
-- WHAT THIS TABLE IS FOR, and why it is not a column on care_alert_summaries
--
-- The triage pass must run ONCE per date, not once per page open — the same
-- "written once, read back forever" rule the rest of this screen follows. The
-- alerts it finds are saved in care_alert_summaries and read back from there,
-- but a date where the pass found NOTHING leaves no row at all, and without a
-- marker every open would pay for the model again. One row per date, written
-- whether or not anything was found, is the whole point.
--
-- model and prompt_version are here for the same reason they are on
-- care_alert_summaries: a model switch or a prompt change re-triages the date,
-- and nothing else does.
--
-- RLS is ON with NO POLICIES — the anon key can neither read nor write it. The
-- Edge Function uses the service-role key, and nothing in the browser touches
-- this table directly. Same posture as care_alert_summaries.
--
-- Safe to re-run: every statement is create-if-not-exists.
-- ==============================================================

create table if not exists public.care_alert_triage (
  day            date        primary key,
  model          text        not null,      -- which model reasoned over it
  prompt_version int         not null,      -- the triage prompt in force
  notes_seen     int         not null default 0,   -- how many notes it read
  found          int         not null default 0,   -- how many alerts it raised
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.care_alert_triage enable row level security;

-- The day-scoped read back of care_alert_summaries is by note_id (the real
-- AxisCare visit_id), because that table has no day column and does not need
-- one — the function already knows every visit_id for the date it is holding.
create index if not exists care_alert_summaries_note_id_idx
  on public.care_alert_summaries (note_id);


-- Provenance, added 2026-09-25 with the triage pass. 'keyword' means the browser's
-- categorizeNote() screen named this note+category; 'triage' means the model found it
-- reading the whole date. The day-scoped read back only returns 'triage' rows, so a
-- leftover keyword row under a category the browser no longer flags can never be drawn
-- as though the triage pass had raised it.
alter table public.care_alert_summaries
  add column if not exists found_by text not null default 'keyword';
create index if not exists care_alert_summaries_found_by_idx
  on public.care_alert_summaries (found_by);
