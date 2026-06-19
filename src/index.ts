// skyphusion-llm-public worker. Routes:
//   GET    /health                 liveness probe (no binding access, always 200)
//   GET    /health/deep            deep check: D1, R2, Vectorize, AI gateway config
//   GET    /api/models             list models with type + capabilities, return user email
//   GET    /api/prefs              per-user AI Gateway settings (slug + token status)
//   PATCH  /api/prefs              update per-user AI Gateway settings
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
export { SttSession } from "./stt-session";
import type { ProviderStreamEvent } from "./parsers/types";
import type { ModelType, Provider, ModelEntry } from "./models";
import { MODELS } from "./models";
import type { Env } from "./env";
import { parseDataUrl, base64ToBytes, bytesToBase64, extFromMime } from "./utils";
import { aiRun, aiLogId, type AiContext } from "./ai-binding";
import {
  loadGatewayCredentials,
  loadGatewayStatus,
  GATEWAY_NOT_CONFIGURED_MSG,
  CF_AIG_TOKEN_REQUIRED_MSG,
  maskSecret,
} from "./gateway-credentials";
import { loadUserPrefs, saveUserPrefs } from "./user-prefs";
import { extractOutput, extractUsage, detectProviderFailure, extractProxiedImageUrl } from "./output-extract";
import { chunkText } from "./chunking";
import { isZip, unzip } from "./zip";
import { parseDiscordExport, chunkDiscordMessages } from "./discord";
import { callAnthropic, callAnthropicStream } from "./providers/anthropic";
import { callXai, callXaiStream } from "./providers/xai";
import { callWorkersAIStream } from "./providers/workers-ai";
import { callOpenAIStream } from "./providers/openai";
import { callGemini, callGeminiStream } from "./providers/google";
import { buildGenParams } from "./longrun-params";
import { buildProxiedImageParams } from "./proxied-image-params";
import { searchBraveWeb } from "./brave-search";
import { generateOpenAIImage } from "./providers/openai-image";
import type {
  InputImageAttachment,
  InputAudioAttachment,
  InputVideoFramesAttachment,
  InputVideoFullAttachment,
  InputAttachment,
} from "./types";

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


const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

// v0.24.0: cap on inline text-file (document) attachments folded into a chat
// prompt. Large files past this are truncated with a marker so a single
// attachment can't blow the model's context window.
const MAX_DOC_ATTACHMENT_CHARS = 200_000;

// v0.24.0: shared handling for an inline document (text-file) attachment on a
// chat turn. The contents are folded into the prompt as a fenced block, the
// same mechanism as audio transcription. Binary input is rejected via the
// same looksBinary heuristic the RAG uploader uses. Returns either an error
// string for the 400 path or the prompt block + persisted metadata record.
function buildDocumentAttachment(att: { text?: string; mime?: string; filename?: string }):
  | { error: string }
  | { extra: string; persisted: PersistedDocumentAttachment } {
  const raw = att.text ?? "";
  if (looksBinary(raw)) {
    return { error: `${att.filename || "Attached file"} looks like binary data that can't be read as text. Attach a text-based file (txt, md, yaml, json, csv, source code, etc.).` };
  }
  const truncated = raw.length > MAX_DOC_ATTACHMENT_CHARS;
  const text = truncated ? raw.slice(0, MAX_DOC_ATTACHMENT_CHARS) : raw;
  const fn = att.filename ? ` ${att.filename}` : "";
  const extra = `[Attached file${fn}]\n\`\`\`\n${text}\n\`\`\`${truncated ? "\n[file truncated to fit context]" : ""}`;
  return { extra, persisted: { type: "document", mime: att.mime, filename: att.filename, chars: text.length } };
}

// ---------- Types ----------

