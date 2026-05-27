// skyphusion-llm-public worker. Routes:
//   GET    /health                 liveness probe (no binding access, always 200)
//   GET    /health/deep            deep check: D1, R2, Vectorize, AI gateway config
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

import { getDocumentProxy } from "unpdf";
import * as XLSX from "xlsx";
import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";

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
  // v0.12.0: Workflow binding for Unified Billing video + music gen. The
  // class is LongRunWorkflow, defined at the bottom of this file. Each
  // instance invokes env.AI.run (long-running), downloads the artifact,
  // uploads to R2, and finalizes the D1 row across retryable steps.
  LONGRUN: Workflow;
  ANTHROPIC_API_KEY?: string; // optional; preferred is to store in AI Gateway dashboard
  XAI_API_KEY?: string;       // optional; preferred is to store in AI Gateway dashboard
  // v0.11.0: AWS credentials for Bedrock BYOK. Scope IAM key to Bedrock invoke only.
  // AWS_REGION defaults to us-east-1 for Nova; Pegasus 1.2 requires us-west-2 or eu-west-1.
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;
  AWS_REGION_PEGASUS?: string; // optional override for Pegasus calls
  CF_AIG_TOKEN?: string;      // only needed if gateway has Authenticated Gateway enabled
  // v0.17.0: Tavily Search API key for the optional web-search retrieval source.
  // Optional: when unset, web search uses Wikipedia only (no key required).
  TAVILY_API_KEY?: string;
}

// ---------- Model catalog ----------

type ModelType = "chat" | "image" | "tts" | "video" | "stt" | "music";
type Provider =
  | "workers-ai"
  | "anthropic"
  | "xai"
  | "google"
  | "bedrock"
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
  // (xAI direct API for xai/*) instead of the env.AI.run binding. The value
  // is the model name expected by the direct provider API. Without this,
  // video gen requires Unified Billing on the AI Gateway.
  byok_alias?: string;
  // v0.13.0: when true, the model can be invoked via POST /api/chat/stream
  // (server-sent events). Pass 1 covers Anthropic only; Pass 2+ will light
  // up Workers AI, xAI, and Bedrock. Chat models only - irrelevant for
  // image/tts/video/stt/music types.
  streaming?: boolean;
}

