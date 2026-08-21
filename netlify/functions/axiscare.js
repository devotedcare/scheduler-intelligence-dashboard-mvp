/* ===============================================================
   AxisCare proxy  —  Netlify Function

   Why this exists:
     1. The AxisCare token must never reach the browser. Anything in
        index.html or config.js is world-readable via view-source.
     2. A browser cannot call AxisCare directly anyway — the request
        is cross-origin and gets blocked.

   So the browser calls this function, which runs on Netlify's server
   where the token lives as an env var, and it calls AxisCare.

   Verified against site 7060 on 2026-08-21 using the published
   OpenAPI spec at /api/documentation.html. AxisCare requires BOTH:

       Authorization:          Bearer <token>
       X-AxisCare-Api-Version: 2023-10-01

   Omitting the version header returns 400 "Unsupported version" —
   and that check runs BEFORE auth, so a missing version masks every
   other problem.

   Environment variables (names match the Client Concierge dashboard
   so both projects configure AxisCare the same way):
       AXISCARE_SITE_URL      required, e.g. https://7060.axiscare.com
       AXISCARE_API_TOKEN     required, secret
       AXISCARE_API_VERSION   optional, defaults to 2023-10-01
       AXISCARE_ALLOWED_PATHS optional, comma-separated path prefixes

   Try it from the browser console on the deployed site:
       await AxisCare.status()
       await AxisCare.ping()
       await AxisCare.get('/api/caregivers', { limit: 1 })
       await AxisCare.get('/api/visits', { startDate:'2026-08-21', endDate:'2026-08-22' })
   =============================================================== */
'use strict';

const DEFAULT_VERSION = '2023-10-01';

/* Confirmed live on site 7060. Read-only endpoints only — this proxy
   forwards GET and nothing else, so it can never mutate AxisCare. */
const DEFAULT_ALLOWED = [
  '/api/caregivers',
  '/api/clients',
  '/api/visits',
  '/api/schedules',
  '/api/contacts',
  '/api/applicants',
  '/api/call-logs',
  '/api/adls',
  '/api/organizations',
  '/api/taggingCategories',
  '/api/classes'
];

const TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 60000;
const MAX_QUERY_PARAMS = 20;

/* Warm serverless instances are reused between invocations, so this
   meaningfully reduces load on AxisCare. */
const cache = new Map();

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    },
    body: JSON.stringify(body)
  };
}

/* Belt and braces: never let the token escape in an error string. */
function redact(text, token) {
  if (!text) return text;
  return token ? String(text).split(token).join('[REDACTED]') : String(text);
}

function env(name, fallback) {
  const v = process.env[name];
  return (v === undefined || v === null || v === '') ? fallback : String(v).trim();
}

