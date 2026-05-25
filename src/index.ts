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
  GOOGLE_API_KEY?: string;    // optional; preferred is to store in AI Gateway dashboard
  OPENAI_API_KEY?: string;    // v0.11.0: optional; for OpenAI BYOK chat
  // v0.11.0: AWS credentials for Bedrock BYOK. Scope IAM key to Bedrock invoke only.
  // AWS_REGION defaults to us-east-1 for Nova; Pegasus 1.2 requires us-west-2 or eu-west-1.
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;
  AWS_REGION_PEGASUS?: string; // optional override for Pegasus calls
  CF_AIG_TOKEN?: string;      // only needed if gateway has Authenticated Gateway enabled
}

// ---------- Model catalog ----------

type ModelType = "chat" | "image" | "tts" | "video" | "stt" | "music";
type Provider =
  | "workers-ai"
  | "anthropic"
  | "xai"
  | "google"
  | "openai"
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
  // (Gemini AI Studio for google/*, xAI direct for xai/*) instead of the
  // env.AI.run binding. The value is the model name expected by the direct
  // provider API (e.g. "veo-3.1-fast-generate-001" for Gemini AI Studio).
  // Without this, video gen requires Unified Billing on the AI Gateway.
  byok_alias?: string;
}

const MODELS: ModelEntry[] = [
  // ---- Chat (text generation) ----
  // Anthropic (BYOK via x-api-key or stored keys, routed through AI Gateway)
  { id: "anthropic/claude-opus-4-7",                    label: "Claude Opus 4.7 (Anthropic, BYOK)",          group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic" },
  { id: "anthropic/claude-opus-4-6",                    label: "Claude Opus 4.6 (Anthropic, BYOK)",          group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic" },
  { id: "anthropic/claude-sonnet-4-6",                  label: "Claude Sonnet 4.6 (Anthropic, BYOK)",        group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic" },
  { id: "anthropic/claude-haiku-4-5",                   label: "Claude Haiku 4.5 (Anthropic, BYOK)",         group: "Chat \u00b7 Anthropic", type: "chat", capabilities: ["vision"], provider: "anthropic" },

  // OpenAI (v0.11.0, BYOK via OPENAI_API_KEY secret routed through AI Gateway's OpenAI proxy)
  { id: "openai/gpt-5.5",                                label: "GPT-5.5 (OpenAI, BYOK)",                     group: "Chat \u00b7 OpenAI", type: "chat", capabilities: ["vision"], provider: "openai", byok_alias: "gpt-5.5" },
  { id: "openai/gpt-5.4",                                label: "GPT-5.4 (OpenAI, BYOK)",                     group: "Chat \u00b7 OpenAI", type: "chat", capabilities: ["vision"], provider: "openai", byok_alias: "gpt-5.4" },
  { id: "openai/gpt-5.4-mini",                           label: "GPT-5.4 mini (OpenAI, BYOK)",                group: "Chat \u00b7 OpenAI", type: "chat", capabilities: ["vision"], provider: "openai", byok_alias: "gpt-5.4-mini" },

  // Amazon Bedrock Nova family (v0.11.0, BYOK via AWS SigV4, direct to bedrock-runtime)
  // All four go through Bedrock's Converse API (unified across model families).
  { id: "bedrock/amazon.nova-2-lite-v1:0",               label: "Amazon Nova 2 Lite (Bedrock, BYOK)",         group: "Chat \u00b7 Bedrock", type: "chat", capabilities: ["vision"], provider: "bedrock", byok_alias: "amazon.nova-2-lite-v1:0" },
  { id: "bedrock/amazon.nova-2-pro-v1:0",                label: "Amazon Nova 2 Pro (Bedrock, BYOK)",          group: "Chat \u00b7 Bedrock", type: "chat", capabilities: ["vision"], provider: "bedrock", byok_alias: "amazon.nova-2-pro-v1:0" },
  { id: "bedrock/amazon.nova-lite-v1:0",                 label: "Amazon Nova Lite (Bedrock, BYOK)",           group: "Chat \u00b7 Bedrock", type: "chat", capabilities: ["vision"], provider: "bedrock", byok_alias: "amazon.nova-lite-v1:0" },
  { id: "bedrock/amazon.nova-pro-v1:0",                  label: "Amazon Nova Pro (Bedrock, BYOK)",            group: "Chat \u00b7 Bedrock", type: "chat", capabilities: ["vision"], provider: "bedrock", byok_alias: "amazon.nova-pro-v1:0" },

  // TwelveLabs Pegasus 1.2 on Bedrock (v0.11.0, video-Q&A via InvokeModel, not Converse).
  // Requires a video attachment. Region must be us-west-2 or eu-west-1.
  // Configurable via AWS_REGION_PEGASUS; otherwise falls back to AWS_REGION.
  { id: "bedrock/twelvelabs.pegasus-1-2-v1:0",           label: "Pegasus 1.2 (TwelveLabs/Bedrock, BYOK)",     group: "Chat \u00b7 Bedrock", type: "chat", capabilities: [], provider: "bedrock", byok_alias: "twelvelabs.pegasus-1-2-v1:0" },

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
  { id: "openai/gpt-image-2-2026-04-21",                label: "GPT Image 2 (OpenAI, BYOK)",   group: "Image Gen",            type: "image", capabilities: [], provider: "openai", byok_alias: "gpt-image-2-2026-04-21" },

  // ---- Text-to-speech ----
  { id: "@cf/deepgram/aura-2-en",                       label: "Aura-2 English (Deepgram)",    group: "TTS",                  type: "tts",   capabilities: [] },
  { id: "@cf/deepgram/aura-2-es",                       label: "Aura-2 Spanish (Deepgram)",    group: "TTS",                  type: "tts",   capabilities: [] },
  { id: "@cf/myshell/melotts",                          label: "MeloTTS (multilingual)",       group: "TTS",                  type: "tts",   capabilities: [] },
  { id: "openai/gpt-4o-mini-tts-2025-12-15",            label: "GPT-4o mini TTS (OpenAI, BYOK)", group: "TTS",                type: "tts",   capabilities: [], provider: "openai", byok_alias: "gpt-4o-mini-tts-2025-12-15" },

  // ---- Speech-to-text (Whisper) ----
  // Attach an audio file, pick a model, get the transcript. Audio file is
  // required; everything else (prompt, system prompt) is ignored.
  { id: "@cf/openai/whisper-large-v3-turbo",            label: "Whisper Large v3 Turbo (best)", group: "Speech-to-text",      type: "stt",   capabilities: [] },
  { id: "@cf/openai/whisper",                           label: "Whisper (general purpose)",    group: "Speech-to-text",       type: "stt",   capabilities: [] },
  { id: "@cf/openai/whisper-tiny-en",                   label: "Whisper Tiny EN (fast, beta)", group: "Speech-to-text",       type: "stt",   capabilities: [] },
  { id: "openai/gpt-4o-transcribe",                     label: "GPT-4o Transcribe (OpenAI, BYOK)", group: "Speech-to-text",   type: "stt",   capabilities: [], provider: "openai", byok_alias: "gpt-4o-transcribe" },
  { id: "openai/gpt-4o-mini-transcribe-2025-12-15",     label: "GPT-4o mini Transcribe (OpenAI, BYOK)", group: "Speech-to-text", type: "stt", capabilities: [], provider: "openai", byok_alias: "gpt-4o-mini-transcribe-2025-12-15" },

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
  type: "image" | "audio" | "video_frames" | "video_full";
  filename?: string;
  mime?: string;
  data?: string;       // data URL (image / audio / video_full)
  frames?: string[];   // data URLs (video_frames)
  duration?: number;
}

interface ChatRequest {
  model: string;
  system_prompt?: string;
  user_input: string;
  attachments?: InputAttachment[];
  use_docs?: boolean;   // Pass 2: when true, retrieve top-K chunks from Vectorize and inject as context
  conversation_id?: string;  // Multi-turn: when present, continue an existing conversation
}

interface RetrievedChunk {
  document_id: number;
  filename: string;
  chunk_index: number;
  text: string;
  score: number;
  page?: number | null;     // PDFs only
  sheet?: string | null;    // XLSX/XLS only
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
  let conversationId = body.conversation_id?.trim() || "";
  let turnIndex = 0;
  const priorTurns: Array<{ user_input: string; output: string }> = [];

  if (conversationId) {
    const prior = await env.DB.prepare(
      `SELECT user_input, output, turn_index
         FROM chats
        WHERE conversation_id = ?
          AND user_email = ?
          AND status = 'done'
          AND model_type = 'chat'
        ORDER BY turn_index ASC`
    )
      .bind(conversationId, userEmail)
      .all<{ user_input: string; output: string; turn_index: number }>();
    const rows = prior.results ?? [];
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

  // RAG retrieval (Pass 2) - per-turn, applies only to THIS turn's system prompt
  let retrievedChunks: RetrievedChunk[] = [];
  let retrievalError: string | null = null;
  if (body.use_docs) {
    const r = await retrieveContext(env, userEmail, body.user_input);
    retrievedChunks = r.chunks;
    retrievalError = r.error;
  }

  // Build the effective system prompt: user-supplied prompt followed by
  // the retrieval block. If only one is present, use that one alone.
  const userSystemPrompt = body.system_prompt?.trim() ?? "";
  const retrievalBlock = retrievedChunks.length ? formatRetrievalForSystemPrompt(retrievedChunks) : "";
  const effectiveSystemPrompt =
    userSystemPrompt && retrievalBlock ? `${userSystemPrompt}\n\n${retrievalBlock}` :
    retrievalBlock || userSystemPrompt || "";

  // Build the message array. For providers that take system as a separate
  // top-level param (Anthropic system, Google systemInstruction), we DON'T
  // include the system role here - we pass effectiveSystemPrompt as the
  // param instead. For providers that take messages-only (xAI, Workers AI),
  // we DO include the system role.
  //
  // Prior turns of this conversation go in as alternating user/assistant
  // text messages. Multimodal content (images) from prior turns is NOT
  // re-included; if the user wants to reference earlier images they can
  // re-attach. Current turn's attachments are still threaded into userContent.
  // OpenAI and Bedrock accept system in messages (OpenAI: as role:"system";
  // Bedrock Converse: as a separate `system` array param but converted from
  // messages by callBedrockNova). Anthropic and Google take system separately.
  const wantsSystemInMessages = !(model.provider === "anthropic" || model.provider === "google");
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
    } else if (model.provider === "google") {
      const r = await callGoogle(env, model, effectiveSystemPrompt || undefined, messages);
      result = r.raw;
      logId = r.logId;
    } else if (model.provider === "openai") {
      const r = await callOpenAI(env, model, messages);
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
    retrieved_context: retrievedChunks.length ? retrievedChunks : null,
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
    conversation_id: conversationId,
    turn_index: turnIndex,
    // Diagnostic: when use_docs was on, include the exact text that went into
    // the model as the system prompt, plus any retrieval error. Inspect via
    // browser DevTools to verify the retrieval block reached the model.
    effective_system_prompt: body.use_docs ? effectiveSystemPrompt : undefined,
    retrieval_error: body.use_docs ? retrievalError : undefined,
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
    if (model.provider === "openai") {
      const r = await imageGenOpenAI(env, model, body.user_input);
      bytes = r.bytes; mime = r.mime;
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
      const result = await aiRun(env, model.id, params);
      logId = aiLogId(env);
      // Response shape is { image: base64 } for FLUX-1 / Lucid / Phoenix.
      const b64 = (result as { image?: string })?.image;
      if (!b64 || typeof b64 !== "string") {
        return json({ error: "Image generation returned no image", raw: result }, { status: 502 });
      }
      bytes = base64ToBytes(b64);
      mime = "image/jpeg";
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

// OpenAI image gen via /v1/images/generations.
// Body: { model, prompt, n, size, response_format: "b64_json" }
// Response: { data: [{ b64_json: "..." }] }
async function imageGenOpenAI(env: Env, model: ModelEntry, prompt: string): Promise<{ bytes: Uint8Array; mime: string }> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }
  const baseUrl = await (env.AI as unknown as {
    gateway: (id: string) => { getUrl: (provider: string) => Promise<string> };
  }).gateway(env.GATEWAY_ID).getUrl("openai");

  const modelName = model.byok_alias ?? model.id.replace(/^openai\//, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
  };
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  const resp = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelName,
      prompt,
      n: 1,
      size: "1024x1024",
      response_format: "b64_json",
    }),
  });
  if (!resp.ok) {
    throw new Error(`OpenAI image ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  const data = await resp.json() as { data?: Array<{ b64_json?: string }> };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image: no b64_json in response");
  return { bytes: base64ToBytes(b64), mime: "image/png" };
}

// ---------- TTS ----------

async function runTts(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = getUserEmail(request);

  let mime: string;
  let bytes: Uint8Array;
  let logId: string | null = null;

  const start = Date.now();
  try {
    if (model.provider === "openai") {
      const r = await ttsOpenAI(env, model, body.user_input);
      mime = r.mime;
      bytes = r.bytes;
    } else {
      // Aura: { text }; MeloTTS: { prompt, lang? }. Send both keys defensively.
      const params: Record<string, unknown> = { text: body.user_input, prompt: body.user_input };
      const resp = await aiRun(env, model.id, params, true /* returnRawResponse */);
      logId = aiLogId(env);
      if (!(resp instanceof Response)) {
        return json({ error: "TTS returned non-Response shape", raw: resp }, { status: 502 });
      }
      mime = resp.headers.get("content-type") || "audio/mpeg";
      bytes = new Uint8Array(await resp.arrayBuffer());
    }
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

// OpenAI TTS via /v1/audio/speech.
// Body: { model, input, voice, response_format }
// Response: raw audio bytes (not JSON). Default voice is "alloy".
async function ttsOpenAI(env: Env, model: ModelEntry, input: string): Promise<{ bytes: Uint8Array; mime: string }> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }
  const baseUrl = await (env.AI as unknown as {
    gateway: (id: string) => { getUrl: (provider: string) => Promise<string> };
  }).gateway(env.GATEWAY_ID).getUrl("openai");

  const modelName = model.byok_alias ?? model.id.replace(/^openai\//, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
  };
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  const resp = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelName,
      input,
      voice: "alloy",
      response_format: "mp3",
    }),
  });
  if (!resp.ok) {
    throw new Error(`OpenAI TTS ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  return {
    bytes: new Uint8Array(await resp.arrayBuffer()),
    mime: resp.headers.get("content-type") || "audio/mpeg",
  };
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
    if (model.provider === "openai") {
      transcript = await sttOpenAI(env, model, parsed.base64, parsed.mime, audioAtt.filename);
    } else {
      const wr = await aiRun(env, model.id, { audio: parsed.base64 });
      transcript = (wr as { text?: string })?.text?.trim() ?? "";
    }
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

// OpenAI transcription via /v1/audio/transcriptions.
// Body: multipart/form-data with `file` (audio binary), `model`, `response_format`.
// Response: { text: "transcript" } when response_format is "json".
async function sttOpenAI(env: Env, model: ModelEntry, audioBase64: string, mime: string, filename?: string): Promise<string> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }
  const baseUrl = await (env.AI as unknown as {
    gateway: (id: string) => { getUrl: (provider: string) => Promise<string> };
  }).gateway(env.GATEWAY_ID).getUrl("openai");

  const modelName = model.byok_alias ?? model.id.replace(/^openai\//, "");

  // OpenAI's /audio/transcriptions endpoint expects multipart/form-data with
  // the audio bytes as the `file` part. Workers have native FormData + Blob
  // so we don't need a polyfill.
  const audioBytes = base64ToBytes(audioBase64);
  const fname = filename || (mime.includes("wav") ? "audio.wav" : mime.includes("mp3") || mime.includes("mpeg") ? "audio.mp3" : "audio.m4a");
  const blob = new Blob([audioBytes], { type: mime });

  const form = new FormData();
  form.append("file", blob, fname);
  form.append("model", modelName);
  form.append("response_format", "json");

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
  };
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  const resp = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers,
    body: form,
  });
  if (!resp.ok) {
    throw new Error(`OpenAI STT ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  const data = await resp.json() as { text?: string };
  return data.text?.trim() ?? "";
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
  retrieved_context?: RetrievedChunk[] | null;
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

// ---------- OpenAI chat (BYOK, v0.11.0) ----------
//
// OpenAI uses the standard `messages` array with role: "system" | "user" | "assistant",
// which matches our internal format directly. No transform needed beyond stripping
// our internal message shapes if they contain attachments (we currently only support
// text via OpenAI - for vision attachments through OpenAI add image_url content
// parts later if needed).
//
// Routed through Cloudflare AI Gateway's OpenAI proxy. Authentication via the
// OPENAI_API_KEY secret. The gateway preserves the OpenAI API schema 1:1 so
// the request and response shapes are identical to the official API.

async function callOpenAI(
  env: Env,
  model: ModelEntry,
  messages: Array<unknown>
): Promise<{ raw: unknown; logId: string | null }> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set; OpenAI BYOK requires the secret to be configured (npx wrangler secret put OPENAI_API_KEY)");
  }

  const baseUrl = await (env.AI as unknown as {
    gateway: (id: string) => { getUrl: (provider: string) => Promise<string> };
  }).gateway(env.GATEWAY_ID).getUrl("openai");

  const modelName = model.byok_alias ?? model.id.replace(/^openai\//, "");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
  };
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelName,
      messages,
      max_tokens: 4096,
    }),
  });

  const logId = resp.headers.get("cf-aig-log-id");
  if (!resp.ok) {
    throw new Error(`OpenAI ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  const raw = await resp.json();
  return { raw, logId };
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

async function callBedrockNova(
  env: Env,
  model: ModelEntry,
  systemPrompt: string | undefined,
  messages: Array<unknown>
): Promise<{ raw: unknown; logId: string | null }> {
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
  // use other providers. Static type-only import avoided to keep things simple.
  const { AwsClient } = await import("aws4fetch");
  const awsClient = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region,
    service: "bedrock",
  });

  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelName)}/converse`;

  const resp = await awsClient.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Bedrock Nova ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  const raw = await resp.json();
  // logId: Bedrock doesn't return a Cloudflare-style log id. Pass null.
  return { raw, logId: null };
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
  const videoAtt = attachments.find((a) => a.type === "video_full");
  if (!videoAtt) {
    throw new Error("Pegasus 1.2 requires a video attachment. Attach an .mp4 (or similar) file before sending the prompt.");
  }

  // Decode the data URL to raw bytes, then re-encode as base64 (no data: prefix).
  // InputAttachment.data is a "data:video/mp4;base64,AAAA..." string.
  const dataUrl = videoAtt.data ?? "";
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
  const isBYOK = !!(model.byok_alias && (model.provider === "xai" || model.provider === "google"));

  // BYOK path: do the submit synchronously (one fast HTTP call, well within
  // the worker's request budget). Save the upstream job_id on the row so the
  // poll endpoint can check status without re-submitting. This avoids using
  // ctx.waitUntil for the long-running poll loop - waitUntil only gets ~30s
  // after the response, which is far less than the 1-3 minutes needed.
  if (isBYOK) {
    let submit: BYOKSubmitResult;
    try {
      if (model.provider === "xai") {
        submit = await submitVideoXai(env, model.byok_alias!, body.user_input);
      } else {
        submit = await submitVideoGoogle(env, model.byok_alias!, body.user_input);
      }
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

  // Pending. For BYOK video gen (xAI/Google with a stored job_id), this is
  // where the actual upstream poll happens - one round-trip per client poll,
  // each in its own worker invocation budget. No more waitUntil cancellation.
  if (row.status === "pending" && row.model_type === "video" && row.job_id && (row.job_provider === "xai" || row.job_provider === "google")) {
    let pollResult: BYOKPollResult;
    try {
      if (row.job_provider === "xai") {
        pollResult = await pollVideoXai(env, row.job_id);
      } else {
        pollResult = await pollVideoGoogle(env, row.job_id);
      }
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

    let bytes: Uint8Array;
    // We know this is a video gen result, so force the mime to video/mp4
    // regardless of what the upstream CDN reports. Many CDNs serve MP4 as
    // application/octet-stream, which would cause the R2 key to end in .bin
    // and downloads to save as <uuid>.bin instead of <uuid>.mp4.
    const mime = "video/mp4";
    try {
      const aresp = await fetch(pollResult.video_url);
      if (!aresp.ok) throw new Error(`Fetch ${aresp.status}`);
      bytes = new Uint8Array(await aresp.arrayBuffer());
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await env.DB.prepare(`UPDATE chats SET status = 'failed', job_error = ? WHERE id = ?`)
        .bind(`Video download failed: ${m}`, row.id)
        .run();
      return json({ id: row.id, status: "failed", job_error: `Video download failed: ${m}` });
    }

    let r2Key: string;
    try {
      r2Key = await r2Put(env, "out", mime, bytes, userEmail);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await env.DB.prepare(`UPDATE chats SET status = 'failed', job_error = ? WHERE id = ?`)
        .bind(`R2 upload failed: ${m}`, row.id)
        .run();
      return json({ id: row.id, status: "failed", job_error: `R2 upload failed: ${m}` });
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

  // Google Gemini: candidates[0].content.parts[].text
  const candidates = r?.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
  if (Array.isArray(candidates) && Array.isArray(candidates[0]?.content?.parts)) {
    const text = candidates[0].content.parts
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
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
    retrieved_context: row.retrieved_context ? safeParseJson<RetrievedChunk[]>(row.retrieved_context) : null,
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
