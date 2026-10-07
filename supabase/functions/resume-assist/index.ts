// resume-assist  ·  AI help writing a Resume Builder draft  ·  (Supabase Edge Function)
//
// WHAT THIS IS FOR
//
// The Resume Builder page (index.html, "RESUME BUILDER") lets a scheduler
// build a "Meet Your Caregiver" card from scratch, or starting from an
// existing caregiver's recorded Skills/Experience chips, and then either
// type the fields by hand or type an instruction and have the model fill
// them in. This function is the model side of that: it never writes
// anything on its own, it only answers a request the browser sent.
//
// TWO MODES, same endpoint, same shape as devi-agent's single dispatch:
//
//   mode:"edit"   the scheduler is asking to change the resume itself
//                 ("add bathing and dressing to skills", "warmer about
//                 paragraph"). Returns ONLY the fields that changed, so a
//                 vague prompt cannot blank out the rest of the draft.
//   mode:"email"  the scheduler wants a draft EMAIL about this resume
//                 (introducing the caregiver to a client, a referral
//                 source, etc). Returns {subject, body} and nothing else -
//                 this function never sends anything. The browser's own
//                 mailto: link, or Copy, is how it leaves the page.
//
// NOT PHI, and nothing about a shift or a specific client goes with the
// request either way - just the resume's own text and the instruction.
//
// THE KEY LIVES HERE, NOT IN THE BROWSER. Same reasoning as every other AI
// feature in this app: a design where the browser held an Anthropic key
// would let anyone with the site URL spend it on anything they liked.
// ANTHROPIC_API_KEY is the same project secret devi-agent and care-brief
// already use - nothing new to set, unless the owner decides to rotate it.
//
// SECRETS (Supabase project secrets):
//   ANTHROPIC_API_KEY   shared with every other AI function here
//   RESUME_MODEL        optional; falls back to CONCIERGE_MODEL, then Haiku
//   RESUME_EFFORT       optional; NOT sent to Haiku, which 400s on it
//   ALLOWED_ORIGIN      shared with devi-agent, quo, care-brief
//
// A COMMIT DOES NOT DEPLOY THIS FILE:
//   npx supabase functions deploy resume-assist --project-ref <ref> --no-verify-jwt

const KEY = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
const MODEL = (Deno.env.get("RESUME_MODEL") ?? Deno.env.get("CONCIERGE_MODEL") ?? "claude-haiku-4-5").trim();
const EFFORT = (Deno.env.get("RESUME_EFFORT") ?? "").trim();
const ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

const API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_MS = 30000;
/* MAX_TOKENS INCLUDES THINKING on Sonnet/Opus, and a thinking model spends the
   budget on reasoning first - the trap every function in this repo documents
   (devi-agent returned an empty text block at 64 tokens; care-brief needed
   4096, not 1024, for a single line). 4096 is generous for either mode here:
   a resume patch is a handful of short field arrays, and an email draft is a
   few short paragraphs. */
const MAX_TOKENS = 4096;
const RATE_MAX = 120;
const RATE_TOTAL = 600;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const RESUME_FIELDS = ["name", "title", "years", "bilingual", "personality",
  "communication", "reliability", "skills", "caregivingStyle", "careExperience", "about"];
const ARRAY_FIELDS = new Set(["bilingual", "personality", "communication", "reliability",
  "skills", "caregivingStyle", "careExperience"]);

// --- CORS (same shape as devi-agent, quo, care-brief) ------------------------
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

// --- rate limit (only an ALLOWED request is counted, so the window drains) ---
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

function stripDraft(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of RESUME_FIELDS) {
    if (!(f in (d || {}))) continue;
    out[f] = ARRAY_FIELDS.has(f)
      ? (Array.isArray(d[f]) ? (d[f] as unknown[]).map((x) => String(x)).slice(0, 40) : [])
      : String(d[f] ?? "").slice(0, 2000);
  }
  return out;
}

const EDIT_TOOL = {
  name: "update_resume",
  description: "Apply the scheduler's requested change to the caregiver resume draft. " +
    "Return ONLY the fields that should change; leave out any field the instruction did not touch.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      title: { type: "string" },
      years: { type: "string", description: "e.g. '4+'" },
      bilingual: { type: "array", items: { type: "string" }, description: "Languages spoken" },
      personality: { type: "array", items: { type: "string" }, description: "Single words or short phrases" },
      communication: { type: "array", items: { type: "string" }, description: "Short phrases, e.g. 'Explains each step to clients'" },
      reliability: { type: "array", items: { type: "string" } },
      skills: { type: "array", items: { type: "string" }, description: "Skills & Strengths" },
      caregivingStyle: { type: "array", items: { type: "string" }, description: "Short phrases" },
      careExperience: { type: "array", items: { type: "string" } },
      about: { type: "string", description: "One short paragraph" },
    },
    additionalProperties: false,
  },
};
const EMAIL_TOOL = {
  name: "write_email",
  description: "Write a short email draft using the resume as context. Return a subject and a plain-text body.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string" },
      body: { type: "string" },
    },
    required: ["subject", "body"],
    additionalProperties: false,
  },
};

