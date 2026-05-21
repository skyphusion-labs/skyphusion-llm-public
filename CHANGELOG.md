# Changelog

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
