#!/usr/bin/env node
/* ---------------------------------------------------------------
   Local dev server —  node scripts/dev-server.js

   Serves the dashboard exactly the way Netlify does, so the whole
   thing can be checked locally before anything is pushed:

     · static files from the repo root
     · /.netlify/functions/*  runs the REAL function code in
       netlify/functions/, with the variables from .env
     · /config.js is generated in memory from .env, so Supabase
       sync works locally without touching the committed file

   No dependencies and no Netlify login. Opening index.html straight
   from disk cannot work, because file:// has no server behind it to
   answer /.netlify/functions/... — that is what this replaces.

   Ctrl-C to stop.
   --------------------------------------------------------------- */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8888);

/* ---- load .env into process.env (without clobbering real env) ---- */
function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) { console.warn('[dev] no .env found — AxisCare and Supabase will be unconfigured'); return; }
  let n = 0;
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(t);
    if (!m) return;
    if (process.env[m[1]] === undefined) { process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); n++; }
  });
  console.log('[dev] loaded ' + n + ' variables from .env');
}
loadEnv();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json'
};

/* config.js is generated at deploy time on Netlify; do the same here
   so the committed placeholder is never overwritten on disk. */
function generatedConfig() {
  const cfg = {
    supabaseUrl: (process.env.SUPABASE_URL || '').trim(),
    supabaseAnonKey: (process.env.SUPABASE_ANON_KEY || '').trim(),
    workspace: (process.env.SCHEDULER_WORKSPACE || 'devoted_care').trim(),
    table: (process.env.SCHEDULER_TABLE || 'scheduler_state').trim(),
    pollMs: Number(process.env.SCHEDULER_POLL_MS || 20000)
  };
  if (!Number.isFinite(cfg.pollMs) || cfg.pollMs < 8000) cfg.pollMs = 20000;
  return '/* generated in memory by scripts/dev-server.js */\n' +
         'window.SCHEDULER_CONFIG = ' + JSON.stringify(cfg, null, 2) + ';\n';
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function runFunction(name, req, res, query) {
  const file = path.join(ROOT, 'netlify', 'functions', name + '.js');
  if (!fs.existsSync(file)) return send(res, 404, JSON.stringify({ ok: false, error: 'No function named "' + name + '"' }), MIME['.json']);

  let mod;
  try {
    delete require.cache[require.resolve(file)];   // pick up edits without a restart
    mod = require(file);
  } catch (e) {
    console.error('[dev] failed to load function ' + name, e);
    return send(res, 500, JSON.stringify({ ok: false, error: 'Function failed to load: ' + e.message }), MIME['.json']);
  }

  const event = {
    httpMethod: req.method,
    path: '/.netlify/functions/' + name,
    headers: req.headers,
    queryStringParameters: query,
    body: null
  };

  try {
    const out = await mod.handler(event, {});
    const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, out.headers || {});
    res.writeHead(out.statusCode || 200, headers);
    res.end(out.body || '');
    console.log('  fn ' + name + ' ' + (query.action || '') + ' ' + (query.path || '') + ' -> ' + (out.statusCode || 200));
  } catch (e) {
    console.error('[dev] function threw', e);
    send(res, 500, JSON.stringify({ ok: false, error: 'Function threw: ' + e.message }), MIME['.json']);
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost:' + PORT);
  let pathname = decodeURIComponent(u.pathname);

  const q = {};
  u.searchParams.forEach((v, k) => { q[k] = v; });

  if (pathname.startsWith('/.netlify/functions/')) {
    return runFunction(pathname.slice('/.netlify/functions/'.length).split('/')[0], req, res, q);
  }
  if (pathname === '/config.js') return send(res, 200, generatedConfig(), MIME['.js']);
  if (pathname === '/') pathname = '/index.html';

  /* keep the server inside the repo */
  const file = path.join(ROOT, pathname);
  if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden');

  fs.readFile(file, (err, buf) => {
    if (err) {
      const nf = path.join(ROOT, '404.html');
      if (fs.existsSync(nf)) { res.writeHead(404, { 'Content-Type': MIME['.html'] }); return res.end(fs.readFileSync(nf)); }
      return send(res, 404, 'Not found: ' + pathname);
    }
    send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
});

server.listen(PORT, () => {
  const site = (process.env.AXISCARE_SITE_URL || '').trim();
  const sb = (process.env.SUPABASE_URL || '').trim();
  console.log('');
  console.log('  Scheduler Intelligence — local dev server');
  console.log('  ----------------------------------------');
  console.log('  http://localhost:' + PORT);
  console.log('');
  console.log('  AxisCare : ' + (site ? site + '  (proxy live)' : 'not configured'));
  console.log('  Supabase : ' + (sb ? sb : 'not configured — sync will read "Local"'));
  console.log('');
  console.log('  Try:  http://localhost:' + PORT + '/.netlify/functions/axiscare?action=ping');
  console.log('  Ctrl-C to stop.');
  console.log('');
});
