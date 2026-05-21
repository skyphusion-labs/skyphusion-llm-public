# skyphusion-llm-public

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Typecheck](https://github.com/SkyPhusion/skyphusion-llm-public/actions/workflows/typecheck.yml/badge.svg)](https://github.com/SkyPhusion/skyphusion-llm-public/actions/workflows/typecheck.yml)

A multimodal AI playground deployed as a single Cloudflare Worker. Chat with text models, generate images, synthesize speech, and analyze images, audio, and video, all through one web UI. Per-user history, R2 artifact storage, and Cloudflare Access for authentication.

## What this is

A working template for the Cloudflare AI stack. One Worker, no framework, no build step beyond TypeScript. The interesting parts are the patterns, not the line count:

- **Unified `env.AI.run()` binding** drives text generation, vision input, audio transcription (Whisper), image generation (FLUX, Lucid Origin, Phoenix), and TTS (Aura-2, MeloTTS) from a single call surface.
- **AI Gateway** wraps every call for observability, caching, and rate-limiting.
- **D1** holds chat metadata and text. **R2** holds all binary artifacts. The chat row references R2 keys; nothing binary touches D1.
- **Cloudflare Access** gates the entire worker URL. The worker reads `Cf-Access-Authenticated-User-Email` to scope history per user; R2 objects carry `customMetadata.user_email` so cross-user access is impossible even if a UUID is guessed.
- **Client-side video keyframe extraction** sends 8 evenly-spaced frames to vision models instead of uploading the full video file.

## Features

- 13 text-generation models from the Workers AI catalog, optgrouped by vendor (Anthropic-equivalents, OpenAI open weights, Meta Llama, Qwen, DeepSeek, Mistral)
- 3 image-generation models: FLUX-1 schnell (fast), Lucid Origin (quality), Phoenix 1.0 (text rendering)
- 3 TTS models: Aura-2 EN, Aura-2 ES, MeloTTS (multilingual)
- Multimodal chat input: text, images (vision), audio (auto-transcribed via Whisper), video (8 sampled keyframes)
- Per-user chat history with replay-able attachments and generated artifacts
- Optgrouped model dropdown with capability-aware UI (vision-only attachment types, image-mode UI re-skin to "negative prompt", TTS-mode UI that hides attachments)
- Enter to send, Shift+Enter for newline
- Streaming-ready R2 artifact proxy that respects Access auth

## Stack

- One Worker, TypeScript, no framework
- `env.AI` unified binding routed through Cloudflare AI Gateway
- D1 for chat history rows
- R2 for input and output artifact bytes
- Static frontend served via Workers Assets
- Cloudflare Access in front for auth

Roughly 1900 LOC across TypeScript, vanilla JS, CSS, HTML, and SQL.

## Quickstart

Prerequisites:

- Cloudflare account with Workers, D1, R2, AI Gateway, and Workers AI enabled
- Node.js 18 or later
- Workers Paid plan if you plan to exceed the free Workers AI tier (10,000 neurons per day across all model usage)

```
git clone https://github.com/SkyPhusion/skyphusion-llm-public.git
cd skyphusion-llm-public
npm install
```

### 1. Create the AI Gateway

Dashboard > AI > AI Gateway > Create Gateway. Name it anything. Copy the slug from the URL after creation and paste it into `wrangler.toml` at `[vars] GATEWAY_ID`.

### 2. Create the D1 database

```
npx wrangler d1 create skyphusion-llm-public
```

Paste the returned `database_id` into `wrangler.toml` at `[[d1_databases]] database_id`. Then apply the schema:

```
npm run db:migrate:remote
npm run db:migrate:local
```

### 3. Create the R2 bucket

```
npx wrangler r2 bucket create skyphusion-llm-public
```

No further config needed; the binding is already in `wrangler.toml`.

### 4. First deploy

```
npm run deploy
```

You will get a `*.workers.dev` URL.

### 5. Cloudflare Access

Dashboard > Zero Trust > Access > Applications > Add an application > Self-hosted. Application domain is your worker URL. Identity providers: enable at least one (Google, GitHub, One-Time PIN, etc.). Policy: Action Allow, Rules > Emails > include your address and anyone else who should have access.

Cloudflare Zero Trust is free up to 50 seats, so a small team is free.

After this, hitting the worker URL shows the Access login screen. Authenticated requests reach the worker with `Cf-Access-Authenticated-User-Email`, which scopes both history and R2 artifact access per user.

### 6. Local development

`wrangler dev` does not run Cloudflare Access. The worker falls back to `user_email = 'anonymous'` for local runs. Do not expose your local dev port to the public internet.

```
npm run dev
```

## Architecture

```
                    Browser (Cloudflare Access login)
                              |
                              v
                    Worker (single fetch handler)
                    /        |         \
                  AI         D1          R2
              (Gateway)  (metadata)  (artifact bytes)
```

The worker is the only public surface. R2 is private; the worker streams objects through `GET /api/artifact/*` after verifying ownership via `customMetadata.user_email` on the R2 object.

### Routes

| Method | Path | Purpose |
|---|---|---|
| GET    | `/api/models`       | List available models with capability flags |
| POST   | `/api/chat`         | Run a model. Dispatches by model type. |
| GET    | `/api/history`      | List the caller's chats |
| GET    | `/api/history/:id`  | One chat row with full attachment + output references |
| DELETE | `/api/history/:id`  | Delete a chat row and clean up its R2 objects |
| GET    | `/api/artifact/*`   | Stream an R2 object, gated by ownership |

### Model types

- `chat`: text generation. Accepts vision attachments on vision-capable models. Audio attachments are transcribed via Whisper. Video attachments are 8 client-extracted keyframes.
- `image`: text-to-image generation. The system prompt field becomes the negative prompt. Output is a JPEG in R2.
- `tts`: text-to-speech. Output is audio (MP3 or model-default container) in R2.

## Multimodal handling

**Images.** Native `image_url` content blocks to vision-capable chat models. Downscaled to 1280px max dimension client-side. 4 MB raw cap.

**Audio.** Transcribed via `@cf/openai/whisper-large-v3-turbo` before the model call. Transcript text is prepended to the user message. Raw audio is dropped (not stored). 20 MB cap.

**Video.** Client-side keyframe extraction via HTML5 video + canvas. Eight evenly-spaced frames are pulled at upload time and sent as image content blocks to a vision-capable chat model. The original video file is never uploaded to the worker. This is sampled-frames understanding, not true temporal video reasoning. For true video, route through Gemini 2.5/3 Pro via the AI Gateway third-party path. 100 MB cap is a browser-side sanity limit.

## Storage and cost

D1 holds metadata and structured JSON pointing to R2 keys. R2 holds binary bytes. Each R2 object carries `customMetadata.user_email` for ownership checks. `DELETE /api/history/:id` cleans up the corresponding R2 objects best-effort.

Workers AI billing is per-token / per-image / per-minute depending on model. Free tier is 10,000 neurons per day across all Workers AI usage. Image generation burns through neurons faster (roughly 1,600 to 6,400 per image). Beyond the free tier, the Workers Paid plan is required at $5/month, with usage at $0.011 per 1,000 neurons.

D1 is roughly $0.75/GB-month for storage. R2 is roughly $0.015/GB-month with no egress fees inside Cloudflare. Free tiers on D1 and R2 cover small personal use indefinitely.

Anthropic (Claude), xAI (Grok), and Google (Gemini) models bill against your own provider accounts via BYOK, not Cloudflare. See below.

## Anthropic models (BYOK)

The Anthropic entries in the model menu (Claude Opus 4.6, Sonnet 4.6, Haiku 4.5) are routed via BYOK (Bring Your Own Key) rather than Cloudflare Unified Billing. The `env.AI.run()` binding doesn't support BYOK for third-party models, so the worker hits the AI Gateway's Anthropic provider endpoint directly with Anthropic-native payloads. The gateway still wraps the call for observability, caching, and rate-limiting.

There are two ways to authenticate, and the worker supports both:

### Option A (recommended): Store the key in AI Gateway

1. Get an API key from https://console.anthropic.com > Settings > API Keys > Create Key
2. Dashboard > AI > AI Gateway > select your gateway > Provider Keys > Add API Key > pick Anthropic > paste
3. Redeploy: `npm run deploy`

The worker sends the request without an `x-api-key` header; the gateway injects the stored key before forwarding to Anthropic. Keys live in Cloudflare Secrets Store, are rotatable in one place, and never appear in worker secrets.

### Option B: Inline secret

1. Get the key as above
2. Load it as a Worker secret:
   ```
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
3. Redeploy

The worker sends the key as `x-api-key` on every request. This overrides any stored key at the gateway level.

### Authenticated Gateway

If your gateway has Authenticated Gateway enabled (recommended for production), also set:
```
npx wrangler secret put CF_AIG_TOKEN
```
The worker will include the `cf-aig-authorization` header automatically when this is set.

Billing: Anthropic charges your account at their per-token rates. There's no Cloudflare markup on BYOK calls; the gateway just proxies. Caching at the gateway level can reduce duplicate-prompt costs.

## xAI / Grok models (BYOK)

Grok 4.3, Grok 4.20 (Multi-Agent and Reasoning variants), and Grok Build 0.1 are routed via BYOK against your own xAI account. Same patterns as Anthropic above: stored keys in the gateway dashboard (recommended) or inline Worker secret. xAI is OpenAI-compatible so no message transform is needed.

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

## Google Gemini models (BYOK)

Gemini 3.5 Flash, Gemini 3.1 Pro, Gemini 3.1 Flash, and Gemini 2.5 Pro are routed via BYOK against your own Google AI Studio account. Same pattern as Anthropic and xAI: stored keys in the gateway dashboard (recommended) or inline Worker secret.

Google's API differs from OpenAI: messages live in a `contents` array of `parts` blocks, system prompts go in `systemInstruction`, images use `inline_data` blocks, and the assistant role is called `model`. The worker handles the transform internally; the same UI works for all four providers.

### Option A (recommended): Store the key in AI Gateway

1. Get an API key from https://aistudio.google.com > Get API key
2. Dashboard > AI > AI Gateway > Provider Keys > Add API Key > pick Google AI Studio > paste
3. Try a Gemini model; the gateway injects the stored key automatically

### Option B: Inline secret

```
npx wrangler secret put GOOGLE_API_KEY
npm run deploy
```

The worker sends `x-goog-api-key` on every request, overriding any stored key.

Billing: Google charges your account directly. Gemini 3.5 Flash and Gemini 3.1 Flash are roughly $0.30/$2.50 per million input/output tokens, Gemini 3.1 Pro is higher (premium reasoning tier), Gemini 2.5 Pro is at the older 2.5-family pricing. Check https://ai.google.dev/pricing for current rates.

## Editing the model menu

`MODELS` at the top of `src/index.ts`. Each entry has:

- `id`: `@cf/{vendor}/{model}` for Workers AI, `anthropic/{model}` for BYOK Anthropic, `xai/{model}` for BYOK xAI, or `google/{model}` for BYOK Google Gemini
- `label` for the dropdown
- `group` for the optgroup heading
- `type`: `"chat"` | `"image"` | `"tts"`
- `capabilities`: array. Currently only `"vision"` is recognized; applies to chat models only.
- `provider` (optional): `"workers-ai"` (default) | `"anthropic"` (BYOK) | `"xai"` (BYOK) | `"google"` (BYOK). Drives the call dispatch.

Full Workers AI catalog: https://developers.cloudflare.com/workers-ai/models/. Skip anything tagged "Planned deprecation."

## Local type check

```
npm run typecheck
```

Runs `tsc --noEmit`. The Workers build uses esbuild and skips type checking, so this script is the source of truth for type errors during development.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome, especially for:

- Additional Workers AI model entries
- Provider-specific response-shape handling in `extractOutput`
- True video understanding via Gemini routing
- Streaming responses for chat
- Image-to-image input for FLUX-2

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

[AGPL-3.0-only](LICENSE). If you run this as a network service for users, you must offer them the source code under the same license.

## Acknowledgements

Built on Cloudflare Workers, Workers AI, AI Gateway, D1, R2, and Cloudflare Access. Image generation models courtesy of Black Forest Labs and Leonardo.Ai. Text-to-speech via Deepgram. Speech-to-text via OpenAI Whisper.
