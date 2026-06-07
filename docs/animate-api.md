# Animate + score API

Endpoints that turn a rendered project into motion and then sound. The GPU
**render-submit** contract is documented separately in
[`render-api.md`](./render-api.md); this covers what happens to a render afterward:
animating a keyframes-only preview (cloud / hybrid / GPU-from-keyframes) and scoring
a finished cut (audio / narration). For the end-to-end picture see the
[walkthrough](./vivijure-walkthrough.md).

Authentication is the same as `render-api.md` (Cloudflare Access; pass a
`cf-access-token` JWT or a `CF-Access-Client-Id` / `CF-Access-Client-Secret` service
token). Examples below use `$TOKEN`. All renders are scoped to the authenticated
email.

## Common shape

The three animation endpoints all operate on a **COMPLETED keyframes-only preview**
(a render with keyframes in R2) and create a NEW history row whose `parent_id` links
back to that preview. Cloud + hybrid runs are **workflow-backed**: they return a
`cloud-<uuid>` jobId and run as a `LongRunWorkflow`. Every animated output is a
**silent** MP4 by design; add a soundtrack afterward with add-audio / add-narration.

Poll any of them at `GET /api/storyboard/render/<jobId>` (or watch the planner
History tab).

---

## POST /api/storyboard/renders/:id/animate-cloud

Animate the preview's keyframes through a cloud image-to-video model, one
`env.AI.run` call per shot, assembled into one silent MP4. (`src/index.ts`
`handleAnimateCloudSubmit`.)

| field | type | required | default | notes |
|---|---|---|---|---|
| `model` | string | **yes** | -- | a catalog `type:"video"` model with the `image-input` capability (e.g. `bytedance/seedance-2.0`, `minimax/hailuo-2.3`, `runwayml/gen-4.5`, `alibaba/hh1-i2v`) |
| `perShot` | object | no | `{}` | `{ shot_id: modelId }` per-shot overrides; each must be an image-input video model (else 400). Phase 4a mixing |
| `motionPrompts` | object | no | `{}` | `{ shot_id: prompt }` |
| `prompt` | string | no | `""` | global motion prompt fallback |

Eligibility: the source render must exist, be owned by you, be **COMPLETED**, and
have at least one keyframe. New row `mode: "cloud-finalized"`.

Response: `{ ok, jobId: "cloud-<uuid>", status: "IN_QUEUE", statusRaw, parentId,
project, model, shots, user }`.

```bash
curl -X POST https://skyphusion.org/api/storyboard/renders/131/animate-cloud \
  -H "cf-access-token: $TOKEN" -H "content-type: application/json" \
  -d '{ "model": "bytedance/seedance-2.0-fast",
        "perShot": { "shot_03": "runwayml/gen-4.5" },
        "prompt": "slow push-in, gentle parallax" }'
```

## POST /api/storyboard/renders/:id/animate-hybrid

Route each shot to **GPU Wan** or a **cloud** i2v model in one film, assembled into a
single silent cut. The GPU subset runs as one `finish_offloaded` finalize (per-shot
clips, no on-GPU assembly); the cloud subset runs the per-shot loop; a `video-finish`
pass merges them. (`handleAnimateHybridSubmit`; workflow `runHybridAnimate`.)

| field | type | required | default | notes |
|---|---|---|---|---|
| `backends` | object | no | `{}` | `{ shot_id: { backend: "gpu" \| "cloud", model? } }`; bad entries 400 (not dropped) |
| `defaultBackend` | `"gpu" \| "cloud"` | no | `"gpu"` | backend for shots absent from `backends` |
| `defaultCloudModel` | string | no | `"alibaba/hh1-i2v"` | image-input video model for cloud shots with no explicit model |
| `motionPrompts` | object | no | `{}` | `{ shot_id: prompt }` |
| `prompt` | string | no | `""` | global motion prompt fallback |

Eligibility: COMPLETED, owned, has keyframes; **and** if any shot is GPU the render
must have a `bundle_key` (the GPU subset finalizes against the bundle). New row
`mode: "cloud-finalized"`.

