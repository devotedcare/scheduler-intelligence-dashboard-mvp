// text-assist  ·  AI help writing a shift-offer / record-status text  ·  (Supabase Edge Function)
//
// WHAT THIS IS FOR
//
// The Text composer (Find Coverage, Needs Update) lets a scheduler pick a
// template, edit it, and send through Quo. This adds a third option: describe
// what the message should say or sound like, and have the model write it -
// then regenerate as many times as needed before Send is ever clicked.
//
// GROUNDED, NOT FREE-FORM. The browser sends the SAME facts
// buildCoverageText() already uses for this shift - client, city, date,
// times, requirements, the care-needs line on a weekend offer - and the
// model is told to use ONLY those. It cannot invent a date, a client, or a
// requirement the instruction did not come with; "write a weekend offer for
// Tuesday" still has to pull Tuesday from the facts, not from the words.
//
// THE {name} TOKEN. A draft for several recipients carries the literal
// "{name}", which the SEND path (not this function) replaces per caregiver.
// The system prompt says to keep it verbatim when context.multi is true, and
// the BROWSER also refuses a multi-recipient answer with no {name} left in
// it - belt and braces, the same principle devi-agent's "never trust a
// model's output without a code-side check" is built on elsewhere in this
// app.
//
// NOT PHI - a shift offer names a client by city and first name only, the
// same information the deterministic templates already put in a text
// message. Nothing here is more sensitive than what already goes out.
//
// SECRETS (Supabase project secrets):
//   ANTHROPIC_API_KEY   shared with every other AI function here
//   TEXT_MODEL          optional; must be a Sonnet or Haiku model - same
//                        rule as resume-assist's RESUME_MODEL, and for the
//                        same reason: no silent fallback to CONCIERGE_MODEL
//                        (Opus 5). Defaults to Haiku.
//   TEXT_EFFORT         optional; NOT sent to Haiku, which 400s on it
//   ALLOWED_ORIGIN      shared with devi-agent, quo, care-brief, resume-assist
//
// A COMMIT DOES NOT DEPLOY THIS FILE:
//   npx supabase functions deploy text-assist --project-ref <ref> --no-verify-jwt

const KEY = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
const RAW_MODEL = (Deno.env.get("TEXT_MODEL") ?? "claude-haiku-4-5").trim();
const MODEL_OK = /sonnet|haiku/i.test(RAW_MODEL);
const MODEL = MODEL_OK ? RAW_MODEL : "claude-haiku-4-5";
const EFFORT = (Deno.env.get("TEXT_EFFORT") ?? "").trim();
const ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

const API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_MS = 30000;
const MAX_TOKENS = 2048;           // a text message, not an essay - thinking still eats this first
const MAX_CHARS = 1500;            // one SMS concat segment's worth of headroom, same spirit as Quo's SEND_MAX_CHARS
const RATE_MAX = 120;
const RATE_TOTAL = 600;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const TOOL = {
  name: "write_message",
  description: "Write the text message to send to the caregiver(s). Call this exactly once.",
  input_schema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
};

function buildSystem(multi: boolean): string {
  return [
    "You write ONE text message from a home-care scheduling desk to a caregiver, offering or",
    "confirming a shift. You are given FACTS about this specific shift and an instruction from the",
    "scheduler describing what the message should say or sound like. Call write_message exactly once.",
    "",
    "USE ONLY THE SUPPLIED FACTS. Never invent a client name, city, date, time or requirement the",
    "facts do not state. If the instruction asks for something the facts do not support, write the",
    "message without that detail rather than guessing at it.",
    "",
    multi
      ? "THIS MESSAGE GOES TO SEVERAL CAREGIVERS. The facts' cgName field is the literal string " +
        "\"{name}\" - keep that EXACT text in the message, unchanged, wherever the caregiver's name " +
        "would go. It is replaced per recipient by the sending system, not by you. Never replace it " +
        "with an actual name, and never remove it."
      : "Address the caregiver by the first name given in the facts.",
    "",
    "Ask a yes/no question somewhere in the message (\"Please reply YES or NO\") unless the",
    "instruction clearly asks for something else, such as a reminder or a confirmation that needs no",
    "reply. Keep it to a few sentences - this is a text message, not an email.",
    "",
    "WRITE PLAIN ASCII ONLY: no en dashes, em dashes, curly quotes or ellipses. Use \"-\", \"'\" and",
    "\"...\" instead. One character outside plain ASCII forces the whole message out of GSM-7 encoding",
    "and roughly doubles what it costs to send - a hyphen does the identical job for free.",
    "",
    "Never mention medication, a diagnosis or any clinical detail beyond what the facts themselves",
    "already include in a careLine field, if present - treat that line as already vetted and include",
    "it only if the instruction or the message's purpose calls for care-needs detail.",
  ].join("\n");
}

