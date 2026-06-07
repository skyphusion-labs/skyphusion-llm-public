# skyphusion-llm-public

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Typecheck](https://github.com/SkyPhusion/skyphusion-llm-public/actions/workflows/typecheck.yml/badge.svg)](https://github.com/SkyPhusion/skyphusion-llm-public/actions/workflows/typecheck.yml)
[![Voice chat](https://img.shields.io/badge/%F0%9F%8E%99%EF%B8%8F_voice_chat-speak_%26_hear_35_chat_models-6d8cff)](#voice-chat)

A multimodal AI playground deployed as a single Cloudflare Worker. 35 chat models across 5 providers, **hands-free voice chat** (talk to any model and hear it reply), image / TTS / STT / video / music generation, cross-model artifact reuse within a conversation (v0.21.7), RAG over files of any type (v0.23.0), projects that scope a knowledge base and system prompt, Discord chat-log ingestion, opt-in web search via Tavily and Wikipedia, SSE streaming on supported chat models, and multi-turn conversations. One web UI behind Cloudflare Access, per-user history, R2 for all binary artifacts.

<p align="center">
  <img src="docs/screenshot-desktop.jpg" alt="Desktop UI: image generation with Nano Banana Pro" width="800"><br><br>
  <img src="docs/screenshot-mobile.jpg" alt="Mobile UI: image generation with Nano Banana Pro" width="280">
</p>

> ### 🎙️ Speak to 35 AI models, and hear all 35 talk back
> Not one voice assistant, **all 35 chat models**, by voice. Pick any model on the
> list, tap the mic, and have a real spoken conversation: your speech is
> transcribed by Deepgram Flux, sent to the model through the normal chat path,
> and the reply is **spoken back** with Aura-2 TTS, hands-free. End to end on
> Cloudflare, no third-party STT/TTS services. Every model on the list, from
> Claude Opus to Llama to Grok to Gemini to GPT, answers out loud, and the
> conversation saves to history like any other chat. See [Voice chat](#voice-chat).

## What this is

A working template for the Cloudflare AI stack. One Worker, no framework, no build step beyond TypeScript. The interesting parts are the patterns, not the model count:

- **Unified `env.AI.run()` binding** drives every modality through one call surface: chat, vision input, image gen, TTS, STT, conversational STT + voice chat (Flux over a WebSocket), video gen (Unified Billing), and music gen.
- **Per-provider dispatch helpers** for Anthropic Claude (Unified Billing), xAI Grok (BYOK), and Gemini, each transforming our internal `messages` shape into the provider's format. OpenAI and Workers AI ride the `env.AI.run` binding directly.
- **SSE streaming** (v0.13.0+) for chat models on all five providers: Anthropic native SSE, Workers AI OpenAI-compatible SSE, xAI OpenAI-compatible SSE, OpenAI proxied (binding-based, v0.21.1), and Gemini (binding-based, v0.21.4).
- **AI Gateway** wraps every call for observability, caching, and rate-limiting.
- **D1** holds chat metadata, multi-turn conversation history, and RAG chunk text. **R2** holds all binary artifacts. **Vectorize** holds RAG embeddings (768-dim BGE-base). The chat row references R2 keys; nothing binary touches D1.
- **Cloudflare Workflows** owns long-running Unified Billing video and music generation (30s to 3min jobs). The `LongRunWorkflow` class holds the blocking `env.AI.run` call alive across step boundaries that `ctx.waitUntil` cannot.
- **Cloudflare Access** gates the entire worker URL. The worker reads `Cf-Access-Authenticated-User-Email` to scope history per user; R2 objects carry `customMetadata.user_email` so cross-user access is impossible even if a UUID is guessed.
- **Client-side video keyframe extraction** sends 8 evenly-spaced frames to vision-capable chat models instead of uploading the full video file.
- **Searchable model picker** (v0.111.0) groups the ~70 catalog entries across 7 modalities with capability badges (vision, stream) inline; type to filter by name.

## Features

**Chat (35 models across 5 providers; 34 of 35 stream-capable):**
- Workers AI: Llama 4 Scout, Llama 3.x family, Qwen3 30B / QwQ 32B / Qwen2.5 Coder 32B, DeepSeek R1, Mistral Small 3.1, Gemma 4 26B / Gemma 3 12B, Granite 4 Micro, Nemotron 3 120B, GLM-4.7 Flash, Hermes 2 Pro, GPT-OSS 120B / 20B, Kimi K2.6, SEA-LION v4 27B, LLaVA 1.5 7B (single-shot vision; the one non-streaming model)
- Anthropic (Unified Billing): Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 4.6, Haiku 4.5 (all streaming)
- xAI BYOK: Grok 4.3, Grok 4.20 (Multi-Agent and Reasoning), Grok Build 0.1 (all streaming as of v0.16.0)
- OpenAI (Unified Billing): GPT-5.5, GPT-5.4, GPT-5.4 mini, o4-mini (streaming as of v0.21.1; needs CF credits)
- Google Gemini (Unified Billing): Gemini 3.1 Pro (streaming as of v0.21.4; needs CF credits)

**Image generation:** Google Nano Banana Pro (Unified Billing), GPT Image 1.5 (OpenAI; transparent PNG with an OpenAI key, opaque otherwise; v0.22.1), Recraft V4 (opaque, art-directed; v0.22.0), FLUX 2 Klein 9B/4B, FLUX 2 Dev, FLUX-1 schnell, Lucid Origin, Phoenix 1.0, Dreamshaper 8 LCM, Stable Diffusion XL. FLUX.2 models accept up to 4 reference images (v0.16.0) for image-to-image generation, downscaled client-side to 512px.

**Video generation:** Google Veo 3.1 / 3.1 Fast / 3 / 3 Fast (Unified Billing), ByteDance Seedance 2.0 / 2.0 Fast, MiniMax Hailuo 2.3 / 2.3 Fast, RunwayML Gen-4.5, Alibaba HappyHorse 1.0 T2V and I2V (image-to-video, v0.21.5), PixVerse v6 / v5.6, Vidu Q3 Pro / Q3 Turbo, xAI Grok Imagine Video. BYOK for xAI, Unified Billing for the rest (durable via Cloudflare Workflows).

**Music generation:** MiniMax Music 2.6 (Unified Billing, durable via Workflows).

**Text-to-speech:** Aura-2 EN / ES, MeloTTS.

**Speech-to-text:** Whisper Large v3 Turbo / Whisper / Whisper Tiny EN and Deepgram Nova-3 (one-shot transcription), plus **Deepgram Flux** conversational/streaming STT with live turn detection over a WebSocket (v0.108.0).

**Voice chat: talk to any model, hear it reply (v0.118.0):** a mic button on any chat model starts a hands-free loop, your speech is transcribed by Flux, each finished turn is sent to the selected model through the normal chat path, and the reply is spoken back via Aura-2 TTS. Works with all 35 chat models, the conversation saves to history like any other, and the whole loop runs on Cloudflare (no third-party STT/TTS). See [Voice chat](#voice-chat).

**RAG (Vectorize):** upload files of any type via the sidebar (v0.23.0), or a `.zip` to import many files at once (v0.25.0, each inner file becomes its own document). PDFs get per-page extraction and spreadsheets (`.xlsx`/`.xls`) per-sheet; every other file is read as UTF-8 text (CSV, JSON, HTML, source code, logs, etc.). Binary formats that don't decode to text (e.g. `.docx`, images) are rejected. The worker chunks, embeds via BGE-base, and stores vectors in Vectorize plus text in D1. Toggle "use my docs" per turn to fold the top-5 nearest chunks into the system prompt before the LLM call.

**Projects and knowledge stores (v0.20.0+):** group documents and conversations under a named project with its own default system prompt and retrieval scope. A document can belong to multiple projects; selecting a project scopes "use my docs" retrieval to just that project's documents and applies the project's system prompt as the default for new chats. Conversations started while a project is active are tagged with it, and any conversation can be moved between projects from the sidebar. See [Projects and knowledge stores](#projects-and-knowledge-stores) below.

**Discord ingestion (v0.20.3+):** import a [DiscordChatExporter](https://github.com/Tyrrrz/DiscordChatExporter) JSON export into a project. The worker parses the export, groups messages into conversation-aware chunks (by author, time gap, and channel), and embeds them into the project's retrieval scope, so you can ask questions across an archived Discord channel's history. Import is a file picker in the project's "manage documents" modal.

**Web search (v0.17.0):** opt-in retrieval source that queries Tavily (general web) and Wikipedia (reference and lore) in parallel. Snippets folded into the system prompt the same way RAG chunks are. Per-turn toggle. Tavily requires `TAVILY_API_KEY`; Wikipedia needs no setup. See [Web search](#web-search) below.

**Streaming (v0.13.0+):** `POST /api/chat/stream` returns SSE for any chat model flagged `streaming: true` in the catalog. Token deltas surface as `{ type: "delta", text: "..." }` events, terminal completion as `{ type: "done", ... }` with token counts and conversation IDs. Client disconnect aborts the upstream model call immediately.

**Multi-turn conversations:** `conversation_id` plus `turn_index` on chat rows. Continuing a conversation pulls prior turns and assembles a full message history for the next call. Mixed-model conversations allowed (start with Llama, continue with Claude). Text-only on continuation; prior images, audio, and video are not re-sent.

**UI (focus-mode redesign, v0.110.0+):** a single centered conversation column with a floating composer; the sidebar (searchable history, projects, documents) is a slide-in overlay; a searchable model picker (type to filter, v0.111.0); a ⚙ popover for the system prompt + retrieval toggles and an account menu in the top bar; a paperclip attach button and a voice-chat mic. Capability-aware mode switching (vision-only attachment types; image-mode re-skins to "negative prompt"; TTS / STT / video / music / voice hide irrelevant inputs), FLUX.2 reference-image attach UI (v0.16.0), per-turn web-search toggle (v0.17.0), per-user replay-able history with attachments and generated artifacts, Enter to send / Shift+Enter for newline. Mobile-optimized (safe-area insets, touch targets, no iOS zoom).

**Vivijure studio (AI music-video pipeline):** the same Worker doubles as the control plane for an AI music-video pipeline, an LLM storyboard planner, a cast builder with auto background removal, audio beat-sync, and bundle assembly, that hands GPU rendering off to a separate RunPod backend. CPU prep and final-cut assembly (rembg, librosa, ffmpeg) run on three Cloudflare Containers. See [Vivijure studio](#vivijure-studio-ai-music-video-pipeline) below.

**Auth:** Cloudflare Access on the worker URL. Per-user history and R2 ownership checks via `Cf-Access-Authenticated-User-Email`. Free up to 50 seats on Zero Trust.

## Vivijure studio (AI music-video pipeline)

Beyond the chat playground, the same Worker hosts **Vivijure studio**, the control
plane for an AI music-video pipeline. (Reachable from the top-bar account menu, or
directly at [`/planner.html`](public/planner.html) and [`/cast.html`](public/cast.html).)
It plans and preps a project here, then hands the GPU-heavy training and rendering
off to a separate RunPod serverless backend.

### Routing

How this control plane, its three Cloudflare Containers, R2, and the GPU backend fit
together. The numbered edges are one render job, start to finish; CPU prep
(background removal, beat detection) happens before the bundle is written, and the
final cut (video-finish) happens after the GPU returns clips.

```mermaid
flowchart TB
    UI["browser<br/>/planner.html · /cast.html"]

    subgraph W["skyphusion-llm-public · control-plane Worker (this repo)"]
        PLAN["storyboard planner (LLM)"]
        CAST["cast / character refs"]
        ASM["bundle assembler"]
        REN["render submit + poll"]
    end

    subgraph CNT["Cloudflare Containers · CPU prep (containers/)"]
        IMG["image-prep<br/>rembg / u2net"]
        BEAT["audio-beat-sync<br/>librosa"]
        VID["video-finish<br/>ffmpeg"]
    end

    R2[("Cloudflare R2<br/>bundles · clips · renders · state")]
    D1[("D1<br/>projects · render history")]
    GPU{{"RunPod · vivijure-serverless<br/>GPU backend"}}

    UI --> CAST
    UI --> PLAN
    CAST -->|"presign R2"| IMG
    PLAN -->|"presign R2"| BEAT
    CAST --> ASM
    PLAN --> ASM
    ASM -->|"1 · write bundle.tar.gz"| R2
    REN -->|"2 · submit job"| GPU
    R2 -->|"3 · pull bundle"| GPU
    GPU -->|"4 · push clips + state"| R2
    GPU -->|"5 · return keys"| REN
    REN -->|"6 · finish"| VID
    VID -->|"7 · final MP4"| R2
    R2 -->|"serve render"| UI
    REN --> D1
```

The flow:

1. **Cast** (`/cast.html`, `POST /api/storyboard/character-ref`) build a cast of
   characters from reference images. Portraits are background-removed automatically
   by the `image-prep` container (below), so the renderer gets a clean subject.
2. **Storyboard planner** (`/planner.html`, `POST /api/storyboard/plan` + `/refine`)
   give a brief and a cast; an LLM (any chat model) plans the film into scenes with
   per-shot prompts, character slots, a shared style prefix, and an act arc. Output
   is a validated `storyboard.yaml`. `/api/storyboard/preflight` checks readiness;
   `/api/storyboard/projects` persists named projects.
3. **Beat sync** (`POST /api/storyboard/audio-upload`, `POST /api/audio/analyze`)
   upload a music bed; the `audio-beat-sync` container runs librosa to detect BPM +
   downbeats and align each shot's timing to the music.
4. **Bundle** (`POST /api/storyboard/bundle`) assemble the storyboard + cleaned cast
   portraits + reference images into a `.tar.gz` project bundle, staged to R2.
5. **Render** (`POST /api/storyboard/render`, `GET /api/storyboard/renders`) submit
   the bundle to the [**vivijure-serverless**](https://github.com/SkyPhusion/vivijure-serverless)
   RunPod GPU endpoint, which trains per-character LoRAs, renders SDXL keyframes plus
   image-to-video, and returns the per-shot clips (plus updated project state) to R2.
   Render history is tracked in D1.
6. **Finish** on render completion the `video-finish` container (ffmpeg) concatenates
   the per-shot clips, crossfades the cuts, and muxes the music bed into the final
   MP4 in R2, so picture finishing and audio muxing stay off the GPU.
7. **Post-render audio** (`POST /api/storyboard/renders/:id/add-audio`,
   `POST /api/storyboard/renders/:id/add-narration`) layer audio onto a *finished*
   render without re-running the GPU: mux an uploaded or generated music bed, or
   synthesize spoken **narration** from text with a TTS voice (Workers AI), then
   mux it on through the same `video-finish` container. Text to speech to a muxed
   MP4, no re-render, no RunPod job. History exposes both as **"add audio"** and
   **"narrate"** buttons on a completed render.

**CPU prep on Cloudflare Containers.** The prep steps that don't need a GPU run as
Cloudflare Containers (`containers/`), so the expensive RunPod GPU worker stays
purely GPU-bound:

- **`image-prep`** (rembg / u2net) removes the background from cast portraits at
  bundle time. The Worker presigns short-lived R2 GET/PUT URLs (SigV4 over Web
  Crypto, `src/r2-presign.ts`) so the container reads + writes R2 directly with no
  binding; the cleaned PNG is content-addressed in R2 and reused across bundles.
- **`audio-beat-sync`** (librosa) detects BPM + downbeats from the uploaded music
  bed so each shot's timing can be aligned to the music (step 3 above).
- **`video-finish`** (ffmpeg) does the final cut off the GPU pod: it concatenates the
  per-shot clips the GPU returns, crossfades the cuts, and muxes the music bed into
  the finished MP4 (step 6 above). Keeping assembly + audio mux here means picture
  finishing never burns GPU minutes.

The two numba-based containers (`image-prep`, `audio-beat-sync`) bake a CPU-portable
numba cache into the image (numba's JIT kernels otherwise compile for ~26-46s on a
cold cache, which blew the container's port-bind window until the cache was pinned
with a whole-second source mtime + a generic CPU target); `video-finish` is a plain
ffmpeg subprocess and needs no such warmup. Each container is fronted by its own
Durable Object.

**Setup.** Vivijure studio needs the RunPod endpoint plus R2 S3 credentials (the
containers reach R2 over the public S3 endpoint):

| Variable | Purpose |
|---|---|
| `RUNPOD_API_KEY` / `RUNPOD_ENDPOINT_ID` | submit + poll render jobs on the vivijure-serverless endpoint |
| `R2_S3_ACCESS_KEY_ID` / `R2_S3_SECRET_ACCESS_KEY` (secrets) | R2 API token (Object R+W) used for presigning |
| `R2_S3_ENDPOINT` / `R2_S3_BUCKET` (vars) | the R2 S3 endpoint + render bucket |

The GPU half (LoRA training + rendering) is a separate RunPod serverless worker,
[`vivijure-serverless`](https://github.com/SkyPhusion/vivijure-serverless); this
repo is only the control plane.

## Stack

- One Worker, TypeScript, no framework
- `env.AI` unified binding routed through Cloudflare AI Gateway
- D1 for chat history rows, multi-turn conversations, and RAG chunk text
- R2 for input and output artifact bytes
- Vectorize for RAG embeddings (768-dim, cosine)
- Cloudflare Workflows for long-running Unified Billing video and music generation
- Static frontend served via Workers Assets
- Cloudflare Access in front for auth

Roughly 7800 LOC TypeScript in `src/index.ts` plus ~9000 LOC across the extracted modules (`src/providers/`, `src/parsers/`, `src/discord.ts`, `chunking.ts`, and friends), plus ~17,000 LOC vanilla JS / CSS / HTML in `public/`, plus schema.sql.

## Quickstart

Prerequisites:

- Cloudflare account with Workers, D1, R2, AI Gateway, and Workers AI enabled
- Node.js 20 or later (CI runs on 22; Node 18 is end-of-life)
- Workers Paid plan if you plan to exceed the free Workers AI tier (10,000 neurons per day across all model usage), and required as of v0.11.0 for the `unpdf` bundle size

```
git clone https://github.com/SkyPhusion/skyphusion-llm-public.git
cd skyphusion-llm-public
npm install
npm run bootstrap
```

`npm run bootstrap` copies `wrangler.example.toml` (the committed template) to `wrangler.toml` (your per-deployer config; gitignored). The committed template gains new bindings across versions; your `wrangler.toml` keeps your deployer-specific IDs across pulls. See [Upgrading across versions](#upgrading-across-versions) below for the convention.

### 1. Create the AI Gateway

Dashboard > AI > AI Gateway > Create Gateway. Name it anything. Copy the slug from the URL after creation. Then set it as a worker secret:

```
echo "your-gateway-slug" | npx wrangler secret put GATEWAY_ID
```

For local development, also add it to `.dev.vars` so `wrangler dev` picks it up:

```
echo "GATEWAY_ID=your-gateway-slug" >> .dev.vars
```

`.dev.vars` is gitignored.

### 2. Create the D1 database

```
npm run db:create
```

Paste the returned `database_id` into `wrangler.toml` at `[[d1_databases]] database_id`. Then apply the schema:

```
npm run db:migrate:remote
npm run db:migrate:local
```

### 3. Create the R2 buckets

```
npx wrangler r2 bucket create skyphusion-llm
npx wrangler r2 bucket create vivijure
```

Both bindings are already in `wrangler.example.toml` (and therefore in your `wrangler.toml` after bootstrap): `R2` (`skyphusion-llm`) holds the chat-side artifacts, and `R2_RENDERS` (`vivijure`) is where the vivijure-serverless GPU worker writes render output that this Worker reads back through `/api/artifact`. If you do not want the split, point both at one bucket: set `R2_RENDERS`'s `bucket_name` to `skyphusion-llm` in your `wrangler.toml` and skip creating `vivijure`.

Recommended: add an object-lifecycle rule that expires the `tmp/` prefix, where ZIP import (v0.26.0) stages archives and extracted files. The import workflow deletes these on the normal path; this rule sweeps any objects leaked by a workflow that errors before cleanup. 1 day is the finest R2 granularity and is plenty (live staged objects last seconds to minutes):

```
npx wrangler r2 bucket lifecycle add skyphusion-llm tmp-staging-cleanup tmp/ --expire-days 1 --force
```

Lifecycle rules are per-bucket account config, not declared in `wrangler.toml`, so this is a one-time setup step per deployment.

### 4. Create the Vectorize index

For RAG over PDFs and spreadsheets:

```
npx wrangler vectorize create skyphusion-llm-vec --dimensions=768 --metric=cosine
```

The `VEC` binding is already in the template. If you don't intend to use RAG, the worker still functions; the binding just goes unused.

### 5. First deploy

```
npm run deploy
```

You will get a `*.workers.dev` URL.

> Note: `wrangler.example.toml` declares a `[[services]]` binding named `EMAIL` that targets a separate `skyphusion-email` Worker ([its own repo](https://github.com/SkyPhusion/skyphusion-email)). Wrangler will not deploy a service binding whose target Worker is not in your account, so this first deploy fails until you either deploy `skyphusion-email` first or comment out the `[[services]]` block in your `wrangler.toml`. The Worker treats `env.EMAIL` as optional at runtime (transactional mail just no-ops without it), so commenting it out is safe.

### 6. Cloudflare Access

Dashboard > Zero Trust > Access > Applications > Add an application > Self-hosted. Application domain is your worker URL. Identity providers: enable at least one (Google, GitHub, One-Time PIN, etc.). Policy: Action Allow, Rules > Emails > include your address and anyone else who should have access.

Cloudflare Zero Trust is free up to 50 seats, so a small team is free.

After this, hitting the worker URL shows the Access login screen. Authenticated requests reach the worker with `Cf-Access-Authenticated-User-Email`, which scopes both history and R2 artifact access per user.

### 7. Optional: web search (Tavily)

For the v0.17.0 web-search feature, set a Tavily API key (free tier: 1000 searches/month):

```
npx wrangler secret put TAVILY_API_KEY
```

Without this, the "search the web" toggle still works but falls back to Wikipedia only. See [Web search](#web-search) below.

### 8. Local development

`wrangler dev` does not run Cloudflare Access. The worker falls back to `user_email = 'anonymous'` for local runs. Do not expose your local dev port to the public internet.

```
npm run dev
```

## Upgrading across versions

`wrangler.toml` is gitignored from v0.12.0 on. The repo ships `wrangler.example.toml` as the canonical template. When you pull a new release, your `wrangler.toml` is untouched, but the example template may have gained new bindings (e.g., v0.12.0 added `[[workflows]]` and `[observability]`). To apply those:

```
diff wrangler.toml wrangler.example.toml
```

Each version that touches `wrangler.example.toml` documents the exact TOML blocks to paste in the corresponding [CHANGELOG.md](CHANGELOG.md) entry under a "wrangler.toml migration" heading. Apply those blocks to your local `wrangler.toml` and redeploy.

For D1 **schema** changes, see [Migrating an existing deployment](#migrating-an-existing-deployment). The short version: `schema.sql` is for fresh databases only; upgrade an existing database with the per-version deltas, never by re-running `schema.sql`.

## Architecture

```
                  Browser (Cloudflare Access login)
                              |
                              v
                  Worker (single fetch handler)
        /        |       |        |       |          \
       AI       D1      R2     Vectorize Workflows  ASSETS
   (Gateway) (metadata)(bytes)  (RAG)   (long jobs) (static)
       |
   +---+---+
   |       |
 Tavily  Wikipedia    (web search, v0.17.0)
```

The worker is the only public surface. R2 is private; the worker streams objects through `GET /api/artifact/*` after verifying ownership via `customMetadata.user_email` on the R2 object.

### Routes

| Method | Path | Purpose |
|---|---|---|
| GET    | `/api/models`             | List available models with capability flags (`streaming`, `vision`, `group`) |
| POST   | `/api/chat`               | Run a model. Dispatches by model type. |
| POST   | `/api/chat/stream`        | SSE streaming variant for chat models flagged `streaming: true` |
| GET/WS | `/api/stt/stream`         | WebSocket for conversational STT (Deepgram Flux via the `SttSession` DO); persists the transcript to history on close |
| POST   | `/api/tts`                | Synthesize text to speech (Aura-2) and stream the audio back (no history row); used by the voice-chat loop |
| GET    | `/api/conversations`      | List the caller's conversations (grouped by `conversation_id`, includes each conversation's `project_id`) |
| GET    | `/api/conversations/:id`  | Full transcript for a conversation |
| DELETE | `/api/conversations/:id`  | Cascade delete of all turns plus R2 artifacts |
| PATCH  | `/api/conversations/:id/project` | Move a conversation to a project, or clear it (`{project_id: number \| null}`) |
| GET    | `/api/history/:id`        | One chat row with full attachment + output references |
| DELETE | `/api/history/:id`        | Delete a single chat row and clean up its R2 objects |
| GET    | `/api/job/:id`            | Poll an async video / music generation job's status |
| GET    | `/api/import/:id`         | Poll a durable `.zip` RAG import workflow's status (v0.26.0) |
| GET    | `/api/documents`          | List uploaded RAG documents (optional `?project_id=N` filter) |
| POST   | `/api/documents`          | Upload, chunk, embed, and store a doc (or a `.zip` to import many at once, v0.25.0) |
| GET    | `/api/documents/:id`      | Document metadata plus first chunks preview |
| DELETE | `/api/documents/:id`      | Cascade delete of doc, chunks, vectors, memberships, and original R2 file |
| GET    | `/api/projects`           | List the caller's projects with document counts |
| POST   | `/api/projects`           | Create a project (`{name, description?, system_prompt?}`) |
| GET    | `/api/projects/:id`       | Project metadata plus its attached documents |
| PATCH  | `/api/projects/:id`       | Update name / description / system prompt |
| DELETE | `/api/projects/:id`       | Delete a project; its documents are kept |
| POST   | `/api/projects/:pid/documents/:did` | Attach a document to a project |
| DELETE | `/api/projects/:pid/documents/:did` | Detach a document from a project |
| POST   | `/api/projects/:id/import-discord` | Import a DiscordChatExporter JSON export into a project |
| GET    | `/api/artifact/*`         | Stream an R2 object, gated by ownership |

### Model types

- `chat`: text generation. Accepts vision attachments on vision-capable models. Audio attachments are transcribed via Whisper. Video attachments are 8 client-extracted keyframes. Text-file attachments (v0.24.0) are inlined into the prompt as a fenced block (any chat model).
- `image`: text-to-image generation. The system prompt field becomes the negative prompt. FLUX.2 models additionally accept up to 4 reference images (v0.16.0). Output is a JPEG/PNG in R2; `openai/gpt-image-1.5` outputs a transparent RGBA PNG when `OPENAI_API_KEY` is set (v0.22.1), opaque otherwise.
- `tts`: text-to-speech. Output is audio (MP3 or model-default container) in R2.
- `stt`: speech-to-text transcription. Input audio, output text.
- `voice`: conversational/streaming STT (Deepgram Flux). A live WebSocket session, not a request/response turn; powers the standalone `/stt.html` panel and the [voice chat](#voice-chat) loop. Special-cased on both routing and UI (the chat path rejects it with a pointer to `/api/stt/stream`).
- `video`: text-to-video generation. Long-running (30s-3min); see "Long-running jobs" below.
- `music`: text-to-music generation. Long-running (30s-90s); see "Long-running jobs" below.

### Long-running jobs

Video and music generation can take 1-3 minutes per call, which exceeds the ~30-second post-response budget that Cloudflare Workers gives to `ctx.waitUntil`. Two architectures handle this:

**BYOK video** (xAI Grok Imagine Video) uses submit-and-poll: the worker submits the job synchronously (one fast HTTP call), persists the upstream job ID, and returns immediately. Each client poll of `/api/job/:id` triggers ONE fresh worker invocation that checks upstream status; when done, that invocation downloads to R2 and finalizes D1.

**Unified Billing video and music** (Veo/Seedance/Hailuo/Gen-4.5/HappyHorse/PixVerse/Vidu/MiniMax Music via Cloudflare credits) uses [Cloudflare Workflows](https://developers.cloudflare.com/workflows/). The `LongRunWorkflow` class (defined at the bottom of `src/index.ts`) holds the blocking `env.AI.run` call alive across step boundaries and retries each phase independently. Workflow instance IDs are stored on the chats row as `job_id` for traceability.

**Bulk ZIP import** (v0.26.0) reuses the same `LongRunWorkflow` binding with `kind: "zip_import"`. The uploaded archive is staged to R2, then the workflow expands it and ingests each inner file in its own step. The win here is different from video/music: it's not about wall-clock time but about subrequest budget. Each file's embedding is several subrequests, so a large archive done in one request could approach the per-invocation limit; one step per file gives each ingest a fresh budget. The client polls `GET /api/import/:id` for the summary. See [RAG ZIP import](#constraints).

The `[[workflows]]` binding in `wrangler.toml` declares this (one binding serves all three kinds; no new binding was needed for ZIP import). Two operational notes:

- Workflows are not supported in `wrangler dev --remote`. Local dev mode is fine; deploy to test the Unified Billing video and music paths and ZIP import.
- To inspect a stuck job: `npx wrangler workflows instances describe skyphusion-longrun <job_id>` shows the per-step status, retry count, and any error messages.
- ZIP import stages archives under the `tmp/` prefix and deletes them in its `cleanup` step. Add an R2 lifecycle rule to sweep any leaks from a failed workflow: `npx wrangler r2 bucket lifecycle add <your-bucket> tmp-staging-cleanup tmp/ --expire-days 1 --force` (see [step 3 of the Quickstart](#3-create-the-r2-bucket)).

## Multimodal handling

**Images.** Native `image_url` content blocks to vision-capable chat models. Downscaled to 1280px max dimension client-side. 4 MB raw cap. FLUX.2 reference images (image-gen, not chat) use a separate 512px max-dim path.

**Audio.** Transcribed via `@cf/openai/whisper-large-v3-turbo` before the model call. Transcript text is prepended to the user message. Raw audio is dropped (not stored). 20 MB cap.

**Video.** Client-side keyframe extraction via HTML5 video + canvas. Eight evenly-spaced frames are pulled at upload time and sent as image content blocks to a vision-capable chat model. The original video file is never uploaded to the worker. This is sampled-frames understanding, not true temporal video reasoning. 100 MB cap on regular video uploads is a browser-side sanity limit.

**Text files (v0.24.0).** Attach any text-based file (yaml, json, csv, source code, logs, markdown, etc.) to a chat turn and its contents are inlined into the prompt as a fenced block for the model to analyze, on any chat model (no vision requirement). The frontend decodes the file to UTF-8 text; the worker rejects bytes that don't decode to usable text (binary formats) and truncates very large files at 200k chars to protect the context window. 2 MB browser-side upload cap. This is distinct from RAG document upload (sidebar): inline attachment puts the whole file in this one turn's context, whereas RAG embeds the file for retrieval across turns.

## Storage and cost

D1 holds metadata and structured JSON pointing to R2 keys. R2 holds binary bytes. Each R2 object carries `customMetadata.user_email` for ownership checks. `DELETE /api/history/:id` cleans up the corresponding R2 objects best-effort.

Workers AI billing is per-token / per-image / per-minute depending on model. Free tier is 10,000 neurons per day across all Workers AI usage. Image generation burns through neurons faster (roughly 1,600 to 6,400 per image). Beyond the free tier, the Workers Paid plan is required at $5/month, with usage at $0.011 per 1,000 neurons.

D1 is roughly $0.75/GB-month for storage. R2 is roughly $0.015/GB-month with no egress fees inside Cloudflare. Free tiers on D1 and R2 cover small personal use indefinitely.

xAI (Grok) models bill against your own xAI account via BYOK. Anthropic (Claude) and the OpenAI / Gemini proxied models bill against your Cloudflare account via Unified Billing. Tavily web search bills against your Tavily account (1000 searches/month free tier). See per-provider sections below.

## Anthropic models (Unified Billing)

The Anthropic entries in the model menu (Claude Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 4.6, Haiku 4.5) run on Cloudflare Unified Billing as of v0.93.0 (they were BYOK before that). The `env.AI.run()` binding doesn't carry Anthropic's native payload shape, so the worker hits the AI Gateway's Anthropic provider endpoint directly with Anthropic-native payloads, but keyless: it sends `cf-aig-authorization: Bearer <CF_AIG_TOKEN>` and no `x-api-key`, so Cloudflare provides the upstream credentials and bills the call. The gateway still wraps it for observability, caching, and rate-limiting.

All five Claude entries support SSE streaming (v0.13.0). Streaming events normalize to the same envelope as Workers AI / xAI / OpenAI streams, so the client doesn't see Anthropic's native event vocabulary.

### Setup

1. Enable Unified Billing for Anthropic on your gateway: Dashboard > AI > AI Gateway > select your gateway > turn on Unified Billing, and confirm a payment method is on the Cloudflare account.
2. Set the gateway token (also covers Authenticated Gateway if enabled):
   ```
   npx wrangler secret put CF_AIG_TOKEN
   ```
   The token must be a Cloudflare API token with AI Gateway Run authorization.
3. Redeploy: `npm run deploy`

`CF_AIG_TOKEN` is required; without it the Anthropic dispatch throws a clear error rather than silently failing auth. There is no `ANTHROPIC_API_KEY` anymore.

Billing: the call bills against your Cloudflare account at Anthropic's per-token rates through Unified Billing. Gateway caching can reduce duplicate-prompt costs.

## xAI / Grok models (BYOK)

Grok 4.3, Grok 4.20 (Multi-Agent and Reasoning variants), and Grok Build 0.1 are routed via BYOK against your own xAI account. This is the one remaining BYOK chat path: store the key in the gateway dashboard (recommended) or set it as an inline Worker secret. xAI is OpenAI-compatible so no message transform is needed.

All four Grok entries support SSE streaming as of v0.16.0. The streaming path requests `stream_options.include_usage: true` so token counts arrive in the final pre-`[DONE]` frame.

### Option A (recommended): Store the key in AI Gateway

1. Get an API key from https://console.x.ai > API Keys > Create API Key
2. Dashboard > AI > AI Gateway > Provider Keys > Add API Key > pick xAI > paste
3. Redeploy

### Option B: Inline secret

```
npx wrangler secret put XAI_API_KEY
npm run deploy
```

The same `CF_AIG_TOKEN` secret applies if your gateway is authenticated.

Note: Grok 4.x are reasoning models and expect `max_completion_tokens` rather than the legacy `max_tokens` field. The worker handles this internally. If you swap in older Grok variants (the grok-3 family was retired May 15, 2026), check xAI's docs for which field they expect.

Billing: xAI charges your account directly. Pricing as of mid-2026: Grok 4.3 and Grok 4.20 variants at $1.25/$2.50 per million input/output tokens, Grok Build 0.1 at $1.00/$2.00. No Cloudflare markup.

## OpenAI models (Unified Billing)

GPT-5.5, GPT-5.4, GPT-5.4 mini, and o4-mini (a reasoning model) are routed through Cloudflare Unified Billing, not BYOK. Unlike the xAI chat provider, there is no OpenAI dispatch helper and no `OPENAI_API_KEY` secret for chat: these models ride the generic `env.AI.run("openai/<model>", { messages })` path, the same call surface as the Workers AI hosted chat models, and Cloudflare handles auth and billing against your CF credits.

This is a deliberate re-introduction. OpenAI chat shipped as BYOK in v0.11.0 and was removed in the v0.14.0 consolidation in favor of Unified Billing. These entries come back on the Unified Billing side of that same decision, so they are not a revert of v0.14.0; the BYOK chat path stays gone.

One narrow BYOK exception exists for image, not chat (v0.22.1): `openai/gpt-image-1.5` can produce transparent PNGs, but the Unified Billing proxy's image schema is strictly `{ prompt, images, quality, size, style }` and rejects `background`/`output_format` (a request with them returns `7003: User Input Error`). Transparency therefore requires a direct call to `api.openai.com`, which does accept those fields. The worker uses an optional `OPENAI_API_KEY` for this single purpose (image only): when set, gpt-image-1.5 goes direct and transparent; when unset, it falls back to the opaque proxy path. See the Image generation section below.

Two current limitations:

- **Streaming (v0.21.1).** SSE works via `callOpenAIStream` (`src/providers/openai.ts`) + `interpretOpenAISSEFrame` (`src/parsers/openai-sse.ts`), the binding-based path shared with Workers AI rather than a direct provider endpoint. The interpreter tolerates both frame shapes the proxy may emit (OpenAI-native `{choices[].delta}` and CF-normalized `{response}`), so it is shape-agnostic. Confirmed live against gpt-5.5, including token-usage on the final frame. `POST /api/chat` (non-streaming) remains available as a fallback.
- **Text in / text out.** `capabilities` is empty, so the attach affordance stays off. Multimodal input through the proxied binding is unverified.

Like all Unified Billing models, these appear in the menu but will fail until you enable Unified Billing in the AI Gateway dashboard and fund it with credits. Output and token-usage parsing is handled by `extractOutput`/`extractUsage` in `src/output-extract.ts`, which cover both the OpenAI chat-completions (`{choices[]}`) and Responses API (`{output[]}`) shapes.

## Google Gemini models (Unified Billing)

Gemini 3.1 Pro (`google/gemini-3.1-pro`) is proxied through Unified Billing. Unlike the OpenAI proxied models, Gemini is **not** OpenAI-shaped through the binding, so it has its own provider module (`src/providers/google.ts`) with a transform in both directions, the same pattern as Anthropic:

- **Request:** the worker's internal OpenAI-style message array is transformed to Gemini's native `{ contents: [{ role, parts: [{ text }] }] }`. Roles map `assistant -> model` (Gemini has no "assistant"), and the system prompt is hoisted out of the turns into `systemInstruction` rather than sent as a `system` turn.
- **Response:** Gemini returns `{ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount, candidatesTokenCount } }`. `extractOutput`/`extractUsage` have branches for both.

Dispatch is unambiguous despite `provider: "google"` also being used for Veo (video) and Nano Banana (image): handlers dispatch on model type first, so a `type: "chat"` Google model only ever reaches `runChat`. Streaming as of v0.21.4 via `callGeminiStream` + `interpretGeminiSSEFrame`, with a dual-mode delta reconciler that handles incremental or cumulative chunks. Text-only (the model is multimodal, but vision input is deferred). Confirmed live against gemini-3.1-pro.

The rest of the Gemini family (`gemini-3-flash`, `gemini-2.5-pro/flash`, the flash-lites) share this exact request/response shape, so they are catalog-only additions on this module once each is spot-checked.

## Video generation (dual-route: Unified Billing + BYOK)

Video models have two possible routes through the AI Gateway:

**Route A: Unified Billing via `env.AI.run`** (binding-based, 15 of 16 models). Cloudflare manages provider auth and bills your CF account directly. Requires opting into Unified Billing in the AI Gateway dashboard and funding it with credits. Per CF docs: BYOK is **not** supported for third-party models called through the AI binding.

**Route B: BYOK via per-provider AI Gateway endpoints** (1 of 16 models). Hits `/grok/v1/videos/*` directly with your stored xAI key. Works today without Unified Billing.

This deployment supports both. The router picks per-model based on a `byok_alias` field in the model catalog. If a model has `byok_alias` set and the provider is `xai`, the worker uses BYOK. Otherwise it uses `env.AI.run`, which will fail with code `2021: Invalid User Credentials` until Unified Billing is enabled.

### Model availability matrix

| Model | Route | Works today | Notes |
|---|---|---|---|
| `xai/grok-imagine-video` | BYOK | yes (with XAI_API_KEY) | $0.05/sec, 8s default |
| `google/veo-3.1`, `veo-3.1-fast`, `veo-3`, `veo-3-fast` | Unified | needs CF credits | route through `env.AI.run` |
| `bytedance/seedance-2.0`, `seedance-2.0-fast` | Unified | needs CF credits | CF partner, no public API |
| `minimax/hailuo-2.3`, `hailuo-2.3-fast` | Unified | needs CF credits | CF partner, no public API |
| `runwayml/gen-4.5` | Unified | needs CF credits | CF partner |
| `alibaba/hh1-t2v` | Unified | needs CF credits | text-to-video |
| `alibaba/hh1-i2v` | Unified | needs CF credits | image-to-video; requires `image_url` (v0.21.5) |
| `pixverse/v6`, `v5.6` | Unified | needs CF credits | CF partner |
| `vidu/q3-pro`, `q3-turbo` | Unified | needs CF credits | CF partner |

The "needs CF credits" entries appear in the menu but will fail until you enable Unified Billing.

### Image-to-video (alibaba/hh1-i2v, v0.21.5; source flows v0.21.6)

`alibaba/hh1-i2v` animates a source image instead of generating from text alone. It's flagged `capabilities: ["image-input"]`, and `runVideo` requires a source image; without one the call 400s before a job is created. The param shape differs from text-to-video (image + integer `duration` + `720P`, no `aspect_ratio`/`generate_audio`), so `buildGenParams` (`src/longrun-params.ts`) selects the i2v shape when an image is present. Output is the same `{state, result:{video}}` envelope as the other video models, so it rides the existing workflow download-to-R2 step. Confirmed live (~100s for a 720P / 5s clip).

Three source flows (v0.21.6), resolved into one of two workflow params:
- **Uploaded attachment** -> stored to R2 (`r2Put`), the key passed through; resolved to a data URI in the workflow.
- **`image_key`** (an existing R2 key, e.g. a prior Nano Banana Pro output) -> same R2-key path. This is the chaining flow.
- **`image_url`** (a fetchable external URL) -> passed straight through.

The upstream accepts base64 `data:` URIs (it re-uploads them to its own object store), so no presigned-URL signer is needed: `r2KeyToDataUri` reads the R2 object and inlines it as a data URI. The resolution happens **inside the workflow step**, not at submit, so the multi-MB base64 never rides the Workflow event payload (~1 MiB cap); only the short key does. `r2KeyToDataUri` enforces the same ownership check as `/api/artifact` (the object's `customMetadata.user_email` must match the requester), so `image_key` can't reference another user's object.

**Cloudflare-side image-to-video pipeline:** generate an image with `google/nano-banana-pro`, take its `output_artifact.key`, and pass it as `image_key` to `alibaba/hh1-i2v`. The image never leaves R2 or becomes a public URL, and both stages bill through the one gateway. Confirmed live end to end.

Known follow-ups: a dimension check (hh1-i2v wants the source >=300x300, aspect 1:2.5 to 2.5:1) would fail fast at submit rather than ~100s into a job; a one-call "animate this artifact" convenience endpoint would skip re-specifying the model.

### Enabling Unified Billing

1. https://dash.cloudflare.com -> AI -> AI Gateway -> your gateway -> Settings
2. Find the Unified Billing section (open beta as of November 2025)
3. Enable it and purchase credits ($20 covers ~40-50 video gens depending on model)
4. No code change required; the existing `env.AI.run` path activates automatically once credits are available

### Architecture

Unified Billing video and music run through Cloudflare Workflows (v0.12.0+). The `LongRunWorkflow` class invokes the model, downloads the artifact, uploads to R2, and finalizes the D1 row across independently-retryable steps. BYOK video (xAI) uses a separate submit-and-poll pattern with no workflow involvement (the upstream xAI API is async-natively).

1. Client POSTs to `/api/chat` with a video model. Worker writes a `status='pending'` row to D1 and returns immediately with `{ id, status: "pending", job_id }`.
2. Background work:
   - **Unified route:** Workflow instance starts; the `LongRunWorkflow` class blocks on `env.AI.run("provider/model", ...)` until the video is ready, then downloads and re-hosts.
   - **BYOK route:** worker submits to `api.x.ai/v1/videos/generations`, persists the upstream job ID, and returns. Each client poll triggers a fresh worker invocation that checks upstream status.
3. When complete, the worker (Unified) or job-poll handler (BYOK) uploads video bytes to your R2 bucket and updates the D1 row to `status='done'`.
4. Client polls `GET /api/job/:id` every 5 seconds. For Unified, this endpoint reads D1 only (no provider calls). For BYOK, each poll triggers an upstream status check.
5. Frontend renders `<video controls>` pointing at `/api/artifact/:key` once `status='done'`.

If the job fails at any stage, the row gets `status='failed'` with a descriptive `job_error`. The history list shows a warning icon and the chat detail view shows the error message.

### Defaults

The worker submits with `duration: 8s`, `aspect_ratio: "16:9"`, `resolution: "720p"`, `generate_audio: true` for the Unified route. The BYOK route uses the xAI-specific param shape (`duration: 8` integer). Per-model parameter customization is a backlog item; param-shape iteration for individual partners as each is exercised in production.

### Cost discipline

Video gen is the most expensive feature in this playground.

- The worker has no per-user rate limiting. If you make the URL public, add rate limits at the AI Gateway level.
- Each generation creates an R2 object (~5-30MB per 8s clip). Use `DELETE /api/history/:id` or `DELETE /api/conversations/:id` to clean up.
- BYOK route prices: xAI Grok Imagine Video $0.05/sec ($0.40 per 8s clip).
- Unified Billing prices: visible at https://dash.cloudflare.com under AI > Models > [model] > Pricing. CF marks up upstream provider costs.

### Image-to-video (BYOK only)

The xAI BYOK route exposes an `image_input` parameter for image-to-video on supported models. The UI does not yet expose this in the standard composer; you can wire it in via the worker request body manually if needed. The Alibaba HH1 model is image-to-video only and requires an input image; selecting it without one will fail.

## Speech-to-text (Whisper, standalone)

Attach an audio file, pick a Whisper model, click Run. The worker calls Whisper directly via `env.AI.run` (no async; Whisper completes in seconds) and stores the transcript as the chat's `output` text. The audio's bytes are not persisted; only the transcript is kept on the row's attachment record, same convention as the chat-path audio attachments.

Four one-shot models are exposed:
- `@cf/openai/whisper-large-v3-turbo` (default; best quality, multilingual)
- `@cf/openai/whisper` (general purpose, slightly older)
- `@cf/openai/whisper-tiny-en` (fast, English-only, beta)
- `@cf/deepgram/nova-3` (Deepgram Nova-3; accurate)

All four are hosted on Workers AI (no Unified Billing needed).

## Voice chat

Talk to any of the 35 chat models and hear it talk back, hands-free. This is one
of the headline features: a full **speech in, speech out** loop over any text
model on the list, running entirely on Cloudflare with no third-party STT/TTS.

**Use it:** select a chat model, click the mic button in the composer (it only
appears for chat models), and start talking. When you finish a thought, the model
answers in the transcript and the answer is spoken aloud. Then it resumes
listening. The mic pulses while live; click it again to stop. A status line shows
the state (listening / thinking / speaking). The conversation is saved to history
exactly like a typed chat, so you can scroll back or continue it by text later.

**How it works:**
- **STT (Deepgram Flux).** `@cf/deepgram/flux` is a WebSocket-only conversational
  STT model with built-in turn detection. The browser opens a WebSocket to
  `/api/stt/stream`, which the worker forwards to a per-session **`SttSession`
  Durable Object**. The DO opens the upstream Flux socket via
  `env.AI.run("@cf/deepgram/flux", { ... }, { websocket: true })` and bridges
  audio up (linear16 PCM @ 16 kHz) and turn events down. It accepts the browser
  socket with the **Hibernation API** and persists the final transcript to D1 on
  close (a plain Worker has no reliable post-101 hook to write history).
- **The loop.** On each `EndOfTurn` event, the client sends the utterance to the
  selected chat model through the normal send path (full conversation context,
  RAG, projects, web search all apply), then POSTs the reply to **`/api/tts`**,
  which synthesizes it with **Aura-2** and streams the audio straight back (no
  history row, since the loop speaks every reply). The mic is muted while the
  model is thinking/speaking so it does not transcribe its own voice.

**No setup:** both Flux and Aura-2 are Workers AI models on the `env.AI` binding,
so voice chat needs no extra keys or services beyond the base deploy.

A standalone transcription-only panel lives at `/stt.html` (same Flux engine,
saves transcripts to history). Conversational/voice models are surfaced as a
`type: "voice"` catalog entry, special-cased on both the routing and UI sides
(they are a live session, not a request/response turn).

## Music generation (MiniMax Music 2.6)

Same Workflow-based architecture as Unified Billing video gen, single model in the catalog: `minimax/music-2.6`. Generates full songs with vocals from a style/mood prompt and optional lyrics, or instrumental tracks. Output is an MP3 stored in R2.

Input fields:
- `user_input` -> `prompt` (style/mood/genre, ~10-300 chars). Example: `"Indie folk, melancholic, introspective, longing, solitary walk, coffee shop"`
- `system_prompt` -> `lyrics` (optional, ~10-3000 chars). Supports structure tags: `[Intro]`, `[Verse]`, `[Chorus]`, `[Bridge]`, `[Outro]`

This is a Cloudflare-proxied (third-party) model, so it requires Unified Billing on the gateway. It will fail with the same `2021: Invalid User Credentials` error as the other 14 Unified-Billing video models until credits are funded.

## Image generation

Eleven models in the catalog: Google Nano Banana Pro and OpenAI GPT Image 1.5, plus Recraft V4, FLUX 2 Klein 9B/4B, FLUX 2 Dev, FLUX-1 schnell, Lucid Origin, Phoenix 1.0, Dreamshaper 8 LCM, Stable Diffusion XL. The eight FLUX/Leonardo/Lykon/Stability models run through Workers AI (no BYOK or Unified Billing required); Nano Banana Pro and Recraft V4 are proxied partner models on Unified Billing (need CF credits); GPT Image 1.5 is Unified Billing for opaque output and OpenAI BYOK for transparent output (see below).

### Google Nano Banana Pro (Unified Billing, v0.21.2)

`google/nano-banana-pro` is Google's higher-quality image model, proxied through Unified Billing rather than hosted on Workers AI. Its schema differs from the `@cf` models, so `runImage` has a dedicated `provider: "google"` branch (verified against the CF model page):

- **Input** is `{ prompt, output_format }` with `additionalProperties: false`. The `@cf` shape (`width`/`height`/`steps`/`negative_prompt`) is rejected, so `system_prompt` (which maps to `negative_prompt` for `@cf` models) is unused here.
- **Output** is a URL, not base64, in the same `{ state, result }` envelope as video/music: `{ state: "Completed", result: { image: "<url>" } }`. The worker fetches the URL and stores the bytes in R2.
- First pass is **text-to-image only**. The schema's `image_input[]` (up to 3 reference images for editing) is a later add, mirroring the FLUX.2 reference-image work.
- Generation is synchronous and observed around 20s. If a busier moment or a higher resolution pushes it past the worker's wall-clock budget, the fallback is to route it through `LongRunWorkflow` like video gen. `ai_gateway_log_id` stays null on the persisted row (the proxied response carries routing info in `gatewayMetadata` instead).

### Proxied image models and transparent PNG (v0.22.0, v0.22.1)

`runImage` routes every model with a `provider` field (Nano Banana, GPT Image 1.5, Recraft V4) through one proxied path; the `@cf` models have no `provider` and take the Workers AI path. Per-model request shape comes from `buildProxiedImageParams` (`src/proxied-image-params.ts`), because each proxied schema is `additionalProperties: false` and rejects the `@cf` `{ width, height, steps, negative_prompt }` shape.

- **Recraft V4** (`recraft/recraftv4`, Unified Billing) is opaque and art-directed (strong composition and text rendering). The CF proxy exposes no alpha control, only an opaque `background_color`, so this is not a transparency model. It returns WebP; the worker stores it with the response content-type, so no format is hardcoded.

- **GPT Image 1.5** (`openai/gpt-image-1.5`) is the transparent-PNG path, with a wrinkle: the Unified Billing proxy 7003-rejects `background`/`output_format`, so transparency is impossible through it. The worker therefore uses a BYOK direct call to `api.openai.com/v1/images/generations` (`src/providers/openai-image.ts`) with `background: "transparent"` + `output_format: "png"` when `OPENAI_API_KEY` is set; GPT image models always return base64 (`data[0].b64_json`, no URL), which the worker decodes and stores as `image/png`. Without the key, gpt-image-1.5 falls back to the opaque proxy path. The BYOK call bypasses the AI Gateway, so `ai_gateway_log_id` stays null on the persisted row (a quick way to tell which path ran).

To enable transparent assets:

```
npx wrangler secret put OPENAI_API_KEY
```

Then redeploy. Billing for transparent generations is on your OpenAI account (BYOK), not CF credits.

**Verifying transparency.** Do not check by re-uploading the image into a chat client; many clients flatten alpha onto a background and re-encode to JPEG, which falsely looks opaque. Check the stored or served bytes directly:

```
npx wrangler r2 object get <bucket>/out/<id>.png --remote --file /tmp/raw.png
file /tmp/raw.png   # expect: PNG image data ... RGBA
python3 -c "from PIL import Image; im=Image.open('/tmp/raw.png'); print(im.mode, im.getchannel('A').getextrema() if im.mode=='RGBA' else 'no alpha')"
```

Want `RGBA` with alpha extrema spanning `(0, 255)`. On a free Cloudflare plan there is no Polish/Mirage/image-resizing, so delivery does not transform the PNG.

GIF is intentionally out of scope: PNG carries an 8-bit alpha channel (the standard sprite format), GIF transparency is 1-bit, and no model emits GIF.

### FLUX.2 reference images (v0.16.0)

The three FLUX-2 models (Klein 9B, Klein 4B, Dev) accept up to 4 reference images for image-to-image generation. When you select a FLUX-2 model in the image-gen UI, an attach row appears alongside the prompt and negative-prompt fields. Pick up to 4 images; each is downscaled client-side to 512px max dimension (per the model spec) and sent as `input_image_0` through `input_image_3` multipart form fields.

FLUX-1 schnell, Lucid Origin, Phoenix 1.0, and Dreamshaper 8 LCM are text-to-image only; no reference image input.

### Gateway routing quirks

As of 2026-Q1, three Workers AI image-gen models have transport-layer incompatibilities with the AI Gateway:

- **FLUX-2 family** requires multipart-form input. Gateway can't proxy stream input.
- **Phoenix 1.0** and **Dreamshaper 8 LCM** return ReadableStream output. Gateway can't proxy stream output.

The worker detects these models and bypasses the gateway, calling `env.AI.run` directly. Cost: no AI Gateway observability/caching for these specific models (the persisted row's `ai_gateway_log_id` stays null). FLUX-1 schnell and Lucid Origin work through the gateway normally.

## Retrieval-Augmented Generation

Upload a file of any type via the sidebar (v0.23.0); the worker chunks it (~500 chars with 50-char overlap), embeds each chunk via `@cf/baai/bge-base-en-v1.5` (768-dim, free Workers AI), and upserts to a Vectorize index. Chunks are also stored in D1 keyed by their Vectorize vector_id so retrieval can look up source text from a vector hit.

### Using docs in a chat

Pick any chat model, check the "use my docs" box that appears next to the run button (only visible when you have at least one document uploaded), and hit Run. The worker embeds your prompt, queries Vectorize for the top 5 nearest chunks, looks up their text in D1, and folds them into the system prompt before calling the LLM.

The retrieved chunks appear above the model's response with filename, chunk index, and similarity score, so you can see exactly what context was used. Click the score row to expand the chunk's full text. The retrieved context is persisted with the chat row, so reloading from history shows the same chunks.

### Setup (one-time, before deploying for the first time)

```
# Create the Vectorize index (768 dimensions for BGE-base, cosine similarity)
npx wrangler vectorize create skyphusion-llm-vec --dimensions=768 --metric=cosine

# Apply the full schema to a FRESH database. schema.sql is the canonical
# full schema for new deployments. Do NOT re-run it against a database that
# already has tables: it contains non-idempotent ALTER statements that abort
# the whole transaction on re-run. For an existing deployment, use the
# per-release delta files instead (see "Migrating an existing deployment").
npx wrangler d1 execute skyphusion-llm --remote --file=schema.sql
```

### Constraints

- **File types**: any file (v0.23.0). PDFs are extracted per page and spreadsheets (`.xlsx`/`.xls`) per sheet; every other file is read as UTF-8 text, which covers `.txt`/`.md` plus CSV, JSON, HTML, XML, source code, logs, config, and so on. Files whose bytes don't decode to usable text (binary formats like `.docx`, images) are rejected with a clear message rather than embedded as garbage. Scanned/image-only PDFs are still unsupported (they need OCR, deferred); modern PDFs created from Word/Pages/LaTeX/Google Docs export work fine.
- **ZIP import** (v0.25.0; durable via Workflows in v0.26.0): upload a `.zip` and the worker expands it, ingesting each inner file as its own document (using the in-zip path as the filename). Decompression is zero-dependency (a hand-rolled central-directory parser plus the Workers-native `DecompressionStream`); stored and deflate entries are supported, encrypted/zip64/other-method entries are skipped. Guards: 10 MB compressed cap (shared with regular uploads), and on expansion max 200 files, 50 MB total uncompressed, 10 MB per inner file. Unreadable inner files are skipped with a reason and reported, not fatal. As of v0.26.0 the import runs in a `LongRunWorkflow` (one step per file, each with a fresh subrequest budget), so large archives import without hitting the Worker per-invocation subrequest limit; the upload returns a `job_id` and the client polls `GET /api/import/:id`.
- **Max file size**: 10MB per upload.
- **Knowledge base**: per-user (scoped by `Cf-Access-Authenticated-User-Email`). By default all your uploaded docs are one corpus; selecting a project narrows retrieval to that project's documents (see [Projects and knowledge stores](#projects-and-knowledge-stores)).
- **Retrieval default**: top-K = 5 chunks. Change `RETRIEVE_TOP_K` in the worker if you want more or fewer.
- **Chunks store the raw text in D1**. R2 keeps the original file too for audit and potential re-processing on a future model swap.
- **Chunking boundaries**: For PDFs, chunks never cross page boundaries (so the "page X" metadata stays meaningful). For XLSX/XLS, chunks never cross sheet boundaries. For TXT/MD, no such boundary; chunks flow freely.
- **Source location**: Retrieved chunks show their page (PDFs) or sheet name (spreadsheets) in the UI, and that location is also included in the system prompt the model sees.
- **Deleting a document** cleans up: vector IDs in Vectorize, chunk rows in D1, the document row in D1, and the original file in R2.
- **Worker bundle size**: with `unpdf` (~500KB) and `xlsx` (~500KB) bundled, the compressed worker exceeds the free-tier 1MB limit. **Workers Paid plan ($5/month) is required as of v0.11.0.**

**Note on the xlsx dependency:** SheetJS stopped publishing to the npm registry several years ago; the `xlsx` name on npm is permanently stuck at 0.18.5. We install directly from SheetJS's CDN tarball URL (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`), which gives us the current maintained version. The package still imports as `xlsx` so the code is unchanged. To upgrade, change the URL in `package.json` to point at the new version's tarball.

## Cross-model artifact reuse (v0.21.7)

A model can use what a previous model generated in the same conversation, without download/re-upload. Generate an image with `google/nano-banana-pro`, then switch to `alibaba/hh1-i2v` and the image is already the source; switch to a vision chat model and ask about it; switch to a FLUX.2 model and use it as a reference.

The mechanism is **attachment-by-reference**. An image or full-video attachment may carry an R2 `key` (an artifact already produced in the conversation) instead of inline `data`. `resolveAttachmentKeys` hydrates the key to data once, at the request dispatch boundary, before routing, via `r2KeyToDataUri`, so every consumer (vision chat, FLUX.2 reference, image-to-video) works unchanged. Ownership is enforced: the object's `customMetadata.user_email` must match the requester, so a client can't reference another user's artifact.

The frontend carries the most recent conversation image forward automatically when you switch to an image-consuming model (unless you attached your own). Image-to-video receives it via the `image_key` field; vision chat and FLUX.2 receive it as an attachment-by-key. Video-as-input carry-forward is supported on the backend but not yet auto-wired in the UI.

## Projects and knowledge stores

Projects (v0.20.0+) group documents and conversations under a named context with its own default system prompt and retrieval scope. The intended use is to separate organizational contexts: a legal-research project bundles case PDFs with a paralegal system prompt; a worldbuilding project bundles fiction notes and an in-character collaborator prompt. The same document can live in multiple projects.

**Creating and using a project.** The sidebar has a Projects section above Documents. Create a project (name, optional description, optional system prompt); it becomes active and shows as a chip next to the model picker. While a project is active:

- "use my docs" retrieval is scoped to just that project's attached documents, instead of your whole corpus.
- The project's system prompt becomes the default for new chats. A per-turn system prompt still overrides it; an empty per-turn prompt falls back to the project's.
- New conversations are tagged with the project. The sidebar shows a project chip on each tagged conversation, and any conversation can be moved between projects (or out of any project) via the move control on its row.

Click the active project's chip `x`, or click the active project again in the sidebar, to deactivate (back to full-corpus retrieval and no default prompt).

**Attaching documents.** The "docs" action on a project row opens a modal with a checkbox per uploaded document; checking attaches, unchecking detaches. Changes apply immediately. Deleting a project keeps its documents (they may belong to other projects); deleting a document removes it from every project.

**Scoping internals.** Retrieval with a project active over-fetches from Vectorize (3x top-K), then filters to the project's documents in D1 and caps at top-K, so a project with few matching documents still returns relevant chunks. All project data is per-user; cross-user reads return 404, cross-user writes are rejected.

### Discord ingestion (v0.20.3+)

Import an archived Discord channel into a project from a [DiscordChatExporter](https://github.com/Tyrrrz/DiscordChatExporter) (DCE) JSON export.

**Exporting from Discord.** Use DCE's JSON format, and do **not** disable markdown processing (export *without* `--markdown false`). Markdown processing is what unwraps mentions to readable `@username` and custom emoji to `:name:`; leaving the raw `<@1234>` tokens in makes the text worse for retrieval. A single low-traffic channel or a date-bounded export keeps the file under the 10MB upload cap. CLI example:

```
DiscordChatExporter.Cli export -t <TOKEN> -c <CHANNEL_ID> -f Json \
  --after 2024-01-01 --before 2024-02-01 -o export.json
```

**Importing.** Open a project's "docs" modal; the "import a Discord export" section has a file picker and an "include bot messages" toggle (on by default; turn off if a dicebot or similar floods the channel). The export is parsed, chunked, embedded, and attached to the project as a document.

**How it's chunked.** Instead of the fixed-window splitter used for documents, Discord messages are grouped into conversation units: consecutive messages in the same channel within a time gap (default 15 minutes) form one unit, formatted as a readable transcript with a channel header and `Author (timestamp): text` lines. Units larger than the target size split on message boundaries with the header repeated. Each chunk records its channel, author set, and time range (the `channel`, `authors`, `sent_at_start`, `sent_at_end` columns on `chunks`), which v0.20.5 retrieval filters will use.

**What's kept and dropped.** Default and reply messages with text content are kept. System notifications (joins, pins, thread-created, calls) and empty-content messages (attachment-only) are dropped. Raw parsed messages are also stored in the `project_messages` table so the corpus can be re-chunked later (e.g. with an improved chunker) without re-uploading the export.

**Limits.** Exports over the 10MB worker request limit are not yet supported; split by date range or channel for now (presigned upload for large exports is planned for v0.20.6). The parser validates the export shape and rejects non-DCE JSON with a diagnostic error rather than producing garbage.

## Web search

An opt-in retrieval source (v0.17.0) that queries the web at request time and folds the snippets into the system prompt. Runs in parallel with RAG, so a single turn can pull from both your uploaded docs and the web. Designed for creative work, worldbuilding, and "what's current" questions where you want your model to do the synthesis rather than a search engine's pre-summary.

### How it works

When you check the "search the web" toggle next to the run button (chat models only), the worker fires two parallel queries on each turn:

1. **Tavily** for general web results. Cleaned snippets, no full-page fetches. Requires `TAVILY_API_KEY`; without it, this source is silently skipped.
2. **Wikipedia** for reference and lore. No API key needed. Returns titles + HTML-stripped snippets via the public MediaWiki search endpoint.

Both have an 8-second per-source timeout. If one fails or times out, the other still returns its hits. Results are persisted in the same `retrieved_context` column alongside any RAG chunks from the same turn, with a `source_type` discriminator so the UI can render web results (title + clickable URL + snippet) distinctly from doc chunks.

Per-turn opt-in: the toggle is not sticky across turns. Each turn decides independently whether to search. Web search and RAG can be on simultaneously; the model sees both in the system prompt.

### Setup

Optional Tavily key (skip if you only want Wikipedia):

1. Sign up at https://tavily.com and create an API key. Free tier is 1000 searches per month.
2. Load it as a Worker secret:
   ```
   npx wrangler secret put TAVILY_API_KEY
   ```
3. Redeploy.

No D1 migration. No new bindings. Wikipedia works with no setup at all.

### Caveats worth knowing

- **Token budget.** Each turn with web search on adds roughly 1500-3000 tokens to the system prompt (Tavily defaults to 5 snippets, Wikipedia to 3). Long campaigns or document-heavy RAG turns may push against your model's context window.
- **Tavily costs.** After the free tier, Tavily is ~$0.005 per search. Auto-search-every-turn would be wasteful; the per-turn toggle is intentional.
- **No fact-checking.** Web snippets are supplementary context, not authoritative. The system prompt tells the model so. Verify anything that matters before quoting it.
- **Wikipedia User-Agent.** The worker identifies itself per Wikimedia's policy. If you fork to a different repo name, update the UA string in `searchWikipedia` so you're not lumped in with anonymous scrapers.

### When it shines

- **Worldbuilding lore**: "Norse trickster mythology," "Edo period yokai," "Welsh place name etymology." Wikipedia alone covers most of this.
- **Current events**: who holds an office, what just happened in the news.
- **Mixed RAG + web**: your campaign uses a setting bible (uploaded as a doc) plus real-world historical detail. Toggle both; the model sees both context blocks.
- **Niche reference**: "17th-century apothecary daily routine," "Victorian funeral customs," anything where you want flavor without writing it yourself.

### When to leave it off

- Timeless concepts (math, physics, philosophy). Adds latency and noise.
- Anything already covered by your RAG corpus where the model just needs to synthesize across it.
- Pure prose work (rewriting, formatting, translation) where retrieval isn't relevant.

If your use case is the legal-research pattern (citation accuracy matters, sources need to be verifiable in court), this is the wrong tool. Curated periodic ingest into Vectorize is the right shape for that, not query-time search.

## Streaming

`POST /api/chat/stream` accepts the same request body as `POST /api/chat` and returns `text/event-stream`. Available for any chat model flagged `streaming: true` in the catalog (34 of the 35 chat models, all but the single-shot LLaVA 1.5, covering all five providers: Anthropic, xAI, Workers AI, OpenAI proxied, and Gemini).

Wire format:

```
data: {"type":"delta","text":"..."}
data: {"type":"done","row_id":N,"latency_ms":N,"tokens_in":N|null,
       "tokens_out":N|null,"conversation_id":"...","turn_index":N}
```

Or, on error:

```
data: {"type":"error","message":"..."}
```

Provider-native event types (Anthropic's `message_start`/`content_block_delta`/etc., xAI/Workers AI/OpenAI OpenAI-style `data: [DONE]` sentinel, Gemini's candidate frames) are normalized server-side. The client sees only the envelope above.

Client disconnect aborts the upstream model call immediately via `AbortSignal`, stopping the token meter mid-generation. Partial responses are NOT persisted; only complete turns reach D1.

A reference client lives at `public/streaming-client.js` (drop-in vanilla-JS module). The frontend automatically picks the streaming endpoint when the selected model has `streaming: true`.

Note: AI Gateway does not surface `cf-aig-log-id` on proxied SSE responses, so streamed turns have `ai_gateway_log_id: null` in D1. Non-streamed turns still get the log ID.

## Editing the model menu

`MODELS` at the top of `src/index.ts`. Each entry has:

- `id`: `@cf/{vendor}/{model}` for Workers AI, `anthropic/{model}` for Anthropic (Unified Billing), `xai/{model}` for BYOK xAI, `openai/{model}` / `google/{model}` for Unified Billing chat, or `bytedance/{model}` / `minimax/{model}` / etc. for Unified Billing video and music partners.
- `label` for the picker
- `group` for the picker section heading
- `type`: `"chat"` | `"image"` | `"tts"` | `"video"` | `"stt"` | `"music"`
- `capabilities`: array. Currently only `"vision"` is recognized; applies to chat models only.
- `provider` (optional): `"workers-ai"` (default) | `"anthropic"` (Unified Billing) | `"xai"` (BYOK) | `"openai"` / `"google"` / `"bytedance"` / `"minimax"` / `"runwayml"` / `"alibaba"` / `"pixverse"` / `"vidu"` (Unified Billing). Drives the call dispatch.
- `byok_alias` (optional): for xAI video, the upstream model name passed to the provider API.
- `streaming` (optional, chat only): when `true`, the model is eligible for `POST /api/chat/stream`. 34 of the 35 chat models across the five providers (Anthropic, Workers AI, xAI, OpenAI, Gemini) are wired; only the single-shot LLaVA 1.5 is not.

Full Workers AI catalog: https://developers.cloudflare.com/workers-ai/models/. Skip anything tagged "Planned deprecation."

## Migrating an existing deployment

Upgrading an existing deployment? The full per-version migration runbook (delta
files, exact `wrangler d1 execute` commands, and the "never re-run `schema.sql`"
reasoning) lives in **[MIGRATIONS.md](MIGRATIONS.md)**.

## Local type check

```
npm run typecheck
```

Runs `tsc --noEmit`. The Workers build uses esbuild and skips type checking, so this script is the source of truth for type errors during development.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome. Current backlog items that would be especially welcome:

- **Tests for the parsers and transforms**: the SSE parsers are exercised by unit fixtures but not validated against real upstream responses. More golden fixtures from live captures would catch drift.
- **Discriminated-union refactor of `InputAttachment`**: currently a flat shape with optional fields; a proper tagged union would surface real assumptions in the code.
- **Provider-shared request builders**: `callXai` + `callXaiStream` share ~30 lines. Factor out URL/headers/body builders.
- **Upstream BYOK video poll throttle**: client polls every 5s, each currently triggers an upstream call. Adding `last_upstream_check_at` to the chats row would let us throttle to ~1 upstream call per 20-30s while keeping client UX responsive.
- **Accessibility on the model picker**: keyboard-accessible (uses `<details>`) but missing `role="combobox"`, `aria-expanded`, `aria-controls`.
- **RAG chunking quality**: fixed-size chunking within page/sheet boundaries; recursive separator splitting would substantially improve retrieval on technical and legal docs.
- **True video understanding via Gemini routing**: the existing 8-keyframe sampling is a workaround; Gemini 2.5 / 3 Pro could handle real temporal video reasoning.
- **Additional Workers AI model entries**: new arrivals show up in the CF catalog regularly.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

[AGPL-3.0-only](LICENSE). If you run this as a network service for users, you must offer them the source code under the same license.

## Acknowledgements

Built and maintained by [SkyPhusion](https://x.com/SkyPhusion).

Built on Cloudflare Workers, Workers AI, AI Gateway, D1, R2, Vectorize, Workflows, and Cloudflare Access. Image generation models courtesy of Black Forest Labs and Leonardo.Ai. Text-to-speech via Deepgram. Speech-to-text via OpenAI Whisper. Web search via Tavily and Wikipedia.
