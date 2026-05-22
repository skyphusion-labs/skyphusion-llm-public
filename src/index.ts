// skyphusion-llm-public worker. Routes:
//   GET    /api/models             list models with type + capabilities, return user email
//   POST   /api/chat               run model, persist row, return result
//   GET    /api/history            list this user's chats, newest first
//   GET    /api/history/:id        one row (with attachments + output_artifact)
//   DELETE /api/history/:id        delete one row + its R2 objects
//   GET    /api/artifact/*         stream an R2 object (access-checked by user_email)
//   *                              served from ./public via Workers Assets
//
// Auth: Cloudflare Access. The worker trusts the
// Cf-Access-Authenticated-User-Email header to scope history per user.
// Local dev has no Access in front of it; user_email defaults to 'anonymous'.
// Do not deploy without Access in front.
//
// Multimodal model types:
//   - chat: text-generation models. Accepts vision attachments if the model
//     declares 'vision' in capabilities. Audio attachments are transcribed
//     via Whisper before the chat call. Video attachments are 8 client-
//     extracted keyframes plus the original file's audio track (also
//     transcribed). Output: text in chats.output.
//   - image: image-generation models (FLUX-1 schnell, Lucid Origin, Phoenix).
//     Input: user_input as prompt, system_prompt as negative_prompt.
//     Output: PNG written to R2, referenced via chats.output_artifact.
//   - tts: text-to-speech models (Aura-2, MeloTTS).
//     Input: user_input as text.
//     Output: audio written to R2, referenced via chats.output_artifact.
//
// Storage:
//   - All input + output artifacts go to R2.
//   - D1 stores R2 keys plus structured metadata.
//   - On DELETE /api/history/:id, R2 objects are removed too.
//   - Artifact ownership is enforced via customMetadata.user_email on the
//     R2 object plus a check in GET /api/artifact/*.

interface Env {
  AI: Ai;
  DB: D1Database;
  R2: R2Bucket;
  VEC: VectorizeIndex;
  ASSETS: Fetcher;
  GATEWAY_ID: string;
  ANTHROPIC_API_KEY?: string; // optional; preferred is to store in AI Gateway dashboard
  XAI_API_KEY?: string;       // optional; preferred is to store in AI Gateway dashboard
  GOOGLE_API_KEY?: string;    // optional; preferred is to store in AI Gateway dashboard
  CF_AIG_TOKEN?: string;      // only needed if gateway has Authenticated Gateway enabled
}

// ---------- Model catalog ----------

type ModelType = "chat" | "image" | "tts" | "video" | "stt" | "music";
type Provider =
  | "workers-ai"
  | "anthropic"
  | "xai"
  | "google"
  | "bytedance"
  | "minimax"
  | "runwayml"
  | "alibaba"
  | "pixverse"
  | "vidu";

interface ModelEntry {
  id: string;
  label: string;
  group: string;
  type: ModelType;
  capabilities: Array<"vision">;
  provider?: Provider; // defaults to "workers-ai" when omitted
  // For video models: if set, the worker uses the per-provider BYOK endpoint
  // (Gemini AI Studio for google/*, xAI direct for xai/*) instead of the
  // env.AI.run binding. The value is the model name expected by the direct
  // provider API (e.g. "veo-3.1-fast-generate-001" for Gemini AI Studio).
  // Without this, video gen requires Unified Billing on the AI Gateway.
  byok_alias?: string;
}