interface ChatRequest {
  model: string;
  system_prompt?: string;
  user_input: string;
  attachments?: InputAttachment[];
  image_url?: string;   // v0.21.5: source image for image-to-video models (hh1-i2v); a fetchable URL
  image_key?: string;   // v0.21.6: source image as an R2 key (e.g. a prior nano-banana output) for image-to-video chaining
  use_docs?: boolean;   // Pass 2: when true, retrieve top-K chunks from Vectorize and inject as context
  use_web_search?: boolean;  // v0.17.0: when true, query Tavily + Brave + Wikipedia and inject snippets as context
  conversation_id?: string;  // Multi-turn: when present, continue an existing conversation
  project_id?: number;  // v0.20.0: when present, scope RAG retrieval to the project's docs
                        // and apply the project's system_prompt as default if system_prompt is empty
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
  source: "tavily" | "brave" | "wikipedia";
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
// v0.24.0: inline text-file attachment. The contents are folded into the
// prompt (not stored in R2); we persist only metadata so history can show
// that a file was attached without bloating D1 with the full text.
interface PersistedDocumentAttachment {
  type: "document";
  mime?: string;
  filename?: string;
  chars: number;
}
type PersistedAttachment =
  | PersistedImageAttachment
  | PersistedAudioAttachment
  | PersistedVideoFramesAttachment
  | PersistedVideoFullAttachment
  | PersistedDocumentAttachment;

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

function modelNeedsCfAigToken(model: ModelEntry): boolean {
  return !!model.provider && model.provider !== "workers-ai";
}

async function requireAiContext(
  env: Env,
  userEmail: string,
  opts?: { requireCfToken?: boolean },
): Promise<AiContext | Response> {
  const gateway = await loadGatewayCredentials(env, userEmail);
  if (!gateway?.gatewayId) {
    return json({ error: GATEWAY_NOT_CONFIGURED_MSG }, { status: 412 });
  }
  if (opts?.requireCfToken && !gateway.cfAigToken) {
    return json({ error: CF_AIG_TOKEN_REQUIRED_MSG }, { status: 412 });
  }
  return { env, gateway };
}

async function handlePrefsGet(request: Request, env: Env): Promise<Response> {
  const userEmail = getUserEmail(request);
  const prefs = await loadUserPrefs(env.DB, userEmail);
  const status = await loadGatewayStatus(env, userEmail);
  return json({
    gateway_id: status.gateway_id,
    cf_aig_token_set: status.cf_aig_token_set,
    cf_aig_token_preview: maskSecret(prefs?.cf_aig_token),
    configured: status.configured,
    source: status.source,
  });
}

async function handlePrefsPatch(request: Request, env: Env): Promise<Response> {
  const userEmail = getUserEmail(request);
  let body: { gateway_id?: string; cf_aig_token?: string; clear_cf_aig_token?: boolean };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: { gateway_id?: string; cf_aig_token?: string } = {};
  if (body.gateway_id !== undefined) patch.gateway_id = body.gateway_id;
  if (body.cf_aig_token !== undefined) patch.cf_aig_token = body.cf_aig_token;
  if (body.clear_cf_aig_token) patch.cf_aig_token = "";

  if (Object.keys(patch).length === 0) {
    return json({ error: "Provide gateway_id and/or cf_aig_token to update" }, { status: 400 });
  }

  const merged = await saveUserPrefs(env.DB, userEmail, patch);
  const status = await loadGatewayStatus(env, userEmail);
  return json({
    gateway_id: status.gateway_id,
    cf_aig_token_set: status.cf_aig_token_set,
    cf_aig_token_preview: maskSecret(merged.cf_aig_token),
    configured: status.configured,
    source: status.source,
  });
}


async function r2Put(env: Env, prefix: "in" | "out", mime: string, bytes: Uint8Array, userEmail: string): Promise<string> {
  const key = `${prefix}/${crypto.randomUUID()}.${extFromMime(mime)}`;
  await env.R2.put(key, bytes, {
    httpMetadata: { contentType: mime },
    customMetadata: { user_email: userEmail },
  });
  return key;
}


// Read an R2 object and return it as a base64 `data:` URI. Used to inline a
// source image for image-to-video (hh1-i2v): the upstream accepts data URIs
// (verified, it re-uploads them to its own OSS), so we don't need a presigned
// GET URL. Ownership is enforced the same way /api/artifact does: the object's
// customMetadata.user_email must match, so a client can't reference another
// user's R2 key via image_key. Throws on miss or ownership mismatch.
async function r2KeyToDataUri(env: Env, key: string, userEmail: string): Promise<string> {
  const obj = await env.R2.get(key);
  if (!obj) throw new Error(`source image not found: ${key}`);
  if (obj.customMetadata?.user_email !== userEmail) {
    throw new Error(`source image not owned by requester: ${key}`);
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const mime = obj.httpMetadata?.contentType || "image/png";
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

// Attachment-by-reference (v0.21.7): an image or full-video attachment may
// carry an R2 `key` (an artifact already produced in this conversation)
// instead of inline `data`. Hydrate `data` from R2 once, here at the request
// boundary, so every downstream consumer (vision chat, FLUX.2 reference
// images, image-to-video) works unchanged. Ownership is enforced by
// r2KeyToDataUri. This is what lets a model use what a previous model in the
// same conversation generated, with no download/re-upload.
async function resolveAttachmentKeys(env: Env, attachments: InputAttachment[], userEmail: string): Promise<InputAttachment[]> {
  return Promise.all(attachments.map(async (att) => {
    if ((att.type === "image" || att.type === "video_full") && att.key && !att.data) {
      return { ...att, data: await r2KeyToDataUri(env, att.key, userEmail) };
    }
    return att;
  }));
}

async function r2DeleteSafe(env: Env, key: string): Promise<void> {
  try { await env.R2.delete(key); } catch { /* ignore */ }
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
      const userEmail = getUserEmail(request);
      const gateway = await loadGatewayStatus(env, userEmail);
      return json({ models: MODELS, user: userEmail, gateway });
    }
    if (url.pathname === "/api/prefs" && request.method === "GET") {
      return handlePrefsGet(request, env);
    }
    if (url.pathname === "/api/prefs" && request.method === "PATCH") {
      return handlePrefsPatch(request, env);
    }
    // v0.104.0 / v0.108.0: conversational STT (@cf/deepgram/flux) over a
    // WebSocket. flux is websocket-only, so this is a WS upgrade endpoint, not a
    // chat model. The upgrade is forwarded to a per-session SttSession Durable
    // Object that bridges to flux and persists the final transcript to /history
    // on close. The original request carries the CF Access user header, which
    // the DO reads to attribute the row.
    if (url.pathname === "/api/stt/stream" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const stub = env.STT_SESSION.get(env.STT_SESSION.newUniqueId());
      return stub.fetch(request);
    }
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env, ctx);
    }
    if (url.pathname === "/api/chat/stream" && request.method === "POST") {
      return handleChatStream(request, env, ctx);
    }
    // v0.118.0: lightweight TTS endpoint for the voice-chat loop. Synthesizes
    // text to speech (Deepgram Aura-2) and streams the audio bytes straight
    // back, WITHOUT persisting a chats row (unlike the tts MODEL path through
    // /api/chat). Used to speak the LLM's reply in hands-free voice chat.
    if (url.pathname === "/api/tts" && request.method === "POST") {
      return handleTtsSpeak(request, env);
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

    // v0.20.0: project endpoints. See handleProjectList for endpoint docs.
    if (url.pathname === "/api/projects") {
      if (request.method === "GET")  return handleProjectList(request, env);
      if (request.method === "POST") return handleProjectCreate(request, env);
    }
    const p = url.pathname.match(/^\/api\/projects\/(\d+)$/);
    if (p) {
      const id = Number(p[1]);
      if (request.method === "GET")    return handleProjectGet(request, env, id);
      if (request.method === "PATCH")  return handleProjectUpdate(request, env, id);
      if (request.method === "DELETE") return handleProjectDelete(request, env, id);
    }
    const pd = url.pathname.match(/^\/api\/projects\/(\d+)\/documents\/(\d+)$/);
    if (pd) {
      const projectId = Number(pd[1]);
      const docId = Number(pd[2]);
      if (request.method === "POST")   return handleProjectDocAdd(request, env, projectId, docId);
      if (request.method === "DELETE") return handleProjectDocRemove(request, env, projectId, docId);
    }
    // v0.20.3: Discord export import into a project.
    const pi = url.pathname.match(/^\/api\/projects\/(\d+)\/import-discord$/);
    if (pi && request.method === "POST") {
      return handleDiscordImport(request, env, Number(pi[1]));
    }

    if (url.pathname === "/api/conversations" && request.method === "GET") {
      return handleConversationList(request, env);
    }
    const c = url.pathname.match(/^\/api\/conversations\/([A-Za-z0-9_:-]+)$/);
    if (c) {
      if (request.method === "GET")    return handleConversationGet(request, env, c[1]);
      if (request.method === "DELETE") return handleConversationDelete(request, env, c[1]);
    }
    // v0.20.2: PATCH /api/conversations/:id/project to move a conversation
    // to/from a project (body: {project_id: number | null}).
    const cp = url.pathname.match(/^\/api\/conversations\/([A-Za-z0-9_:-]+)\/project$/);
    if (cp && request.method === "PATCH") {
      return handleConversationMoveToProject(request, env, cp[1]);
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

    // v0.26.0: poll a durable zip-import workflow by its instance id.
    const imp = url.pathname.match(/^\/api\/import\/([A-Za-z0-9-]+)$/);
    if (imp && request.method === "GET") {
      return handleImportStatus(request, env, imp[1]);
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

  // Hydrate attachment-by-reference (image/video attachments carrying an R2
  // key instead of inline data) before routing, so every handler sees ready
  // attachments. v0.21.7: cross-model artifact reuse within a conversation.
  if (body.attachments?.length) {
    body.attachments = await resolveAttachmentKeys(env, body.attachments, getUserEmail(request));
  }

  if (model.type === "chat") return runChat(request, env, model, body);
  if (model.type === "image") return runImage(request, env, model, body);
  if (model.type === "tts") return runTts(request, env, model, body);
  if (model.type === "video") return runVideo(request, env, ctx, model, body);
  if (model.type === "stt") return runStt(request, env, model, body);
  if (model.type === "music") return runMusic(request, env, ctx, model, body);
  // "voice" is a live streaming session, not a request/response turn. The UI
  // opens the mic streamer (WS /api/stt/stream) instead of POSTing here; reject
  // with a clear pointer in case a client tries the chat path anyway.
  if (model.type === "voice") {
    return json(
      { error: "This is a live voice model; connect to the WebSocket at /api/stt/stream (mic streaming), not /api/chat." },
      { status: 400 },
    );
  }
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
  // Anthropic + Workers AI + xAI + OpenAI + Google. Workers AI catalog
  // entries omit `provider` (the type allows this and the ModelEntry default
  // per the type comment is "workers-ai"); Unified Billing providers set it
  // explicitly.
  const isWorkersAI = !model.provider;
  if (
    model.provider !== "anthropic" &&
    model.provider !== "xai" &&
    model.provider !== "openai" &&
    model.provider !== "google" &&
    !isWorkersAI
  ) {
    return json({ error: `Streaming for provider '${model.provider}' is not yet implemented.` }, { status: 501 });
  }

  return runChatStream(request, env, model, body);
}

// ---------- Chat (text generation, multimodal in) ----------

async function runChat(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = getUserEmail(request);
  const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: modelNeedsCfAigToken(model) });
  if (ctxOrErr instanceof Response) return ctxOrErr;
  const aiCtx = ctxOrErr;
  const inputs: InputAttachment[] = body.attachments ?? [];

  // v0.20.0: resolve project_id to row, apply per-project system_prompt
  // fallback when the per-turn prompt is empty/undefined. The effective
  // prompt is mutated back onto `body` so downstream provider calls and
  // persistence see exactly what was used. scopedProjectId is passed to
  // retrieveContext so RAG retrieval is filtered to that project's docs.
  const { resolvedSystemPrompt, scopedProjectId } = await resolveProjectForChat(env, userEmail, body);
  body.system_prompt = resolvedSystemPrompt;

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
      ? retrieveContext(env, userEmail, body.user_input, RETRIEVE_TOP_K, scopedProjectId)
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
      imageDataUrls.push(att.data!); // guaranteed by the parsed guard above (data may be hydrated from a key)
      persistedAtt.push({ type: "image", key, mime: parsed.mime, filename: att.filename });
    } else if (att.type === "audio") {
      const parsed = att.data ? parseDataUrl(att.data) : null;
      if (!parsed) return json({ error: "Invalid audio data URL" }, { status: 400 });
      try {
        const wr = await aiRun(aiCtx, WHISPER_MODEL, { audio: parsed.base64 });
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
      // Full video file upload. No chat model currently consumes the raw video
      // (the keyframe path covers vision models); the upload is still stored in
      // R2 so it appears in history and the plumbing stays ready for a future
      // video-aware model. Dormant since Bedrock Pegasus was removed in v0.95.0.
      const parsed = att.data ? parseDataUrl(att.data) : null;
      if (!parsed) return json({ error: "Invalid video data URL" }, { status: 400 });
      const bytes = base64ToBytes(parsed.base64);
      const key = await r2Put(env, "in", parsed.mime, bytes, userEmail);
      const fn = att.filename ? ` "${att.filename}"` : "";
      extraText.push(`[Full video${fn} attached for video-aware model]`);
      persistedAtt.push({ type: "video_full", key, mime: parsed.mime, filename: att.filename });
    } else if (att.type === "document") {
      const r = buildDocumentAttachment(att);
      if ("error" in r) return json({ error: r.error }, { status: 400 });
      extraText.push(r.extra);
      persistedAtt.push(r.persisted);
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
  // For Workers AI, xAI, and OpenAI, we push a role:"system" message.
  //
  // Prior turns of this conversation go in as alternating user/assistant
  // text messages. Multimodal content (images) from prior turns is NOT
  // re-included; if the user wants to reference earlier images they can
  // re-attach. Current turn's attachments are still threaded into userContent.
  const wantsSystemInMessages = model.provider !== "anthropic" && model.provider !== "google";
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
    if (model.id === "@cf/llava-hf/llava-1.5-7b-hf") {
      // LLaVA 1.5 is image-to-text: input is { image: number[] (raw bytes),
      // prompt, max_tokens }, not the chat { messages } shape, and it's
      // single-shot (one image + one prompt; prior turns and system prompt are
      // not threaded). We surface it as a vision chat model so the existing
      // attach UI works, but route it here for the different wire format.
      const imgAtt = inputs.find((a) => a.type === "image");
      if (!imgAtt?.data) {
        return json({ error: "LLaVA needs an image attachment. Attach one, then ask about it." }, { status: 400 });
      }
      const parsedImg = parseDataUrl(imgAtt.data);
      if (!parsedImg) {
        return json({ error: "Invalid image data URL" }, { status: 400 });
      }
      result = await aiRun(aiCtx, model.id, {
        image: [...base64ToBytes(parsedImg.base64)],
        prompt: body.user_input || "Describe this image in detail.",
        max_tokens: 512,
      });
      logId = aiLogId(aiCtx);
    } else if (model.provider === "anthropic") {
      const r = await callAnthropic(aiCtx, model, effectiveSystemPrompt || undefined, messages);
      result = r.raw;
      logId = r.logId;
    } else if (model.provider === "xai") {
      const r = await callXai(aiCtx, model, messages);
      result = r.raw;
      logId = r.logId;
    } else if (model.provider === "google") {
      const r = await callGemini(aiCtx, model, effectiveSystemPrompt || undefined, messages);
      result = r.raw;
      logId = r.logId;
    } else {
      result = await aiRun(aiCtx, model.id, { messages });
      logId = aiLogId(aiCtx);
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `AI call failed: ${m}` }, { status: 502 });
  }

