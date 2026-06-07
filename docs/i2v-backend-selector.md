# Pluggable image-to-video (motion) backend: cloud vs GPU

Design + rollout plan for letting a Vivijure render choose how its keyframes are
animated: the **cloud** image-to-video models (this Worker's `/api/chat` video
catalog) or the **GPU** pod's Wan 2.2 I2V. Written 2026-06-07.

## Why

Motion is currently hardwired per path. The pod's `finalize` (i2v_only) animates
the render's own SDXL keyframes with Wan 2.2; the playground's video models animate
a single uploaded image. There is no way to say "render the film, but animate it
with Seedance" or "animate these authored keyframes on the GPU." During the NEON
HALFLIFE production the keyframes were authored off-pipeline (reference-locked
nano-banana, for compositional control the regional pass cannot give), and the only
cloud i2v model wired for an input image was `alibaba/hh1-i2v`, the weakest of the
set. The better motion models could not see a keyframe at all.

## The two backends

| | Cloud i2v (this Worker) | GPU i2v (pod Wan 2.2) |
|---|---|---|
| Where | `/api/chat` video models via `env.AI.run` (Unified Billing) | RunPod pod, `finalize`/full render |
| Input | one keyframe per call (`image_key`/`image_url`) | the render's `clips/<shot>_keyframe.png` |
| Quality | premium, model-dependent (Seedance/Hailuo/Veo/Runway) | high, consistent Wan 2.2 |
| Assembly | off-GPU (`video-finish` container) + our score | pod exports silent picture, then mux |
| Cost | per-second provider cost, no GPU | GPU minutes (scale-to-zero) |
| Best for | art-directed / externally-authored keyframes; no pod spin-up | keyframes the regional pass already rendered well |

Neither is strictly better. The point is to pick per film (and eventually per shot).

## Phase 1 (this PR): make the cloud side worth choosing

Only `hh1-i2v` accepted a keyframe. This PR flags the premium cloud video models as
`image-input` and gives each its verified per-model param shape in
`buildGenParams` (their schemas differ, and `additionalProperties:false` makes a
wrong field fatal):

| Model | image field | duration | size |
|---|---|---|---|
| `bytedance/seedance-2.0` (+fast) | `image` | int 5 | `resolution:720p`, `aspect_ratio:16:9` |
| `minimax/hailuo-2.3` (+fast) | `first_frame_image` | int 6 | `resolution:768P` |
| `runwayml/gen-4.5` | `image_input` | int 5 | `ratio:1280:720` |
| `alibaba/hh1-i2v` (existing) | `image` | int 5 | `resolution:720P` |

`google/veo-*` is deferred: its `image_input` wants raw base64, not a URL/data-URI,
so it needs a conversion step in the workflow. Tracked as a follow-up.

After this, the existing `/api/chat` image-to-video path (`POST /api/chat {model,
image_key|image_url, user_input:<motion prompt>}` then poll `/api/job/<id>`) works
with any of these models. That is the cloud backend, available immediately and
hand-drivable today; the phases below make it a first-class storyboard step.

## Phase 2 (SHIPPED v0.144.0): cloud animation as a storyboard step

A control-plane endpoint that animates a render's keyframes via a chosen cloud
model and assembles the result, so it is not hand-driven:

- `POST /api/storyboard/renders/<id>/animate-cloud { model, motionPrompts?, prompt? }`
  on a COMPLETED render that has keyframes. `model` must be a video model with the
  `image-input` capability (the Phase 1 set). Returns a `cloud-<uuid>` jobId.
- A `cloud_animate` LongRunWorkflow: one durable step per shot (presign the
  keyframe, `env.AI.run` the cloud i2v model, store the clip in R2_RENDERS), then an
  assemble step (`video-finish` container concat) that re-puts the result with the
  owner's `customMetadata` so `/api/artifact` serves it. Status is kept current on
  the render row via the by-`job_id` `updateRenderFromView`.
- Poll at `GET /api/storyboard/render/<jobId>`: a `cloud-` short-circuit serves the
  row directly (these are not RunPod jobs, and the long run must not hit the
  RunPod-404 phantom path). New history row carries `mode: "cloud-finalized"`.
- Output is silent by design; add a score with the existing
  `POST .../add-audio` on the new row (no audio plumbing duplicated here).
- Follow-ups: per-shot model override (`perShot`); parallel shot gens (steps are
  sequential today).

### Original design notes

Add a control-plane endpoint that animates a render's keyframes via a chosen cloud
model and assembles the result, so it is not hand-driven:

- `POST /api/storyboard/renders/<id>/animate-cloud { model, motionPrompts?, perShot? }`
- Runs a durable workflow: for each shot, take its keyframe from R2
  (`renders/<proj>/<job>/keyframes/shot_NN.png`, served as a fetchable URL), call
  the cloud video model, collect the clips, then call the `video-finish` container
  to concat (+ optional `audioKey`). Persist as a new render row (`mode:
  "cloud-finalized"`).
- Mirrors the existing GPU `finalize` so the two backends are symmetric from the
  caller's view.

## Phase 3 (SHIPPED v0.145.0): the selector in the Vivijure control panel

Shipped as a control on the keyframes-only preview's finalize row in `planner.js`
(`buildHistoryRow`): a "Motion" backend `<select>` (GPU Wan I2V vs Cloud per-shot
i2v) plus a cloud model dropdown (the `image-input` catalog: Seedance / Hailuo /
Runway / hh1) that appears only when Cloud is picked. GPU routes to the existing
`finalizeRender` (`/finalize`); Cloud routes to the new `animateCloudRender`
(`/animate-cloud { model }`). Both `loadHistory()` after submit, so the new row is
polled by the existing history auto-refresh (the render-poll `cloud-` short-circuit
serves it). Vanilla JS, no build step; cloud model options are hand-maintained like
the Wan model option lists.

