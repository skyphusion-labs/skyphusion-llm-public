# Changelog

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