const MODELS: ModelEntry[] = [
  // ---- Chat (text generation) ----
  // Anthropic (BYOK via x-api-key or stored keys, routed through AI Gateway)
  { id: "anthropic/claude-opus-4-6",                    label: "Claude Opus 4.6 (Anthropic, BYOK)",          group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic" },
  { id: "anthropic/claude-sonnet-4-6",                  label: "Claude Sonnet 4.6 (Anthropic, BYOK)",        group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic" },
  { id: "anthropic/claude-haiku-4-5",                   label: "Claude Haiku 4.5 (Anthropic, BYOK)",         group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic" },

  // xAI / Grok (BYOK via Bearer auth or stored keys, routed through AI Gateway)
  { id: "xai/grok-4.3",                                 label: "Grok 4.3 (xAI, BYOK)",                       group: "Chat \u00b7 xAI",       type: "chat", capabilities: ["vision"], provider: "xai" },
  { id: "xai/grok-4.20-multi-agent-0309",               label: "Grok 4.20 Multi-Agent (xAI, BYOK)",          group: "Chat \u00b7 xAI",       type: "chat", capabilities: ["vision"], provider: "xai" },
  { id: "xai/grok-4.20-0309-reasoning",                 label: "Grok 4.20 Reasoning (xAI, BYOK)",            group: "Chat \u00b7 xAI",       type: "chat", capabilities: ["vision"], provider: "xai" },
  { id: "xai/grok-build-0.1",                           label: "Grok Build 0.1 (xAI, BYOK, coding)",         group: "Chat \u00b7 xAI",       type: "chat", capabilities: [],         provider: "xai" },

  // Google Gemini (BYOK via x-goog-api-key or stored keys, routed through AI Gateway)
  { id: "google/gemini-3.5-flash",                      label: "Gemini 3.5 Flash (Google, BYOK)",            group: "Chat \u00b7 Google",    type: "chat", capabilities: ["vision"], provider: "google" },
  { id: "google/gemini-3.1-pro-preview",                label: "Gemini 3.1 Pro (Google, BYOK)",              group: "Chat \u00b7 Google",    type: "chat", capabilities: ["vision"], provider: "google" },
  { id: "google/gemini-3.1-flash",                      label: "Gemini 3.1 Flash (Google, BYOK)",            group: "Chat \u00b7 Google",    type: "chat", capabilities: ["vision"], provider: "google" },
  { id: "google/gemini-2.5-pro",                        label: "Gemini 2.5 Pro (Google, BYOK)",              group: "Chat \u00b7 Google",    type: "chat", capabilities: ["vision"], provider: "google" },

  // Frontier
  { id: "@cf/moonshotai/kimi-k2.6",                     label: "Kimi K2.6 (1T)",               group: "Chat \u00b7 Frontier", type: "chat", capabilities: ["vision"] },
  { id: "@cf/openai/gpt-oss-120b",                      label: "GPT-OSS 120B (reasoning)",     group: "Chat \u00b7 Frontier", type: "chat", capabilities: [] },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct",      label: "Llama 4 Scout (MoE, vision)",  group: "Chat \u00b7 Frontier", type: "chat", capabilities: ["vision"] },
  { id: "@cf/google/gemma-4-26b-a4b-it",                label: "Gemma 4 26B (vision)",         group: "Chat \u00b7 Frontier", type: "chat", capabilities: ["vision"] },
  // OpenAI open weights
  { id: "@cf/openai/gpt-oss-20b",                       label: "GPT-OSS 20B",                  group: "Chat \u00b7 OpenAI",   type: "chat", capabilities: [] },
  // Meta
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",     label: "Llama 3.3 70B (fp8)",          group: "Chat \u00b7 Meta",     type: "chat", capabilities: [] },
  { id: "@cf/meta/llama-3.2-11b-vision-instruct",       label: "Llama 3.2 11B (vision)",       group: "Chat \u00b7 Meta",     type: "chat", capabilities: ["vision"] },
  { id: "@cf/meta/llama-3.2-3b-instruct",               label: "Llama 3.2 3B",                 group: "Chat \u00b7 Meta",     type: "chat", capabilities: [] },
  // Qwen
  { id: "@cf/qwen/qwen3-30b-a3b-fp8",                   label: "Qwen3 30B MoE",                group: "Chat \u00b7 Qwen",     type: "chat", capabilities: [] },
  { id: "@cf/qwen/qwq-32b",                             label: "QwQ 32B (reasoning)",          group: "Chat \u00b7 Qwen",     type: "chat", capabilities: [] },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct",          label: "Qwen2.5 Coder 32B",            group: "Chat \u00b7 Qwen",     type: "chat", capabilities: [] },
  // Other
  { id: "@cf/deepseek/deepseek-r1-distill-qwen-32b",    label: "DeepSeek R1 32B",              group: "Chat \u00b7 Other",    type: "chat", capabilities: [] },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 (vision)",   group: "Chat \u00b7 Other",    type: "chat", capabilities: ["vision"] },
  { id: "@cf/zai-org/glm-4.7-flash",                    label: "GLM-4.7 Flash (Z.AI, 100+ lang)", group: "Chat \u00b7 Other", type: "chat", capabilities: [] },
  { id: "@cf/nvidia/nemotron-3-120b-a12b",              label: "Nemotron 3 120B (NVIDIA, agentic)", group: "Chat \u00b7 Other", type: "chat", capabilities: [] },
  { id: "@cf/google/gemma-3-12b-it",                    label: "Gemma 3 12B (vision, 128K)",   group: "Chat \u00b7 Google",   type: "chat", capabilities: ["vision"] },
  { id: "@cf/ibm-granite/granite-4.0-h-micro",          label: "Granite 4.0 Micro (IBM)",      group: "Chat \u00b7 Other",    type: "chat", capabilities: [] },
  { id: "@hf/nousresearch/hermes-2-pro-mistral-7b",     label: "Hermes 2 Pro (function calling)", group: "Chat \u00b7 Other", type: "chat", capabilities: [] },
  { id: "@cf/meta/llama-3.2-1b-instruct",               label: "Llama 3.2 1B (tiny, cheap)",   group: "Chat \u00b7 Meta",     type: "chat", capabilities: [] },

  // ---- Image generation ----
  { id: "@cf/black-forest-labs/flux-2-klein-9b",        label: "FLUX 2 Klein 9B (frontier)",   group: "Image Gen",            type: "image", capabilities: [] },
  { id: "@cf/black-forest-labs/flux-2-klein-4b",        label: "FLUX 2 Klein 4B (faster)",     group: "Image Gen",            type: "image", capabilities: [] },
  { id: "@cf/black-forest-labs/flux-2-dev",             label: "FLUX 2 Dev (multi-reference)", group: "Image Gen",            type: "image", capabilities: [] },
  { id: "@cf/black-forest-labs/flux-1-schnell",         label: "FLUX-1 schnell (fast)",        group: "Image Gen",            type: "image", capabilities: [] },
  { id: "@cf/leonardo/lucid-origin",                    label: "Lucid Origin (Leonardo)",      group: "Image Gen",            type: "image", capabilities: [] },
  { id: "@cf/leonardo/phoenix-1.0",                     label: "Phoenix 1.0 (Leonardo)",       group: "Image Gen",            type: "image", capabilities: [] },
  { id: "@cf/lykon/dreamshaper-8-lcm",                  label: "Dreamshaper 8 LCM (fast SD)",  group: "Image Gen",            type: "image", capabilities: [] },

  // ---- Text-to-speech ----
  { id: "@cf/deepgram/aura-2-en",                       label: "Aura-2 English (Deepgram)",    group: "TTS",                  type: "tts",   capabilities: [] },
  { id: "@cf/deepgram/aura-2-es",                       label: "Aura-2 Spanish (Deepgram)",    group: "TTS",                  type: "tts",   capabilities: [] },
  { id: "@cf/myshell/melotts",                          label: "MeloTTS (multilingual)",       group: "TTS",                  type: "tts",   capabilities: [] },

  // ---- Speech-to-text (Whisper) ----
  // Attach an audio file, pick a model, get the transcript. Audio file is
  // required; everything else (prompt, system prompt) is ignored.
  { id: "@cf/openai/whisper-large-v3-turbo",            label: "Whisper Large v3 Turbo (best)", group: "Speech-to-text",      type: "stt",   capabilities: [] },
  { id: "@cf/openai/whisper",                           label: "Whisper (general purpose)",    group: "Speech-to-text",       type: "stt",   capabilities: [] },
  { id: "@cf/openai/whisper-tiny-en",                   label: "Whisper Tiny EN (fast, beta)", group: "Speech-to-text",       type: "stt",   capabilities: [] },

  // ---- Music generation (Unified Billing only) ----
  { id: "minimax/music-2.6",                            label: "MiniMax Music 2.6 (needs CF credits)", group: "Music Gen",     type: "music", capabilities: [], provider: "minimax" },

  // ---- Video generation (Cloudflare Unified Billing via env.AI.run) ----
  // All routed through env.AI.run("provider/model", ...) - CF handles auth and
  // billing. No BYOK to xAI/Google/etc needed for these models.
  { id: "google/veo-3.1",                               label: "Veo 3.1 (Google, BYOK)",                           group: "Video Gen", type: "video", capabilities: [], provider: "google",   byok_alias: "veo-3.1-generate-preview" },
  { id: "google/veo-3.1-fast",                          label: "Veo 3.1 Fast (Google, BYOK)",                      group: "Video Gen", type: "video", capabilities: [], provider: "google",   byok_alias: "veo-3.1-fast-generate-001" },
  { id: "google/veo-3",                                 label: "Veo 3 (Google, needs CF credits)",                 group: "Video Gen", type: "video", capabilities: [], provider: "google" },
  { id: "google/veo-3-fast",                            label: "Veo 3 Fast (Google, needs CF credits)",            group: "Video Gen", type: "video", capabilities: [], provider: "google" },
  { id: "bytedance/seedance-2.0",                       label: "Seedance 2.0 (ByteDance, needs CF credits)",       group: "Video Gen", type: "video", capabilities: [], provider: "bytedance" },
  { id: "bytedance/seedance-2.0-fast",                  label: "Seedance 2.0 Fast (ByteDance, needs CF credits)",  group: "Video Gen", type: "video", capabilities: [], provider: "bytedance" },
  { id: "minimax/hailuo-2.3",                           label: "Hailuo 2.3 (MiniMax, needs CF credits)",           group: "Video Gen", type: "video", capabilities: [], provider: "minimax" },
  { id: "minimax/hailuo-2.3-fast",                      label: "Hailuo 2.3 Fast (MiniMax, needs CF credits)",      group: "Video Gen", type: "video", capabilities: [], provider: "minimax" },
  { id: "xai/grok-imagine-video",                       label: "Grok Imagine Video (xAI, BYOK)",                   group: "Video Gen", type: "video", capabilities: [], provider: "xai",      byok_alias: "grok-imagine-video" },
  { id: "runwayml/gen-4.5",                             label: "Gen-4.5 (RunwayML, needs CF credits)",             group: "Video Gen", type: "video", capabilities: [], provider: "runwayml" },
  { id: "alibaba/hh1-t2v",                              label: "HappyHorse 1.0 (Alibaba, img2vid, needs CF credits)", group: "Video Gen", type: "video", capabilities: [], provider: "alibaba" },
  { id: "pixverse/v6",                                  label: "PixVerse v6 (needs CF credits)",                   group: "Video Gen", type: "video", capabilities: [], provider: "pixverse" },
  { id: "pixverse/v5.6",                                label: "PixVerse v5.6 (needs CF credits)",                 group: "Video Gen", type: "video", capabilities: [], provider: "pixverse" },
  { id: "vidu/q3-pro",                                  label: "Vidu Q3 Pro (needs CF credits)",                   group: "Video Gen", type: "video", capabilities: [], provider: "vidu" },
  { id: "vidu/q3-turbo",                                label: "Vidu Q3 Turbo (needs CF credits)",                 group: "Video Gen", type: "video", capabilities: [], provider: "vidu" },
];

const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

// ---------- Types ----------

interface InputAttachment {
  type: "image" | "audio" | "video_frames";
  filename?: string;
  mime?: string;
  data?: string;       // data URL (image / audio)
  frames?: string[];   // data URLs (video_frames)
  duration?: number;
}

interface ChatRequest {
  model: string;
  system_prompt?: string;
  user_input: string;
  attachments?: InputAttachment[];
  use_docs?: boolean;   // Pass 2: when true, retrieve top-K chunks from Vectorize and inject as context
}

interface RetrievedChunk {
  document_id: number;
  filename: string;
  chunk_index: number;
  text: string;
  score: number;
}

interface PersistedImageAttachment {
  type: "image";
  key: string;
  mime?: string;
  filename?: string;
}
interface PersistedAudioAttachment {
  type: "audio";
  mime?: string;
  filename?: string;
  transcript: string | null;
}
interface PersistedVideoFramesAttachment {
  type: "video_frames";
  keys: string[];
  frame_count: number;
  duration?: number;
  filename?: string;
}
type PersistedAttachment =
  | PersistedImageAttachment
  | PersistedAudioAttachment
  | PersistedVideoFramesAttachment;

interface OutputArtifact {
  key: string;
  mime: string;
  type: "image" | "audio" | "video";
}

// ---------- Helpers ----------

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function getUserEmail(request: Request): string {
  return request.headers.get("cf-access-authenticated-user-email") ?? "anonymous";
}

function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mime: match[1], base64: match[2] };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("png"))  return "png";
  if (m.includes("jpeg")) return "jpg";
  if (m.includes("jpg"))  return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif"))  return "gif";
  if (m.includes("mp3"))  return "mp3";
  if (m.includes("mpeg")) return "mp3";
  if (m.includes("wav"))  return "wav";
  if (m.includes("ogg"))  return "ogg";
  if (m.includes("webm")) return "webm";
  if (m.includes("m4a"))  return "m4a";
  return "bin";
}

async function r2Put(env: Env, prefix: "in" | "out", mime: string, bytes: Uint8Array, userEmail: string): Promise<string> {
  const key = `${prefix}/${crypto.randomUUID()}.${extFromMime(mime)}`;
  await env.R2.put(key, bytes, {
    httpMetadata: { contentType: mime },
    customMetadata: { user_email: userEmail },
  });
  return key;
}

async function r2DeleteSafe(env: Env, key: string): Promise<void> {
  try { await env.R2.delete(key); } catch { /* ignore */ }
}

// Untyped binding wrapper.
type RunOpts = { gateway: { id: string }; returnRawResponse?: boolean };
type RunFn = (model: string, params: unknown, opts?: RunOpts) => Promise<unknown>;
function aiRun(env: Env, model: string, params: unknown, returnRaw = false): Promise<unknown> {
  const opts: RunOpts = { gateway: { id: env.GATEWAY_ID } };
  if (returnRaw) opts.returnRawResponse = true;
  return (env.AI as unknown as { run: RunFn }).run(model, params, opts);
}
function aiLogId(env: Env): string | null {
  return (env.AI as unknown as { aiGatewayLogId?: string }).aiGatewayLogId ?? null;
}

// ---------- Router ----------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/models" && request.method === "GET") {
      return json({ models: MODELS, user: getUserEmail(request) });
    }
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env, ctx);
    }
    if (url.pathname === "/api/history" && request.method === "GET") {
      return handleHistoryList(request, env);
    }

    if (url.pathname === "/api/documents") {
      if (request.method === "GET")  return handleDocumentList(request, env);
      if (request.method === "POST") return handleDocumentUpload(request, env);
    }

    const d = url.pathname.match(/^\/api\/documents\/(\d+)$/);
    if (d) {
      const id = Number(d[1]);
      if (request.method === "GET")    return handleDocumentGet(request, env, id);
      if (request.method === "DELETE") return handleDocumentDelete(request, env, id);
    }

    const h = url.pathname.match(/^\/api\/history\/(\d+)$/);
    if (h) {
      const id = Number(h[1]);
      if (request.method === "GET")    return handleHistoryGet(request, env, id);
      if (request.method === "DELETE") return handleHistoryDelete(request, env, id);
    }

    const j = url.pathname.match(/^\/api\/job\/(\d+)$/);
    if (j && request.method === "GET") {
      return handleJobPoll(request, env, Number(j[1]));
    }

    const a = url.pathname.match(/^\/api\/artifact\/(.+)$/);
    if (a && request.method === "GET") {
      return handleArtifact(request, env, decodeURIComponent(a[1]));
    }

    return env.ASSETS.fetch(request);
  },
};

// ---------- /api/chat ----------

