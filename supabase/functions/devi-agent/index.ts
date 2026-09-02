// Ask Devi -> Claude Messages API  ·  thin proxy  (Supabase Edge Function)
//
// The dashboard owns the conversation. This function's only job is to hold the
// API key and forward one Messages API round trip.
//
//   POST { system, messages, max_tokens }  ->  Claude's response, verbatim
//
// It NEVER touches Supabase, NEVER writes anything, and NEVER runs tools. Devi
// can only *say* things. Nothing it returns reaches the availability table, the
// roster, or AxisCare — the browser renders the text and stops there. That is
// the whole safety argument for pointing it at real scheduling data, and it is
// why there is no tool list in this file: adding one changes that argument.
//
// WHY AN EDGE FUNCTION AND NOT A NETLIFY ONE. Every other backend in this repo
// is a Netlify function, so this is the odd one out. It is here because the
// ANTHROPIC_API_KEY secret is here — see the header of netlify/functions/
// axiscare.js for the same reasoning applied to the AxisCare token. Two
// backends is a real cost; moving the key would be a bigger one.
//
// Secrets (Supabase project secrets — never in the repo, never in index.html):
//   ANTHROPIC_API_KEY   required. Anthropic key for this dashboard. NOTE the
//                       name: the local .env calls the same value
//                       CLAUDE_API_KEY, which is what everything else in this
//                       repo reads. Only this function wants ANTHROPIC_*.
//   CONCIERGE_MODEL     the model id. Kept under the Concierge's name because
//                       that secret already exists on this project; DEVI_MODEL
//                       overrides it if you would rather split them later.
//   ALLOWED_ORIGIN      comma-separated origin allow-list. See CORS below.
//   DEVI_EFFORT         optional. low|medium|high|xhigh|max, or "off" to send
//                       nothing. Defaults to medium.
//   DEVI_MAX_TOKENS     optional. Ceiling for max_tokens. Defaults to 4096.
//   DEVI_SHARED_SECRET  optional. If set, requires a matching X-Devi-Secret
//                       header.
//
// THINKING IS DELIBERATELY NOT SENT, and that is not an oversight. Omitting it
// gives the correct default on every model worth pointing this at:
//   claude-opus-5 / sonnet-5   adaptive is the only on-mode, and it is the
//                              default            -> adaptive thinking
//   claude-haiku-4-5           adaptive unsupported, thinking is opt-in
//                                                 -> no thinking
// Hardcoding either one would break the other the moment CONCIERGE_MODEL
// changed. Never send {type:"disabled"} on Opus 5 specifically: it can write a
// tool call into its visible text where it silently never runs, and it leaks
// <thinking> tags. Lower DEVI_EFFORT instead — that is what it is for.
//
// THINKING SPENDS FROM max_tokens, WHICH IS THE ONE TRAP HERE. On Opus 5 a
// small ceiling produces HTTP 200, stop_reason "max_tokens", and an EMPTY
// text block — every token went to thinking before a word was written.
// Measured on this key: max_tokens 64 -> 64 thinking tokens, "" returned;
// max_tokens 1024 -> 79 thinking + 9 text, answered fine. MIN_TOKENS below is
// the floor that stops a caller asking for a blank reply.
//
// EFFORT IS SENT, BUT ONLY WHERE THE MODEL SUPPORTS IT. output_config.effort
// ERRORS on Haiku 4.5 and Sonnet 4.5, so it is gated on the model id and the
// model stays switchable from the Supabase dashboard without a redeploy.
// Anything added here later needs the same treatment.
//
// Deploy with JWT verification OFF — the dashboard sends no JWT:
//   supabase functions deploy devi-agent --no-verify-jwt

const KEY     = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
const MODEL   = (Deno.env.get("DEVI_MODEL") ?? Deno.env.get("CONCIERGE_MODEL") ?? "claude-opus-5").trim();
const SECRET  = (Deno.env.get("DEVI_SHARED_SECRET") ?? "").trim();
const ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "*")
  .split(",").map((s) => s.trim()).filter(Boolean);

