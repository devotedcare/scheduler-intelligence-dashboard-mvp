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
//   RESUME_MODEL        optional; must be a Sonnet or Haiku model - anything
//                        else is rejected and Haiku is used instead (owner,
//                        2026-10-07: never Opus here). Falls back to Haiku
//                        when unset. Does NOT fall back to CONCIERGE_MODEL.
//   RESUME_EFFORT       optional; NOT sent to Haiku, which 400s on it
//   ALLOWED_ORIGIN      shared with devi-agent, quo, care-brief
//
// A COMMIT DOES NOT DEPLOY THIS FILE:
//   npx supabase functions deploy resume-assist --project-ref <ref> --no-verify-jwt

const KEY = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
/* SONNET OR HAIKU ONLY (owner, 2026-10-07) - deliberately NOT falling back to
   CONCIERGE_MODEL the way care-brief does, because that secret is Opus 5
   ("CONCIERGE_MODEL | claude-opus-5" - CLAUDE.md). Falling back to it here
   would silently put Opus behind this screen the moment RESUME_MODEL went
   unset, which is the one thing this was just asked not to do. A model set
   that is neither family is rejected, not merely ignored - see below. */
const RAW_MODEL = (Deno.env.get("RESUME_MODEL") ?? "claude-haiku-4-5").trim();
const MODEL_OK = /sonnet|haiku/i.test(RAW_MODEL);
const MODEL = MODEL_OK ? RAW_MODEL : "claude-haiku-4-5";
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
  description: "Apply the scheduler's instruction to the caregiver resume draft. For a targeted edit, " +
    "return only the fields that change. For a build from sources, return every field the sources support.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      title: { type: "string" },
      years: { type: "string", description: "'4+', or the whole line 'Caregiving Since November 2025' when under a year" },
      bilingual: { type: "array", items: { type: "string" }, description: "Languages spoken" },
      personality: { type: "array", items: { type: "string" }, description: "Single words or short phrases" },
      communication: { type: "array", items: { type: "string" }, description: "Short phrases, e.g. 'Explains each step to clients'" },
      reliability: { type: "array", items: { type: "string" } },
      skills: { type: "array", items: { type: "string" }, description: "Skills & Strengths" },
      caregivingStyle: { type: "array", items: { type: "string" }, description: "Short phrases" },
      careExperience: { type: "array", items: { type: "string" } },
      about: { type: "string", description: "Three to five short sentences of background only" },
      notes: {
        type: "object",
        description: "For the scheduler, never printed on the resume.",
        properties: {
          builtFrom: { type: "string", description: "One short line naming the sources used" },
          leftOff: { type: "array", items: { type: "string" }, description: "What was deliberately left off the page, and why" },
          confirm: { type: "array", items: { type: "string" }, description: "Conflicts or doubtful details to check" },
        },
        additionalProperties: false,
      },
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

/* THE RULES BELOW ARE THE OFFICE'S OWN "caregiver-resume" SKILL (owner, 2026-10-07).
   The same rulebook claude.ai follows when the office builds one of these by hand,
   so a resume made here and one made there leave the same things off and sort a
   fact into the same box. If the skill changes, this prompt changes with it.

   What could NOT come across: the skill draws the PDF with a Python builder
   (ReportLab) that scales the type to fill the page. There is no Python in a
   browser or an Edge Function, so the page here is still the HTML template in
   index.html (resume2Html) printed to PDF. The CONTENT rules are the skill's;
   the page layout is this app's own approximation of it. */
