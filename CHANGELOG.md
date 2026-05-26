# Changelog

## v0.14.0

**Breaking:** removes OpenAI BYOK and the Gemini chat / Veo 3.1 video BYOK paths to consolidate around Anthropic + xAI + Bedrock BYOK and Unified Billing for everything else. Deployers who used OpenAI or Google BYOK will need to migrate to one of the remaining providers.

- Catalog entries removed (13 total):
  - OpenAI BYOK: `openai/gpt-5.5`, `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/gpt-image-2-2026-04-21`, `openai/gpt-4o-mini-tts-2025-12-15`, `openai/gpt-4o-transcribe`, `openai/gpt-4o-mini-transcribe-2025-12-15`.
  - Google BYOK: `google/gemini-3.5-flash`, `google/gemini-3.1-pro-preview`, `google/gemini-3.1-flash`, `google/gemini-2.5-pro`, `google/veo-3.1`, `google/veo-3.1-fast`.
- Preserved: `google/veo-3` and `google/veo-3-fast` (no `byok_alias`, route through Unified Billing via the `LongRunWorkflow` step pattern; still need CF credits to actually fire).
- Worker code deletions: `callOpenAI`, `imageGenOpenAI`, `ttsOpenAI`, `sttOpenAI`, `callGoogle`, `transformToGoogle`, `GooglePart` / `GoogleContent` interfaces, `submitVideoGoogle`, `pollVideoGoogle`. All BYOK dispatch branches in `runChat`, `runImage`, `runTts`, `runStt`, `runVideo`, and `handleJobPoll` collapsed accordingly. Google fallback removed from both `extractOutput` (candidates[0].content.parts[].text) and `extractUsage` (usageMetadata).
- `Env` interface: `OPENAI_API_KEY` and `GOOGLE_API_KEY` removed.
- `Provider` type union: `"openai"` removed. `"google"` kept for the two veo-3 Unified Billing entries.
- `runChat` `wantsSystemInMessages` simplified from `!(model.provider === "anthropic" || model.provider === "google")` to `model.provider !== "anthropic"`. Anthropic still takes system as a top-level field; everything else gets `role: "system"` in the messages array.
- `runVideo` `isBYOK` simplified to `!!(model.byok_alias && model.provider === "xai")`. Only xAI Grok Imagine Video uses the per-provider BYOK video path now; everything else goes through the Workflow.
- `handleJobPoll` BYOK branch reduced to `row.job_provider === "xai"` (was xai-or-google).
- README, CONTRIBUTING, and `wrangler.example.toml` updated to drop OpenAI / Google BYOK references. The orphaned "Google Gemini models (BYOK)" content that was sitting headerless under the xAI section (likely from an earlier edit losing the `##` header) is also removed.
- Net diff against `src/index.ts`: +26 / -388 lines across 24 hunks.

**Deployer migration (existing v0.13.x deployments):**

After deploying v0.14.0, drop the obsolete secrets so they don't sit unused:

```
npx wrangler secret delete OPENAI_API_KEY
npx wrangler secret delete GOOGLE_API_KEY
```

Neither is fatal if forgotten; they're just inert.

No D1 migration. No R2 migration. Existing rows that reference removed models will still render in history (the row stores the model ID as a string, not a foreign key into the catalog); attempting to continue or retry one of those conversations will fail at submit time with a clear error.

## v0.13.0

Rolls up four patches landed between v0.12.0 and v0.14.0: hot-path latency, SSE streaming Pass 1 (Anthropic), SSE streaming Pass 2 (Workers AI), and the image-gen workarounds for FLUX.2 plus the gateway-incompatible streaming-output models.

**Hot-path latency:**

- `runChat` prelude now overlaps the D1 prior-turns SELECT, the Vectorize RAG retrieve, and the attachment normalization walk. Previously these ran sequentially even though they're independent. Hoisted `priorTurnsPromise` and `retrievePromise` to fire at the top of the function and awaited only at the message-array assembly point.
- Video-frame attachments now upload to R2 in parallel via `Promise.all` instead of an in-order `for await` loop. For an 8-frame video, this collapses ~600ms of sequential PUTs into a single round trip.
- `handleJobPoll` streams the upstream artifact directly into R2 via a new `r2PutStream` helper that pipes `aresp.body` through the bucket without buffering the whole video into memory. Cuts peak memory on a 30MB video gen from ~30MB to a few hundred KB and shaves one full body-read pass off the latency.
- Two try-blocks in `handleJobPoll` collapsed into one (the separation was historical and prevented sharing the streaming pipe).

**SSE streaming (chat models only):**

- New `POST /api/chat/stream` endpoint returns `text/event-stream`. Same request body shape as `POST /api/chat`. Response is a sequence of envelope events emitted via a `TransformStream`:
  - `{ "type": "delta", "text": "..." }` for each token chunk as the model emits it.
  - `{ "type": "done", "row_id": ..., "latency_ms": ..., "tokens_in": ..., "tokens_out": ..., "conversation_id": ..., "turn_index": ... }` once the model finishes. Token counts mirror the non-stream path.
  - `{ "type": "error", "message": "..." }` on upstream failure.
