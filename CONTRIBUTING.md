# Contributing

Thanks for your interest. A few things to know before you open a PR.

## Project posture

This project is maintained as time allows. Response times on issues and PRs may vary. If you need a guaranteed-response open-source project, this is probably not the right one. If you find it useful and want to make it better, contributions are welcome.

## Scope

The project is a template for the Cloudflare AI stack: a single Worker that ties together Workers AI, AI Gateway, D1, R2, Vectorize, Workflows, and Cloudflare Access. Modalities covered: chat (text and vision), image generation, TTS, STT, video generation, music generation, and RAG over uploaded PDFs and spreadsheets. xAI chat is the one remaining BYOK path; Anthropic and everyone else run on Unified Billing through the AI Gateway / `env.AI.run`.

PRs that fit:

- New Workers AI models in the catalog (verify the model ID and the response shape against the model page on `developers.cloudflare.com/workers-ai/models/`)
- Conversion of BYOK chat providers to Unified Billing where Cloudflare supports them (see "Adding a new model provider" below)
- Per-provider param mapping for Unified Billing video models (the current baseline assumes Veo's param shape and sends the same to ByteDance / RunwayML / Alibaba / PixVerse / Vidu, which may reject or ignore some params; provider-specific mappers would fix this)
- Better handling of provider-specific response shapes in `extractOutput` or in the per-provider dispatch helpers (`callAnthropic`, `callXai`, `callGemini`)
- Image-to-image input for FLUX 2 (the multipart binding already accepts up to 4 reference images; frontend needs the UI to attach them)
- Audio extraction from uploaded video files (today video attachments are 8 keyframes only; pulling the audio track and feeding it to Whisper would give transcription plus visual analysis from one upload)
- TTS voice picker for Aura / MeloTTS variants
- STT output formats (verbose_json, SRT, VTT)
- Cross-conversation export to Markdown

PRs unlikely to merge:

- Framework migrations (React, Vue, Svelte, etc.). The vanilla-JS-and-no-build posture is deliberate. Build steps add friction for the "clone, fill in IDs, deploy" path that the README documents.
- Replacement of D1 / R2 / Vectorize / Access with non-Cloudflare alternatives. The point is to be a Cloudflare-native template.
- Features that materially expand the surface area without a clear use case. The current modality list (chat, image, TTS, STT, video, music, RAG) is intentional; adding agentic browsing, image upscaling, document generation, etc. needs strong justification tied to an actual use case.
- Telemetry, analytics, or anything that exfiltrates user data to a third-party service.

## Adding a new model provider

When adding a new third-party model that isn't already in the catalog, prefer the **Unified Billing** path (via `env.AI.run` with the provider's model ID) over BYOK. Reasons:

- Unified Billing means deployers don't need a separate API key for that provider; the cost rolls up to their Cloudflare bill.
- It uses Cloudflare's AI Gateway natively, so observability, caching, and rate limiting come free.
- It is less code on our side: no per-provider dispatch helper, no transform between our internal `messages` shape and the provider's format.

Add a BYOK path only when:

- The provider is not yet supported by Unified Billing (uncommon, but happens for new launches).
- The provider's billing model does not fit Unified Billing (e.g., it requires its own cloud credentials and is not proxied through the AI Gateway).
- A deployer specifically wants their own quota or rate-limit ceiling with the provider, distinct from their Cloudflare account.

If you add a BYOK entry, mark the catalog row with `{ provider: "<name>", byok_alias: "<provider-side-model-id>" }` and label it `(BYOK)` in the UI so deployers know to set the corresponding secret. The existing xAI entries are the reference pattern.

## Long-running operations

Video and music generation can take 30 seconds to 3 minutes per call. These paths use Cloudflare Workflows (`LongRunWorkflow` in `src/index.ts`) for durable execution; do not use `ctx.waitUntil` for anything that may exceed 30 seconds after the HTTP response is sent. If you are adding a new long-running operation, hand off to the workflow and persist the workflow instance ID on the chats row as `job_id` for traceability.

## Filing an issue

For bug reports: include the model you were using, the operation that failed, and the actual error from the worker logs (`npx wrangler tail`). For workflow-related failures, also include the output of `npx wrangler workflows instances describe skyphusion-longrun <job_id>`. For feature requests: include the use case, not just the feature.

## Submitting a PR

1. Fork, branch, code.
2. Run `npm run typecheck` before pushing. The CI workflow runs the same check; failing typecheck blocks merge.
3. If you touched the `Env` interface or added a binding, run `npx wrangler types` to regenerate `worker-configuration.d.ts` and commit the regenerated file.
4. Wrangler configuration changes go in `wrangler.example.toml` (the committed template). The actual `wrangler.toml` is gitignored so deployers can keep their own IDs; document any new bindings as a copy-paste TOML block in the CHANGELOG entry for the version so existing deployers can apply them by hand.
5. If you touched the D1 schema, document the migration step in the CHANGELOG and in the README.
6. If you added a model, verify the model ID and the response shape against the model page on `developers.cloudflare.com/workers-ai/models/`.
7. Keep the no-em-dash style. Source files in this repo do not use em-dashes (U+2014) or en-dashes (U+2013). Use commas, semicolons, or parentheses.
8. Open the PR with a description of what changed and why. If you regression-tested anything in a deployed environment, mention what.

## Code style

- TypeScript with strict mode on, no emit (Workers build uses esbuild).
- Vanilla JS for the frontend, no framework, no build step.
- No external runtime dependencies beyond what Workers provides natively. Current production dependencies are `unpdf` (for RAG over PDFs) and `xlsx` (for RAG over spreadsheets). New runtime dependencies need justification.
- Plain HTML and CSS. No CSS framework, no preprocessor.

## License

By submitting a contribution, you agree that your work will be licensed under AGPL-3.0-only, the same license as the project.
