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
- `src/zip.ts` — zero-dependency ZIP reader (central-directory parser + `DecompressionStream`) for RAG `.zip` import; each inner file is ingested as its own document via `ingestDocument` in `index.ts`. The import runs durably in `LongRunWorkflow` (`kind: "zip_import"`), one step per file; the client polls `GET /api/import/:id`.
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

The same `LONGRUN` binding serves several workflow kinds (`run()` branches on `event.payload.kind`):
- **`runGen`** (default; `kind` is `"video"`/`"music"`): Unified Billing / BYOK video + music gen.
- **`runZipImport`** (`kind: "zip_import"`): bulk `.zip` RAG import; one step per inner file gives each `ingestDocument` a fresh subrequest budget. No chats row; the client polls `GET /api/import/:id` (reads the instance `status().output`, ownership-checked via the recorded `user_email`).
- **`runCloudAnimate`** (`kind: "cloud_animate"`): animate a render's keyframes via a cloud i2v model, one durable step per shot, assembled by the `video-finish` container into a silent `cloud-<uuid>` row. See `docs/animate-api.md`.
- **`runHybridAnimate`** (`kind: "hybrid_animate"`): GPU+cloud per-shot animation in one film (dual-lane progress, beat-sync trim, continue-on-error). See `docs/i2v-hybrid-backend.md`.

## Wrangler bindings reference

Declared in `wrangler.example.toml` (the committed template; the real `wrangler.toml` is gitignored). Mirror every binding in the `Env` interface (`src/env.ts`). Create the backing resources via the `npm run db:*` scripts and the `npx wrangler ... create` commands in the README.

| Binding | Type | Purpose |
|---|---|---|
| `AI` | `[ai]` | Unified AI binding — Workers AI models directly + Unified Billing partners through AI Gateway. BYOK providers bypass it. |
| `DB` | `[[d1_databases]]` (`skyphusion-llm`) | Chat metadata, conversations, RAG chunk text, projects. Fill in `database_id` after `wrangler d1 create`. |
| `R2` | `[[r2_buckets]]` (`skyphusion-llm`) | All binary artifacts (input + generated output). |
| `R2_RENDERS` | `[[r2_buckets]]` (`vivijure`) | Storyboard/render artifacts (bundles, renders, project-state tarballs) the vivijure-serverless GPU worker reads/writes; the Worker serves them back via `/api/artifact` + `/api/storyboard/*` (v0.39.1). Point it at the same bucket as `R2` if you do not want the split. |
| `VEC` | `[[vectorize]]` (`skyphusion-llm-vec`) | RAG embeddings, 768-dim (`@cf/baai/bge-base-en-v1.5`), cosine. |
| `ASSETS` | `[assets]` (`./public`) | Static frontend served via Workers Assets. |
| `LONGRUN` | `[[workflows]]` (`skyphusion-longrun` / `LongRunWorkflow`) | Durable execution for long-running video/music gen (v0.12.0). |

Also: `[observability] enabled = true` (dashboard log tailing). `compatibility_date` is pinned in the template.

**Secrets** (set with `npx wrangler secret put <NAME>`; not in the template). For local dev, put them in `.dev.vars` (gitignored) instead:

| Secret | Required? | Purpose |
|---|---|---|
| `GATEWAY_ID` | Yes | AI Gateway slug; every `env.AI.run` call passes it. |
| `ANTHROPIC_API_KEY` | BYOK | Anthropic chat. |
| `XAI_API_KEY` | BYOK | xAI chat + Grok Imagine video. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | BYOK | Bedrock (SigV4 via `aws4fetch`). |
| `AWS_REGION` | Optional | Defaults `us-east-1` (Nova). |
| `AWS_REGION_PEGASUS` | Optional | Defaults `us-west-2` (Pegasus only in `us-west-2`/`eu-west-1`). |
| `OPENAI_API_KEY` | Optional | v0.22.1; **image only** — direct call for `gpt-image-1.5` transparent PNG. Without it, that model falls back to opaque via Unified Billing. OpenAI chat does NOT use it. |
| `TAVILY_API_KEY` | Optional | v0.17.0; web-search retrieval. Falls back to Wikipedia-only when unset. |
| `CF_AIG_TOKEN` | Optional | Only if Authenticated Gateway is enabled. |

## Routes reference

