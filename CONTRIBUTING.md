# Contributing

Thanks for your interest. A few things to know before you open a PR.

## Project posture

This project is maintained as time allows. Response times on issues and PRs may vary. If you need a guaranteed-response open-source project, this is probably not the right one. If you find it useful and want to make it better, contributions are welcome.

## Scope

The project is a template for the Cloudflare AI stack: single Worker, Workers AI binding, D1, R2, Access. PRs that fit the scope:

- New Workers AI models in the catalog
- Better handling of provider-specific response shapes in `extractOutput`
- Streaming responses for chat models
- Image-to-image input for FLUX-2 (the multipart binding)
- Audio extraction from uploaded video files
- Optional integrations gated behind config (Gemini routing for video, Anthropic via third-party AI Gateway, etc.)

PRs unlikely to merge:

- Framework migrations (React, Vue, etc.). The vanilla-JS-and-no-build posture is deliberate.
- Replacement of D1/R2/Access with other providers. The point is to be a Cloudflare-native template.
- Features that materially expand surface area beyond chat / image / TTS without strong justification.

## Filing an issue

For bug reports: include the model you were using, the operation that failed, and the actual error from the worker logs (`npx wrangler tail`). For feature requests: include the use case, not just the feature.

## Submitting a PR

1. Fork, branch, code.
2. Run `npm run typecheck` before pushing. The CI workflow runs the same check; failing typecheck blocks merge.
3. If you touched the schema, document the migration step in the README.
4. If you added a model, verify the model ID and the response shape against the actual model page on `developers.cloudflare.com/workers-ai/models/`.
5. Keep the no-em-dash style. Source files in this repo do not use em-dashes or en-dashes. Use commas, semicolons, or parentheses.
6. Open the PR with a description of what changed and why.

## Code style

- TypeScript with strict mode on, no emit (Workers build uses esbuild).
- Vanilla JS for the frontend, no framework, no build step.
- No external runtime dependencies beyond what Workers provides natively. Dev dependencies are limited to wrangler and TypeScript.
- Plain HTML and CSS. No CSS framework, no preprocessor.

## License

By submitting a contribution, you agree that your work will be licensed under AGPL-3.0-only, the same license as the project.