const EDIT_SYSTEM = [
  "You build and edit Devoted Care's one-page 'Meet Your Caregiver' resume, which introduces a",
  "caregiver to a client's FAMILY. You are given the CURRENT draft and ONE instruction, sometimes",
  "with sources: pasted office notes or call transcripts, attached screenshots of the caregiver",
  "dashboard, an older resume, a certificate. Call update_resume exactly once.",
  "",
  "TWO KINDS OF INSTRUCTION",
  "1. A targeted edit ('make the about warmer', 'add Hoyer lift to skills'). Return ONLY the fields",
  "   it asks to change and leave every other field out of the call.",
  "2. A build ('create her resume', 'recreate this', 'use this', or sources handed over with little",
  "   instruction). Return EVERY field the sources support. The current draft counts as a source:",
  "   its skills, care experience and personality usually came from the caregiver dashboard. Return",
  "   those fields too, cleaned up by the rules below.",
  "",
  "SOURCES",
  "Every line must trace to the draft, the instruction or an attachment. Never invent a trait, a",
  "skill, years or a credential, and never fill a gap with a guess. An empty box is correct when",
  "nothing supports it: leave that field out. When sources disagree, use the most direct one (what",
  "the caregiver said outranks a draft somebody wrote) and say so in notes.confirm.",
  "When an attachment is itself a finished resume with labelled boxes, each box goes to the field",
  "of the SAME name: its RELIABILITY items into reliability, its CAREGIVING STYLE items into",
  "caregivingStyle, its COMMUNICATION items into communication. Do not move an item to a different",
  "box and do not rewrite a box from the About paragraph.",
  "",
  "ALWAYS LEAVE OFF (a family reads this page)",
  "- Availability and schedules: shift times, days, weekends, overnights, long hours, 'flexible'.",
  "- Where they live, service areas, travel, driving, a car, license numbers, contact details, age,",
  "  date of birth, pay.",
  "- Internal office notes: lift limits, coaching, AxisCare or other software, 'ideal client",
  "  match', placement considerations, deal-breakers.",
  "- Text written for one family's request, such as 'Why we recommend her'.",
  "- 'Active' after a credential, expired certifications, and credentials nobody has confirmed.",
  "- Medical tasks. Devoted Care is non-medical: write 'Medication reminders', never giving or",
  "  administering medication, and no catheter, injection or wound care. A nursing credential (LVN,",
  "  CNA) may still be stated as background.",
  "- Names of other agencies, employers or past clients, and health details about the caregiver.",
  "- Anything negative. Every line should read as a positive trait to a family.",
  "",
  "DO NOT REPEAT",
  "- Each fact appears once on the page.",
  "- About never restates the boxes. It carries only what the boxes do not say.",
  "- Drop near-synonyms within a list (Warm / Friendly, Compassionate / Empathetic), and a style",
  "  line that only restates a listed trait ('unhurried' when Calm and Patient are listed).",
  "- Do not repeat a box's title in its items: under care experience write 'Stroke', not 'Stroke",
  "  care'; 'Hospice', not 'Hospice care'.",
  "",
  "THE FIELDS",
  "- years: '4+' style when a total is known. When it is under a year or no total is given, write",
  "  the whole line instead: 'Caregiving Since November 2025'.",
  "- title: the confirmed credential, such as 'Registered Home Care Aide (HCA)'. With no confirmed",
  "  credential, 'Caregiver'. Languages go in bilingual, not here.",
  "- personality: single trait words.",
  "- communication: how they talk with clients or keep the family informed. Not paperwork.",
  "- reliability: only what the sources support, such as 'Reliable', 'Punctual'. A trait listed",
  "  under personality that is really about reliability belongs here instead. Never fill this box",
  "  with 'flexible' or with availability.",
  "- caregivingStyle: how they work with clients, such as 'Gives clients space when needed'.",
  "- skills: the dashboard skill tags, transfers and mobility first, then personal care, then",
  "  daily-living help.",
  "- careExperience: conditions from the dashboard's Experience section.",
  "- about: three to five short, plain, third-person sentences of BACKGROUND only: where they have",
  "  worked (private homes, a home care company, facilities, hospice), the kinds of clients, their",
  "  credential history ('was previously a CNA'), what references say, comfort with pets.",
  "Items are short sentence-case phrases with no full stop, in plain, simple, positive words. Never",
  "write placeholder text such as 'TBD' or 'N/A'.",
  "",
  "NOTES (always fill these in on a build; on a small edit they may be empty)",
  "- notes.builtFrom: one short line naming the sources used.",
  "- notes.leftOff: what you deliberately left off the page and, in a few words, why.",
  "- notes.confirm: conflicts between sources, and anything that looks filled in by default rather",
  "  than known, for the scheduler to check. Do not recap the resume.",
  "",
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
  "",
  "You may be shown one or more attached images or PDF pages - use them as reference for facts the",
  "instruction asks you to include; never invent what an attachment does not actually show.",
  "",
  "When the email is to a client's FAMILY, keep it short, warm and professional: introduce the",
  "caregiver, add one sentence of highlights, invite questions, give the office number",
  "(805) 419-6909, and sign off 'Devoted Care Services, LLC'. Leave out the caregiver's",
  "availability, where they live, driving and contact details.",
  "Write plain ASCII only: no en dashes, em dashes, curly quotes or ellipses.",
].join("\n");