Response: `{ ok, jobId: "cloud-<uuid>", status, statusRaw, parentId, project, shots,
gpuShots, cloudShots, user }`.

Behavior (v0.154.0): per-lane progress in `output.progress` (`gpu`/`cloud`), beat-sync
trim on both lanes, and continue-on-error -- a failed shot/lane is recorded in
`output.failed_shots` and skipped; the run completes `output.partial = true` as long
as any clip was produced. Design: [`i2v-hybrid-backend.md`](./i2v-hybrid-backend.md).

```bash
curl -X POST https://skyphusion.org/api/storyboard/renders/131/animate-hybrid \
  -H "cf-access-token: $TOKEN" -H "content-type: application/json" \
  -d '{ "backends": {
          "shot_01": { "backend": "gpu" },
          "shot_02": { "backend": "cloud", "model": "minimax/hailuo-2.3" }
        },
        "defaultBackend": "gpu", "defaultCloudModel": "alibaba/hh1-i2v" }'
```

## POST /api/storyboard/render-from-keyframes

The reverse bridge: render directly from a bundle whose scenes carry injected start
keyframes (`clips/<shot_id>_keyframe.png`), via the pod's `i2v_only` finalize, with
**no** prior render row and no SDXL keyframe-gen to clobber them. (`src/index.ts`
`handleRenderFromKeyframes`; pod path, not a workflow.)

| field | type | required | default | notes |
|---|---|---|---|---|
| `project` | string | **yes** | -- | non-empty |
| `bundleKey` | string | **yes** | -- | a bundle assembled with `sceneStartImages` (see [`i2v-backend-selector.md`](./i2v-backend-selector.md)) |
| `qualityTier` | `"draft" \| "standard" \| "final"` | no | `final` | |
| `renderOverrides` | object | no | -- | freeform pod overrides |
| `audioKey` | string | no | -- | `audio/` or `out/` key to mux |

Response: `{ ok, jobId: "<runpod-job-id>", status, statusRaw, project, bundleKey,
user }`. New row `mode: "full"` (flips to `"finalized"` when the GPU envelope lands),
`parent_id: null`.

---

## Scoring a finished render

Both run off-GPU through the `video-finish` container with `remuxAudioOnly` (the video
is stream-copied, so resolution is preserved -- see [`containers.md`](./containers.md)).
They update the existing COMPLETED row's `output_key` in place (mode unchanged) and
return `{ ok, output_key, seconds, has_audio: true, user }`.

### POST /api/storyboard/renders/:id/add-audio

Mux an audio bed onto the finished video. (`handleAddRenderAudio`.)

| field | type | required | notes |
|---|---|---|---|
| `audioKey` | string | **yes** | must match `^(audio\|out)/.+` (an uploaded bed or a generated `out/<uuid>.mp3`) |

Eligibility: COMPLETED **and** has an `output_key` (else 409).

```bash
curl -X POST https://skyphusion.org/api/storyboard/renders/142/add-audio \
  -H "cf-access-token: $TOKEN" -H "content-type: application/json" \
  -d '{ "audioKey": "out/9d863853-....mp3" }'
```

### POST /api/storyboard/renders/:id/add-narration

Synthesize spoken narration (Workers AI TTS) and mux it on. (`handleAddRenderNarration`.)

| field | type | required | default | notes |
|---|---|---|---|---|
| `text` | string | **yes** | -- | non-empty, max 4000 chars |
| `voice` | string | no | `@cf/deepgram/aura-2-en` | one of `@cf/deepgram/aura-2-en`, `@cf/deepgram/aura-2-es`, `@cf/myshell-ai/melotts` |

Eligibility: COMPLETED **and** has an `output_key` (else 409).

```bash
curl -X POST https://skyphusion.org/api/storyboard/renders/142/add-narration \
  -H "cf-access-token: $TOKEN" -H "content-type: application/json" \
  -d '{ "text": "In the neon haze, the city never sleeps.", "voice": "@cf/deepgram/aura-2-en" }'
```