async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: ChatRequest;
  try {
    body = await request.json<ChatRequest>();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.model || !body.user_input) {
    return json({ error: "model and user_input are required" }, { status: 400 });
  }
  const model = MODELS.find((x) => x.id === body.model);
  if (!model) {
    return json({ error: `Unknown model: ${body.model}` }, { status: 400 });
  }

  if (model.type === "chat") return runChat(request, env, model, body);
  if (model.type === "image") return runImage(request, env, model, body);
  if (model.type === "tts") return runTts(request, env, model, body);
  if (model.type === "video") return runVideo(request, env, ctx, model, body);
  if (model.type === "stt") return runStt(request, env, model, body);
  if (model.type === "music") return runMusic(request, env, ctx, model, body);
  return json({ error: `Unsupported model type: ${model.type}` }, { status: 500 });
}

// ---------- Chat (text generation, multimodal in) ----------

async function runChat(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = getUserEmail(request);
  const inputs: InputAttachment[] = body.attachments ?? [];

  // Walk inputs: write images / video frames to R2, transcribe audio via
  // Whisper. Build three parallel structures used after the loop:
  //   - extraText: prompt snippets the LLM sees
  //   - imageDataUrls: data URLs the LLM sees as image_url blocks
  //   - persistedAtt: per-attachment storage records
  const extraText: string[] = [];
  const imageDataUrls: string[] = [];
  const persistedAtt: PersistedAttachment[] = [];

  for (const att of inputs) {
    if (att.type === "image") {
      if (!model.capabilities.includes("vision")) {
        return json({ error: `Model ${model.id} does not support vision. Pick a vision-capable chat model or remove the image.` }, { status: 400 });
      }
      const parsed = att.data ? parseDataUrl(att.data) : null;
      if (!parsed) return json({ error: "Invalid image data URL" }, { status: 400 });
      const bytes = base64ToBytes(parsed.base64);
      const key = await r2Put(env, "in", parsed.mime, bytes, userEmail);
      imageDataUrls.push(att.data!);
      persistedAtt.push({ type: "image", key, mime: parsed.mime, filename: att.filename });
    } else if (att.type === "audio") {
      const parsed = att.data ? parseDataUrl(att.data) : null;
      if (!parsed) return json({ error: "Invalid audio data URL" }, { status: 400 });
      try {
        const wr = await aiRun(env, WHISPER_MODEL, { audio: parsed.base64 });
        const text = (wr as { text?: string })?.text?.trim() ?? "";
        const label = att.filename ? ` from ${att.filename}` : "";
        extraText.push(text
          ? `[Transcribed audio${label}]\n${text}`
          : `[Audio attachment${label} transcribed to empty text]`);
        persistedAtt.push({ type: "audio", mime: parsed.mime, filename: att.filename, transcript: text || null });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        return json({ error: `Audio transcription failed: ${m}` }, { status: 502 });
      }
    } else if (att.type === "video_frames") {
      if (!model.capabilities.includes("vision")) {
        return json({ error: `Model ${model.id} does not support vision. Video frames require a vision-capable chat model.` }, { status: 400 });
      }
      const frames = att.frames ?? [];
      const keys: string[] = [];
      for (const fdataUrl of frames) {
        const parsed = parseDataUrl(fdataUrl);
        if (!parsed) continue;
        const bytes = base64ToBytes(parsed.base64);
        const k = await r2Put(env, "in", parsed.mime, bytes, userEmail);
        keys.push(k);
        imageDataUrls.push(fdataUrl);
      }
      const dur = att.duration ? ` ${att.duration.toFixed(1)}s` : "";
      const fn = att.filename ? ` "${att.filename}"` : "";
      extraText.push(`[Video${fn}${dur}, ${frames.length} evenly-sampled frames attached below]`);
      persistedAtt.push({ type: "video_frames", keys, frame_count: keys.length, duration: att.duration, filename: att.filename });
    }
  }

  const userText = [body.user_input, ...extraText].filter(Boolean).join("\n\n");
  const userContent: unknown = imageDataUrls.length
    ? [{ type: "text", text: userText }, ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } }))]
    : userText;

  // ---- RAG retrieval (Pass 2) ----
  // When body.use_docs is true, embed the user's prompt, fetch top-K chunks
  // from Vectorize, and fold them into the system prompt so the model sees
  // them as reference material. We use body.user_input (the textual prompt)
  // as the query - attachment transcripts could be added but for now this
  // keeps retrieval signal focused on what the user actually typed.
  let retrievedChunks: RetrievedChunk[] = [];
  if (body.use_docs) {
    retrievedChunks = await retrieveContext(env, userEmail, body.user_input);
  }

  // Build the effective system prompt: user-supplied prompt followed by
  // the retrieval block. If only one is present, use that one alone.
  const userSystemPrompt = body.system_prompt?.trim() ?? "";
  const retrievalBlock = retrievedChunks.length ? formatRetrievalForSystemPrompt(retrievedChunks) : "";
  const effectiveSystemPrompt =
    userSystemPrompt && retrievalBlock ? `${userSystemPrompt}\n\n${retrievalBlock}` :
    retrievalBlock || userSystemPrompt || "";

  const messages: Array<unknown> = [];
  if (effectiveSystemPrompt) {
    messages.push({ role: "system", content: effectiveSystemPrompt });
  }
  messages.push({ role: "user", content: userContent });

  const start = Date.now();
  let result: unknown;
  let logId: string | null = null;
  try {
    if (model.provider === "anthropic") {
      const r = await callAnthropic(env, model, effectiveSystemPrompt || undefined, messages);
      result = r.raw;
      logId = r.logId;
    } else if (model.provider === "xai") {
      const r = await callXai(env, model, messages);
      result = r.raw;
      logId = r.logId;
    } else if (model.provider === "google") {
      const r = await callGoogle(env, model, effectiveSystemPrompt || undefined, messages);
      result = r.raw;
      logId = r.logId;
    } else {
      result = await aiRun(env, model.id, { messages });
      logId = aiLogId(env);
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `AI call failed: ${m}` }, { status: 502 });
  }

  const latency = Date.now() - start;
  const output = extractOutput(result);
  const usage = extractUsage(result);

  const row = await persistChat(env, {
    userEmail,
    model: model.id,
    model_type: "chat",
    system_prompt: body.system_prompt ?? null,
    user_input: body.user_input,
    output,
    output_artifact: null,
    attachments: persistedAtt,
    tokens_in: usage.in_,
    tokens_out: usage.out_,
    latency_ms: latency,
    ai_gateway_log_id: logId,
    retrieved_context: retrievedChunks.length ? retrievedChunks : null,
  });

  return json({
    id: row.id,
    created_at: row.created_at,
    model: model.id,
    model_type: "chat",
    output,
    tokens_in: usage.in_,
    tokens_out: usage.out_,
    latency_ms: latency,
    ai_gateway_log_id: logId,
    transcripts: extraText,
    retrieved_chunks: retrievedChunks,
  });
}

// ---------- Image generation ----------

async function runImage(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = getUserEmail(request);

  const params: Record<string, unknown> = {
    prompt: body.user_input,
    width: 1024,
    height: 1024,
    steps: 25,
  };
  if (body.system_prompt && body.system_prompt.trim()) {
    params.negative_prompt = body.system_prompt;
  }

  // FLUX-1 schnell uses fewer steps and has no negative_prompt.
  if (model.id === "@cf/black-forest-labs/flux-1-schnell") {
    params.steps = 4;
    delete params.negative_prompt;
  }

  const start = Date.now();
  let result: unknown;
  let logId: string | null = null;
  try {
    result = await aiRun(env, model.id, params);
    logId = aiLogId(env);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `Image generation failed: ${m}` }, { status: 502 });
  }
  const latency = Date.now() - start;

  // Response shape is { image: base64 } for FLUX-1 / Lucid / Phoenix.
  const b64 = (result as { image?: string })?.image;
  if (!b64 || typeof b64 !== "string") {
    return json({ error: "Image generation returned no image", raw: result }, { status: 502 });
  }
  const bytes = base64ToBytes(b64);
  // JPEG is the de facto output for FLUX-1; Leonardo also returns JPEG-ish.
  // Sniff would be more correct but cost outweighs benefit at this scale.
  const mime = "image/jpeg";
  const key = await r2Put(env, "out", mime, bytes, userEmail);
  const outputArtifact: OutputArtifact = { key, mime, type: "image" };

  const row = await persistChat(env, {
    userEmail,
    model: model.id,
    model_type: "image",
    system_prompt: body.system_prompt ?? null,
    user_input: body.user_input,
    output: "",
    output_artifact: outputArtifact,
    attachments: [],
    tokens_in: null,
    tokens_out: null,
    latency_ms: latency,
    ai_gateway_log_id: logId,
  });

  return json({
    id: row.id,
    created_at: row.created_at,
    model: model.id,
    model_type: "image",
    output: "",
    output_artifact: outputArtifact,
    latency_ms: latency,
    ai_gateway_log_id: logId,
  });
}

// ---------- TTS ----------

async function runTts(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = getUserEmail(request);

  // Aura: { text }; MeloTTS: { prompt, lang? }. Send both keys defensively.
  const params: Record<string, unknown> = { text: body.user_input, prompt: body.user_input };

  const start = Date.now();
  let resp: unknown;
  let logId: string | null = null;
  try {
    resp = await aiRun(env, model.id, params, true /* returnRawResponse */);
    logId = aiLogId(env);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `TTS failed: ${m}` }, { status: 502 });
  }
  const latency = Date.now() - start;

  // returnRawResponse gives us a Response object with audio bytes.
  if (!(resp instanceof Response)) {
    return json({ error: "TTS returned non-Response shape", raw: resp }, { status: 502 });
  }
  const mime = resp.headers.get("content-type") || "audio/mpeg";
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const key = await r2Put(env, "out", mime, bytes, userEmail);
  const outputArtifact: OutputArtifact = { key, mime, type: "audio" };

  const row = await persistChat(env, {
    userEmail,
    model: model.id,
    model_type: "tts",
    system_prompt: null,
    user_input: body.user_input,
    output: "",
    output_artifact: outputArtifact,
    attachments: [],
    tokens_in: null,
    tokens_out: null,
    latency_ms: latency,
    ai_gateway_log_id: logId,
  });

  return json({
    id: row.id,
    created_at: row.created_at,
    model: model.id,
    model_type: "tts",
    output: "",
    output_artifact: outputArtifact,
    latency_ms: latency,
    ai_gateway_log_id: logId,
  });
}

