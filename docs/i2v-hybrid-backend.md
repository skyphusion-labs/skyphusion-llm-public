# GPU + cloud hybrid i2v (Phase 4 finale)

Design for animating ONE film where each shot is routed to either the **GPU**
(pod Wan 2.2 i2v) or a **cloud** i2v model, then assembled into a single silent
MP4. Written 2026-06-07. Builds on the shipped pieces; the ONE pod dependency is a
small finalize change (SkyPhusion/vivijure-serverless#17 -- finalize honoring
`finish_offloaded` to emit per-shot clips), since finalize today always assembles
on-GPU. Everything else composes existing parts. (Fallback while #17 is reviewed:
run one single-shot finalize per GPU shot -- works, but N pod jobs.)

## Goal

Today a render's motion is all-GPU (`finalize`) or all-cloud (`animate-cloud`).
The hybrid lets a film send, say, the dialogue two-shots to Wan (consistent,
identity-locked) and the wide atmosphere shots to Seedance (cheaper, no GPU
spin-up), in one assembled cut. It is the last slice of the pluggable-backend
arc (`docs/i2v-backend-selector.md` Phase 4): 4a mixed cloud *models* per shot;
this mixes the *backends* themselves.

## Shape (consistent with 4a / 4b)

Operates on a **COMPLETED keyframes-only render** (the same surface as
`finalize` and `animate-cloud`): it already has every shot's keyframe in R2.
Each shot is assigned a backend; the result is a new `hybrid-finalized` history
row, silent by design (score afterward via the existing `add-audio`).

## What's already in place (reuse, do not rebuild)

- **GPU subset**: `submitFinalizeJob` + `process_shot_ids` already restricts the
  pod's i2v pass + (its own) assembly to a chosen subset of shot ids
  (runpod-submit.ts; pod `orchestrator.finalize`).
- **GPU per-shot clips (no pod assembly)**: the pod's **off-GPU finish** mode
  (override `n` -> output `finish_offloaded:true` + `clips:[{key,target_seconds}]`)
  returns per-shot clip R2 keys instead of an assembled MP4
  (`finishInputFromPodOutput`, `resolveOffloadedFinish` index.ts:2456). This is
  the join hook: run the GPU subset finish-offloaded so we get raw clips.
- **Cloud subset**: `runCloudAnimate`'s per-shot loop (presign keyframe ->
  `env.AI.run` i2v -> clip to `renders/<proj>/<job>/clips/<sid>.mp4`) +
  per-shot model from 4a (`perShot`).
- **Unified assembly**: `runVideoFinish` (the `video-finish` container) concats
  an ordered list of R2 clip keys into one MP4, normalizing size/fps (it already
  handled a size mismatch in the NEON HALFLIFE run). This is what merges the GPU
  clips and the cloud clips.
- **Progress / notify / logs / phantom-guard**: all from v0.146.x; reused as-is.

## Data model