All matched in the single `fetch` handler in `src/index.ts` (top-of-file comment lists the core set). Anything not matched falls through to `ASSETS` (static `public/`). Every `/api/*` route is scoped to the caller's `Cf-Access-Authenticated-User-Email`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness probe; no binding access, always 200. |
| GET | `/health/deep` | Deep check: D1, R2, Vectorize, AI Gateway config (50–200ms). |
| GET | `/api/models` | List models with `type` + capability flags; returns caller email. |
| POST | `/api/chat` | Run a model; dispatches by `model.type`. Persists a row. |
| POST | `/api/chat/stream` | SSE variant, only for catalog entries flagged `streaming: true`. |
| GET | `/api/history` | List caller's chats, newest first. |
| GET / DELETE | `/api/history/:id` | One row (with attachments + output) / delete row + its R2 objects. |
| GET | `/api/artifact/*` | Stream an R2 object, gated by `customMetadata.user_email`. |
| GET | `/api/job/:id` | Poll an async video/music job status (reads the chats row). |
| GET | `/api/import/:id` | Poll a durable `.zip` RAG import workflow (reads the `LongRunWorkflow` instance status). |
| GET | `/api/conversations` | List caller's conversations (grouped by `conversation_id`). |
| GET / DELETE | `/api/conversations/:id` | Full transcript / cascade-delete turns + R2 artifacts. |
| PATCH | `/api/conversations/:id/project` | Move conversation to a project or clear it (v0.20.2). |
| GET / POST | `/api/documents` | List RAG docs (`?project_id=N` filter) / upload+chunk+embed. |
| GET / DELETE | `/api/documents/:id` | Metadata + chunk preview / cascade-delete doc, chunks, vectors, R2. |
| GET / POST | `/api/projects` | List projects with doc counts / create project. |
| GET / PATCH / DELETE | `/api/projects/:id` | Get / update name+desc+system_prompt / delete (docs kept). |
| POST / DELETE | `/api/projects/:pid/documents/:did` | Attach / detach a document. |
| POST | `/api/projects/:id/import-discord` | Import a DiscordChatExporter JSON export. |

### Storyboard / Vivijure routes

The Vivijure studio control plane (planner + cast builder) lives in the same `fetch` handler. Full contracts: `docs/render-api.md` (GPU render submit), `docs/animate-api.md` (animate + score), `docs/cast-api.md` (cast/LoRA), `docs/containers.md` (the three CPU containers), plus the design docs `docs/i2v-backend-selector.md` / `docs/i2v-hybrid-backend.md` and the user guide `docs/vivijure-walkthrough.md`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/storyboard/plan` · `/refine` · `/yaml` · `/markers` · `/preflight` | LLM storyboard planning, YAML re-emit, NLE markers, readiness checks. |
| GET / POST | `/api/storyboard/projects` (+ `/:id`, `/:id/storyboard`) | Storyboard project CRUD + snapshot save. |
| POST | `/api/storyboard/audio-upload` · `/character-ref` · `/bundle` | Stage an audio bed / a character ref image / assemble the `.tar.gz` bundle. |
| POST | `/api/audio/analyze` | Beat-sync (librosa) via the `AUDIO_BEAT_SYNC` container. |
| POST | `/api/video/finish` | Concat/crossfade/mux via the `VIDEO_FINISH` container. |
| POST / GET | `/api/storyboard/render` · `/render-from-keyframes` · `/renders` · `/renders/adopt` | Submit a GPU render / render from injected keyframes / list / adopt an external job. |
| GET / DELETE | `/api/storyboard/render/:jobId` (+ `/stream`) | Poll one render (resolves vs RunPod) / cancel / SSE status stream. |
| POST / PATCH / DELETE | `/api/storyboard/renders/:id` (+ `/regen-shot`, `/finalize`, `/retry`) | Per-render edit/delete; per-shot keyframe regen; finalize a preview; retry. |
| POST | `/api/storyboard/renders/:id/animate-cloud` · `/animate-hybrid` | Animate a keyframes-only preview (cloud i2v / GPU+cloud hybrid). Workflow-backed `cloud-<uuid>`. |
| POST | `/api/storyboard/renders/:id/add-audio` · `/add-narration` | Score a finished render off-GPU (music mux / TTS narration). |
| GET / POST / PATCH / DELETE | `/api/cast` (+ `/:id`, `/:id/portrait`, `/:id/refs[/:key]`, `/:id/sources[/:key]`, `/:id/train-lora`, `/:id/lora-status`) | Cast CRUD, portrait/refs/sources staging, GPU LoRA training + poll. |

## Conventions (from CONTRIBUTING.md — enforced)

- **No em-dashes (U+2014) or en-dashes (U+2013) anywhere in source.** Use commas, semicolons, or parentheses.
- **No build step, no framework, no CSS preprocessor.** Vanilla JS/HTML/CSS frontend is deliberate; framework-migration PRs are rejected.
- **Minimal runtime deps.** Only `aws4fetch` (Bedrock SigV4), `unpdf` (PDF RAG), `xlsx` (spreadsheet RAG). New runtime deps need justification.
- **Prefer Unified Billing over BYOK** for new providers (no extra deployer key, native AI Gateway, less code). Add BYOK only when Unified Billing doesn't support the provider or its billing model doesn't fit. BYOK catalog rows use `{ provider, byok_alias }` and label `(BYOK)` in the UI.
- **`wrangler.toml` is gitignored.** All config/binding changes go in `wrangler.example.toml` (the committed template); document new bindings as a copy-paste TOML block in the CHANGELOG entry so existing deployers can apply them by hand.
- After adding a binding, mirror it in the hand-authored `Env` interface (`src/env.ts`). Runtime types come from the pinned `@cloudflare/workers-types` devDep + `src/env.ts`; do not generate `worker-configuration.d.ts` (it is unreferenced here and gitignored).
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