// ---------- Speech-to-text (Whisper) ----------
//
// Synchronous: user attaches an audio file and picks a Whisper model, worker
// calls Whisper directly and returns the transcript as the row's `output`
// text. No D1 status='pending' or polling - Whisper completes in seconds.
// Reuses the existing audio attachment shape from the chat path.

async function runStt(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = getUserEmail(request);
  const t0 = Date.now();

  const audioAtt = (body.attachments ?? []).find((a) => a.type === "audio");
  if (!audioAtt?.data) {
    return json({ error: "Please attach an audio file to transcribe" }, { status: 400 });
  }
  const parsed = parseDataUrl(audioAtt.data);
  if (!parsed) return json({ error: "Invalid audio data URL" }, { status: 400 });

  let transcript: string;
  try {
    const wr = await aiRun(env, model.id, { audio: parsed.base64 });
    transcript = (wr as { text?: string })?.text?.trim() ?? "";
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `Transcription failed: ${m}` }, { status: 502 });
  }

  const latency = Date.now() - t0;
  // Persist the audio's transcript on the attachment record but not the
  // raw audio bytes (same convention as the chat path).
  const persistedAtt: PersistedAttachment[] = [{
    type: "audio",
    mime: parsed.mime,
    filename: audioAtt.filename,
    transcript: transcript || null,
  }];

  const row = await persistChat(env, {
    userEmail,
    model: model.id,
    model_type: "stt",
    system_prompt: body.system_prompt ?? null,
    user_input: body.user_input || "(audio attachment)",
    output: transcript || "(empty transcript)",
    output_artifact: null,
    attachments: persistedAtt,
    tokens_in: null,
    tokens_out: null,
    latency_ms: latency,
    ai_gateway_log_id: aiLogId(env),
  });

  return json({
    id: row.id,
    created_at: row.created_at,
    model: model.id,
    model_type: "stt",
    output: transcript,
    output_artifact: null,
    latency_ms: latency,
  });
}

// ---------- Music generation (MiniMax via Unified Billing) ----------
//
// Same async architecture as video gen: write pending row, schedule the
// actual env.AI.run call via ctx.waitUntil, fetch the result audio, store
// in R2, mark done. Client polls /api/job/:id (no provider calls).
//
// User input maps to fields:
//   body.user_input    -> "prompt" (style/mood description, ~10-300 chars)
//   body.system_prompt -> "lyrics" (optional, supports [Verse]/[Chorus] tags)
//
// Output shape from the docs example: { audio: "https://...mp3" }

interface MusicGenResult {
  audio?: string;
  state?: string;
  result?: { audio?: string };
  gatewayMetadata?: { keySource?: string };
}

async function runMusic(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  model: ModelEntry,
  body: ChatRequest
): Promise<Response> {
  const userEmail = getUserEmail(request);
  const startedAt = new Date().toISOString();

  const row = await persistChat(env, {
    userEmail,
    model: model.id,
    model_type: "music",
    system_prompt: body.system_prompt ?? null,
    user_input: body.user_input,
    output: "",
    output_artifact: null,
    attachments: [],
    tokens_in: null,
    tokens_out: null,
    latency_ms: 0,
    ai_gateway_log_id: null,
    status: "pending",
    job_id: null,
    job_provider: model.provider ?? null,
    job_error: null,
    job_started_at: startedAt,
  });

  ctx.waitUntil(
    generateMusicBackground(env, row.id, userEmail, model.id, body.user_input, body.system_prompt ?? "", startedAt)
  );

  return json({
    id: row.id,
    created_at: row.created_at,
    model: model.id,
    model_type: "music",
    output: "",
    output_artifact: null,
    status: "pending",
    job_started_at: startedAt,
  });
}

async function generateMusicBackground(
  env: Env,
  rowId: number,
  userEmail: string,
  modelId: string,
  prompt: string,
  lyrics: string,
  startedAtIso: string
): Promise<void> {
  const failRow = async (msg: string) => {
    try {
      await env.DB.prepare(`UPDATE chats SET status = 'failed', job_error = ? WHERE id = ?`)
        .bind(msg.slice(0, 1000), rowId)
        .run();
    } catch { /* swallow - background task */ }
  };

  // Build the request body. Send `lyrics` only if non-empty; some wrappers
  // may reject empty strings.
  const params: Record<string, unknown> = { prompt };
  if (lyrics && lyrics.trim()) params.lyrics = lyrics;

  let result: MusicGenResult;
  try {
    result = await aiRun(env, modelId, params) as MusicGenResult;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await failRow(`env.AI.run failed: ${m}`);
    return;
  }

  // Extract audio URL. The docs show flat shape `{ audio: "..." }`; we also
  // accept `{ result: { audio: "..." } }` and `{ state: "Completed", result: {...} }`
  // in case CF normalizes other providers' shapes.
  const audioUrl = result?.audio ?? result?.result?.audio;
  if (!audioUrl) {
    await failRow(`Gen returned no audio URL. Raw: ${JSON.stringify(result).slice(0, 500)}`);
    return;
  }

  // Re-host in our R2 (the MiniMax-hosted URL on aliyuncs.com may be
  // temporary; we control the lifecycle by storing locally).
  let bytes: Uint8Array;
  let mime = "audio/mpeg";
  try {
    const aresp = await fetch(audioUrl);
    if (!aresp.ok) throw new Error(`Fetch ${aresp.status}`);
    mime = aresp.headers.get("content-type") || "audio/mpeg";
    bytes = new Uint8Array(await aresp.arrayBuffer());
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await failRow(`Audio download failed: ${m}`);
    return;
  }

  let r2Key: string;
  try {
    r2Key = await r2Put(env, "out", mime, bytes, userEmail);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await failRow(`R2 upload failed: ${m}`);
    return;
  }

  const outputArtifact: OutputArtifact = { key: r2Key, mime, type: "audio" };
  const latency = Date.now() - Date.parse(startedAtIso);

  try {
    await env.DB.prepare(
      `UPDATE chats SET status = 'done', output_artifact = ?, latency_ms = ? WHERE id = ?`
    )
      .bind(JSON.stringify(outputArtifact), latency, rowId)
      .run();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await failRow(`D1 finalize failed: ${m}`);
  }
}

// ---------- Persistence ----------

interface PersistArgs {
  userEmail: string;
  model: string;
  model_type: ModelType;
  system_prompt: string | null;
  user_input: string;
  output: string;
  output_artifact: OutputArtifact | null;
  attachments: PersistedAttachment[];
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number;
  ai_gateway_log_id: string | null;
  status?: "pending" | "done" | "failed";
  job_id?: string | null;
  job_provider?: string | null;
  job_error?: string | null;
  job_started_at?: string | null;
  retrieved_context?: RetrievedChunk[] | null;
}

async function persistChat(env: Env, a: PersistArgs): Promise<{ id: number; created_at: string }> {
  const row = await env.DB.prepare(
    `INSERT INTO chats
       (user_email, model, model_type, system_prompt, user_input, output,
        output_artifact, attachments,
        tokens_in, tokens_out, latency_ms, ai_gateway_log_id,
        status, job_id, job_provider, job_error, job_started_at,
        retrieved_context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id, created_at`
  )
    .bind(
      a.userEmail, a.model, a.model_type, a.system_prompt, a.user_input, a.output,
      a.output_artifact ? JSON.stringify(a.output_artifact) : null,
      a.attachments.length ? JSON.stringify(a.attachments) : null,
      a.tokens_in, a.tokens_out, a.latency_ms, a.ai_gateway_log_id,
      a.status ?? "done",
      a.job_id ?? null,
      a.job_provider ?? null,
      a.job_error ?? null,
      a.job_started_at ?? null,
      a.retrieved_context && a.retrieved_context.length ? JSON.stringify(a.retrieved_context) : null
    )
    .first<{ id: number; created_at: string }>();
  return row ?? { id: 0, created_at: new Date().toISOString() };
}

// ---------- Anthropic BYOK call ----------
//
// Direct fetch to the Anthropic provider endpoint of AI Gateway. The gateway
// wraps the call for observability, caching, and rate-limiting.
//
// Auth strategy: stored-keys-first. If env.ANTHROPIC_API_KEY is set, we send
// it as x-api-key (inline auth, takes priority at the gateway). If it isn't,
// we omit the header and let the gateway inject the key you've stored in
// dashboard > AI Gateway > Provider Keys. Either path works.
//
// The message format coming in is OpenAI-style (role + content array with
// text / image_url blocks). We transform to Anthropic's Messages API shape:
// system pulled to a top-level field, image_url blocks rewritten as image
// blocks with base64 source.

