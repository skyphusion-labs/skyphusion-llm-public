# rembg container

Single-purpose background-removal HTTP service that lives behind a
Cloudflare Container binding on the skyphusion-llm Worker. Used by the
cast portrait flow to strip backdrops off uploaded / generated cast
portraits before they land in R2, so the vivijure-serverless regional
render path's IP-Adapter sees a clean isolated-subject conditioning
input.

## API

`POST /clean`
- Request body: raw image bytes (png / jpeg / webp), at most 16 MB.
- Response body: PNG bytes of the subject composited onto solid black.
- Errors: 400 (empty / undecodable), 413 (over cap).

`GET /`
- Health probe; returns `{"ok": true, "model": "u2net"}` once the
  rembg ONNX session is loaded.

## Build + push

The image is built and pushed via wrangler from the Worker side:

```bash
# From the skyphusion-llm-public root
npx wrangler containers build ./containers/rembg --tag rembg:latest
npx wrangler containers push rembg:latest
```

The Worker references the image in `wrangler.toml` under a
`[[containers]]` block; the binding (`REMBG` on `env`) carries
`Container.fetch(...)` semantics so handlers call it like any other
fetch target. See `src/containers/rembg.ts` for the Durable Object
wrapper class.

## Why solid black

Tested across smoke v22 to v26: portraits with a studio-gray backdrop
leak gray into the rendered keyframe (IP-Adapter dominates the bg at
scale 0.7); environmental backdrops cause the two regional masks to
merge into one fused figure (CLIP encoder confuses subject + busy bg).
Solid black gives the CLIP encoder clean isolated identity AND no
specific bg color to leak. Prompt + LoRA then drive the actual
environment. Verified in smoke v26: two distinct figures + forest at
dusk backdrop, matching the prompt.

## Model

u2net.onnx (~176 MB) is baked into the image at build time so cold-
start latency does not include the GitHub-releases download. The
rembg session is initialized once at module load; per-request latency
on a basic container instance is roughly 200-500 ms for a 1024 x 1024
portrait.
