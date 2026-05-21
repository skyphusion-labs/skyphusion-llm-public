# Changelog

## v0.1.0 (initial public release)

- Single Cloudflare Worker fronting AI Gateway
- 13 chat models, 3 image-generation models, 3 TTS models from the Workers AI catalog
- Multimodal chat input: text, images (vision), audio (Whisper transcription), video (8 client-extracted keyframes)
- D1 for chat history, R2 for input and output binary artifacts
- Cloudflare Access for authentication, per-user history scoping, per-object ownership checks via R2 customMetadata
- Vanilla TypeScript Worker, vanilla JS frontend, no build step beyond tsc
- Enter to send, Shift+Enter for newline
- Optgrouped model dropdown with capability-aware UI re-skin per model type