  // Some providers (notably OpenAI/Gemini proxied via unified billing) return
  // a failure envelope { state: "Failed", error: "..." } as a resolved value
  // instead of throwing. Surface it as a 502 here; otherwise extractOutput
  // would stringify the envelope into chats.output and persist the failed
  // turn as a success.
  const providerFailure = detectProviderFailure(result);
  if (providerFailure) {
    return json({ error: `Model execution failed: ${providerFailure}` }, { status: 502 });
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
    project_id: scopedProjectId ?? null,
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
  let aiCtx: AiContext | null = null;
  const needsProxiedGateway = !!model.provider && !(model.provider === "openai" && env.OPENAI_API_KEY);
  if (needsProxiedGateway) {
    const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: true });
    if (ctxOrErr instanceof Response) return ctxOrErr;
    aiCtx = ctxOrErr;
  }

  // Image gen splits two ways. Proxied models (those with a `provider`:
  // nano-banana/google, gpt-image-1.5/openai, recraftv4/recraft) go through the
  // gateway binding, return a URL, and share one code path. The @cf models
  // (no `provider`) return base64 or a ReadableStream and need the bypass +
  // shape-detection handling below. Both converge on the (bytes, mime) tuple
  // and the shared R2-put + persist + respond tail.
  let bytes: Uint8Array;
  let mime: string;
  let latency: number;
  let logId: string | null = null;

  const start = Date.now();
  try {
    if (model.provider) {
      if (model.provider === "openai" && env.OPENAI_API_KEY) {
        // BYOK direct: the only path that yields a transparent PNG (the proxy
        // rejects background/output_format). Returns base64, decoded in the
        // helper; no gateway log id since this bypasses the AI Gateway.
        ({ bytes, mime } = await generateOpenAIImage(env.OPENAI_API_KEY, model.id, body.user_input));
        logId = null;
      } else {
      // Proxied image (Unified Billing via the gateway): nano-banana (google),
      // recraftv4 (recraft, opaque), and gpt-image-1.5 (openai) ONLY as the
      // opaque fallback when no OPENAI_API_KEY is set (the transparent path is
      // the BYOK branch above).
      // The @cf models carry no `provider`, so this branch is exactly the
      // proxied set. Per-provider request shape comes from buildProxiedImageParams
      // because each upstream schema is additionalProperties:false and rejects
      // the @cf { width, height, steps, negative_prompt } shape; system_prompt
      // has no negative_prompt slot on any of them and is ignored.
      //
      // All three return a URL (not base64) in the { state, result } envelope:
      //   { state: "Completed", result: { image: "<url>" } }
      // so we fetch the URL and store the bytes, like the video path does. mime
      // comes from the response content-type (recraftv4 returns webp, the
      // openai/google paths return png), so no format is hardcoded on the store.
      // (First pass is text-to-image only; gpt-image-1.5's images[] editing and
      // reference inputs are a later add, mirroring the FLUX.2 ref-image work.)
      const result = await aiRun(aiCtx!, model.id, buildProxiedImageParams(model.provider, body.user_input));
      logId = aiLogId(aiCtx!);

      const failure = detectProviderFailure(result);
      if (failure) {
        return json({ error: `Image generation failed: ${failure}` }, { status: 502 });
      }
      const imageUrl = extractProxiedImageUrl(result);
      if (!imageUrl) {
        return json({ error: "Image generation returned no image URL", raw: result }, { status: 502 });
      }
      const aresp = await fetch(imageUrl);
      if (!aresp.ok) {
        return json({ error: `Failed to fetch generated image: ${aresp.status}` }, { status: 502 });
      }
      bytes = new Uint8Array(await aresp.arrayBuffer());
      mime = aresp.headers.get("content-type") || "image/png";
      }
    } else {
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
      const isSdxl = model.id === "@cf/stabilityai/stable-diffusion-xl-base-1.0";
      const bypassGateway = isFlux2
        || model.id === "@cf/leonardo/phoenix-1.0"
        || model.id === "@cf/lykon/dreamshaper-8-lcm"
        || isSdxl; // SDXL returns a ReadableStream image; gateway can't proxy it

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
        // SDXL's step field is `num_steps` (max 20), not `steps`; swap to avoid
        // sending an unknown/over-max field.
        if (isSdxl) {
          delete params.steps;
          params.num_steps = 20;
        }
        runParams = params;
      }

      // Run via the binding. Bypass the gateway for stream-incompatible
      // models; everything else stays on the aiRun helper path (which
      // populates ai_gateway_log_id for observability).
      let result: unknown;
      if (bypassGateway) {
        type BypassRunFn = (model: string, params: unknown) => Promise<unknown>;
        result = await (env.AI as unknown as { run: BypassRunFn }).run(model.id, runParams);
      } else {
        if (!aiCtx) {
          const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: false });
          if (ctxOrErr instanceof Response) return ctxOrErr;
          aiCtx = ctxOrErr;
        }
        result = await aiRun(aiCtx, model.id, runParams);
        logId = aiLogId(aiCtx);
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
        // All stream-output image models here emit PNG bytes. (The SDXL docs
        // claim image/jpg, but the binding's actual output is PNG, confirmed
        // live, so we don't special-case it.)
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