// --- CORS (same shape as every sibling function) -----------------------------
function normOrigin(s: string): string { return s.trim().replace(/\/+$/, ""); }
function originAllowed(origin: string): boolean {
  if (!origin) return false;
  const o0 = normOrigin(origin);
  return ORIGINS.some((raw) => {
    const o = normOrigin(raw);
    if (o === "*" || o === o0) return true;
    const i = o.indexOf("*");
    if (i < 0) return false;
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
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "86400",
    ...(allowAll ? {} : { vary: "Origin" }),
  };
}
const json = (cors: Record<string, string>, status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" },
  });

const hits = new Map<string, number[]>();
let all: number[] = [];
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = all.filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_TOTAL) { all = recent; return true; }
  const seen = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (seen.length >= RATE_MAX) { hits.set(ip, seen); all = recent; return true; }
  recent.push(now); all = recent;
  seen.push(now); hits.set(ip, seen);
  if (hits.size > 5000) [...hits.keys()].slice(0, 1000).forEach((k) => hits.delete(k));
  return false;
}

/* Only the fields coverageTextCtx() actually produces, and nothing else - a
   caller cannot smuggle extra instructions in under an unexpected key. */
const CTX_FIELDS = ["cgName", "clName", "city", "careLine", "dayName", "dateStr", "startStr", "endStr", "reqs", "template"];
function stripContext(c: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of CTX_FIELDS) {
    if (!(f in (c || {}))) continue;
    out[f] = f === "reqs"
      ? (Array.isArray(c[f]) ? (c[f] as unknown[]).map((x) => String(x)).slice(0, 10) : [])
      : String(c[f] ?? "").slice(0, 500);
  }
  return out;
}

async function callClaude(system: string, userText: string): Promise<string> {
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{ role: "user", content: userText }],
  };
  if (EFFORT && !/haiku/i.test(MODEL)) body.effort = EFFORT;

  const r = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": ANTHROPIC_VERSION },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await r.json().catch(() => null) as Record<string, unknown> | null;
  if (!r.ok) {
    const e = (data?.error as { message?: string })?.message;
    throw new Error(e || ("Anthropic returned HTTP " + r.status + "."));
  }
  const parts = (data?.content as Array<{ type: string; input?: unknown }>) || [];
  const use = parts.find((p) => p.type === "tool_use");
  if (!use) {
    const why = String(data?.stop_reason ?? "unknown");
    throw new Error(why === "max_tokens"
      ? "The model spent its whole budget thinking and returned nothing usable (stop_reason: max_tokens)."
      : "The model did not return a usable answer (stop_reason: " + why + ").");
  }
  return String((use.input as Record<string, unknown>)?.message ?? "");
}

/* Plain ASCII, enforced in code rather than trusted from the prompt - the
   same reason every other function here double-checks its own rule. A
   curly quote or dash is swapped for its plain equivalent rather than
   rejecting the whole message over one character. */
function toGsm7(s: string): string {
  return s.replace(/[–—]/g, "-").replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"').replace(/…/g, "...").replace(/·/g, "-");
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!Object.keys(cors).length) return json({}, 403, { ok: false, error: "origin not allowed: " + (origin || "(none sent)") });

  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("action") === "status") {
    return json(cors, 200, {
      ok: true, configured: !!KEY, model: MODEL, missing: KEY ? [] : ["ANTHROPIC_API_KEY"],
      modelOverridden: MODEL_OK ? null : RAW_MODEL,
    });
  }
  if (req.method !== "POST") return json(cors, 405, { ok: false, error: "Only POST is supported." });
  if (!KEY) return json(cors, 503, { ok: false, error: "AI assistance is not configured on the server (ANTHROPIC_API_KEY missing)." });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return json(cors, 429, { ok: false, error: "too many requests - try again shortly" });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(cors, 400, { ok: false, error: "Expected a JSON body." }); }

  const prompt = String(body?.prompt ?? "").trim().slice(0, 2000);
  if (!prompt) return json(cors, 400, { ok: false, error: "A prompt is required." });
  const context = stripContext((body?.context ?? {}) as Record<string, unknown>);
  const multi = (body?.context as Record<string, unknown>)?.multi === true;

  const userText = "Facts about this shift:\n" + JSON.stringify(context, null, 2) +
    "\n\nWhat the message should say or sound like:\n" + prompt;

  try {
    let message = toGsm7(await callClaude(buildSystem(multi), userText)).trim().slice(0, MAX_CHARS);
    if (!message) return json(cors, 502, { ok: false, error: "The model returned an empty message." });
    return json(cors, 200, { ok: true, message });
  } catch (err) {
    const e = err as Error;
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return json(cors, timedOut ? 504 : 502, { ok: false, error: timedOut ? "The request timed out." : (e?.message || "Could not reach the model.") });
  }
});