const MAX_TOKENS_CEIL = Number(Deno.env.get("DEVI_MAX_TOKENS") ?? "4096") || 4096;
/* Below this, adaptive thinking can consume the whole budget and the caller
   gets a successful, empty answer. See the header. */
const MIN_TOKENS = 1024;

const EFFORT = (Deno.env.get("DEVI_EFFORT") ?? "medium").trim().toLowerCase();
const EFFORT_MODELS = /^claude-(fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)\b/;
const USE_EFFORT = !!EFFORT && EFFORT !== "off" && EFFORT_MODELS.test(MODEL);

const API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/* The dashboard's own request is ~55KB (a ~14k-token snapshot plus the
   thread). 64KB leaves room to grow and takes the worst case a stranger can
   buy with one request from about $3.20 down to about $0.20 — the ceiling is
   set by how much context you can be made to pay for, and this is that dial. */
const MAX_BODY_BYTES = 64_000;

/* TWO limits, because the per-caller one is only a courtesy: its key comes
   from X-Forwarded-For, which the caller writes. Rotating that header defeats
   it completely. RATE_TOTAL is the one that actually holds — it counts every
   request this isolate has served, no matter who claims to be sending it. */
const RATE_MAX = 60;                      // per claimed caller, per window
const RATE_TOTAL = 400;                   // per isolate, per window — the real cap
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RETRIES = 3;                        // on 429 / 529 / 5xx

// --- CORS --------------------------------------------------------------------
//
// An ALLOWED_ORIGIN entry may use "*" as a wildcard for part of ONE hostname
// label, so every Netlify deploy preview of a site can be allowed without
// listing each PR number:
//     https://*--scheduling-intelligence-dashboard-mvp.netlify.app
// "*" never matches a dot, so it cannot widen onto another domain.
//
// TWO ORIGINS PEOPLE GET WRONG, both worth knowing before editing the secret:
//   · "null"  is what a browser sends for a page opened straight off disk
//             (file://…/index.html). It is NOT a wildcard and does NOT cover
//             a local web server.
//   · a local SERVER sends a real origin — http://localhost:8888 for
//             `netlify dev`, http://localhost:5500 for VS Code Live Server,
//             http://127.0.0.1:8888 if the address bar says 127.0.0.1 rather
//             than localhost. Those are DIFFERENT origins to the browser and
//             each needs its own entry.
// A trailing slash is tolerated on both sides below, because an origin never
// actually carries one and a pasted URL usually does — that mismatch silently
// failed every request once already.
function normOrigin(s: string): string {
  return s.trim().replace(/\/+$/, "");
}

function originAllowed(origin: string): boolean {
  if (!origin) return false;
  const o0 = normOrigin(origin);
  return ORIGINS.some((raw) => {
    const o = normOrigin(raw);
    if (o === o0) return true;
    if (!o.includes("*")) return false;
    const i = o.indexOf("*");
    const head = o.slice(0, i), tail = o.slice(i + 1);
    if (!o0.startsWith(head) || !o0.endsWith(tail)) return false;
    if (o0.length < head.length + tail.length) return false;
    const mid = o0.slice(head.length, o0.length - tail.length);
    return !mid.includes(".") && !mid.includes("/");
  });
}

function corsHeaders(origin: string): Record<string, string> {
  const allowAll = ORIGINS.length === 1 && ORIGINS[0] === "*";
  const ok = allowAll || originAllowed(origin);
  if (!ok) return {};
  return {
    "access-control-allow-origin": allowAll ? "*" : origin,
    "access-control-allow-headers": "content-type, x-devi-secret",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "86400",
    ...(allowAll ? {} : { vary: "Origin" }),
  };
}

const json = (cors: Record<string, string>, status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });

