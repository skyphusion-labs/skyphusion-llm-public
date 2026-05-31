# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A multimodal AI playground deployed as a **single Cloudflare Worker** (no framework, no build step beyond TypeScript). One web UI behind Cloudflare Access exposes chat (38 models / 6 providers), image / TTS / STT / video / music generation, and RAG over PDF/XLSX. The interesting part is the patterns, not the model count: every modality funnels through `env.AI.run()` (the unified AI binding) wrapped by AI Gateway, with BYOK escape hatches for providers Unified Billing doesn't cover.

## Commands

```bash
npm run dev              # wrangler dev (local; no Cloudflare Access, user_email='anonymous')
npm run deploy           # wrangler deploy
npm run typecheck        # tsc --noEmit — CI gate; run before pushing
npm test                 # vitest run (one-shot)
npm run test:watch       # vitest watch
npx vitest run tests/xai-sse.test.ts   # single test file
npm run bootstrap        # copy wrangler.example.toml -> wrangler.toml (first-time setup)
```

D1 schema (see "Schema migrations" caveat before using these):
```bash
npm run db:migrate:remote   # apply schema.sql to remote D1
npm run db:migrate:local    # apply schema.sql to local D1
```

Debugging a deployed worker: `npx wrangler tail`. Inspecting a stuck long-running job: `npx wrangler workflows instances describe skyphusion-longrun <job_id>`.

## Architecture

Everything lives in one Worker `fetch` handler in `src/index.ts` (~3800 LOC). Pure/reusable logic is extracted into modules so `index.ts` is the orchestrator:

- `src/models.ts` — **the model catalog**, single source of truth. Each entry's `id` is the routing key; `type` (`chat`|`image`|`tts`|`video`|`stt`|`music`) picks the dispatcher, `provider` (default `workers-ai`) + `byok_alias` pick the code path, `capabilities`/`streaming` drive the UI. Adding an entry here flows automatically to `GET /api/models` and the frontend picker.
- `src/providers/*.ts` — per-provider dispatch helpers (`callAnthropic`, `callXai`, `callBedrockNova`/`callBedrockPegasus`, `callGemini`, `callWorkersAIStream`, `callOpenAIStream`, `openai-image`). Each transforms the internal `messages` shape into the provider's request format and back. BYOK providers (Anthropic, xAI, Bedrock) call upstream directly; the rest go through `env.AI.run`.
- `src/parsers/*.ts` — streaming adapters, one per wire format (Anthropic native SSE, OpenAI-compatible SSE for xAI/OpenAI, Bedrock `vnd.amazon.eventstream` binary frames, Workers AI SSE, Gemini SSE), all normalized to a common `ProviderStreamEvent` envelope (`parsers/types.ts`). `sse-framer.ts` is the shared line framer. **These are the bulk of the unit tests.**
- `src/ai-binding.ts` — `aiRun()` wraps `env.AI.run` with the gateway opt; `aiLogId()` reads the AI Gateway log ID after a call.
- `src/output-extract.ts` — normalizes wildly different provider response shapes into output text/usage; `detectProviderFailure`, `extractProxiedImageUrl`.
- `src/env.ts` — hand-authored `Env` binding interface (mirror of `wrangler.toml` bindings). `src/types.ts` — the `InputAttachment` discriminated union (request boundary).
- `src/chunking.ts` / `src/discord.ts` — RAG chunking and DiscordChatExporter ingestion.
- `src/longrun-params.ts` / `src/proxied-image-params.ts` — param builders for video/music and proxied image gen.
- `public/` — vanilla JS/CSS/HTML frontend (`app.js`, `streaming-client.js`, `styles.css`, `index.html`), served via Workers Assets. No framework, no build.

### Request dispatch

`handleChat` (`src/index.ts:331`) branches on `model.type` to `runChat`/`runImage`/`runTts`/`runVideo`/`runStt`/`runMusic`. `runChat`/`runChatStream` then branch on `model.provider` to the right helper. Streaming requests hit `POST /api/chat/stream` (`handleChatStream`, only for catalog entries flagged `streaming: true`).

### Storage model