const MODELS: ModelEntry[] = [
  // ---- Chat (text generation) ----
  // Anthropic (BYOK via x-api-key or stored keys, routed through AI Gateway)
  // v0.13.0: streaming: true makes these eligible for POST /api/chat/stream.
  { id: "anthropic/claude-opus-4-7",                    label: "Claude Opus 4.7 (Anthropic, BYOK)",          group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic", streaming: true },
  { id: "anthropic/claude-opus-4-6",                    label: "Claude Opus 4.6 (Anthropic, BYOK)",          group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic", streaming: true },
  { id: "anthropic/claude-sonnet-4-6",                  label: "Claude Sonnet 4.6 (Anthropic, BYOK)",        group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic", streaming: true },
  { id: "anthropic/claude-haiku-4-5",                   label: "Claude Haiku 4.5 (Anthropic, BYOK)",         group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic", streaming: true },

  // Amazon Bedrock Nova family (v0.11.0, BYOK via AWS SigV4, direct to bedrock-runtime)
  // All four go through Bedrock's Converse API (unified across model families).
  { id: "bedrock/amazon.nova-2-lite-v1:0",               label: "Amazon Nova 2 Lite (Bedrock, BYOK)",         group: "Chat \u00b7 Bedrock", type: "chat", capabilities: ["vision"], provider: "bedrock", byok_alias: "amazon.nova-2-lite-v1:0", streaming: true },
  { id: "bedrock/amazon.nova-2-pro-v1:0",                label: "Amazon Nova 2 Pro (Bedrock, BYOK)",          group: "Chat \u00b7 Bedrock", type: "chat", capabilities: ["vision"], provider: "bedrock", byok_alias: "amazon.nova-2-pro-v1:0", streaming: true },
  { id: "bedrock/amazon.nova-lite-v1:0",                 label: "Amazon Nova Lite (Bedrock, BYOK)",           group: "Chat \u00b7 Bedrock", type: "chat", capabilities: ["vision"], provider: "bedrock", byok_alias: "amazon.nova-lite-v1:0", streaming: true },
  { id: "bedrock/amazon.nova-pro-v1:0",                  label: "Amazon Nova Pro (Bedrock, BYOK)",            group: "Chat \u00b7 Bedrock", type: "chat", capabilities: ["vision"], provider: "bedrock", byok_alias: "amazon.nova-pro-v1:0", streaming: true },

  // TwelveLabs Pegasus 1.2 on Bedrock (v0.11.0, video-Q&A via InvokeModel, not Converse).
  // Requires a video attachment. Region must be us-west-2 or eu-west-1.
  // Configurable via AWS_REGION_PEGASUS; otherwise falls back to AWS_REGION.
  { id: "bedrock/twelvelabs.pegasus-1-2-v1:0",           label: "Pegasus 1.2 (TwelveLabs/Bedrock, BYOK)",     group: "Chat \u00b7 Bedrock", type: "chat", capabilities: [], provider: "bedrock", byok_alias: "twelvelabs.pegasus-1-2-v1:0" },

  // xAI / Grok (BYOK via Bearer auth or stored keys, routed through AI Gateway)
  { id: "xai/grok-4.3",                                 label: "Grok 4.3 (xAI, BYOK)",                       group: "Chat \u00b7 xAI",       type: "chat", capabilities: ["vision"], provider: "xai", streaming: true },
  { id: "xai/grok-4.20-multi-agent-0309",               label: "Grok 4.20 Multi-Agent (xAI, BYOK)",          group: "Chat \u00b7 xAI",       type: "chat", capabilities: ["vision"], provider: "xai", streaming: true },
  { id: "xai/grok-4.20-0309-reasoning",                 label: "Grok 4.20 Reasoning (xAI, BYOK)",            group: "Chat \u00b7 xAI",       type: "chat", capabilities: ["vision"], provider: "xai", streaming: true },
  { id: "xai/grok-build-0.1",                           label: "Grok Build 0.1 (xAI, BYOK, coding)",         group: "Chat \u00b7 xAI",       type: "chat", capabilities: [],         provider: "xai", streaming: true },

  // Frontier
  { id: "@cf/moonshotai/kimi-k2.6",                     label: "Kimi K2.6 (1T)",               group: "Chat \u00b7 Frontier", type: "chat", capabilities: ["vision"], streaming: true },
  { id: "@cf/openai/gpt-oss-120b",                      label: "GPT-OSS 120B (reasoning)",     group: "Chat \u00b7 Frontier", type: "chat", capabilities: [], streaming: true },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct",      label: "Llama 4 Scout (MoE, vision)",  group: "Chat \u00b7 Frontier", type: "chat", capabilities: ["vision"], streaming: true },
  { id: "@cf/google/gemma-4-26b-a4b-it",                label: "Gemma 4 26B (vision)",         group: "Chat \u00b7 Frontier", type: "chat", capabilities: ["vision"], streaming: true },
  // OpenAI open weights
  { id: "@cf/openai/gpt-oss-20b",                       label: "GPT-OSS 20B",                  group: "Chat \u00b7 OpenAI",   type: "chat", capabilities: [], streaming: true },
  // Meta
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",     label: "Llama 3.3 70B (fp8)",          group: "Chat \u00b7 Meta",     type: "chat", capabilities: [], streaming: true },
  { id: "@cf/meta/llama-3.2-11b-vision-instruct",       label: "Llama 3.2 11B (vision)",       group: "Chat \u00b7 Meta",     type: "chat", capabilities: ["vision"], streaming: true },
  { id: "@cf/meta/llama-3.2-3b-instruct",               label: "Llama 3.2 3B",                 group: "Chat \u00b7 Meta",     type: "chat", capabilities: [], streaming: true },
  // Qwen
  { id: "@cf/qwen/qwen3-30b-a3b-fp8",                   label: "Qwen3 30B MoE",                group: "Chat \u00b7 Qwen",     type: "chat", capabilities: [], streaming: true },
  { id: "@cf/qwen/qwq-32b",                             label: "QwQ 32B (reasoning)",          group: "Chat \u00b7 Qwen",     type: "chat", capabilities: [], streaming: true },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct",          label: "Qwen2.5 Coder 32B",            group: "Chat \u00b7 Qwen",     type: "chat", capabilities: [], streaming: true },
  // Other
  { id: "@cf/deepseek/deepseek-r1-distill-qwen-32b",    label: "DeepSeek R1 32B",              group: "Chat \u00b7 Other",    type: "chat", capabilities: [], streaming: true },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 (vision)",   group: "Chat \u00b7 Other",    type: "chat", capabilities: ["vision"], streaming: true },
  { id: "@cf/zai-org/glm-4.7-flash",                    label: "GLM-4.7 Flash (Z.AI, 100+ lang)", group: "Chat \u00b7 Other", type: "chat", capabilities: [], streaming: true },
  { id: "@cf/nvidia/nemotron-3-120b-a12b",              label: "Nemotron 3 120B (NVIDIA, agentic)", group: "Chat \u00b7 Other", type: "chat", capabilities: [], streaming: true },
  { id: "@cf/google/gemma-3-12b-it",                    label: "Gemma 3 12B (vision, 128K)",   group: "Chat \u00b7 Google",   type: "chat", capabilities: ["vision"], streaming: true },
  { id: "@cf/ibm-granite/granite-4.0-h-micro",          label: "Granite 4.0 Micro (IBM)",      group: "Chat \u00b7 Other",    type: "chat", capabilities: [], streaming: true },
  { id: "@hf/nousresearch/hermes-2-pro-mistral-7b",     label: "Hermes 2 Pro (function calling)", group: "Chat \u00b7 Other", type: "chat", capabilities: [], streaming: true },
  { id: "@cf/meta/llama-3.2-1b-instruct",               label: "Llama 3.2 1B (tiny, cheap)",   group: "Chat \u00b7 Meta",     type: "chat", capabilities: [], streaming: true },

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

// v0.17.1: discriminated union to mirror PersistedAttachment's style. Each
// variant declares its required payload field as non-optional; the type
// discriminator (`type`) is what TypeScript uses to narrow inside type guards
// like `if (att.type === "image") { att.data /* now string, not string|undefined */ }`.
// Runtime validation still belongs at parse-time at the API boundary; the
// type only describes the contract we expect from a well-formed request.
interface InputImageAttachment {
  type: "image";
  data: string;        // data URL
  mime?: string;
  filename?: string;
}
interface InputAudioAttachment {
  type: "audio";
  data: string;        // data URL
  mime?: string;
  filename?: string;
}
interface InputVideoFramesAttachment {
  type: "video_frames";
  frames: string[];    // array of data URLs (one per keyframe)
  duration?: number;
  filename?: string;
}
interface InputVideoFullAttachment {
  type: "video_full";
  data: string;        // data URL
  mime?: string;
  filename?: string;
}
type InputAttachment =
  | InputImageAttachment
  | InputAudioAttachment
  | InputVideoFramesAttachment
  | InputVideoFullAttachment;

interface ChatRequest {
  model: string;
  system_prompt?: string;
  user_input: string;
  attachments?: InputAttachment[];
  use_docs?: boolean;   // Pass 2: when true, retrieve top-K chunks from Vectorize and inject as context
  use_web_search?: boolean;  // v0.17.0: when true, query Tavily + Wikipedia and inject snippets as context
  conversation_id?: string;  // Multi-turn: when present, continue an existing conversation
}

interface RetrievedChunk {
  // v0.17.0: discriminator. Omitted on existing rows (pre-v0.17.0) and on new
  // RAG-only rows; readers treat "missing" as "rag" for back-compat.
  source_type?: "rag";
  document_id: number;
  filename: string;
  chunk_index: number;
  text: string;
  score: number;
  page?: number | null;     // PDFs only
  sheet?: string | null;    // XLSX/XLS only
}

// v0.17.0: web-search result, stored alongside RAG chunks in the same
// retrieved_context column. The frontend renders branches on source_type.
interface RetrievedWebResult {
  source_type: "web";
  source: "tavily" | "wikipedia";
  url: string;
  title: string;
  snippet: string;          // already HTML-stripped
  score?: number;           // Tavily provides a relevance score; Wikipedia does not
}

type RetrievedItem = RetrievedChunk | RetrievedWebResult;

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
interface PersistedVideoFullAttachment {
  type: "video_full";
  key: string;
  mime?: string;
  filename?: string;
}
type PersistedAttachment =
  | PersistedImageAttachment
  | PersistedAudioAttachment
  | PersistedVideoFramesAttachment
  | PersistedVideoFullAttachment;

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
  if (m.includes("mp4"))  return "mp4";
  if (m.includes("quicktime")) return "mov";
  if (m.includes("mov"))  return "mov";
  if (m.includes("matroska") || m.includes("mkv")) return "mkv";
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

// Streaming variant: pipes a ReadableStream directly into R2 without
// buffering the bytes in worker memory. Use this for large artifacts (video,
// audio) where the source is a fetch response body. R2.put accepts
// ReadableStream as the value parameter and will consume it as the upload
// progresses, so peak memory stays bounded regardless of artifact size.
async function r2PutStream(env: Env, prefix: "in" | "out", mime: string, stream: ReadableStream, userEmail: string): Promise<string> {
  const key = `${prefix}/${crypto.randomUUID()}.${extFromMime(mime)}`;
  await env.R2.put(key, stream, {
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

    // Cheap liveness check. No binding access; sub-millisecond response.
    // Use for high-frequency uptime polling (Kuma at 60s interval, etc).
    if (url.pathname === "/health") {
      return json({ ok: true, ts: Date.now() });
    }

    // Deep check: exercises D1, R2, Vectorize, and confirms the AI gateway
    // is configured. Returns 503 if any check fails so an uptime monitor
    // flips red. Slower than /health (50-200ms typical) so poll less
    // frequently (5min interval works well).
    if (url.pathname === "/health/deep" && request.method === "GET") {
      return handleHealthDeep(env);
    }

    if (url.pathname === "/api/models" && request.method === "GET") {
      return json({ models: MODELS, user: getUserEmail(request) });
    }
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env, ctx);
    }
    if (url.pathname === "/api/chat/stream" && request.method === "POST") {
      return handleChatStream(request, env, ctx);
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

    if (url.pathname === "/api/conversations" && request.method === "GET") {
      return handleConversationList(request, env);
    }
    const c = url.pathname.match(/^\/api\/conversations\/([A-Za-z0-9_:-]+)$/);
    if (c) {
      if (request.method === "GET")    return handleConversationGet(request, env, c[1]);
      if (request.method === "DELETE") return handleConversationDelete(request, env, c[1]);
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

// ---------- /api/chat/stream (v0.13.0) ----------
//
// Thin entry point. Validates input + model, gates by model.streaming +
// model.provider (Pass 1 supports Anthropic only), then dispatches to
// runChatStream. Non-chat types and non-streaming chat models bounce with
// 400 here so the streaming runtime stays narrow.

async function handleChatStream(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  void ctx; // the response body is a live stream; the worker stays alive while it's open.

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
  if (model.type !== "chat") {
    return json({ error: `Streaming is only supported for chat models. Use /api/chat for ${model.type} models.` }, { status: 400 });
  }
  if (!model.streaming) {
    return json({ error: `Model ${model.id} does not support streaming. Use /api/chat (non-streaming) or pick a streaming-capable model.` }, { status: 400 });
  }
  // Pass 4: Anthropic + Workers AI + xAI + Bedrock Nova.
  // Workers AI catalog entries omit `provider` (the type allows this and the
  // ModelEntry default per the type comment is "workers-ai"); BYOK providers
  // set it explicitly.
  //
  // Bedrock Pegasus is single-shot video Q&A (uses InvokeModel, not
  // ConverseStream) and is not flagged streaming in the catalog, so it
  // would already fail the model.streaming check above. The provider gate
  // here permits all of bedrock; the catalog flag is the real filter.
  const isWorkersAI = !model.provider;
  if (
    model.provider !== "anthropic" &&
    model.provider !== "xai" &&
    model.provider !== "bedrock" &&
    !isWorkersAI
  ) {
    return json({ error: `Streaming for provider '${model.provider}' is not yet implemented.` }, { status: 501 });
  }

  return runChatStream(request, env, model, body);
}

// ---------- Chat (text generation, multimodal in) ----------

async function runChat(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = getUserEmail(request);
  const inputs: InputAttachment[] = body.attachments ?? [];

  // Hot-path parallelization (v0.12.1): kick off the prior-turns SELECT and
  // the RAG retrieve in the background while the attachment walk runs. None
  // of the three depend on each other (the SELECT only needs the inbound
  // conversation_id + user_email; retrieveContext only needs user_email +
  // the raw user_input), so serializing them costs ~600-1500ms on
  // multimodal+RAG turns. We await each promise at its existing use site
  // below so the error surface is unchanged.
  const conversationIdIn = body.conversation_id?.trim() || "";
  const priorTurnsPromise: Promise<{
    rows: Array<{ user_input: string; output: string; turn_index: number }>;
  }> = conversationIdIn
    ? env.DB.prepare(
        `SELECT user_input, output, turn_index
           FROM chats
          WHERE conversation_id = ?
            AND user_email = ?
            AND status = 'done'
            AND model_type = 'chat'
          ORDER BY turn_index ASC`
      )
        .bind(conversationIdIn, userEmail)
        .all<{ user_input: string; output: string; turn_index: number }>()
        .then((r) => ({ rows: r.results ?? [] }))
    : Promise.resolve({ rows: [] });

  const retrievePromise: Promise<{ chunks: RetrievedChunk[]; error: string | null }> =
    body.use_docs
      ? retrieveContext(env, userEmail, body.user_input)
      : Promise.resolve({ chunks: [], error: null });

  // v0.17.0: web search runs in parallel with RAG retrieval and the
  // attachment walk. Per-source timeouts + catches inside searchWeb bound
  // the worst-case latency to WEB_SEARCH_TIMEOUT_MS.
  const webSearchPromise: Promise<{ results: RetrievedWebResult[]; error: string | null }> =
    body.use_web_search
      ? searchWeb(env, body.user_input)
      : Promise.resolve({ results: [], error: null });

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
      imageDataUrls.push(att.data);
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
      // Parse first (cheap, synchronous), then fan out R2 puts in parallel.
      // Frames are independent: there's no ordering constraint between R2
      // writes, only between the resulting `imageDataUrls` entries (which
      // we preserve by iterating the same parsedFrames array twice).
      const parsedFrames = frames
        .map((fdataUrl) => ({ fdataUrl, parsed: parseDataUrl(fdataUrl) }))
        .filter((p): p is { fdataUrl: string; parsed: { mime: string; base64: string } } => p.parsed !== null);
      const keys = await Promise.all(
        parsedFrames.map(({ parsed }) =>
          r2Put(env, "in", parsed.mime, base64ToBytes(parsed.base64), userEmail)
        )
      );
      for (const { fdataUrl } of parsedFrames) {
        imageDataUrls.push(fdataUrl);
      }
      const dur = att.duration ? ` ${att.duration.toFixed(1)}s` : "";
      const fn = att.filename ? ` "${att.filename}"` : "";
      extraText.push(`[Video${fn}${dur}, ${frames.length} evenly-sampled frames attached below]`);
      persistedAtt.push({ type: "video_frames", keys, frame_count: keys.length, duration: att.duration, filename: att.filename });
    } else if (att.type === "video_full") {
      // Full video file upload for models that need the raw video (Pegasus 1.2).
      // Stored in R2 so it appears in history; the dispatch reads it back from
      // the InputAttachment.data field directly (we don't need to fetch it from
      // R2 since it's already in this request).
      const parsed = att.data ? parseDataUrl(att.data) : null;
      if (!parsed) return json({ error: "Invalid video data URL" }, { status: 400 });
      const bytes = base64ToBytes(parsed.base64);
      const key = await r2Put(env, "in", parsed.mime, bytes, userEmail);
      const fn = att.filename ? ` "${att.filename}"` : "";
      extraText.push(`[Full video${fn} attached for video-aware model]`);
      persistedAtt.push({ type: "video_full", key, mime: parsed.mime, filename: att.filename });
    }
  }

  const userText = [body.user_input, ...extraText].filter(Boolean).join("\n\n");
  const userContent: unknown = imageDataUrls.length
    ? [{ type: "text", text: userText }, ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } }))]
    : userText;

  // ---- Multi-turn conversation continuation (v0.10.0) ----
  // If body.conversation_id is present, fetch prior turns of that conversation
  // (filtered to this user, completed chat turns only) and assemble a history
  // of user/assistant message pairs. The current turn appends to that history.
  // If no conversation_id, generate a new one for the first turn.
  // The SELECT itself runs in parallel with the attachment walk (hoisted
  // above as priorTurnsPromise); here we just consume the result.
  let conversationId = conversationIdIn;
  let turnIndex = 0;
  const priorTurns: Array<{ user_input: string; output: string }> = [];

  if (conversationId) {
    const { rows } = await priorTurnsPromise;
    for (const r of rows) {
      // Skip empty/failed prior turns defensively.
      if (r.user_input && r.output) {
        priorTurns.push({ user_input: r.user_input, output: r.output });
      }
    }
    turnIndex = rows.length ? (rows[rows.length - 1].turn_index + 1) : 0;
  } else {
    // crypto.randomUUID() is available in Workers runtime.
    conversationId = crypto.randomUUID();
  }

  // RAG retrieval (Pass 2) - per-turn, applies only to THIS turn's system prompt.
  // The retrieve itself runs in parallel with the attachment walk + prior-turns
  // fetch (hoisted above as retrievePromise); here we just consume the result.
  const { chunks: retrievedChunks, error: retrievalError } = await retrievePromise;

  // v0.17.0: web-search retrieval, same parallelism pattern as RAG.
  const { results: webResults, error: webSearchError } = await webSearchPromise;
  const allRetrieved: RetrievedItem[] = [...retrievedChunks, ...webResults];

  // Build the effective system prompt: user-supplied prompt followed by
  // the retrieval block(s). Order: user prompt, then RAG (more specific
  // to this user's corpus), then web (more general). Either or both
  // retrieval blocks may be empty.
  const userSystemPrompt = body.system_prompt?.trim() ?? "";
  const retrievalBlock = retrievedChunks.length ? formatRetrievalForSystemPrompt(retrievedChunks) : "";
  const webBlock = webResults.length ? formatWebForSystemPrompt(webResults) : "";
  const effectiveSystemPrompt = [userSystemPrompt, retrievalBlock, webBlock]
    .filter(Boolean)
    .join("\n\n");

  // Build the message array. For Anthropic, system goes as a top-level field
  // on the upstream request (handled inside callAnthropic), not in messages.
  // For Workers AI, xAI, and Bedrock, we push a role:"system" message.
  //
  // Prior turns of this conversation go in as alternating user/assistant
  // text messages. Multimodal content (images) from prior turns is NOT
  // re-included; if the user wants to reference earlier images they can
  // re-attach. Current turn's attachments are still threaded into userContent.
  const wantsSystemInMessages = model.provider !== "anthropic";
  const messages: Array<unknown> = [];
  if (effectiveSystemPrompt && wantsSystemInMessages) {
    messages.push({ role: "system", content: effectiveSystemPrompt });
  }
  for (const t of priorTurns) {
    messages.push({ role: "user", content: t.user_input });
    messages.push({ role: "assistant", content: t.output });
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
    } else if (model.provider === "bedrock") {
      // Pegasus uses a totally different API shape (InvokeModel + video media);
      // Nova family uses Converse. Route accordingly.
      if (model.byok_alias?.startsWith("twelvelabs.pegasus")) {
        const r = await callBedrockPegasus(env, model, body.user_input, body.attachments ?? []);
        result = r.raw;
      } else {
        const r = await callBedrockNova(env, model, effectiveSystemPrompt || undefined, messages);
        result = r.raw;
      }
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
    retrieved_context: allRetrieved.length ? allRetrieved : null,
    conversation_id: conversationId,
    turn_index: turnIndex,
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
    web_results: webResults,
    conversation_id: conversationId,
    turn_index: turnIndex,
    // Diagnostic: when either retrieval source was on, include the exact text
    // that went into the model as the system prompt, plus per-source errors.
    // Inspect via browser DevTools to verify the retrieval block reached
    // the model.
    effective_system_prompt: (body.use_docs || body.use_web_search) ? effectiveSystemPrompt : undefined,
    retrieval_error: body.use_docs ? retrievalError : undefined,
    web_search_error: body.use_web_search ? webSearchError : undefined,
  });
}

// ---------- Image generation ----------

async function runImage(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = getUserEmail(request);

  // OpenAI image gen has a different API (POST /v1/images/generations with a
  // different response shape). Route to a dedicated helper that returns the
  // (bytes, mime) tuple, then share the R2-put + persist + respond tail.
  let bytes: Uint8Array;
  let mime: string;
  let latency: number;
  let logId: string | null = null;

  const start = Date.now();
  try {
    // Two Cloudflare-side complications for Workers AI image gen as of
    // 2026-Q1, both manifesting as either:
      //   - AiError 5006 "required properties at '/' are 'multipart'", or
      //   - "AI Gateway does not support ReadableStreams yet"
      //
      // The matrix:
      //   FLUX-1 schnell, Lucid Origin   - JSON in,    JSON out (base64).   Gateway path works.
      //   FLUX-2 (Klein 9b/4b, Dev)      - multipart in, JSON out (base64). Gateway can't proxy stream input.
      //   Phoenix 1.0, Dreamshaper 8 LCM - JSON in,    ReadableStream out.  Gateway can't proxy stream output.
      //
      // Solution: bypass the AI Gateway for the five problematic models by
      // calling env.AI.run directly without the gateway option, and detect
      // the response shape at runtime so we can drain a ReadableStream into
      // bytes or extract base64 from JSON as appropriate. Cost: no AI Gateway
      // observability/caching for these specific models (ai_gateway_log_id
      // stays null on the persisted row).
      const isFlux2 = model.id.startsWith("@cf/black-forest-labs/flux-2-");
      const bypassGateway = isFlux2
        || model.id === "@cf/leonardo/phoenix-1.0"
        || model.id === "@cf/lykon/dreamshaper-8-lcm";

      let runParams: unknown;

      if (isFlux2) {
        // FLUX.2 requires multipart form data input. FormData doesn't expose
        // its serialized body or boundary directly; wrap in a Response
        // constructor to get the stream + the Content-Type header value
        // with the boundary string.
        const form = new FormData();
        form.append("prompt", body.user_input);
        form.append("width", "1024");
        form.append("height", "1024");
        if (body.system_prompt && body.system_prompt.trim()) {
          // FLUX.2's public schema doesn't list negative_prompt, but the
          // binding ignores unknown form fields rather than erroring.
          form.append("negative_prompt", body.system_prompt);
        }

        // Reference images (v0.16.0): FLUX.2 accepts up to 4 input images
        // via input_image_0..input_image_3 form fields. Each must be at most
        // 512x512 (the frontend downscales before upload). We silently cap
        // beyond 4 rather than erroring, so a user who picks 5 just doesn't
        // see the 5th show up; the picker UI also caps at 4 client-side.
        const inputs: InputAttachment[] = body.attachments ?? [];
        let refIdx = 0;
        for (const att of inputs) {
          if (refIdx >= 4) break;
          if (att.type !== "image" || !att.data) continue;
          const parsed = parseDataUrl(att.data);
          if (!parsed) continue;
          const blob = new Blob([base64ToBytes(parsed.base64)], { type: parsed.mime });
          form.append(`input_image_${refIdx}`, blob, att.filename || `ref-${refIdx}.png`);
          refIdx++;
        }

        const formResponse = new Response(form);
        runParams = {
          multipart: {
            body: formResponse.body!,
            contentType: formResponse.headers.get("content-type")!,
          },
        };
      } else {
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
        runParams = params;
      }

      // Run via the binding. Bypass the gateway for stream-incompatible
      // models; everything else stays on the aiRun helper path (which
      // populates ai_gateway_log_id for observability).
      let result: unknown;
      if (bypassGateway) {
        result = await (env.AI as unknown as { run: RunFn }).run(model.id, runParams);
      } else {
        result = await aiRun(env, model.id, runParams);
        logId = aiLogId(env);
      }

      // Two response shapes are possible:
      //   1. JSON { image: "base64..." } - FLUX-1, FLUX-2, Lucid Origin
      //   2. ReadableStream of raw PNG bytes - Phoenix, Dreamshaper
      // Detect at runtime rather than mapping per-model; safer if Cloudflare
      // shifts a model from one shape to the other.
      if (result instanceof ReadableStream) {
        const reader = result.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            total += value.length;
          }
        }
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          bytes.set(c, offset);
          offset += c.length;
        }
        mime = "image/png";
      } else {
        const b64 = (result as { image?: string })?.image;
        if (!b64 || typeof b64 !== "string") {
          return json({ error: "Image generation returned no image", raw: result }, { status: 502 });
        }
        bytes = base64ToBytes(b64);
        // FLUX.2 outputs PNG; the older JSON path returned JPEG historically.
        mime = isFlux2 ? "image/png" : "image/jpeg";
      }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `Image generation failed: ${m}` }, { status: 502 });
  }
  latency = Date.now() - start;

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
    conversation_id: row.conversation_id,
    turn_index: 0,
  });
}