Follow-up (the deeper integration below, not yet built): a `motion_backend` /
`motion_model` field on the initial render-submit payload so the choice can be made
up front (the cloud path is inherently post-keyframes, so the preview-row control is
the natural surface for now).

### Original design notes

Data model (render submit payload + persisted on the storyboard / render row):

```
motion_backend: "gpu_wan" | "cloud"          // default gpu_wan
motion_model:   string                       // when cloud: the video model id
```

Routing at submit time: `gpu_wan` keeps today's finalize/full-render path; `cloud`
runs the Phase 2 animate-cloud flow on the keyframes.

UI (storyboard render dialog): a "Motion" section, radio `GPU (Wan 2.2)` vs
`Cloud`; when Cloud, a model dropdown (Seedance / Hailuo / Runway / hh1) that
surfaces each model's duration + resolution constraints and a rough cost hint.

## Phase 4 (optional): per-shot mixing + the reverse bridge

- **Phase 4a (SHIPPED v0.147.0): per-shot cloud-model mixing.** `animate-cloud`
  accepts `perShot: { shot_id: modelId }` (each an image-input video model; bad
  entries 400). `runCloudAnimate` resolves `perShot[shot] || model` per shot and
  records each clip's model in `output.clips[].model`. The planner's keyframe strip
  gains a per-shot model picker (revealed when Cloud is selected); completed rows
  label each clip's model and badge a multi-model run as "cloud · mixed". Cloud-only
  slice; mixing GPU Wan *and* cloud in one film is the hybrid below.
- Per-scene override across backends (GPU vs cloud per shot): `scenes[].motion_backend`
  / `motion_model`, so a film can send the standoff to Wan and the atmosphere shots to
  Seedance. (Hybrid; not yet built.)
- **The reverse bridge (control-plane half SHIPPED v0.148.0).** `assembleBundle`
  accepts `sceneStartImages: { sceneId -> TrainingImage }` and writes each to
  `clips/<id>_keyframe.png` in the bundle; `POST /api/storyboard/bundle` forwards it.
  Verified against the pod (vivijure-src/core.py): the render path reads each scene's
  start frame from `scene.start_image`, falling back to
  `<project_dir>/clips/<id>_keyframe.png`, so this injects externally-authored
  keyframes into the pod's Wan motion with **no pod change**. Remaining: the planner UI
  to attach a keyframe per scene at the bundle step, and end-to-end validation once the
  pod's full Wan i2v render path is proven on the volume-free worker (keyframes-only is
  proven). Closes the loop the other way (cloud-authored keyframes -> baked-pod Wan).
- **Phase 4b loop CLOSED (v0.149.0 UI + v0.150.0 i2v entry).** The per-scene keyframe
  picker shipped in the planner bundle step (v0.149.0). Then a gap surfaced: the bundle's
  `clips/<id>_keyframe.png` only "takes" on the pod's i2v_only path -- the normal +
  keyframes-only render passes REGENERATE the SDXL keyframe and overwrite an injected one
  (verified core.py:1077-1084; only `if i2v_only and still_path.is_file()` reuses). So
  v0.150.0 adds **`POST /api/storyboard/render-from-keyframes`**, which submits the pod's
  `finalize`/i2v_only action DIRECTLY against a fresh bundle (no prior render row, so no gen
  pass to clobber the injected frames); the pod builds the manifest on demand and animates
  the injected keyframes -- NO pod change. The bundle result panel gains a "render from
  keyframes (GPU i2v)" button. Remaining: a live fresh-bundle finalize smoke test, plus an
  OPTIONAL pod enhancement (Option A: honor injected keyframes in the normal render path
  too) handed off in `~/vivijure-reverse-bridge-pod-handoff.md`.

## Open questions / tradeoffs

- **Cost surfacing**: cloud is per-second per provider, GPU is per-minute scale-to-
  zero. Show an estimate in the dialog.
- **Aspect/resolution reconciliation**: each cloud model allows different
  sizes/ratios; map the film's 16:9 to each model's nearest allowed value.
- **Clip duration**: cloud models emit fixed ~5-8s clips; beat-sync trimming stays
  off-GPU in `video-finish`.
- **Audio**: Seedance/Veo can self-generate audio; we want silent + our own score,
  so `generate_audio:false` (Phase 1 already sets this).

## Content moderation, per provider (v0.145.1)

The cloud i2v vendors run input-image moderation, and it false-positives on our own
AI-generated photoreal characters (it reads a synthetic human as a possible real
person / public figure and rejects the keyframe). This bites exactly the renders we
most want to animate (the photoreal ones); anime/stylized keyframes pass.

What each model exposes (verified against the CF model pages 2026-06-07):
- **Runway Gen-4.5** is the only one with a knob: `content_moderation:
  { public_figure_threshold: "low" }`. We send the loosest documented value, so
  Runway is the photoreal-friendly cloud lane.
- **Seedance 2.0, Hailuo 2.3, hh1-i2v** expose NO moderation field; it is hard-coded
  provider-side and cannot be overridden from our payload (Seedance is the strict
  one that returns `InputImageSensitiveContentDetected.PrivacyInformation`).
- **LoRA training and the SDXL keyframe pass are self-hosted** (our GPU), so they
  have no vendor moderation at all; this concern is purely the third-party i2v edge.

Operator posture: single key-holder, Cloudflare-Access-gated, logs monitored, AUP
enforced. (If AI Gateway Guardrails is enabled at the dashboard, that is a separate
layer the operator toggles there; it is not set in this code.)