async function callAnthropic(
  env: Env,
  model: ModelEntry,
  systemPrompt: string | undefined,
  messages: Array<unknown>
): Promise<{ raw: unknown; logId: string | null }> {
  const { system, messages: aMessages } = transformToAnthropic(messages, systemPrompt);

  const baseUrl = await (env.AI as unknown as {
    gateway: (id: string) => { getUrl: (provider: string) => Promise<string> };
  }).gateway(env.GATEWAY_ID).getUrl("anthropic");

  // Strip the "anthropic/" prefix we use in our internal IDs; Anthropic's API
  // expects just the model name (e.g. "claude-opus-4-6").
  const modelName = model.id.replace(/^anthropic\//, "");

  const body: Record<string, unknown> = {
    model: modelName,
    max_tokens: 4096,
    messages: aMessages,
  };
  if (system) body.system = system;

  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (env.ANTHROPIC_API_KEY) headers["x-api-key"] = env.ANTHROPIC_API_KEY;
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const logId = resp.headers.get("cf-aig-log-id");

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${errText.slice(0, 500)}`);
  }

  const raw = await resp.json();
  return { raw, logId };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: Array<unknown>;
}

function transformToAnthropic(
  messages: Array<unknown>,
  systemPromptOverride: string | undefined
): { system: string | undefined; messages: AnthropicMessage[] } {
  let system: string | undefined = systemPromptOverride && systemPromptOverride.trim()
    ? systemPromptOverride
    : undefined;
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    const msg = m as { role: string; content: unknown };
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : "";
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: [{ type: "text", text: msg.content }] });
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    const content: Array<unknown> = [];
    for (const block of msg.content) {
      const b = block as { type?: string; text?: string; image_url?: { url?: string } };
      if (b.type === "text" && typeof b.text === "string") {
        content.push({ type: "text", text: b.text });
      } else if (b.type === "image_url" && b.image_url?.url) {
        const parsed = parseDataUrl(b.image_url.url);
        if (parsed) {
          content.push({
            type: "image",
            source: { type: "base64", media_type: parsed.mime, data: parsed.base64 },
          });
        }
      }
    }
    out.push({ role: msg.role, content });
  }

  return { system, messages: out };
}

// ---------- xAI BYOK call ----------
//
// xAI's API is OpenAI-compatible (same wire format), so no message transform
// is needed. Routed through AI Gateway's xAI provider endpoint for caching,
// logging, and rate-limiting.
//
// Auth strategy: stored-keys-first. If env.XAI_API_KEY is set, we send it as
// Authorization: Bearer (inline auth, takes priority at the gateway). If it
// isn't, we omit the header and let the gateway inject the key you've stored
// in dashboard > AI Gateway > Provider Keys. Either path works.
//
// Note: Grok 4.x models are reasoning models that expect max_completion_tokens
// rather than the older max_tokens field.

async function callXai(
  env: Env,
  model: ModelEntry,
  messages: Array<unknown>
): Promise<{ raw: unknown; logId: string | null }> {
  const baseUrl = await (env.AI as unknown as {
    gateway: (id: string) => { getUrl: (provider: string) => Promise<string> };
  }).gateway(env.GATEWAY_ID).getUrl("grok");

  // Strip "xai/" prefix; xAI's API expects just the model name (e.g. "grok-4.3").
  const modelName = model.id.replace(/^xai\//, "");

  const body: Record<string, unknown> = {
    model: modelName,
    messages,
    max_completion_tokens: 4096,
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (env.XAI_API_KEY) headers["Authorization"] = `Bearer ${env.XAI_API_KEY}`;
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const logId = resp.headers.get("cf-aig-log-id");

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`xAI API ${resp.status}: ${errText.slice(0, 500)}`);
  }

  const raw = await resp.json();
  return { raw, logId };
}

// ---------- Google Gemini BYOK call ----------
//
// Direct fetch to AI Gateway's Google AI Studio provider endpoint. The
// gateway wraps the call for observability, caching, and rate-limiting.
//
// Auth strategy: stored-keys-first. If env.GOOGLE_API_KEY is set, we send it
// as x-goog-api-key (inline auth, takes priority at the gateway). If it
// isn't, we omit the header and let the gateway inject the key you've stored
// in dashboard > AI Gateway > Provider Keys.
//
// Google's wire format differs from both OpenAI and Anthropic: messages are
// in a `contents` array with `parts` blocks, the system prompt lives in
// `systemInstruction`, image input uses `inline_data` blocks, and the
// assistant role is called `model`. We transform on the way in and unify
// the response shape in extractOutput / extractUsage.

async function callGoogle(
  env: Env,
  model: ModelEntry,
  systemPrompt: string | undefined,
  messages: Array<unknown>
): Promise<{ raw: unknown; logId: string | null }> {
  const { systemInstruction, contents } = transformToGoogle(messages, systemPrompt);

  const baseUrl = await (env.AI as unknown as {
    gateway: (id: string) => { getUrl: (provider: string) => Promise<string> };
  }).gateway(env.GATEWAY_ID).getUrl("google-ai-studio");

  // Strip "google/" prefix; Google's API expects just the model name (e.g. "gemini-3.5-flash").
  const modelName = model.id.replace(/^google\//, "");

  const body: Record<string, unknown> = {
    contents,
    generationConfig: { maxOutputTokens: 4096 },
  };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (env.GOOGLE_API_KEY) headers["x-goog-api-key"] = env.GOOGLE_API_KEY;
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  const resp = await fetch(`${baseUrl}/v1beta/models/${modelName}:generateContent`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const logId = resp.headers.get("cf-aig-log-id");

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Google API ${resp.status}: ${errText.slice(0, 500)}`);
  }

  const raw = await resp.json();
  return { raw, logId };
}

interface GooglePart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}
interface GoogleContent {
  role: "user" | "model";
  parts: GooglePart[];
}

function transformToGoogle(
  messages: Array<unknown>,
  systemPromptOverride: string | undefined
): { systemInstruction: { parts: Array<{ text: string }> } | undefined; contents: GoogleContent[] } {
  let systemText = systemPromptOverride && systemPromptOverride.trim() ? systemPromptOverride : "";
  const contents: GoogleContent[] = [];

  for (const m of messages) {
    const msg = m as { role: string; content: unknown };
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : "";
      systemText = systemText ? `${systemText}\n\n${text}` : text;
      continue;
    }
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    // Google calls the assistant role "model".
    const role: "user" | "model" = msg.role === "assistant" ? "model" : "user";

    if (typeof msg.content === "string") {
      contents.push({ role, parts: [{ text: msg.content }] });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const parts: GooglePart[] = [];
    for (const block of msg.content) {
      const b = block as { type?: string; text?: string; image_url?: { url?: string } };
      if (b.type === "text" && typeof b.text === "string") {
        parts.push({ text: b.text });
      } else if (b.type === "image_url" && b.image_url?.url) {
        const parsed = parseDataUrl(b.image_url.url);
        if (parsed) {
          parts.push({ inline_data: { mime_type: parsed.mime, data: parsed.base64 } });
        }
      }
    }
    contents.push({ role, parts });
  }

  return {
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    contents,
  };
}

// ---------- Video generation (Unified Billing via env.AI.run) ----------
//
// As of Cloudflare Agents Week 2026 (April 2026), the AI Gateway and Workers
// AI are unified. Third-party video models are callable via env.AI.run with
// model strings like "google/veo-3.1-fast" or "xai/grok-imagine-video".
// Cloudflare bills your account directly under Unified Billing - no BYOK to
// xAI, Google, etc needed for these models. See:
//   https://developers.cloudflare.com/ai-gateway/features/unified-billing/
//   https://developers.cloudflare.com/ai/models/google/veo-3.1-fast/
//
// Video gen takes 30s-3min. Rather than hold the client's HTTP request open
// that long, we:
//   1. Write a status='pending' row to D1
//   2. Use ctx.waitUntil() to run env.AI.run in the background after the
//      response is sent
//   3. The background task fetches the resulting video from CF's catalog R2
//      bucket and re-uploads to our R2 bucket so we have a stable URL
//   4. Frontend polls GET /api/job/:id which just reads D1
//
// env.AI.run for video models appears to block until completion based on the
// docs example showing state="Completed" directly. If it ever returns a
// non-terminal state, the background task marks the job failed with a clear
// error so we can iterate.

interface VideoGenResult {
  state?: string;
  result?: { video?: string };
  gatewayMetadata?: { keySource?: string };
}

async function runVideo(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  model: ModelEntry,
  body: ChatRequest
): Promise<Response> {
  const userEmail = getUserEmail(request);
  const startedAt = new Date().toISOString();

  const row = await persistChat(env, {
    userEmail,
    model: model.id,
    model_type: "video",
    system_prompt: body.system_prompt ?? null,
    user_input: body.user_input,
    output: "",
    output_artifact: null,
    attachments: [],
    tokens_in: null,
    tokens_out: null,
    latency_ms: 0,
    ai_gateway_log_id: null,
    status: "pending",
    job_id: null,
    job_provider: model.provider ?? null,
    job_error: null,
    job_started_at: startedAt,
  });

  // Schedule the actual generation to run after the response is sent.
  // If the model has a byok_alias, route through the per-provider BYOK
  // endpoint (works with stored gateway keys or env-var keys today).
  // Otherwise call env.AI.run, which requires Unified Billing on the gateway.
  if (model.byok_alias && (model.provider === "xai" || model.provider === "google")) {
    ctx.waitUntil(
      generateVideoBYOK(env, row.id, userEmail, model, body.user_input, startedAt)
    );
  } else {
    ctx.waitUntil(
      generateVideoUnified(env, row.id, userEmail, model.id, body.user_input, startedAt)
    );
  }

  return json({
    id: row.id,
    created_at: row.created_at,
    model: model.id,
    model_type: "video",
    output: "",
    output_artifact: null,
    status: "pending",
    job_started_at: startedAt,
  });
}

async function generateVideoUnified(
  env: Env,
  rowId: number,
  userEmail: string,
  modelId: string,
  prompt: string,
  startedAtIso: string
): Promise<void> {
  const failRow = async (msg: string) => {
    try {
      await env.DB.prepare(`UPDATE chats SET status = 'failed', job_error = ? WHERE id = ?`)
        .bind(msg.slice(0, 1000), rowId)
        .run();
    } catch { /* swallow - background task can't surface errors anyway */ }
  };

  let result: VideoGenResult;
  try {
    // Baseline params shape per the documented Veo example. Some models may
    // accept additional or different params; their errors will surface in
    // job_error and we can iterate per-model from there.
    result = await aiRun(env, modelId, {
      prompt,
      duration: "8s",
      aspect_ratio: "16:9",
      resolution: "720p",
      generate_audio: true,
    }) as VideoGenResult;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await failRow(`env.AI.run failed: ${m}`);
    return;
  }

  if (!result || (result.state && result.state !== "Completed")) {
    await failRow(`Unexpected gen state: ${result?.state ?? "missing"}`);
    return;
  }

  const videoUrl = result.result?.video;
  if (!videoUrl) {
    await failRow("Gen completed but no video URL in result");
    return;
  }

  // Re-host into our R2 for stable serving and uniform artifact access.
  let bytes: Uint8Array;
  let mime = "video/mp4";
  try {
    const vresp = await fetch(videoUrl);
    if (!vresp.ok) throw new Error(`Fetch ${vresp.status}`);
    mime = vresp.headers.get("content-type") || "video/mp4";
    bytes = new Uint8Array(await vresp.arrayBuffer());
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await failRow(`Video download failed: ${m}`);
    return;
  }

  let r2Key: string;
  try {
    r2Key = await r2Put(env, "out", mime, bytes, userEmail);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await failRow(`R2 upload failed: ${m}`);
    return;
  }

  const outputArtifact: OutputArtifact = { key: r2Key, mime, type: "video" };
  const latency = Date.now() - Date.parse(startedAtIso);

  try {
    await env.DB.prepare(
      `UPDATE chats SET status = 'done', output_artifact = ?, latency_ms = ? WHERE id = ?`
    )
      .bind(JSON.stringify(outputArtifact), latency, rowId)
      .run();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await failRow(`D1 finalize failed: ${m}`);
  }
}