// ---------- TTS ----------

async function runTts(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = getUserEmail(request);

  let mime: string;
  let bytes: Uint8Array;
  let logId: string | null = null;

  const start = Date.now();
  try {
    // Aura: { text }; MeloTTS: { prompt, lang? }. Send both keys defensively.
    const params: Record<string, unknown> = { text: body.user_input, prompt: body.user_input };
    const resp = await aiRun(env, model.id, params, true /* returnRawResponse */);
    logId = aiLogId(env);
    if (!(resp instanceof Response)) {
      return json({ error: "TTS returned non-Response shape", raw: resp }, { status: 502 });
    }
    mime = resp.headers.get("content-type") || "audio/mpeg";
    bytes = new Uint8Array(await resp.arrayBuffer());
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `TTS failed: ${m}` }, { status: 502 });
  }
  const latency = Date.now() - start;

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
    conversation_id: row.conversation_id,
    turn_index: 0,
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
    conversation_id: row.conversation_id,
    turn_index: 0,
  });
}

// ---------- Music generation (MiniMax via Unified Billing) ----------
//
// As of v0.12.0, music gen uses Cloudflare Workflows for durable execution.
// The runMusic handler creates a LongRunWorkflow instance, persists its ID
// on the chats row as job_id, and returns immediately. The workflow handles
// the actual env.AI.run call (which blocks for ~30-90 seconds), downloads
// the audio, uploads to R2, and finalizes the D1 row.
//
// User input maps to fields:
//   body.user_input    -> "prompt" (style/mood description, ~10-300 chars)
//   body.system_prompt -> "lyrics" (optional, supports [Verse]/[Chorus] tags)

async function runMusic(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  model: ModelEntry,
  body: ChatRequest
): Promise<Response> {
  // ctx unused now that we no longer schedule a waitUntil task; the workflow
  // owns the long-running work. Kept in signature for router compatibility.
  void ctx;
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

  // Kick off the workflow. The instance ID is stored on the row so we can
  // look it up later for status/observability. If create() itself fails
  // (e.g., quota exceeded), fail the row synchronously so the client sees
  // an error rather than an indefinite pending state.
  let instanceId: string;
  try {
    const instance = await env.LONGRUN.create({
      params: {
        rowId: row.id,
        userEmail,
        modelId: model.id,
        prompt: body.user_input,
        lyrics: body.system_prompt ?? "",
        kind: "music",
        startedAtIso: startedAt,
      } satisfies LongRunParams,
    });
    instanceId = instance.id;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await env.DB.prepare(`UPDATE chats SET status = 'failed', job_error = ? WHERE id = ?`)
      .bind(`Workflow create failed: ${m}`.slice(0, 1000), row.id)
      .run();
    return json({ error: `Failed to start music generation: ${m}` }, { status: 502 });
  }

  // Persist the workflow instance ID on the row for traceability.
  await env.DB.prepare(`UPDATE chats SET job_id = ? WHERE id = ?`)
    .bind(instanceId, row.id)
    .run();

  return json({
    id: row.id,
    created_at: row.created_at,
    model: model.id,
    model_type: "music",
    output: "",
    output_artifact: null,
    status: "pending",
    job_started_at: startedAt,
    job_id: instanceId,
    conversation_id: row.conversation_id,
    turn_index: 0,
  });
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
  retrieved_context?: RetrievedItem[] | null;
  conversation_id?: string | null;
  turn_index?: number | null;
}

async function persistChat(env: Env, a: PersistArgs): Promise<{ id: number; created_at: string; conversation_id: string }> {
  // For non-chat model types (image/tts/video/etc), conversation_id is
  // auto-assigned as a synthetic per-row key so the rows still group in the
  // sidebar as single-turn entries.
  const convId = a.conversation_id ?? null;
  const turnIdx = a.turn_index ?? null;

  const row = await env.DB.prepare(
    `INSERT INTO chats
       (user_email, model, model_type, system_prompt, user_input, output,
        output_artifact, attachments,
        tokens_in, tokens_out, latency_ms, ai_gateway_log_id,
        status, job_id, job_provider, job_error, job_started_at,
        retrieved_context, conversation_id, turn_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      a.retrieved_context && a.retrieved_context.length ? JSON.stringify(a.retrieved_context) : null,
      convId,
      turnIdx
    )
    .first<{ id: number; created_at: string }>();

  if (!row) {
    return { id: 0, created_at: new Date().toISOString(), conversation_id: "" };
  }

  // For non-chat rows that didn't get an explicit conversation_id, backfill
  // a synthetic one so they appear in the conversation list.
  let finalConvId = convId;
  if (!finalConvId) {
    finalConvId = `single-${row.id}`;
    await env.DB.prepare(
      `UPDATE chats SET conversation_id = ?, turn_index = 0 WHERE id = ?`
    )
      .bind(finalConvId, row.id)
      .run();
  }

  return { id: row.id, created_at: row.created_at, conversation_id: finalConvId };
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

// ---------- runChatStream + callAnthropicStream (v0.13.0) ----------
//
// Streaming counterpart of runChat. Shares the prelude contract (parallel
// hoisting of priorTurnsPromise + retrievePromise overlapping the attachment
// walk; multi-turn continuation; RAG system-prompt assembly) and diverges
// at the model call: callAnthropicStream is an async generator that yields
// normalized text deltas and usage events.
//
// Wire format on the response body (text/event-stream):
//   data: {"type":"delta","text":"..."}
//   data: {"type":"done","row_id":N,"latency_ms":N,"tokens_in":N|null,
//          "tokens_out":N|null,"conversation_id":"...","turn_index":N}
//   data: {"type":"error","message":"..."}
//
// Anthropic's native SSE event types (message_start, content_block_delta,
// content_block_stop, message_delta, message_stop, ping, etc.) are stripped
// inside callAnthropicStream and normalized to the envelope above.
//
// On client disconnect, the next writer.write() throws; we abort the
// upstream Anthropic fetch via AbortController and exit without persisting
// the partial response. Design decision B (Pass 1): drop partials.
//
// NOTE: the prelude here intentionally duplicates the prelude in runChat.
// Both functions own the same shape but persist + respond differently. A
// later pass may extract a shared helper; for Pass 1 the duplication is
// bounded and easier to read than a parameterized abstraction.

async function runChatStream(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = getUserEmail(request);
  const inputs: InputAttachment[] = body.attachments ?? [];

  // Hot-path parallelization (mirrors runChat v0.12.1). Kick off SELECT +
  // RAG retrieve before the attachment walk; await at the existing use sites.
  const conversationIdIn = body.conversation_id?.trim() || "";
  const priorTurnsPromise: Promise<{
    rows: Array<{ user_input: string; output: string; turn_index: number }>;
  }> = conversationIdIn
    ? env.DB.prepare(
        `SELECT user_input, output, turn_index
           FROM chats
          WHERE conversation_id = ?
            AND user_email = ?
            AND status = 'done'
            AND model_type = 'chat'
          ORDER BY turn_index ASC`
      )
        .bind(conversationIdIn, userEmail)
        .all<{ user_input: string; output: string; turn_index: number }>()
        .then((r) => ({ rows: r.results ?? [] }))
    : Promise.resolve({ rows: [] });

  const retrievePromise: Promise<{ chunks: RetrievedChunk[]; error: string | null }> =
    body.use_docs
      ? retrieveContext(env, userEmail, body.user_input)
      : Promise.resolve({ chunks: [], error: null });

  // v0.17.0: web search runs in parallel with RAG retrieval, same as runChat.
  const webSearchPromise: Promise<{ results: RetrievedWebResult[]; error: string | null }> =
    body.use_web_search
      ? searchWeb(env, body.user_input)
      : Promise.resolve({ results: [], error: null });

  // Attachment walk. Reach completion before any bytes flow back; streaming
  // helps with time-to-last-token, not time-to-first-token on multimodal turns.
  const extraText: string[] = [];
  const imageDataUrls: string[] = [];
  const persistedAtt: PersistedAttachment[] = [];

  for (const att of inputs) {
    if (att.type === "image") {
      if (!model.capabilities.includes("vision")) {
        return json({ error: `Model ${model.id} does not support vision.` }, { status: 400 });
      }
      const parsed = att.data ? parseDataUrl(att.data) : null;
      if (!parsed) return json({ error: "Invalid image data URL" }, { status: 400 });
      const bytes = base64ToBytes(parsed.base64);
      const key = await r2Put(env, "in", parsed.mime, bytes, userEmail);
      imageDataUrls.push(att.data);
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
        return json({ error: `Model ${model.id} does not support vision.` }, { status: 400 });
      }
      const frames = att.frames ?? [];
      const parsedFrames = frames
        .map((fdataUrl) => ({ fdataUrl, parsed: parseDataUrl(fdataUrl) }))
        .filter((p): p is { fdataUrl: string; parsed: { mime: string; base64: string } } => p.parsed !== null);
      const keys = await Promise.all(
        parsedFrames.map(({ parsed }) =>
          r2Put(env, "in", parsed.mime, base64ToBytes(parsed.base64), userEmail)
        )
      );
      for (const { fdataUrl } of parsedFrames) {
        imageDataUrls.push(fdataUrl);
      }
      const dur = att.duration ? ` ${att.duration.toFixed(1)}s` : "";
      const fn = att.filename ? ` "${att.filename}"` : "";
      extraText.push(`[Video${fn}${dur}, ${frames.length} evenly-sampled frames attached below]`);
      persistedAtt.push({ type: "video_frames", keys, frame_count: keys.length, duration: att.duration, filename: att.filename });
    } else if (att.type === "video_full") {
      // Anthropic Messages API doesn't accept raw video. Reject explicitly
      // so the user picks a different model rather than getting silent
      // truncation. (Pegasus is the only video-aware model and it's non-streaming.)
      return json({ error: "Anthropic streaming does not accept raw video attachments. Use a non-streaming model that supports video, or attach extracted frames instead." }, { status: 400 });
    }
  }

  const userText = [body.user_input, ...extraText].filter(Boolean).join("\n\n");
  const userContent: unknown = imageDataUrls.length
    ? [{ type: "text", text: userText }, ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } }))]
    : userText;

  // Consume the parallel-hoisted promises.
  let conversationId = conversationIdIn;
  let turnIndex = 0;
  const priorTurns: Array<{ user_input: string; output: string }> = [];

  if (conversationId) {
    const { rows } = await priorTurnsPromise;
    for (const r of rows) {
      if (r.user_input && r.output) {
        priorTurns.push({ user_input: r.user_input, output: r.output });
      }
    }
    turnIndex = rows.length ? (rows[rows.length - 1].turn_index + 1) : 0;
  } else {
    conversationId = crypto.randomUUID();
  }

  const { chunks: retrievedChunks } = await retrievePromise;
  const { results: webResults } = await webSearchPromise;
  const allRetrieved: RetrievedItem[] = [...retrievedChunks, ...webResults];

  const userSystemPrompt = body.system_prompt?.trim() ?? "";
  const retrievalBlock = retrievedChunks.length ? formatRetrievalForSystemPrompt(retrievedChunks) : "";
  const webBlock = webResults.length ? formatWebForSystemPrompt(webResults) : "";
  const effectiveSystemPrompt = [userSystemPrompt, retrievalBlock, webBlock]
    .filter(Boolean)
    .join("\n\n");

  // Build the message array. For providers that take system as a separate
  // top-level param (Anthropic), we DON'T include a system role here;
  // callAnthropicStream pulls effectiveSystemPrompt to a top-level field.
  // For Workers AI (and any future provider that accepts role:"system" in
  // messages, like xAI's OpenAI-compatible API), we DO push it.
  const wantsSystemInMessages = !(model.provider === "anthropic");
  const messages: Array<unknown> = [];
  if (effectiveSystemPrompt && wantsSystemInMessages) {
    messages.push({ role: "system", content: effectiveSystemPrompt });
  }
  for (const t of priorTurns) {
    messages.push({ role: "user", content: t.user_input });
    messages.push({ role: "assistant", content: t.output });
  }
  messages.push({ role: "user", content: userContent });

  // TransformStream pattern: return `readable` as the response body, write
  // SSE events to `writer`. The worker stays alive while writer is open, so
  // the background IIFE doesn't need ctx.waitUntil.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Emit one SSE event. Returns false if the writer is closed (client
  // disconnected); caller uses this to short-circuit + abort upstream.
  const emit = async (event: Record<string, unknown>): Promise<boolean> => {
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      return true;
    } catch {
      return false;
    }
  };

  const upstreamAbort = new AbortController();
  const start = Date.now();

  // Background IIFE drives the stream. Does NOT await; this function returns
  // the Response immediately while the IIFE writes events to the body.
  (async () => {
    let accumulated = "";
    let usageIn: number | null = null;
    let usageOut: number | null = null;

    try {
      // Dispatch per provider. All generators yield the same ProviderStreamEvent
      // shape so the consumer loop is provider-agnostic.
      let streamGenerator: AsyncGenerator<ProviderStreamEvent>;
      if (model.provider === "anthropic") {
        streamGenerator = callAnthropicStream(env, model, effectiveSystemPrompt || undefined, messages, upstreamAbort.signal);
      } else if (model.provider === "xai") {
        streamGenerator = callXaiStream(env, model, messages, upstreamAbort.signal);
      } else if (model.provider === "bedrock") {
        streamGenerator = callBedrockNovaStream(env, model, effectiveSystemPrompt || undefined, messages, upstreamAbort.signal);
      } else {
        streamGenerator = callWorkersAIStream(env, model, messages, upstreamAbort.signal);
      }

      for await (const ev of streamGenerator) {
        if (ev.type === "text") {
          accumulated += ev.text;
          const ok = await emit({ type: "delta", text: ev.text });
          if (!ok) {
            // Client gone. Abort upstream so we stop paying for tokens
            // and exit without persisting (Pass 1: drop partials).
            upstreamAbort.abort();
            return;
          }
        } else if (ev.type === "usage") {
          if (ev.in_ !== null) usageIn = ev.in_;
          if (ev.out_ !== null) usageOut = ev.out_;
        }
      }

      const latency = Date.now() - start;

      // Persist as a single row. retrieved_context is saved on the row so
      // the History/Conversation views render citations the same way runChat
      // does. v0.17.0: web-search results are stored in the same column with
      // a source_type discriminator. ai_gateway_log_id is null: streaming
      // responses from AI Gateway don't surface cf-aig-log-id on the proxied
      // SSE response.
      const row = await persistChat(env, {
        userEmail,
        model: model.id,
        model_type: "chat",
        system_prompt: body.system_prompt ?? null,
        user_input: body.user_input,
        output: accumulated,
        output_artifact: null,
        attachments: persistedAtt,
        tokens_in: usageIn,
        tokens_out: usageOut,
        latency_ms: latency,
        ai_gateway_log_id: null,
        retrieved_context: allRetrieved.length ? allRetrieved : null,
        conversation_id: conversationId,
        turn_index: turnIndex,
      });

      await emit({
        type: "done",
        row_id: row.id,
        latency_ms: latency,
        tokens_in: usageIn,
        tokens_out: usageOut,
        conversation_id: conversationId,
        turn_index: turnIndex,
      });
    } catch (err) {
      // Self-triggered AbortError (we aborted because client disconnected)
      // is expected; suppress it. Anything else is surfaced to the client
      // as a terminal error event.
      if (err instanceof Error && err.name === "AbortError") return;
      const m = err instanceof Error ? err.message : String(err);
      await emit({ type: "error", message: m });
    } finally {
      try { await writer.close(); } catch { /* writer may already be closed */ }
    }
  })();

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // Disable any in-path buffering. Cloudflare doesn't buffer streaming
      // responses but downstream proxies (Nginx etc.) might; this is the
      // standard hint to flush per-event.
      "x-accel-buffering": "no",
    },
  });
}

// Normalized event shape yielded by every per-provider streaming adapter
// (callAnthropicStream today; callWorkersAIStream as of Pass 2; future xAI
// and Bedrock adapters in Pass 3/4). runChatStream's consumer loop stays
// generic over this type.
type ProviderStreamEvent =
  | { type: "text"; text: string }
  | { type: "usage"; in_: number | null; out_: number | null };

// Async generator: drives Anthropic's Messages API in streaming mode and
// yields normalized events. Strips Anthropic's verbose SSE envelope
// (message_start, content_block_start, content_block_delta, content_block_stop,
// message_delta, message_stop, ping) to just text + usage.
//
// Anthropic emits usage in two places:
//   - message_start: { usage: { input_tokens, output_tokens } } (initial small)
//   - message_delta: { usage: { input_tokens, output_tokens } } (cumulative)
// We yield both; the caller keeps the latest non-null value, so the final
// message_delta wins for output_tokens and message_start typically wins for
// input_tokens (it's a one-shot value).
async function* callAnthropicStream(
  env: Env,
  model: ModelEntry,
  systemPrompt: string | undefined,
  messages: Array<unknown>,
  signal: AbortSignal
): AsyncGenerator<ProviderStreamEvent> {
  const { system, messages: aMessages } = transformToAnthropic(messages, systemPrompt);

  const baseUrl = await (env.AI as unknown as {
    gateway: (id: string) => { getUrl: (provider: string) => Promise<string> };
  }).gateway(env.GATEWAY_ID).getUrl("anthropic");

  const modelName = model.id.replace(/^anthropic\//, "");

  const body: Record<string, unknown> = {
    model: modelName,
    max_tokens: 4096,
    messages: aMessages,
    stream: true,
  };
  if (system) body.system = system;

  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "accept": "text/event-stream",
  };
  if (env.ANTHROPIC_API_KEY) headers["x-api-key"] = env.ANTHROPIC_API_KEY;
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${errText.slice(0, 500)}`);
  }
  if (!resp.body) throw new Error("Anthropic returned no stream body");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE event boundaries are \n\n. Within an event, the fields we care
      // about are `data: <json>` lines; everything else (event: name, id:,
      // retry:) we ignore. Anthropic uses `event:` for the type and `data:`
      // for the payload; the payload's own `type` field also carries the
      // event kind, so we can rely on that alone.
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;

        let dataPayload = "";
        for (const line of part.split("\n")) {
          if (line.startsWith("data: ")) dataPayload = line.slice(6);
          else if (line.startsWith("data:")) dataPayload = line.slice(5);
        }
        if (!dataPayload || dataPayload === "[DONE]") continue;

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(dataPayload);
        } catch {
          continue;
        }

        const evType = data.type as string | undefined;
        if (evType === "content_block_delta") {
          const delta = data.delta as { type?: string; text?: string } | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            yield { type: "text", text: delta.text };
          }
        } else if (evType === "message_start") {
          const msg = data.message as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
          if (msg?.usage) {
            yield {
              type: "usage",
              in_: msg.usage.input_tokens ?? null,
              out_: msg.usage.output_tokens ?? null,
            };
          }
        } else if (evType === "message_delta") {
          const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
          if (usage) {
            yield {
              type: "usage",
              in_: usage.input_tokens ?? null,
              out_: usage.output_tokens ?? null,
            };
          }
        }
        // content_block_start, content_block_stop, message_stop, ping: ignored
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* fine */ }
  }
}