const EDIT_SYSTEM = [
  "You help a scheduler at a home-care agency fill in and edit a caregiver's recruiting resume",
  "('Meet Your Caregiver' card). You are given the CURRENT draft and ONE instruction. Call",
  "update_resume exactly once, with ONLY the fields the instruction asks to change - leave every",
  "other field out of the call entirely, even if you could improve it. The scheduler reviews",
  "everything before anything is saved, so do not be shy about proposing specific wording, but",
  "never invent a fact the instruction or the current draft does not support (a certification, a",
  "language, a care condition) - ask for shorter or more general wording instead.",
  "",
  "Personality, Reliability, Skills & Strengths and Care Experience are short words or two-word",
  "phrases, not sentences. Communication and Caregiving Style are short first-person-plural-style",
  "phrases describing how the caregiver works, one per array entry, matching this house style:",
  "'Explains each step to clients', 'Gives clients space when needed', 'Handles client refusals well'.",
  "About is ONE short paragraph, third person, warm and specific, with no medical claims and no",
  "promises about availability or pay. Never write placeholder text like 'TBD' or 'N/A' - if there",
  "is nothing to say yet, leave the field out of the call.",
  "Write plain ASCII only: no en dashes, em dashes, curly quotes or ellipses.",
].join("\n");

const EMAIL_SYSTEM = [
  "You write ONE short email draft for a scheduler at a home-care agency, using a caregiver's",
  "resume as context (their skills, experience and personality) and the scheduler's own instruction",
  "for who it is to and what it should say. Call write_email exactly once.",
  "",
  "Keep it brief and professional - a few short paragraphs at most. Use only what the resume",
  "actually states; never invent a certification, a specific client name, a date, a rate of pay or",
  "an availability promise the scheduler did not ask you to include. If the instruction asks for",
  "something the resume gives no basis for, write the email anyway using what IS there and leave",
  "the unsupported part out rather than guessing. This is a DRAFT the scheduler will read and edit",
  "before anyone sends it - nothing here is sent automatically.",
  "Write plain ASCII only: no en dashes, em dashes, curly quotes or ellipses.",
].join("\n");

async function callClaude(system: string, userText: string, tool: Record<string, unknown>) {
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: (tool as { name: string }).name },
    messages: [{ role: "user", content: userText }],
  };
  /* EFFORT, NOT TO HAIKU - it answers 400 to a field it does not recognise.
     NO temperature anywhere - Sonnet 5 / Opus 5 reject one, so the first
     model switch would fail on every request. */
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
  return use.input as Record<string, unknown>;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!Object.keys(cors).length) return json({}, 403, { ok: false, error: "origin not allowed: " + (origin || "(none sent)") });

  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("action") === "status") {
    return json(cors, 200, { ok: true, configured: !!KEY, model: MODEL, missing: KEY ? [] : ["ANTHROPIC_API_KEY"] });
  }
  if (req.method !== "POST") return json(cors, 405, { ok: false, error: "Only POST is supported." });
  if (!KEY) return json(cors, 503, { ok: false, error: "AI assistance is not configured on the server (ANTHROPIC_API_KEY missing)." });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return json(cors, 429, { ok: false, error: "too many requests - try again shortly" });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(cors, 400, { ok: false, error: "Expected a JSON body." }); }

  const prompt = String(body?.prompt ?? "").trim().slice(0, 2000);
  if (!prompt) return json(cors, 400, { ok: false, error: "A prompt is required." });
  const draft = stripDraft((body?.draft ?? {}) as Record<string, unknown>);
  const mode = body?.mode === "email" ? "email" : "edit";

  const draftText = "Current resume draft (JSON):\n" + JSON.stringify(draft, null, 2) +
    "\n\nInstruction:\n" + prompt;

  try {
    if (mode === "email") {
      const out = await callClaude(EMAIL_SYSTEM, draftText, EMAIL_TOOL);
      return json(cors, 200, {
        ok: true,
        subject: String(out.subject ?? "").slice(0, 300),
        body: String(out.body ?? "").slice(0, 8000),
      });
    }
    const out = await callClaude(EDIT_SYSTEM, draftText, EDIT_TOOL);
    const patch = stripDraft(out);
    return json(cors, 200, { ok: true, patch });
  } catch (err) {
    const e = err as Error;
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return json(cors, timedOut ? 504 : 502, { ok: false, error: timedOut ? "The request timed out." : (e?.message || "Could not reach the model.") });
  }
});
