#!/usr/bin/env node
/* ---------------------------------------------------------------
   Writes config.js from environment variables at deploy time.

   Netlify runs this via the `command` in netlify.toml. It has no
   dependencies and never fails the build — a missing key just means
   the site deploys in local-only mode, which is a working state.
   --------------------------------------------------------------- */
'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'config.js');

const cfg = {
  supabaseUrl:     (process.env.SUPABASE_URL     || '').trim(),
  supabaseAnonKey: (process.env.SUPABASE_ANON_KEY || '').trim(),
  workspace:       (process.env.SCHEDULER_WORKSPACE || 'devoted_care').trim(),
  table:           (process.env.SCHEDULER_TABLE     || 'scheduler_state').trim(),
  pollMs:          Number(process.env.SCHEDULER_POLL_MS || 20000)
};

if (!Number.isFinite(cfg.pollMs) || cfg.pollMs < 8000) cfg.pollMs = 20000;

/* Catch the two mistakes people actually make. */
const problems = [];
if (cfg.supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(cfg.supabaseUrl)) {
  problems.push('SUPABASE_URL looks wrong: expected https://<project-ref>.supabase.co (no trailing slash, no /rest/v1)');
}
if (cfg.supabaseAnonKey && cfg.supabaseAnonKey.length < 40) {
  problems.push('SUPABASE_ANON_KEY looks too short to be a real key');
}
/* The role lives inside the JWT payload, so it has to be decoded —
   a plain substring test on the key never matches. */
function jwtRole(key) {
  try {
    const seg = String(key).split('.')[1];
    if (!seg) return null;
    const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json).role || null;
  } catch (e) { return null; }
}

const role = jwtRole(cfg.supabaseAnonKey);
if (role === 'service_role') {
  problems.push('SUPABASE_ANON_KEY is a SERVICE ROLE key. It bypasses every row-level security policy and must NEVER be sent to a browser. Use the anon / publishable key instead.');
} else if (role && role !== 'anon') {
  problems.push('SUPABASE_ANON_KEY carries an unexpected role "' + role + '". Expected "anon".');
}

const banner =
`/* GENERATED FILE — do not edit by hand.
   Written by scripts/build-config.js at ${new Date().toISOString()}
   Change the values in Netlify > Site configuration > Environment variables,
   then redeploy. */\n`;

fs.writeFileSync(OUT, banner + 'window.SCHEDULER_CONFIG = ' + JSON.stringify(cfg, null, 2) + ';\n');

const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
console.log('[build-config] wrote config.js');
console.log('[build-config]   workspace : ' + cfg.workspace);
console.log('[build-config]   table     : ' + cfg.table);
console.log('[build-config]   supabase  : ' + (configured ? cfg.supabaseUrl : 'NOT CONFIGURED — site will run in local-only mode'));

problems.forEach(p => console.warn('[build-config] WARNING: ' + p));

/* Deliberately exit 0 even when unconfigured: a local-only deploy is
   still a usable site, and failing the build would hide that. */