// ---------- callWorkersAIStream (v0.13.0 Pass 2) ----------
//
// Async generator: drives a Workers AI chat model via env.AI.run with
// stream:true and yields normalized text + usage events.
//
// Workers AI streaming returns a ReadableStream from env.AI.run, already
// SSE-formatted. Event shape is OpenAI-compatible:
//   data: {"response":"..."}                       // one per token chunk
//   data: {"response":"","usage":{...}}            // optional final usage chunk
//   data: [DONE]                                   // terminal sentinel
//
// Reasoning models (gpt-oss-120b, qwq-32b, deepseek-r1-distill-qwen-32b)
// emit <think>...</think> blocks inside `response`. Pass 2 streams them
// through as-is; future UX pass can strip or fold them into a toggle.
//
// Abort handling: env.AI.run doesn't accept an AbortSignal. We bridge
// signal -> reader.cancel() so client disconnect propagates cancellation
// up the binding pipeline and we stop being billed mid-generation.

async function* callWorkersAIStream(
  env: Env,
  model: ModelEntry,
  messages: Array<unknown>,
  signal: AbortSignal
): AsyncGenerator<ProviderStreamEvent> {
  const result = await aiRun(env, model.id, { messages, stream: true });

  if (!(result instanceof ReadableStream)) {
    throw new Error(`Workers AI did not return a stream (got ${typeof result}). Ensure stream:true is honored by this model.`);
  }

  const reader = result.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Bridge AbortSignal -> reader.cancel(). If the signal is already aborted
  // by the time we get here, cancel immediately.
  const onAbort = () => { try { reader.cancel(); } catch { /* fine */ } };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;

        let payload = "";
        for (const line of part.split("\n")) {
          if (line.startsWith("data: ")) payload = line.slice(6);
          else if (line.startsWith("data:")) payload = line.slice(5);
        }
        if (!payload || payload === "[DONE]") continue;

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }

        // Text delta. `response` is the OpenAI-style per-chunk field. Empty
        // strings are normal on the final chunk (which carries usage); skip them.
        const resp = data.response;
        if (typeof resp === "string" && resp.length > 0) {
          yield { type: "text", text: resp };
        }

        // Usage. Workers AI uses OpenAI naming; some adapters fall back to
        // the Anthropic naming. Accept both, prefer OpenAI.
        const usage = data.usage as {
          prompt_tokens?: number;
          completion_tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
        } | undefined;
        if (usage) {
          yield {
            type: "usage",
            in_: usage.prompt_tokens ?? usage.input_tokens ?? null,
            out_: usage.completion_tokens ?? usage.output_tokens ?? null,
          };
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* fine */ }
  }
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

// v0.17.2: shared request builder for both callXai (non-streaming) and
// callXaiStream (SSE). All the URL/headers/body construction lives here;
// callers differ only in whether they pass `signal`, whether they read
// `cf-aig-log-id`, and how they consume the response body.

async function prepareXaiRequest(
  env: Env,
  model: ModelEntry,
  messages: Array<unknown>,
  opts: { stream: boolean },
): Promise<{ url: string; headers: Record<string, string>; body: string }> {
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
  if (opts.stream) {
    body.stream = true;
    // include_usage:true asks xAI to send token counts in the final pre-[DONE]
    // chunk. Without this, usage stays null on streamed responses.
    body.stream_options = { include_usage: true };
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (env.XAI_API_KEY) headers["Authorization"] = `Bearer ${env.XAI_API_KEY}`;
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  return {
    url: `${baseUrl}/v1/chat/completions`,
    headers,
    body: JSON.stringify(body),
  };
}

async function callXai(
  env: Env,
  model: ModelEntry,
  messages: Array<unknown>
): Promise<{ raw: unknown; logId: string | null }> {
  const { url, headers, body } = await prepareXaiRequest(env, model, messages, { stream: false });

  const resp = await fetch(url, { method: "POST", headers, body });

  const logId = resp.headers.get("cf-aig-log-id");

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`xAI API ${resp.status}: ${errText.slice(0, 500)}`);
  }

  const raw = await resp.json();
  return { raw, logId };
}

// ---------- callXaiStream (v0.13.x Pass 3) ----------
//
// Async generator: drives an xAI Grok model via direct fetch with stream:true
// and yields normalized text + usage events.
//
// xAI uses standard OpenAI-compatible SSE:
//   data: {"choices":[{"delta":{"content":"..."}}]}        // per chunk
//   data: {"choices":[],"usage":{...}}                      // final usage chunk
//   data: [DONE]                                            // terminal sentinel
//
// The usage chunk only fires when stream_options.include_usage:true is set
// on the request, which we do. The gateway proxies the SSE body through
// transparently.
//
// Abort handling: fetch() takes the AbortSignal directly. When the client
// disconnects, runChatStream aborts the controller and the upstream fetch
// is cancelled mid-stream, releasing the worker invocation immediately.

async function* callXaiStream(
  env: Env,
  model: ModelEntry,
  messages: Array<unknown>,
  signal: AbortSignal
): AsyncGenerator<ProviderStreamEvent> {
  const { url, headers, body } = await prepareXaiRequest(env, model, messages, { stream: true });

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`xAI API ${resp.status}: ${errText.slice(0, 500)}`);
  }
  if (!resp.body) {
    throw new Error("xAI streaming: response body missing");
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;
        let payload = "";
        for (const line of part.split("\n")) {
          if (line.startsWith("data: ")) payload = line.slice(6);
          else if (line.startsWith("data:")) payload = line.slice(5);
        }
        if (!payload || payload === "[DONE]") continue;

        let data: {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }

        const text = data.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text.length > 0) {
          yield { type: "text", text };
        }

        if (data.usage) {
          yield {
            type: "usage",
            in_: data.usage.prompt_tokens ?? null,
            out_: data.usage.completion_tokens ?? null,
          };
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* fine */ }
  }
}