- New optional `streaming: boolean` flag on `ModelEntry`. Frontend can filter the catalog to streamable models for routing; the worker rejects stream requests for non-streaming models with HTTP 501.
- Streaming wired for two providers in this release:
  - **Pass 1 (Anthropic):** all four Claude entries (Opus 4.7 / 4.6, Sonnet 4.6, Haiku 4.5). Uses `callAnthropicStream` async generator that strips Anthropic's native SSE envelope (`message_start`, `content_block_delta`, etc.) and re-emits our flat envelope.
  - **Pass 2 (Workers AI):** 19 `@cf/*` and `@hf/*` chat models flagged streaming. Uses `callWorkersAIStream` which calls `env.AI.run({stream: true})` and reads the returned `ReadableStream` of OpenAI-compatible SSE. The `AnthropicStreamEvent` internal type was renamed to `ProviderStreamEvent` since it now serves both backends.
  - **Pass 3 (xAI Grok) and Pass 4 (Bedrock Nova):** still on the backlog. The `handleChatStream` validator returns 501 with a clear message for those.
- Client disconnect handling: the worker holds an `AbortController` and aborts the upstream fetch when the SSE pipe closes. Partial tokens already buffered are dropped; no D1 row is persisted for an aborted stream. This matches the non-stream path's behavior (no partial rows).
- Reasoning models (`@cf/openai/gpt-oss-120b`, `@cf/openai/gpt-oss-20b`, `@hf/.../qwq-32b`, `@cf/deepseek/deepseek-r1-distill-qwen-32b`) stream `<think>...</think>` blocks as part of the delta text. The frontend can fold these in the UI; the worker passes them through unchanged.
- AI Gateway log ID is null on streaming rows. The gateway does not yet surface `cf-aig-log-id` on SSE responses. Once Cloudflare exposes it, plumbing it through is a one-line change.

**Streaming client module (new file):**

- `public/streaming-client.js`, a vanilla JS module with no dependencies. Exposes `streamChat(body, { onDelta, onDone, onError })` returning a `cancel()` function. Drop-in for any frontend that wants to wire the new endpoint without rewriting its existing chat code path. About 7.6KB. Includes integration notes in the file header.

**Image generation workarounds:**

- FLUX.2 (`@cf/black-forest-labs/flux-2-klein-9b`, `-klein-4b`, `-dev`) requires multipart input to `env.AI.run`. Two errors had been masking this: `AiError 5006: "required properties at '/' are 'multipart'"` from the AI binding, and `"AI Gateway does not support ReadableStreams yet"` when the gateway tried to proxy a stream-shaped input. Fix: build `FormData`, wrap it in `new Response(form)` to extract the boundary-bearing `Content-Type`, then pass `{ multipart: { body, contentType } }` to `env.AI.run`. Detected per-call via `model.id.startsWith("@cf/black-forest-labs/flux-2-")`.
- Streaming-output models (`@cf/leonardo/phoenix-1.0`, `@cf/lykon/dreamshaper-8-lcm`) return a `ReadableStream` of PNG bytes rather than the usual `{ image: base64 }` JSON. The AI Gateway cannot proxy stream-output bodies either. Same fix as FLUX.2 input: bypass the gateway by calling `env.AI.run` directly without the `gateway: { id }` option, then detect the response shape at runtime (`result instanceof ReadableStream` -> drain to `Uint8Array`; else extract `result.image` as base64).
- Five models now bypass the AI Gateway: the three FLUX.2 entries plus phoenix-1.0 and dreamshaper-8-lcm. Cost: `ai_gateway_log_id` is null on rows generated by these. Cloudflare's error text says "yet," so the bypass is expected to be temporary. The other two image models (`@cf/black-forest-labs/flux-1-schnell` and `@cf/leonardo/lucid-origin`) still route through the gateway normally.

**Internal:**

- No D1 migration. No R2 migration. No new worker secrets.
- New worker file: `public/streaming-client.js` (must be served by the Assets binding, which already covers `public/*`).
- Net diff against v0.12.0 across the four patches: roughly +700 / -100 lines. Most of it is the SSE machinery and the FLUX.2 multipart construction.

## v0.12.0

