/* ---------------------------------------------------------------
   Runtime configuration for Scheduler Intelligence.

   This file is REGENERATED on every Netlify deploy by
   scripts/build-config.js, using the environment variables you set
   in Netlify. The copy committed to git is intentionally empty.

   With empty values the app still runs perfectly - it just saves to
   the current browser only, and the status pill reads "Local".

   About the anon key: it is a PUBLIC key and is meant to live in the
   browser. It opens nothing on its own: every table has RLS on with no
   anon policy, and the page reaches its data only through the app-gate
   Edge Function, which checks the desk PIN on every request. The key
   only gets those requests past the Supabase gateway.

   To point a local copy at Supabase without a build, just fill these
   in - but do not commit real values if the repo is ever made public.
   --------------------------------------------------------------- */
window.SCHEDULER_CONFIG = {
  supabaseUrl:     '',
  supabaseAnonKey: '',

  // One shared row = one shared workspace. Change this to run a
  // second, isolated copy (e.g. 'devoted_care_training') off the
  // same Supabase project - and add the same name to APP_WORKSPACES
  // on the app-gate function, which refuses any workspace not listed.
  workspace:       'devoted_care',
  // Leave as is: app-gate only reaches scheduler_state and refuses
  // any other table name.
  table:           'scheduler_state',

  // How often to check for changes made by another scheduler (ms).
  pollMs:          20000
};
