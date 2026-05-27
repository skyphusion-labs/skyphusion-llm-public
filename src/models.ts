// Model catalog (v0.18.4).
//
// Extracted from src/index.ts for navigability. This file is the single
// authoritative list of models the worker exposes; adding or removing
// entries here flows automatically to GET /api/models and the frontend
// model picker.
//
// Each entry's `id` is the routing key. The worker's dispatch logic uses
// the `provider` field (defaulting to "workers-ai") plus the `byok_alias`
// when present to pick a code path. The `type` field controls which
// dispatcher runs (chat / image / tts / video / stt / music). The
// `capabilities` array is mostly UI-driven (vision toggles the attach
// affordance for vision-capable chat models). The `streaming` flag opts
// chat models in to POST /api/chat/stream.
//
// Catalog conventions for adding a new model:
//   - Use the upstream's canonical ID for the prefix
//     (anthropic/, xai/, bedrock/, @cf/<vendor>/, etc.)
//   - Include "BYOK" or "needs CF credits" in the label so the picker
//     makes the billing model obvious to the user
//   - Set streaming: true if the model can stream and your provider's
//     stream parser handles it (Anthropic, xAI, Bedrock Nova, Workers AI
//     are all covered as of v0.16.0)
//   - For Bedrock chat: set byok_alias to the exact upstream model ID
//   - For BYOK video: set byok_alias to the provider's model name and
//     leave provider set to the provider's slug

export type ModelType = "chat" | "image" | "tts" | "video" | "stt" | "music";
export type Provider =
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

export interface ModelEntry {
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

export const MODELS: ModelEntry[] = [
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