// v0.118.0: speak arbitrary text via Aura-2 and stream the audio back. No D1
// row (the voice-chat loop calls this for every assistant reply; persisting
// each one would flood history). Caps length and restricts the voice to the
// two Aura-2 catalog entries.
const TTS_VOICES = new Set(["@cf/deepgram/aura-2-en", "@cf/deepgram/aura-2-es"]);
async function handleTtsSpeak(request: Request, env: Env): Promise<Response> {
  const userEmail = getUserEmail(request);
  const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: false });
  if (ctxOrErr instanceof Response) return ctxOrErr;
  const aiCtx = ctxOrErr;

  let body: { text?: string; voice?: string };
  try {
    body = await request.json<{ text?: string; voice?: string }>();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
  if (!text) return json({ error: "text required" }, { status: 400 });
  const voice = body.voice && TTS_VOICES.has(body.voice) ? body.voice : "@cf/deepgram/aura-2-en";
  try {
    const resp = await aiRun(aiCtx, voice, { text, prompt: text }, true /* returnRawResponse */);
    if (!(resp instanceof Response)) {
      return json({ error: "TTS returned non-Response shape" }, { status: 502 });
    }
    const mime = resp.headers.get("content-type") || "audio/mpeg";
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return new Response(bytes, { headers: { "content-type": mime, "cache-control": "no-store" } });
  } catch (err) {
    return json({ error: `TTS failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }
}

async function runTts(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = getUserEmail(request);
  const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: false });
  if (ctxOrErr instanceof Response) return ctxOrErr;
  const aiCtx = ctxOrErr;

  let mime: string;
  let bytes: Uint8Array;
  let logId: string | null = null;

  const start = Date.now();
  try {
    // Aura: { text }; MeloTTS: { prompt, lang? }. Send both keys defensively.
    const params: Record<string, unknown> = { text: body.user_input, prompt: body.user_input };
    const resp = await aiRun(aiCtx, model.id, params, true /* returnRawResponse */);
    logId = aiLogId(aiCtx);
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

// Deepgram ASR on Workers AI returns the native Deepgram results object, not
// the top-level { text } that Whisper returns. Standard path is
// results.channels[0].alternatives[0].transcript; we also tolerate a couple of
// alternate shapes and a normalized top-level text/transcript, defensively.
function extractDeepgramTranscript(result: unknown): string {
  const r = result as {
    results?: {
      channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
      alternatives?: Array<{ transcript?: string }>;
    };
    text?: string;
    transcript?: string;
  };
  const viaChannels = r?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof viaChannels === "string") return viaChannels.trim();
  const viaAlternatives = r?.results?.alternatives?.[0]?.transcript;
  if (typeof viaAlternatives === "string") return viaAlternatives.trim();
  if (typeof r?.transcript === "string") return r.transcript.trim();
  if (typeof r?.text === "string") return r.text.trim();
  return "";
}

async function runStt(request: Request, env: Env, model: ModelEntry, body: ChatRequest): Promise<Response> {
  const userEmail = getUserEmail(request);
  const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: false });
  if (ctxOrErr instanceof Response) return ctxOrErr;
  const aiCtx = ctxOrErr;
  const t0 = Date.now();

  const audioAtt = (body.attachments ?? []).find((a) => a.type === "audio");
  if (!audioAtt?.data) {
    return json({ error: "Please attach an audio file to transcribe" }, { status: 400 });
  }
  const parsed = parseDataUrl(audioAtt.data);
  if (!parsed) return json({ error: "Invalid audio data URL" }, { status: 400 });

  const viaDeepgram = model.id.startsWith("@cf/deepgram/");
  let transcript: string;
  try {
    if (viaDeepgram) {
      // Deepgram wants { audio: { body, contentType } } where body is a
      // ReadableStream of the audio bytes (a bare base64 string or Uint8Array
      // fails schema validation). AI Gateway does not support ReadableStream
      // inputs ("error 5006/ReadableStreams not supported"), so this is the
      // one call that bypasses the gateway and hits the binding directly;
      // there's no cf-aig-log-id for it (logId stays null below). Output is
      // the native Deepgram results object, parsed by extractDeepgramTranscript.
      const dr = await (env.AI as unknown as { run: (m: string, p: unknown) => Promise<unknown> })
        .run(model.id, { audio: { body: new Response(base64ToBytes(parsed.base64)).body, contentType: parsed.mime } });
      transcript = extractDeepgramTranscript(dr);
    } else {
      const wr = await aiRun(aiCtx, model.id, { audio: parsed.base64 });
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
    ai_gateway_log_id: viaDeepgram ? null : aiLogId(aiCtx),
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

// Conversational STT (@cf/deepgram/flux) is handled by the SttSession Durable
// Object (src/stt-session.ts), which the /api/stt/stream route forwards the WS
// upgrade to. It bridges to flux and persists the final transcript to /history.

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
  const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: modelNeedsCfAigToken(model) });
  if (ctxOrErr instanceof Response) return ctxOrErr;
  void ctxOrErr; // credentials validated; workflow loads them from D1 by userEmail
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
  // v0.62.0: MiniMax music-2.6 returns gateway error 7003 ("User Input
  // Error") when lyrics is empty or missing, even for instrumental
  // requests. Default to "[Instrumental]" - the model's own marker
  // syntax - so a caller that wants an instrumental track can omit the
  // system_prompt without their job failing seconds after submit. A
  // non-empty system_prompt (real lyrics) wins.
  const rawLyrics = (body.system_prompt ?? "").trim();
  const lyrics = rawLyrics.length > 0 ? body.system_prompt! : "[Instrumental]";

  let instanceId: string;
  try {
    const instance = await env.LONGRUN.create({
      params: {
        rowId: row.id,
        userEmail,
        modelId: model.id,
        prompt: body.user_input,
        lyrics,
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
  project_id?: number | null;  // v0.20.2: project this chat turn was sent within
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
        retrieved_context, conversation_id, turn_index, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      turnIdx,
      a.project_id ?? null
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

// ---------- runChatStream (v0.13.0) ----------
//
// Streaming counterpart of runChat. Shares the prelude contract (parallel
// hoisting of priorTurnsPromise + retrievePromise overlapping the attachment
// walk; multi-turn continuation; RAG system-prompt assembly) and diverges
// at the model call: each provider's stream adapter (callAnthropicStream
// in src/providers/anthropic.ts, etc.) is an async generator that yields
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
  const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: modelNeedsCfAigToken(model) });
  if (ctxOrErr instanceof Response) return ctxOrErr;
  const aiCtx = ctxOrErr;
  const inputs: InputAttachment[] = body.attachments ?? [];

  // v0.20.0: same project resolution as runChat. See resolveProjectForChat
  // for semantics. Mutating body.system_prompt here means downstream code
  // (provider call, persistence) sees the effective prompt with no further
  // awareness of projects.
  const { resolvedSystemPrompt, scopedProjectId } = await resolveProjectForChat(env, userEmail, body);
  body.system_prompt = resolvedSystemPrompt;

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
      ? retrieveContext(env, userEmail, body.user_input, RETRIEVE_TOP_K, scopedProjectId)
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
      imageDataUrls.push(att.data!); // guaranteed by the parsed guard above (data may be hydrated from a key)
      persistedAtt.push({ type: "image", key, mime: parsed.mime, filename: att.filename });
    } else if (att.type === "audio") {
      const parsed = att.data ? parseDataUrl(att.data) : null;
      if (!parsed) return json({ error: "Invalid audio data URL" }, { status: 400 });
      try {
        const wr = await aiRun(aiCtx, WHISPER_MODEL, { audio: parsed.base64 });
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
      // No streaming model accepts raw video; reject explicitly so the user
      // attaches extracted frames instead of getting silent truncation.
      return json({ error: "Raw video attachments are not accepted on the streaming path. Attach extracted frames instead." }, { status: 400 });
    } else if (att.type === "document") {
      const r = buildDocumentAttachment(att);
      if ("error" in r) return json({ error: r.error }, { status: 400 });
      extraText.push(r.extra);
      persistedAtt.push(r.persisted);
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
        streamGenerator = callAnthropicStream(aiCtx, model, effectiveSystemPrompt || undefined, messages, upstreamAbort.signal);
      } else if (model.provider === "xai") {
        streamGenerator = callXaiStream(aiCtx, model, messages, upstreamAbort.signal);
      } else if (model.provider === "openai") {
        streamGenerator = callOpenAIStream(aiCtx, model, messages, upstreamAbort.signal);
      } else if (model.provider === "google") {
        streamGenerator = callGeminiStream(aiCtx, model, effectiveSystemPrompt || undefined, messages, upstreamAbort.signal);
      } else {
        streamGenerator = callWorkersAIStream(aiCtx, model, messages, upstreamAbort.signal);
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
        project_id: scopedProjectId ?? null,
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

// ---------- Video generation (Unified Billing via env.AI.run) ----------
//
// As of Cloudflare Agents Week 2026 (April 2026), the AI Gateway and Workers
// AI are unified. Third-party video models are callable via env.AI.run with
// model strings like "google/veo-3.1-fast" or "xai/grok-imagine-video".
// Cloudflare bills your account directly under Unified Billing. See:
//   https://developers.cloudflare.com/ai-gateway/features/unified-billing/
//   https://developers.cloudflare.com/ai/models/google/veo-3.1-fast/
//
// Video gen takes 30s-3min. env.AI.run for these models blocks until
// completion, which exceeds the ~30s waitUntil budget after an HTTP response.
// Cloudflare Workflows (v0.12.0+): the runVideo handler creates a
// LongRunWorkflow instance, persists its ID on the row, and returns
// immediately. The workflow class holds the long blocking env.AI.run call
// alive across step boundaries, then downloads and finalizes D1.
//
// The frontend polls /api/job/:id for status (reads D1 only; the workflow
// updates the row when done).

async function runVideo(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  model: ModelEntry,
  body: ChatRequest
): Promise<Response> {
  void ctx;
  const userEmail = getUserEmail(request);
  const ctxOrErr = await requireAiContext(env, userEmail, { requireCfToken: modelNeedsCfAigToken(model) });
  if (ctxOrErr instanceof Response) return ctxOrErr;
  void ctxOrErr; // credentials validated; workflow loads them from D1 by userEmail
  const startedAt = new Date().toISOString();

  // Image-to-video models (e.g. alibaba/hh1-i2v, flagged "image-input") need a
  // source image (v0.21.6). Three sources, resolved into one of two workflow
  // params: an uploaded attachment or an R2 key (image_key, e.g. a prior
  // nano-banana output for chaining) -> `imageKey`, resolved to a data: URI in
  // the workflow; a fetchable external URL (image_url) -> `imageUrl`, passed
  // through. Uploads are stored to R2 here so the (potentially multi-MB) image
  // doesn't ride the Workflow event payload (~1 MiB cap); the small key does.
  const needsImage = model.capabilities.includes("image-input");
  let srcImageKey: string | undefined;
  let srcImageUrl: string | undefined;
  if (needsImage) {
    const imgAtt = (body.attachments ?? []).find((a) => a.type === "image" && a.data);
    if (imgAtt && imgAtt.type === "image" && imgAtt.data) {
      const parsed = parseDataUrl(imgAtt.data);
      if (!parsed) {
        return json({ error: "Attached image is not a base64 data URL." }, { status: 400 });
      }
      srcImageKey = await r2Put(env, "in", parsed.mime, base64ToBytes(parsed.base64), userEmail);
    } else if (body.image_key && body.image_key.trim()) {
      srcImageKey = body.image_key.trim();
    } else if (body.image_url && body.image_url.trim()) {
      srcImageUrl = body.image_url.trim();
    } else {
      return json({ error: "This image-to-video model requires a source image: attach one, or pass 'image_key' (an R2 key) or 'image_url' (a fetchable URL)." }, { status: 400 });
    }
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
        imageUrl: srcImageUrl,
        imageKey: srcImageKey,
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

// ---------- Job polling endpoint ----------
//
// Reflects the current D1 row state. Long-running video/music jobs are owned
// by LongRunWorkflow instances, which update the row when they finish.

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

  // Pending (Unified Billing video/music via LongRunWorkflow). The workflow
  // updates D1 when its work completes; this endpoint just reflects current
  // row state.
  return json({ id: row.id, status: "pending" });
}

// ---------- Output extraction (text models) ----------
// extractOutput / extractUsage moved to src/output-extract.ts (v0.21.0) so
// they can be unit-tested without importing index.ts. Imported at the top.

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
  //   - v0.20.2: project_id from the conversation's first turn (the sidebar
  //     shows a project chip when this is set). project_id is a per-row
  //     column but conversations are expected to have a uniform value
  //     across turns (handleConversationMoveToProject updates all turns
  //     atomically). Subqueries match the existing pattern for first_input.
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
        (SELECT project_id FROM chats c2
          WHERE c2.conversation_id = c.conversation_id AND c2.user_email = c.user_email
          ORDER BY c2.turn_index ASC LIMIT 1) AS project_id,
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
      project_id: number | null;
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

// v0.20.2: move a conversation to a project (or clear its project assignment).
// Body: { project_id: number | null }. When project_id is a number, the
// project must exist and belong to the same user. When null, the assignment
// is cleared on all turns.
//
// All turns in the conversation are updated atomically. The conversation_id
// is the existing key for ownership (chats.user_email + conversation_id).
async function handleConversationMoveToProject(
  request: Request,
  env: Env,
  conversationId: string,
): Promise<Response> {
  const userEmail = getUserEmail(request);

  let body: { project_id?: number | null };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const newProjectId = body.project_id ?? null;
  if (newProjectId !== null) {
    if (!Number.isInteger(newProjectId) || newProjectId <= 0) {
      return json({ error: "project_id must be a positive integer or null" }, { status: 400 });
    }
    // Confirm the target project exists and belongs to this user.
    const proj = await env.DB.prepare(
      `SELECT id FROM projects WHERE id = ? AND user_email = ?`
    )
      .bind(newProjectId, userEmail)
      .first();
    if (!proj) return json({ error: "Project not found" }, { status: 404 });
  }

  // Confirm the conversation exists and belongs to this user before
  // updating, otherwise we silently no-op on stale ids.
  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM chats
      WHERE conversation_id = ? AND user_email = ?`
  )
    .bind(conversationId, userEmail)
    .first<{ n: number }>();
  if (!existing || existing.n === 0) {
    return json({ error: "Conversation not found" }, { status: 404 });
  }

  const result = await env.DB.prepare(
    `UPDATE chats SET project_id = ?
      WHERE conversation_id = ? AND user_email = ?`
  )
    .bind(newProjectId, conversationId, userEmail)
    .run();

  return json({
    conversation_id: conversationId,
    project_id: newProjectId,
    rows_updated: result.meta?.changes ?? 0,
  });
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
const EMBED_BATCH_SIZE = 16;       // BGE accepts batches; 16 keeps requests small
const DOC_MAX_BYTES = 10 * 1024 * 1024;  // 10MB upload cap

// v0.25.0: ZIP import (RAG). A .zip upload is expanded and each inner file is
// ingested as its own document. The compressed archive still rides the 10MB
// DOC_MAX_BYTES cap above; these bound the decompressed expansion (zip-bomb
// guard) and the inner-file count.
const ZIP_MAX_ENTRIES = 200;
const ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const ZIP_MAX_FILE_BYTES = DOC_MAX_BYTES;

// Best-effort content type for a file pulled out of a zip (we only get a name,
// not a mime). extractChunks routes PDFs/spreadsheets by extension regardless,
// so this only affects the contentType stored on the R2 object.
function mimeFromName(name: string): string {
  const ext = (name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  switch (ext) {
    case "pdf": return "application/pdf";
    case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "xls": return "application/vnd.ms-excel";
    case "md": case "markdown": return "text/markdown";
    case "csv": return "text/csv";
    case "json": return "application/json";
    case "html": case "htm": return "text/html";
    case "xml": return "application/xml";
    case "txt": case "log": case "yaml": case "yml": return "text/plain";
    default: return "application/octet-stream";
  }
}

// v0.17.0: web-search retrieval limits and timeouts. Each upstream is
// time-bounded per source so a slow Tavily doesn't block Brave or Wikipedia.
// Counts kept small to bound context-token spend when the toggle is on.
const TAVILY_MAX_RESULTS    = 5;
const BRAVE_MAX_RESULTS     = 5;
const WIKIPEDIA_MAX_RESULTS = 3;
const WEB_SEARCH_TIMEOUT_MS = 8000;

// v0.23.0: RAG document upload accepts any file type (no allowlist). PDF and
// XLSX/XLS get native per-page / per-sheet extraction; everything else is
// decoded as UTF-8 text (covers txt, md, csv, json, html, source code, logs,
// etc. regardless of extension or mime). extractChunks rejects only files
// whose bytes don't decode to usable text (binary formats like .docx/.png/.zip).

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

// v0.20.0: project + project_documents join. A project groups documents
// (and in v0.20.1, conversations) under a shared system_prompt and
// retrieval scope. Many-to-many membership via project_documents.
interface ProjectRow {
  id: number;
  user_email: string;
  name: string;
  slug: string;
  description: string | null;
  system_prompt: string | null;
  created_at: string;
  updated_at: string;
}

// Output of the per-format extractors. Each ExtractedChunk has text plus
// optional source-location metadata that gets persisted on the chunk row.
interface ExtractedChunk {
  text: string;
  page?: number;     // PDF: 1-indexed page number
  sheet?: string;    // XLSX/XLS: source sheet name
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

// v0.23.0: heuristic: is a decoded string actually binary data we failed to
// read as text? A meaningful fraction of U+FFFD (UTF-8 replacement) or C0 control
// codes other than the usual whitespace (tab, LF, CR) means the source was
// binary (zipped office docs, images, archives). Text-based formats stay far
// below the threshold. Sample the head to keep this O(1)-ish on big files.
function looksBinary(text: string): boolean {
  if (!text) return true;
  const sample = text.length > 4096 ? text.slice(0, 4096) : text;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0xfffd) { bad++; continue; }
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) bad++;
  }
  return bad / sample.length > 0.1;
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

  // Everything else: treat as UTF-8 text. Covers txt/md plus any code, CSV,
  // JSON, HTML, log, or other text-based format, whatever the extension.
  // Decode with replacement on invalid bytes rather than throwing; if the
  // result is mostly replacement/control bytes the file is binary in a format
  // we can't extract, so reject it instead of embedding garbage.
  const text = new TextDecoder("utf-8").decode(bytes);
  if (looksBinary(text)) {
    throw new Error(
      `${filename} looks like binary data that can't be read as text. PDF and ` +
      `XLSX/XLS are extracted natively; otherwise upload a text-based file ` +
      `(txt, md, csv, json, html, source code, etc.).`
    );
  }
  return chunkText(text).map((t) => ({ text: t }));
}

async function embedBatch(env: Env, userEmail: string, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const gateway = await loadGatewayCredentials(env, userEmail);
  if (!gateway?.gatewayId) {
    throw new Error(GATEWAY_NOT_CONFIGURED_MSG);
  }
  const aiCtx: AiContext = { env, gateway };
  const result = await aiRun(aiCtx, EMBED_MODEL, { text: texts }) as {
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
  topK: number = RETRIEVE_TOP_K,
  projectId?: number,
): Promise<{ chunks: RetrievedChunk[]; error: string | null }> {
  if (!queryText || !queryText.trim()) {
    return { chunks: [], error: "Empty query text" };
  }

  // 1) Embed the query. Log + surface errors instead of silently swallowing.
  let queryVec: number[];
  try {
    const vectors = await embedBatch(env, userEmail, [queryText]);
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
  // When projectId is set, we overfetch (3x topK) at the Vectorize stage
  // and filter by project membership in D1, since Vectorize doesn't know
  // about project membership. Without overfetch, a small topK that all
  // misses the project would return zero results even when the project
  // has relevant chunks.
  const vectorizeTopK = projectId !== undefined ? topK * 3 : topK;
  let matches: { id: string; score: number }[];
  try {
    const q = await env.VEC.query(queryVec, { topK: vectorizeTopK });
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
  // somehow collide. When projectId is set, additionally INNER JOIN
  // project_documents so only chunks whose document is in that project's
  // membership set come through.
  const ids = matches.map((m) => m.id);
  const placeholders = ids.map(() => "?").join(",");
  let rows;
  try {
    if (projectId !== undefined) {
      rows = await env.DB.prepare(
        `SELECT c.document_id, c.chunk_index, c.text, c.vector_id, c.page, c.sheet, d.filename
           FROM chunks c
           JOIN documents d           ON c.document_id = d.id
           JOIN project_documents pd  ON pd.document_id = d.id
           JOIN projects p            ON p.id = pd.project_id
          WHERE c.user_email = ?
            AND p.user_email = ?
            AND pd.project_id = ?
            AND c.vector_id IN (${placeholders})`
      )
        .bind(userEmail, userEmail, projectId, ...ids)
        .all<{ document_id: number; chunk_index: number; text: string; vector_id: string; filename: string; page: number | null; sheet: string | null }>();
    } else {
      rows = await env.DB.prepare(
        `SELECT c.document_id, c.chunk_index, c.text, c.vector_id, c.page, c.sheet, d.filename
           FROM chunks c
           JOIN documents d ON c.document_id = d.id
          WHERE c.user_email = ?
            AND c.vector_id IN (${placeholders})`
      )
        .bind(userEmail, ...ids)
        .all<{ document_id: number; chunk_index: number; text: string; vector_id: string; filename: string; page: number | null; sheet: string | null }>();
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error("retrieveContext: D1 lookup failed:", m);
    return { chunks: [], error: `D1 lookup failed: ${m}` };
  }

  const results = rows.results ?? [];
  if (results.length === 0) {
    // Vectorize had matches but D1 join returned nothing. Two causes:
    //   1. user_email mismatch (vectors written under a different identity).
    //   2. With projectId set: matches were real but none of the matched
    //      documents are members of the requested project.
    const idSample = ids.slice(0, 3).join(", ");
    const scope = projectId !== undefined ? ` project_id=${projectId},` : "";
    const msg = `Vectorize returned ${matches.length} matches but D1 join returned 0. user_email='${userEmail}',${scope} sample vector_ids=[${idSample}]. Check whether vectors were upserted under a different user identity, or whether the project has any document members.`;
    console.warn("retrieveContext:", msg);
    return { chunks: [], error: msg };
  }

  // 4) Merge scores back in, preserve Vectorize ordering. When projectId
  // is set we overfetched from Vectorize (3x topK), so cap output here to
  // hold the chat prompt size to the caller's intended top-K.
  const byId = new Map(results.map((r) => [r.vector_id, r]));
  const scoreById = new Map(matches.map((m) => [m.id, m.score]));
  const out: RetrievedChunk[] = [];
  for (const id of ids) {
    if (out.length >= topK) break;
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
// Optional retrieval source: Tavily and Brave for general web, Wikipedia for
// lore / reference. All three run in parallel; failure of one doesn't kill
// the others. Per-source timeouts (WEB_SEARCH_TIMEOUT_MS) prevent a slow
// upstream from blocking the whole turn.
//
// Tavily requires TAVILY_API_KEY; Brave requires BRAVE_API_KEY. When either
// key is unset, that source is silently skipped. Wikipedia needs no key.
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
  // doesn't abort the others. Partial results are better than nothing.
  const tavilyPromise: Promise<RetrievedWebResult[]> = env.TAVILY_API_KEY
    ? searchTavily(env.TAVILY_API_KEY, q).catch(() => [])
    : Promise.resolve([]);
  const bravePromise: Promise<RetrievedWebResult[]> = env.BRAVE_API_KEY
    ? searchBrave(env.BRAVE_API_KEY, q).catch(() => [])
    : Promise.resolve([]);
  const wikipediaPromise: Promise<RetrievedWebResult[]> = searchWikipedia(q).catch(() => []);

  const [tavily, brave, wikipedia] = await Promise.all([tavilyPromise, bravePromise, wikipediaPromise]);
  const results = [...tavily, ...brave, ...wikipedia];

  // Empty results is fine; it just means the query didn't match anything in
  // any source. Real per-source failures are swallowed by the .catch above
  // so the other sources can still return their hits.
  return { results, error: null };
}

async function searchBrave(apiKey: string, query: string): Promise<RetrievedWebResult[]> {
  const hits = await searchBraveWeb(apiKey, query, {
    maxResults: BRAVE_MAX_RESULTS,
    timeoutMs: WEB_SEARCH_TIMEOUT_MS,
  });
  return hits.map((r): RetrievedWebResult => ({
    source_type: "web",
    source: "brave",
    url: r.url,
    title: r.title,
    snippet: r.snippet,
  }));
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
  // Strip HTML tags to a fixpoint first, so a reassembled/nested tag (e.g.
  // "<<script>script>") can't survive a single pass, THEN decode the handful of
  // entities Wikipedia emits -- decoding &amp; LAST so an encoded entity like
  // "&amp;lt;" stays literal text instead of being double-unescaped into "<".
  // Output is plain text for an LLM context block (not an HTML/DOM sink).
  let prev = "";
  let s = html;
  while (s !== prev) {
    prev = s;
    s = s.replace(/<[^>]+>/g, "");
  }
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function webSourceSystemLabel(source: RetrievedWebResult["source"]): string {
  switch (source) {
    case "tavily": return "Web";
    case "brave": return "Brave";
    case "wikipedia": return "Wikipedia";
  }
}

function formatWebForSystemPrompt(results: RetrievedWebResult[]): string {
  if (results.length === 0) return "";
  const body = results
    .map((r, i) => {
      const sourceLabel = webSourceSystemLabel(r.source);
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
  const url = new URL(request.url);
  const projectIdParam = url.searchParams.get("project_id");

  // v0.20.0: optional ?project_id=N filter. When set, return only documents
  // attached to that project via project_documents. The project ownership
  // check is done by joining on projects.user_email implicitly via WHERE
  // p.user_email = ?, so attempting to filter by another user's project
  // returns an empty list rather than leaking that the project exists.
  if (projectIdParam !== null) {
    const projectId = Number(projectIdParam);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return json({ error: "project_id must be a positive integer" }, { status: 400 });
    }
    const rows = await env.DB.prepare(
      `SELECT d.id, d.created_at, d.filename, d.mime, d.size_bytes,
              d.total_chars, d.chunk_count
         FROM documents d
         JOIN project_documents pd ON pd.document_id = d.id
         JOIN projects p           ON p.id = pd.project_id
        WHERE d.user_email = ?
          AND p.user_email = ?
          AND pd.project_id = ?
        ORDER BY pd.added_at DESC`
    )
      .bind(userEmail, userEmail, projectId)
      .all<{
        id: number;
        created_at: string;
        filename: string;
        mime: string;
        size_bytes: number;
        total_chars: number;
        chunk_count: number;
      }>();
    return json({
      user: userEmail,
      project_id: projectId,
      documents: rows.results ?? [],
    });
  }

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

// Result of ingesting a single file into the RAG store. Returned (not a
// Response) so both the single-file upload path and the per-entry zip-import
// path can compose it.
type IngestResult =
  | { ok: true; id: number; created_at: string; filename: string; mime: string; size_bytes: number; total_chars: number; chunk_count: number }
  | { ok: false; status: number; error: string };

// Core RAG ingest for one file: extract -> store raw bytes in R2 -> insert the
// document row -> embed in batches and upsert vectors -> write chunk rows.
// Extracted from handleDocumentUpload (v0.25.0) so ZIP import can reuse it
// per inner file. Best-effort rollback on embedding failure.
async function ingestDocument(env: Env, userEmail: string, filename: string, mime: string, bytes: Uint8Array): Promise<IngestResult> {
  let extracted: ExtractedChunk[];
  try {
    extracted = await extractChunks(bytes, mime, filename);
  } catch (err) {
    return { ok: false, status: 400, error: `Extraction failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (extracted.length === 0) {
    return { ok: false, status: 400, error: "No chunks produced (empty, image-only/scanned PDF, or unreadable format)." };
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
    return { ok: false, status: 500, error: "Failed to insert document row" };
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
      const vectors = await embedBatch(env, userEmail, batch.map((c) => c.text));
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
    return { ok: false, status: 502, error: `Embedding failed: ${err instanceof Error ? err.message : String(err)}` };
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

  return {
    ok: true,
    id: docId,
    created_at: docInsert.created_at,
    filename,
    mime,
    size_bytes: bytes.length,
    total_chars: totalChars,
    chunk_count: extracted.length,
  };
}

// v0.26.0: a .zip upload is imported durably via the LongRunWorkflow rather
// than synchronously. We stage the archive to R2 (the workflow reads it from
// there, since 10MB can't ride the workflow event payload), kick off the
// workflow, and return its instance id as job_id. The client polls
// GET /api/import/:id for the result. Expansion + per-file ingest happen in
// separate workflow steps, each with a fresh subrequest budget, so large
// archives import without hitting the per-invocation subrequest limit that the
// old synchronous path (v0.25.0) could approach.
async function handleZipImport(env: Env, userEmail: string, zipBytes: Uint8Array): Promise<Response> {
  // Stage the archive so the workflow can read it back. customMetadata.user_email
  // matches the convention used for every other R2 object.
  const zipKey = `tmp/${crypto.randomUUID()}.zip`;
  try {
    await env.R2.put(zipKey, zipBytes, {
      httpMetadata: { contentType: "application/zip" },
      customMetadata: { user_email: userEmail },
    });
  } catch (err) {
    return json({ error: `Failed to stage zip: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }

  const startedAt = new Date().toISOString();
  let instanceId: string;
  try {
    const instance = await env.LONGRUN.create({
      params: { kind: "zip_import", userEmail, zipKey, startedAtIso: startedAt } satisfies LongRunParams,
    });
    instanceId = instance.id;
  } catch (err) {
    await r2DeleteSafe(env, zipKey);
    return json({ error: `Failed to start import: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }

  // async:true tells the client to poll /api/import/:id rather than expecting
  // an inline result.
  return json({ zip: true, async: true, job_id: instanceId });
}

// v0.26.0: poll a zip-import workflow. Translates the workflow instance status
// into the same pending/done/failed vocabulary the rest of the UI uses. The
// import summary is only returned to the user who started it (the workflow
// records userEmail in its output), so a guessed instance id can't read another
// user's result.
async function handleImportStatus(request: Request, env: Env, id: string): Promise<Response> {
  const userEmail = getUserEmail(request);
  let status: { status: string; output?: unknown; error?: unknown };
  try {
    const instance = await env.LONGRUN.get(id);
    status = await instance.status();
  } catch {
    return json({ error: "Unknown import job" }, { status: 404 });
  }

  if (status.status === "complete") {
    const summary = (status.output ?? {}) as Partial<ZipImportSummary>;
    if (summary.userEmail !== userEmail) {
      return json({ error: "Unknown import job" }, { status: 404 });
    }
    return json({
      status: "done",
      imported_count: summary.imported_count ?? 0,
      total_chunks: summary.total_chunks ?? 0,
      imported: summary.imported ?? [],
      skipped: summary.skipped ?? [],
    });
  }

  if (status.status === "errored" || status.status === "terminated") {
    const msg = typeof status.error === "string" ? status.error : JSON.stringify(status.error ?? "import failed");
    return json({ status: "failed", error: msg });
  }

  // queued / running / waiting / paused / unknown -> still in progress.
  return json({ status: "pending" });
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
  // No file-type allowlist: any file is accepted. extractChunks routes by
  // format and falls back to UTF-8 text for unknown types, rejecting only
  // bytes that don't decode to usable text. A .zip is expanded (v0.25.0).
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

  // v0.25.0: a zip is expanded and each inner file ingested separately.
  if (isZip(bytes)) {
    return handleZipImport(env, userEmail, bytes);
  }

  const r = await ingestDocument(env, userEmail, filename, mime, bytes);
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json({
    id: r.id,
    created_at: r.created_at,
    filename: r.filename,
    mime: r.mime,
    size_bytes: r.size_bytes,
    total_chars: r.total_chars,
    chunk_count: r.chunk_count,
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
  // v0.20.1: also clean up project_documents memberships so deleting a doc
  // that's attached to projects doesn't leave orphan membership rows.
  // v0.20.3: also clean up project_messages (raw Discord rows) for the doc.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM chunks            WHERE document_id = ? AND user_email = ?`).bind(id, userEmail),
    env.DB.prepare(`DELETE FROM project_documents WHERE document_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM project_messages  WHERE document_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM documents         WHERE id          = ? AND user_email = ?`).bind(id, userEmail),
  ]);
  await r2DeleteSafe(env, doc.r2_key);

  return json({ deleted: id, vectors_removed: vectorIds.length });
}

// ---------- Projects (v0.20.0) ----------
//
// Projects group documents (and in v0.20.1 onward, conversations) under a
// shared system_prompt and retrieval scope. v0.20.0 endpoints:
//
//   GET    /api/projects                              list user's projects
//   POST   /api/projects                              create project
//   GET    /api/projects/:id                          get project + members
//   PATCH  /api/projects/:id                          rename / update prompt / desc
//   DELETE /api/projects/:id                          delete (cascades to memberships)
//   POST   /api/projects/:pid/documents/:did          add document to project
//   DELETE /api/projects/:pid/documents/:did          remove document from project
//   GET    /api/documents?project_id=N                list docs in project
//
// All endpoints scope by user_email; cross-user reads return 404,
// cross-user writes (e.g. adding another user's doc to your project) are
// rejected with 400 before touching the DB.
//
// Per-project system prompt fallback (handleChat / handleChatStream):
// when a chat request includes project_id but no per-turn system_prompt,
// the project's system_prompt is used as default. A per-turn system_prompt
// always overrides; empty-string system_prompt counts as "set to empty"
// and disables the fallback (intentional - lets users explicitly clear).
//
// Per-project RAG scoping (retrieveContext): when a chat request includes
// project_id, retrieval joins project_documents and excludes chunks from
// documents not in that project's membership set. No project_id means
// "all user's docs" (backward compat).

// Generate a URL-safe slug from a display name. Strips non-alphanumeric
// characters, collapses runs of whitespace and dashes, lowercases, trims.
// Empty input or all-punctuation input falls back to "project".
function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]+/g, "")  // drop punctuation/diacritics
    .trim()
    .replace(/[\s-]+/g, "-")          // collapse whitespace runs to single dash
    .replace(/^-+|-+$/g, "");         // trim leading/trailing dashes
  return s || "project";
}

// Find an unused slug for the user. If `base` is unused, returns base.
// Otherwise appends -2, -3, ... until free. Bounded at 200 attempts;
// beyond that we throw, which would indicate a degenerate slug or a
// pathological state.
async function findFreeSlug(env: Env, userEmail: string, base: string): Promise<string> {
  let candidate = base;
  let suffix = 2;
  while (suffix < 200) {
    const existing = await env.DB.prepare(
      `SELECT id FROM projects WHERE user_email = ? AND slug = ? LIMIT 1`
    )
      .bind(userEmail, candidate)
      .first();
    if (!existing) return candidate;
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  throw new Error(`Could not allocate slug after 200 attempts (base='${base}')`);
}

// Shared helper used by runChat + runChatStream. Resolves the chat's
// project_id (if any), looks up the project row scoped to the user, and
// computes the effective system prompt with project-fallback semantics.
//
// Semantics:
//   - body.project_id is undefined or not a positive integer: no project.
//   - body.project_id points to a project not owned by this user: treated
//     same as missing (returns project=null, no fallback). Logged.
//   - body.project_id points to a deleted/unknown project: same as above.
//
//   - Per-turn body.system_prompt non-empty (after trim) wins outright;
//     the project's system_prompt is ignored.
//   - Per-turn body.system_prompt is undefined or empty/whitespace AND a
//     project is resolved AND that project has a non-null system_prompt:
//     use the project's prompt.
//   - Otherwise: no effective prompt (undefined).
//
// The resolved project_id is also returned for retrieveContext scoping.
async function resolveProjectForChat(
  env: Env,
  userEmail: string,
  body: ChatRequest,
): Promise<{ project: ProjectRow | null; resolvedSystemPrompt: string | undefined; scopedProjectId: number | undefined }> {
  let project: ProjectRow | null = null;
  let scopedProjectId: number | undefined;

  if (body.project_id !== undefined && Number.isInteger(body.project_id) && body.project_id > 0) {
    project = await env.DB.prepare(
      `SELECT id, user_email, name, slug, description, system_prompt, created_at, updated_at
         FROM projects WHERE id = ? AND user_email = ?`
    )
      .bind(body.project_id, userEmail)
      .first<ProjectRow>();
    if (!project) {
      console.warn(
        `Chat referenced unknown project_id=${body.project_id} for user_email='${userEmail}'; ` +
        `falling back to no-project semantics (no system prompt fallback, no retrieval scoping).`
      );
    } else {
      scopedProjectId = project.id;
    }
  }

  const reqPrompt = body.system_prompt;
  const hasReqPrompt = reqPrompt !== undefined && reqPrompt.trim() !== "";
  const resolvedSystemPrompt = hasReqPrompt
    ? reqPrompt
    : (project?.system_prompt ?? undefined);

  return { project, resolvedSystemPrompt, scopedProjectId };
}

async function handleProjectList(request: Request, env: Env): Promise<Response> {
  const userEmail = getUserEmail(request);
  // LEFT JOIN to count document memberships per project. COUNT(pd.document_id)
  // returns 0 for projects with no members (because of LEFT JOIN), rather
  // than 1 which COUNT(*) would return.
  const rows = await env.DB.prepare(
    `SELECT p.id, p.name, p.slug, p.description, p.system_prompt,
            p.created_at, p.updated_at,
            COUNT(pd.document_id) AS document_count
       FROM projects p
       LEFT JOIN project_documents pd ON pd.project_id = p.id
      WHERE p.user_email = ?
      GROUP BY p.id
      ORDER BY p.created_at DESC`
  )
    .bind(userEmail)
    .all<{
      id: number; name: string; slug: string; description: string | null;
      system_prompt: string | null; created_at: string; updated_at: string;
      document_count: number;
    }>();
  return json({ user: userEmail, projects: rows.results ?? [] });
}

async function handleProjectGet(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = getUserEmail(request);
  const proj = await env.DB.prepare(
    `SELECT id, name, slug, description, system_prompt, created_at, updated_at
       FROM projects WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first<ProjectRow>();
  if (!proj) return json({ error: "Not found" }, { status: 404 });

  // Include the project's documents (id, filename, chunk_count) so the
  // detail view can render them without a second fetch.
  const docs = await env.DB.prepare(
    `SELECT d.id, d.filename, d.mime, d.size_bytes, d.chunk_count, d.created_at,
            pd.added_at
       FROM project_documents pd
       JOIN documents d ON d.id = pd.document_id
      WHERE pd.project_id = ? AND d.user_email = ?
      ORDER BY pd.added_at DESC`
  )
    .bind(id, userEmail)
    .all<{
      id: number; filename: string; mime: string; size_bytes: number;
      chunk_count: number; created_at: string; added_at: string;
    }>();

  return json({ project: proj, documents: docs.results ?? [] });
}

async function handleProjectCreate(request: Request, env: Env): Promise<Response> {
  const userEmail = getUserEmail(request);
  let body: { name?: string; description?: string; system_prompt?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  if (!name) return json({ error: "name is required" }, { status: 400 });
  if (name.length > 200) return json({ error: "name too long (max 200 chars)" }, { status: 400 });

  const baseSlug = slugify(name);
  const slug = await findFreeSlug(env, userEmail, baseSlug);

  const description = (body.description ?? "").trim() || null;
  const systemPrompt = (body.system_prompt ?? "").trim() || null;

  const result = await env.DB.prepare(
    `INSERT INTO projects (user_email, name, slug, description, system_prompt)
     VALUES (?, ?, ?, ?, ?)
     RETURNING id, name, slug, description, system_prompt, created_at, updated_at`
  )
    .bind(userEmail, name, slug, description, systemPrompt)
    .first<ProjectRow>();

  if (!result) return json({ error: "Insert failed" }, { status: 500 });
  return json({ project: result }, { status: 201 });
}

async function handleProjectUpdate(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = getUserEmail(request);
  // Confirm ownership before any write.
  const existing = await env.DB.prepare(
    `SELECT id FROM projects WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first();
  if (!existing) return json({ error: "Not found" }, { status: 404 });

  let body: { name?: string; description?: string | null; system_prompt?: string | null };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Build dynamic UPDATE based on which fields the caller sent. Undefined =
  // "don't touch"; null or empty string = "clear to empty/null". Name has
  // to be a non-empty string if provided.
  const sets: string[] = [];
  const params: Array<string | number | null> = [];

  if (body.name !== undefined) {
    const n = body.name.trim();
    if (!n) return json({ error: "name cannot be empty" }, { status: 400 });
    if (n.length > 200) return json({ error: "name too long (max 200 chars)" }, { status: 400 });
    sets.push("name = ?");
    params.push(n);
  }
  if (body.description !== undefined) {
    const d = (body.description ?? "").toString().trim() || null;
    sets.push("description = ?");
    params.push(d);
  }
  if (body.system_prompt !== undefined) {
    const sp = (body.system_prompt ?? "").toString().trim() || null;
    sets.push("system_prompt = ?");
    params.push(sp);
  }

  if (sets.length === 0) {
    return json({ error: "No updatable fields in body" }, { status: 400 });
  }

  // Slug is intentionally NOT updated on rename. Keeps URLs/storage keys
  // stable. If renames need new slugs, that's a separate explicit op.
  sets.push("updated_at = datetime('now')");
  params.push(id, userEmail);

  await env.DB.prepare(
    `UPDATE projects SET ${sets.join(", ")} WHERE id = ? AND user_email = ?`
  )
    .bind(...params)
    .run();

  const updated = await env.DB.prepare(
    `SELECT id, name, slug, description, system_prompt, created_at, updated_at
       FROM projects WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first<ProjectRow>();
  return json({ project: updated });
}

async function handleProjectDelete(request: Request, env: Env, id: number): Promise<Response> {
  const userEmail = getUserEmail(request);
  const existing = await env.DB.prepare(
    `SELECT id FROM projects WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .first();
  if (!existing) return json({ error: "Not found" }, { status: 404 });

  // Cascade: delete memberships first, then the project itself. Documents
  // belonging to the project STAY (they may be in other projects, and even
  // if not, the user uploaded them and may want to keep them outside
  // project organization). v0.20.3: also clear project_messages scoped to
  // this project (raw Discord rows; the documents and their chunks stay).
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM project_documents WHERE project_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM project_messages  WHERE project_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM projects          WHERE id = ? AND user_email = ?`).bind(id, userEmail),
  ]);
  return json({ deleted: id });
}

async function handleProjectDocAdd(request: Request, env: Env, projectId: number, docId: number): Promise<Response> {
  const userEmail = getUserEmail(request);
  // Confirm both project and document belong to the user. Cross-user
  // attachment is rejected here.
  const proj = await env.DB.prepare(
    `SELECT id FROM projects WHERE id = ? AND user_email = ?`
  )
    .bind(projectId, userEmail)
    .first();
  if (!proj) return json({ error: "Project not found" }, { status: 404 });

  const doc = await env.DB.prepare(
    `SELECT id FROM documents WHERE id = ? AND user_email = ?`
  )
    .bind(docId, userEmail)
    .first();
  if (!doc) return json({ error: "Document not found" }, { status: 404 });

  // INSERT OR IGNORE: idempotent membership. Reattaching a doc that's
  // already a member returns 200 without an error (added_at stays at the
  // original value).
  await env.DB.prepare(
    `INSERT OR IGNORE INTO project_documents (project_id, document_id) VALUES (?, ?)`
  )
    .bind(projectId, docId)
    .run();
  return json({ project_id: projectId, document_id: docId, added: true });
}

async function handleProjectDocRemove(request: Request, env: Env, projectId: number, docId: number): Promise<Response> {
  const userEmail = getUserEmail(request);
  const proj = await env.DB.prepare(
    `SELECT id FROM projects WHERE id = ? AND user_email = ?`
  )
    .bind(projectId, userEmail)
    .first();
  if (!proj) return json({ error: "Project not found" }, { status: 404 });

  await env.DB.prepare(
    `DELETE FROM project_documents WHERE project_id = ? AND document_id = ?`
  )
    .bind(projectId, docId)
    .run();
  return json({ project_id: projectId, document_id: docId, removed: true });
}

// v0.20.3: import a DiscordChatExporter JSON export into a project.
//
// POST /api/projects/:id/import-discord
// Body: { filename?: string, data: base64, options?: { gapMinutes, includeBots } }
//
// Pipeline (mirrors handleDocumentUpload, but for Discord exports):
//   1. validate project ownership
//   2. decode + size-check the export bytes
//   3. parse DCE JSON -> normalized messages (parseDiscordExport)
//   4. conversation-aware chunk (chunkDiscordMessages)
//   5. store export bytes in R2
//   6. insert a documents row for the export file
//   7. attach the document to the project (project_documents)
//   8. persist raw messages to project_messages (for future re-chunking)
//   9. embed chunks, upsert to Vectorize, insert chunk rows with the
//      channel/authors/time metadata columns
//
// The chunk embed/store loop is intentionally a near-duplicate of the one in
// handleDocumentUpload rather than a shared helper: the document path is the
// higher-traffic code and has no integration tests, so refactoring it to
// share code carries regression risk disproportionate to ~30 saved lines.
// Consolidation is a candidate for a later cleanup release once integration
// tests exist.
async function handleDiscordImport(request: Request, env: Env, projectId: number): Promise<Response> {
  const userEmail = getUserEmail(request);

  const proj = await env.DB.prepare(
    `SELECT id FROM projects WHERE id = ? AND user_email = ?`
  )
    .bind(projectId, userEmail)
    .first();
  if (!proj) return json({ error: "Project not found" }, { status: 404 });

  let body: { filename?: string; data?: string; options?: { gapMinutes?: number; includeBots?: boolean } };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.data) {
    return json({ error: "Missing export data" }, { status: 400 });
  }

  const filename = body.filename || "discord-export.json";

  // Decode base64 (data URL or raw).
  let bytes: Uint8Array;
  try {
    const parsed = body.data.startsWith("data:") ? parseDataUrl(body.data) : null;
    bytes = parsed ? base64ToBytes(parsed.base64) : base64ToBytes(body.data);
  } catch (err) {
    return json({ error: `Bad export data: ${err instanceof Error ? err.message : err}` }, { status: 400 });
  }
  if (bytes.length > DOC_MAX_BYTES) {
    return json({
      error: `Export too large (${bytes.length} bytes, max ${DOC_MAX_BYTES}). Split the export by date range or channel, or wait for presigned upload (v0.20.4).`,
    }, { status: 413 });
  }

  // Parse the JSON export.
  let exportJson: unknown;
  try {
    exportJson = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    return json({ error: `Export is not valid JSON: ${err instanceof Error ? err.message : err}` }, { status: 400 });
  }

  let parsed;
  try {
    parsed = parseDiscordExport(exportJson);
  } catch (err) {
    return json({ error: `Not a recognized DiscordChatExporter export: ${err instanceof Error ? err.message : err}` }, { status: 400 });
  }
  if (parsed.messages.length === 0) {
    return json({
      error: "No usable messages in the export (all were system notifications or empty). Nothing to import.",
    }, { status: 400 });
  }

  const chunks = chunkDiscordMessages(parsed.messages, {
    gapMinutes: body.options?.gapMinutes,
    includeBots: body.options?.includeBots,
  });
  if (chunks.length === 0) {
    return json({ error: "Parsing produced messages but chunking produced none (check includeBots option)." }, { status: 400 });
  }

  const totalChars = chunks.reduce((sum, c) => sum + c.text.length, 0);
  const mime = "application/json";
  const r2Key = await r2Put(env, "in", mime, bytes, userEmail);

  // Insert the documents row for the export file.
  const docInsert = await env.DB.prepare(
    `INSERT INTO documents
       (user_email, filename, mime, r2_key, size_bytes, total_chars, chunk_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id, created_at`
  )
    .bind(userEmail, filename, mime, r2Key, bytes.length, totalChars, chunks.length)
    .first<{ id: number; created_at: string }>();
  if (!docInsert) {
    await r2DeleteSafe(env, r2Key);
    return json({ error: "Failed to insert document row" }, { status: 500 });
  }
  const docId = docInsert.id;

  // Attach the export document to the project so project-scoped retrieval
  // includes it immediately.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO project_documents (project_id, document_id) VALUES (?, ?)`
  )
    .bind(projectId, docId)
    .run();

  // Persist raw messages for future re-chunking. Batched in groups to stay
  // within D1 statement limits.
  const PM_BATCH = 50;
  for (let i = 0; i < parsed.messages.length; i += PM_BATCH) {
    const slice = parsed.messages.slice(i, i + PM_BATCH);
    const stmts = slice.map((m) =>
      env.DB.prepare(
        `INSERT INTO project_messages
           (project_id, document_id, user_email, message_id, channel, author, author_id, is_bot, sent_at, content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(projectId, docId, userEmail, m.messageId, m.channel, m.author, m.authorId, m.isBot ? 1 : 0, m.sentAt, m.content)
    );
    await env.DB.batch(stmts);
  }

  // Embed chunks and upsert to Vectorize. vector_id scheme matches documents:
  // `${userEmail}:${docId}:${chunkIndex}`.
  const vectorIdsWritten: string[] = [];
  const chunkRowsToInsert: {
    chunk_index: number;
    text: string;
    vector_id: string;
    channel: string;
    authors: string;
    sent_at_start: string;
    sent_at_end: string;
  }[] = [];

  try {
    for (let b = 0; b < chunks.length; b += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(b, b + EMBED_BATCH_SIZE);
      const vectors = await embedBatch(env, userEmail, batch.map((c) => c.text));
      if (vectors.length !== batch.length) {
        throw new Error(`Embedding batch returned ${vectors.length} vectors for ${batch.length} texts`);
      }
      const payload = batch.map((c, i) => {
        const idx = b + i;
        const vid = `${userEmail}:${docId}:${idx}`;
        chunkRowsToInsert.push({
          chunk_index: idx,
          text: c.text,
          vector_id: vid,
          channel: c.channel,
          authors: c.authors.join(", "),
          sent_at_start: c.sentAtStart,
          sent_at_end: c.sentAtEnd,
        });
        vectorIdsWritten.push(vid);
        return {
          id: vid,
          values: vectors[i],
          metadata: {
            user_email: userEmail,
            document_id: docId,
            chunk_index: idx,
            channel: c.channel,
          },
        };
      });
      await env.VEC.upsert(payload);
    }
  } catch (err) {
    // Rollback partial state.
    if (vectorIdsWritten.length) {
      try { await env.VEC.deleteByIds(vectorIdsWritten); } catch { /* swallow */ }
    }
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM project_messages  WHERE document_id = ?`).bind(docId),
      env.DB.prepare(`DELETE FROM project_documents WHERE document_id = ?`).bind(docId),
      env.DB.prepare(`DELETE FROM documents         WHERE id = ?`).bind(docId),
    ]);
    await r2DeleteSafe(env, r2Key);
    const m = err instanceof Error ? err.message : String(err);
    return json({ error: `Embedding failed: ${m}` }, { status: 502 });
  }

  // Insert chunk rows with the Discord metadata columns. page/sheet stay NULL.
  if (chunkRowsToInsert.length) {
    for (let i = 0; i < chunkRowsToInsert.length; i += PM_BATCH) {
      const slice = chunkRowsToInsert.slice(i, i + PM_BATCH);
      const stmts = slice.map((c) =>
        env.DB.prepare(
          `INSERT INTO chunks
             (document_id, user_email, chunk_index, text, vector_id, channel, authors, sent_at_start, sent_at_end)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(docId, userEmail, c.chunk_index, c.text, c.vector_id, c.channel, c.authors, c.sent_at_start, c.sent_at_end)
      );
      await env.DB.batch(stmts);
    }
  }

  return json({
    document_id: docId,
    created_at: docInsert.created_at,
    project_id: projectId,
    filename,
    guild: parsed.guild,
    channel: parsed.channel,
    raw_message_count: parsed.rawCount,
    imported_message_count: parsed.parsedCount,
    chunk_count: chunks.length,
  });
}

// ---------- Artifact serving ----------

async function handleArtifact(request: Request, env: Env, key: string): Promise<Response> {
  const userEmail = getUserEmail(request);
  // Artifacts (chat input + output) all live on env.R2.
  const bucket = env.R2;
  // v0.142.0: forward the request's conditional headers (If-None-Match) to R2.
  // With a conditional get, R2 returns the object WITHOUT a body when the
  // client's ETag still matches, and we reply 304 (a ~0-byte revalidation);
  // a changed object returns fresh bytes. customMetadata is present on the
  // body-less R2Object too, so the ownership check is unaffected.
  const obj = await bucket.get(key, { onlyIf: request.headers });
  if (!obj) return new Response("Not Found", { status: 404 });

  // Authorization: only the user who created the artifact may fetch it.
  // We stored user_email in customMetadata at put time. Checked before any
  // 304 so a non-owner with a guessed ETag still gets 403, never a hit/miss.
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
  // Revalidate every fetch instead of blind-caching for an hour: no-cache means
  // the browser keeps its copy but must check ETag first, so an overwritten
  // artifact shows fresh while an unchanged one costs only a 304. MP4s (which
  // never overwrite, since a new render is a new job-id key) just 304 cheaply.
  headers.set("cache-control", "private, no-cache");
  if (obj.httpEtag) headers.set("etag", obj.httpEtag);
  headers.set("content-disposition", `inline; filename="${filename}"`);

  // R2 returns a body-less R2Object when the conditional matched (not modified).
  if (!("body" in obj) || obj.body === null) {
    return new Response(null, { status: 304, headers });
  }
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

  // AI binding: confirm worker-level gateway config, or note per-user mode.
  // We deliberately do NOT run an actual model here; even the cheapest model
  // call burns neurons and a per-minute health probe would add up.
  {
    const t0 = Date.now();
    if (env.GATEWAY_ID?.trim()) {
      checks.ai_config = { ok: true, latency_ms: Date.now() - t0 };
    } else {
      // Public demo: users supply gateway slug + token via /api/prefs.
      checks.ai_config = { ok: true, latency_ms: Date.now() - t0 };
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

interface LongRunGenParams extends Record<string, unknown> {
  rowId: number;
  userEmail: string;
  modelId: string;
  prompt: string;
  lyrics?: string;          // music only
  imageUrl?: string;        // image-to-video: a fetchable URL passed through as-is
  imageKey?: string;        // image-to-video: an R2 key resolved to a data: URI in the workflow (uploads + chaining)
  kind: LongRunKind;
  startedAtIso: string;
}

// v0.26.0: durable bulk ZIP import. The uploaded archive is staged to R2
// (`zipKey`) so its bytes never ride the workflow event payload; the workflow
// unzips it and ingests each inner file in its own step. Putting each file in
// a separate step gives each ingest a fresh Worker subrequest budget, which is
// what lets a large archive import without hitting the per-invocation limit
// that the synchronous v0.25.0 path could approach.
interface ZipImportParams extends Record<string, unknown> {
  kind: "zip_import";
  userEmail: string;
  zipKey: string;
  startedAtIso: string;
}

type LongRunParams =
  | LongRunGenParams
  | ZipImportParams;

// Returned by the zip-import workflow run() and surfaced via the instance's
// status().output to the polling client. userEmail is included so the status
// endpoint can enforce per-user ownership (a guessed instance id can't read
// another user's import result).
interface ZipImportSummary {
  userEmail: string;
  imported_count: number;
  total_chunks: number;
  imported: Array<{ name: string; id: number; chunk_count: number }>;
  skipped: Array<{ name: string; reason: string }>;
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
  async run(event: WorkflowEvent<LongRunParams>, step: WorkflowStep): Promise<unknown> {
    if (event.payload.kind === "zip_import") {
      return this.runZipImport(event.payload, step);
    }
    return this.runGen(event.payload, step);
  }

  // v0.26.0: bulk ZIP import. Step 1 unzips the staged archive and stages each
  // inner file to a temp R2 object (returning only the small name+key list, so
  // we stay under the 1 MiB step-return cap and never pass bytes between
  // steps). Each subsequent step ingests one file with a fresh subrequest
  // budget. A failed ingest becomes a skip, not a workflow failure. A final
  // step deletes the temp objects and the staged zip.
  async runZipImport(p: ZipImportParams, step: WorkflowStep): Promise<ZipImportSummary> {
    const { userEmail, zipKey } = p;

    const { staged, skipped: unzipSkipped } = await step.do(
      "unzip-and-stage",
      { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
      async (): Promise<{ staged: Array<{ name: string; key: string }>; skipped: Array<{ name: string; reason: string }> }> => {
        const obj = await this.env.R2.get(zipKey);
        if (!obj) throw new Error("staged zip not found in R2");
        const bytes = new Uint8Array(await obj.arrayBuffer());
        const { entries, skipped } = await unzip(bytes, {
          maxEntries: ZIP_MAX_ENTRIES,
          maxTotalBytes: ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES,
          maxFileBytes: ZIP_MAX_FILE_BYTES,
        });
        const out: Array<{ name: string; key: string }> = [];
        for (const e of entries) {
          const key = `tmp/${crypto.randomUUID()}`;
          await this.env.R2.put(key, e.bytes, { customMetadata: { user_email: userEmail } });
          out.push({ name: e.name, key });
        }
        return { staged: out, skipped };
      }
    );

    const imported: ZipImportSummary["imported"] = [];
    const skipped: ZipImportSummary["skipped"] = [...unzipSkipped];

    // One step per file: each gets its own subrequest budget. ingestDocument
    // swallows its own errors into an ok:false result (after rolling back its
    // partial writes), so an unreadable file does not abort the import.
    for (let i = 0; i < staged.length; i++) {
      const item = staged[i];
      const res = await step.do(
        `ingest-${i}`,
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
        async (): Promise<{ ok: true; name: string; id: number; chunk_count: number } | { ok: false; name: string; reason: string }> => {
          const obj = await this.env.R2.get(item.key);
          if (!obj) return { ok: false, name: item.name, reason: "staged file missing" };
          const bytes = new Uint8Array(await obj.arrayBuffer());
          const r = await ingestDocument(this.env, userEmail, item.name, mimeFromName(item.name), bytes);
          return r.ok
            ? { ok: true, name: item.name, id: r.id, chunk_count: r.chunk_count }
            : { ok: false, name: item.name, reason: r.error };
        }
      );
      if (res.ok) imported.push({ name: res.name, id: res.id, chunk_count: res.chunk_count });
      else skipped.push({ name: res.name, reason: res.reason });
    }

    // Cleanup: drop the temp staged files and the staged zip. Best-effort; a
    // leaked temp object under tmp/ is harmless and can be swept by an R2
    // lifecycle rule. Done after all ingests so a per-file step retry can still
    // re-read its staged object.
    await step.do(
      "cleanup",
      { retries: { limit: 1, delay: "5 seconds", backoff: "linear" } },
      async (): Promise<void> => {
        for (const item of staged) await r2DeleteSafe(this.env, item.key);
        await r2DeleteSafe(this.env, zipKey);
      }
    );

    return {
      userEmail,
      imported_count: imported.length,
      total_chunks: imported.reduce((s, d) => s + d.chunk_count, 0),
      imported,
      skipped,
    };
  }

  async runGen(payload: LongRunGenParams, step: WorkflowStep): Promise<void> {
    const { rowId, userEmail, modelId, prompt, lyrics, imageUrl, imageKey, kind, startedAtIso } = payload;

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
          // Resolve the source image for image-to-video: an R2 key (upload or
          // chained nano-banana output) becomes a data: URI here, inside the
          // step, so the big base64 never rides the Workflow event payload.
          // A plain URL passes straight through. Resolution happens in-step so
          // a transient R2 read is covered by the step's retry.
          const resolvedImage = imageKey
            ? await r2KeyToDataUri(this.env, imageKey, userEmail)
            : imageUrl;
          const params = buildGenParams(kind, { modelId, prompt, lyrics, imageUrl: resolvedImage });

          const gateway = await loadGatewayCredentials(this.env, userEmail);
          if (!gateway?.gatewayId) {
            throw new Error(GATEWAY_NOT_CONFIGURED_MSG);
          }
          const aiCtx: AiContext = { env: this.env, gateway };
          const result = await aiRun(aiCtx, modelId, params) as LongRunResult;

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
          // end in .bin when upstream serves application/octet-stream.
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