// --- rate limit --------------------------------------------------------------
// Per isolate, so it is a brake rather than a guarantee — Supabase may run
// several. Enough to stop one stuck browser loop emptying the account.
const hits = new Map<string, number[]>();
let all: number[] = [];
function rateLimited(ip: string): boolean {
  const now = Date.now();

  /* The global count first — this is the one that cannot be sidestepped. */
  all = all.filter((t) => now - t < RATE_WINDOW_MS);
  all.push(now);
  if (all.length > RATE_TOTAL) return true;

  const seen = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  seen.push(now);
  hits.set(ip, seen);
  /* Bounded, and deliberately evicting the OLDEST rather than clearing
     everything: hits.clear() handed every caller a fresh allowance, which a
     flood of rotated X-Forwarded-For values could trigger on purpose. */
  if (hits.size > 5000) {
    const oldest = [...hits.keys()].slice(0, 1000);
    oldest.forEach((k) => hits.delete(k));
  }
  return seen.length > RATE_MAX;
}

// --- Claude ------------------------------------------------------------------
async function callClaude(payload: unknown): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i <= RETRIES; i++) {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "x-api-key": KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) return res;
    if (res.status !== 429 && res.status !== 529 && res.status < 500) return res;
    last = res;
    if (i < RETRIES) {
      /* Honour Retry-After when the API sends one; otherwise back off. */
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 400 * Math.pow(2, i);
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, Math.min(wait, 8000)));
    }
  }
  return last!;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: Object.keys(cors).length ? 204 : 403, headers: cors });
  }
  if (!Object.keys(cors).length) {
    /* No CORS headers means the browser will reject the reply anyway; answering
       403 with a readable reason makes it visible in the network tab instead of
       looking like the function is down. */
    return new Response(JSON.stringify({ error: "origin not allowed: " + (origin || "(none sent)") }),
      { status: 403, headers: { "content-type": "application/json" } });
  }
  if (req.method !== "POST") return json(cors, 405, { error: "POST only" });
  if (!KEY) return json(cors, 503, { error: "ANTHROPIC_API_KEY is not set on this project" });
  if (SECRET && req.headers.get("x-devi-secret") !== SECRET) {
    return json(cors, 401, { error: "bad or missing X-Devi-Secret" });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return json(cors, 429, { error: "too many requests — try again shortly" });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(cors, 413, { error: "request too large" });

  let body: { system?: unknown; messages?: unknown; max_tokens?: unknown };
  try { body = JSON.parse(raw); } catch { return json(cors, 400, { error: "bad JSON" }); }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json(cors, 400, { error: "messages is required" });
  }

  /* Cache the stable prefix. The system block carries Devi's instructions and
     the roster summary, which change rarely; the thread underneath changes
     every turn. One breakpoint on system is all this needs. Prompt caching is
     a BAA-covered Messages API feature. */
  const system = (typeof body.system === "string" && body.system.trim())
    ? [{ type: "text", text: body.system, cache_control: { type: "ephemeral" } }]
    : undefined;

  const asked = Number(body.max_tokens) || 0;
  const payload: Record<string, unknown> = {
    model: MODEL,                                   // pinned server-side; the client cannot choose
    max_tokens: Math.min(Math.max(asked, MIN_TOKENS), MAX_TOKENS_CEIL),
    messages: body.messages,
  };
  if (system) payload.system = system;
  if (USE_EFFORT) payload.output_config = { effort: EFFORT };   // GA, no beta header

  try {
    const res = await callClaude(payload);
    const text = await res.text();
    if (!res.ok) {
      console.error("claude error", res.status, text.slice(0, 500));
      let reason = "the model service returned an error";
      try {
        const e = JSON.parse(text);
        if (e?.error?.message) reason = String(e.error.message);
      } catch { /* keep the generic reason */ }
      return json(cors, res.status, { error: reason });
    }
    /* Claude's response body, verbatim — the dashboard reads content and
       stop_reason and renders the text as PLAIN TEXT, never as HTML. */
    return new Response(text, { status: 200, headers: { ...cors, "content-type": "application/json" } });
  } catch (e) {
    console.error("devi-agent", e);
    return json(cors, 502, { error: String((e as Error)?.message ?? e) });
  }
});
