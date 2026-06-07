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

## Phase 3: the selector in the Vivijure control panel

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

- Per-scene override: `scenes[].motion_backend` / `motion_model`, so a film can
  send the standoff to Wan and the atmosphere shots to Seedance.
- The reverse bridge: a per-scene `start_image` in the bundle assembler so
  externally-authored keyframes can drive the *pod's* Wan motion (today there is no
  injection point: the bundle carries only a top-level `start_image` and there is no
  API to write `projects/<name>/state.tar.gz`). This closes the loop the other way.

## Open questions / tradeoffs

- **Cost surfacing**: cloud is per-second per provider, GPU is per-minute scale-to-
  zero. Show an estimate in the dialog.
- **Aspect/resolution reconciliation**: each cloud model allows different
  sizes/ratios; map the film's 16:9 to each model's nearest allowed value.
- **Clip duration**: cloud models emit fixed ~5-8s clips; beat-sync trimming stays
  off-GPU in `video-finish`.
- **Audio**: Seedance/Veo can self-generate audio; we want silent + our own score,
  so `generate_audio:false` (Phase 1 already sets this).
