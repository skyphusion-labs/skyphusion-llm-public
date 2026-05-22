# Changelog

## v0.9.5

- Added Claude Opus 4.7 (`claude-opus-4-7`) as the top Anthropic entry. Opus 4.7 is Anthropic's flagship as of April 16, 2026, with a 1M-token context window, 128K max output, and adaptive thinking. Existing Opus 4.6, Sonnet 4.6, and Haiku 4.5 entries are preserved. BYOK via the same Anthropic dispatch path; no code or config changes needed beyond the catalog entry.

## v0.9.4

- Fix the actual RAG retrieval bug. Vectorize V2 API expects `returnMetadata` to be a string enum (`'none'` | `'indexed'` | `'all'`), not a boolean. Passing `returnMetadata: false` caused Vectorize to reject every query with `VECTOR_QUERY_ERROR (40026): Failed to parse the request body as JSON: returnMetadata: expected value at line 1 column 28`. The error was silent until v0.9.3 surfaced it. Dropped the option entirely - `'none'` is the default and what we wanted.

## v0.9.3

- Critical fix: `retrieveContext` was silently swallowing errors at every step (embed failure, Vectorize query failure). When anything in the retrieval pipeline threw, the function returned an empty array with no logging and no error surfaced to the user — making it look like retrieval just "wasn't finding anything" when in fact it was hard-failing.
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