- **D1** (`schema.sql`): `chats` (metadata + R2 keys + multi-turn `conversation_id` + `job_id` for long jobs), `documents`/`chunks` (RAG text), `projects`/`project_documents`/`project_messages`. **No binary ever touches D1** — rows reference R2 keys.
- **R2**: all binary artifacts (input attachments + generated output). Ownership enforced via `customMetadata.user_email` on the object; the worker is the only public surface and streams objects through `GET /api/artifact/*` after an ownership check.
- **Vectorize** (`VEC`): RAG embeddings, 768-dim BGE-base, cosine.

### Auth

Cloudflare Access gates the whole worker URL. The worker trusts `Cf-Access-Authenticated-User-Email` to scope history and artifacts per user. `wrangler dev` has no Access in front — `user_email` falls back to `'anonymous'`. **Never deploy without Access.**

### Long-running jobs (video/music, 30s–3min)

These exceed the ~30s `ctx.waitUntil` budget, so they use **Cloudflare Workflows**. The `LongRunWorkflow` class (bottom of `src/index.ts`) holds the blocking `env.AI.run` call alive across retryable step boundaries; the workflow instance ID is persisted as `chats.job_id`. The one exception is BYOK xAI video, which uses submit-and-poll (`GET /api/job/:id` triggers a fresh invocation per poll). **Workflows do not run under `wrangler dev --remote`** — deploy to test Unified Billing video/music.

## Conventions (from CONTRIBUTING.md — enforced)

- **No em-dashes (U+2014) or en-dashes (U+2013) anywhere in source.** Use commas, semicolons, or parentheses.
- **No build step, no framework, no CSS preprocessor.** Vanilla JS/HTML/CSS frontend is deliberate; framework-migration PRs are rejected.
- **Minimal runtime deps.** Only `aws4fetch` (Bedrock SigV4), `unpdf` (PDF RAG), `xlsx` (spreadsheet RAG). New runtime deps need justification.
- **Prefer Unified Billing over BYOK** for new providers (no extra deployer key, native AI Gateway, less code). Add BYOK only when Unified Billing doesn't support the provider or its billing model doesn't fit. BYOK catalog rows use `{ provider, byok_alias }` and label `(BYOK)` in the UI.
- **`wrangler.toml` is gitignored.** All config/binding changes go in `wrangler.example.toml` (the committed template); document new bindings as a copy-paste TOML block in the CHANGELOG entry so existing deployers can apply them by hand.
- After touching the `Env` interface or adding a binding, run `npx wrangler types` to regenerate `worker-configuration.d.ts`, and mirror the field in `src/env.ts`.
- Adding a Workers AI model: verify the model ID and response shape against `developers.cloudflare.com/workers-ai/models/`.

### Schema migrations

`schema.sql` is for **fresh databases only**. Upgrade an existing DB with the per-version delta files (`migrate-v*.sql`) and the steps documented in the CHANGELOG / README — **never re-run `schema.sql`** against a populated DB.

## Testing

Tests live in `tests/` and run under plain Vitest in a Node environment (`vitest.config.ts`) — **not** `@cloudflare/vitest-pool-workers`. They cover pure functions (SSE/eventstream parsers, chunking, output extraction, param builders, Discord parsing) that use only standard web APIs. There is no Workers-runtime integration test harness; if you add one that hits the fetch handler, you'll need the pool-workers adapter.

## Identity & commits
- Handle/username is `skyphusion` across all services. Default to it when a username is needed.
- One scoped commit per release. Subject = scoped change, body = the why, footer = files touched.

## Release versioning
- SemVer-style `0.MINOR.PATCH` (currently pre-1.0). **PATCH** for fixes, follow-throughs, and backend-only tweaks; **MINOR** for new features (a new model, modality, or capability). Bump `package.json` `version` in the same commit.
- Commit subjects that ship a release end the subject with the version in parens, e.g. `feat(image): transparent PNG ... (v0.22.1)`.
- Every release gets a new top-of-file entry in `CHANGELOG.md`: `## vX.Y.Z` heading, a one-line summary, prose explaining the why, and a `### Code` section listing every file touched (including the `package.json` X -> Y bump) ending with typecheck/test status. New bindings or schema changes are documented as copy-paste blocks in the entry so existing deployers can apply them by hand.
- In-code version references: when a line of code or a comment is tied to a release, tag it `(vX.Y.Z)` so the catalog/config history stays traceable (this is the existing convention throughout `src/`).