Per-shot backend assignment on the submit body (no schema column; lives in the
workflow params + the row's `output_json` like `clips[].model` does today):

```
backends: {
  "shot_01": { backend: "gpu" },
  "shot_02": { backend: "cloud", model: "runwayml/gen-4.5" },
  ...
}
defaultBackend: "gpu" | "cloud"   // shots omitted from `backends` use this
defaultCloudModel: "<model id>"   // for cloud shots with no explicit model
motionPrompts?: { shot_id: prompt }   // already supported by animate-cloud
```

Validation (pure, testable, mirrors `normalizePerShotModels`): every cloud
shot's model is an image-input video model; backend is one of gpu|cloud.

## API

`POST /api/storyboard/renders/<id>/animate-hybrid`
`{ backends, defaultBackend?, defaultCloudModel?, motionPrompts? }`
on a COMPLETED keyframes-only render. Returns a `cloud-<uuid>` jobId (same
poll surface; the row is workflow-backed, so the `pollRenderResolved` `cloud-`
guard from v0.146.1 already protects it from the phantom path). New row
`mode: "hybrid-finalized"`, `parent_id` = the keyframes render (4b linkage).

## Orchestration: the `hybrid_animate` workflow

A new `LongRunWorkflow` kind (sibling of `cloud_animate`). Steps:

1. **mark-running** (as cloud_animate).
2. **Partition** shots into `gpuShots` / `cloudShots` by `backends` + defaults.
3. **GPU subset** (only if `gpuShots` non-empty): one durable step that
   - `submitFinalizeJob({ project, bundleKey, processShotIds: gpuShots, renderOverrides: { ...n/off-GPU-finish... } })`,
   - then **polls** the RunPod job to terminal inside the step (submit+poll loop
     with sleeps; the step's own retry covers transient poll errors),
   - on COMPLETED reads the off-GPU finish manifest -> `{ shot_id -> clipKey }`
     for the GPU shots.
   This is the one genuinely new mechanic: a workflow that drives a RunPod job
   end-to-end (vs the client/cron polling the normal render path). De-risk by
   reusing `submitFinalizeJob` + `pollRenderJob`.
4. **Cloud subset** (only if `cloudShots` non-empty): the existing per-shot
   `env.AI.run` i2v loop from `runCloudAnimate`, one durable step per shot,
   resolving `backends[shot].model || defaultCloudModel` -> `{ shot_id -> clipKey }`.
   (GPU step and the cloud loop can run concurrently via the workflow; simplest
   v1 runs GPU step then cloud loop sequentially.)
5. **Assemble**: merge both maps, order by shot_id, `runVideoFinish(clips ordered)`
   -> `renders/<proj>/<jobId>/hybrid_full.mp4`; re-put with owner customMetadata.
6. **finalize-row**: COMPLETED; `output_json.clips = [{shot_id, key, backend, model?}]`
   so History can label each shot's backend (badge "hybrid").
7. **notify + write-log** (reused from v0.146.0).

Failure policy v1: any shot/subset failure fails the row (mirrors cloud_animate);
the per-render log names the culprit. Partial/continue-on-error is a follow-up.

## UI

Extend the 4a keyframe-strip per-shot picker: each shot gets a backend choice
(**GPU Wan** | **Cloud · <model>**), revealed on a new "Motion: Hybrid" option
in the finalize-row backend `<select>`. Submit collects `backends`. Completed
rows badge "hybrid" and label each clip's backend (the v0.146/4a clip-label spot).
Reuses `CLOUD_I2V_MODELS`.

## Edge cases / open questions

- **Clip consistency**: Wan vs cloud clips differ in size/fps/duration;
  `video-finish` normalizes (width/height/fps params) -- set the film's target
  explicitly so both lanes converge. Confirm beat-sync trim still applies.
- **GPU off-GPU-finish trigger** (RESOLVED, live): set
  `render_overrides.finish_offloaded = true` + `process_shot_ids = <gpu subset>`
  on the finalize submit. Pod (SkyPhusion/vivijure-serverless#17, shipped
  serverless-v0.6.0, deployed) returns `clips: [{ key, shot_id, target_seconds? }]`
  for the subset, NO on-GPU assembly. Top-level `mode` stays `"finalized"` even on
  this path -- key off `finish_offloaded` / the clips, not `mode`. (Earlier this
  section guessed `n`; the actual flag is `finish_offloaded`.)
- **Wait time**: GPU finalize is ~20-30 min, cloud is minutes; the workflow waits
  for the slower lane. Progress should report both lanes (extend the
  `setCloudAnimateProgress` marker to "gpu k/N + cloud m/M").
- **Cost surfacing** (dialog): GPU per-minute scale-to-zero vs cloud per-second
  per provider; show a rough split estimate.
- **LoRA / cast**: the GPU finalize subset still trains/reuses cast LoRAs as
  normal finalize does; cloud shots ignore them. Fine; no change.

## Implementation slices

1. **Backend + workflow** (the substance): data model + `normalizeHybridBackends`
   (pure, tested) + `/animate-hybrid` route + `hybrid_animate` workflow kind
   (GPU subset finish-offloaded + cloud subset + unified assembly). API-drivable.
2. **UI**: per-shot backend picker + hybrid badge + per-clip backend label.
3. **Polish**: dual-lane progress, cost hint, partial-failure policy.

## Code seams (grounded, for the implementer)

- `src/runpod-submit.ts` `submitFinalizeJob` / `buildFinalizePayload` / `FinalizeArgs.processShotIds`.
- `src/video-finish.ts` `finishInputFromPodOutput`, `runVideoFinish`.
- `src/index.ts` `resolveOffloadedFinish` (2456), `runCloudAnimate` (the per-shot loop + assemble + finalize-row), `pollRenderResolved` `cloud-` guard.
- `src/storyboard-validate.ts` `normalizePerShotModels` (pattern for `normalizeHybridBackends`).
- `public/planner.js` `CLOUD_I2V_MODELS`, the keyframe-strip per-shot picker (4a), `animationVersionLabel`.
- Pod (reference only, no change): `orchestrator.finalize` + `process_shot_ids`; off-GPU finish via override `n`.