- Unblock Unified Billing video and music generation by migrating from `ctx.waitUntil` to Cloudflare Workflows. Resolves the long-standing `waitUntil` cancellation issue: previously, jobs whose `env.AI.run` call exceeded the ~30-second post-response budget were cancelled mid-flight, leaving D1 rows stuck in `pending`. The new `LongRunWorkflow` class holds the blocking call alive across step boundaries (unlimited wall-clock per step for I/O-bound work) and retries each phase independently.
- Affected providers (now durable): Google Veo 3 / Veo 3 Fast, ByteDance Seedance 2.0 / 2.0 Fast, MiniMax Hailuo 2.3 / 2.3 Fast, RunwayML Gen-4.5, Alibaba HappyHorse 1.0, PixVerse v6 / v5.6, Vidu Q3 Pro / Q3 Turbo, MiniMax Music 2.6. xAI Grok Imagine Video and Google Veo BYOK paths are unchanged (still use the submit-and-poll pattern from v0.10.2, which already works).
- Workflow steps: (1) `invoke-model` calls `env.AI.run` with 1 retry on 30s linear backoff; (2) `download-and-store` fetches the upstream artifact and uploads to R2 in one combined step (Workflows cap step return values at 1 MiB so we can't pass bytes between steps - video files are 5-15MB, music 3-5MB); (3) `finalize-d1` writes status, `output_artifact`, and latency to the chats row.
- D1 `chats.job_id` now stores the Workflow instance ID for Unified Billing jobs (BYOK rows still store the upstream provider's job ID). Useful for cross-referencing with `npx wrangler workflows instances describe skyphusion-longrun <id>`.
**Frontend:**

- Per-turn action buttons: each completed (or failed) assistant message now shows three small icon buttons. **Copy** writes the response text to the clipboard (hidden on pure-artifact turns like image/audio/video without text output). **Edit** restores the model picker, system prompt, and user input to match the historical turn, then focuses the input so the user can tweak before re-running; does NOT auto-submit. **Retry** does the same restore but fires `run()` immediately for one-click resubmit. Attachments from the original turn are not carried forward (multi-turn continuation is text-only across all paths), so retry on an image-bearing chat turn submits text only. Click handler is delegated on `#transcript` since the transcript is re-rendered via `innerHTML` on each turn change. Clipboard write uses `navigator.clipboard.writeText` with an `execCommand` fallback for non-secure contexts.

**Frontend unchanged:**

- The existing `GET /api/job/:id` polling endpoint still works. The workflow updates D1 directly when complete, so the poll endpoint just reads the current state.
- Removed: `generateVideoUnified`, `generateMusicBackground`, `MusicGenResult`, `VideoGenResult` (replaced by inline workflow logic).
- No D1 migration required.

**Config restructuring (deploy-impacting):**

- `wrangler.toml` is now gitignored. The repo ships `wrangler.example.toml` as the committed template; deployer-specific values (D1 `database_id`, worker `name`) live in your local `wrangler.toml` and are no longer overwritten when you pull a new version. Bootstrap a new clone with `npm run bootstrap` (copies the example to a real `wrangler.toml`).
- `GATEWAY_ID` moved out of `[vars]` in the wrangler config and into a worker secret. Set it with `echo "your-gateway-slug" | npx wrangler secret put GATEWAY_ID`. For local development, also add `GATEWAY_ID=your-gateway-slug` to `.dev.vars`.
- New `npm run bootstrap` script idempotently creates `wrangler.toml` from the template.

**wrangler.toml migration for existing deployers (v0.11.x -> v0.12.0):**

Apply these changes to your live `wrangler.toml`. Paste the two new blocks anywhere after the `[assets]` block. Then delete the `[vars]` block (since `GATEWAY_ID` is now a secret), and run the `secret put` command at the end.

```toml
# Add these two blocks to your wrangler.toml:

[[workflows]]
name = "skyphusion-longrun"
binding = "LONGRUN"
class_name = "LongRunWorkflow"

[observability]
enabled = true
```

Then:

```
# Delete the [vars] block from wrangler.toml (it only had GATEWAY_ID).
# Move GATEWAY_ID to a secret:
echo "your-gateway-slug" | npx wrangler secret put GATEWAY_ID

# Add it to .dev.vars too if you do local dev:
echo "GATEWAY_ID=your-gateway-slug" >> .dev.vars

# Regenerate types and deploy:
npx wrangler types
npm run deploy
```

Workflows are not supported on `wrangler dev --remote`, so the Unified Billing video and music paths can only be exercised in deployed mode.

**Known limitations carried into v0.12.0:**

- Per-provider param mapping is still Veo-baseline (`prompt / duration / aspect_ratio / resolution / generate_audio`) for all video models. ByteDance/RunwayML/Alibaba/PixVerse/Vidu may reject or ignore some of those parameters; expect param-shape iteration as each provider is exercised in production. Errors will surface in `chats.job_error` rather than getting silently swallowed.
- Bedrock Nova vision attachments are still text-only (`callBedrockNova` strips image content parts). Frontend gates uploads on the `vision` capability flag so the UI lets users attach images, but the worker drops them silently. Backlog item.

## v0.11.1

- Expand OpenAI BYOK across model types per Conrad's confirmed model list:
  - Image gen: `gpt-image-2-2026-04-21` via `/v1/images/generations` (returns base64 PNG; stored in R2 via the same artifact pipeline as Workers AI image gen).
  - TTS: `gpt-4o-mini-tts-2025-12-15` via `/v1/audio/speech` (returns MP3 bytes; default voice "alloy", configurable later).
  - STT: `gpt-4o-transcribe` and `gpt-4o-mini-transcribe-2025-12-15` via `/v1/audio/transcriptions` (multipart upload using native FormData/Blob).
- Removed `openai/gpt-4.1` from the catalog since Conrad's confirmed list doesn't include it. Chat models remain GPT-5.5, GPT-5.4, GPT-5.4 mini.
- New OpenAI-specific dispatch helpers: `imageGenOpenAI`, `ttsOpenAI`, `sttOpenAI`. Each routes through Cloudflare AI Gateway's OpenAI proxy using the existing `OPENAI_API_KEY` secret.

**Not implemented this turn (deferred for architectural reasons):**

OpenAI Realtime API models (`gpt-realtime-2`, `gpt-realtime-1.5`, `gpt-realtime-mini-2025-12-15`, `gpt-realtime-translate`, `gpt-realtime-whisper`) use WebSocket-based bidirectional audio streaming, not HTTP request/response. A Cloudflare Worker handler cannot hold a persistent duplex stream (same `waitUntil` cancellation problem we hit with video gen). The right architecture is:

1. Worker endpoint mints an ephemeral session token via OpenAI's `/v1/realtime/sessions` server-side.
2. Browser opens WebSocket directly to `wss://api.openai.com/v1/realtime?model=...` using that token.
3. Browser handles full-duplex audio capture (MediaRecorder / WebRTC), playback, and transcript display.

This is a substantial separate feature (~400-500 LOC across worker + frontend + UI). Deferred to a focused future session.

## v0.11.0

- Add OpenAI BYOK chat. Catalog ships GPT-5.5, GPT-5.4, GPT-5.4 mini, GPT-4.1. Routes through Cloudflare AI Gateway's OpenAI proxy. New `OPENAI_API_KEY` worker secret. Standard OpenAI messages-array format, no transform needed.
- Add Amazon Bedrock BYOK chat (Nova family). Catalog ships Nova 2 Lite, Nova 2 Pro, Nova Lite, Nova Pro. All routed through Bedrock's Converse API which normalizes request/response shapes across model families. SigV4 signing handled by `aws4fetch` (compact, designed for Workers runtime; eliminates ~150 LOC of manual crypto signing).
- Add TwelveLabs Pegasus 1.2 on Bedrock (video-Q&A). Different architecture from chat: uses `InvokeModel` (not Converse) with a `{inputPrompt, mediaSource}` body shape. Frontend uploads the full video as a new `video_full` attachment type (not the default frame-extraction used for vision-capable chat models). Limitations: Bedrock InvokeModel has a 25MB request limit (~18MB binary after base64); Pegasus is only available in us-west-2 and eu-west-1; Pegasus is single-shot per call so multi-turn requires re-attaching the video on each follow-up.
- New worker secrets: `OPENAI_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. New optional env vars: `AWS_REGION` (default us-east-1, used for Nova), `AWS_REGION_PEGASUS` (default us-west-2, used for Pegasus calls specifically).
- New dependency: `aws4fetch ^1.0.18`. Run `npm install` after pulling.
- New attachment type `video_full` (raw video upload) for Pegasus. Existing `video_frames` (canvas-extracted JPG frames) unchanged for other vision-capable chat models.
- `extractOutput` and `extractUsage` extended to handle Bedrock's response shape (`output.message.content[].text`) and camelCase token fields (`inputTokens`/`outputTokens`).
- No D1 migration required.

## v0.10.4

- Add project favicon and PWA manifest. The mark is a stylized Greek phi (the first letter of "phusion" in skyphusion) in cyan and magenta on a deep navy rounded square. Ships as `favicon.svg` (vector, used by all modern browsers) with PNG fallbacks at 16/32/180/192/512 for older browsers, iOS, and Android home-screen installs. `manifest.webmanifest` lets the app be installed as a standalone PWA on mobile.
- No worker code changes. Cloudflare Workers Assets binding serves the new `public/*.png`, `public/favicon.svg`, and `public/manifest.webmanifest` files automatically; no wrangler config change needed.

## v0.10.3

- Fix videos downloading as `.bin` instead of `.mp4`. Three compounding causes:
  1. `extFromMime` had no entry for `mp4` (or `mov` / `mkv`), so any video mime fell through to the `"bin"` fallback. R2 keys got `out/<uuid>.bin`, and the browser's `<a download>` used the URL's filename, so saves went to disk as `.bin`.
  2. In the BYOK video poll path, we were trusting the upstream CDN's `Content-Type` header. xAI's CDN can serve MP4 as `application/octet-stream`, which would have failed `extFromMime` even after fix #1. We know contextually it's a video gen result, so the mime is now hardcoded to `video/mp4` in this path.
  3. `handleArtifact` wasn't setting a `Content-Disposition` header, so browsers had no filename hint other than the URL path. Now it sets `Content-Disposition: inline; filename="<r2 key tail>"`.
- Limitation: existing video artifacts already stored in R2 with `.bin` keys won't be retroactively renamed. They'll still download as `.bin`. New videos generated after deploy will save as `.mp4` correctly.

## v0.10.2

- Fix Grok Imagine Video failing for the actual underlying reason. The "not found" error was the *symptom*; the *cause* was Cloudflare Workers' `waitUntil()` having a ~30-second post-response budget, while video generation takes 1-3 minutes. The background poll loop was getting cancelled mid-run, leaving rows stuck in "pending" until the client gave up.
- Refactored BYOK video architecture: submit happens synchronously in `POST /api/chat` (one fast HTTP call), upstream `job_id` persists to D1, then each client poll of `GET /api/job/:id` triggers ONE upstream poll in its own fresh worker invocation. Each invocation has its own ~30s budget, well within reach. When the upstream reports "done", the same invocation downloads the video, uploads to R2, and finalizes D1.
- Also fix Bug 1 from the diagnostic: the v0.10.0 multi-turn refactor neglected to add `conversation_id` to non-chat response shapes (image, TTS, video, music, STT). The frontend was seeing `result.conversation_id === undefined`, stringifying it to "undefined", and fetching `/api/conversations/undefined`. Now all non-chat handlers return `conversation_id` from the persisted row.
- Removed obsolete `generateVideoBYOK` background task function and `BYOK_POLL_INTERVAL_MS` / `BYOK_POLL_MAX_MS` constants. No longer needed.
- Known limitation: Unified Billing video models (bytedance, runwayml, alibaba, pixverse, vidu, etc.) and music gen (`minimax/music-2.6`) still use the old waitUntil-based pattern and are subject to the same cancellation issue. A future Cloudflare Workflows refactor will fix these. BYOK works reliably now; Unified Billing models won't until they're funded AND the architecture is reworked.

## v0.10.1

- Fix Grok Imagine Video failing with "not found": Cloudflare AI Gateway's xAI proxy only supports the OpenAI-compatible chat schema (`/v1/chat/completions`). It doesn't proxy `/v1/videos/generations` or `/v1/videos/:id`, so every video submit returned 404. Now we call `https://api.x.ai` directly for these endpoints, bypassing the gateway. The XAI_API_KEY secret is still used; the workaround means no gateway caching/analytics for video gen specifically, but those features were marginal for 1-3 minute generations.
- The fix requires `XAI_API_KEY` to be set as a worker secret (previously the AI Gateway "Stored Keys" feature could fill it in transparently for chat; with direct calls we need the actual secret).

## v0.10.0

- Multi-turn conversations. Each conversation is a sequence of turns sharing a `conversation_id` and ordered by `turn_index`. Continuing a conversation pulls prior turns from D1 and assembles a `[system, user1, assistant1, user2, assistant2, ..., userN]` message array for the model.
- New schema columns on `chats`: `conversation_id TEXT` and `turn_index INTEGER`. Backfill migration assigns `'legacy-<id>'` and `turn_index = 0` to existing rows so they remain accessible.
- New API endpoints: `GET /api/conversations` (list, summarized), `GET /api/conversations/:id` (all turns of a conversation), `DELETE /api/conversations/:id` (cascade delete of all turns + R2 artifacts).
- Frontend rework: the output area is now a scrolling transcript that renders alternating user / assistant turns instead of a single most-recent response. The sidebar lists conversations (one entry per conversation with first prompt + turn count + last activity) instead of individual chat rows. "+ new" starts a fresh conversation.
- ChatRequest gained optional `conversation_id`. If omitted, the worker generates a UUID and starts a new conversation. If present, the worker continues the existing one (and writes the next turn under it).
- Chat response gained `conversation_id` and `turn_index` so the frontend can track and continue.
- Decisions made for v1: per-turn retrieval (each turn can independently use_docs); text-only history (image/audio/video attachments from prior turns are not re-sent on continuation, only the user's text and the assistant's text reply); mixed-model conversations allowed (switch models between turns freely); no automatic summarization of older turns.
- Required migrations: `ALTER TABLE chats ADD COLUMN conversation_id TEXT`, `ALTER TABLE chats ADD COLUMN turn_index INTEGER`, then `UPDATE chats SET conversation_id = 'legacy-' || id, turn_index = 0 WHERE conversation_id IS NULL`, and `CREATE INDEX IF NOT EXISTS idx_chats_conversation ON chats(conversation_id, turn_index)`.

## v0.9.5

- Added Claude Opus 4.7 (`claude-opus-4-7`) as the top Anthropic entry. Opus 4.7 is Anthropic's flagship as of April 16, 2026, with a 1M-token context window, 128K max output, and adaptive thinking. Existing Opus 4.6, Sonnet 4.6, and Haiku 4.5 entries are preserved. BYOK via the same Anthropic dispatch path; no code or config changes needed beyond the catalog entry.

## v0.9.4

- Fix the actual RAG retrieval bug. Vectorize V2 API expects `returnMetadata` to be a string enum (`'none'` | `'indexed'` | `'all'`), not a boolean. Passing `returnMetadata: false` caused Vectorize to reject every query with `VECTOR_QUERY_ERROR (40026): Failed to parse the request body as JSON: returnMetadata: expected value at line 1 column 28`. The error was silent until v0.9.3 surfaced it. Dropped the option entirely - `'none'` is the default and what we wanted.

## v0.9.3

- Critical fix: `retrieveContext` was silently swallowing errors at every step (embed failure, Vectorize query failure). When anything in the retrieval pipeline threw, the function returned an empty array with no logging and no error surfaced to the user ,  making it look like retrieval just "wasn't finding anything" when in fact it was hard-failing.
- New return shape: `retrieveContext` now returns `{ chunks, error }`. Errors are logged to `console.error`/`console.warn` (visible via `wrangler tail`) and surfaced in the chat response as `retrieval_error` when `use_docs` is on.
- New explicit diagnostic case: when Vectorize returns matches but the D1 join returns nothing, the error message includes the user_email and sample vector_ids so a user_email mismatch (vectors written under one identity, query made under another) is immediately visible.

## v0.9.2

- Fix duplicate-system-prompt bug introduced in Pass 2: when use_docs was on for Anthropic or Google models, the effective system prompt (user prompt + retrieval block) was being sent BOTH as the API's top-level system parameter AND as a system message in the messages array. The transforms concatenate these, so the model saw the same content twice. While not fatal, it may have confused some models into deprioritizing the retrieved context. Now the system role is only added to the messages array for providers that don't accept a separate system parameter (xAI, Workers AI).
- Add `effective_system_prompt` diagnostic field to the chat response when `use_docs` is true. Lets you verify via browser DevTools (Network tab → /api/chat → Response) that the retrieval block reached the worker correctly.

## v0.9.1

- Fix dependency versions in package.json that I made up in v0.9.0
  - `unpdf`: bumped from invalid `^0.13.0` (doesn't exist) to `^1.6.0` (current major); also dropped `{ useSystemFonts: true }` arg to `getDocumentProxy` which is not part of the unpdf wrapper API
  - `xlsx`: switched from `^0.20.3` (npm version is stuck at 0.18.5, SheetJS stopped publishing) to the SheetJS CDN tarball URL `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. This is SheetJS's own recommended install pattern. The package still imports as `xlsx`.

## v0.9.0

- Phase 3A: PDF and XLSX/XLS support for document ingestion
- Added `unpdf` (~500KB) for PDF text extraction; per-page extraction with page numbers stored as chunk metadata. Modern text-extractable PDFs only; scanned/image-only PDFs need OCR (Phase 3B, deferred)
- Added `xlsx` (SheetJS, ~500KB) for XLSX (Office Open XML) and XLS (legacy BIFF binary) support; per-sheet CSV extraction with sheet name stored as chunk metadata
- New `ExtractedChunk` shape carries optional `page` and `sheet` metadata through the ingestion pipeline; `chunkText` now runs per-page or per-sheet so chunks never cross those boundaries
- Source location surfaced everywhere: chunks displayed in the UI show "chunk N · page 7" or "chunk N · sheet \"Q3\""; the system prompt block injected into chat shows "from filename.pdf, page 7"; the new `chunks.page` and `chunks.sheet` columns persist this
- Vectorize metadata also stores page/sheet (alongside the existing user_email/document_id/chunk_index) for any future server-side filtering
- Upload byte cap raised from 5MB to 10MB to accommodate larger PDFs
- **Bundle size note**: with unpdf + xlsx bundled, the worker exceeds the free-tier 1MB compressed limit. Workers paid plan is now required.
- Required migration: `ALTER TABLE chunks ADD COLUMN page INTEGER` and `ALTER TABLE chunks ADD COLUMN sheet TEXT`; also `npm install` to pick up the new dependencies

## v0.8.2

- Fix typecheck failure in `handleDocumentUpload`: Workers' `TextDecoder` types don't accept `{ fatal: false }` as a constructor option. Dropped the explicit option (non-fatal is the default), keeping the existing try/catch for defensive handling.

## v0.8.1

- RAG Pass 2: chat retrieval injection now wired end-to-end
- New `use_docs` flag on `POST /api/chat`; when true, worker embeds the user prompt, queries Vectorize for top-5 chunks, looks up text in D1, and folds them into the effective system prompt
- Effective system prompt threading: combined user-provided prompt + retrieval block, passed through cleanly to all four provider dispatch paths (Anthropic top-level system, Google systemInstruction, xAI / Workers AI system message in messages array)
- Per-user retrieval scoping enforced at the D1 layer (chunks JOIN with `WHERE user_email = ?`), so no Vectorize metadata index is required
- New `retrieved_context` column on `chats` table stores the retrieved chunks as JSON for each turn that used RAG; restored on history reload
- New chat response field `retrieved_chunks`: array of `{ document_id, filename, chunk_index, text, score }` returned alongside the model output
- Frontend: new "use my docs" checkbox in the input bottom row, visible only for chat models when the user has at least one document; checkbox auto-clears when the doc list becomes empty
- Retrieved chunks render above the model output as a collapsible block with filename, chunk index, and similarity score per chunk; persists across history reloads
- Required migration: `ALTER TABLE chats ADD COLUMN retrieved_context TEXT` if upgrading from v0.8.0

## v0.8.0

- RAG Pass 1: document ingestion pipeline (no chat integration yet, that's Pass 2)
- New `Vectorize` binding (`VEC`) with 768-dim index `skyphusion-llm-vec` for embedding storage
- New D1 tables: `documents` (per-doc metadata) and `chunks` (per-chunk text + Vectorize vector_id link)
- New endpoints: `GET /api/documents` (list), `POST /api/documents` (upload + chunk + embed + store), `GET /api/documents/:id` (metadata + chunk preview), `DELETE /api/documents/:id` (cascade-cleanup of Vectorize + D1 + R2)
- Chunking: ~500 chars per chunk with 50-char overlap, breaks preferred at paragraph/newline/sentence boundaries
- Embedding: `@cf/baai/bge-base-en-v1.5` (768-dim, free Workers AI), batched 16 chunks per call
- File support: `.txt`, `.md`, `.markdown` only; 5MB max upload (PDF and other formats deferred to a follow-on)
- Knowledge base scope: per-user (single corpus per user), scoped by Cf-Access-Authenticated-User-Email
- Frontend: new Documents section in sidebar below History with upload button, doc list with chunk count + size + date, per-doc delete with confirmation
- Vectorize cleanup: deleting a document removes all its vector IDs from Vectorize via `deleteByIds`, chunk rows from D1, and the original file from R2
- Setup commands documented in README; requires one-time `npx wrangler vectorize create` and `wrangler d1 execute --file=schema.sql`

## v0.7.5

- Flip workspace layout: output now sits in the middle (1fr, fills available space) and the input pins to the bottom. Controls (model picker, system prompt) stay at the top. Chat-style layout.

## v0.7.4

- Clear the user-input box and refocus it after a successful submit so the next prompt can be typed immediately. Output, attachments, and system prompt all remain visible.

## v0.7.3

- Rename `Image gen` / `Music gen` / `Video gen` group labels to title case (`Image Gen` / `Music Gen` / `Video Gen`) for visual consistency in the model dropdown
- Fix typecheck failure in `runStt`: `PersistedAudioAttachment.filename` is `string | undefined`, so dropped the unnecessary `?? null` fallback

## v0.7.2

- Added speech-to-text (Whisper) as a standalone model type, with 3 variants: `@cf/openai/whisper-large-v3-turbo`, `@cf/openai/whisper`, `@cf/openai/whisper-tiny-en`. Synchronous (no polling); user attaches audio, worker calls Whisper directly, returns transcript as output text.
- Added music generation (`minimax/music-2.6`) using the same fire-and-forget architecture as video gen. User provides a style/mood description and optional lyrics; worker schedules generation via `ctx.waitUntil`, downloads the resulting MP3, stores in R2. Requires Unified Billing (third-party proxied model).
- New `ModelType` variants: `"stt"` and `"music"`.
- Frontend: type-specific affordances for STT (audio attachment required) and music (lyrics field in system_prompt slot). Pending music jobs resume polling on history reload. New emoji icons in history list: musical note for music output, memo for transcripts.

## v0.7.1

- Expanded Workers AI catalog by 10 entries
- Chat additions: `glm-4.7-flash` (Z.AI multilingual), `nemotron-3-120b-a12b` (NVIDIA agentic), `gemma-3-12b-it` (Google vision, 128K context), `granite-4.0-h-micro` (IBM, function calling), `hermes-2-pro-mistral-7b` (function calling specialist), `llama-3.2-1b-instruct` (tiny test model)
- Image additions: `flux-2-klein-9b` (Flux 2 frontier, 9B distilled), `flux-2-klein-4b` (smaller, faster), `flux-2-dev` (multi-reference), `dreamshaper-8-lcm` (fast SD fine-tune)
- Total catalog now 55 models across chat / image / TTS / video (30 / 7 / 3 / 15)

## v0.7.0

- Add text-to-video generation across 15 models from 9 providers, with a dual-route architecture: Cloudflare Unified Billing (via `env.AI.run`) for all 15 models, and BYOK (per-provider AI Gateway endpoints) for the 3 models with documented direct provider APIs
- Providers: Google (Veo 3.1, Veo 3.1 Fast, Veo 3, Veo 3 Fast), ByteDance (Seedance 2.0, Seedance 2.0 Fast), MiniMax (Hailuo 2.3, Hailuo 2.3 Fast), xAI (Grok Imagine Video), RunwayML (Gen-4.5), Alibaba (HappyHorse 1.0), PixVerse (v6, v5.6), Vidu (Q3 Pro, Q3 Turbo)
- BYOK route (works today with existing keys): xAI Grok Imagine Video, Google Veo 3.1, Google Veo 3.1 Fast
- Unified Billing route (requires CF credits): all 15 models, including the 12 CF-partner-only models without public APIs
- Per-model `byok_alias` field in the catalog controls routing; if present, worker uses per-provider endpoints with stored gateway keys or env-var keys; if absent, worker uses `env.AI.run` which requires Unified Billing
- New `model_type: "video"` dispatches to one of two background functions via `ctx.waitUntil`: `generateVideoUnified` (single blocking `env.AI.run` call) or `generateVideoBYOK` (submit + poll loop up to 5 minutes + download)
- Both routes share the same fire-and-forget pattern: write `status='pending'` row, schedule background work, return immediately, frontend polls D1 for state changes
- D1 schema gains `status`, `job_id`, `job_provider`, `job_error`, `job_started_at` columns; old rows default to `status='done'`
- New `GET /api/job/:id` endpoint just reads D1 (cheap polling, no provider calls)
- Frontend polls every 5 seconds while pending, with elapsed-time counter
- Loading a still-pending chat from history resumes polling automatically
- History list shows hourglass for pending jobs, warning icon for failed, film clapboard for completed video output
- `<video controls>` rendering in the output artifact area, with download link

## v0.6.0

- Mobile-responsive layout with breakpoints at 768px and 420px
- Sidebar collapses into a slide-in drawer below 768px; hamburger toggle button fixed at top-left
- Tap backdrop to close drawer; selecting a history item auto-closes it
- Touch-friendly button sizes (44px minimum height where it matters)
- Always-visible delete button on history items in mobile (no hover available on touch)
- 16px input font to prevent iOS focus auto-zoom
- `viewport-fit=cover` and `env(safe-area-inset-*)` padding for notched iPhones
- Workspace padding pulls in on narrow phones (<420px)
- Generated image output capped at 50vh on mobile (was 60vh) so other UI stays visible

## v0.5.0

- Add Google Gemini models (Gemini 3.5 Flash, Gemini 3.1 Pro, Gemini 3.1 Flash, Gemini 2.5 Pro) via BYOK
- New `provider: "google"` dispatch routes to AI Gateway's `google-ai-studio` provider endpoint
- New `transformToGoogle` converts OpenAI-style messages to Google's `contents`/`parts` format, system prompt to top-level `systemInstruction`, image blocks to `inline_data`, assistant role to `model`
- `extractOutput` extended to handle Gemini's `candidates[0].content.parts[].text` shape
- `extractUsage` extended to handle Gemini's `usageMetadata.promptTokenCount` / `candidatesTokenCount`
- Same stored-keys-first auth pattern as Anthropic and xAI: optional `GOOGLE_API_KEY` Worker secret overrides stored keys; absence falls back to whatever's configured at the gateway

## v0.4.1

- Correct Grok model IDs to match the actual xAI catalog: `grok-4.3`, `grok-4.20-multi-agent-0309`, `grok-4.20-0309-reasoning`, `grok-build-0.1`
- Remove the v0.3.0 stub IDs (`grok-4.20`, `grok-4.1-fast`) that didn't resolve at xAI

## v0.4.0

- Provider keys now preferred via AI Gateway dashboard (BYOK Store Keys) rather than Worker secrets
- Worker auth headers are conditional: if `ANTHROPIC_API_KEY` / `XAI_API_KEY` is set, the inline key is sent; if not, the request goes through with no provider auth header and the gateway injects the stored key from Provider Keys configuration
- Added optional `CF_AIG_TOKEN` Worker secret for Authenticated Gateway support (sends `cf-aig-authorization` header when set)
- Removed the hard error when keys are missing; selecting an Anthropic or xAI model with no provider auth configured anywhere now surfaces the upstream provider's 401, which is more informative

## v0.3.0

- Add xAI / Grok models (Grok 4.20, Grok 4.3, Grok 4.1 Fast) via BYOK
- `provider` field on model entries gains `"xai"` value
- xAI dispatch is simpler than Anthropic: OpenAI-compatible wire format, no message transform, standard Bearer token auth
- `max_completion_tokens` used instead of `max_tokens` to support reasoning models (Grok 4.x)
- `XAI_API_KEY` worker secret required to enable xAI models; absence returns a clear error
- README documents the BYOK setup parallel to Anthropic's section

## v0.2.0

- Add Anthropic Claude models (Opus 4.6, Sonnet 4.6, Haiku 4.5) via BYOK
- New `provider` field on model entries dispatches between Workers AI binding and Anthropic direct fetch
- BYOK calls go through the AI Gateway Anthropic provider endpoint, preserving caching/logging/rate-limiting
- Image content blocks transform from OpenAI-style `image_url` to Anthropic-style `image` with base64 source
- `ANTHROPIC_API_KEY` worker secret required to enable Anthropic models; absence returns a clear error

## v0.1.0 (initial public release)

- Single Cloudflare Worker fronting AI Gateway
- 13 chat models, 3 image-generation models, 3 TTS models from the Workers AI catalog
- Multimodal chat input: text, images (vision), audio (Whisper transcription), video (8 client-extracted keyframes)
- D1 for chat history, R2 for input and output binary artifacts
- Cloudflare Access for authentication, per-user history scoping, per-object ownership checks via R2 customMetadata
- Vanilla TypeScript Worker, vanilla JS frontend, no build step beyond tsc
- Enter to send, Shift+Enter for newline
- Optgrouped model dropdown with capability-aware UI re-skin per model type