async function callClaude(system: string, content: unknown, tool: Record<string, unknown>) {
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: (tool as { name: string }).name },
    messages: [{ role: "user", content }],
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
    return json(cors, 200, {
      ok: true, configured: !!KEY, model: MODEL, missing: KEY ? [] : ["ANTHROPIC_API_KEY"],
      /* Non-null only when RESUME_MODEL was set to something outside Sonnet/
         Haiku and got overridden - so a mistaken secret is visible here
         rather than quietly running the fallback forever. */
      modelOverridden: MODEL_OK ? null : RAW_MODEL,
    });
  }
  if (req.method !== "POST") return json(cors, 405, { ok: false, error: "Only POST is supported." });
  if (!KEY) return json(cors, 503, { ok: false, error: "AI assistance is not configured on the server (ANTHROPIC_API_KEY missing)." });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return json(cors, 429, { ok: false, error: "too many requests - try again shortly" });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(cors, 400, { ok: false, error: "Expected a JSON body." }); }

  /* 24000, not 2000: a .txt attachment is folded into this same string by the
     browser (RZATTACH) before it ever reaches here, so the cap has to leave
     room for that, not just a typed sentence. Still far short of a context
     the model cannot handle - roughly 6,000 tokens of plain text. */
  const prompt = String(body?.prompt ?? "").trim().slice(0, 24000);
  if (!prompt) return json(cors, 400, { ok: false, error: "A prompt is required." });
  const draft = stripDraft((body?.draft ?? {}) as Record<string, unknown>);
  const mode = body?.mode === "email" ? "email" : "edit";

  /* ATTACHMENTS — a screenshot, an old resume, a certificate. Validated here
     rather than trusted from the browser: a request is still just a request,
     and nothing stops someone calling this endpoint directly. Capped the
     same two ways the browser already caps them (RZATTACH_MAX_FILES,
     RZATTACH_MAX_BYTES) so a client that skipped its own limits does not get
     a free pass - these are the SAME numbers, not a second policy to keep in
     step; see index.html if either ever changes. */
  const ATTACH_MAX = 3, ATTACH_MAX_B64 = Math.ceil(5 * 1024 * 1024 * 4 / 3);
  const IMG_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
  const rawAttach = Array.isArray(body?.attachments) ? (body.attachments as Array<Record<string, unknown>>) : [];
  if (rawAttach.length > ATTACH_MAX) return json(cors, 400, { ok: false, error: "Up to " + ATTACH_MAX + " attachments at a time." });
  const contentBlocks: Array<Record<string, unknown>> = [];
  for (const a of rawAttach) {
    const mediaType = String(a?.mediaType ?? "");
    const data = String(a?.data ?? "");
    if (!data || data.length > ATTACH_MAX_B64) return json(cors, 400, { ok: false, error: "An attachment was missing or too large (5MB limit)." });
    if (!/^[A-Za-z0-9+/]+=*$/.test(data)) return json(cors, 400, { ok: false, error: "An attachment was not valid base64 data." });
    if (IMG_TYPES.has(mediaType)) {
      contentBlocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
    } else if (mediaType === "application/pdf") {
      contentBlocks.push({ type: "document", source: { type: "base64", media_type: mediaType, data } });
    } else {
      return json(cors, 400, { ok: false, error: "Attachments must be JPEG, PNG, WEBP, GIF or PDF." });
    }
  }

  const draftText = "Current resume draft (JSON):\n" + JSON.stringify(draft, null, 2) +
    "\n\nInstruction:\n" + prompt;
  /* Attachments BEFORE the text that refers to them - Anthropic's own
     guidance for multi-image/document requests, and the only order that
     reads naturally either way ("here is a screenshot; here is what I want
     done with it" rather than the other way round). A request with nothing
     attached sends a plain string, exactly as before - no behaviour change
     for the common case. */
  const content = contentBlocks.length ? [...contentBlocks, { type: "text", text: draftText }] : draftText;

  try {
    if (mode === "email") {
      const out = await callClaude(EMAIL_SYSTEM, content, EMAIL_TOOL);
      return json(cors, 200, {
        ok: true,
        subject: String(out.subject ?? "").slice(0, 300),
        body: String(out.body ?? "").slice(0, 8000),
      });
    }
    const out = await callClaude(EDIT_SYSTEM, content, EDIT_TOOL);
    const patch = stripDraft(out);
    /* NOTES ride beside the patch, never inside it: stripDraft() keeps only
       real resume fields, so a note can never be saved onto the resume or
       printed on the page a family reads. Capped like every other model
       output here, because it is arbitrary text. */
    const rawNotes = (out.notes ?? {}) as Record<string, unknown>;
    const list = (v: unknown) => Array.isArray(v)
      ? v.map((x) => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 12) : [];
    const notes = {
      builtFrom: String(rawNotes.builtFrom ?? "").trim().slice(0, 300),
      leftOff: list(rawNotes.leftOff),
      confirm: list(rawNotes.confirm),
    };
    return json(cors, 200, { ok: true, patch, notes });
  } catch (err) {
    const e = err as Error;
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return json(cors, timedOut ? 504 : 502, { ok: false, error: timedOut ? "The request timed out." : (e?.message || "Could not reach the model.") });
  }
});