// ---------- Video generation BYOK path (per-provider endpoints) ----------
//
// Used when a model has byok_alias set. Goes through the AI Gateway's
// per-provider proxy endpoints (e.g. {gateway}/grok/v1/videos/generations)
// rather than env.AI.run. This works with stored provider keys in the
// gateway dashboard or with env-var keys (XAI_API_KEY, GOOGLE_API_KEY),
// without requiring Unified Billing.
//
// Submit/poll/download is orchestrated by generateVideoBYOK inside a
// ctx.waitUntil background task. The same D1 status='pending' machinery
// applies; the only difference from the Unified path is that we poll the
// provider ourselves (every 5s, up to 5 minutes) before downloading the
// resulting video and storing it in R2.

const BYOK_POLL_INTERVAL_MS = 5000;
const BYOK_POLL_MAX_MS = 5 * 60 * 1000;

interface BYOKSubmitResult { job_id: string; }
interface BYOKPollResult {
  status: "pending" | "done" | "failed";
  video_url?: string;
  error?: string;
}

async function generateVideoBYOK(
  env: Env,
  rowId: number,
  userEmail: string,
  model: ModelEntry,
  prompt: string,
  startedAtIso: string
): Promise<void> {
  const failRow = async (msg: string) => {
    try {
      await env.DB.prepare(`UPDATE chats SET status = 'failed', job_error = ? WHERE id = ?`)
        .bind(msg.slice(0, 1000), rowId)
        .run();
    } catch { /* swallow */ }
  };

  if (!model.byok_alias) { await failRow("BYOK route entered without byok_alias"); return; }

  // 1. Submit job
  let submit: BYOKSubmitResult;
  try {
    if (model.provider === "xai") {
      submit = await submitVideoXai(env, model.byok_alias, prompt);
    } else if (model.provider === "google") {
      submit = await submitVideoGoogle(env, model.byok_alias, prompt);
    } else {
      await failRow(`BYOK path not implemented for provider: ${model.provider}`);
      return;
    }
  } catch (err) {
    await failRow(`BYOK submit failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Record the upstream job_id on the row for visibility.
  try {
    await env.DB.prepare(`UPDATE chats SET job_id = ? WHERE id = ?`).bind(submit.job_id, rowId).run();
  } catch { /* non-fatal */ }

  // 2. Poll until done, failed, or timeout
  const deadline = Date.now() + BYOK_POLL_MAX_MS;
  let pollResult: BYOKPollResult = { status: "pending" };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, BYOK_POLL_INTERVAL_MS));
    try {
      if (model.provider === "xai") {
        pollResult = await pollVideoXai(env, submit.job_id);
      } else if (model.provider === "google") {
        pollResult = await pollVideoGoogle(env, submit.job_id);
      } else {
        pollResult = { status: "failed", error: `Unsupported provider: ${model.provider}` };
      }
    } catch (err) {
      // Transient poll error; keep trying until deadline.
      continue;
    }
    if (pollResult.status !== "pending") break;
  }

  if (pollResult.status === "pending") {
    await failRow(`BYOK poll timed out after ${BYOK_POLL_MAX_MS / 1000}s`);
    return;
  }
  if (pollResult.status === "failed") {
    await failRow(`BYOK gen failed: ${pollResult.error ?? "unknown"}`);
    return;
  }

  // 3. Download from provider and re-host in our R2
  if (!pollResult.video_url) { await failRow("BYOK gen done but no video_url"); return; }

  let bytes: Uint8Array;
  let mime = "video/mp4";
  try {
    if (pollResult.video_url.startsWith("data:")) {
      const parsed = parseDataUrl(pollResult.video_url);
      if (!parsed) throw new Error("Bad data URL");
      bytes = base64ToBytes(parsed.base64);
      mime = parsed.mime;
    } else {
      // Google Gemini Files URIs require the API key on download; xAI URLs
      // are pre-signed. Apply the key conditionally by hostname.
      const fetchHeaders: Record<string, string> = {};
      try {
        const u = new URL(pollResult.video_url);
        if (u.hostname.endsWith("generativelanguage.googleapis.com") && env.GOOGLE_API_KEY) {
          fetchHeaders["x-goog-api-key"] = env.GOOGLE_API_KEY;
        }
      } catch { /* ignore */ }
      const vresp = await fetch(pollResult.video_url, { headers: fetchHeaders });
      if (!vresp.ok) throw new Error(`Fetch ${vresp.status}`);
      mime = vresp.headers.get("content-type") || "video/mp4";
      bytes = new Uint8Array(await vresp.arrayBuffer());
    }
  } catch (err) {
    await failRow(`Video download failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 4. R2 upload + D1 finalize
  let r2Key: string;
  try {
    r2Key = await r2Put(env, "out", mime, bytes, userEmail);
  } catch (err) {
    await failRow(`R2 upload failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const outputArtifact: OutputArtifact = { key: r2Key, mime, type: "video" };
  const latency = Date.now() - Date.parse(startedAtIso);
  try {
    await env.DB.prepare(
      `UPDATE chats SET status = 'done', output_artifact = ?, latency_ms = ? WHERE id = ?`
    )
      .bind(JSON.stringify(outputArtifact), latency, rowId)
      .run();
  } catch (err) {
    await failRow(`D1 finalize failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// xAI BYOK submit/poll - hits /grok/v1/videos/* through the gateway.

async function submitVideoXai(env: Env, modelName: string, prompt: string): Promise<BYOKSubmitResult> {
  const baseUrl = await (env.AI as unknown as {
    gateway: (id: string) => { getUrl: (provider: string) => Promise<string> };
  }).gateway(env.GATEWAY_ID).getUrl("grok");

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.XAI_API_KEY) headers["Authorization"] = `Bearer ${env.XAI_API_KEY}`;
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  const resp = await fetch(`${baseUrl}/v1/videos/generations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelName,
      prompt,
      duration: 8,
      aspect_ratio: "16:9",
      resolution: "720p",
    }),
  });
  if (!resp.ok) throw new Error(`xAI submit ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  const data = await resp.json() as { request_id?: string };
  if (!data.request_id) throw new Error("xAI submit returned no request_id");
  return { job_id: data.request_id };
}

async function pollVideoXai(env: Env, jobId: string): Promise<BYOKPollResult> {
  const baseUrl = await (env.AI as unknown as {
    gateway: (id: string) => { getUrl: (provider: string) => Promise<string> };
  }).gateway(env.GATEWAY_ID).getUrl("grok");

  const headers: Record<string, string> = {};
  if (env.XAI_API_KEY) headers["Authorization"] = `Bearer ${env.XAI_API_KEY}`;
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  const resp = await fetch(`${baseUrl}/v1/videos/${encodeURIComponent(jobId)}`, { headers });
  if (!resp.ok) throw new Error(`xAI poll ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  const data = await resp.json() as {
    status?: string;
    video?: { url?: string };
    error?: { message?: string } | string;
  };

  if (data.status === "done" && data.video?.url) return { status: "done", video_url: data.video.url };
  if (data.status === "failed" || data.status === "expired") {
    const errMsg = typeof data.error === "string" ? data.error : (data.error?.message ?? data.status);
    return { status: "failed", error: errMsg };
  }
  return { status: "pending" };
}

// Google Veo BYOK submit/poll - hits /google-ai-studio/v1beta/* through the gateway.

async function submitVideoGoogle(env: Env, modelName: string, prompt: string): Promise<BYOKSubmitResult> {
  const baseUrl = await (env.AI as unknown as {
    gateway: (id: string) => { getUrl: (provider: string) => Promise<string> };
  }).gateway(env.GATEWAY_ID).getUrl("google-ai-studio");

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.GOOGLE_API_KEY) headers["x-goog-api-key"] = env.GOOGLE_API_KEY;
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  const resp = await fetch(`${baseUrl}/v1beta/models/${modelName}:predictLongRunning`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { aspectRatio: "16:9", durationSeconds: 8 },
    }),
  });
  if (!resp.ok) throw new Error(`Google submit ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  const data = await resp.json() as { name?: string };
  if (!data.name) throw new Error("Google submit returned no operation name");
  return { job_id: data.name };
}

async function pollVideoGoogle(env: Env, operationName: string): Promise<BYOKPollResult> {
  const baseUrl = await (env.AI as unknown as {
    gateway: (id: string) => { getUrl: (provider: string) => Promise<string> };
  }).gateway(env.GATEWAY_ID).getUrl("google-ai-studio");

  const headers: Record<string, string> = {};
  if (env.GOOGLE_API_KEY) headers["x-goog-api-key"] = env.GOOGLE_API_KEY;
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  const resp = await fetch(`${baseUrl}/v1beta/${operationName}`, { headers });
  if (!resp.ok) throw new Error(`Google poll ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  const data = await resp.json() as {
    done?: boolean;
    error?: { message?: string };
    response?: {
      generatedVideos?: Array<{ video?: { uri?: string; videoBytes?: string } }>;
    };
  };

  if (data.error) return { status: "failed", error: data.error.message ?? "Unknown Google error" };
  if (!data.done) return { status: "pending" };

  const v = data.response?.generatedVideos?.[0]?.video;
  if (v?.uri) return { status: "done", video_url: v.uri };
  if (v?.videoBytes) return { status: "done", video_url: `data:video/mp4;base64,${v.videoBytes}` };
  return { status: "failed", error: "Google reported done but returned no video uri or bytes" };
}

// ---------- Job polling endpoint ----------
//
// All real work happens in the waitUntil background task. This endpoint just
// reflects the current D1 row state to the client.

async function handleJobPoll(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = getUserEmail(request);

  const row = await env.DB.prepare(
    `SELECT id, status, job_error, job_started_at, output_artifact, latency_ms
       FROM chats
      WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first<{
      id: number;
      status: string;
      job_error: string | null;
      job_started_at: string | null;
      output_artifact: string | null;
      latency_ms: number | null;
    }>();

  if (!row) return json({ error: "Not found" }, { status: 404 });

  if (row.status === "done") {
    return json({
      id: row.id,
      status: "done",
      output_artifact: row.output_artifact ? safeParseJson<OutputArtifact>(row.output_artifact) : null,
      latency_ms: row.latency_ms,
    });
  }
  if (row.status === "failed") {
    return json({ id: row.id, status: "failed", job_error: row.job_error });
  }
  return json({ id: row.id, status: "pending" });
}

// ---------- Output extraction (text models) ----------

function extractOutput(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as Record<string, unknown>;

  if (typeof r?.response === "string") return r.response;
  if (typeof r?.result === "string")   return r.result;

  const choices = r?.choices as Array<{ message?: { content?: string } }> | undefined;
  if (Array.isArray(choices) && typeof choices[0]?.message?.content === "string") {
    return choices[0].message.content;
  }

  // Anthropic Messages API: top-level content array
  const content = r?.content as Array<{ type?: string; text?: string }> | undefined;
  if (Array.isArray(content)) {
    const text = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    if (text) return text;
  }

  // Google Gemini: candidates[0].content.parts[].text
  const candidates = r?.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
  if (Array.isArray(candidates) && Array.isArray(candidates[0]?.content?.parts)) {
    const text = candidates[0].content.parts
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
    if (text) return text;
  }

  const out = r?.output as Array<unknown> | undefined;
  if (Array.isArray(out)) {
    const text = out
      .flatMap((block) => {
        const b = block as { content?: Array<{ type?: string; text?: string }> };
        return (b?.content ?? [])
          .filter((c) => c?.type === "output_text" || c?.type === "text")
          .map((c) => c.text ?? "");
      })
      .join("");
    if (text) return text;
  }

  return JSON.stringify(result);
}

function extractUsage(result: unknown): { in_: number | null; out_: number | null } {
  const r = result as Record<string, unknown>;
  // OpenAI / Anthropic: usage object on result
  const u = r?.usage as Record<string, number> | undefined;
  if (u) {
    return {
      in_:  u.prompt_tokens ?? u.input_tokens  ?? null,
      out_: u.completion_tokens ?? u.output_tokens ?? null,
    };
  }
  // Google Gemini: usageMetadata
  const um = r?.usageMetadata as Record<string, number> | undefined;
  if (um) {
    return {
      in_:  um.promptTokenCount ?? null,
      out_: um.candidatesTokenCount ?? null,
    };
  }
  return { in_: null, out_: null };
}

// ---------- History ----------

async function handleHistoryList(request: Request, env: Env): Promise<Response> {
  const userEmail = getUserEmail(request);
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

  const rows = await env.DB.prepare(
    `SELECT id, created_at, model, model_type, system_prompt, user_input, output,
            tokens_in, tokens_out, latency_ms, status,
            CASE WHEN attachments     IS NOT NULL THEN 1 ELSE 0 END AS has_attachments,
            CASE WHEN output_artifact IS NOT NULL THEN 1 ELSE 0 END AS has_output_artifact
       FROM chats
      WHERE user_email = ?
      ORDER BY created_at DESC
      LIMIT ?`
  )
    .bind(userEmail, limit)
    .all();

  return json({ user: userEmail, chats: rows.results ?? [] });
}

async function handleHistoryGet(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = getUserEmail(request);
  const row = await env.DB.prepare(
    `SELECT * FROM chats WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first<{ attachments: string | null; output_artifact: string | null; retrieved_context: string | null }>();

  if (!row) return json({ error: "Not found" }, { status: 404 });

  return json({
    ...row,
    attachments: row.attachments ? safeParseJson<PersistedAttachment[]>(row.attachments) : null,
    output_artifact: row.output_artifact ? safeParseJson<OutputArtifact>(row.output_artifact) : null,
    retrieved_context: row.retrieved_context ? safeParseJson<RetrievedChunk[]>(row.retrieved_context) : null,
  });
}

function safeParseJson<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

async function handleHistoryDelete(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = getUserEmail(request);

  // Pull keys first so we can clean up R2.
  const row = await env.DB.prepare(
    `SELECT attachments, output_artifact FROM chats WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first<{ attachments: string | null; output_artifact: string | null }>();

  if (!row) return json({ error: "Not found" }, { status: 404 });

  const keysToDelete: string[] = [];
  if (row.attachments) {
    const atts = safeParseJson<PersistedAttachment[]>(row.attachments) ?? [];
    for (const a of atts) {
      if (a.type === "image") keysToDelete.push(a.key);
      else if (a.type === "video_frames") keysToDelete.push(...(a.keys ?? []));
      // audio has no R2 reference
    }
  }
  if (row.output_artifact) {
    const oa = safeParseJson<OutputArtifact>(row.output_artifact);
    if (oa?.key) keysToDelete.push(oa.key);
  }

  // Delete from D1 first; if it succeeds, clean R2. (If R2 cleanup fails the
  // row is already gone, so worst case we have orphaned objects, which is
  // fine for occasional manual cleanup.)
  const result = await env.DB.prepare(
    `DELETE FROM chats WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .run();
  if (!result.success || (result.meta?.changes ?? 0) === 0) {
    return json({ error: "Not found" }, { status: 404 });
  }

  for (const k of keysToDelete) await r2DeleteSafe(env, k);

  return json({ deleted: id, r2_keys_deleted: keysToDelete.length });
}

// ---------- RAG: document ingestion (Pass 1) ----------
//
// Pass 1 supports text/markdown only. Uploaded files are stored in R2,
// chunked, embedded with @cf/baai/bge-base-en-v1.5 (768-dim), and the
// resulting vectors are upserted into the Vectorize index. Chunks remain
// in D1 keyed by their Vectorize vector_id so retrieval can look up the
// original text from a vector hit.
//
// Chunking is character-based with ~50 char overlap. We try to break on
// natural boundaries (paragraph breaks, then newlines, then sentences)
// before falling back to a hard cut. Target 500 chars per chunk - small
// enough that BGE-base does well, large enough that each chunk carries
// usable context.
//
// Pass 2 will add the retrieval injection path into /api/chat. Pass 1
// only builds the ingestion pipeline so we can validate Vectorize +
// chunking + embedding end-to-end before touching chat.

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const EMBED_DIMENSIONS = 768;
const CHUNK_TARGET_CHARS = 500;
const CHUNK_OVERLAP_CHARS = 50;
const EMBED_BATCH_SIZE = 16;       // BGE accepts batches; 16 keeps requests small
const DOC_MAX_BYTES = 5 * 1024 * 1024;  // 5MB upload cap
const ALLOWED_DOC_MIMES = ["text/plain", "text/markdown", "text/x-markdown"];

interface DocumentRow {
  id: number;
  user_email: string;
  created_at: string;
  filename: string;
  mime: string;
  r2_key: string;
  size_bytes: number;
  total_chars: number;
  chunk_count: number;
}

interface ChunkRow {
  id: number;
  document_id: number;
  user_email: string;
  chunk_index: number;
  text: string;
  vector_id: string;
}

function chunkText(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;

  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + CHUNK_TARGET_CHARS, text.length);
    let cut = end;

    // If we're not at EOF, try to find a natural break in the last 1/3
    // of the chunk window. Prefer paragraph break > newline > sentence end.
    if (end < text.length) {
      const windowStart = pos + Math.floor(CHUNK_TARGET_CHARS * 2 / 3);
      const window = text.slice(windowStart, end);
      const para = window.lastIndexOf("\n\n");
      const nl = window.lastIndexOf("\n");
      const dot = window.lastIndexOf(". ");
      if (para >= 0)      cut = windowStart + para + 2;
      else if (nl >= 0)   cut = windowStart + nl + 1;
      else if (dot >= 0)  cut = windowStart + dot + 2;
    }

    const piece = text.slice(pos, cut).trim();
    if (piece) out.push(piece);

    if (cut >= text.length) break;
    pos = Math.max(cut - CHUNK_OVERLAP_CHARS, pos + 1);
  }
  return out;
}

async function embedBatch(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const result = await aiRun(env, EMBED_MODEL, { text: texts }) as {
    shape?: [number, number];
    data?: number[][];
  };
  if (!result.data || !Array.isArray(result.data)) {
    throw new Error("Embedding model returned no data array");
  }
  return result.data;
}

// ---------- RAG: retrieval (Pass 2) ----------
//
// Embeds the user prompt, queries Vectorize for the top-K nearest chunks,
// then looks up source text in D1. We filter by user_email in the D1 JOIN
// (not in the Vectorize filter param) so this works without a metadata
// index on the Vectorize side - simpler for single-user deployments.
// Vectorize score ordering is preserved.

const RETRIEVE_TOP_K = 5;

async function retrieveContext(
  env: Env,
  userEmail: string,
  queryText: string,
  topK: number = RETRIEVE_TOP_K
): Promise<RetrievedChunk[]> {
  if (!queryText || !queryText.trim()) return [];

  // 1) Embed the query.
  let queryVec: number[];
  try {
    const vectors = await embedBatch(env, [queryText]);
    if (vectors.length === 0) return [];
    queryVec = vectors[0];
  } catch {
    return [];
  }

  // 2) Query Vectorize. No metadata filter - we scope by user in D1 below.
  let matches: { id: string; score: number }[];
  try {
    const q = await env.VEC.query(queryVec, { topK, returnMetadata: false });
    matches = (q?.matches ?? []).map((m) => ({ id: m.id, score: m.score }));
  } catch {
    return [];
  }
  if (matches.length === 0) return [];

  // 3) D1 lookup: join chunks to documents, scope by user_email so we
  // never return another user's chunk even if their vector IDs would
  // somehow collide.
  const ids = matches.map((m) => m.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT c.document_id, c.chunk_index, c.text, c.vector_id, d.filename
       FROM chunks c
       JOIN documents d ON c.document_id = d.id
      WHERE c.user_email = ?
        AND c.vector_id IN (${placeholders})`
  )
    .bind(userEmail, ...ids)
    .all<{ document_id: number; chunk_index: number; text: string; vector_id: string; filename: string }>();

  // 4) Merge scores back in, preserve Vectorize ordering.
  const byId = new Map((rows.results ?? []).map((r) => [r.vector_id, r]));
  const scoreById = new Map(matches.map((m) => [m.id, m.score]));
  const out: RetrievedChunk[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    out.push({
      document_id: r.document_id,
      filename: r.filename,
      chunk_index: r.chunk_index,
      text: r.text,
      score: scoreById.get(id) ?? 0,
    });
  }
  return out;
}

function formatRetrievalForSystemPrompt(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  const body = chunks
    .map((c, i) => `[Excerpt ${i + 1}, from ${c.filename} (chunk ${c.chunk_index})]\n${c.text}`)
    .join("\n\n---\n\n");
  return [
    "You have access to the following excerpts from the user's uploaded documents.",
    "Use them when they are relevant to the user's query. If they don't answer the question,",
    "say so plainly rather than guessing or hallucinating.",
    "",
    body,
  ].join("\n");
}

async function handleDocumentList(request: Request, env: Env): Promise<Response> {
  const userEmail = getUserEmail(request);
  const rows = await env.DB.prepare(
    `SELECT id, created_at, filename, mime, size_bytes, total_chars, chunk_count
       FROM documents
      WHERE user_email = ?
      ORDER BY created_at DESC`
  )
    .bind(userEmail)
    .all<{
      id: number;
      created_at: string;
      filename: string;
      mime: string;
      size_bytes: number;
      total_chars: number;
      chunk_count: number;
    }>();
  return json({ user: userEmail, documents: rows.results ?? [] });
}

async function handleDocumentGet(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = getUserEmail(request);
  const doc = await env.DB.prepare(
    `SELECT id, created_at, filename, mime, size_bytes, total_chars, chunk_count
       FROM documents
      WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first();
  if (!doc) return json({ error: "Not found" }, { status: 404 });

  // Include first ~10 chunks for inspection without dumping the whole doc.
  const chunks = await env.DB.prepare(
    `SELECT chunk_index, text FROM chunks
      WHERE document_id = ? AND user_email = ?
      ORDER BY chunk_index ASC
      LIMIT 10`
  )
    .bind(id, userEmail)
    .all();

  return json({ document: doc, chunk_preview: chunks.results ?? [] });
}

async function handleDocumentUpload(request: Request, env: Env): Promise<Response> {
  const userEmail = getUserEmail(request);

  // Accept JSON { filename, mime, data: base64 } - matches the existing
  // attachment-upload convention used by the chat path.
  let body: { filename?: string; mime?: string; data?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const filename = body.filename || "untitled.txt";
  const mime = body.mime || "text/plain";
  if (!ALLOWED_DOC_MIMES.includes(mime) && !filename.match(/\.(txt|md|markdown)$/i)) {
    return json({ error: `Unsupported file type: ${mime}. Only .txt and .md allowed in Pass 1.` }, { status: 400 });
  }
  if (!body.data) {
    return json({ error: "Missing file data" }, { status: 400 });
  }

  // Decode base64 data URL or raw base64.
  let bytes: Uint8Array;
  try {
    const parsed = body.data.startsWith("data:") ? parseDataUrl(body.data) : null;
    bytes = parsed ? base64ToBytes(parsed.base64) : base64ToBytes(body.data);
  } catch (err) {
    return json({ error: `Bad file data: ${err instanceof Error ? err.message : err}` }, { status: 400 });
  }
  if (bytes.length > DOC_MAX_BYTES) {
    return json({ error: `File too large (${bytes.length} bytes, max ${DOC_MAX_BYTES})` }, { status: 413 });
  }

  // Decode as UTF-8 text. Default behavior replaces invalid bytes with U+FFFD
  // rather than throwing, which is what we want for graceful upload handling.
  let text: string;
  try {
    text = new TextDecoder("utf-8").decode(bytes);
  } catch (err) {
    return json({ error: `Could not decode as UTF-8: ${err instanceof Error ? err.message : err}` }, { status: 400 });
  }
  if (!text.trim()) {
    return json({ error: "File is empty after decoding" }, { status: 400 });
  }

  // Chunk
  const pieces = chunkText(text);
  if (pieces.length === 0) {
    return json({ error: "No chunks produced from text" }, { status: 400 });
  }

  // Store raw bytes in R2 for audit / future re-processing.
  const r2Key = await r2Put(env, "in", mime, bytes, userEmail);

  // Insert document row first so we have its ID for vector_id generation.
  const docInsert = await env.DB.prepare(
    `INSERT INTO documents
       (user_email, filename, mime, r2_key, size_bytes, total_chars, chunk_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id, created_at`
  )
    .bind(userEmail, filename, mime, r2Key, bytes.length, text.length, pieces.length)
    .first<{ id: number; created_at: string }>();
  if (!docInsert) {
    await r2DeleteSafe(env, r2Key);
    return json({ error: "Failed to insert document row" }, { status: 500 });
  }
  const docId = docInsert.id;

  // Embed in batches and upsert to Vectorize. We tag every vector with
  // user_email + document_id so we can filter on retrieval and clean up on delete.
  // Vector IDs are scoped: `${userEmail}:${docId}:${chunkIndex}`.
  const vectorIdsWritten: string[] = [];
  const chunkRowsToInsert: { chunk_index: number; text: string; vector_id: string }[] = [];

  try {
    for (let b = 0; b < pieces.length; b += EMBED_BATCH_SIZE) {
      const batch = pieces.slice(b, b + EMBED_BATCH_SIZE);
      const vectors = await embedBatch(env, batch);
      if (vectors.length !== batch.length) {
        throw new Error(`Embedding batch returned ${vectors.length} vectors for ${batch.length} texts`);
      }

      const vectorizePayload = batch.map((t, i) => {
        const idx = b + i;
        const vid = `${userEmail}:${docId}:${idx}`;
        chunkRowsToInsert.push({ chunk_index: idx, text: t, vector_id: vid });
        vectorIdsWritten.push(vid);
        return {
          id: vid,
          values: vectors[i],
          metadata: {
            user_email: userEmail,
            document_id: docId,
            chunk_index: idx,
          },
        };
      });

      await env.VEC.upsert(vectorizePayload);
    }
  } catch (err) {
    // Rollback: best-effort cleanup of partially-written state.
    if (vectorIdsWritten.length) {
      try { await env.VEC.deleteByIds(vectorIdsWritten); } catch { /* swallow */ }
    }
    await env.DB.prepare(`DELETE FROM documents WHERE id = ?`).bind(docId).run();
    await r2DeleteSafe(env, r2Key);
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `Embedding failed: ${m}` }, { status: 502 });
  }

  // Now write all chunk rows in a single batched D1 statement.
  if (chunkRowsToInsert.length) {
    const stmts = chunkRowsToInsert.map((c) =>
      env.DB.prepare(
        `INSERT INTO chunks (document_id, user_email, chunk_index, text, vector_id)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(docId, userEmail, c.chunk_index, c.text, c.vector_id)
    );
    await env.DB.batch(stmts);
  }

  return json({
    id: docId,
    created_at: docInsert.created_at,
    filename,
    mime,
    size_bytes: bytes.length,
    total_chars: text.length,
    chunk_count: pieces.length,
  });
}

async function handleDocumentDelete(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = getUserEmail(request);

  const doc = await env.DB.prepare(
    `SELECT r2_key FROM documents WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first<{ r2_key: string }>();
  if (!doc) return json({ error: "Not found" }, { status: 404 });

  // Collect vector IDs first so we can clean them out of Vectorize.
  const chunkRows = await env.DB.prepare(
    `SELECT vector_id FROM chunks WHERE document_id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .all<{ vector_id: string }>();

  const vectorIds = (chunkRows.results ?? []).map((r) => r.vector_id);
  if (vectorIds.length) {
    try { await env.VEC.deleteByIds(vectorIds); } catch { /* best effort */ }
  }

  // Cascade delete in D1 (no real FK enforcement, so explicit) and R2.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM chunks    WHERE document_id = ? AND user_email = ?`).bind(id, userEmail),
    env.DB.prepare(`DELETE FROM documents WHERE id          = ? AND user_email = ?`).bind(id, userEmail),
  ]);
  await r2DeleteSafe(env, doc.r2_key);

  return json({ deleted: id, vectors_removed: vectorIds.length });
}

// ---------- Artifact serving ----------

async function handleArtifact(request: Request, env: Env, key: string): Promise<Response> {
  const userEmail = getUserEmail(request);
  const obj = await env.R2.get(key);
  if (!obj) return new Response("Not Found", { status: 404 });

  // Authorization: only the user who created the artifact may fetch it.
  // We stored user_email in customMetadata at put time.
  const owner = obj.customMetadata?.user_email;
  if (owner !== userEmail) {
    return new Response("Forbidden", { status: 403 });
  }

  const headers = new Headers();
  headers.set("content-type", obj.httpMetadata?.contentType || "application/octet-stream");
  headers.set("cache-control", "private, max-age=3600");
  return new Response(obj.body, { headers });
}