// ---------- Amazon Bedrock chat - Nova family (BYOK, v0.11.0) ----------
//
// Bedrock requires AWS SigV4 signed requests. We use the aws4fetch library to
// handle signing (compact, designed for Workers runtime). All Nova models
// (Nova 2 Lite, Nova 2 Pro, Nova Lite, Nova Pro) use the Converse API which
// normalizes request/response shapes across model families.
//
// Converse API message shape transforms FROM our internal {role, content}
// format TO Bedrock's:
//   - role: "system" extracted to a top-level `system: [{text}]` array
//   - role: "user"|"assistant" with content string becomes
//     {role, content: [{text: "..."}]}
//
// Response shape: { output: { message: { content: [{ text: "..." }] } }, ... }
// extractOutput already handles the .text field via a fall-through case
// we'll add below.

// v0.17.2: shared request builder for both callBedrockNova (non-streaming)
// and callBedrockNovaStream (eventstream). All the AWS client setup, model-
// name resolution, message transform, and URL construction lives here. The
// only thing that differs between the two callers is the endpoint suffix
// (converse vs converse-stream), driven by opts.stream.

async function prepareBedrockNovaRequest(
  env: Env,
  model: ModelEntry,
  systemPrompt: string | undefined,
  messages: Array<unknown>,
  opts: { stream: boolean },
) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set; Bedrock BYOK requires AWS credentials (npx wrangler secret put AWS_ACCESS_KEY_ID; npx wrangler secret put AWS_SECRET_ACCESS_KEY)");
  }
  const region = env.AWS_REGION || "us-east-1";
  const modelName = model.byok_alias ?? model.id.replace(/^bedrock\//, "");

  // Transform our messages array into Bedrock Converse format. System messages
  // are pulled out separately; user/assistant become content-block arrays.
  const bedrockMessages: Array<{ role: string; content: Array<{ text: string }> }> = [];
  for (const msg of messages) {
    const m = msg as { role: string; content: unknown };
    if (m.role === "system") continue; // we use systemPrompt arg instead
    if (typeof m.content === "string") {
      bedrockMessages.push({ role: m.role, content: [{ text: m.content }] });
    } else if (Array.isArray(m.content)) {
      // Multi-part content (e.g. text + image). For now, concatenate text parts.
      // TODO: pass through image parts as Bedrock image content blocks when adding vision.
      const textParts = (m.content as Array<{ type?: string; text?: string }>)
        .filter((p) => p.type === "text" || typeof p.text === "string")
        .map((p) => p.text || "")
        .join("\n");
      bedrockMessages.push({ role: m.role, content: [{ text: textParts || "(empty)" }] });
    }
  }

  const body: Record<string, unknown> = {
    messages: bedrockMessages,
    inferenceConfig: { maxTokens: 4096 },
  };
  if (systemPrompt) {
    body.system = [{ text: systemPrompt }];
  }

  // Dynamic import so the aws4fetch bundle isn't loaded for users who only
  // use other providers.
  const { AwsClient } = await import("aws4fetch");
  const awsClient = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region,
    service: "bedrock",
  });

  // Endpoint suffix: converse for sync, converse-stream for SSE.
  const endpoint = opts.stream ? "converse-stream" : "converse";
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelName)}/${endpoint}`;

  return { awsClient, url, bodyJson: JSON.stringify(body) };
}

async function callBedrockNova(
  env: Env,
  model: ModelEntry,
  systemPrompt: string | undefined,
  messages: Array<unknown>
): Promise<{ raw: unknown; logId: string | null }> {
  const { awsClient, url, bodyJson } = await prepareBedrockNovaRequest(
    env, model, systemPrompt, messages, { stream: false },
  );

  const resp = await awsClient.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyJson,
  });

  if (!resp.ok) {
    throw new Error(`Bedrock Nova ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  const raw = await resp.json();
  // logId: Bedrock doesn't return a Cloudflare-style log id. Pass null.
  return { raw, logId: null };
}

// ---------- callBedrockNovaStream (v0.13.x Pass 4) ----------
//
// Async generator: drives a Bedrock Nova model via ConverseStream and yields
// normalized text + usage events.
//
// Bedrock streams over the application/vnd.amazon.eventstream binary protocol.
// Each frame:
//   [4 bytes BE]  total_length          (entire frame including itself)
//   [4 bytes BE]  headers_length        (size of headers section in bytes)
//   [4 bytes BE]  prelude_crc           (CRC32 of first 8 bytes - we skip)
//   [headers_length bytes]  headers     (name/type/value triplets)
//   [payload_bytes]         payload     (JSON for the events we care about)
//   [4 bytes BE]  message_crc           (CRC32 of everything before - we skip)
//
//   payload_bytes = total_length - 16 - headers_length
//
// Headers are name/type/value triplets:
//   [1 byte] name_length
//   [name_length bytes] name (UTF-8)
//   [1 byte] value_type           (0/1 = bool; 2 = byte; 3 = i16; 4 = i32;
//                                   5/8 = 8-byte; 6 = byte array; 7 = string;
//                                   9 = uuid)
//   [value]
//
// All headers we care about (:message-type, :event-type, :content-type) are
// type 7 (string with 2-byte BE length prefix). Other types are parsed for
// length and skipped defensively so an unknown header doesn't desync the
// stream.
//
// Event types we react to:
//   contentBlockDelta -> {"delta":{"text":"..."},"contentBlockIndex":N}
//   metadata          -> {"usage":{"inputTokens":N,"outputTokens":M},...}
//
// Other event types (messageStart, contentBlockStart, contentBlockStop,
// messageStop) carry no info we need for the flat envelope.
//
// Errors arrive as :message-type=exception with the exception name in
// :event-type. The payload is a JSON error description.
//
// Abort handling: aws4fetch forwards `signal` to fetch(), so client
// disconnect cancels the upstream request mid-stream.

async function* callBedrockNovaStream(
  env: Env,
  model: ModelEntry,
  systemPrompt: string | undefined,
  messages: Array<unknown>,
  signal: AbortSignal
): AsyncGenerator<ProviderStreamEvent> {
  const { awsClient, url, bodyJson } = await prepareBedrockNovaRequest(
    env, model, systemPrompt, messages, { stream: true },
  );

  const resp = await awsClient.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyJson,
    signal,
  });

  if (!resp.ok) {
    throw new Error(`Bedrock Nova streaming ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  if (!resp.body) {
    throw new Error("Bedrock Nova streaming: response body missing");
  }

  const reader = resp.body.getReader();
  let buf = new Uint8Array(0);

  function append(bytes: Uint8Array) {
    const merged = new Uint8Array(buf.length + bytes.length);
    merged.set(buf, 0);
    merged.set(bytes, buf.length);
    buf = merged;
  }

  function readU32BE(at: number): number {
    return (
      ((buf[at] << 24) |
        (buf[at + 1] << 16) |
        (buf[at + 2] << 8) |
        buf[at + 3]) >>> 0
    );
  }

  function parseHeaders(start: number, end: number): Record<string, string> {
    const out: Record<string, string> = {};
    const td = new TextDecoder();
    let p = start;
    while (p < end) {
      const nameLen = buf[p]; p += 1;
      if (p + nameLen > end) break;
      const name = td.decode(buf.subarray(p, p + nameLen)); p += nameLen;
      if (p >= end) break;
      const valType = buf[p]; p += 1;
      if (valType === 7) {
        // String: 2-byte BE length, then UTF-8 data.
        if (p + 2 > end) break;
        const valLen = (buf[p] << 8) | buf[p + 1]; p += 2;
        if (p + valLen > end) break;
        out[name] = td.decode(buf.subarray(p, p + valLen)); p += valLen;
      } else {
        // Skip non-string header types defensively per the AWS EventStream spec.
        if (valType === 0 || valType === 1) {
          // boolean, no payload bytes
        } else if (valType === 2) {
          p += 1;
        } else if (valType === 3) {
          p += 2;
        } else if (valType === 4) {
          p += 4;
        } else if (valType === 5 || valType === 8) {
          p += 8;
        } else if (valType === 6) {
          if (p + 2 > end) break;
          const dlen = (buf[p] << 8) | buf[p + 1];
          p += 2 + dlen;
        } else if (valType === 9) {
          p += 16;
        } else {
          // Unknown type, give up cleanly with what we have.
          return out;
        }
      }
    }
    return out;
  }

  const td = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      append(value);

      // Drain as many complete frames as the buffer holds.
      while (buf.length >= 12) {
        const totalLen = readU32BE(0);
        if (totalLen < 16 || totalLen > 16 * 1024 * 1024) {
          throw new Error(`Bedrock Nova streaming: bogus frame length ${totalLen}`);
        }
        if (buf.length < totalLen) break; // wait for more bytes

        const headersLen = readU32BE(4);
        const headersStart = 12; // skip prelude_crc at bytes 8..11
        const headersEnd = headersStart + headersLen;
        const payloadStart = headersEnd;
        const payloadEnd = totalLen - 4; // message_crc trails
        const headers = parseHeaders(headersStart, headersEnd);

        const messageType = headers[":message-type"];
        const eventType = headers[":event-type"];

        const payloadText = td.decode(buf.subarray(payloadStart, payloadEnd));

        // Advance past this frame in the buffer.
        buf = buf.slice(totalLen);

        if (messageType === "exception") {
          let msg = payloadText;
          try {
            const obj = JSON.parse(payloadText) as { message?: string; Message?: string };
            msg = obj.message ?? obj.Message ?? payloadText;
          } catch { /* keep raw */ }
          throw new Error(`Bedrock Nova stream exception (${eventType ?? "unknown"}): ${msg.slice(0, 500)}`);
        }

        if (messageType !== "event") continue;

        let data: {
          delta?: { text?: string };
          usage?: { inputTokens?: number; outputTokens?: number };
        };
        try {
          data = JSON.parse(payloadText);
        } catch {
          continue;
        }

        if (eventType === "contentBlockDelta") {
          const text = data.delta?.text;
          if (typeof text === "string" && text.length > 0) {
            yield { type: "text", text };
          }
        } else if (eventType === "metadata") {
          if (data.usage) {
            yield {
              type: "usage",
              in_: data.usage.inputTokens ?? null,
              out_: data.usage.outputTokens ?? null,
            };
          }
        }
        // messageStart, contentBlockStart, contentBlockStop, messageStop
        // carry no info we need for the flat envelope.
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* fine */ }
  }
}

// ---------- TwelveLabs Pegasus 1.2 on Bedrock (v0.11.0) ----------
//
// Pegasus is video-Q&A: takes a video file and a text prompt, returns text
// analysis. Different from chat in that:
//   - Doesn't use Converse API; uses InvokeModel directly
//   - Requires a video attachment (validated in dispatch)
//   - Body shape: {inputPrompt: string, mediaSource: {base64String|s3Location}}
//   - Region restricted: us-west-2 or eu-west-1 only (cross-region inference
//     from other US/EU regions can work; configurable via AWS_REGION_PEGASUS).
//   - Bedrock InvokeModel payload limit is 25MB, so base64-encoded video must
//     stay under roughly 18MB binary. Larger videos would require S3 (not
//     supported in this build - we'd need to add an S3 binding).

async function callBedrockPegasus(
  env: Env,
  model: ModelEntry,
  prompt: string,
  attachments: InputAttachment[]
): Promise<{ raw: unknown; logId: string | null }> {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set for Pegasus BYOK");
  }

  // Find the first video attachment. Pegasus requires exactly one video.
  // Frontend uploads as "video_full" (the raw video file as a data URL) when
  // the selected model is Pegasus, rather than the default frame-extraction
  // behavior used for vision-capable chat models.
  // v0.17.1: type predicate narrows the find result to InputVideoFullAttachment
  // so videoAtt.data is typed `string` without needing a `?? ""` fallback.
  const videoAtt = attachments.find(
    (a): a is InputVideoFullAttachment => a.type === "video_full",
  );
  if (!videoAtt) {
    throw new Error("Pegasus 1.2 requires a video attachment. Attach an .mp4 (or similar) file before sending the prompt.");
  }

  // Decode the data URL to raw bytes, then re-encode as base64 (no data: prefix).
  // videoAtt.data is a "data:video/mp4;base64,AAAA..." string per the type.
  const dataUrl = videoAtt.data;
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx < 0) {
    throw new Error("Pegasus: video attachment data URL is malformed");
  }
  const base64Raw = dataUrl.slice(commaIdx + 1);

  // Hard size check. 18MB binary = ~24MB base64. Bedrock InvokeModel cap is 25MB.
  // Conservatively reject videos that base64-encode to over 24MB.
  const PEGASUS_MAX_BASE64_BYTES = 24 * 1024 * 1024;
  if (base64Raw.length > PEGASUS_MAX_BASE64_BYTES) {
    const mb = (base64Raw.length * 0.75 / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Pegasus: video too large (~${mb}MB binary). Bedrock InvokeModel has a 25MB request limit; ` +
      `videos must be under roughly 18MB. For larger videos you'd need S3 integration (not yet supported).`
    );
  }

  // Region selection: Pegasus is only available in us-west-2 and eu-west-1.
  // AWS_REGION_PEGASUS lets the operator pin Pegasus to a different region
  // than the default Nova region (which is typically us-east-1).
  const region = env.AWS_REGION_PEGASUS || env.AWS_REGION || "us-west-2";

  const body = {
    inputPrompt: prompt,
    mediaSource: { base64String: base64Raw },
    temperature: 0.2,
  };

  const { AwsClient } = await import("aws4fetch");
  const awsClient = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region,
    service: "bedrock",
  });

  const modelName = model.byok_alias ?? "twelvelabs.pegasus-1-2-v1:0";
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelName)}/invoke`;

  const resp = await awsClient.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Pegasus ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  const raw = await resp.json();
  return { raw, logId: null };
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
// Video gen takes 30s-3min. env.AI.run for these models blocks until
// completion. Two architectures coexist:
//
//   - BYOK path (xAI Grok video, Google Veo with API key): submit-and-poll.
//     The submit returns a job_id in <30s; each client poll of /api/job/:id
//     triggers ONE upstream poll in a fresh worker invocation. Download to
//     R2 happens when upstream reports done.
//
//   - Unified Billing path (v0.12.0+): Cloudflare Workflows. The runVideo
//     handler creates a LongRunWorkflow instance, persists its ID on the
//     row, and returns immediately. The workflow class (defined at the
//     bottom of this file) holds the long blocking env.AI.run call alive
//     across step boundaries, then downloads and finalizes D1.
//
// Both paths populate chats.output_artifact and let the frontend poll
// /api/job/:id for status (which just reads D1 in the Unified path; the
// workflow itself updates D1 when done).

async function runVideo(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  model: ModelEntry,
  body: ChatRequest
): Promise<Response> {
  // ctx is no longer used: BYOK paths are sync-submit, Unified Billing path
  // delegates to LongRunWorkflow. Kept in the signature for router uniformity.
  void ctx;
  const userEmail = getUserEmail(request);
  const startedAt = new Date().toISOString();
  const isBYOK = !!(model.byok_alias && model.provider === "xai");

  // BYOK path: do the submit synchronously (one fast HTTP call, well within
  // the worker's request budget). Save the upstream job_id on the row so the
  // poll endpoint can check status without re-submitting. This avoids using
  // ctx.waitUntil for the long-running poll loop - waitUntil only gets ~30s
  // after the response, which is far less than the 1-3 minutes needed.
  if (isBYOK) {
    let submit: BYOKSubmitResult;
    try {
      submit = await submitVideoXai(env, model.byok_alias!, body.user_input);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return json({ error: `Video submit failed: ${m}` }, { status: 502 });
    }

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
      job_id: submit.job_id,
      job_provider: model.provider ?? null,
      job_error: null,
      job_started_at: startedAt,
    });

    return json({
      id: row.id,
      created_at: row.created_at,
      model: model.id,
      model_type: "video",
      output: "",
      output_artifact: null,
      status: "pending",
      job_started_at: startedAt,
      job_id: submit.job_id,
      conversation_id: row.conversation_id,
      turn_index: 0,
    });
  }

  // Unified Billing path (env.AI.run for third-party video models). As of
  // v0.12.0, this is handled by the LongRunWorkflow class for durable
  // execution. env.AI.run blocks until the upstream provider finishes
  // (30s-3min), which exceeds the ~30s waitUntil budget after an HTTP
  // response. The workflow keeps the call alive across step boundaries
  // and retries each step independently.
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

  let instanceId: string;
  try {
    const instance = await env.LONGRUN.create({
      params: {
        rowId: row.id,
        userEmail,
        modelId: model.id,
        prompt: body.user_input,
        kind: "video",
        startedAtIso: startedAt,
      } satisfies LongRunParams,
    });
    instanceId = instance.id;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await env.DB.prepare(`UPDATE chats SET status = 'failed', job_error = ? WHERE id = ?`)
      .bind(`Workflow create failed: ${m}`.slice(0, 1000), row.id)
      .run();
    return json({ error: `Failed to start video generation: ${m}` }, { status: 502 });
  }

  // Persist the workflow instance ID on the row for traceability.
  await env.DB.prepare(`UPDATE chats SET job_id = ? WHERE id = ?`)
    .bind(instanceId, row.id)
    .run();

  return json({
    id: row.id,
    created_at: row.created_at,
    model: model.id,
    model_type: "video",
    output: "",
    output_artifact: null,
    status: "pending",
    job_started_at: startedAt,
    job_id: instanceId,
    conversation_id: row.conversation_id,
    turn_index: 0,
  });
}

// ---------- Video generation BYOK path (per-provider endpoints) ----------
//
// BYOK video architecture (v0.10.2):
//
// The OLD architecture (v0.7.0-v0.10.1) used ctx.waitUntil to run a long poll
// loop after the response was sent. That doesn't work: Cloudflare Workers only
// gives waitUntil ~30 seconds after the response, but video generation takes
// 1-3 minutes. The waitUntil task got cancelled mid-poll, leaving rows stuck
// "pending" until the client gave up.
//
// The NEW architecture:
//   1. POST /api/chat: submit synchronously (one fast HTTP call), store the
//      upstream job_id on the row, return immediately.
//   2. GET /api/job/:id: each client poll triggers one upstream poll. If done,
//      this single invocation downloads the video and stores it in R2. Each
//      invocation gets its own ~30s budget, plenty for one round-trip.
//
// This eliminates the waitUntil cancellation problem entirely for BYOK models.
// The Unified Billing path (env.AI.run) still uses waitUntil and is still
// subject to the same problem - that requires a Cloudflare Workflows refactor.

interface BYOKSubmitResult { job_id: string; }
interface BYOKPollResult {
  status: "pending" | "done" | "failed";
  video_url?: string;
  error?: string;
}


// xAI BYOK submit/poll - hits /v1/videos/* directly on api.x.ai.
//
// IMPORTANT: Cloudflare AI Gateway only proxies the OpenAI-compatible chat
// schema for xAI - it doesn't know /v1/videos/generations and returns 404
// ("not found") for that path. We call api.x.ai directly to work around it.
// This means no caching/analytics for video gen, but those benefits were
// marginal for a 1-3 minute generation anyway.

const XAI_DIRECT_BASE = "https://api.x.ai";

async function submitVideoXai(env: Env, modelName: string, prompt: string): Promise<BYOKSubmitResult> {
  if (!env.XAI_API_KEY) throw new Error("XAI_API_KEY not set; xAI video gen requires the secret to be configured");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "Authorization": `Bearer ${env.XAI_API_KEY}`,
  };

  const resp = await fetch(`${XAI_DIRECT_BASE}/v1/videos/generations`, {
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
  if (!env.XAI_API_KEY) throw new Error("XAI_API_KEY not set");
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${env.XAI_API_KEY}`,
  };

  const resp = await fetch(`${XAI_DIRECT_BASE}/v1/videos/${encodeURIComponent(jobId)}`, { headers });
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

