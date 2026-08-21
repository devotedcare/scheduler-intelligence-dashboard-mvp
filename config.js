/* ---------------------------------------------------------------
   Runtime configuration for Scheduler Intelligence.

   This file is REGENERATED on every Netlify deploy by
   scripts/build-config.js, using the environment variables you set
   in Netlify. The copy committed to git is intentionally empty.

   With empty values the app still runs perfectly - it just saves to
   the current browser only, and the status pill reads "Local".

   About the anon key: it is a PUBLIC key and is meant to live in the
   browser. What protects the data is the row-level security policy in
   supabase/schema.sql, not the secrecy of this key.

   To point a local copy at Supabase without a build, just fill these
   in - but do not commit real values if the repo is ever made public.
   --------------------------------------------------------------- */
window.SCHEDULER_CONFIG = {
  supabaseUrl:     '',
  supabaseAnonKey: '',

  // One shared row = one shared workspace. Change this to run a
  // second, isolated copy (e.g. 'devoted_care_training') off the
  // same Supabase project.
  workspace:       'devoted_care',
  table:           'scheduler_state',

  // How often to check for changes made by another scheduler (ms).
  pollMs:          20000
};