function allowedPaths() {
  const raw = env('AXISCARE_ALLOWED_PATHS', '');
  if (!raw) return DEFAULT_ALLOWED;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/* Reject anything that could turn this into an open proxy. */
function validatePath(path, allow) {
  if (!path) return 'Missing "path" parameter.';
  if (!path.startsWith('/')) return 'Path must start with "/".';
  if (path.includes('..')) return 'Path must not contain "..".';
  if (path.startsWith('//')) return 'Path must not start with "//".';
  if (/^[a-z][a-z0-9+.-]*:/i.test(path.slice(1))) return 'Path must not contain a URL scheme.';
  if (path.length > 512) return 'Path is too long.';
  const hit = allow.some(p => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'));
  if (!hit) {
    return 'Path "' + path + '" is not in the allowlist. Allowed prefixes: ' + allow.join(', ') +
           '. Add it via the AXISCARE_ALLOWED_PATHS environment variable.';
  }
  return null;
}

function axisHeaders(token, version) {
  return {
    Accept: 'application/json',
    Authorization: 'Bearer ' + token,
    'X-AxisCare-Api-Version': version
  };
}

/* Turn an AxisCare response into a consistent envelope for the browser. */
async function callAxis(url, token, version) {
  const res = await fetch(url, {
    headers: axisHeaders(token, version),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch (e) { data = { raw: redact(text, token).slice(0, 2000) }; }
  return { res, data };
}

/* AxisCare's own error messages are good — surface them rather than
   replacing them with something vaguer. */
function axisErrors(data) {
  const e = data && data.errors;
  if (!e) return null;
  if (Array.isArray(e)) return e.join('; ');
  if (typeof e === 'object') return Object.keys(e).map(k => e[k]).join('; ');
  return String(e);
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { Allow: 'GET, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Only GET is supported.' });

  const qs      = event.queryStringParameters || {};
  const action  = qs.action || 'status';
  const site    = env('AXISCARE_SITE_URL', '').replace(/\/+$/, '');
  const token   = env('AXISCARE_API_TOKEN', '');
  const version = env('AXISCARE_API_VERSION', DEFAULT_VERSION);
  const configured = !!(site && token);

  /* ---- status: is the plumbing in place? Never reveals the token. ---- */
  if (action === 'status') {
    return json(200, {
      ok: true,
      configured,
      siteUrl: site || null,
      apiVersion: version,
      tokenSet: !!token,
      tokenLength: token ? token.length : 0,   // presence check without disclosure
      allowedPaths: allowedPaths(),
      mode: configured ? 'ready' : 'not configured',
      note: configured
        ? 'Configured. Run AxisCare.ping() to confirm the token actually works.'
        : 'Set AXISCARE_SITE_URL and AXISCARE_API_TOKEN in Netlify environment variables, then redeploy.'
    });
  }

  if (!configured) {
    return json(503, {
      ok: false,
      error: 'AxisCare is not configured on the server.',
      missing: [!site && 'AXISCARE_SITE_URL', !token && 'AXISCARE_API_TOKEN'].filter(Boolean)
    });
  }

  /* ---- ping: prove the credentials work, end to end ---- */
  if (action === 'ping') {
    try {
      const { res, data } = await callAxis(site + '/api/caregivers?limit=1', token, version);
      const errs = axisErrors(data);
      return json(res.ok ? 200 : 502, {
        ok: res.ok,
        status: res.status,
        apiVersion: version,
        message: res.ok
          ? 'AxisCare responded successfully — token and version are correct.'
          : 'AxisCare rejected the request.',
        hint: res.ok ? undefined
          : (res.status === 400 ? 'A 400 "Unsupported version" means AXISCARE_API_VERSION is wrong. Current value: ' + version
          : (res.status === 401 || res.status === 403 ? 'Check AXISCARE_API_TOKEN — it may be wrong, expired, or lack permission.'
          : undefined)),
        axisError: errs || undefined
      });
    } catch (err) {
      return json(502, { ok: false, error: 'Could not reach AxisCare: ' + redact(err && err.message, token) });
    }
  }

  if (action !== 'get') {
    return json(400, { ok: false, error: 'Unknown action "' + action + '". Use "status", "ping" or "get".' });
  }

  /* ---- get: proxy a read ---- */
  const path = qs.path || '';
  const bad = validatePath(path, allowedPaths());
  if (bad) return json(400, { ok: false, error: bad });

  /* Forward q_* params as real query params: q_limit=50 -> limit=50 */
  const params = new URLSearchParams();
  let count = 0;
  for (const k of Object.keys(qs)) {
    if (!k.startsWith('q_')) continue;
    if (++count > MAX_QUERY_PARAMS) return json(400, { ok: false, error: 'Too many query parameters.' });
    params.set(k.slice(2), qs[k]);
  }

  const q = params.toString();
  const url = site + path + (q ? (path.includes('?') ? '&' : '?') + q : '');

  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return json(200, { ok: true, cached: true, status: hit.status, data: hit.data });
  }

  try {
    const { res, data } = await callAxis(url, token, version);

    if (!res.ok) {
      const errs = axisErrors(data);
      return json(res.status === 401 || res.status === 403 ? 502 : res.status, {
        ok: false,
        status: res.status,
        error: 'AxisCare returned HTTP ' + res.status + '.',
        axisError: errs || undefined,
        hint: res.status === 400
          ? 'Usually a wrong AXISCARE_API_VERSION (currently ' + version + ').'
          : res.status === 422
            ? 'Missing required query parameters — AxisCare says which, above. /api/visits and /api/schedules both need q_startDate and q_endDate.'
            : (res.status === 401 || res.status === 403)
              ? 'Check AXISCARE_API_TOKEN and its permissions.'
              : undefined,
        data
      });
    }

    cache.set(url, { at: Date.now(), status: res.status, data });
    if (cache.size > 100) cache.delete(cache.keys().next().value);

    return json(200, { ok: true, cached: false, status: res.status, data });

  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return json(timedOut ? 504 : 502, {
      ok: false,
      error: timedOut
        ? 'AxisCare did not respond within ' + (TIMEOUT_MS / 1000) + 's.'
        : 'Could not reach AxisCare: ' + redact(err && err.message, token),
      hint: timedOut ? undefined : 'Check that AXISCARE_SITE_URL is correct and reachable.'
    });
  }
};
