/* ===============================================================
   AxisCare proxy  —  Netlify Function

   Why this exists at all:
     1. The AxisCare token must never reach the browser. Anything in
        index.html or config.js is world-readable via view-source.
     2. A browser cannot call the AxisCare API directly anyway —
        cross-origin requests from your Netlify domain will be
        blocked unless AxisCare explicitly allows it via CORS.

   So the browser calls this function, and this function — running on
   Netlify's server, where the token lives as an env var — calls
   AxisCare.

   STATUS: scaffold. The dashboard still renders demo data. This is
   deployed and testable so that wiring real endpoints later is a
   field-mapping job, not an infrastructure job.

   Try it from the browser console on the deployed site:
       await AxisCare.status()
       await AxisCare.get('/caregivers')

   Environment variables (Netlify > Site configuration > Environment):
       AXISCARE_BASE_URL       required, e.g. https://api.axiscare.com/v1
       AXISCARE_TOKEN          required, secret
       AXISCARE_AUTH_STYLE     bearer (default) | header | query
       AXISCARE_TOKEN_HEADER   header name when AUTH_STYLE=header  (default X-API-Key)
       AXISCARE_TOKEN_PARAM    query name  when AUTH_STYLE=query   (default token)
       AXISCARE_ALLOWED_PATHS  comma-separated path prefixes (see DEFAULT_ALLOWED)
   =============================================================== */
'use strict';

const DEFAULT_ALLOWED = [
  '/caregivers', '/employees', '/applicants',
  '/clients', '/patients',
  '/visits', '/shifts', '/schedules', '/appointments'
];

const TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 60000;
const MAX_QUERY_PARAMS = 20;

/* Warm-instance cache. Serverless containers are reused between
   invocations, so this meaningfully reduces load on AxisCare. */
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
  let s = String(text);
  if (token) s = s.split(token).join('[REDACTED]');
  return s;
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

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { Allow: 'GET, OPTIONS' }, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Only GET is supported.' });

  const qs        = event.queryStringParameters || {};
  const action    = qs.action || 'status';
  const baseUrl   = env('AXISCARE_BASE_URL', '');
  const token     = env('AXISCARE_TOKEN', '');
  const authStyle = env('AXISCARE_AUTH_STYLE', 'bearer').toLowerCase();
  const configured = !!(baseUrl && token);

  /* ---- status: is the plumbing in place? Never reveals the token. ---- */
  if (action === 'status') {
    return json(200, {
      ok: true,
      configured,
      baseUrlSet: !!baseUrl,
      tokenSet: !!token,
      tokenLength: token ? token.length : 0,   // presence check without disclosure
      authStyle,
      allowedPaths: allowedPaths(),
      mode: configured ? 'ready' : 'scaffold',
      note: configured
        ? 'Proxy is configured. The dashboard still renders demo data until fields are mapped.'
        : 'Set AXISCARE_BASE_URL and AXISCARE_TOKEN in Netlify environment variables, then redeploy.'
    });
  }

  if (action !== 'get') {
    return json(400, { ok: false, error: 'Unknown action "' + action + '". Use "status" or "get".' });
  }

  if (!configured) {
    return json(503, {
      ok: false,
      error: 'AxisCare is not configured on the server.',
      missing: [!baseUrl && 'AXISCARE_BASE_URL', !token && 'AXISCARE_TOKEN'].filter(Boolean)
    });
  }

  const path = qs.path || '';
  const bad = validatePath(path, allowedPaths());
  if (bad) return json(400, { ok: false, error: bad });

  /* Forward q_* params through as real query params: q_page=2 -> page=2 */
  const params = new URLSearchParams();
  let count = 0;
  for (const k of Object.keys(qs)) {
    if (!k.startsWith('q_')) continue;
    if (++count > MAX_QUERY_PARAMS) return json(400, { ok: false, error: 'Too many query parameters.' });
    params.set(k.slice(2), qs[k]);
  }

  const headers = { Accept: 'application/json' };
  if (authStyle === 'bearer')      headers.Authorization = 'Bearer ' + token;
  else if (authStyle === 'header') headers[env('AXISCARE_TOKEN_HEADER', 'X-API-Key')] = token;
  else if (authStyle === 'query')  params.set(env('AXISCARE_TOKEN_PARAM', 'token'), token);
  else return json(500, { ok: false, error: 'AXISCARE_AUTH_STYLE must be one of: bearer, header, query.' });

  const q = params.toString();
  const url = baseUrl.replace(/\/+$/, '') + path + (q ? (path.includes('?') ? '&' : '?') + q : '');

  /* Cache key excludes headers, but the token is per-deploy, so this is safe. */
  const cacheKey = url;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return json(200, { ok: true, cached: true, status: hit.status, data: hit.data });
  }

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();

    let data;
    try { data = text ? JSON.parse(text) : null; }
    catch (e) { data = { raw: redact(text, token).slice(0, 2000) }; }

    if (!res.ok) {
      return json(res.status === 401 || res.status === 403 ? 502 : res.status, {
        ok: false,
        error: 'AxisCare returned HTTP ' + res.status + '.',
        hint: (res.status === 401 || res.status === 403)
          ? 'Check AXISCARE_TOKEN and AXISCARE_AUTH_STYLE — the token may be wrong, expired, or sent the wrong way.'
          : undefined,
        status: res.status,
        data
      });
    }

    cache.set(cacheKey, { at: Date.now(), status: res.status, data });
    if (cache.size > 100) cache.delete(cache.keys().next().value);

    return json(200, { ok: true, cached: false, status: res.status, data });

  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return json(timedOut ? 504 : 502, {
      ok: false,
      error: timedOut
        ? 'AxisCare did not respond within ' + (TIMEOUT_MS / 1000) + 's.'
        : 'Could not reach AxisCare: ' + redact(err && err.message, token),
      hint: timedOut ? undefined : 'Check that AXISCARE_BASE_URL is correct and reachable from the public internet.'
    });
  }
};