// ---------- Job polling endpoint ----------
//
// All real work happens in the waitUntil background task. This endpoint just
// reflects the current D1 row state to the client.

async function handleJobPoll(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = getUserEmail(request);

  const row = await env.DB.prepare(
    `SELECT id, status, job_error, job_started_at, output_artifact, latency_ms,
            job_id, job_provider, model_type
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
      job_id: string | null;
      job_provider: string | null;
      model_type: string;
    }>();

  if (!row) return json({ error: "Not found" }, { status: 404 });

  // Terminal states return immediately.
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

  // Pending. For BYOK video gen (xAI with a stored job_id), this is where
  // the actual upstream poll happens - one round-trip per client poll, each
  // in its own worker invocation budget. No more waitUntil cancellation.
  if (row.status === "pending" && row.model_type === "video" && row.job_id && row.job_provider === "xai") {
    let pollResult: BYOKPollResult;
    try {
      pollResult = await pollVideoXai(env, row.job_id);
    } catch (err) {
      // Transient upstream error - keep status pending, client will try again.
      console.error("handleJobPoll: upstream poll failed:", err instanceof Error ? err.message : String(err));
      return json({ id: row.id, status: "pending" });
    }

    if (pollResult.status === "pending") {
      return json({ id: row.id, status: "pending" });
    }

    if (pollResult.status === "failed") {
      await env.DB.prepare(`UPDATE chats SET status = 'failed', job_error = ? WHERE id = ?`)
        .bind(`Upstream gen failed: ${pollResult.error ?? "unknown"}`, row.id)
        .run();
      return json({ id: row.id, status: "failed", job_error: pollResult.error ?? "unknown" });
    }

    // Done. Download video, upload to R2, finalize D1.
    if (!pollResult.video_url) {
      await env.DB.prepare(`UPDATE chats SET status = 'failed', job_error = ? WHERE id = ?`)
        .bind("Upstream reported done but no video_url", row.id)
        .run();
      return json({ id: row.id, status: "failed", job_error: "Upstream reported done but no video_url" });
    }

    // Done. Stream-pipe the upstream video directly into R2 without buffering
    // the bytes in worker memory. Combines what used to be a separate download
    // (await aresp.arrayBuffer()) and r2Put step into one streaming put.
    // Save: 5-30MB peak memory and ~1-5s on the user-visible "done" poll for
    // typical Veo/Grok video outputs.
    const mime = "video/mp4";
    let r2Key: string;
    try {
      const aresp = await fetch(pollResult.video_url);
      if (!aresp.ok) throw new Error(`Fetch ${aresp.status}`);
      if (!aresp.body) throw new Error("Upstream response has no body");
      r2Key = await r2PutStream(env, "out", mime, aresp.body, userEmail);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await env.DB.prepare(`UPDATE chats SET status = 'failed', job_error = ? WHERE id = ?`)
        .bind(`Video download/upload failed: ${m}`, row.id)
        .run();
      return json({ id: row.id, status: "failed", job_error: `Video download/upload failed: ${m}` });
    }

    const outputArtifact: OutputArtifact = { key: r2Key, mime, type: "video" };
    const latency = row.job_started_at ? (Date.now() - Date.parse(row.job_started_at)) : 0;
    await env.DB.prepare(
      `UPDATE chats SET status = 'done', output_artifact = ?, latency_ms = ? WHERE id = ?`
    )
      .bind(JSON.stringify(outputArtifact), latency, row.id)
      .run();

    return json({
      id: row.id,
      status: "done",
      output_artifact: outputArtifact,
      latency_ms: latency,
    });
  }

  // Other pending case (Unified Billing video, music gen). As of v0.12.0
  // these are owned by LongRunWorkflow instances which update D1 directly
  // when their work completes. No active polling here - just return the
  // current D1 state; the workflow will eventually flip it to done/failed.
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

  // Bedrock Converse API (Nova family): { output: { message: { content: [{ text }] } } }
  const bedrockOutput = r?.output as { message?: { content?: Array<{ text?: string }> } } | undefined;
  if (bedrockOutput?.message?.content) {
    const text = bedrockOutput.message.content
      .map((c) => c.text ?? "")
      .join("");
    if (text) return text;
  }

  // Bedrock Pegasus 1.2 (InvokeModel): { message: "...", finishReason: "..." }
  // Some versions return { generations: [{ text }] } instead - cover both.
  if (typeof r?.message === "string") return r.message as string;
  const generations = r?.generations as Array<{ text?: string }> | undefined;
  if (Array.isArray(generations) && typeof generations[0]?.text === "string") {
    return generations[0].text;
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
  // OpenAI / Anthropic / Bedrock: usage object on result.
  // OpenAI uses prompt_tokens/completion_tokens; Anthropic uses input_tokens/output_tokens;
  // Bedrock Converse uses inputTokens/outputTokens (camelCase).
  const u = r?.usage as Record<string, number> | undefined;
  if (u) {
    return {
      in_:  u.prompt_tokens ?? u.input_tokens ?? u.inputTokens ?? null,
      out_: u.completion_tokens ?? u.output_tokens ?? u.outputTokens ?? null,
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
    retrieved_context: row.retrieved_context ? safeParseJson<RetrievedItem[]>(row.retrieved_context) : null,
  });
}

function safeParseJson<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

// ---------- Multi-turn conversations ----------
//
// A conversation is a set of chat rows sharing the same conversation_id,
// ordered by turn_index. Old single-turn chats with NULL conversation_id
// were backfilled in the migration to 'legacy-<id>' so they still appear
// in the list. Non-chat rows (image/tts/etc) get 'single-<id>' assigned
// at persistChat time and show as single-turn entries.
//
// handleConversationList returns one row per distinct conversation_id with
// a summary: turn count, first prompt, latest model, last activity. Used
// by the sidebar as the replacement for the per-row history list.
//
// handleConversationGet returns all rows of a conversation in turn order.
// Used when the user clicks a conversation to view the full transcript.

async function handleConversationList(request: Request, env: Env): Promise<Response> {
  const userEmail = getUserEmail(request);

  // Group by conversation_id. For each, give:
  //   - turn_count, first/last timestamps
  //   - the first user_input as a preview
  //   - the model used in the latest turn
  //   - whether any turn has a non-null output_artifact (for the icon)
  //   - the model_type of the first turn (chat/image/tts/video/music/stt)
  const rows = await env.DB.prepare(
    `SELECT
        c.conversation_id,
        COUNT(*) AS turn_count,
        MIN(c.created_at) AS first_created_at,
        MAX(c.created_at) AS last_created_at,
        (SELECT user_input FROM chats c2
          WHERE c2.conversation_id = c.conversation_id AND c2.user_email = c.user_email
          ORDER BY c2.turn_index ASC LIMIT 1) AS first_input,
        (SELECT model FROM chats c2
          WHERE c2.conversation_id = c.conversation_id AND c2.user_email = c.user_email
          ORDER BY c2.turn_index DESC LIMIT 1) AS latest_model,
        (SELECT model_type FROM chats c2
          WHERE c2.conversation_id = c.conversation_id AND c2.user_email = c.user_email
          ORDER BY c2.turn_index ASC LIMIT 1) AS first_model_type,
        SUM(CASE WHEN output_artifact IS NOT NULL THEN 1 ELSE 0 END) AS artifact_count
      FROM chats c
      WHERE c.user_email = ?
      GROUP BY c.conversation_id
      ORDER BY last_created_at DESC
      LIMIT 200`
  )
    .bind(userEmail)
    .all<{
      conversation_id: string;
      turn_count: number;
      first_created_at: string;
      last_created_at: string;
      first_input: string;
      latest_model: string;
      first_model_type: string;
      artifact_count: number;
    }>();
  return json({ user: userEmail, conversations: rows.results ?? [] });
}

async function handleConversationGet(request: Request, env: Env, id: string): Promise<Response> {
  const userEmail = getUserEmail(request);
  const rows = await env.DB.prepare(
    `SELECT * FROM chats
      WHERE conversation_id = ? AND user_email = ?
      ORDER BY turn_index ASC, created_at ASC`
  )
    .bind(id, userEmail)
    .all<{
      attachments: string | null;
      output_artifact: string | null;
      retrieved_context: string | null;
    }>();

  if ((rows.results ?? []).length === 0) {
    return json({ error: "Not found" }, { status: 404 });
  }

  // Parse the JSON columns on each turn so the frontend doesn't have to.
  const turns = (rows.results ?? []).map((row) => ({
    ...row,
    attachments: row.attachments ? safeParseJson<PersistedAttachment[]>(row.attachments) : null,
    output_artifact: row.output_artifact ? safeParseJson<OutputArtifact>(row.output_artifact) : null,
    retrieved_context: row.retrieved_context ? safeParseJson<RetrievedItem[]>(row.retrieved_context) : null,
  }));

  return json({ conversation_id: id, turns });
}

async function handleConversationDelete(request: Request, env: Env, id: string): Promise<Response> {
  const userEmail = getUserEmail(request);

  // Pull all R2 keys across all turns before deleting D1 rows.
  const rows = await env.DB.prepare(
    `SELECT attachments, output_artifact FROM chats
      WHERE conversation_id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .all<{ attachments: string | null; output_artifact: string | null }>();

  const results = rows.results ?? [];
  if (results.length === 0) {
    return json({ error: "Not found" }, { status: 404 });
  }

  const keysToDelete: string[] = [];
  for (const row of results) {
    if (row.attachments) {
      const atts = safeParseJson<PersistedAttachment[]>(row.attachments) ?? [];
      for (const a of atts) {
        if (a.type === "image") keysToDelete.push(a.key);
        else if (a.type === "video_frames") keysToDelete.push(...(a.keys ?? []));
        else if (a.type === "video_full") keysToDelete.push(a.key);
      }
    }
    if (row.output_artifact) {
      const oa = safeParseJson<OutputArtifact>(row.output_artifact);
      if (oa?.key) keysToDelete.push(oa.key);
    }
  }

  await env.DB.prepare(
    `DELETE FROM chats WHERE conversation_id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .run();

  for (const k of keysToDelete) {
    await r2DeleteSafe(env, k);
  }

  return json({ deleted: id, turns_removed: results.length, artifacts_removed: keysToDelete.length });
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
      else if (a.type === "video_full") keysToDelete.push(a.key);
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
const DOC_MAX_BYTES = 10 * 1024 * 1024;  // 10MB upload cap

// v0.17.0: web-search retrieval limits and timeouts. Both upstreams are
// time-bounded per source so a slow Tavily doesn't block on a working
// Wikipedia (or vice versa). Counts kept small to bound context-token spend
// when the toggle is on; a typical use_web_search:true request adds roughly
// 1500-3000 tokens to the system prompt.
const TAVILY_MAX_RESULTS    = 5;
const WIKIPEDIA_MAX_RESULTS = 3;
const WEB_SEARCH_TIMEOUT_MS = 8000;

// Phase 3A: extended file type support. The arrays are kept simple - both
// mime check AND filename-extension check pass through if either matches,
// so a .pdf uploaded with no mime still works.
const ALLOWED_DOC_MIMES = [
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",  // .xlsx
  "application/vnd.ms-excel",                                            // .xls
];
const ALLOWED_DOC_EXT_RE = /\.(txt|md|markdown|pdf|xlsx|xls)$/i;

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
  page: number | null;
  sheet: string | null;
}

// Output of the per-format extractors. Each ExtractedChunk has text plus
// optional source-location metadata that gets persisted on the chunk row.
interface ExtractedChunk {
  text: string;
  page?: number;     // PDF: 1-indexed page number
  sheet?: string;    // XLSX/XLS: source sheet name
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

// ---------- RAG Phase 3A: per-format text extraction ----------
//
// For PDFs we extract per-page using unpdf (a serverless-friendly PDF.js
// wrapper) and tag each resulting chunk with its source page. Chunks never
// cross page boundaries so the source-page metadata stays meaningful.
//
// For XLSX/XLS we use SheetJS's CSV exporter per sheet and tag each chunk
// with its source sheet name. Same boundary rule: chunks never cross sheets.
//
// Scanned/image-only PDFs are not handled here; pdfjs extracts the empty
// text layer they have, which gives few or zero chunks. A future Phase 3B
// would render pages to PNG and run them through a vision model for OCR.

async function extractPdfChunks(bytes: Uint8Array): Promise<ExtractedChunk[]> {
  const pdf = await getDocumentProxy(bytes);
  const out: ExtractedChunk[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // pdfjs's text items have a .str field; join with spaces and collapse
    // runs of whitespace that come from rendering positioning.
    const raw = (content.items as Array<{ str?: string }>)
      .map((it) => (it.str ?? "").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s+\n/g, "\n")
      .trim();
    if (!raw) continue;
    for (const piece of chunkText(raw)) {
      out.push({ text: piece, page: i });
    }
  }
  return out;
}

function extractXlsxChunks(bytes: Uint8Array): ExtractedChunk[] {
  // SheetJS read accepts ArrayBuffer-ish inputs; dense=true uses a
  // 2D-array internal layout which is faster on sparse sheets.
  const wb = XLSX.read(bytes, { type: "array", dense: true });
  const out: ExtractedChunk[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false, strip: true });
    const text = csv.trim();
    if (!text) continue;
    // For a small sheet, the whole CSV may be one chunk. For a large sheet,
    // chunkText breaks on newlines (the row boundaries in CSV).
    for (const piece of chunkText(text)) {
      out.push({ text: piece, sheet: sheetName });
    }
  }
  return out;
}

// Per-mime dispatcher. Returns ExtractedChunk[] regardless of input format.
// The caller is responsible for storing the raw bytes in R2 and persisting
// each chunk row with its page/sheet metadata.
async function extractChunks(bytes: Uint8Array, mime: string, filename: string): Promise<ExtractedChunk[]> {
  const ext = (filename.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();

  // PDF
  if (mime === "application/pdf" || ext === "pdf") {
    return await extractPdfChunks(bytes);
  }

  // XLSX or XLS
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    ext === "xlsx" || ext === "xls"
  ) {
    return extractXlsxChunks(bytes);
  }

  // Text or markdown: decode and chunk. Default UTF-8 with replacement on
  // invalid bytes (rather than throwing).
  const text = new TextDecoder("utf-8").decode(bytes);
  return chunkText(text).map((t) => ({ text: t }));
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
): Promise<{ chunks: RetrievedChunk[]; error: string | null }> {
  if (!queryText || !queryText.trim()) {
    return { chunks: [], error: "Empty query text" };
  }

  // 1) Embed the query. Log + surface errors instead of silently swallowing.
  let queryVec: number[];
  try {
    const vectors = await embedBatch(env, [queryText]);
    if (vectors.length === 0) {
      const msg = "Embed returned no vectors";
      console.error("retrieveContext:", msg);
      return { chunks: [], error: msg };
    }
    queryVec = vectors[0];
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error("retrieveContext: embed failed:", m);
    return { chunks: [], error: `embed failed: ${m}` };
  }

  // 2) Query Vectorize. No metadata filter - we scope by user in D1 below.
  let matches: { id: string; score: number }[];
  try {
    const q = await env.VEC.query(queryVec, { topK });
    matches = (q?.matches ?? []).map((m) => ({ id: m.id, score: m.score }));
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error("retrieveContext: vectorize query failed:", m);
    return { chunks: [], error: `vectorize query failed: ${m}` };
  }
  if (matches.length === 0) {
    console.warn("retrieveContext: vectorize returned 0 matches for query");
    return { chunks: [], error: "vectorize returned 0 matches" };
  }

  // 3) D1 lookup: join chunks to documents, scope by user_email so we
  // never return another user's chunk even if their vector IDs would
  // somehow collide.
  const ids = matches.map((m) => m.id);
  const placeholders = ids.map(() => "?").join(",");
  let rows;
  try {
    rows = await env.DB.prepare(
      `SELECT c.document_id, c.chunk_index, c.text, c.vector_id, c.page, c.sheet, d.filename
         FROM chunks c
         JOIN documents d ON c.document_id = d.id
        WHERE c.user_email = ?
          AND c.vector_id IN (${placeholders})`
    )
      .bind(userEmail, ...ids)
      .all<{ document_id: number; chunk_index: number; text: string; vector_id: string; filename: string; page: number | null; sheet: string | null }>();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error("retrieveContext: D1 lookup failed:", m);
    return { chunks: [], error: `D1 lookup failed: ${m}` };
  }

  const results = rows.results ?? [];
  if (results.length === 0) {
    // Vectorize had matches but D1 join returned nothing - likely a user_email
    // mismatch (vectors written under one identity, query under another).
    const idSample = ids.slice(0, 3).join(", ");
    const msg = `Vectorize returned ${matches.length} matches but D1 join returned 0. user_email='${userEmail}', sample vector_ids=[${idSample}]. Check whether vectors were upserted under a different user identity.`;
    console.warn("retrieveContext:", msg);
    return { chunks: [], error: msg };
  }

  // 4) Merge scores back in, preserve Vectorize ordering.
  const byId = new Map(results.map((r) => [r.vector_id, r]));
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
      page: r.page,
      sheet: r.sheet,
    });
  }
  return { chunks: out, error: null };
}

function formatRetrievalForSystemPrompt(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  const body = chunks
    .map((c, i) => {
      const loc =
        c.page !== undefined && c.page !== null ? `, page ${c.page}` :
        c.sheet ? `, sheet "${c.sheet}"` :
        "";
      return `[Excerpt ${i + 1}, from ${c.filename}${loc} (chunk ${c.chunk_index})]\n${c.text}`;
    })
    .join("\n\n---\n\n");
  return [
    "You have access to the following excerpts from the user's uploaded documents.",
    "Use them when they are relevant to the user's query. If they don't answer the question,",
    "say so plainly rather than guessing or hallucinating.",
    "",
    body,
  ].join("\n");
}

// ---------- Web search (v0.17.0) ----------
//
// Optional retrieval source: Tavily for general web, Wikipedia for lore /
// reference. Both run in parallel; failure of one doesn't kill the other.
// Per-source timeouts (WEB_SEARCH_TIMEOUT_MS) prevent a slow upstream from
// blocking the whole turn.
//
// Tavily requires an API key (TAVILY_API_KEY). When unset, the Tavily call
// is silently skipped and only Wikipedia runs. Wikipedia needs no key.
//
// Results are persisted to the existing retrieved_context column alongside
// RAG chunks, with source_type discriminator. The frontend renders branches
// on source_type to show the source URL for web results.

async function searchWeb(
  env: Env,
  query: string
): Promise<{ results: RetrievedWebResult[]; error: string | null }> {
  const q = query.trim();
  if (!q) return { results: [], error: null };

  // Each upstream is wrapped in its own timeout + catch so a single failure
  // doesn't abort the other. Partial results are better than nothing.
  const tavilyPromise: Promise<RetrievedWebResult[]> = env.TAVILY_API_KEY
    ? searchTavily(env.TAVILY_API_KEY, q).catch(() => [])
    : Promise.resolve([]);
  const wikipediaPromise: Promise<RetrievedWebResult[]> = searchWikipedia(q).catch(() => []);

  const [tavily, wikipedia] = await Promise.all([tavilyPromise, wikipediaPromise]);
  const results = [...tavily, ...wikipedia];

  // Empty results is fine; it just means the query didn't match anything in
  // either source. Real per-source failures are swallowed by the .catch above
  // so the other source can still return its hits. If you want surfaced
  // diagnostics on partial failures, lift the per-source catches into
  // labeled results.
  return { results, error: null };
}

async function searchTavily(apiKey: string, query: string): Promise<RetrievedWebResult[]> {
  const body = {
    api_key: apiKey,
    query,
    search_depth: "basic",
    include_answer: false,           // we want raw snippets, not Tavily's pre-summary
    include_raw_content: false,      // snippets only; full pages blow up token budget
    max_results: TAVILY_MAX_RESULTS,
  };

  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`Tavily ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json() as {
    results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
  };
  const items = data.results ?? [];
  return items
    .filter((r) => r.url && r.title)
    .map((r): RetrievedWebResult => ({
      source_type: "web",
      source: "tavily",
      url: r.url!,
      title: r.title!,
      snippet: (r.content ?? "").trim(),
      score: typeof r.score === "number" ? r.score : undefined,
    }));
}

async function searchWikipedia(query: string): Promise<RetrievedWebResult[]> {
  // Wikipedia's search endpoint returns titles + HTML snippets in one call.
  // origin=* is required for CORS, but harmless server-side too. We don't
  // hit /page/summary per result (would be N+1 round-trips); the search
  // snippet is enough for most creative-work queries.
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", query);
  url.searchParams.set("srlimit", String(WIKIPEDIA_MAX_RESULTS));
  url.searchParams.set("srprop", "snippet");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");

  const resp = await fetch(url.toString(), {
    headers: {
      // Wikimedia asks for a descriptive User-Agent identifying the tool.
      // See https://meta.wikimedia.org/wiki/User-Agent_policy
      "user-agent": "skyphusion-llm-public/0.17.0 (https://github.com/SkyPhusion/skyphusion-llm-public)",
    },
    signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`Wikipedia ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json() as {
    query?: { search?: Array<{ title?: string; snippet?: string; pageid?: number }> };
  };
  const items = data.query?.search ?? [];
  return items
    .filter((r) => r.title && r.pageid !== undefined)
    .map((r): RetrievedWebResult => ({
      source_type: "web",
      source: "wikipedia",
      url: `https://en.wikipedia.org/?curid=${r.pageid}`,
      title: r.title!,
      // Snippet comes back as HTML with <span class="searchmatch">...</span>
      // around matched terms. Strip tags and decode the few entities that
      // Wikipedia commonly emits. Good enough for an LLM context block.
      snippet: stripWikipediaSnippet(r.snippet ?? ""),
    }));
}

function stripWikipediaSnippet(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatWebForSystemPrompt(results: RetrievedWebResult[]): string {
  if (results.length === 0) return "";
  const body = results
    .map((r, i) => {
      const sourceLabel = r.source === "tavily" ? "Web" : "Wikipedia";
      return `[${sourceLabel} ${i + 1}, "${r.title}" (${r.url})]\n${r.snippet}`;
    })
    .join("\n\n---\n\n");
  return [
    "You have access to the following snippets retrieved from web search.",
    "Treat these as supplementary context, not authoritative fact. Quote URLs",
    "verbatim if citing a source. If the snippets don't answer the question,",
    "say so plainly rather than fabricating.",
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
  if (!ALLOWED_DOC_MIMES.includes(mime) && !ALLOWED_DOC_EXT_RE.test(filename)) {
    return json({ error: `Unsupported file type: ${mime} (${filename}). Allowed: .txt, .md, .pdf, .xlsx, .xls` }, { status: 400 });
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

  // Extract chunks based on the file type. For .txt/.md this is just a UTF-8
  // decode + chunk. For .pdf it's per-page extraction. For .xlsx/.xls it's
  // per-sheet CSV extraction. Each ExtractedChunk carries optional page/sheet
  // location metadata that we persist on the chunk row.
  let extracted: ExtractedChunk[];
  try {
    extracted = await extractChunks(bytes, mime, filename);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `Extraction failed: ${m}` }, { status: 400 });
  }
  if (extracted.length === 0) {
    return json({
      error: "No chunks produced. The file may be empty, image-only (scanned PDFs need OCR which is not yet supported), or in an unexpected format.",
    }, { status: 400 });
  }

  const totalChars = extracted.reduce((sum, c) => sum + c.text.length, 0);

  // Store raw bytes in R2 for audit / future re-processing.
  const r2Key = await r2Put(env, "in", mime, bytes, userEmail);

  // Insert document row first so we have its ID for vector_id generation.
  const docInsert = await env.DB.prepare(
    `INSERT INTO documents
       (user_email, filename, mime, r2_key, size_bytes, total_chars, chunk_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id, created_at`
  )
    .bind(userEmail, filename, mime, r2Key, bytes.length, totalChars, extracted.length)
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
  const chunkRowsToInsert: {
    chunk_index: number;
    text: string;
    vector_id: string;
    page: number | null;
    sheet: string | null;
  }[] = [];

  try {
    for (let b = 0; b < extracted.length; b += EMBED_BATCH_SIZE) {
      const batch = extracted.slice(b, b + EMBED_BATCH_SIZE);
      const vectors = await embedBatch(env, batch.map((c) => c.text));
      if (vectors.length !== batch.length) {
        throw new Error(`Embedding batch returned ${vectors.length} vectors for ${batch.length} texts`);
      }

      const vectorizePayload = batch.map((c, i) => {
        const idx = b + i;
        const vid = `${userEmail}:${docId}:${idx}`;
        chunkRowsToInsert.push({
          chunk_index: idx,
          text: c.text,
          vector_id: vid,
          page: c.page ?? null,
          sheet: c.sheet ?? null,
        });
        vectorIdsWritten.push(vid);
        const metadata: Record<string, string | number> = {
          user_email: userEmail,
          document_id: docId,
          chunk_index: idx,
        };
        if (c.page !== undefined) metadata.page = c.page;
        if (c.sheet !== undefined) metadata.sheet = c.sheet;
        return { id: vid, values: vectors[i], metadata };
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
        `INSERT INTO chunks (document_id, user_email, chunk_index, text, vector_id, page, sheet)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(docId, userEmail, c.chunk_index, c.text, c.vector_id, c.page, c.sheet)
    );
    await env.DB.batch(stmts);
  }

  return json({
    id: docId,
    created_at: docInsert.created_at,
    filename,
    mime,
    size_bytes: bytes.length,
    total_chars: totalChars,
    chunk_count: extracted.length,
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

  // Use the last path segment of the R2 key as a download filename hint, so
  // <a download> on the client saves with the right extension (mp4/png/etc)
  // rather than defaulting to .bin or no extension.
  const filename = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;

  const headers = new Headers();
  headers.set("content-type", obj.httpMetadata?.contentType || "application/octet-stream");
  headers.set("cache-control", "private, max-age=3600");
  headers.set("content-disposition", `inline; filename="${filename}"`);
  return new Response(obj.body, { headers });
}

// ---------- Health checks ----------
//
// /health is a liveness probe: no binding access, always 200. Use for
// frequent (60s) uptime polling.
//
// /health/deep exercises each external dependency once. Each check is timed
// independently; the response body includes per-check ok/latency/error so
// a partial outage is visible even though the overall HTTP status is 503.
// Use for slower (5min) polling.
//
// Both endpoints sit behind Cloudflare Access. For Kuma to reach them you
// need either an Access service token (recommended) or a bypass policy on
// /health* in the Access app config.

interface HealthCheckResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

async function handleHealthDeep(env: Env): Promise<Response> {
  const checks: Record<string, HealthCheckResult> = {};

  // D1: SELECT 1 round-trip. Verifies the binding works and the database
  // is reachable. Doesn't touch any user data.
  {
    const t0 = Date.now();
    try {
      await env.DB.prepare(`SELECT 1 AS ok`).first();
      checks.d1 = { ok: true, latency_ms: Date.now() - t0 };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      checks.d1 = { ok: false, latency_ms: Date.now() - t0, error: m };
    }
  }

  // R2: HEAD on a key that doesn't exist. Returns null on a working binding
  // (no error). Validates auth and bucket reachability without creating or
  // reading user data.
  {
    const t0 = Date.now();
    try {
      await env.R2.head("__healthcheck_nonexistent_key__");
      checks.r2 = { ok: true, latency_ms: Date.now() - t0 };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      checks.r2 = { ok: false, latency_ms: Date.now() - t0, error: m };
    }
  }

  // Vectorize: describe() returns index metadata. Cheap, no vector ops.
  {
    const t0 = Date.now();
    try {
      await env.VEC.describe();
      checks.vectorize = { ok: true, latency_ms: Date.now() - t0 };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      checks.vectorize = { ok: false, latency_ms: Date.now() - t0, error: m };
    }
  }

  // AI binding: just confirm GATEWAY_ID is set. We deliberately do NOT run
  // an actual model here; even the cheapest model call burns neurons and a
  // per-minute health probe would add up. If the secret is missing, every
  // real chat request will fail anyway, so this is sufficient.
  {
    const t0 = Date.now();
    if (env.GATEWAY_ID && typeof env.GATEWAY_ID === "string" && env.GATEWAY_ID.length > 0) {
      checks.ai_config = { ok: true, latency_ms: Date.now() - t0 };
    } else {
      checks.ai_config = { ok: false, latency_ms: Date.now() - t0, error: "GATEWAY_ID not set" };
    }
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  return json(
    { ok: allOk, ts: Date.now(), checks },
    { status: allOk ? 200 : 503 }
  );
}

// ---------- LongRunWorkflow (v0.12.0) ----------
//
// Cloudflare Workflow that handles Unified Billing video and music generation.
// Both surfaces (runVideo Unified path, runMusic) hand off to this class via
// env.LONGRUN.create({ params }). The workflow is responsible for:
//   1. Invoking env.AI.run (blocking call, 30s-3min)
//   2. Downloading the resulting artifact from CF's catalog R2 bucket
//   3. Uploading the bytes to our own R2 bucket
//   4. Finalizing the D1 row (status, output_artifact, latency)
//
// Why Workflows rather than ctx.waitUntil:
//   - waitUntil has a ~30s budget after the HTTP response is sent. env.AI.run
//     for Veo/Seedance/Hailuo etc. takes 1-3 minutes, so the task gets
//     cancelled mid-call. That cancellation was the failure mode in v0.11.x.
//   - Workflows have unlimited wall-clock time per step (CPU time still
//     capped, but env.AI.run is I/O-bound).
//   - Each step retries independently with built-in backoff, so a transient
//     R2 upload failure doesn't force re-running the (expensive) gen call.
//
// Step 2 (download + R2 upload) is one combined step because step.do return
// values are capped at 1 MiB; video files are 5-15MB, music 3-5MB - we can't
// pass bytes between steps. So we fold the download and R2 put into a single
// step and return just the small R2 key. The trade-off: if R2 upload fails
// after a successful download, the retry re-downloads the same source URL
// (CF's catalog R2 - cheap and reliable). Acceptable.
//
// Response shapes per https://developers.cloudflare.com/ai/models/:
//   Veo:     { state:"Completed", result:{ video:"..." }, gatewayMetadata }
//   MiniMax: { audio:"..." } (flat) - some normalized providers may wrap in
//            { state, result:{ audio }, gatewayMetadata } so we accept both.
//   Other UB video providers (bytedance/runway/alibaba/pixverse/vidu) are
//   expected to follow the Veo-style wrapper but have NOT been runtime-
//   verified as of v0.12.0. Per-provider param shapes may also differ from
//   the Veo baseline (prompt/duration/aspect_ratio/resolution/generate_audio);
//   errors surface in job_error for iteration.

type LongRunKind = "video" | "music";

interface LongRunParams extends Record<string, unknown> {
  rowId: number;
  userEmail: string;
  modelId: string;
  prompt: string;
  lyrics?: string;          // music only
  kind: LongRunKind;
  startedAtIso: string;
}

// Shape we expect back from env.AI.run for video and music. Both share the
// same envelope; only the inner field differs (video vs audio).
interface LongRunResult {
  state?: string;
  result?: { video?: string; audio?: string };
  audio?: string;          // flat shape for minimax/music-2.6
  gatewayMetadata?: { keySource?: string };
}

export class LongRunWorkflow extends WorkflowEntrypoint<Env, LongRunParams> {
  async run(event: WorkflowEvent<LongRunParams>, step: WorkflowStep): Promise<void> {
    const { rowId, userEmail, modelId, prompt, lyrics, kind, startedAtIso } = event.payload;

    // Best-effort row-fail helper. Used in the outer catch to surface
    // workflow-level failures to the polling client. Failures inside this
    // helper are intentionally swallowed - if D1 is down, there's nothing
    // we can do from a background workflow anyway.
    const failRow = async (msg: string): Promise<void> => {
      try {
        await this.env.DB.prepare(`UPDATE chats SET status = 'failed', job_error = ? WHERE id = ?`)
          .bind(msg.slice(0, 1000), rowId)
          .run();
      } catch { /* swallow */ }
    };

    try {
      // Step 1: invoke the model. Long-running blocking call.
      //
      // Retry policy: ONE retry only. Each attempt costs Unified Billing
      // credits; if it fails twice with a 30s spacing, the third attempt is
      // unlikely to help and we'd rather surface the error to the user.
      const artifactUrl = await step.do(
        "invoke-model",
        { retries: { limit: 1, delay: "30 seconds", backoff: "linear" } },
        async (): Promise<string> => {
          const params: Record<string, unknown> = kind === "video"
            ? {
                prompt,
                duration: "8s",
                aspect_ratio: "16:9",
                resolution: "720p",
                generate_audio: true,
              }
            : { prompt };
          if (kind === "music" && lyrics && lyrics.trim()) {
            params.lyrics = lyrics;
          }

          const result = await aiRun(this.env, modelId, params) as LongRunResult;

          if (result.state && result.state !== "Completed") {
            throw new Error(`Unexpected gen state: ${result.state}`);
          }
          const url = kind === "video"
            ? result.result?.video
            : (result.audio ?? result.result?.audio);
          if (!url) {
            throw new Error(`Gen completed but no ${kind} URL. Raw: ${JSON.stringify(result).slice(0, 500)}`);
          }
          return url;
        }
      );

      // Step 2: download artifact and upload to R2 (combined; can't pass
      // bytes between steps due to the 1 MiB step return cap).
      const { r2Key, mime } = await step.do(
        "download-and-store",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async (): Promise<{ r2Key: string; mime: string }> => {
          const aresp = await fetch(artifactUrl);
          if (!aresp.ok) throw new Error(`Fetch ${aresp.status} from ${artifactUrl.slice(0, 100)}`);
          // For video, force video/mp4. CF's catalog R2 and many CDNs serve
          // MP4 as application/octet-stream, which would cause R2 keys to
          // end in .bin (matches the BYOK video fix in v0.10.3).
          const upstreamMime = aresp.headers.get("content-type") || "";
          const finalMime = kind === "video"
            ? "video/mp4"
            : (upstreamMime || "audio/mpeg");
          const bytes = new Uint8Array(await aresp.arrayBuffer());
          const key = await r2Put(this.env, "out", finalMime, bytes, userEmail);
          return { r2Key: key, mime: finalMime };
        }
      );

      // Step 3: finalize the D1 row.
      await step.do(
        "finalize-d1",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async (): Promise<void> => {
          const outputArtifact: OutputArtifact = {
            key: r2Key,
            mime,
            type: kind === "video" ? "video" : "audio",
          };
          const latency = Date.now() - Date.parse(startedAtIso);
          await this.env.DB.prepare(
            `UPDATE chats SET status = 'done', output_artifact = ?, latency_ms = ? WHERE id = ?`
          )
            .bind(JSON.stringify(outputArtifact), latency, rowId)
            .run();
        }
      );
    } catch (err) {
      // A step exhausted its retries (or some non-step code threw). Mark the
      // D1 row failed so the polling client gets a clear error, then re-throw
      // so the workflow instance itself is reported as errored in the
      // dashboard (preserves observability).
      const m = err instanceof Error ? err.message : String(err);
      await failRow(m);
      throw err;
    }
  }
}
