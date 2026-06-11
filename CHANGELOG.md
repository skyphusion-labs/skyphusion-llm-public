# Changelog

## v0.162.2

Fix: a successful plan left the Refine / Audio / Preflight sections hidden (follow-on to v0.162.1).

The v0.162.1 eviction correctly nulled `planState.storyboard` before the fetch, but
`renderPlanResult` then called `showRefineSection()`, `showAudioSection()`, and
`showPreflightSection()` -- all three of which gate on `planState.storyboard` -- BEFORE
`showBundleStage()`, the only place the storyboard was set back to the freshly planned value. So
after every successful plan those three sections saw a null storyboard and stayed hidden (or showed
their "plan first" placeholder). The fix assigns `planState.storyboard = data.storyboard` at the top
of the success branch, before any section-show call; `showBundleStage()` still sets it again to the
same value, so the early assignment only makes the ordering deterministic. Caught by the full e2e
regression run on the live site.

### Code
- `public/planner.js`: set `planState.storyboard` at the top of the `renderPlanResult` success branch, before the `showXxxSection()` calls
- `package.json`: 0.162.1 -> 0.162.2

typecheck green; unit suite 608/608 green; regression confirmed against the live planner.

## v0.162.1

Fix: stale localStorage leaks a previous project's storyboard into a new brief (issue #4).

Three changes close the regression. First, `plan()` now nulls `planState.storyboard`,
`planState.originalStoryboard`, and `planState.refineHistory`, hides `#planner-output`, clears
`#planner-output-state`, and calls `savePersistedState()` synchronously before the fetch fires --
so the YAML view can never display a prior project's output during the in-flight window. Second,
`resetBundleStage()` now also clears `bundleState.sceneStartImages`, which was the one field left
behind when re-planning. Third, the "clear brief" button is promoted to a full session reset
("new / reset"): it clears the brief, storyboard, audio bed, bundle, render, and the persisted
snapshot in one shot, giving users an explicit affordance to start clean without resorting to
console workarounds.

### Code
- `public/planner.js`: evict stale storyboard in `plan()` before fetch; clear `sceneStartImages` in `resetBundleStage()`; full reset in `#planner-brief-clear` handler
- `public/planner.html`: rename "clear brief" button to "new / reset", update title
- `package.json`: 0.162.0 -> 0.162.1

typecheck not applicable (planner.js is vanilla JS); verified with headless-Chrome harness on mindcrime (6/6 pass).

## v0.162.0

Feat: scatter/gather distributed-render UI + history nesting (GH #2).

**Submit UI (Part A):** adds a "distributed render (scatter/gather)" checkbox and a
shard-count input to the Render step. The checkbox is disabled with a descriptive reason
when fewer than 2 shots are present or no character slot is bound (scatter requires
`castLoras` to be non-empty -- the server hard-400s otherwise). The shard-count input is
hidden until the checkbox is checked and clamped to `[2, shotCount]`. On submit, calls
`submitScatterRender()` which POSTs to `/api/storyboard/render/scatter` with `shotIds`
derived via `sceneIdAt` (matching the GPU's per-shot clip filenames), then drives the
existing `renderState` poll/stream loop against the returned `scatter-<uuid>` jobId.

**History nesting (Part B):** scatter shard children are no longer shown as individual
top-level cards. `renderHistoryList` builds a `scatterParentIds` set (rows whose `job_id`
starts with `scatter-`), then skips any child whose `parent_id` is in that set. The
scatter parent card gains a "distributed -- N shards" badge and, while `SCATTERING`,
shows "k of N shards complete" progress computed from `childrenByParent`. Non-scatter
parent/child rows (keyframes-from, animate) are unaffected.

Files: `public/planner.html`, `public/planner.js`, `public/styles.css`.

## v0.161.1

Fix: the cron notify-sweep phantom-failed live scatter renders. A `scatter-<uuid>` parent is a
synthetic row that OWNS N RunPod shard jobs; it is not itself a RunPod job. The every-3-min
notify sweep (`scheduled`) RunPod-polled every non-terminal render row, so it queried RunPod for
the synthetic parent id, got a 404, and the phantom-job classifier marked the whole gather
FAILED mid-run, exactly the cloud-animate class of bug fixed in v0.146.1. Caught on the very
first live multi-job scatter, where the three shards were healthy and IN_PROGRESS on RunPod the
entire time the parent was being false-failed.

The fix makes the sweep scatter-aware, mirroring the cloud-animate guard:
- `pollRenderResolved` short-circuits `scatter-` parents (serve a terminal row cached, else
  "confirming"), so no caller can phantom-fail a gather.
- the `scheduled` sweep now DRIVES a scatter parent's gather via `resolveScatterGather` instead
  of RunPod-polling it, so a fire-and-forget scatter (no client polling) still refreshes its
  shards, merges on the last clip, reaches a terminal status, and notifies once.
- the sweep query excludes shard children (`parent_id IS NOT NULL`): the parent's gather owns
  their lifecycle and the single completion notify, so a shard is never swept or emailed alone.

Validated end-to-end against a live multi-job render: a 10-shot / 3-shard draft scatter of the
neon_halflife board (reusing the trained Vesper/Rhode LoRAs, no retrain) split [4,3,3], ran three
parallel RunPod jobs, and the gather assembled one MP4.

### Code
- `src/index.ts`: `pollRenderResolved` `scatter-` guard; `scheduled` sweep drives `resolveScatterGather` for scatter parents (and `continue`s past the RunPod path); `getRenderOwnerEmail` import
- `src/renders-db.ts`: `getRenderOwnerEmail` (new); `listUnresolvedNotifiableJobs` excludes shard children (`AND parent_id IS NULL`)
- `package.json`: 0.161.0 -> 0.161.1

typecheck clean; 608 tests pass.

## v0.161.0

Feature: distributed scatter/gather rendering. A storyboard render can now be split across N
parallel RunPod jobs and gathered into one MP4, dropping wall-clock to ~T/N at the same
GPU-second cost.

The backend enablers already shipped (`process_shot_ids` subset renders, `pretrained_loras`
staging, `finish_offloaded` per-shot clips); this is the control-plane conductor that drives
them. `POST /api/storyboard/render/scatter` resolves the cast LoRAs (which must already be
trained + ready for a scatter, a shard that retrains would defeat the parallelism and risk
per-shard identity drift), splits the storyboard into N finish-offloaded shard jobs that reuse
the pre-trained adapters, and writes a synthetic `scatter-<uuid>` parent renders row plus one
child row per shard (linked by `parent_id`, with the shard's shots stored on it). Polling the
parent at `GET /api/storyboard/render/<scatter-uuid>` routes to the gather watcher: it polls
each shard, checks clip presence across the whole storyboard, and on the last clip assembles
ONE MP4 via the video-finish container, D1-locked on the parent job (the same idempotency model
as the single-job offloaded finish). A dead shard with shots still missing fails the parent;
otherwise it reports per-shot progress.

Also exposes `processShotIds` on the render submit path (the backend `orchestrator.plan()`
already scopes scenes to `process_shot_ids` for any action; only `finalize` carried it before).

NOT YET VALIDATED against a live multi-job render; the pure conductor logic is unit-tested.

### Code
- `src/scatter.ts` (new): `splitShots`, `buildShardJobs`, `gatherDecision`, `scatterParentJobId` / `isScatterParentJobId`
- `tests/scatter.test.ts` (new): 14 tests for the conductor core
- `src/runpod-submit.ts`: `processShotIds` on `RenderSubmitArgs` / `process_shot_ids` on `RenderJobInput`; `buildSubmitPayload` emits it
- `src/renders-db.ts`: `getRenderIdByJobId`, `getScatterChildren`
- `src/index.ts`: `handleScatterSubmit` + `resolveScatterGather`, the `scatter-` poll branch, the `POST /api/storyboard/render/scatter` route, imports
- `package.json`: 0.160.0 -> 0.161.0

typecheck clean; 608 tests pass.

## v0.160.0

Feature/fix: the "render keyframes only" checkbox produced a full render with motion
(a silent MP4) instead of stopping at SDXL keyframes. Same envelope-shape family as the
v0.159.1 LoRA bug: a contract field the consumer never read.

Cause: keyframes-only was sent as `render_overrides.keyframes_only`. The retired
vivijure-serverless honored that flag by short-circuiting after the SDXL pass; the
clean-room vivijure-backend dispatches on the `action` field ONLY and never read the
flag (`grep keyframes_only` across the backend: zero hits), so a keyframes-only request
ran the full train -> keyframes -> i2v -> assemble path. The flag was a dead passenger
on the wire.

Fix: keyframes-only is now a first-class `action: "preview"` (vivijure-backend
`Action.PREVIEW`, backend-v0.1.12), exactly like `finalize` / `train_lora`. `buildSubmitPayload`
sets `input.action = "preview"` when `keyframesOnly` is true and no longer folds anything into
`render_overrides`; `normalizeRenderOverrides` drops `keyframes_only` from its wire flags (only
`finish_offloaded` remains). Routing is one word now, traceable producer -> consumer. The public
`keyframesOnly` request field and the `keyframes-only` render `mode` are unchanged; only the
pod wire representation moved.

DEPLOY ORDER: requires the backend `preview` action live first (tag `backend-v0.1.12`).
Sending `action: "preview"` to an older backend falls back to `render` (`Action.parse`), i.e.
today's full-render behavior -- no regression, but not the fix until both are deployed.

### Code
- `src/runpod-submit.ts`: `RenderJobInput.action?: "preview"`; `buildSubmitPayload` sets it from
  `keyframesOnly`; `normalizeRenderOverrides` drops the `keyframes_only` flag + the `opts` arg
- `src/index.ts`: render-request `keyframesOnly` comment now points at `action="preview"`
- `docs/render-api.md`: routing-flags note + keyframes-only description
- `tests/runpod-submit.test.ts`: preview-action assertions; dropped the obsolete flag/opts cases
- `package.json`: 0.159.1 -> 0.160.0
- typecheck: clean; tests: green

## v0.159.1

Fix: cast LoRA training appeared broken on the clean-room backend. The job trained
and uploaded the adapter fine, but the cast page never flipped `lora_status` to
`ready` -- so the UX looked stuck and a later render retrained from scratch.

Cause: a clean-room <-> control-plane envelope-shape mismatch (same family as the
render_overrides disconnect). The harvest code read a top-level `output.lora_key`
(the old vivijure-serverless shape); the clean-room backend returns the key NESTED
under `output.lora[slot].lora_id`. So the harvest always missed it and marked the
job "completed but envelope did not include lora_key".

New `extractTrainedLoraKey(output)` reads both shapes (nested first, legacy
top-level fallback) and is used by both harvest sites -- `handleCastLoraStatus`
(the cast-page poll) and `refreshTrainingLora` (the self-heal at render-submit) --
so they can't drift again. No backend change.

### Code

- `src/lora-bundle.ts` - add `extractTrainedLoraKey`.
- `src/index.ts` - both harvest sites use it (was: top-level `lora_key` only).
- `tests/lora-bundle.test.ts` - new; pins the nested + legacy shapes.
- `package.json` - 0.159.0 -> 0.159.1.


## v0.159.0

Item D groundwork: the multi-job GATHER core for distributed (scatter/gather) renders.
Purely additive -- new exported helpers in `video-finish.ts`, no existing path changed.

Distributed renders fan a single film's shots across N RunPod workers (each renders a
`process_shot_ids` subset with `finish_offloaded`, writing per-shot clips to R2), so the i2v
long pole becomes max-of-shots instead of sum-of-shots. Every backend primitive for that is
already shipped (the shot-subset render path, the R2-pull of reused LoRAs, per-shot clip keys,
the off-GPU finish container, the progress channel). What was missing is the control-plane piece
that merges clips no single job owns -- this adds it:

- `clipKey(project, shotId)` / `finishOutputKey(project)` -- the canonical R2 keys
  (`renders/<slug>/clips/<shot_id>.mp4`, `renders/<slug>/full.mp4`), byte-identical to the
  backend's `keys.clip_key` (via the shared `renderSlug`), so they address the SAME objects the
  shot-workers write.
- `finishInputFromClipKeys(project, orderedShotIds, opts)` -- builds a `VideoFinishInput` by
  addressing clips directly by project + storyboard order (vs `finishInputFromPodOutput`, which
  reads one job's manifest), so it merges whatever N shot-jobs wrote. Reuses the existing
  `runVideoFinish` + `VIDEO_FINISH` container unchanged.
- `gatherClipPresence(env, project, shotIds)` -- the gather signal: which shots already have a
  clip in R2 (cheap `R2_RENDERS.head`), so a scatter render is finishable when all are present.

Next (separate PR): the gather-finish endpoint + the fan-out orchestrator that submits the N
shot-jobs and auto-triggers the finish. This PR is the reusable core they build on.

### Code

- `src/video-finish.ts` - add `clipKey`, `finishOutputKey`, `GatherFinishOpts`,
  `finishInputFromClipKeys`, `gatherClipPresence`; import `renderSlug`.
- `tests/video-finish.test.ts` - cover the key layout, the assembler (order / targetSeconds /
  finish params / null-on-empty), and the gather signal (present/missing split, head-rejection
  tolerance).
- `package.json` - 0.158.0 -> 0.159.0.
- typecheck clean; tests pass (video-finish suite 22, full suite green). No backend/contract change.

## v0.158.0

Rework the planner render step to the namespaced `render_overrides` contract,
the UI counterpart to v0.157.0. The advanced-settings panel had ~115 controls
feeding the old flat `render_overrides` keys + the ~24 vivijure-serverless
`*Overrides` blocks -- all dropped by the clean-room backend (v0.157.0). They were
dead controls that looked live: a user could set adetailer / consistency / wan
negatives / lora scale and nothing reached the pod.

Now every control traces 1:1 to a `config.py` field, or it's gone (Conrad's call:
"if it's not in the config or the storyboard right now, it goes"). The panel is
regrouped under three disclosures -- **keyframe** (seed, size, base model,
guidance, steps, identity method + scales, and `multi_char` regional/pose/per-slot
scales/max-slots/pose-scale), **i2v** (model, num_frames, steps, guidance, fps,
flow_shift), **lora** (rank, max_steps, lr, resolution) -- and `buildRenderOverrides`
emits `{ keyframe, i2v, lora }`. The expert raw-JSON textarea is restricted to those
sections + the routing flags (`keyframes_only` / `finish_offloaded`); a stray flat
key is dropped, so the planner never emits anything outside the contract.

Removed (~90 controls, no `config.py` home): adetailer, consistency, continuity,
character-generation/bible, image-prompting, scene-length, movie, production,
top-level-switches, quality-gate, ffmpeg-quality, image-models, lora-train-extras,
prompt-templates, the base-SDXL local_diffusion knobs, the multi_char geometry
extras, the face_lock repo/model fields, and flat misc (output w/h, crossfade, the
old single `lora_scale`, `seed_mode`, `identity_lock`). Their builder functions,
help text, state/prefs persistence, and event wiring all go with them.

### Code

- `public/planner.js` - rewrite `buildRenderOverrides` to emit `{keyframe,i2v,lora}`
  (textarea restricted to sections + flags); delete `collectOverrideBlocks` + 24
  dead `build*Overrides` functions (~32 KB) and the two `Object.assign(...,
  collectOverrideBlocks())` merges (render + finalize); rewrite `FIELD_HELP` to 25
  brief, accurate entries; prune the dead controls from state save/restore, prefs,
  and event wiring. Pure-function tested; all removed-control refs are null-safe.
- `public/planner.html` - replace the ~115-control advanced panel with the
  keyframe / i2v / lora disclosures (survivor IDs preserved, no duplicates); trim
  the common row (drop lora_scale + consistency); drop the prompt_templates expert
  textarea; rewrite the raw-JSON textarea to the namespaced shape (91 KB -> 39 KB).
- `package.json` - 0.157.0 -> 0.158.0.
- No src/ or backend change. typecheck clean; 583 tests pass (src unaffected).

## v0.157.0

Redesign the render-submit contract to the namespaced `render_overrides`
`{ keyframe, i2v, lora }` shape the clean-room `vivijure-backend` actually reads,
and drop everything not in that spec.

The control plane had accumulated ~24 flat `*Overrides` blocks
(`multiCharacterOverrides`, `wanDiffusionOverrides`, `loraTrainOverrides`,
`qualityGateOverrides`, `consistencyOverrides`, `adetailerOverrides`, ...) built
against the old `vivijure-serverless` pod, which read them via per-module
`set_overrides`. The clean-room backend that actually runs now reads ONE thing --
`render_overrides.{keyframe,i2v,lora}` parsed by `config.py
RenderConfig.from_request` -- and ignores unknown sections. So every one of those
blocks was being serialized onto the wire and then silently dropped on the pod
(the contract-completeness audit, `~/vivijure-audit-F-contract.md`). Advanced
knobs set by a caller did nothing; renders ran at the `qualityTier` baseline
regardless.

This collapses the surface to the real contract:

- `renderOverrides` is now the namespaced `{ keyframe, i2v, lora }` object plus the
  routing flags the backend reads off the raw dict (`keyframes_only`,
  `finish_offloaded`). `normalizeRenderOverrides` keeps only those known sections
  (objects) and flags (booleans) and drops the rest; the pod re-clamps every value.
- All 23 out-of-spec `*Overrides` interfaces + their normalizers are deleted from
  `runpod-submit.ts`; the render-submit, finalize, and train-lora request bodies +
  arg assembly in `index.ts` no longer parse or forward them. Standalone LoRA
  training hyperparams now ride `render_overrides.lora`.
- `docs/render-api.md` documents the namespaced contract (it previously claimed
  "each block routes to the matching pod config block", which was true for
  vivijure-serverless but not the clean-room backend).

No planner-UI change: `app.js` / `planner.js` never assembled these blocks (they
were a curl-contract-API surface), so nothing user-facing in the planner regresses.

### Code

- `src/runpod-submit.ts` - delete 23 `*Overrides` interfaces + 23 normalizers; add
  `normalizeRenderOverrides`; rewrite `buildSubmitPayload` / `buildFinalizePayload` /
  `buildTrainLoraPayload` to emit `render_overrides.{keyframe,i2v,lora}`; trim
  `RenderSubmitArgs` / `RenderJobInput` / `FinalizeArgs` / `FinalizeJobInput` /
  `TrainLoraArgs` / `TrainLoraJobInput` to the in-spec fields (net -1537 lines).
- `src/index.ts` - drop the 23 override fields from the render-submit body type +
  arg assembly; strip the finalize handler's body-override plumbing (it keeps
  `renderOverrides: row.render_overrides`); switch the train-lora handler to
  `renderOverrides` (net -445 lines).
- `docs/render-api.md` - rewrite the override section to the namespaced contract.
- `tests/runpod-submit.test.ts` - replace the deleted-normalizer suites with a
  `normalizeRenderOverrides` suite; update the builder tests for namespaced filtering.
- `package.json` - 0.156.3 -> 0.157.0.
- typecheck clean; 583 tests pass (36 files).

## v0.156.3

Restore the `standard` quality tier (v0.156.1 removed it in error). The removal was on the
belief that the pod's `for_tier` only branches draft vs final -- it does not. Both
`KeyframeConfig.for_tier` and `I2VConfig.for_tier` in the backend `config.py` branch all
THREE tiers, and standard is a genuinely distinct middle: 8-step distilled keyframes + a
20-step EasyCache i2v pass (vs draft's 4-step Lightning and final's 30-step keyframe +
40-step MixCache). Dropping it hid a real capability and collapsed any `standard` request
to `final`.

`coerceQualityTier` now passes `standard` through (was: coerce to `final`); the `qualityTier`
unions, the planner picker, the validation messages, and the render-api doc are widened back
to draft|standard|final. (Caught by the contract-completeness audit reading the `for_tier`
bodies, not the `KeyframeConfig` docstring whose one-line summary omits standard.)

### Code

- `src/runpod-submit.ts` - `coerceQualityTier` returns standard unchanged; unions -> draft|standard|final.
- `src/index.ts` - unions + validation messages -> draft|standard|final.
- `public/planner.html` - restore the standard `<option>` (8-step keyframes + 20-step EasyCache i2v).
- `docs/render-api.md` - qualityTier row + per-tier descriptions restored.
- `tests/coerce-quality-tier.test.ts` - standard passes through (was: coerces to final).
- `package.json` - 0.156.2 -> 0.156.3.
- typecheck clean; full suite 610 green.

## v0.156.2

Off-GPU finish now actually fires for an offloaded render. The control plane's
`resolveOffloadedFinish` keyed on `out.finish_offloaded === true`, and
`finishInputFromPodOutput` required `out.output_key` -- but a clean-room pod
`finish_offloaded` render emits per-shot clips with NEITHER (no flag, no merged
output_key), so the CF video-finish merge never ran: the render completed with clips
in R2 but no `full.mp4`. (Caught driving the A+B render verification.)

Recognize an offloaded render by its SHAPE -- per-shot clips and no merged output_key
(a normal render is the inverse) -- via a new `isOffloadedRenderOutput` predicate, and
derive the canonical `renders/<project>/full.mp4` target from the clips' `/clips/`
prefix when the pod omits `output_key`. The explicit `finish_offloaded` flag and an
explicit `output_key` (the cloud / hybrid paths) still work unchanged.

### Code

- `src/video-finish.ts` - new `isOffloadedRenderOutput`; `finishInputFromPodOutput`
  derives `<prefix>/full.mp4` when `output_key` is absent (was: return null).
- `src/index.ts` - `resolveOffloadedFinish` triggers on `isOffloadedRenderOutput(out)`
  instead of the never-sent `finish_offloaded` flag.
- `tests/offloaded-finish.test.ts` - new: 7 cases (the predicate + the target derive).
- `tests/video-finish.test.ts` - updated the missing-output_key case to assert the derive.
- `package.json` - 0.156.1 -> 0.156.2.
- typecheck clean; full suite green.

## v0.156.1

Drop the vestigial `standard` quality tier. The render tiers are `keyframe` (the
`keyframesOnly` preview flag), `draft` (4-step distilled), and `final` (full-step
high-cfg); the pod's `for_tier` only ever branched draft vs final, so `standard` was a
label that promised a tier that does not exist.

Removed `standard` from the `qualityTier` type unions, the planner picker, and the
render-api doc, and changed the adopt default from `standard` to `final`. A single
`coerceQualityTier` helper normalizes input: `draft` / `final` pass through, the legacy
`standard` coerces to `final` (so old History rows and any old client never 400),
anything else is an invalid tier. The consistency-mode `standard` option (a different
control entirely) is untouched.

### Code

- `src/runpod-submit.ts` - new `coerceQualityTier`; `qualityTier` / `quality_tier` unions
  narrowed to `"draft" | "final"`; `validateRenderContract` coerces; comments.
- `src/index.ts` - import + use `coerceQualityTier` across the submit / adopt / finalize /
  retry paths; adopt default `standard` -> `final`; validation messages -> `'draft' | 'final'`.
- `public/planner.html` - drop the `standard` quality-tier `<option>`.
- `docs/render-api.md` - union -> `draft | final`, examples `standard` -> `final`.
- `tests/coerce-quality-tier.test.ts` - new: 3 cases (pass-through, legacy coerce, invalid).
- `package.json` - 0.156.0 -> 0.156.1.
- typecheck clean; full suite 604 green.

## v0.156.0

Live render progress, read from R2 instead of SSH. The planner can now poll a
render's structured stage snapshot (training step, keyframe / i2v counts, last
event, error) through the control plane, no pod shell required.

The vivijure-backend worker writes a best-effort progress channel to R2 for every
render: a per-job snapshot at `renders/<project>/progress/<job_id>.json` (plus an
NDJSON event log) keyed by project AND job id. This adds the consumer side.
`GET /api/storyboard/renders/<id>/progress` looks up the render row scoped to the
caller's `user_email`, builds the snapshot key from its project + job id, and reads
it back through the existing `R2_RENDERS` (vivijure) binding, so there is no new
binding and no new secret. A missing object is reported as `pending` (the snapshot
lags the submit by a stage or two, and rows that predate the channel never get one),
an R2 read error is a 502, and a present snapshot is returned verbatim alongside the
DB status.

The key builder (`renderSlug` / `progressSnapshotKey`) mirrors the backend's
`harness/keys.py _slug` byte for byte and lives in its own module so vitest can cover
it; a drift there would silently 404 against a key the worker never wrote.

### Code

- `src/render-progress.ts` - new: `renderSlug` (mirror of the backend `_slug`),
  `progressSnapshotKey` / `progressLogKey`, and the `RenderProgressSnapshot` shape.
- `src/index.ts` - import the module; new `handleRenderProgress` (ownership-checked
  row lookup, then R2 snapshot read with pending / 502 / ok handling); route
  `GET /api/storyboard/renders/<id>/progress`.
- `tests/render-progress.test.ts` - new: 7 cases pinning `renderSlug` and the key
  builders to the backend `_slug` behavior.
- `package.json` - 0.155.0 -> 0.156.0.
- typecheck clean; `npx vitest run tests/render-progress.test.ts` 7/7 green.

## v0.155.0

Audio mux no longer re-encodes (or upscales) a finished render. Scoring a hybrid
film keeps its native 1280x720.

`add-audio` / `add-narration` mux a music bed (or TTS) onto an already-assembled
render via the `video-finish` container. The container is built to normalize and
concat raw per-shot clips, so it always ran `_normalize` (an explicit
`scale=...,pad=...` filter plus a `libx264` re-encode) on its inputs. The mux path
fed it a single finished MP4 with no `width`/`height`, so it fell back to the
container default (1920x1080) and a lossy re-encode. For a 1080p GPU render that
happened to match; for a 1280x720 hybrid or cloud render it upscaled the picture
into a 1080p frame and re-encoded it. Hybrid scoring is the headline case
(`docs/hybrid-verification-checklist.md` scores the silent `hybrid_full.mp4` with
`add-audio`).

This adds an audio-only remux path: when the caller is adding a bed to one finished
clip, the container stream-copies the video (`-c:v copy`, no scale/pad/re-encode) and
only adds the audio track, so the output keeps the source's exact resolution, fps,
and quality. Audio length handling is unchanged (pin to the video duration with `-t`,
pad a short bed with `apad`, cut a long one). The full normalize/concat path is
untouched for real multi-clip assembly.

### Code

- `containers/video-finish/app.py` - new `_remux_audio_only(work, video_path, audio_path)`
  (stream-copy video + mux bed, faststart); `finish` accepts `remuxAudioOnly` (requires
  exactly one clip) and branches to it instead of `_assemble`.
- `src/video-finish.ts` - `VideoFinishInput.remuxAudioOnly?: boolean`; `parseVideoFinishInput`
  validates it (boolean, single clip); `runVideoFinish` threads it into the container payload.
- `src/index.ts` - `muxAudioOntoRender` (the shared add-audio / add-narration helper) sets
  `remuxAudioOnly: true`.
- `tests/video-finish.test.ts` - 3 cases (accept single-clip remux, reject multi-clip, reject
  non-boolean).
- `package.json` - 0.154.0 -> 0.155.0.

typecheck clean; vitest 594/594 (3 new); `python3 -m py_compile containers/video-finish/app.py` clean.
Container + Workflow paths do not run under `wrangler dev`, so this needs a deploy +
one live `add-audio` on a 720p render to confirm the output stays 1280x720.

## v0.154.0

Phase 4 hybrid slice-3 polish: dual-lane progress, beat-sync trim on both lanes,
and continue-on-error partial success.

The hybrid finale (v0.151.0-v0.153.0) shipped a working GPU+cloud per-shot animator,
but slice-3 (the open questions in `docs/i2v-hybrid-backend.md`) was deferred. This
closes it:

- **Dual-lane progress (#1).** A single "done/total" counter hid which lane was
  moving during the ~20-30 min GPU finalize. The workflow now writes per-lane counts
  (`output.progress.gpu` / `.cloud`) and surfaces the pod's render fraction during the
  GPU wait, so the History row reads e.g. "GPU rendering 1/2 · cloud 3/3". The cloud
  lane now runs first (minutes, ticks per shot) so movement is visible immediately,
  then the GPU long pole. The overall `progress.done/total` is kept for the v0.146.0
  badge.
- **Beat-sync trim on both lanes (#4).** The assemble pass previously concatenated
  clips at their native i2v length (no trim), so a hybrid silently lost the beat-sync
  the all-GPU finalize gives. Now each clip is trimmed to its authored `target_seconds`:
  the bundle's `storyboard.yaml` (beat-synced films stamp `target_seconds` on every
  scene via `applyBeatTiming`) is the base, and the GPU off-GPU-finish manifest's
  `target_seconds` overrides for GPU shots. A film with no authored durations keeps
  native length (unchanged from cloud_animate).
- **Continue-on-error partial success (#3).** A single shot/provider hiccup used to
  fail the whole (expensive) run. Now a failed cloud shot or a failed GPU lane is
  recorded in `output.failed_shots` and skipped; the run assembles whatever succeeded
  and completes with `output.partial = true` (the row only fails if NO clip was made).
  The History row badges "partial (N failed)" with a per-shot tooltip.
- **Cost hint (#2).** The hybrid confirm dialog adds an honest, non-dollar cost line
  (GPU shots = one scale-to-zero pod render billed per-minute; cloud shots = per-second
  per provider). We have no per-provider price table, so no invented figures.

No schema change (all new fields live in `output_json`, like `clips[].backend` does).
Verification needs a live hybrid run (Workflows/Containers do not run under
`wrangler dev`); the next hybrid is its smoke test.

### Code
- `src/planner-yaml.ts` - `parseShotDurations` (extract `{shot_id -> target_seconds}`
  from an emitted `storyboard.yaml`).
- `src/bundle-assembler.ts` - `readShotDurationsFromBundle` (gunzip + readTar + parse).
- `src/renders-db.ts` - `setHybridProgress` (per-lane gpu/cloud + overall counter).
- `src/index.ts` - `runHybridAnimate`: cloud-lane-first ordering, per-lane progress,
  GPU render-fraction surfacing, storyboard+manifest beat-trim into `assemble`,
  continue-on-error with `partial`/`failed_shots`.
- `public/planner.js` - `hybridProgressText` (per-lane badge), partial badge, qualitative
  cost hint in the hybrid confirm dialog.
- `public/styles.css` - `.planner-history-mode-partial` badge style.
- `tests/planner-yaml.test.ts` - `parseShotDurations` coverage (6 new).
- `package.json` - 0.153.0 -> 0.154.0.
- typecheck clean; vitest 591/591 (6 new).

## v0.153.0

Hybrid GPU-lane keyframe parity: inject the parent's exact keyframes into the GPU
finalize bundle.

The hybrid (v0.151.0) GPU lane finalizes the parent's input bundle, which carries no
keyframes. The pod restores the project's shared `state.tar.gz` (last-render-wins, not
the specific parent row) before extracting the bundle, so the GPU lane could animate a
different keyframe generation than the cloud lane (which presigns the parent row's exact
R2 keyframe). Same project/seed -> usually identical; divergent if the project was
re-rendered between the preview and the hybrid.

Fix: the GPU lane now overlays the parent's keyframes into the finalize bundle at
`clips/<id>_keyframe.png`. Because the pod restores state THEN extracts the bundle
(`_restore_prior_state` -> `download_and_extract`), these overwrite the state-restored
frames and `i2v_only` reuses them -> the GPU lane animates the **same** keyframes the
cloud lane does, guaranteed. No pod change.

- `readTar` (ustar reader, inverse of `emitTar`) lets a bundle be spliced without
  re-assembling it from the storyboard + cast.
- `overlayKeyframesIntoBundle` (bundle-assembler): download `bundle_key` -> gunzip ->
  `readTar` -> splice the GPU shots' keyframes (from R2) -> `emitTar` -> gzip -> upload
  `bundles/<project>-hybrid-<jobId>.tar.gz`.
- `runHybridAnimate`: a `gpu-bundle-overlay` step builds that bundle; the GPU finalize
  uses it.

No schema change.

### Code
- `src/tar-emit.ts` - `readTar` (POSIX ustar reader).
- `src/bundle-assembler.ts` - `overlayKeyframesIntoBundle` + `gunzipBytes`.
- `src/index.ts` - hybrid GPU lane overlays the bundle before finalize.
- `tests/tar-emit.test.ts` - `readTar` round-trip + overlay-replace coverage.
- `package.json` - 0.152.0 -> 0.153.0.
- typecheck clean; vitest 585/585 (2 new).

## v0.152.0

Phase 4 finale, slice 2: the hybrid per-shot backend picker UI.

The v0.151.0 backend was API-only. The planner's Motion selector (on a keyframes-only
preview's finalize row) gains a third option, **"Hybrid (per-shot GPU/Cloud)"**. When
chosen, each keyframe's per-shot picker (the 4a strip control) reveals a **"GPU (Wan)"**
option alongside the cloud models, so the user sets each shot's backend; an unset shot
defaults to GPU. The submit builds the `backends` map and posts to
`/api/storyboard/renders/<id>/animate-hybrid`. Completed rows badge **"hybrid"** when
clips used both backends (read off `output.clips[].backend`).

GPU vs Cloud routing in the same control: the per-shot picker's `"gpu"` value -> a GPU
shot; a cloud-model value -> a cloud shot; the GPU option is hidden in plain Cloud mode
(where the picker stays cloud-models-only) and a stale `"gpu"` pick is reset on switch.

Frontend-only; no API change (the endpoint shipped in v0.151.0).

### Code
- `public/planner.js` - "Hybrid" Motion option; per-shot GPU option (hidden outside
  hybrid); 3-way change + submit routing; `animateHybridRender`; "hybrid" version badge.
- `package.json` - 0.151.0 -> 0.152.0.
- node --check + typecheck clean; vitest 583/583.

## v0.151.0

Phase 4 finale, slice 1: GPU+cloud hybrid i2v backend + workflow (API-drivable).

Animate one keyframes-only render across BOTH motion backends in a single film -- some
shots on the GPU (pod Wan i2v) and some on a cloud i2v model -- then assemble all the
clips into one silent MP4. This is the backend + orchestration; the per-shot backend
picker UI is slice 2.

- **`POST /api/storyboard/renders/<id>/animate-hybrid`**
  `{ backends?: { shot_id: { backend: "gpu"|"cloud", model? } }, defaultBackend?,
  defaultCloudModel?, motionPrompts?, prompt? }` on a COMPLETED keyframes-only render.
  Validated by the pure, tested `normalizeHybridBackends`. Returns a `cloud-<uuid>`
  jobId (workflow-backed; the v0.146.1 `pollRenderResolved` `cloud-` guard already
  protects it).
- **`hybrid_animate` LongRunWorkflow**: partitions shots by backend; the **GPU subset**
  runs as ONE finalize with `render_overrides.finish_offloaded=true` +
  `process_shot_ids` (pod SkyPhusion/vivijure-serverless#17, live in serverless-v0.6.0 --
  emits per-shot clips, no on-GPU assembly), polled to terminal with a durable
  `step.do` + `step.sleep` loop; the **cloud subset** reuses the `cloud_animate` per-shot
  `env.AI.run` loop. Both lanes yield `{ shot_id -> clipKey }` in R2; a final
  `runVideoFinish` concats them in shot order into `hybrid_full.mp4`. Row mode stays
  `cloud-finalized`; `output.clips[].backend` tags each clip so the UI can badge "hybrid".
  Progress / completion-notify / gateway-log / parent_id linkage all reused.

No schema change. Spec: `docs/i2v-hybrid-backend.md`. The N-single-shot-finalize
fallback is dropped now that #17 is live (one finalize covers the whole GPU subset).

### Code
- `src/storyboard-validate.ts` - `normalizeHybridBackends` (pure validator).
- `src/index.ts` - `/animate-hybrid` route + `handleAnimateHybridSubmit`;
  `HybridAnimateParams` + `hybrid_animate` dispatch + `runHybridAnimate` workflow.
- `tests/storyboard-validate.test.ts` - `normalizeHybridBackends` coverage.
- `docs/i2v-hybrid-backend.md` - finish_offloaded trigger resolved (was guessing `n`).
- `package.json` - 0.150.0 -> 0.151.0.
- typecheck clean; vitest 583/583 (4 new).

## v0.150.0

Phase 4b close-the-loop: render directly from a bundle's injected keyframes (GPU i2v),
no pod change.

The reverse bridge wrote per-scene keyframes into the bundle at
`clips/<id>_keyframe.png`, but nothing fed them to the GPU without the SDXL keyframe
pass overwriting them first. Verified against the pod (vivijure-src/core.py): only the
`finalize` / i2v_only action reuses an on-disk keyframe; the normal + keyframes-only
passes regenerate it. So this adds a control-plane path that submits the pod's
**finalize/i2v_only action directly against a fresh bundle** — the pod skips SDXL gen
and animates the injected `clips/<id>_keyframe.png`, with no pod change.

- **`POST /api/storyboard/render-from-keyframes`** `{ project, bundleKey, qualityTier?,
  renderOverrides?, audioKey? }` — submits `buildFinalizePayload` (action `finalize`)
  against the given bundle (no prior render row needed, so no keyframe-gen pass to
  overwrite the injected frames). Persists a history row; poll via the existing
  `GET /api/storyboard/render/<jobId>`.
- **Planner**: the bundle result panel gains a "render from keyframes (GPU i2v)" button
  when the bundle included per-scene keyframes; it posts to the new endpoint and the row
  polls in History like any render.

The pod builds the manifest from `storyboard.yaml` on demand for a fresh bundle, so
this is the standalone i2v entry the reverse bridge needed. A live end-to-end smoke
test of a fresh-bundle finalize is the remaining confirmation (see
`~/vivijure-reverse-bridge-pod-handoff.md`). An optional pod enhancement (Option A) to
also honor injected keyframes in the *normal* render path is handed off there too; it
is not required now that this endpoint exists.

No schema change.

### Code
- `src/index.ts` - `POST /api/storyboard/render-from-keyframes` + `handleRenderFromKeyframes`.
- `public/planner.js` - "render from keyframes (GPU i2v)" button on the bundle result +
  `renderFromKeyframes`.
- `docs/i2v-backend-selector.md` - Phase 4b loop-closing endpoint documented.
- `package.json` - 0.149.0 -> 0.150.0.
- node --check + typecheck clean; vitest 579/579.

## v0.149.0

Phase 4b UI: attach a per-scene start keyframe at the bundle step.

The v0.148.0 backend accepted `sceneStartImages` but nothing in the planner produced
it. The bundle stage now has an optional collapsible "per-scene start keyframes"
section: one row per scene (id + prompt snippet + a file picker). Attaching an image
stages it to R2 via the existing `/api/storyboard/character-ref` path (so the JSON
body stays small and the key survives a reload, like character refs), and `bundleNow`
sends `sceneStartImages: { sceneId: { key } }`. The assembler writes each to
`clips/<id>_keyframe.png`, which the pod uses as that scene's Wan i2v start frame.
Scene ids resolve the same way the validator/pod do (explicit id, else `shot_NN`).

Frontend-only; no API change (the endpoint already accepts the field). Staged keys
persist through the bundle-stage stash so a tab reopen restores them.

### Code
- `public/planner.html` - collapsible per-scene keyframe section in the bundle stage.
- `public/planner.js` - `bundleState.sceneStartImages`; `renderSceneKeyframes` +
  `sceneIdAt`; `showBundleStage` reset/restore (4th arg); `bundleNow` sends the field;
  persisted in `collectBundleStageState` / `restoreBundleStagePanel`.
- `public/styles.css` - per-scene picker styles.
- `package.json` - 0.148.0 -> 0.149.0.
- node --check clean; typecheck clean; vitest 579/579 (frontend not under the pool).

## v0.148.0

Phase 4b (control-plane half): the reverse bridge -- per-scene start images in the
bundle, so externally-authored keyframes drive the pod's Wan i2v motion.

The cloud lane could already animate authored keyframes; the GPU lane could not (the
bundle carried only a top-level `start_image`, so the pod's Wan path had no per-scene
injection point). The pod's render path already reads each scene's start frame from
`scene.start_image`, falling back to `<project_dir>/clips/<id>_keyframe.png`
(verified in vivijure-src/core.py, not assumed), so the bridge is purely a bundle
addition with **no pod change**.

- `assembleBundle` accepts `sceneStartImages: { sceneId -> TrainingImage }` and writes
  each to `clips/<sceneId>_keyframe.png` in the bundle. Keys are validated against the
  storyboard's scene ids (a typo errors rather than shipping an unread keyframe).
  Bytes go in raw (no background removal -- these are full frames, not portraits).
- `POST /api/storyboard/bundle` accepts `sceneStartImages` and threads it through.

This is the backend half. The planner UI for attaching a keyframe per scene at the
bundle step is the next step. End-to-end validation also waits on the pod's FULL Wan
i2v render path being proven on the new volume-free worker (keyframes-only is proven;
full render is the remaining unproven path on that side).

No schema change.

### Code
- `src/bundle-assembler.ts` - `sceneStartImages` -> `clips/<id>_keyframe.png`, scene-id
  validated; layout comment updated.
- `src/index.ts` - `/api/storyboard/bundle` accepts + forwards `sceneStartImages`.
- `tests/bundle-assembler.test.ts` - per-scene keyframe written; unknown id rejected.
- `docs/i2v-backend-selector.md` - Phase 4b control-plane half marked shipped.
- `package.json` - 0.147.0 -> 0.148.0.
- typecheck clean; vitest green (2 new).

## v0.147.0

Phase 4a: per-shot cloud-model mixing for the cloud animation backend.

A cloud animation ran every keyframe through one model. This lets a single run mix
models across shots, e.g. the standoff on Runway Gen-4.5 (photoreal-friendly) and the
atmosphere shots on Seedance, in one assembled MP4.

- **API**: `POST /api/storyboard/renders/<id>/animate-cloud` accepts an optional
  `perShot: { shot_id: modelId }`. Each override must be an image-input video model
  (same gate as the default `model`); a bad entry 400s rather than silently falling
  back. Shots without an override use `model`. Validated by the pure, tested
  `normalizePerShotModels`.
- **Workflow**: `runCloudAnimate` resolves `perShot[shot] || model` per shot, records
  each clip's actual model in `output.clips[].model`, and the per-render gateway log
  already traces per-shot model.
- **UI** (`planner.js`): each keyframe in the preview strip gets a per-shot model
  picker ("(default)" + the image-input catalog), revealed only when the Cloud
  backend is chosen; the submit collects the overrides. Completed rows label each
  clip with its model, and the version badge reads "cloud · mixed" when a run used
  more than one. The cloud catalog is now a single `CLOUD_I2V_MODELS` const shared by
  the default dropdown and the per-shot pickers.

No schema change (per-shot models live in the existing `output_json`).

### Code
- `src/storyboard-validate.ts` - `normalizePerShotModels` (pure validator).
- `src/index.ts` - animate-cloud submit parses/validates `perShot`; `CloudAnimateParams`
  + `runCloudAnimate` thread per-shot model into gen, log, and `clips[].model`.
- `public/planner.js` - per-shot pickers, mixed-model badge, per-clip model label,
  shared `CLOUD_I2V_MODELS`.
- `public/styles.css` - per-shot picker + clip model-label styles.
- `tests/storyboard-validate.test.ts` - `normalizePerShotModels` coverage.
- `docs/i2v-backend-selector.md` - Phase 4a marked shipped.
- `package.json` - 0.146.1 -> 0.147.0.
- typecheck clean; vitest green (new validator tests).

## v0.146.1

Fix: stop the cron sweep / SSE stream from false-failing in-flight cloud
animations as "phantom" RunPod jobs.

`pollRenderResolved` RunPod-polls a job and, on a 404 past the 150s grace window,
marks the row FAILED ("RunPod has no record of this job"). Cloud-animate jobs
(`cloud-<uuid>`) are workflow-backed, not RunPod jobs, and run for minutes (one
provider call per shot). The GET poll handler already short-circuited them, but
the **cron notify sweep** and the **SSE stream resolver** call `pollRenderResolved`
directly with no guard, so a cloud render in flight got 404'd and phantom-failed
mid-run while its shots were still completing at the provider (visible as
"completing in AI Gateway but FAILED in the control panel"). Earlier cloud runs
only survived by luck of sweep timing; longer ones lose the race every time.

The guard now lives inside `pollRenderResolved` so all three callers are covered:
a `cloud-` job is served from its own row (terminal -> cached; still running ->
"confirming", i.e. keep waiting) and is never RunPod-polled or phantom-failed.
As a side benefit the sweep can now NOTIFY a completed cloud job instead of
failing it.

### Code
- `src/index.ts` - `pollRenderResolved` short-circuits `cloud-` job ids before
  the RunPod poll / phantom path; import `isTerminalStatus`.
- `package.json` - 0.146.0 -> 0.146.1.
- typecheck clean; vitest green.

## v0.146.0

Cloud i2v feedback: live per-shot progress, completion notification, and a
per-render AI Gateway log.

A cloud animation runs one provider call per shot over several minutes, and until
now it ran silently: no progress while it worked, no signal when it finished, and
the History "logs" link 404'd (the GPU log writer never ran for cloud rows). Three
additions close that:

- **Progress.** As each shot's clip lands, the workflow writes
  `output.progress = { done, total }`; the History row shows "animating k/N"
  (and "submitted" before the first shot) instead of a silent IN_PROGRESS.
- **Completion notification.** `runCloudAnimate` now calls the same
  `maybeNotifyRenderDone` path the GPU poller uses, so a finished (or failed)
  cloud animation emails / ntfy's the owner, gated on their prefs and claimed
  once so a workflow replay can't double-send.
- **AI Gateway log piping.** Each shot's gateway log id (`aiLogId`, captured
  right after the `aiRun`) is recorded, and on terminal the run writes a
  per-render log to the SAME conventional key as GPU jobs
  (`renders/logs/<jobId>.txt`) so the existing History "logs" link just works.
  The writer best-effort fetches each shot's gateway log object via
  `env.AI.gateway(GATEWAY_ID).getLog(logId)` (request/response/cost) and inlines
  it; a missing/expired id or disabled log storage degrades to the id alone.

No schema change. The notification reuses `notified_at` (v0.139.0). The per-shot
clip union + version badges land in v0.145.2; this builds on those rows.

### Code
- `src/render-log.ts` - `buildCloudAnimateLogText` (pure) + `writeCloudAnimateLog`
  (best-effort gateway `getLog` enrich, conventional-key write).
- `src/renders-db.ts` - `setCloudAnimateProgress` (guarded interim output_json write).
- `src/index.ts` - `runCloudAnimate`: capture per-shot log id, write progress,
  add `notify` + `write-log` steps, and notify + log on failure.
- `public/planner.js` - in-flight "animating k/N" badge; version label falls back
  to bare "cloud" before the model is known.
- `public/styles.css` - progress badge style.
- `tests/render-log.test.ts` - `buildCloudAnimateLogText` coverage (success + failure).
- `package.json` - 0.145.2 -> 0.146.0.
- typecheck clean; vitest green (new pure-builder tests added).

## v0.145.2

Link a derived animation back to the keyframes it was made from, and union the
rendered output onto those keyframes in History.

The `finalize` (GPU Wan) and `animate-cloud` (cloud i2v) endpoints each spawn a NEW
render row carrying the assembled MP4 and the per-shot clips, but that row had no
back-reference to the keyframes-only preview it derived from. `animate-cloud` even
computed a `parentId` and carried it through the workflow params, then dropped it on
the floor (no column, never stored). So the animated result was an orphan: the
keyframes preview never showed its animation, and the per-shot clips persisted in
`output_json.clips` were rendered nowhere. This adds the missing `renders.parent_id`
FK and uses it.

The join is 1:many on purpose: one keyframes preview can have a GPU finalize AND
one-or-more cloud animations (e.g. Runway and Hailuo) at once, so the UI does NOT
collapse a child onto the parent (which version would win?). Instead each animation
row unions ITS OWN per-shot clips onto the (shared) keyframe stills, labels itself by
version (`mode` + `output.model`, e.g. "cloud · gen-4.5", "GPU · Wan"), and links to
its parent; the keyframes preview shows a count of its derived animations. Versions
stay distinct, nothing overwrites.

Apply the migration delta to prod ONCE (additive, nullable; safe before the new code
deploys): `wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.145.2.sql`

```sql
ALTER TABLE renders ADD COLUMN parent_id INTEGER;
CREATE INDEX IF NOT EXISTS renders_by_parent
  ON renders(parent_id) WHERE parent_id IS NOT NULL;
```

Existing orphan rows back-fill by hand if desired (set `parent_id` to the preview's
id); new finalize / animate-cloud rows link automatically.

### Code
- `migrate-v0.145.2.sql` - new delta: `renders.parent_id` + partial index.
- `schema.sql` - same column + index mirrored for fresh DBs.
- `src/renders-db.ts` - `NewRenderRow.parentId` / `RenderRow.parent_id`;
  `insertRender` binds it; both SELECTs + `normalizeRow` carry it.
- `src/index.ts` - `animate-cloud` and `finalize` submits set `parentId: id`.
- `public/planner.js` - per-shot clip union onto keyframe stills; version badge;
  parent<->child cross-links; child index built in `renderHistoryList`.
- `public/styles.css` - clip thumb, version badge, cross-link chip styles.
- `package.json` - 0.145.1 -> 0.145.2.
- typecheck clean; vitest unchanged (UI/SQL not covered by the Node pool).

## v0.145.1

Loosen Runway i2v input moderation to its lowest documented setting.

The cloud i2v vendors moderate the input keyframe, and it false-positives on our own
AI-generated photoreal characters (flagged as a possible real person / public
figure, then rejected). Of the wired image-input models, only `runwayml/gen-4.5`
exposes a knob, so `buildGenParams` now sends `content_moderation:
{ public_figure_threshold: "low" }` for it, making Runway the photoreal-friendly
cloud lane. Seedance 2.0, Hailuo 2.3, and hh1-i2v expose no moderation field (it is
hard-coded provider-side; Seedance is the strict one returning
`InputImageSensitiveContentDetected.PrivacyInformation`). LoRA training + the SDXL
keyframe pass are self-hosted and have no vendor moderation. Operator-gated platform
(single key-holder, Access-gated, monitored logs, enforced AUP). See
`docs/i2v-backend-selector.md` for the per-provider table.

### Code
- `src/longrun-params.ts` - Runway i2v shape adds `content_moderation:
  { public_figure_threshold: "low" }`.
- `tests/longrun-params.test.ts` - Runway shape test updated (10/10 pass).
- `docs/i2v-backend-selector.md` - per-provider content-moderation section.
- `package.json` - 0.145.0 -> 0.145.1.

## v0.145.0

Motion backend selector in the control panel: choose GPU (Wan) or Cloud i2v.

The keyframes-only preview's finalize row in the planner now lets you pick how to
animate the keyframes: GPU (the pod's Wan 2.2 I2V, the existing `finalize`) or Cloud
(a per-shot cloud image-to-video model via the v0.144.0 `animate-cloud` endpoint).
Phase 3 of the pluggable motion backend (`docs/i2v-backend-selector.md`); it makes
the cloud backend a click instead of a curl.

- `buildHistoryRow` (`public/planner.js`): a "Motion" backend `<select>` (GPU vs
  Cloud) plus a cloud model `<select>` that shows only when Cloud is picked. The
  cloud options are the `image-input` video catalog (Seedance 2.0 (+fast), Hailuo
  2.3 (+fast), Runway Gen-4.5, hh1-i2v), hand-maintained like the existing Wan model
  option lists.
- GPU routes to the existing `finalizeRender`; Cloud routes to a new
  `animateCloudRender` that POSTs `/api/storyboard/renders/<id>/animate-cloud
  { model }` and `loadHistory()`s. The new `cloud-<uuid>` row is polled by the
  existing history auto-refresh (the render-poll `cloud-` short-circuit serves it).
- Cloud output is silent by design; the existing add-audio action scores it.

Vanilla JS / CSS only (no build step). `planner.js` passes `node --check`; the src
typecheck + suite are unaffected (frontend-only change).

### Code
- `public/planner.js` - motion backend + model selectors in the finalize row;
  `animateCloudRender`.
- `public/styles.css` - `.planner-motion-backend` + select styling.
- `docs/i2v-backend-selector.md` - Phase 3 marked shipped.
- `package.json` - 0.144.0 -> 0.145.0.

## v0.144.0

Cloud image-to-video animation of a render's keyframes (the cloud motion backend).

`POST /api/storyboard/renders/<id>/animate-cloud { model, motionPrompts?, prompt? }`
takes a COMPLETED render that has SDXL keyframes and animates each keyframe into a
clip via a chosen cloud image-to-video model (the Phase 1 `image-input` set:
Seedance / Hailuo / Runway / hh1), then assembles the clips into a silent mp4. It
runs entirely on the control plane, no GPU pod, mirroring the GPU `finalize`
endpoint so the two motion backends are symmetric. Phase 2 of the pluggable motion
backend (`docs/i2v-backend-selector.md`).

How it works:
- A new `cloud_animate` `LongRunWorkflow` kind. One durable step per shot: presign
  the keyframe (R2_RENDERS), `env.AI.run` the cloud i2v model with the per-model
  shape from `buildGenParams`, store the clip at
  `renders/<project>/<jobId>/clips/<shot>.mp4`. Then an assemble step runs the
  `video-finish` container to concat, and re-puts the result with the owner's
  `customMetadata.user_email` (the container's presigned PUT sets none, and
  `/api/artifact` 403s without it).
- Returns a `cloud-<uuid>` jobId. `handleRenderPoll` short-circuits `cloud-` jobs to
  serve the render row directly: they are workflow-backed (not RunPod) and can run
  for many minutes, so they must skip the RunPod-404 `classifyMissingJob` path that
  would otherwise falsely fail a long job as a phantom.
- The new history row carries `mode: "cloud-finalized"` (added to the renders-db
  mode union + normalizer). Row status is updated by the by-`job_id`
  `updateRenderFromView` using a synthetic view; failures call
  `markRenderFailedByJobId`.
- Output is silent by design; add a score afterward with the existing
  `POST .../add-audio` on the new row.

Verification: typecheck clean; full suite 571/571. Video gen + the video-finish
container run through Cloudflare Workflows/Containers, which do not run under
`wrangler dev`, so this needs a post-deploy smoke test (one animate-cloud call on a
keyframes-only render; checklist in the PR).

### Code
- `src/index.ts` - `handleAnimateCloudSubmit` + route; `CloudAnimateParams` +
  `LongRunWorkflow.runCloudAnimate` (new workflow kind); `cloud-` short-circuit in
  `handleRenderPoll`.
- `src/renders-db.ts` - `"cloud-finalized"` added to the `mode` union (RenderRow +
  NewRenderRow) and to `normalizeRow`.
- `docs/i2v-backend-selector.md` - Phase 2 marked shipped.
- `package.json` - 0.143.0 -> 0.144.0.

## v0.143.0

Image-to-video on the premium video models (keyframe animation), not just hh1-i2v.

Until now only `alibaba/hh1-i2v` was flagged `image-input`, so animating a keyframe
(image-to-video) was limited to the one weakest model. This wires the strong cloud
i2v models too: `bytedance/seedance-2.0` (+fast), `minimax/hailuo-2.3` (+fast), and
`runwayml/gen-4.5`. Each provider's image-to-video input schema differs (different
image field, duration type, resolution vs ratio) and `additionalProperties:false`
makes a stray field fatal, so `buildGenParams` now dispatches a verified per-model
shape instead of one hardcoded hh1 shape:

- Seedance: `image`, integer duration, `resolution:720p` + `aspect_ratio`, audio off.
- Hailuo: `first_frame_image`, `resolution:768P`.
- Runway: `image_input`, `ratio:1280:720` (no separate resolution).
- hh1-i2v: unchanged (also the safe default when no `modelId` is passed, so existing
  callers and the prior param shape are byte-identical).

Prompt-required models get a default motion prompt when the caller passes none.
`google/veo-*` is intentionally deferred: its `image_input` wants raw base64 rather
than a URL/data-URI, which needs a conversion step in the workflow.

This is Phase 1 of a pluggable cloud-vs-GPU motion backend for Vivijure renders; see
`docs/i2v-backend-selector.md` for the full rollout plan.

Schemas verified against the Cloudflare model pages (2026-06-07). Video gen runs
through Cloudflare Workflows, which do not run under `wrangler dev`, so the new
shapes need a one-call smoke test per model after deploy (checklist in the PR).

### Code
- `src/longrun-params.ts` - per-model `imageToVideoParams` dispatch; `modelId` added
  to `GenParamOpts`.
- `src/models.ts` - `image-input` capability on seedance-2.0(+fast),
  hailuo-2.3(+fast), gen-4.5.
- `src/index.ts` - pass `modelId` into `buildGenParams` at the workflow call site.
- `tests/longrun-params.test.ts` - per-model i2v shape tests (10 pass).
- `docs/i2v-backend-selector.md` - new design + rollout doc.
- `package.json` - 0.142.0 -> 0.143.0.

typecheck: clean. tests: `tests/longrun-params.test.ts` 10/10 pass.

## v0.142.0

Artifact cache: ETag revalidation instead of a blind 1-hour cache.

`/api/artifact` served `Cache-Control: private, max-age=3600`, so an artifact
overwritten at a stable key (the `regen-shot` path rewrites
`renders/<project>/<job>/keyframes/<shot>.png` in place) could show the browser's
pre-regen copy for up to an hour. The handler now forwards the request's
conditional headers to R2 and serves `private, no-cache` + an `ETag`: an
unchanged artifact costs a ~0-byte `304`, a changed one returns fresh bytes.
This is the non-breaking alternative to hashing keyframe filenames (which would
have forced D1 `keyframes_json` rewrites + orphaned-object cleanup); keys stay
stable. Note these responses are `private`, so this was never a Cloudflare
edge-cache issue, only the browser's private cache. MP4s never overwrite (a new
render is a new job-id key), so they simply `304` cheaply.

### Code
- `src/index.ts` `handleArtifact`: conditional `bucket.get(key, { onlyIf:
  request.headers })`; `ETag` from `obj.httpEtag`; `304` on a body-less match;
  `cache-control: private, no-cache`. Ownership is still checked before any
  `304`, so a non-owner with a guessed ETag gets `403`, not a hit/miss oracle.
- `tsc --noEmit`: clean. `vitest`: all passing.

## v0.141.0

Per-render logs in R2, plus a History "logs" link.

When a render reaches a terminal status, the control plane now persists a
readable per-render log (status, queue/exec timing, the COMPLETED envelope, and
on failure the GPU side's diagnostics tail) to R2 at a conventional key,
`renders/logs/<job_id>.txt`. The History row gains a **logs** link (terminal
renders only) that opens it through `/api/artifact`. The key is derived from the
row's `job_id`, so there is no new D1 column, no migration, and no read-path
change. This is the foundation for richer render observability (next steps:
ingest the full RunPod container log, and Workers Logs + Logpush-to-R2 for the
Worker's own request logs).

The R2 write is best-effort: it runs after the render row is updated, never
throws, and a failure is swallowed, so logging can never block or break the
render-resolve path. The log object is stamped with the render owner's
`user_email`, so `/api/artifact`'s ownership gate serves it like any other
render artifact.

### Code
- New `src/render-log.ts`: `renderLogKey` + `buildRenderLogText` (pure,
  unit-tested) + `writeRenderLog` (best-effort R2 put, never throws).
- `src/renders-db.ts` `updateRenderFromView`: on terminal status, look up the
  row owner and write the log to R2 (try/catch, non-fatal).
- `public/planner.js`: History row "logs" link, gated on `job_id` +
  `completed_at`.
- Tests: `tests/render-log.test.ts` (4 cases: key derivation + builder
  formatting / error / omitted blocks).
- `tsc --noEmit`: clean. `vitest`: all passing.

## v0.140.0

Rename the product to **Vivijure** (control-plane brand sweep).

Part of the cross-repo project rename; the GPU worker repo is now
`vivijure-serverless`. This sweeps the visible "Vivijure" brand and the
`vivijure-serverless` contract references to Vivijure across the planner + cast
UI, the render-done email template, code comments, and docs. It also flips the
`R2_RENDERS` bucket name from `vivijure` to `vivijure` (the bucket was migrated;
objects copied server-side with `user_email` + content-type metadata preserved).

No behavior change: binding NAMES (`R2_RENDERS`, `R2`), R2 key prefixes, and the
job contract are unchanged; only the `bucket_name` value and human-facing strings
move. The chat bucket (`R2` = `skyphusion-llm`) is untouched, and historical
CHANGELOG entries + applied migrations are intentionally left as-is.

### Code
- 26 files: UI (`planner.html`, `cast.html`, `index.html`, `stt.html`,
  `topbar.js`, `styles.css`), `render-email.ts`, `index.ts`, `runpod-submit.ts`,
  `env.ts`, `bundle-assembler.ts`, `audio-routing.ts`, `lora-resolver.ts`,
  `planner-yaml.ts`, `storyboard-validate.ts`, `containers/*`, `schema.sql`
  (comment), `wrangler.example.toml` (`R2_RENDERS` bucket), `README`, `CLAUDE.md`,
  `.github/*` templates, tests.
- No `Env` interface change (binding names unchanged), so no `wrangler types` regen.
- `tsc --noEmit`: clean. `vitest`: 562 passed (32 files).

## v0.139.0

User Preferences (first instance) + opt-in render-done email notifications.

The `skyphusion-email` service binding (wired in v0.137.0) was dormant; this
points it at its first real use, and stands up the per-user settings store the
account menu had as a "coming soon" placeholder.

**User Preferences.** A `user_prefs` table (one row per Cloudflare-Access email,
a JSON blob so new prefs need no schema change) + `GET`/`PATCH /api/prefs`. The
account menu now has a Preferences block; the first control is the email toggle.
Reads always return the full shape with defaults, so nothing branches on "is it
set".

**Render-done emails (opt-in, default off).** When `emailNotifications` is on and
one of your renders reaches a terminal status, you get one email (project,
duration, a watch link for COMPLETED, the reason for FAILED). Built to NOT be
spammy:
- Opt-in, default off. No surprise mail.
- Exactly one email per render: an atomic `notified_at` claim (NULL -> now in a
  single conditional UPDATE) means concurrent polls and the cron can never
  double-send.
- Terminal status only; keyframe previews are excluded (fast, you are watching).
- A cron (`*/3`) resolves fire-and-forget renders (an API contract fired with no
  client polling) so they still reach terminal + email. The email also fires on
  the normal poll path, so it works even before the cron is enabled.

### Code
- `src/user-prefs.ts` (new): `UserPrefs`, `normalizeUserPrefs`/`mergeUserPrefs`
  (pure), `getUserPrefs`/`setUserPrefs`.
- `src/render-email.ts` (new): `buildRenderEmail` (pure HTML+text builder, house
  style, escaped).
- `src/renders-db.ts`: `claimRenderNotify` (atomic once-only claim) +
  `listUnresolvedNotifiableJobs` (cron sweep query).
- `src/index.ts`: `maybeNotifyRenderDone` (claim -> check prefs -> send, best-
  effort) hooked at the terminal-transition points; `GET`/`PATCH /api/prefs`
  handlers + routes; `scheduled()` cron sweep.
- `public/planner.html` + `public/topbar.js` + `public/styles.css`: Preferences
  block in the account menu + email toggle wired to `/api/prefs`.
- `tests/user-prefs.test.ts`, `tests/render-email.test.ts`: +13 tests (562 pass);
  `tsc --noEmit` clean; `node --check` clean.
- DB: `migrate-v0.139.0.sql` (user_prefs table + renders.notified_at); apply to
  prod before/at deploy. `schema.sql` updated.
- Config: `[triggers] crons` added to `wrangler.example.toml` + `wrangler.toml`.
  Prod injects `wrangler.toml` from a Jenkins secret, so that secret must also
  get the `[triggers]` block for the cron to run in production (the email still
  fires on the poll path without it).


## v0.138.0

Document the render contract API and make API-submitted renders show in History.

The submit endpoint (`POST /api/storyboard/render`) already accepts the full
contract and tracks every render it submits, so advanced users can drive the
pipeline directly by curl instead of the UI. Two gaps closed:

1. **Contract API docs.** `docs/render-api.md`: auth (Cloudflare Access JWT or a
   headless service token), the full field table, curl examples (keyframes-only,
   full multi-character with pose + a muxed track reusing a ready cast), polling,
   and the adopt endpoint. The contract a script builds against.

2. **API renders are now visible in History.** Renders submitted outside the UI
   have no active project (`project_id` NULL), so the planner's active-project
   filter hid them whenever a project was selected. `listRendersForUser` now
   unions loose rows (`project_id = ? OR project_id IS NULL`) with the active
   project's, so they always show. The loose set is small (API renders) and does
   not crowd the project's own rows under LIMIT.

3. **Adopt endpoint.** `POST /api/storyboard/renders/adopt { jobId, project?,
   bundleKey?, qualityTier?, mode? }` inserts a SUBMITTED row, scoped to the
   caller, for a job fired straight at the RunPod endpoint (bypassing the
   Worker). The existing poll/resolve flow then fills it in. For backfilling
   directly-submitted jobs into a user's History.

### Code
- `src/renders-db.ts`: `listRendersForUser` project filter -> union with
  `project_id IS NULL`.
- `src/index.ts`: `handleAdoptRender` + the `/api/storyboard/renders/adopt` POST
  route (static, before the `/renders/<id>` regex).
- `docs/render-api.md`: new.
- D1-query paths follow the repo convention (query/handler code is verified live,
  not unit-tested; only pure helpers are). `tsc --noEmit` clean. Requires deploy.


## v0.137.6

Two planner fixes/features.

1. Fix: bundling skipped the Audio step. Staging a bundle auto-advanced straight
   to Render, and because bundle assembly is async that forced navigation fired
   late and yanked the user back to Render if they had navigated to Audio in the
   meantime ("bundle, go to audio, it instantly skips to render"). Now a staged
   bundle advances to Audio (the next step in plan -> cast/bundle -> audio ->
   render); Render stays unlocked so the user can still jump ahead.

2. Feature: auto-suggest an ideal MiniMax music prompt from the planned video.
   The first time the Audio step is opened for a plan (and whenever the user hits
   the new "suggest from video" button), a one-shot /api/chat on the selected
   planning model drafts a single concise instrumental music prompt matched to
   the storyboard's concept, visual style, shot arc, and duration (and the
   original brief, which usually names the genre/BPM), then prefills the music
   prompt field. Non-destructive: it never overwrites a prompt the user already
   typed, and only auto-fires once per plan.

### Code
- `public/planner.js`: post-bundle `showStep("render")` -> `showStep("audio")`;
  new `suggestMusicPrompt(opts)` (mirrors `scriptMyPlan`, one-shot `/api/chat`),
  auto-fired on first Audio open (empty-field + once-per-plan guards), reset on
  fresh plan; "suggest from video" button listener.
- `public/planner.html`: "suggest from video" button + updated music hint.
- No `src/` change. `node --check` clean.


## v0.137.5

Expose multi-character pose conditioning + its geometry in the planner UI. The
contract keys existed (v0.137.4) but only an API submit could set them; now the
planner's multi-character override panel has the controls, so a UI render can
draw two characters apart and apply the ghost-cape fix.

New controls under multi-character overrides: a pose-conditioning on/off select
plus ControlNet scale, figure inset / gap / width, and an extra-negative field.
The geometry inputs are pre-filled with the confirmed ghost-cape values
(inset 0.12, gap 0.035, width 0.95, the stray-cloth negative); they only ship
when pose is turned on, so non-pose renders keep a minimal submit body. Pose is
off by default (opt-in; needs the openpose controlnet primed on the volume).

### Code
- `public/planner.html`: 6 inputs (`#planner-mc-pose`, `-cn-scale`,
  `-pose-inset`, `-pose-gap`, `-pose-figw`, `-pose-neg`) in the multi-character
  panel + a pose note in the overrides hint.
- `public/planner.js`: `buildMultiCharacterOverrides` reads them (gated on pose
  on; bounds-checked, negative capped at 400) into `multiCharacterOverrides`,
  which is already forwarded to the Worker normalizer; +6 FIELD_HELP entries.
- No Worker/src change (the normalizer already validates these keys, v0.137.4).
  `node --check` clean; `tsc --noEmit` clean; 69 runpod-submit tests pass.


## v0.137.4

Make the multi-character pose-template geometry fully contract-driven, so the
"ghost cape" fix (and any future pose-spacing tweak) lives on the job contract
instead of being baked into the GPU image. The image stays immutable; the Worker
sends the values.

When two figures were posed wide apart, the empty center band got filled with a
hallucinated draped shape (a stray cape/cloth) between them. The fix is to pull
the figures closer and shrink that band, but those are tunables, so they belong
on the contract, not in a pod rebuild.

New `multiCharacterOverrides` keys (validated + range-bounded, forwarded to the
pod's `multi_character` overrides): `pose_inset_frac` (0..0.25, pulls both
figures toward center), `pose_gap_frac` (0..0.15, inter-column gap),
`pose_fig_width_frac` / `pose_fig_height_frac` (0.3..1, figure size), and
`pose_negative` (string, trimmed + capped at 400 chars, appended to the negative
only on the pose path). All absent -> the pod uses its original geometry.

Also closes the last `multi_character` contract gap found in a full pod<->Worker
sync audit: `openpose_controlnet_repo` (the pod accepted it but the Worker could
not send it). Now forwarded too, so every key the pod whitelists is reachable
from the Worker and nothing the Worker sends is dropped. Category-level audit:
all 24 pod override categories are Worker-reachable; no silent drops either way.

Pairs with vivijure-serverless 0.4.89 (the pod side that reads these keys; its
defaults reproduce the original geometry byte-for-byte).

### Code
- `src/runpod-submit.ts`: `MultiCharacterOverrides` gains the five geometry keys
  + `openpose_controlnet_repo`; `normalizeMultiCharacterOverrides` validates each
  (bounded floats via a local `poseFrac` helper; `pose_negative` trim + 400-char
  cap; repo trim + 200-char cap).
- `tests/runpod-submit.test.ts`: +4 tests (geometry pass-through in range, drop
  out of range, pose_negative trim/cap/empty, openpose_controlnet_repo trim).
  69 pass; `tsc --noEmit` clean.
- No D1 / Env change. Requires a Worker deploy to forward the new keys.


## v0.137.3

Fix audio/narration mux still truncating the video to a short bed. The v0.136.5
`-af apad -shortest` did not hold in the deployed video-finish container (a long
narration cut a 51s render down to ~30s). Replace it with an explicit, version-
proof approach: probe the video duration and force the output to it with `-t`,
padding the audio (`apad`) to fill a short bed and cutting a long one. Output is
now always exactly the video's duration.

### Code
- `containers/video-finish/app.py`: `_assemble` audio mux -> probe `_probe_duration`
  + `-map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -af apad -t <vdur>`. Verified locally
  on a 51s video + 8s bed -> 51s output. Requires a container redeploy.
- No Worker/test change.


## v0.137.2

UX: the add-audio / narrate buttons now show a clear inline status while the
off-GPU mux runs. The mux is a CPU-container call that can take 10-30s (plus cold
start), and the bare "narrating..." button text was too subtle - it looked like
nothing was happening. Now a visible status line in the row ("Synthesizing speech
and muxing it onto the video...", pulsing) reports progress, with a check on
completion and the alert preserved on failure.

### Code
- `public/planner.js`: `setMuxStatus`/`clearMuxStatus` helpers; wired into
  `addAudioToRender` + `addNarrationToRender`.
- `public/styles.css`: `.planner-history-mux-status` (+ working/done states, pulse).
- No server change.


## v0.137.1

Docs: document the post-render audio/narration capabilities in the README
(Vivijure flow step 7) - mux a music bed (`add-audio`) or synthesize spoken
narration (`add-narration`) onto a finished render off-GPU via the video-finish
container.

### Code
- `README.md` only. No code change.


## v0.137.0

Add spoken narration to a finished render without the GPU. A "narrate" button on
completed renders in History takes narration text, synthesizes it with a TTS
voice (Workers AI), and muxes it onto the video off-GPU via the same video-finish
path as add-audio. Text -> speech -> muxed MP4, no re-render, no RunPod job.

- `POST /api/storyboard/renders/:id/add-narration` `{ text, voice? }`: TTS the
  text (voice from the catalog's three: aura-2-en/-es, melotts; default
  aura-2-en), store it in R2, then mux onto the render's MP4.
- Refactor: the add-audio mux core is now a shared `muxAudioOntoRender` helper +
  `loadCompletedRenderForMux` guard, used by both add-audio and add-narration.
- History UI: a **"narrate"** button next to "add audio" on completed rows.

### Code
- `src/index.ts`: `muxAudioOntoRender` + `loadCompletedRenderForMux` (extracted
  from add-audio), `handleAddRenderNarration` + `/renders/:id/add-narration`
  route, `NARRATION_VOICES`.
- `public/planner.js`: `addNarrationToRender` + the "narrate" History button.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 545 pass.


## v0.137.0

Wire a service binding to the skyphusion-email Worker so the planner can send
transactional mail (render-complete notices, etc.) from @skyphusion.org with no
API token or public network hop. This lands the plumbing only; no route calls
`env.EMAIL.send()` yet.

### Code
- `src/env.ts`: add the `EmailServiceBinding` interface + optional `EMAIL`
  binding on `Env`.
- `wrangler.example.toml`: add the `[[services]]` block (binding `EMAIL` ->
  service `skyphusion-email`, entrypoint `EmailService`). Mirror it into your
  per-deployer `wrangler.toml` (and the CI Secret-file credential).
- `Jenkinsfile`: email conrad@rockenhaus.net on build failure (top-level post).
- `npm run typecheck` passes. Requires a Worker redeploy; no D1 / test change.


## v0.136.6

Plumb OpenPose ControlNet pose-conditioning overrides through to the pod
(pairs with vivijure-serverless 0.4.87) - the real two-character separation
lever (draws the bodies apart, vs masks that only route identity).

- `multiCharacterOverrides.pose_conditioning` (bool): when on + >=2 slots, the
  regional keyframe is conditioned on a per-slot pose skeleton so each slot gets
  its own figure/column. Pod default false.
- `multiCharacterOverrides.controlnet_conditioning_scale` (0..2): pose adherence
  strength. Pod default 0.55.

### Code
- `src/runpod-submit.ts`: add both fields to `MultiCharacterOverrides` + the
  normalizer. `tests/runpod-submit.test.ts`: +2 cases.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 545 pass.


## v0.136.5

Fix the add-audio mux truncating the video to a short audio bed. The video-finish
container muxed with bare `-shortest`, so an audio file shorter than the video cut
the video down to the audio length. Now it pads the audio with silence to the
video length (`-af apad -shortest`): a short bed leaves the tail silent, a long
bed is cut to the video, and the output is always exactly the video's duration.

### Code
- `containers/video-finish/app.py`: `_assemble` audio mux -> `-af apad -shortest`.
- No Worker/test change; requires a container redeploy (wrangler rebuilds the
  video-finish image on deploy).


## v0.136.4

Add audio to a finished render without firing up the GPU.

Pick an audio file on a completed render in History and mux it onto the silent
MP4 entirely on CPU, via the existing video-finish (ffmpeg) container. No
re-render, no RunPod job.

- `POST /api/storyboard/renders/:id/add-audio` `{ audioKey }`: muxes the audio
  bed onto the render's existing MP4 (the render is a single clip to the
  video-finish container), re-stamps the R2 `user_email` / `content-type`
  metadata the artifact route needs, and points the row at the muxed MP4
  (cache-busted key per audio bed so a new bed never serves a stale CDN copy).
- History UI: an **"add audio"** button on completed rows uploads an audio file
  (`/api/storyboard/audio-upload`), then calls the new endpoint; the row's
  inline player + download then serve the version with sound.

### Code
- `src/index.ts`: `handleAddRenderAudio` + `/renders/:id/add-audio` route + a
  small `shortHash` for the cache-busted output key.
- `src/renders-db.ts`: `setRenderAudioOutput` (updates `output_key` +
  `output_json` `has_audio`/`output_key`/`seconds`).
- `public/planner.js`: `addAudioToRender` + the "add audio" History button.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 543 pass.


## v0.136.3

Add a `region_gap_px` knob to the regional multi-character engine (pairs with
vivijure-serverless 0.4.86) so two characters can be pushed apart instead of
merging at the frame center.

The regional engine's only mask-geometry knob was `feather_px`, which only ADDS
center overlap; there was no way to create a gap, so two subjects tended to meet
in the middle. `region_gap_px` carves a dead center band (width 2*gap) where
neither slot's IP-Adapter applies, pulling the two n=2 subjects to opposite outer
halves. Pod default 0 (geometry unchanged); driven via `multiCharacterOverrides`.

### Code
- `src/runpod-submit.ts`: add `region_gap_px` to `MultiCharacterOverrides` and the
  normalizer (range 0..600, rounded). `tests/runpod-submit.test.ts`: +2 cases.
- Pairs with vivijure-serverless 0.4.86 (`_build_region_masks` `region_gap_px`).
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 543 pass.

## v0.136.2

Document the Vivijure control-plane <-> vivijure-serverless connection and the three
Cloudflare Containers in the README. No code change.

- Added a **Routing** mermaid diagram to the Vivijure studio section: the
  control-plane Worker, the three CPU containers, R2, D1, and the RunPod GPU handoff,
  with numbered edges tracing one render job start to finish.
- The container list was missing **`video-finish`** (the ffmpeg final-cut container).
  All three are now documented: `image-prep` (rembg/u2net background removal),
  `audio-beat-sync` (librosa BPM + downbeat detection), and `video-finish` (ffmpeg
  concat + crossfade + music mux, off the GPU). Clarified that only the two
  numba-based containers bake a numba cache; `video-finish` is a plain subprocess.
- Updated the render flow to reflect the off-GPU finish: the GPU returns per-shot
  clips and the `video-finish` container assembles the final MP4 (new step 6).

### Code
- Docs only: `README.md`, `package.json` (version bump). No `src/` or `public/` change.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 541 pass (unchanged).

## v0.136.1

Documentation accuracy pass for release. No code change; corrects stale numbers
and instructions across the public docs after auditing them against the code.

- **README model counts** were stale in several places. Corrected against
  `src/models.ts` (71 catalog entries total): catalog "~50" -> "~70"; video
  "15 models" -> "16"; image "Ten" -> "Eleven" (Stable Diffusion XL was
  missing); chat streaming "all 33" -> "34 of 35" (the single-shot LLaVA 1.5 is
  the lone non-streaming chat model). Added the shipped-but-undocumented models
  to the feature lists: SEA-LION v4 27B, LLaVA 1.5 7B, Stable Diffusion XL, and
  Deepgram Nova-3 (the STT section now lists four one-shot models, not three).
  Refreshed the stale LOC figures (index.ts ~3700 -> ~7800, etc.).
- **MIGRATIONS.md** never documented the `migrations/` subdirectory and falsely
  claimed `renders.project_id` (v0.55.0) and the `cast_members` LoRA columns
  (v0.57.0) shipped with no delta file. They do: documented `migrations/`
  v0.46.0 (cast), v0.53.0 (projects), v0.55.0 (renders.project_id), v0.57.0
  (cast LoRA) with their apply commands; removed a stray misplaced v0.20.2
  command block under the v0.22.1 heading.
- **SECURITY.md** had no usable reporting channel ("email the maintainer", no
  address). Switched to GitHub private vulnerability reporting (Security tab ->
  Report a vulnerability), added a supported-versions statement and a 90-day
  coordinated-disclosure window.
- **CONTRIBUTING.md**: noted CI runs the vitest suite (not just typecheck) on
  same-repo PRs/pushes, and to run `npm test` before pushing.

### Code
- Docs only: `README.md`, `MIGRATIONS.md`, `SECURITY.md`, `CONTRIBUTING.md`,
  `package.json` (version bump). No `src/` or `public/` change.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 541 pass (unchanged).

## v0.136.0

Stop the render status from hanging at IN_QUEUE forever when RunPod drops a job,
and stop claiming "queued" before RunPod actually confirms it.

Two related fixes to the render submit/poll loop:

1. "Job submitted" vs confirmed queued. RunPod's `/run` returns `IN_QUEUE`
   optimistically, but the job can evaporate before `/status` ever sees it
   (observed live: job `d4790110` reported `IN_QUEUE` on submit, then `/status`
   404'd permanently). The render row no longer trusts that `/run` status: it is
   recorded as `SUBMITTED` and only flips to `IN_QUEUE` / `IN_PROGRESS` once a
   real `/status` poll confirms it (`updateRenderFromView` overwrites it). The UI
   shows "submitted" with a working cancel button and a queue-equivalent (un-
   anchored) ETA clock.

2. Phantom job -> FAILED, not an infinite retry. When `/status` returns RunPod's
   404 ("job not found"), the poll handlers now reconcile against our own row:
   - row already terminal -> serve the cached row (RunPod just GC'd a finished
     job; never re-fail it);
   - within a 150s grace window -> report `SUBMITTED` and keep polling (covers
     the brief `/run` -> `/status` propagation race);
   - past the grace window -> mark the row `FAILED` with a clear message and
     report it terminal, so both the one-shot poll and the SSE stream stop
     instead of retrying the 404 forever (the old behavior: "poll failed
     (retrying)" on an 8s loop, badge stuck at IN_QUEUE).

The phantom reconciliation is shared by `GET /api/storyboard/render/<jobId>` and
its `/stream` SSE variant, so whichever path the client is on terminates.

### Code
- `src/renders-db.ts`: add `isTerminalStatus`, `PHANTOM_GRACE_SECONDS`, pure
  `classifyMissingJob(rowStatus, submittedAt, now, grace?)`, `getRenderForPoll`,
  and `markRenderFailedByJobId` (guarded so it never clobbers a terminal row).
- `src/index.ts`: add `pollRenderResolved(env, jobId)` (wraps `pollRenderJob` +
  404 reconciliation) and route both poll handlers through it; record + return
  `SUBMITTED` at submit time instead of RunPod's `/run` status.
- `public/planner.js`: treat `SUBMITTED` as in-flight in `setJobStatusBadge`
  (cancellable), the ETA anchor, and the history `filterRows` bucket.
- `tests/renders-db.test.ts`: cover `classifyMissingJob` (terminal / confirming /
  phantom / custom grace) and `isTerminalStatus`.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 541 pass.

## v0.135.15

Fix the front-page composer send button rendering as a padded rounded square with
an off-center arrow instead of the round gradient button. The button is
`<button id="run" class="composer-send">`, and the legacy `#run` id rules
(`border-radius: 4px`, `padding`, flat `--accent` background, plus a `min-height:
44px` in the mobile media query) out-specify the `.composer-send` class rules (id
1,0,0 beats class 0,1,0), so they won, exactly the failure the in-code comment
warned about. Scoped all `#run` rules to `#run:not(.composer-send)` so the legacy
flat-send styling no longer applies to the round composer button; the
`.composer-send` rules now take effect, and the planner's reused `.composer-send`
button (which isn't `#run`) is unaffected.

### Code
- `public/styles.css`: `#run` / `#run:hover` / `#run:disabled` / media-query
  `#run` -> `#run:not(.composer-send)`.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 535 pass. (CSS only.)

## v0.135.14

Fix a LoRA-reuse hole: a trained LoRA could be silently retrained. A LoRA's
result is only harvested into D1 (lora_status -> "ready", lora_key written) by
`GET /api/cast/:id/lora-status`, which only runs while the cast page is open and
polling. There is no cron. So if you start a LoRA training and close/leave the
cast page before it finishes, the RunPod job completes but the row stays
`lora_status="training"` forever, and a later render sees it as not-ready and
RETRAINS it from scratch, defeating the v0.135.6 reuse. (Observed live: Kaito's
job was COMPLETED on RunPod while his cast row still said "training".)

Now the render/finalize submit self-heals: when resolving `castLoras`, any bound
slot still "training" with a job id is polled and harvested first (mirroring the
lora-status handler's COMPLETED/FAILED logic), so a finished-but-unharvested LoRA
gets reused instead of retrained. A poll error leaves the row as-is (the slot
just trains fresh that render). The cast-page UI already self-heals on revisit;
a cron for fully passive status updates is a possible follow-up, not needed for
reuse correctness.

### Code
- `src/index.ts`: add `refreshTrainingLora(env, cast, userEmail)`; call it in the
  castLoras resolution of both the render-submit and finalize paths.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 535 pass.

## v0.135.13

Add an explicit "art style" control to training-set generation, replacing the
v0.135.12 "match the reference image" anchor that did not work. Verified by
generating real images on nano-banana-pro with Kaito's anime portrait attached:
the "match the reference's art style" prompt still rendered photoreal, while an
explicit "anime art style, anime illustration" lead rendered clean anime. The
photographic templates ("studio lighting", "golden hour") dominate unless the
style is stated outright; nano-banana weights the text over the reference.

Added an optional per-character "art style" input on the cast page (remembered
in localStorage, no D1 column). When set, `composeTrainingPrompt` leads each of
the 10 prompts with `<style> art style, <style> illustration`; blank keeps the
templates as-is (correct for photoreal characters). The portrait generator
already has a free-text prompt field, so this closes the gap on the training set
specifically.

### Code
- `public/cast.html`: add `#cast-training-style` input under the model picker.
- `public/cast.js`: `composeTrainingPrompt(template, bible, style)` leads with the
  explicit style; `getTrainingStyle` + localStorage persist/restore; pass style at
  the gen call site.
- `tests/cast-db.test.ts`: 3-arg mirror + style assertions (535 tests).
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 535 pass. `node --check` OK.

## v0.135.12

Fix training-set generation rendering photoreal images from an anime portrait.
The 10 training prompts are photographic ("soft studio lighting", "golden-hour
outdoor lighting", "harsh midday sunlight"), and while the flow attaches the
character's portrait as a reference, nano-banana-pro weights the text prompt
over the reference image, so an anime portrait produced a photoreal training
set (FLUX follows the reference style, so it had stayed anime). Now
`composeTrainingPrompt` leads each prompt with "Match the art style and visual
rendering of the reference image", so style follows the portrait (anime stays
anime, photoreal stays photoreal) regardless of model, with zero new config: the
portrait is the style decision and the training set inherits it.

### Code
- `public/cast.js`: `composeTrainingPrompt` prepends `TRAINING_STYLE_ANCHOR`.
- `tests/cast-db.test.ts`: update the mirror + assertions.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 533 pass. `node --check`
  on cast.js OK.

## v0.135.11

Offer Nano Banana Pro in the cast training-set model picker. The picker was
hardcoded to the FLUX 2 family on the basis that nano-banana ignores the
attached reference for identity, but that verdict came from photoreal testing;
for anime subjects nano-banana-pro locks identity well (confirmed in use) and,
unlike FLUX 2, it does not over-flag on content (the 3030 path that kept
blocking edgier character designs). Added it as an option; FLUX Klein-9b stays
the default so photoreal characters do not regress. gpt-image-1.5 stays excluded
(still ignores identity). The portrait picker already exposed the full catalog;
this is specifically the training-set picker that feeds the LoRA.

### Code
- `public/cast.js`: add `google/nano-banana-pro` to `TRAINING_MODELS`; update the
  rationale comment.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 533 pass. `node --check`
  on cast.js OK. (Client-only; the /api/chat image path already routes this model.)

## v0.135.10

Mark the per-portrait / per-reference "remove" button (`.cast-ref-delete`) red,
matching the destructive-action color language (red outline rather than fill,
since there is one per thumbnail). HTML unchanged.

### Code
- `public/styles.css`: `.cast-ref-delete` red outline + red hover.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 533 pass. (CSS only.)

## v0.135.9

Carry the planner's color language (danger=red, action=accent) onto the cast
page.

- **Destructive = solid red.** The portrait "clear", the portrait-gen "discard",
  and the multi-character preview "discard" now use a `.cast-danger` modifier
  (solid red, keeps each button's context size). "delete this character" is now
  pronounced solid red in its base state (was an outline that only filled on
  hover); deleting a character is high-consequence.
- **retrain / train LoRA** now uses the accent fill (`.cast-save-btn`, light
  blue) instead of the neutral elevated button, marking it as the pane's primary
  action.
- **download .safetensors** is more pronounced via a new `.cast-accent-outline`
  modifier (accent text + border) instead of the dim secondary outline, so it
  reads as a real result to grab without competing with the filled train button.

### Code
- `public/cast.html`: `clear` / both `discard` buttons -> `cast-danger`;
  `train LoRA` -> `cast-save-btn`; `download .safetensors` -> `cast-accent-outline`.
- `public/styles.css`: `.cast-danger-btn` rewritten to solid red; add
  `.cast-danger` and `.cast-accent-outline` modifiers.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 533 pass. (HTML/CSS only.)

## v0.135.8

Planner color/affordance pass so the controls read at a glance: destructive =
red, status = green, action = accent.

- **Plan button** right-aligned (the transient status moves left), so it sits
  under "clear brief" and matches the refine "send" button's placement; both are
  already the accent primary style.
- **Destructive actions in red.** "delete project" and "discard all edits" are
  now solid red (new `.planner-danger`, matching the existing "clear brief"
  treatment, disabled-aware). Per-shot "delete" gets a red outline in its base
  state (outline rather than fill so a long shot list is not a wall of red).
- **Status indicators in green.** The "edited" badge and the "yaml in sync"
  message (and other inline success statuses) now use `--success` green instead
  of the accent blue.
- **"export markers"** now uses the accent hue like the other action buttons
  (new compact `.planner-accent-btn`), instead of the plain secondary outline.

### Code
- `public/planner.html`: reorder plan/status; `delete project` +
  `discard all edits` -> `planner-danger`; `export markers` -> `planner-accent-btn`.
- `public/styles.css`: `.planner-actions .planner-status { margin-right:auto }`;
  `.planner-status-success` + `.planner-scenes-dirty` -> `--success`;
  `.planner-scene-delete` red outline; add `.planner-danger` + `.planner-accent-btn`.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 533 pass. (HTML/CSS only.)

## v0.135.7

Clean up the common render-controls box (art style / seed / lora scale /
consistency). It was an auto-fit grid that landed on three columns, so the four
fields sat 3-then-1 with consistency mode stranded alone on a second row, and
the wide "randomize" text button was crammed into the narrow seed cell, bleeding
into the lora-scale column. Now it is a balanced 2x2 grid (art style | seed,
lora scale | consistency) that collapses to one column under 720px, and the
randomize control is a compact square dice icon button (the established
image-gen idiom, with title + aria-label "randomize seed") that stretches to the
seed input's height and sits flush beside it. No behavior change; layout and
affordance only.

### Code
- `public/planner.html`: randomize button is now a dice glyph with title /
  aria-label (id + class unchanged, JS binding intact).
- `public/styles.css`: `.planner-overrides-common` -> fixed 2-column grid with a
  720px single-column breakpoint and align-items:start; `.planner-overrides-secondary`
  -> compact 38px square icon button.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 533 pass. (HTML/CSS only.)

## v0.135.6

Make LoRA reuse authoritative server-side so the GPU never needlessly retrains a
cast LoRA that is already trained. Background: a render skips training via two
paths, the per-project `state.tar.gz` (which cannot exist on a new project's
first render) and the cast-LoRA path (`castLoras` {slot: cast_id} ->
`pretrained_loras` -> the pod stages the `.safetensors` and synthesizes the
job-json so `lora_already_trained` returns true). For a new project the cast
path is the only one that can apply, but `buildCastLoraSubmit` gated on the
browser's CACHED `lora_status`, so a LoRA that finished training after page load
was dropped client-side, no `castLoras` was sent, and the GPU retrained it. The
v0.135.5 cache-refresh was a partial mitigation.

Now `buildCastLoraSubmit` sends every validly-bound `slot -> cast_id` and lets
the render / finalize route (which already re-reads each cast row fresh from D1,
ownership-scoped, and forwards only `ready` rows with a `loras/` key) be the
single source of truth. This removes the dependency on cache freshness and on
whether `state.tar.gz` exists. The now-redundant v0.135.5 submit-time
`loadCast()` refresh is removed. Submit also surfaces the server's decision
(`pretrainedSlots` reused vs `castLoraSkipped` trained fresh) in the status line
and console, so a reused render is visibly distinct from one that retrains.

Verified: the pod path is already correct (`_stage_pretrained_loras` downloads
the LoRA, registers it, and writes the job-json the train-skip gate checks); the
only gap was the client not sending the bindings.

### Code
- `public/planner.js`: `buildCastLoraSubmit` sends all bound cast ids (server
  gates readiness); removed the v0.135.5 submit-time catalog refresh in
  `submitRender` + `finalizeRender`; surface `pretrainedSlots` / `castLoraSkipped`
  on submit.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 533 pass. `node --check`
  on planner.js OK. (Client-only; server resolver unchanged.)

## v0.135.5

Fix the planner retraining LoRAs that are already trained and ready. Reuse works
by sending a `{slot: cast_id}` `castLoras` map on render/finalize submit; the
Worker resolves it to `pretrained_loras` (the cast row's `loras/` key) and the
GPU skips training for those slots. But `buildCastLoraSubmit` gates on the cast
catalog cached in the browser, which is fetched ONCE at page load (`loadCast`
runs only in init). A LoRA that finishes training after the planner is open is
still cached as not-ready, so the slot is silently dropped, no `castLoras` is
sent, and the GPU retrains a LoRA that D1 already has as `ready` with a valid
key. Now `submitRender` and `finalizeRender` refresh the catalog (`await
loadCast()`) right before building the map, so freshly-trained LoRAs are reused
without a manual page reload. The refresh preserves the prior catalog if the
fetch comes back empty, so a transient failure never drops reuse for every slot.

Confirmed against live data: cast rows for Rei Kurogane (cast-8) and Kaito Yurei
(cast-7) are both `lora_status=ready` with `loras/cast-*/...safetensors` keys,
yet a render trained fresh because the page-load catalog predated training.

### Code
- `public/planner.js`: in `submitRender` and `finalizeRender`, `await loadCast()`
  before `buildCastLoraSubmit()` when bindings exist; restore the prior catalog
  if the refresh returns empty.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 533 pass. `node --check`
  on planner.js OK. (Client-only.)

## v0.135.4

Two render-page polish fixes. (1) Trim the "art style (keyframe SDXL base)" help
popover: dropped the wordy paragraph contrasting it with the advanced img2img
base and the turbo/volume-primed footnote -- that's reference-doc material, not a
quick-tip tooltip. Kept the one-line "what it does" plus the per-option value
map. (2) Fix the "randomize" button bleeding into the lora-scale field. The
seed input + randomize button share a flex row that sits in a grid cell of the
common-overrides box; without min-width:0 the input held its content width and
the row overflowed the cell into the next column. Added min-width:0 to the row
and input and pinned the button with flex:0 0 auto so the input absorbs the
slack.

### Code
- `public/planner.js`: shorten FIELD_HELP for `planner-ld-keyframe-model-id`.
- `public/styles.css`: `.planner-overrides-row` min-width:0; input min-width:0;
  `.planner-overrides-secondary` flex:0 0 auto.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 533 pass. `node --check`
  on planner.js OK. (Client-only.)

## v0.135.3

Fix the scene editor's "target seconds" boxes rendering dark-on-dark (invisible).
The value was always there -- a console probe showed the number inputs holding
the right values and the storyboard fully populated -- but the box looked blank.
Root cause: the themed `.planner-field` input rule (light text on elevated bg)
listed `textarea`, `select`, and `input[type="text"]` but not
`input[type="number"]`, so the lone number input in each scene row (target
seconds) fell through to the browser default (dark text) on the dark scene-row
background. The adjacent "act" / "start_image" text inputs were themed and
visible, which is why only target seconds looked empty. Added
`input[type="number"]` to the rule, symmetric with `input[type="text"]`.

This is what the v0.134.3 / v0.135.2 backfill work was chasing: the data was
correct the whole time (server populates target_seconds on every plan; the
client backfill covers restored storyboards) -- the symptom was purely this
missing CSS selector. The backfill is still correct and stays.

### Code
- `public/styles.css`: add `.planner-field input[type="number"]` to the themed
  input selector (line ~1701) so number inputs get `color: var(--fg)`.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 533 pass. (CSS-only; no
  JS/TS touched.)

## v0.135.2

Fix blank "target seconds" boxes in the scene editor. The server populates
`target_seconds` at plan/refine time (confirmed live: a fresh plan returns it on
every path), but a storyboard that reaches the editor any other way -- restored
from saved state, an older project planned before the v0.134.3 backfill shipped,
or a model that omitted `clip_seconds`/`duration_seconds` -- renders straight
from saved data with no backfill, so the boxes show empty. Added a client-side
`backfillTargetSeconds` that mirrors the server's storyboard-validate priority
(explicit start/end span, else `clip_seconds`, else an even split of
`duration_seconds`) and runs in `renderSceneEditor` before the rows are built.
Mutates the storyboard in place so the value persists and flows downstream to
bundle/render, exactly like the server. No-op when `target_seconds` is already
set, so fresh plans are unaffected.

### Code
- `public/planner.js`: add `backfillTargetSeconds(storyboard)`; call it at the
  top of `renderSceneEditor`.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 533 pass. `node --check`
  on planner.js OK. (Client-only; no TS touched.)

## v0.135.1

Fix the "bundle staged" panel showing "0 B gzipped, 0 files inside" after a page
reload. The bundle itself was always fine (the assembler returns real
`sizeBytes`/`fileCount` and the freshly-staged panel showed them); the bug was
only in the restore path, which rebuilt the panel from persisted state that
never saved the size/count and hardcoded zeros (with a comment calling it
"acceptable"). Confirmed the actual R2 object is healthy: 15.27 MB, 29 entries
(storyboard + both portraits + 12 + 13 refs). Now `bundleState` tracks the
gzipped size and entry count, persists them alongside `bundleKey`, and rehydrates
the real numbers on reload. Purely cosmetic; no change to what the GPU pulls.

### Code
- `public/planner.js`: add `sizeBytes`/`fileCount` to `bundleState`; set them on
  assemble success; persist in `collectBundleStageState`; rehydrate in
  `restoreBundleStagePanel` (was hardcoded `0`); reset in `resetBundleStage` and
  `showBundleStage`.
- typecheck: `tsc --noEmit` clean. tests: `vitest run` 533 pass. `node --check`
  on planner.js OK. (No TS touched; behavior is client-only.)

## v0.135.0

Promote the keyframe SDXL base to the common render controls. It's the single
biggest art-style lever (it renders each shot's keyframe, which Wan I2V then
animates, so the clip inherits its look), but it was buried two disclosures deep
("advanced -> image & SDXL -> SDXL base + keyframe..."). Moved the picker up into
the common overrides row next to seed / lora scale / consistency mode, relabeled
"art style (keyframe SDXL base)", and persisted it like the other common
controls (survives reload). The img2img `model_id` base stays in advanced (it's
the portrait/continuity path, not the rendered look). The `?` help on both now
spells out the difference so the two SDXL bases aren't confused. No behavior
change to the render itself -- same `local_diffusion_overrides.keyframe_model_id`
on the wire; this is purely placement + clarity + persistence.

### Code
- `public/planner.html`: move `#planner-ld-keyframe-model-id` from the advanced
  "SDXL base + keyframe + seeds" disclosure into `.planner-overrides-common`.
- `public/planner.js`: persist/restore the picker (collect + restore arrays);
  FIELD_HELP rewritten for both keyframe + img2img bases to contrast them.
- `package.json`: version 0.134.4 -> 0.135.0.

## v0.134.4

Clearer beat-timing apply message. After applying a beat plan, the warning read
"plan has 17 shots vs 16 scenes" -- but the "17" is `timedScenes.length`, how
many shots the *track* fits (musical phrases), not the storyboard's shot count.
A user whose storyboard had 16 shots read it as the planner claiming 17. Reworded
to name the source: "the track fits 17 shots but the storyboard has 16; 1 musical
phrase unused -- add a scene (or replan) to use the rest." (And the shorter-track
branch now notes the track is shorter than the storyboard.) Behavior unchanged --
beat timing still applies to the overlapping min(scenes, segments) range.

### Code
- `public/planner.js`: reword the `applyBeatPlan` mismatch messages.
- `package.json`: version 0.134.3 -> 0.134.4.

## v0.134.3

Planner backfills per-scene `target_seconds`. The scene editor's "target
seconds" box read a per-scene `target_seconds`, but that field is optional in
the schema, so the model populated only the top-level `clip_seconds` (per-shot
default) + `duration_seconds` and left each scene's value empty -> blank boxes,
even though the seconds were visible in the JSON. `validateStoryboard` now
backfills each scene's `target_seconds` when the model omits it: an explicit
start/end span wins, else `clip_seconds`, else an even split of
`duration_seconds` across the scenes (rounded to 0.01s). This is the same
fallback markers.ts / preflight already applied at render time, now materialized
into the data so the editor shows an explicit per-shot duration and beat-snap /
YAML / render all see the same value. (Re-plan or refine an existing storyboard
to backfill it; new plans get it automatically.)

### Code
- `src/storyboard-validate.ts`: backfill `target_seconds` from start/end span /
  `clip_seconds` / `duration_seconds`-even-split after validation passes.
- `package.json`: version 0.134.2 -> 0.134.3.

## v0.134.2

Stop the bundle stage showing a misleading "0 B" for cast-pulled reference rows.
When a bound cast member's reference set is synthesized into the per-slot upload
list (`synthesizeUploadsFromCast`) or rehydrated from staged R2 keys after a tab
close, the rows carry no client-side byte size -- refs are persisted as
`{key, mime}` only -- so every row rendered `formatBytes(0)` = "0 B", which reads
as an empty/broken file even though the R2 objects are full-size (verified: a
1.3 MB portrait + 11 refs at ~0.3-0.5 MB each). Now a row with an unknown size
renders no size text (its "staged" status already conveys state), and the
per-slot summary omits the "· 0 B" total when it is zero. Inline uploads, which
do know their `file.size`, still show real sizes. Cosmetic only; the bundle was
always assembled by key, so the GPU got the real images regardless.

### Code
- `public/planner.js`: `renderSlotUploads` row size renders `""` when
  `entry.size` is falsy; per-slot summary appends the byte total only when > 0.
- `package.json`: version 0.134.1 -> 0.134.2.

## v0.134.1

Fix the planner page scrolling sideways once a plan produces long YAML/JSON.
The result panes are a 2-column grid (`1fr 1fr`) and the storyboard `<pre>`
uses `white-space: pre`. Grid items default to `min-width: auto`, so a `1fr`
track refuses to shrink below its content's intrinsic width; the long unbroken
YAML lines (`full_prompt`, `style_prefix`, `cast_rules`) forced the column past
the viewport, widening the whole document and scrolling it right, which clipped
the left input column. The `overflow: auto` already on the `<pre>` never engaged
because the track itself was growing. Added `min-width: 0` to
`.planner-result-pane` so the tracks shrink to the available width and the
`<pre>` scrolls its long lines internally instead. CSS only.

### Code
- `public/styles.css`: `.planner-result-pane { min-width: 0; }`.
- `package.json`: version 0.134.0 -> 0.134.1.
- typecheck: clean. tests: unchanged (frontend-only).

## v0.134.0

"Script my plan" replaces the chat auto-fill. The v0.132.0 behavior dumped each
raw "ask the model" reply straight into the brief, which is wrong: the brief
should be a synthesized plan, not a transcript of turns. Removed the auto-fill
(and the `briefFromChat` ownership flag and its clears) entirely. Added a
"script my plan" button next to "new conversation" that takes the turn-by-turn
conversation and asks the selected planning model (one-shot /api/chat, no
conversation_id so it doesn't pollute the thread) to synthesize a single concise
production brief -- setting/mood, length, key beats in order, characters and when
they appear -- and drops that into the brief box, which the Plan step then feeds
to the storyboard model. The user reviews/edits the brief before hitting plan.

### Code
- `public/planner.html`: `#planner-chat-script` ("script my plan") button in the
  chat actions row.
- `public/planner.js`: removed the sendChat auto-fill + `briefFromChat` (decl,
  sendChat, clear-brief handler, brief input listener); added `scriptMyPlan()`
  (summarize transcript -> brief) and its init wiring.
- `package.json`: version 0.133.3 -> 0.134.0.

## v0.133.3

Two frontend ergonomics tweaks. (1) The main chat composer now auto-grows to
fit the whole message as you type instead of wrapping inside a fixed one-line
box. The CSS already tried this with `field-sizing: content`, but that property
only lands in very recent Chrome/Firefox/Safari, so for most browsers the field
stayed one line tall and scrolled internally; replaced it with a JS auto-grow
(`autoGrowUserInput`, height set from `scrollHeight` on input + at every
programmatic value change) plus `overflow-y: auto`. The existing
`min-height: 2.75rem` / `max-height: 40vh` clamps still bound it (grows to 40%
of the viewport, then scrolls). `box-sizing: border-box` is global and the
composer textarea has `border: 0`, so `height = scrollHeight` is exact.
(2) Added a red "clear brief" button on the vivijure planner, on the cast
field's header row pushed to the far right (aligned with the cast box); it wipes
the brief textarea, resets the `briefFromChat` ownership flag, and persists the
empty state.

### Code
- `public/app.js`: `autoGrowUserInput()` + `input` listener; called at the four
  sites that set the composer value programmatically (new chat, post-send
  clear, voice utterance, load-turn-for-edit).
- `public/planner.html`: `.planner-cast-header` wrapper + `#planner-brief-clear`.
- `public/planner.js`: wire `#planner-brief-clear` to clear the brief.
- `public/styles.css`: composer textarea JS-driven sizing (drop
  `field-sizing: content`, add `overflow-y: auto`); `.planner-cast-header` +
  `.planner-clear-brief` styles.
- `package.json`: version 0.133.2 -> 0.133.3.
- typecheck: clean. tests: unchanged (frontend-only).

## v0.133.2

Visible "back to storyboard planner" link on the cast screen. The cast page
already linked to /planner.html via the topbar Vivijure brand and an account-
popover item, but neither reads as "go back," so users got stranded on cast.
Added an explicit `&#8592; back to storyboard planner` link in the cast header
(right side of the title row). HTML + CSS only.

### Code
- `public/cast.html`: back link in `.cast-header`.
- `public/styles.css`: `.cast-back-link` style.
- `package.json`: version 0.133.1 -> 0.133.2.

## v0.133.1

Extend the v0.133.0 picker treatment to the other model-id override fields. The
remaining free-text model-id inputs were typo magnets that also accepted
un-primed ids (which fail offline on the pod), and the two Wan fields still had
stale "Wan 2.1" placeholders even though 0.4.81 baked Wan 2.2. Converted to
selects of the bases actually primed on the volume:
- SDXL base (img2img / portrait path): auto / SDXL Turbo / Animagine / RealVisXL
  / SDXL base 1.0 (turbo allowed here, unlike the keyframe base).
- I2V model: auto / Wan 2.2 I2V A14B.
- T2V model: auto / Wan 2.2 T2V A14B.
Left the face-lock escape hatches (InstantID base/controlnet/adapter, IP-Adapter
repo/subfolder/weight) as free text -- each has effectively one primed value and
they are deliberate power-user overrides. No JS change: the collectors already
read `.value`. FIELD_HELP entries for the three fields updated.

### Code
- `public/planner.html`: `#planner-wd-t2v-model-id`, `#planner-wd-i2v-model-id`,
  `#planner-ld-model-id` inputs -> selects of primed bases (stale Wan 2.1
  placeholders removed).
- `public/planner.js`: FIELD_HELP for those three rewritten for the pickers.
- `package.json`: version 0.133.0 -> 0.133.1.

## v0.133.0

Keyframe SDXL base is now a picker, not a free-text model id. The advanced
"keyframe SDXL model id" field was a text input, which is a typo magnet and let
users enter an un-primed id that fails offline on the pod. Replaced with a
`<select>` of the SDXL keyframe bases actually primed on the volume: auto / pod
default (photoreal RealVisXL V5.0), anime (Animagine XL 4.0), photoreal
(RealVisXL V5.0), neutral (SDXL base 1.0). Turbo is intentionally omitted (the
pod refuses it as a keyframe base since it ignores negatives). This is the main
art-style lever for a render: the chosen base renders each shot's SDXL keyframe,
which Wan I2V then animates. No JS change needed -- collectLocalDiffusionOverrides
already reads `.value`, which behaves identically for a select; empty value = no
override = pod default. The `?` help entry was updated to describe the choices.

### Code
- `public/planner.html`: `#planner-ld-keyframe-model-id` input -> select with the
  four primed-base options.
- `public/planner.js`: FIELD_HELP[`planner-ld-keyframe-model-id`] rewritten for the
  picker (popover still auto-derives the allowed values from the options).
- `package.json`: version 0.132.2 -> 0.133.0.

## v0.132.2

Cast image gen falls back to Nano Banana Pro when FLUX-2's safety checker keeps
flagging. Isolated live: FLUX-2 (klein-9b AND dev) deterministically returns
"3030 ... output flagged" on some fine reference images (masked / glowing-red-
eyes characters), while `google/nano-banana-pro` renders the identical image at
HTTP 200. The v0.132.1 retry only beats random flags, so a borderline character
still dead-ended on the FLUX-2 picker. Now, after the retries exhaust on a flag,
`chatImageWithRetry` retries once on `google/nano-banana-pro` (unless that was
already the selected model) before surfacing the error. Other errors still
propagate immediately; a genuinely unsafe input still fails on the fallback too.

### Code
- `public/cast.js`: `FLAG_FALLBACK_MODEL` + `postChat()` helper; `chatImageWithRetry`
  falls back to the permissive model after a persistent flag.
- `package.json`: version 0.132.1 -> 0.132.2.

## v0.132.1

Auto-retry cast image generation on a provider safety false-positive. The image
models' safety checker (FLUX-2 / nano-banana) sometimes returns "3030 ... your
output has been flagged ... choose another prompt / input image" on perfectly
fine inputs (e.g. a masked character holding a stylized weapon), and the flag is
nondeterministic per call since each generation rolls a fresh seed. Previously a
single flag hard-failed the portrait / training-set / joint-reference generators
on the first roll. Now those calls retry up to 3 times on a flag before
surfacing the error; only safety flags are retried (bad model / network / etc.
still propagate immediately). Does not defeat a genuinely-flagged input (a source
image that trips the checker every time will still fail after the retries), and
costs up to 3 generation calls in the worst case. No backend change.

### Code
- `public/cast.js`: `isFlaggedError()` + `chatImageWithRetry()` helper next to
  `api()`; the three `/api/chat` image-gen call sites (generatePortrait,
  training-set loop, joint two-character) now route through it.
- `package.json`: version 0.132.0 -> 0.132.1.

## v0.132.0

Three planner fixes from live use.

1. Auto-fill the brief from the "ask the model" chat. The user no longer
   copy/pastes the model's reply into the brief; each assistant turn populates
   `#planner-brief` automatically. Non-destructive: it only fills when the brief
   is empty or was itself last filled by chat (a manual edit takes ownership via
   the brief `input` listener and stops the auto-overwrite), so a hand-written
   brief is never clobbered. Status note "reply copied into the brief" confirms.
2. Audio step no longer renders blank. `showAudioSection()` set the section's
   `hidden` attribute true whenever there was no storyboard, and since
   `showStep()` only toggles the `step-hidden` class (not the attribute),
   landing on the Audio step without a storyboard showed nothing. Now the
   section always reveals; the functional blocks (generate / upload / BPM-snap)
   are hidden behind a "plan or load a storyboard first" placeholder until a
   storyboard exists, and `showStep("audio")` re-evaluates on entry.
3. Render "time remaining" computes a real ETA. The v0.44.0 ETA scaffold
   extrapolates from a 0-1 progress fraction, but the serverless pod streams
   progress as log TEXT ("Scene N/3"), not structured scene_index/scene_total,
   so the fraction was always null and the ETA stuck at "computing...". Parse
   the latest "Scene N/M" out of the log and feed the existing extrapolation.

No backend change; no em/en-dashes.

### Code
- `public/planner.js`: `briefFromChat` flag + brief auto-fill in `sendChat` and
  ownership-clear in the brief `input` listener; `showAudioSection()` reveals +
  placeholder-gates instead of hiding, `showStep("audio")` calls it on entry;
  `computeProgressFraction()` falls back to parsing "Scene N/M" from `out.log`.
- `public/planner.html`: `#planner-audio-locked` placeholder in the audio stage.
- `package.json`: version 0.131.1 -> 0.132.0.

## v0.131.1

Reposition + restyle the v0.131.0 planner chat per feedback. The "ask the model"
box now sits directly under the model picker (model -> chat -> brief -> cast)
inside the plan form, instead of as a separate stage below the plan controls,
and it reuses the main chat UI's send button (`.composer-send`, the gradient
arrow) instead of a text "send". To make that button a real shared component,
its CSS was de-scoped from `#run.composer-send` to `.composer-send` (the main
chat's `#run` still carries the class, so it is visually unchanged). The chat
input also now matches the main composer's keybinding: Enter sends, Shift+Enter
inserts a newline (was Cmd/Ctrl+Enter). No backend change. tsc clean, tests pass.

### Code
- `public/planner.html`: move `#planner-chat` from a post-form `.planner-stage`
  section to a `.planner-field` block between the model and brief fields; swap
  the send button to `.composer-send` + the arrow SVG; new `.planner-chat-head`
  label/status row.
- `public/styles.css`: de-scope `#run.composer-send` -> `.composer-send` (5
  rules) so the send button is reusable; add `.planner-chat-head`.
- `public/planner.js`: chat input keybinding Enter-to-send / Shift+Enter newline.
- `package.json`: version 0.131.0 -> 0.131.1.

## v0.131.0

Freeform "ask the model" chat in the planner. The planner previously exposed the
planning model only through Plan (structured storyboard) and refine (which
rewrites an existing storyboard); there was no way to just type a prompt and read
the model's reply in that window. This adds a multi-turn chat thread to the
planner, always visible and independent of any storyboard, that talks to the
model selected in the brief's picker via the existing POST /api/chat. Memory is
server-side: each turn passes conversation_id back so the worker replays prior
turns from D1; the client keeps only a display log plus the id, persisted across
tab closes at the top level of the planner stash (so it survives even before a
storyboard is planned). Reuses the refine thread's styling and pattern. Backend
unchanged (/api/chat already supported this). No em/en-dashes.

### Code
- `public/planner.html`: new `#planner-chat` section (turns list, input,
  send + "new conversation" buttons) after the brief/plan controls; reuses
  `.planner-refine-*` styling.
- `public/planner.js`: `planState.chatHistory` + `chatConversationId`;
  `sendChat` / `renderChatTurns` / `clearChat` / `setChatStatus` mirroring the
  refine thread; top-level persist in the snapshot + storyboard-independent
  restore in `restorePersistedState`; init wiring (click, Cmd/Ctrl+Enter,
  new conversation). `node --check` clean.
- `package.json`: version 0.130.0 -> 0.131.0.

## v0.130.0

Populate the planner's per-option `?` help registry. The v0.124.0 affordance was
a scaffold with an empty `FIELD_HELP`; it now carries 136 plain-language "what it
does" descriptions, one per render-override control across the common row and
every advanced domain group (identity & face, video & motion, image & SDXL, LoRA
& training, continuity & timing, pipeline & production, adetailer, encoding).
Descriptions are sourced from the pod's `CONFIG-REFERENCE.md` (defaults, ranges,
behavior for every config knob) and expanded into operator-friendly language;
the popover still auto-derives allowed values, numeric range, and the pod default
from the control itself, so each entry only supplies the prose. Verified every
key maps to a real control id (no typos), full coverage of the advanced controls,
and no em/en-dashes. Frontend only.

### Code
- `public/planner.js`: `FIELD_HELP` filled with 136 `{ what }` entries grouped by
  domain (no logic change; `buildFieldHelpContent` already merges prose with
  auto-derived values/range/default).
- `package.json`: version 0.129.0 -> 0.130.0.

## v0.129.0

Render-history playback + per-shot download (planner History step). The inline
movie player (HTML5 `<video controls preload="metadata">`, already present for
completed rows with a silent MP4) now renders full card width **directly below
the view / re-render / delete buttons** instead of below the keyframe strip, so
the finished movie is the first thing under the actions. Each SDXL keyframe gets
an explicit per-shot **download** button (saves `<project>-<shot>.png`), and
clicking a keyframe thumbnail now opens an inline **lightbox** preview (dim
backdrop, large still, caption + download, click / Escape to dismiss) instead of
a raw new-tab. `preload="metadata"` keeps opening a row from pulling the whole
MP4 (the fetch starts on play). The full-movie download was already there.
Per-shot motion clips (the short Wan video per shot) are a tracked follow-up:
they are not saved to R2 / exposed in the row yet, which needs pod-side work.
Frontend only.

### Code
- `public/planner.js`: movie player block moved to render right after
  `.planner-history-actions`; per-keyframe `download` link + `shotStillFilename`;
  thumbnail click opens `openShotPreview` / `ensureShotLightbox` (singleton
  overlay) instead of `target="_blank"`.
- `public/styles.css`: `.planner-history-keyframe-dl`; `.planner-lightbox` +
  figure / image / bar / download styles.
- `package.json`: version 0.128.0 -> 0.129.0.

## v0.128.0

Fix: default the LoRA quality gate OFF to stop wasting GPU. The gate renders
`probe_count` (default 2) SDXL probe keyframes PER SLOT on the GPU just to score a
weak grayscale-SSIM similarity to the cast portrait -- a metric we never trust
(disabled in every smoke). Worse, on the pod the baked `enabled: false` sits at
the wrong config path (`loras.training.quality_gate`, while `gate_cfg()` reads
`loras.quality_gate`), so the gate actually ran ON by default, burning extra GPU
on every training. `normalizeQualityGateOverrides` now defaults `enabled: false`
(callers can still opt in with `enabled: true`), so every render / finalize /
cast-train submit tells the pod to skip the probe renders. No pod rebuild needed
(immutable-image: the override does it). GPU-spend reduction with zero quality
loss.

### Code
- `src/runpod-submit.ts`: `normalizeQualityGateOverrides` defaults `enabled: false` and always returns an object (so the override always reaches the pod).
- `tests/runpod-submit.test.ts`: +3 tests for the new default; updated the finalize-payload expectation to include `quality_gate_overrides: { enabled: false }`.
- `package.json`: version 0.127.0 -> 0.128.0.

typecheck clean; 533/533 tests pass.

## v0.127.0

Render-history organization, frontend half (Phase 3b, completes Phase 3 and the
planner modernization). The History step gains folders, tags, and richer search
over the v0.126.0 backend:
- **Filter bar**: a folder `<select>` (all / unfiled / each folder present) and
  a row of clickable tag pills (AND filter: a row must carry every selected
  tag), both derived from the loaded rows. The existing text search now also
  matches folder path + tags.
- **Per-row**: a folder chip + clickable tag pills in the meta bar (click a tag
  to filter by it), and an expanded-row editor with a datalist-backed folder
  input and a comma-separated tags input. Tag suggestions (from the user's full
  tag set via `GET /api/storyboard/renders/tags`) appear as click-to-add pills.
  Edits PATCH the row and update the list optimistically.

Folder / tag filters are session-only (reset on reload); text + status filters
persist as before. Frontend only; the v0.126.0 backend + D1 columns carry it.

### Code
- `public/planner.js`: `historyState.filters.folderPath` + `selectedTags` +
  `historyState.allTags`; `fetchAllTags` / `historyFolders` / `historyRowTags` /
  `rebuildHistoryFacets` / `toggleTagFilter` / `patchRenderOrganization` /
  `buildHistoryOrganizeRow`; `filterRows` extended (folder + tags + search);
  folder chip + tag pills + organize editor in `buildHistoryRow`; folder-select
  listener in init.
- `public/planner.html`: history facets row (folder select + tag-filter
  container) + folder datalist; search placeholder updated.
- `public/styles.css`: facet / tag-pill / folder-chip / organize-editor styles;
  organize editor added to the collapsed-row hide set.
- `package.json`: version 0.126.0 -> 0.127.0.

## v0.126.0

Render-history organization, backend half (Phase 3a of the planner
modernization). Adds two nullable columns to the `renders` table, `folder_path`
(free-form "/"-delimited path, NULL = unfiled) and `tags_json` (JSON array of
short lowercase tags), plus a `renders_by_user_folder` index. The
`PATCH /api/storyboard/renders/:id` route now also accepts `folderPath` (string
or null) and `tags` (string array), normalized + length/count-capped on the
write path; the list endpoint returns both fields on every row; and a new
`GET /api/storyboard/renders/tags` returns the user's distinct tags (most-used
first) for autocomplete. Tag filtering is client-side over the already-loaded
history (matching the existing text / status filters), so there is no JSON
index. The frontend history UI that uses all this lands next (Phase 3b); this
release is additive and changes no existing behavior. Prod D1 migrated via
`migrate-v0.126.0.sql`.

### Code
- `schema.sql` + `migrate-v0.126.0.sql`: `renders.folder_path` + `tags_json`
  ALTERs + `renders_by_user_folder` index (delta applied to prod, not a
  schema.sql re-run).
- `src/renders-db.ts`: `RenderRow.folder_path` + `tags`; `normalizeFolderPath` +
  `normalizeTags` pure helpers; `setRenderFolder` / `setRenderTags` /
  `listUserTags`; new columns in both SELECTs + `normalizeRow`.
- `src/index.ts`: PATCH handler extended with `folderPath` + `tags`; new
  `GET /api/storyboard/renders/tags` -> `handleRenderTagsList`.
- `tests/renders-db.test.ts`: 7 tests for `normalizeFolderPath` / `normalizeTags`
  (530 total).
- `MIGRATIONS.md`: v0.126.0 entry. `package.json`: 0.125.0 -> 0.126.0.

## v0.125.0

Frontend (no worker change): planner render-step declutter, part 2 of 2 (the
regroup). The 13 flat advanced sub-panels are now organized under six collapsed
domain groups inside "advanced settings": identity & face / video & motion (Wan)
/ image & SDXL / LoRA & training / continuity & timing / pipeline & production.
The five structured quick-controls that stayed in advanced (adetailer, seed
mode, multi-character, identity lock, face lock mode) are folded into the
relevant group's top. De-duplication: removed the two block-level seed copies
(`#planner-gen-seed`, `#planner-gen-seed-mode`) that the in-code SDXL-block
comment documents as superseded by the canonical render_overrides seed /
seed_mode; collapsed the duplicate chain-scenes control by removing
`#planner-mv-chain-scenes` and re-pointing `buildMovieOverrides` at the
surviving `#planner-vc-chain-scenes`, so one toggle still drives both
`video_consistency.chain_scenes` and `movie.chain_scenes`.

The `render_overrides` payload is unchanged except for the three intended
de-dups: verified the render-section control-id set dropped exactly
`{planner-gen-seed, planner-gen-seed-mode, planner-mv-chain-scenes}` and added
nothing (168 -> 165). The regroup was done with a byte-preserving extract-and-
reassemble pass (no panel markup retyped). The per-option "?" help affordance
(v0.124.0) carries over automatically since it targets every `.planner-field`
under "advanced settings".

### Code
- `public/planner.html`: 13 `.planner-overrides-raw-details` panels regrouped
  under six `.planner-overrides-domain` disclosures; structured quick-controls
  folded into identity & face / image & SDXL; 3 de-dup `<label>` blocks removed.
- `public/planner.js`: `buildMovieOverrides` chain_scenes now reads
  `#planner-vc-chain-scenes` (was `#planner-mv-chain-scenes`).
- `public/styles.css`: `.planner-overrides-domain` group styling; sub-panel
  border reset inside a domain.
- `package.json`: version 0.124.0 -> 0.125.0.

## v0.124.0

Frontend (no worker change): per-option help affordance on the planner render
step. Every render-override control (the common row + everything in "advanced
settings") now gets a small "?" button next to its label; clicking it shows a
popover describing the option. The prose lives in a `FIELD_HELP` registry keyed
by control id (empty for now, to be filled in as options get documented), but
the popover is already useful without an entry: it auto-derives the allowed
values from a `<select>`'s options, the numeric range from a number input's
`min` / `max` / `step`, and the pod default from the input's placeholder. So
the affordance reserves the space now and documenting an option later is just
adding a `FIELD_HELP` entry. Icons are injected at init (registry-driven, no
markup churn across ~130 controls); the popover closes on outside-click /
Escape.

### Code
- `public/planner.js`: `FIELD_HELP` registry + `attachFieldHelp()` (injects the
  `?` into `.planner-overrides-common` / `.planner-overrides-details` fields) +
  `buildFieldHelpContent()` (auto-derives values/range/default) + a singleton
  popover with outside-click / Escape close; `attachFieldHelp()` called once at
  init.
- `public/styles.css`: `.field-help` icon, `.field-help-pop` popover,
  `.planner-field > span.has-help` inline-flex (scoped to injected labels).
- `package.json`: version 0.123.0 -> 0.124.0.

## v0.123.0

Frontend (no worker change): planner render-step declutter, part 1 of 2 (render
config tiering). The render step opened onto ~8 structured fields plus 16
always-listed advanced accordions plus two raw-JSON textareas, all stacked. Now
the default view is the five canonical knobs: quality tier + keyframes-only
(already there) and a new always-visible common row of seed / lora scale /
consistency. Everything else collapses into one "advanced settings" disclosure,
and the two raw-JSON escape hatches (prompt templates + catch-all render
overrides) move into a separate collapsed "expert: raw JSON" disclosure at the
bottom so structured knobs aren't buried under free-form JSON. The
`render_overrides` payload shape is identical: every control still feeds the
same key and empty still means "use bundle default" (verified the render-section
control-id set is byte-identical before/after). Part 2 will regroup the 16
advanced accordions into ~6 domain groups and de-duplicate the redundant copies.

### Code
- `public/planner.html`: render step restructured into common row +
  `advanced settings` + `expert: raw JSON`; `#planner-seed` / `#planner-lora-scale`
  / `#planner-consistency` lifted into `.planner-overrides-common`;
  `#planner-pt-json` + `#planner-render-overrides` moved into `.planner-overrides-expert`.
- `public/styles.css`: `.planner-overrides-common` grid + `.planner-overrides-expert`
  block styling; expert textareas added to the full-width textarea rule.
- `public/planner.js`: restore + rerun-from-history now open the `expert`
  disclosure (not `advanced`) for carried-forward raw overrides; no serializer
  change (`collectOverrideBlocks` / `buildRenderOverrides` untouched).
- `package.json`: version 0.122.7 -> 0.123.0.

## v0.122.7

Frontend (no worker change): Vivijure-brand the studio shell. The planner + cast
pages now carry their own "Vivijure" wordmark on the left of the shared
`.topbar`, with a single subdued "skyphusion" link on the right as the way back
to the playground front page (matching the modernized front-page brand). The
duplicated top-nav row (Chat / Vivijure / Cast / Voice) is gone; cross-app
navigation (Storyboard planner / Cast / Voice) lives in the account drawer, so
each destination has exactly one link. cast.html is migrated off the legacy
`.wv-topbar` onto the same chrome as planner.html, and the now-unused
`.wv-topbar` CSS block (105 lines) is deleted.

### Code
- `public/planner.html`: topbar reworked to Vivijure brand + single skyphusion
  home link; account drawer trimmed to Cast + Voice (Chat link dropped, covered
  by the skyphusion brand link).
- `public/cast.html`: swapped `.wv-topbar` markup for the shared `.topbar` /
  `.brand` / `.account-menu` chrome (Vivijure-branded), account drawer links to
  planner + voice.
- `public/styles.css`: added `.topbar-spacer` / `.brand-vivijure` / `.brand-home`;
  removed the dead `.planner-nav` rules and the entire legacy `.wv-topbar` block.
- `package.json`: version 0.122.6 -> 0.122.7.

## v0.122.6

Frontend fix (no worker change): expand the squished "prompt templates
(advanced, JSON)" textarea in the planner's render step. Only
`#planner-render-overrides` carried the full-width monospace treatment, so the
sibling `#planner-pt-json` textarea fell back to the browser's narrow
default-cols width and rendered as a tiny box. Generalize the rule to every raw-
JSON textarea inside `.planner-overrides-raw-details` and give them a 7rem
min-height; bump the prompt-templates default rows 4 -> 8.

### Code
- `public/styles.css`: `#planner-render-overrides` rule generalized to
  `.planner-overrides-raw-details textarea` + `min-height: 7rem` + `line-height`.
- `public/planner.html`: `#planner-pt-json` rows 4 -> 8.
- `package.json`: version 0.122.5 -> 0.122.6.

## v0.122.5

CI fix (Jenkins only, no worker change): make the `skyphusion-ci` deploy stage
able to deploy the containers-Worker. `wrangler deploy` builds the three
Cloudflare Container images (`containers/{audio-beat-sync,image-prep,video-finish}`)
before publishing, which needs the Docker CLI + daemon; the plain `node:22` agent
had neither, so the v0.122.4 deploy aborted with "The Docker CLI is needed to build
the configured images." Give the agent real Docker access:
- New `ci/node-docker.Dockerfile` (`node:22` + Docker CLI + buildx), built/pushed
  on mindcrime-ci as `ghcr.io/skyphusion/ci-node-docker:latest`. (Currently present
  locally on the runner; the GitHub PAT in CI lacks `write:packages` so the GHCR
  push is pending a token with that scope. Jenkins uses the local image regardless.)
- Jenkinsfile agent now uses that image and bind-mounts the host Docker socket with
  `--group-add 988` (the `docker` gid on mindcrime-ci), so wrangler's container
  builds run against the host daemon. Still runs as the Jenkins uid (keeps the
  v0.122.4 non-root workspace-cleanup fix).
- Pipeline timeout raised 20 -> 60 min, since a full deploy rebuilds all three
  container images.

### Code
- `ci/node-docker.Dockerfile` (new): CI agent image (node + Docker CLI + buildx).
- `Jenkinsfile`: custom agent image + Docker socket mount + `--group-add 988`; timeout 20 -> 60 min.
- `package.json`: version 0.122.4 -> 0.122.5.

## v0.122.4

CI fix (Jenkins only, no worker change): the `skyphusion-ci` pipeline ran its
`node:22` Docker agent as root (`args '-u root:root'`), so npm wrote root-owned
files (`.npm` cache/logs, `node_modules`) into the bind-mounted workspace. The
next build's git checkout runs as the host `jenkins` user, which cannot delete
those root-owned files, so every build after the first failed at "Failed to clean
the workspace / Operation not permitted" before any stage ran. Drop the
`-u root:root` so the container runs as the Jenkins uid (`HOME=$WORKSPACE` already
makes npm work without root); files are now jenkins-owned and cleanable. Also move
the `wrangler.toml` scrub into the Deploy stage's own `post` (a top-level `post`
`sh` threw `MissingContextVariableException` when a build failed before the agent
came up). The already-poisoned `skyphusion-ci_main` workspace was cleared on the
runner by hand (root-owned files predating this fix).

### Code
- `Jenkinsfile`: drop `-u root:root` from the docker agent; move `wrangler.toml` cleanup to the Deploy stage `post`.
- `package.json`: version 0.122.3 -> 0.122.4.

## v0.122.3

Deployment hygiene (no runtime changes): standardize the committed resource names
to match production, ship the migration delta v0.122.0 forgot, and split the
migration runbook out of the README.

- **Resource names.** The committed config/docs referenced placeholder names
  (`skyphusion-llm-public`) for the D1 database and R2 bucket; production uses
  `skyphusion-llm` for both, `vivijure` for the `R2_RENDERS` bucket (the same
  bucket the vivijure-serverless GPU worker reads/writes), and `skyphusion-llm-vec`
  for Vectorize (already correct). Aligned `wrangler.example.toml` (incl. the worker
  `name` + `R2_RENDERS` bucket), the CLAUDE.md binding table (and added the missing
  `R2_RENDERS` row), the README setup commands, and the older migrate files' Apply
  comments. The package/repo name and `git clone` dir are unchanged. Historical
  CHANGELOG command examples are left as-is (append-only record).
- **`migrate-v0.122.0.sql`.** The `renders.finish_state` column (v0.122.0) shipped
  in `schema.sql` (matching the pervasive trailing-ALTER pattern there) but no
  per-version delta was provided for existing DBs. Added now.
- **`MIGRATIONS.md`.** Moved the per-version migration runbook out of the README
  (now a pointer) into a dedicated guide, and backfilled the delta files the README
  never documented (v0.34.0, v0.36.0, v0.39.0, v0.40.0, v0.42.0, v0.122.0).

### Code
- `migrate-v0.122.0.sql` (new): `ALTER TABLE renders ADD COLUMN finish_state TEXT;`.
- `MIGRATIONS.md` (new): the extracted + backfilled migration runbook.
- `README.md`: migration section replaced with a one-line pointer; setup commands renamed.
- `wrangler.example.toml`, `CLAUDE.md`, `migrate-v0.20.0/0.20.2/0.20.3/0.34.0.sql`: name alignment.
- `package.json`: version 0.122.2 -> 0.122.3.

Apply (existing D1; fresh DBs get the column from `schema.sql`):
```bash
wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.122.0.sql
```

No source/test changes; typecheck clean, 523 tests still green.

## v0.122.2

Fix: off-GPU finished renders were unviewable in the UI ("No video with supported
format and MIME type found"). The video-finish container PUTs the assembled MP4
via a presigned URL, which does not carry the `user_email` customMetadata that
`handleArtifact`'s ownership check requires (the on-GPU boto3 upload sets it), so
the artifact fetch 403'd. resolveOffloadedFinish now re-stamps the object via the
R2_RENDERS binding after assembly (customMetadata.user_email from the render row +
content-type=video/mp4). getFinishState also returns user_email. One-time, on the
finishing poll.

### Code
- `src/index.ts`: `resolveOffloadedFinish` re-stamps the assembled MP4 via the `R2_RENDERS` binding (customMetadata.user_email from the render row + content-type=video/mp4) right after the container finishes.
- `src/renders-db.ts`: `getFinishState` also selects `user_email`.
- `package.json`: version 0.122.0 -> 0.122.2.

typecheck clean; 523/523 tests pass.

## v0.122.0

Feature: off-GPU video finishing, second half. The render poll now assembles the
final MP4 on the video-finish container instead of the GPU pod. When a render ran
with `finish_offloaded` (vivijure-serverless 0.4.77), the pod returns the per-shot
clips + a finish manifest but no assembled MP4; on RunPod COMPLETED,
`handleRenderPoll` calls the video-finish container exactly once and patches
`output_key` onto the result. Idempotency is a D1 lock: a new `renders.finish_state`
column (NULL -> 'finishing' -> 'done' | 'failed'); `claimFinish` is an atomic
compare-and-swap so concurrent polls don't double-run the container, and a poll
that loses the claim (or one that kicked off a still-running assemble) reports
`IN_PROGRESS`/`FINISHING` so the client keeps polling without a COMPLETED row
landing before the MP4 exists. `finishInputFromPodOutput` maps the pod's
snake_case manifest (incl. `trim_join_frames` -> `trimJoinFrames`) to the
container contract. renders-db helpers: claimFinish / markFinishDone /
markFinishFailed / getFinishState. +3 unit tests (12 total in video-finish).
Default (no flag) renders are unchanged: on-GPU assembly stays the path + fallback.

Also shipped in this release: Jenkins CI on the mindcrime-ci box, alongside the
existing self-hosted GitHub Actions runner. The root `Jenkinsfile` mirrors `ci.yml`
(npm ci -> typecheck -> test) inside a `node:22` Docker agent and adds a deploy
stage gated to `main` behind a manual approval `input` (30-min timeout so an
unattended build aborts rather than hanging). Deploy injects the gitignored
`wrangler.toml` from a Jenkins Secret file credential (`skyphusion-wrangler-toml`)
and authenticates with the existing `CLOUDFLARE_API_TOKEN` Secret text credential;
it never touches Worker secrets (`wrangler deploy` doesn't push them). Three
per-container pipelines (`containers/<name>/Jenkinsfile`) each build their
Cloudflare Container image (`docker build --platform linux/amd64`, BuildKit on for
the `# syntax=` Dockerfiles) and smoke-test it (run on an ephemeral host port, poll
`/health` for ~60s, dump logs on failure), then tear down the container + image in
`post`. The deploy gate uses `beforeInput true` so only `main` builds prompt for
approval (Jenkins evaluates `input` before `when` by default, which would otherwise
prompt on every PR). The four jobs are wired as multibranch pipelines on the runner
with same-repo branch + origin-PR discovery only (no fork-PR builds, mirroring the
fork guard in `ci.yml`).

### Code
- `src/index.ts`: `handleRenderPoll` off-GPU finish (one container call on COMPLETED) + `finishInputFromPodOutput` manifest mapping.
- `src/renders-db.ts`: `claimFinish` (atomic CAS) / `markFinishDone` / `markFinishFailed` / `getFinishState`.
- `src/video-finish.ts`: container-contract tweaks for the poll-driven finish.
- `schema.sql`: `renders.finish_state` column (NULL -> 'finishing' -> 'done' | 'failed').
- `tests/video-finish.test.ts`: +3 tests (12 in this file).
- `Jenkinsfile` (new): root CI + manual-approval deploy pipeline (Docker `node:22` agent).
- `containers/audio-beat-sync/Jenkinsfile` (new): build + `/health` smoke test.
- `containers/image-prep/Jenkinsfile` (new): build + `/health` smoke test.
- `containers/video-finish/Jenkinsfile` (new): build + `/health` smoke test.
- `package.json`: version 0.121.0 -> 0.122.0.

Schema (apply to existing D1 before deploy; fresh DBs get it from `schema.sql`):
```sql
ALTER TABLE renders ADD COLUMN finish_state TEXT;
```

Jenkins credentials (set on the mindcrime-ci runner; both deploy-stage creds now in place):
- `skyphusion-wrangler-toml` (Secret file): the real `wrangler.toml` (`database_id` +
  `account_id`); copied into the workspace before deploy.
- `CLOUDFLARE_API_TOKEN` (Secret text): Cloudflare API token with Edit Workers perms
  (already present on the runner).

typecheck clean; 523/523 tests pass.

## v0.121.0

Feature: video-finish Cloudflare Container. The render pipeline's tail (concat
the per-shot clips, optional film-style xfade crossfades, mux the soundtrack,
faststart) is pure CPU ffmpeg that used to run on GPU-billed pod seconds; it now
runs on a CPU-only container, the third sibling to the audio-beat-sync and
image-prep containers. `containers/video-finish/` (Python + aiohttp + ffmpeg)
exposes POST /finish { clips:[{url,targetSeconds?}], audioUrl?, outputUrl, ... }
and faithfully ports vivijure-serverless assemble.py (normalize scale/pad/fps/
libx264, hard concat or pairwise xfade 0.1-1.5, audio mux aac 192k -shortest
+faststart, 1-frame tail-trim on hard cuts). New Worker route POST
/api/video/finish presigns the clip + soundtrack GETs and the output PUT and
calls the container with the same warm-/health + retry-on-503 cold-start guard
as image-prep (src/video-finish.ts, src/containers/video-finish.ts, VIDEO_FINISH
binding, wrangler [[containers]] + migration v6). No JIT/model cache to bake
(ffmpeg is a static binary); the only warm is a build-time libx264 sanity-encode.
9 unit tests (tests/video-finish.test.ts; parse + cold-start guard). Container
image built + validated on real libx264 (3-clip xfade+audio, hard+silent). This
is the standalone route; rewiring the pod render flow to call it instead of
assembling on-GPU is a follow-up.

### Code
- `containers/video-finish/` (new): `app.py` (aiohttp `/health` + POST `/finish`, ffmpeg assembly), `Dockerfile` (python:3.11-slim + ffmpeg + build-time libx264 sanity-encode), `requirements.txt`, `.dockerignore`.
- `src/video-finish.ts` (new): `parseVideoFinishInput` + `callVideoFinish` (warm-/health + retry-on-503) + `runVideoFinish` (presign + call).
- `src/containers/video-finish.ts` (new): `VideoFinishContainer` DO wrapper.
- `src/index.ts`: POST `/api/video/finish` route + `handleVideoFinish`; export the DO class.
- `src/env.ts`: `VIDEO_FINISH` binding.
- `tests/video-finish.test.ts` (new): 9 tests (input parse + cold-start guard).
- `wrangler.example.toml`: `VIDEO_FINISH` binding + `[[containers]]` + migration.
- `package.json`: version 0.120.0 -> 0.121.0.

New bindings (add to your `wrangler.toml`; migration tag = your next free tag):
```toml
[[durable_objects.bindings]]
name = "VIDEO_FINISH"
class_name = "VideoFinishContainer"

[[containers]]
class_name = "VideoFinishContainer"
image = "./containers/video-finish/Dockerfile"
max_instances = 3
instance_type = "standard-1"

[[migrations]]
tag = "v6"
new_sqlite_classes = ["VideoFinishContainer"]
```

typecheck clean; 520/520 tests pass.

## v0.120.0

Frontend: modernize the Vivijure storyboard planner chrome and add a guided
stepper (Phase 1 of the planner declutter). The legacy `.wv-topbar` is replaced
with the playground's shared `.topbar` / `.brand` / `.account-menu` chrome
(gradient brand mark, centered page nav, signed-in user + page links in the
account popover), wired by a modernized `topbar.js` that now fills
`#account-email` and drives the popover on pages without `app.js`. The long
single-column pipeline becomes a five-step rail (Plan, Cast & Bundle, Audio,
Render, History): only the active step's `[data-step]` sections render (via a
`.step-hidden` class layered on top of each section's own progressive-reveal
`hidden`), steps unlock as prerequisites are met (a plan unlocks Cast/Audio, a
staged bundle unlocks Render and auto-advances there), and a back/next footer
walks the steps. Pure markup/IA + CSS; no change to the render payload, the
`render_overrides` contract, or any backend route. Also adds a `--success`
design token and migrates the few remaining hardcoded status `rgba()` colors
to it. The History step now always shows its header + an empty-state when there
are no renders, instead of collapsing.

## v0.119.0

Feature: beat-synced storyboard planning. `/api/storyboard/plan` now accepts an
optional `beatPlan` field (forward the `output` of `/api/audio/analyze`). When
present, the planner is pinned to exactly `timedScenes.length` shots and each
scene's `start` / `end` / `target_seconds` is stamped deterministically from the
beat plan, so the cuts land on the beat. The split: the LLM owns shot count +
content (told the exact count and per-shot pacing via a prompt block); the code
owns the frame-accurate seconds (stamped after validation, so model numeric
drift can't move a cut). Top-level `duration_seconds` / `clip_seconds` are set
from the plan (clip_seconds falls back to the median shot length). Count drift
between model and plan is reconciled (extra scenes dropped, underflow stamped as
far as it goes) and surfaced in a non-fatal `timingWarnings` array on the
response. New pure module `src/beat-timing.ts` (parse + prompt block + stamp),
11 unit tests in `tests/beat-timing.test.ts`. No change to the audio container or
the GPU pod; this is purely the planner-side bridge that was previously missing
(the beat plan was returned to the client but never consumed by planning).

### Code
- `src/beat-timing.ts` (new): `parseBeatTimingInput` + `buildBeatTimingBlock` + `applyBeatTiming` (pure).
- `src/index.ts`: `/api/storyboard/plan` accepts `beatPlan`, injects the prompt block, stamps timing after validation, surfaces `timingWarnings`.
- `src/planner.ts`: `PlanStoryboardArgs.beatBlock` threaded into the planning user message.
- `src/planner-prompt.ts`: `buildPlanningUserMessage` optional 3rd `beatBlock` arg.
- `tests/beat-timing.test.ts` (new): 11 tests.
- `package.json`: version 0.118.1 -> 0.119.0.

typecheck clean; 511/511 tests pass.

## v0.118.1

Fix: voice STT broke because Deepgram Flux changed its event shape. Turn events
are now nested as `{type:"TurnInfo", event:"EndOfTurn", ...}` (they used to be
flat `{type:"EndOfTurn"}`). Our parsers keyed on `ev.type`, which is now always
`"TurnInfo"`, so `EndOfTurn` was never detected: the voice-chat loop never sent
anything, the standalone STT never committed/persisted turns, and the idle
session eventually died ("socket error"). Added a `fluxEventName()` normalizer
(tolerates both shapes) used by the widget, the voice-chat loop, and the
SttSession DO. Verified the upstream socket itself is healthy (101 + Connected +
TurnInfo events) via a direct WS probe.

## v0.118.0

**Voice chat: talk to any chat model and hear it reply, hands-free.**

A mic button in the composer (chat models only) starts a hands-free loop: your
speech is transcribed by the Flux STT container, each finished turn is sent to
the selected chat model through the normal send path, and the reply is spoken
back via Deepgram Aura-2 TTS, end to end on Cloudflare. The mic mutes itself
while the model is thinking/speaking so it doesn't transcribe the reply, then
resumes listening. Works with all 35 chat models; the conversation lands in
history like any other.

- `src/index.ts`: `POST /api/tts` synthesizes text to speech (Aura-2) and streams
  the audio bytes straight back, with NO chats row (unlike the tts model path),
  since the loop speaks every reply.
- `public/voice-widget.js`: extracted `createMicStreamer` (mic -> linear16 PCM ->
  /api/stt/stream, with mute) shared by the standalone STT panel and the loop.
- `public/app.js`: the voice-chat controller (STT turn -> run() -> /api/tts ->
  play), a composer mic button with a live pulse + status line.

## v0.117.0

- **Send button actually round + arrow dead-center now**: the v0.116.0 styling
  was on a `.composer-send` class, but the button is `id="run"` and two legacy
  `#run` rules (id-specificity) won, keeping the old `padding` / `border-radius:
  4px` / `min-height: 44px` (a de-centered rounded square). Raised the selector
  to `#run.composer-send` so it wins, and zeroed the stray padding/min-height.

## v0.116.0

- **Modernized the send button**: clean 40px circle with the brand gradient, a
  crisp SVG up-arrow (replacing the off-center text glyph; `svg{display:block}`
  removes the inline-baseline gap so it sits dead-center), and a subtle
  lift-on-hover / press-scale.

## v0.115.0

Composer fixes (from a mobile screenshot).

- **Center the text block** between the paperclip and send button: the composer
  was `align-items: flex-end`, so the textarea text sat at the top while the
  buttons sat at the bottom. Now centered, with the box height tuned per
  breakpoint so the placeholder fills it (no gap above the paperclip).
- **Removed the stray dashed border** around the paperclip (leftover legacy
  `.attach-row` drag-drop styling).
- **Placeholder** drops the "type here, " prefix -> just "enter to send,
  shift+enter for newline".

## v0.114.0

More frontpage polish.

- **Solid popovers**: the account accordion and ⚙ settings menus used a
  translucent glass background, so page content (e.g. "new conversation") bled
  through and made them hard to read. Both are now solid. (The sticky topbar
  stays glassy by design.)
- **Bigger composer**: the long placeholder ("enter to send, shift+enter for
  newline") was clipping; raised the text box baseline height (and more on
  phones) so it shows in full.
- **Paperclip attach**: replaced the verbose "image, audio (auto-transcribed),
  video (sampled to frames), or a text file (inlined)" hint with a paperclip
  icon on the attach button, which reads as "upload a file" without the
  sentence. (Attachment behavior is unchanged; the STT "audio required" hint and
  the FLUX.2 reference-image hint stay.)

## v0.113.0

Two mobile fixes for the model dropdown.

- **Opening it shifted the screen off-center**: the wider (v0.112.0) panel is
  `position: absolute` anchored to the centered trigger, so it overflowed the
  right edge and caused horizontal scroll. On mobile it's now pinned as a
  contained sheet under the topbar (`position: fixed`, anchored to the topbar's
  bottom so it survives notch safe-area height).
- **The on-screen keyboard popped up on every open** because the search box was
  auto-focused. Auto-focus is now gated to precise-pointer (desktop) devices, so
  touch users get the dropdown without an unwanted keyboard.

## v0.112.0

Fixes for the v0.111.0 frontpage polish.

- **Model dropdown stayed open**: the new `.model-picker-panel { display: flex }`
  overrode the UA `[hidden]{display:none}` the picker toggles with, so it never
  closed. Added a `.model-picker-panel[hidden]{display:none}` guard (same guard
  audited for the voice panel, which had the same latent trap).
- **Squished model labels**: widened the dropdown (min 340px, up to 460px) and
  let labels wrap to their full text instead of truncating onto one line.
- **Composer text box**: taller baseline (and taller still on phones) so it
  doesn't squish on mobile.
- Restored the voice (conversational STT) panel styling that was dropped when
  the inline `<style>` was removed during the v0.110.0 rewrite.

## v0.111.0

Follow-up polish on the focus-mode frontpage.

- **Account accordion** (top-right): a person-icon menu whose first row shows the
  signed-in email (reserved for a future user-preferences screen), then
  "Vivijure Studio / AI Video Pipeline" and "Voice / Conversational STT". The
  ⚙ system-prompt/settings button sits to its left. Both popovers are mutually
  exclusive and close on outside-click / Escape. The Vivijure + voice links left
  the sidebar (Vivijure is now one entry, no "storyboard"/"cast" split).
- **Searchable model picker**: a filter box at the top of the dropdown live-
  filters models by name (hides empty groups; Enter picks the first match).
- **Cleaned model labels**: removed "(needs CF credits)" and "BYOK" markers from
  the visible labels (`src/models.ts`); the worker still routes by `provider` /
  `byok_alias`.
- **History search**: a search box at the top of the history sidebar filters the
  conversation list client-side.
- **Composer placeholder** now reads "enter to send, shift+enter for newline".

## v0.110.0

Modern "focus-mode" redesign of the playground frontpage, mobile-first, with a
bold skyphusion rebrand. The old two-pane, control-heavy layout was cluttered;
this strips it back to a single conversation column and a floating composer.

### What ships

- **Focus-mode layout** (`public/index.html` + `public/styles.css`): the
  sidebar (history / projects / documents) becomes a slide-in overlay (☰),
  reachable at any width; the conversation is a centered reading column; the
  composer floats at the bottom as one rounded bar with inline + (attach) and ↑
  (send). System prompt, "use my docs", "search the web", and the active-project
  chip move into a ⚙ settings popover instead of always-on controls.
- **Bold rebrand**: a cosmic sky-fusion palette on a deep-space base, a gradient
  brand mark + wordmark, a subtle aurora glow, and a gradient send button. New
  `:root` tokens (the palette change carries across the Vivijure tool pages too,
  for consistency).
- **Single "Vivijure studio" menu entry** in the sidebar (no more separate
  "storyboard" / "cast" items on the main page; that sub-nav lives inside
  Vivijure's own pages). "voice" stays a separate playground tool link.
- **Mobile-optimized**: safe-area insets (notch / home bar), 16px composer/input
  fonts (no iOS zoom-on-focus), larger touch targets, a near-full-width settings
  sheet, and hover-free affordances on touch devices.

### Notes

- `app.js` keeps its full element/ID contract; the only behavior changes are the
  ⚙ popover toggle and routing the composer show/hide through `.composer`.
- The standalone `/stt.html` already shed the Vivijure topbar in v0.109.0.

## v0.109.0

- `public/stt.html`: drop the Vivijure topbar (logo + cast/storyboard-planner
  nav + user pill) and the `topbar.js` it pulled in. Conversational STT is a
  skyphusion-llm playground feature, not part of the Vivijure video pipeline, so
  it shouldn't carry that chrome. Replaced with a plain "back to chat" link. The
  "voice" cross-links in the genuine Vivijure tools' topbars (cast/planner) stay
  (they parallel the existing "chat" cross-link to the playground).

## v0.108.0

Finishes conversational STT (`@cf/deepgram/flux`): the live mic session now
persists to history, shows up as a first-class "voice" model, and is reachable
from the main chat composer (not just the standalone `/stt.html` page).

### What ships

- **`SttSession` Durable Object** (`src/stt-session.ts`). `/api/stt/stream`
  forwards the WS upgrade to a per-session DO (`newUniqueId`) instead of a plain
  Worker relay. The DO accepts the browser socket via the Hibernation API,
  bridges to the upstream flux socket (audio up / Deepgram events down),
  accumulates each `EndOfTurn` into DO SQLite (hibernation-safe; the in-memory
  outbound upstream socket is not, but an active session streams continuously
  and never idles long enough to hibernate, with a guard if it does), and on
  close writes one `chats` row (`model_type: "voice"`) so the session lands in
  `/history`. New `STT_SESSION` binding + `v5` migration (`new_sqlite_classes`).
- **`type: "voice"`** model type + a `@cf/deepgram/flux` catalog entry. It is a
  live session, not a request/response turn, so `/api/chat` rejects it with a
  pointer to the WS endpoint; the UI special-cases it.
- **Composer mic affordance.** Selecting the voice model swaps the text composer
  for an inline live panel (start/stop, live captions, committed turns).
  Conversations from voice sessions show a 🎙 icon in the history sidebar.
- **`public/voice-widget.js`**: the STT client (mic capture, linear16 PCM
  resample, WS, turn rendering) extracted into a reusable factory shared by
  `/stt.html` and the composer. Removed the TEMP `/api/stt/selftest` probe.

### Notes

- `buildTranscript` + `sanitizeCloseCode` are split into `src/stt-util.ts` (no
  `cloudflare:workers` import) so they unit-test in the node pool. 500 tests pass.
- Verified live earlier: the upstream flux handshake works and the DO binding
  resolves; a real mic round-trip + the history row should be confirmed in the
  browser post-deploy.

## v0.107.0

CPU-bound media prep moves off the GPU pod onto Cloudflare Containers: audio beat
analysis and cast-portrait background removal now run in CF Containers the Worker
calls directly, keeping the RunPod worker purely GPU-bound. Both containers were
built and verified live on Cloudflare.

### What ships

- **Audio beat-sync container** (`containers/audio-beat-sync/`, librosa). `POST
  /api/audio/analyze` is now a single synchronous call: presign an R2 GET, POST
  it to the container's `/analyze`, normalize the snake_case plan inline. Drops
  the v0.105.0 GPU-pod submit/poll pair (the pod `analyze_audio` action was
  reverted in vivijure-serverless 0.4.60) and the `GET /api/audio/analyze/:jobId`
  poll route. `planner.js` `analyzeBeats` consumes the result inline (no poll).
  Removed the dead `submitAnalyzeAudioJob` / `buildAnalyzeAudioPayload` /
  `AnalyzeAudioJobInput` from `runpod-submit.ts`.
- **Image-prep container** (`containers/image-prep/`, rembg). Cast portraits go
  through `IMAGE_PREP`'s `/portrait/prep` at bundle time (`assembleBundle`):
  presign GET (source) + PUT (cleaned dest), the container removes the background
  and PUTs an alpha PNG, which we read back into the tar. Content-addressed in R2
  (`cast-clean/<sha256>.png`) so repeat bundles reuse it. Best-effort: a container
  failure falls back to the original portrait rather than failing the bundle.
- **`src/r2-presign.ts`**: R2 (S3-compatible) SigV4 GET/PUT query presigning over
  Web Crypto, so the containers (which hold no R2 binding) can fetch + write R2
  objects directly. New env: `R2_S3_ACCESS_KEY_ID`/`R2_S3_SECRET_ACCESS_KEY`
  (secrets), `R2_S3_ENDPOINT`/`R2_S3_BUCKET` (vars).
- **Container DO wrappers** (`src/containers/`), `AUDIO_BEAT_SYNC` + `IMAGE_PREP`
  bindings, and wrangler container/DO/migration config (`new_sqlite_classes`).

### Notes

- Container cold-start was the hard part. Both pin a persistent, CPU-portable
  numba cache into the image (`NUMBA_CPU_NAME=generic` + a whole-second mtime
  touch so buildkit's mtime truncation doesn't invalidate it) so first-request
  JIT is ~1.5s, not ~46s. image-prep also imports rembg lazily (no startup warm,
  which starved the port-bind on the small-core CF instance). A fully-cold
  container can still 503 a heavy request racing its bind, so `callImagePrep`
  warms with `/health` and retries `/portrait/prep` on 503.
- `tests/audio-analyze.test.ts` (parser) + `tests/image-prep.test.ts` (the 503
  guard). 496 tests pass.
- Pod-side follow-up (separate vivijure-serverless commit): strip rembg from
  `multi_character_regional.py` + the pod Dockerfile once this is in production.

## v0.106.0

Planner UI for audio beat-sync (consumes the v0.105.0 routes), plus a latent-bug fix uncovered while wiring it.

### What ships

- `public/planner.html` + `public/planner.js`: an "analyze beats (auto)" control in the audio bed section (with a "seconds per shot" input). It POSTs `/api/audio/analyze`, polls `/api/audio/analyze/:jobId` every 2s (60s cap) mirroring the music-gen poll, shows `BPM · shots · duration · note`, and an "apply to storyboard" button that writes the plan's beat-aligned `target_seconds` onto the overlapping scenes (non-destructive: never adds/deletes scenes; reports any count mismatch). Clamps to `STORYBOARD_MAX_SCENES` (50) with a warning. Apply is disabled for duration-mode plans with no per-scene cuts.
- **Bug fix:** `planner.js` declared `finalizeRender` twice (a sync `(data)` render-poll display fn and an `async (row, btnEl)` finalize-action fn). In sloppy mode the second silently shadowed the first, so render-poll completion (two call sites) was invoking the wrong function. Renamed the poll-display fn to `finalizeRenderPoll` + its callers. (Adding top-level `const`/`let` for the beat-sync code made V8 reject the duplicate outright, which surfaced it; it would otherwise have kept misbehaving silently.)

### Notes

`target_seconds` is the only field written (the renderer consumes it; consecutive durations summing across scenes is what lands cuts on the beat). End-to-end needs the 0.4.59 pod image live on the endpoint. Browser-untested (no mic/audio here); the analyze submit + poll + apply paths should be verified in the planner once an audio bed + the pod image are available.

## v0.105.0

Audio beat-sync, Worker side (backend). Pairs with the `analyze_audio` pod action in vivijure-serverless 0.4.59; see docs/audio-beat-sync.md. The planner UI hook is a follow-up.

### What ships

- `src/runpod-submit.ts`: `AudioAnalyzeRequest` + `AnalyzeAudioJobInput` types, `buildAnalyzeAudioPayload` (pure, camel->snake, omits defaults), `AudioBeatPlan`/`TimedScene` + `parseAudioBeatPlan` (pod snake_case -> Worker camelCase; null on no valid `mode`; filters malformed `timed_scenes`), and `submitAnalyzeAudioJob` (mirrors `submitRenderJob`).
- `src/index.ts`: `POST /api/audio/analyze` (`handleAudioAnalyzeSubmit`) and `GET /api/audio/analyze/:jobId` (`handleAudioAnalyzePoll`), mirroring the render submit/poll pair. Submit validates `audioKey` (required, `audio/` or `out/`), `clipSeconds > 0`, `mode in {beat,duration}`; routes the key through `placeAudioForGpu` (copies `out/` chat-bucket music output into `R2_RENDERS` under `audio/`); HEADs `R2_RENDERS` (404 before burning a RunPod call); submits. Poll reuses `pollRenderJob`/`isValidJobId` and parses the COMPLETED `output` via `parseAudioBeatPlan` (502 + raw on parse failure).
- `tests/audio-analyze.test.ts`: 9 tests for the two pure helpers.
- `docs/audio-beat-sync.md`: the spec.

### Next

Planner UI: an "analyze beats" button in the audio section that submits + polls, shows BPM/shots/note, and an "apply to storyboard" that writes `timedScenes` into scene `target_seconds`/`start`/`end` (with a `STORYBOARD_MAX_SCENES` cap warning). End-to-end needs the 0.4.59 pod image live on the endpoint.

## v0.104.0

Added conversational speech-to-text via Deepgram Flux (`@cf/deepgram/flux`) over a WebSocket. Phase 1: a standalone `/stt.html` "voice" widget; flux stays out of the model catalog (it is websocket-only, not a request/response chat/STT model).

### What ships

- `src/index.ts`: new `GET /api/stt/stream` WebSocket route. `handleFluxStream` opens the upstream model socket via `env.AI.run("@cf/deepgram/flux", { encoding: "linear16", sample_rate: "16000" }, { websocket: true })` (verified: the binding returns a 101 Response carrying a `.webSocket`), then bridges browser<->upstream: audio frames up (binary linear16 PCM @ 16 kHz), Deepgram turn/transcript events down (JSON). Close codes are sanitized (only 1000 / 3000-4999 are re-sendable; everything else maps to 1011). Bypasses AI Gateway (no `cf-aig-log-id`), since the gateway can't proxy the WS audio.
  - A temporary `GET /api/stt/selftest` HTTP probe is included to confirm the upstream handshake; it will be removed once the mic path is verified end-to-end in a browser.
- `public/stt.html` + `public/stt.js`: the widget. `getUserMedia` -> a 16 kHz `AudioContext` + `ScriptProcessor` -> Float32→Int16 PCM -> WS. Renders the live interim transcript, committed turns, and a raw-events debug panel. CF Access auth rides the same-origin WS upgrade cookie.
- Added a "voice" nav link to the cast/planner/chat pages.

### Notes

Phase 1 is a pure relay with no history persistence; that (and a possible Durable Object for durable sessions) is a later phase. The Deepgram event field names (`type`, `transcript`, `end_of_turn_confidence`, etc.) are handled per the docs but should be confirmed against the raw-events panel on the first live mic test.

## v0.103.0

Added LLaVA 1.5 7B (`@cf/llava-hf/llava-1.5-7b-hf`), an image-to-text (image Q&A) model.

### What ships

- `src/models.ts`: new catalog row, surfaced as a vision chat model (`type: "chat"`, `capabilities: ["vision"]`, no streaming) so it reuses the existing attach-an-image UI with no frontend changes.
- `src/index.ts` `runChat`: a dispatch branch for LLaVA. Unlike chat models it takes `{ image: number[] (raw bytes), prompt, max_tokens }`, not `{ messages }`, and is single-shot (prior turns and system prompt are not threaded). Requires an image attachment (400 otherwise). Goes through the AI Gateway normally (JSON in/out, no stream).
- `src/output-extract.ts`: handle LLaVA's `{ description }` output shape (+ test).

### Notes

LLaVA 1.5 is older/weaker than the existing vision chat models (Llama 3.2 11B vision, Llama 4 Scout, Gemma, Mistral Small 3.1, plus Claude/Gemini vision); it's offered as a lightweight single-shot image-describe option, not a capability upgrade. Multi-turn follow-ups re-run against only the currently attached image.

## v0.102.0

Corrected the SDXL stored mime to `image/png`. v0.100.0 set `image/jpeg` based on the model doc's stated `image/jpg` content-type, but a live generation showed the binding actually returns PNG bytes (`file` reports PNG). The stored artifact mime now matches the bytes; SDXL no longer special-cases the drained-stream mime (all stream-output image models emit PNG).

## v0.101.0

Removed the rembg Cloudflare Container entirely. It was disabled back in v0.98.0 (bg-removal moved pod-side), but the dormant `[[containers]]` config kept making `wrangler deploy` rebuild the container image, and that build started failing on a `requirements.txt` dependency conflict (`pillow==11.0.0`), blocking all deploys.

### What ships

- Deleted `containers/rembg/` (Dockerfile, main.py, requirements.txt, README) and `src/containers/rembg.ts`.
- `src/index.ts`: dropped the `RembgContainer` re-export; updated the cast-portrait comment (bg-removal is pod-side, container gone).
- `src/env.ts`: removed the `REMBG_CONTAINER` binding.
- `wrangler.toml`: removed the `[[durable_objects.bindings]]` + `[[containers]]` blocks; added a `tag = "v2"` migration with `deleted_classes = ["RembgContainer"]` so the already-registered DO class is cleanly torn down (keeping v1 in history). `wrangler.example.toml`: removed the rembg binding/container/migration blocks outright (fresh deploys never had it).
- `package.json`: dropped the now-unused `@cloudflare/containers` dependency.

Net effect: `wrangler deploy` no longer builds a container, so deploys work again. The cast-portrait flow is unchanged (raw passthrough to R2; bg-removal in `vivijure-serverless` at render time).

## v0.100.0

Added Stable Diffusion XL (`@cf/stabilityai/stable-diffusion-xl-base-1.0`) to image generation, a different aesthetic from the FLUX lineup.

### What ships

- `src/models.ts`: new `type: "image"` catalog row, "Stable Diffusion XL (SDXL)".
- `src/index.ts` `runImage`: SDXL reuses the Workers-AI stream-output path (it returns a `ReadableStream` of JPEG, so it joins the `bypassGateway` set with Phoenix/Dreamshaper since AI Gateway can't proxy stream output). Two SDXL-specific tweaks: its step field is `num_steps` (max 20), not `steps`, so the param builder swaps it; and the drained-stream mime is set to `image/jpeg` for SDXL (PNG for the others).

Verified live: generated an image through the deployed worker, non-empty JPEG bytes returned, no error.

## v0.99.0

Synced the catalog with the live Workers AI list: fixed two dead model IDs, added SEA-LION chat and Deepgram Nova-3 STT. (This is the catalog/STT work originally slated for 0.96.0; it was lost from git in a concurrent-session collision and is re-landed here. The 0.96.0-0.98.0 span was consumed by the parallel rembg Container work.)

### What ships

- **Fixed dead IDs** (verified absent from the live `wrangler ai models` catalog; old paths 404):
  - `@cf/myshell/melotts` -> `@cf/myshell-ai/melotts` (TTS)
  - `@cf/deepseek/deepseek-r1-distill-qwen-32b` -> `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` (chat)
- **Added chat**: `@cf/aisingapore/gemma-sea-lion-v4-27b-it` (SEA-LION v4 27B, Southeast Asian languages). Rides the generic `aiRun` chat path.
- **Added STT**: `@cf/deepgram/nova-3`. The `runStt` Deepgram branch (already on main from v0.97.0) sends `{ audio: { body: <ReadableStream>, contentType } }` and reads the native Deepgram `results.channels[].alternatives[].transcript`; it bypasses AI Gateway (Gateway rejects ReadableStream inputs) so there's no `cf-aig-log-id`. Verified live by round-tripping Aura-2 TTS through nova-3.
- `@cf/deepgram/flux` is intentionally excluded: websocket-only (error 8006 over the request/response binding).

### Not yet added

SDXL (`@cf/stabilityai/stable-diffusion-xl-base-1.0`) and LLaVA 1.5 (`@cf/llava-hf/llava-1.5-7b-hf`) are requested but pending live contract verification (SDXL output shape vs FLUX; LLaVA's image-to-text input contract).

## v0.98.0

Rolled back the v0.97.0 cast-portrait container integration. The bg-removal step moves pod-side to `vivijure-serverless 0.4.56`; portrait uploads pass through to R2 raw again.

### Why

The Cloudflare Container the v0.97.0 commit wired up never reached an active state. Container instances list as healthy on the dashboard but the runtime never promotes them, and the same behavior reproduces with a stdlib hello-world image on the same account, so the issue is broader than the rembg build. Container-side logs surfaced one signal (`/dev/shm` missing for numba's multiprocessing semaphores) but the hello-world test shows there is more going on; root-causing further needs CF support. In the meantime every portrait upload through v0.97.0 was returning 502, which had to stop.

### What ships

- `src/index.ts` `handleCastPortraitUpload`, both branches: dropped the `cleanPortrait` calls and the cleaned-bytes path; portrait bytes now go straight to R2 under `cast/<id>/portrait.<ext>` with the source mime, same as pre-v0.97.0 behavior.
- The whole Container code surface stays in place so the path can be re-enabled when CF resolves the runtime issue: `containers/rembg/` (Dockerfile, requirements.txt, main.py), `src/containers/rembg.ts` (DO wrapper + `cleanPortrait` helper), and the `[[durable_objects.bindings]]` + `[[containers]]` blocks in `wrangler.example.toml`. The container builds and runs correctly locally; only the CF runtime is blocked.
- `package.json`: 0.97.0 to 0.98.0.

### Where the cleaning happens now

`vivijure-serverless 0.4.56` adds rembg + composite-on-black to `multi_character_regional.py:_slot_portraits`. The IP-Adapter at the regional render path sees a clean subject-on-black plate regardless of what the user uploaded; the saved portrait stays as the raw upload. Same end-user behavior, different deploy target.

## v0.97.0

New Cloudflare Container running rembg + u2net for the cast portrait flow. Wires the cast portrait endpoints to strip backdrops and composite the subject onto solid black before writing to R2, so the vivijure-serverless regional render path's IP-Adapter sees a clean conditioning input.

### Why

Smokes v22 through v26 on the regional render path confirmed that the IP-Adapter at scale 0.7 projects the portrait backdrop straight into the rendered keyframe: a studio-gray portrait leaks gray into every shot, an environmental portrait causes the two regional masks to merge into one fused figure (CLIP encoder confused by busy bg overlapping subject), and only a subject-on-pure-black plate gives the right behavior (two distinct figures + scene-driven backdrop). The manual workflow used in v26 (run rembg locally, upload the result) does not generalize to users uploading raw photos, so the cleaning needs to happen automatically at portrait write time.

### What ships

- `containers/rembg/`: new container project. Dockerfile pinned to `python:3.12-slim`, requirements pinned to versions validated against smoke v26 (`rembg==2.0.75`, `onnxruntime==1.26.0`, FastAPI + uvicorn). `u2net.onnx` baked into the image at build time so cold-starts do not include the 176 MB GitHub-releases download. One endpoint: `POST /clean` accepts image bytes, returns PNG bytes of the subject on solid black.
- `src/containers/rembg.ts`: `RembgContainer` Durable Object wrapper extending `Container` from `@cloudflare/containers`; `defaultPort = 8080`, `sleepAfter = "5m"`. `cleanPortrait(env, bytes)` helper hides the DO stub plumbing from the handlers and throws on non-2xx.
- `wrangler.example.toml`: new `[[durable_objects.bindings]]` for `REMBG_CONTAINER`, `[[containers]]` block pointing at the Dockerfile, and `[[migrations]]` block registering the DO class.
- `src/env.ts`: `REMBG_CONTAINER: DurableObjectNamespace` binding.
- `src/index.ts`: `RembgContainer` re-exported from the worker entry (Cloudflare runtime needs the class importable from the entry to bind it). `handleCastPortraitUpload` both branches (binary upload + JSON `{from_chat_artifact}`) pipe bytes through `cleanPortrait` before the R2 write; cleaned output is always PNG so the portrait_key carries `.png` regardless of source format. `handleCastSourceAdd` is intentionally not wired — sources are FLUX 2 multi-reference inputs for the cast portrait + training-set generators (v0.90.0 / v0.91.0), never fed to the regional render path's IP-Adapter.
- `package.json`: 0.96.0 to 0.97.0; `@cloudflare/containers` dependency added.

### Note

The CF Container path turned out to be blocked at runtime (see v0.98.0); this entry documents the design and the code surface that ships with the worker, but the integration is disabled by the v0.98.0 rollback.

## v0.95.0

Removed Amazon Bedrock entirely (Nova family + TwelveLabs Pegasus) and the `aws4fetch` dependency it pulled in.

### Why

Bedrock was the only provider requiring a second cloud's credentials (AWS IAM + SigV4), which runs against the consolidation onto Cloudflare Unified Billing. The four Nova chat models were redundant with stronger models already in the catalog (and their advertised vision was never wired), and Pegasus 1.2 was implemented as a coding exercise with no real use case. Dropping all of it sheds the lone AWS-BYOK setup burden, a runtime dependency, and a chunk of dedicated dispatch/parser code.

### What ships

- Deleted `src/providers/bedrock.ts`, `src/parsers/bedrock-eventstream.ts`, and `tests/bedrock-eventstream.test.ts`.
- `src/models.ts`: removed the 5 Bedrock catalog rows and the `"bedrock"` provider from the union.
- `src/index.ts`: removed the Bedrock import and the sync + streaming dispatch branches; simplified the streaming-provider gate.
- `src/env.ts`: removed `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_REGION_PEGASUS`.
- `src/output-extract.ts`: removed the Bedrock Converse / Pegasus InvokeModel response-shape branches and the Bedrock camelCase usage keys (plus their tests).
- `package.json`: dropped the `aws4fetch` dependency; description now reads 33 models across 5 providers.
- Docs: removed the Bedrock section from `README.md` and all Bedrock references across `README.md`, `CONTRIBUTING.md`, and `wrangler.example.toml`.

Also folded in stale-doc cleanup from v0.93.0: the README "Anthropic models" section now documents Unified Billing (keyless `cf-aig-authorization`) instead of the removed BYOK key.

### Note

The `video_full` attachment path is retained but dormant; Pegasus was its only consumer. No chat model currently reads raw video (vision models use the 8-keyframe path).

## v0.94.0

Storyboard-planner picker synced with the frontier hosted flagships and pruned of a model that does not belong.

### Why

The planner catalog had drifted from the main MODELS list: Claude Opus 4.8 (the newest flagship) was missing, and Grok Build 0.1, a coding-tuned model, had no business in a narrative storyboard picker. With every paid provider now on Cloudflare Unified Billing, the OpenAI and Google frontier models are also first-class planner options.

### What ships

- `src/planner-catalog.ts`: added `anthropic/claude-opus-4-8`, `openai/gpt-5.5`, and `google/gemini-3.1-pro`; removed `xai/grok-build-0.1`. Added `google` to `PlanningProvider` and `plannerProviderFor`.
- `src/planner.ts`: added a `google` dispatch branch (both plan + refine sites) that calls `callGemini` with the system prompt hoisted to `systemInstruction`. OpenAI rides the existing `aiRun` else-branch with a plain `{messages}` body, same as the main chat path. Bedrock chat models remain intentionally excluded (no SigV4 dispatch in the planner).
- `tests/planner-catalog.test.ts`: pinned the three new entries, pinned Grok Build and all Bedrock rows as excluded, and added `plannerProviderFor` cases for the google and openai paths.

### Output discipline

No API-level JSON mode is used; the guardrail is the existing strip-fences -> `JSON.parse` -> `validateStoryboard` chain, which rejects any off-schema output as a failed plan rather than passing it to the renderer. The curated frontier choices maximize first-pass schema compliance; reasoning, coding, and sub-10B models stay out because they degrade it.

## v0.93.0

Anthropic chat moves from BYOK to Cloudflare Unified Billing. Requests now bill through Cloudflare instead of a personal Anthropic key.

### Why

The goal is to route every paid provider through Cloudflare Unified Billing so cost rolls up to one bill, and the Anthropic API credits backing the old BYOK key were exhausted. Cloudflare's AI Gateway supports Anthropic under Unified Billing (keyless: `cf-aig-authorization` header, no provider key), so the switch is an auth change, not a new dispatch path; the existing Messages-API transform, streaming, and SSE parsing are unchanged.

### What ships

- `src/providers/anthropic.ts`: `prepareAnthropicRequest` no longer sends `x-api-key`. It now requires `CF_AIG_TOKEN` and sends `cf-aig-authorization: Bearer <token>` only (a provider key would flip the gateway back to BYOK/pass-through billing). Missing `CF_AIG_TOKEN` throws a clear error instead of silently failing auth.
- `src/env.ts`: removed the now-unused `ANTHROPIC_API_KEY` field; documented `CF_AIG_TOKEN` as required for Anthropic Unified Billing.
- Catalog/labels: dropped the "BYOK" suffix from the five Anthropic chat labels (`src/models.ts`) and updated provider comments (`src/planner.ts`, `src/planner-catalog.ts`, `src/index.ts`).
- `wrangler.example.toml`: removed `ANTHROPIC_API_KEY` from the secrets list; noted `CF_AIG_TOKEN` is now required for Anthropic.

### Deploy steps for existing deployers

1. Enable Unified Billing for Anthropic on your AI Gateway (dashboard > AI Gateway > your gateway), and confirm a payment method is on the Cloudflare account.
2. Ensure `CF_AIG_TOKEN` is set (`npx wrangler secret put CF_AIG_TOKEN`) with a Cloudflare API token that has AI Gateway Run authorization.
3. The old `ANTHROPIC_API_KEY` secret is no longer read and can be deleted (`npx wrangler secret delete ANTHROPIC_API_KEY`).

## v0.86.0

The planner UI now exposes and forwards every override block, and finalize forwards them too. Closes the last gaps so everything is Worker-configurable.

### Why

The TS payload layer (`src/runpod-submit.ts`) and routes (`src/index.ts`) already accepted `wan_negative_prompt`, adetailer `face_confidence` / `extra_steps`, the face_lock IP-Adapter + InstantID string fields, and the whole `prompt_templates_overrides` shape (added in v0.82.0), but the planner UI never built inputs for them, so they were unreachable. Separately, `finalizeRender` only ever forwarded `audioKey` + `castLoras`, so a finalize ran the Wan I2V + assembly with pod defaults for every advanced block even when the render-submit had set them. This pairs with the pod-side fix in vivijure-serverless 0.4.54, which made the readers honor these values via `core.effective_config`; with the pod now reading them, the Worker has to actually send them on both paths.

### What ships

New inputs (planner.html), each wired into its existing builder (planner.js):
- **wan_diffusion**: `#planner-wd-negative-prompt` textarea (`wan_negative_prompt`, trimmed, <= 1024 chars).
- **adetailer**: `#planner-ad-face-confidence` (0..1) and `#planner-ad-extra-steps` (int 0..16).
- **face_lock**: top-level `#planner-fl-ip-repo`, `#planner-fl-ip-subfolder`, `#planner-fl-ip-weight`; InstantID sub-block `#planner-fl-iid-base-model`, `#planner-fl-iid-cn-model`, `#planner-fl-iid-adapter-repo`, `#planner-fl-iid-adapter-weight`, `#planner-fl-iid-antelope-root` (all trimmed non-empty strings; `instantid` still only attached when non-empty).
- **prompt_templates** (had no UI): a new advanced disclosure with a single `#planner-pt-json` textarea. New `buildPromptTemplatesOverrides()` JSON-parses it inside try/catch; non-null non-array object wins, malformed JSON is dropped (route + pod re-validate structure).

DRY refactor: the entire render-submit override-block collection (plus the new `promptTemplates` line and the regional-engine injection) is extracted into a module-scope `collectOverrideBlocks()` returning a plain `{ xOverrides: ... }` object. The render path now does `Object.assign(reqBody, collectOverrideBlocks())` (behavior identical: same keys, same regional injection, now against the local object before the merge). `finalizeRender` does `Object.assign(finalizeBody, collectOverrideBlocks())` right after the castLoras block, so finalize forwards every advanced override. This single source of truth is what prevents the render/finalize drift that caused the gap.

### Code

- `public/planner.html`: added the wan_diffusion, adetailer, and face_lock inputs in their matching advanced disclosures; added the new "prompt templates (advanced, JSON)" disclosure.
- `public/planner.js`: extended `buildAdetailerOverrides`, `buildWanDiffusionOverrides`, `buildFaceLockOverrides`; added `buildPromptTemplatesOverrides` and `collectOverrideBlocks`; replaced the inline render-submit collection with `Object.assign(reqBody, collectOverrideBlocks())`; added `Object.assign(finalizeBody, collectOverrideBlocks())` in `finalizeRender`.
- `package.json`: 0.85.0 -> 0.86.0.

### Tests

496/496 passing, type-check clean. `node --check public/planner.js` is unaffected by this change (the pre-existing duplicate `finalizeRender` declaration is out of scope; the new code parses clean once that collision is isolated).

## v0.83.0

Worker-side fix for the v16-v18 multi-character regression. v15 produced a clean two-subject keyframe (Aria left, Marcus right, distinct identities, no seam); v16-v18 all regressed into a single merged figure regardless of payload tuning, including v18 which used the v15-baseline payload + zero overrides. Bisect surfaced vivijure-serverless 0.4.46 wired `prompt_engine.negative_for_style` into the regional path's `negative_prompt`, and the config.yaml default `image_prompting.negative_extra` contains `"duplicate person, multiple people, multiple heads, character sheet, reference sheet, multiple views, split image, panels, collage"` - SDXL anti-multi-subject negatives on a path whose entire purpose is rendering multiple people in one frame.

### Why Worker, not pod

The immutable-image directive says rendering-behavior fixes ship via Worker payload, not pod code. Per `feedback-no-config-changes-on-image` memory. The two recent violations of this rule (0.4.47 default change, 0.4.50 attempt) are exactly the friction the memory now exists to prevent.

### What ships

`public/planner.js`: after assembling the render payload, when `multiCharacterOverrides.engine === "regional"`, inject `imagePromptingOverrides.negative_extra = ""` and `imagePromptingOverrides.anatomy_guard = false` (only when the user hasn't already typed something for those fields). On the wire this neutralizes the regional path's `negative_for_style` call to an effectively-empty negative, matching v15 behavior. The pod stays at 0.4.49; no rebuild needed.

User can type a custom `negative_extra` or set `anatomy_guard` explicitly in the image-prompting advanced block to override the injected default.

### Tests

473/473 still passing, type-check clean.

## v0.82.0

Phase 13 (the last major config pull). Wire types + normalizers for the prompt-template constants that vivijure-serverless 0.4.49 just made payload-routable, plus two small extensions on existing override blocks.

### What's new

- **`PromptTemplatesOverrides`** interface — 12 fields covering the prompt-engine and hand-fix constants:
  - Scalar strings (10): `anatomy_positive_base`, `anatomy_positive_human`, `anatomy_positive_anime`, `anatomy_negative_global`, `anatomy_negative_focused`, `anatomy_negative_portrait`, `anatomy_negative_anime`, `portrait_positive`, `hand_positive`, `hand_negative`. Each capped at 1024 chars to prevent runaway overrides bloating prompts past SDXL's CLIP-77 limit.
  - `framing_hints?: string[]` — up to 32 entries, each ≤128 chars. Replaces the pod's pinned 10-entry cycle.
  - `act_mood?: Record<string, string>` — keyed by act name, values ≤256 chars. Merges over the pod-side defaults.
- **`AdetailerOverrides`** extended: `face_confidence` (0..1) and `extra_steps` (0..16). Closes the gaps the comprehensive code audit identified.
- **`WanDiffusionOverrides`** extended: `wan_negative_prompt` (≤1024 chars). Replaces the pod-pinned `WAN_DEFAULT_NEGATIVE` per render; the pod was already reading `wan_negative_prompt` off the config block but the key wasn't in the override schema, so it was unreachable from the payload.

### Wiring

`normalizePromptTemplatesOverrides` validates scalars + the two structural fields; drop-on-invalid (pod re-validates). `buildSubmitPayload` and `buildFinalizePayload` forward the new field. `handleRenderSubmit` and the finalize handler accept it from the request body and forward through.

### Tests

473/473 still passing, type-check clean.

### What now stays in the image

After Phase 13, the only hardcoded values left in the docker image are genuine algorithm internals (grabcut bounding-box rectangles, mask blur radii, retry counts), deployment constants (volume paths, VRAM estimates for the pipeline registry), and redundant-with-already-exposed preset structures (`quality_tiers.*` presets that overlap with the `wan_diffusion` overrides). The image is structurally immutable for production iteration.

## v0.81.0

Phase R regional knobs land in the planner UI with v15-confirmed defaults pre-filled. Companion to vivijure-serverless 0.4.48 which reverted a misguided pod-side default change (0.4.47 had bumped the lora_scale_per_slot default from 0.55 to 0.3 in pod code; that violates the immutable-image directive that the whole 12-phase config pull served). Production defaults belong on the Worker, not in the pod.

### What's new in the UI

Three fields added to the "multi-character composite (advanced)" disclosure:

- **engine** select — `regional` (default, single-pass with per-region IP-Adapter masks) or `composite_legacy` (the pre-Phase-R panel + grabcut + tile escape hatch)
- **regional LoRA scale per slot** — pre-filled at `0.3` (v15 win)
- **regional IP-Adapter scale per slot** — pre-filled at `0.7` (v15 win)

These are **values, not placeholders**. The field carries the value to the wire payload unless the user explicitly clears it. The default behavior shifts from "send nothing, let the pod use its compiled default" to "send v15's known-good values, override per render if desired". The docker image stays immutable; the production defaults are right here in the Worker.

### Why pre-fill instead of placeholder

The pod's compiled default for `lora_scale_per_slot` is still 0.55 (the original config-file value). v15 smoke confirmed 0.3 is the production-quality value for multi-character keyframes. If we want "0.3 in production" without rebuilding the pod, the Worker has to fill it. The user can clear the field to fall back to the pod default for that key — same as every other override.

### Tests

473/473 still passing, type-check clean.

## v0.80.0

LLM Assist content guards. The structural validator in `src/storyboard-validate.ts` historically only checked JSON shape (required fields, slot IDs, types). The four content-shape constraints the GPU renderer depends on are now enforced too, closing the gaps an LLM Assist (`POST /api/storyboard/plan`, `POST /api/storyboard/refine`) output could slip through.

### What now fails validation

- **Scene prompt over 50 words.** SDXL's CLIP-L and OpenCLIP-G each cap at 77 tokens; the pod's regional path prepends ~15 tokens of triggers + style_prefix, leaving ~60 tokens of scene-prompt budget at ~1.3 tokens/word. 50 words is a small safety margin. Error names the offending scene and word count so the user (or the re-prompt loop) knows where to tighten.
- **Scene count over 50.** Preflight warns at 24; this is the firm ceiling. Catches an LLM Assist trying to produce a 100-shot epic on a draft pass.
- **`full_prompt` over 1024 chars.** Cap on the top-level synopsis field that the pod reads at manifest-build time.
- **`style_prefix` over 256 chars.** The pod's 0.4.38 `background_prompt()` builds the bg backplate verbatim from `style_prefix`; a 2000-char LLM Assist style_prefix would itself overflow CLIP 77 before any scene-prompt tokens are added.

### What now silently coerces

- **Scene IDs always normalize to `shot_NN`.** LLM Assist outputs like `"scene_dramatic_sunset"` or `""` get renumbered in declaration order; a valid `"shot_07"` is preserved. The renderer looks up scenes by id, and downstream tools assume `shot_NN`; coercion (rather than rejection) means the LLM doesn't have to know the format.

### Defense in depth

The bundle assembler still re-validates defensively at bundle time, so these guards run twice (LLM Assist response path + bundle path). On the pod side, vivijure-serverless 0.4.44 ships an appositive-strip on the regional prompt as a third line of defense.

### Tests

464 → 473 (9 new guard tests covering all 4 caps + the coercion behavior). Type-check clean.

## v0.79.0

Phase 12 of the worker-pod config pull. Four more config.yaml regions become routable from the web Worker: `loras.training` extras (4 keys the v0.68.0 LoraTrainOverrides didn't cover: `enabled`, `min_images`, `max_images`, `trigger_template`), `loras.default_scale` (1 key), `quality.*` ffmpeg encoding knobs (`assemble_crf`, `assemble_preset`), and `image_models.default_profile`. Pod side landed in vivijure-serverless 0.4.37.

### Backend

- `src/runpod-submit.ts`: `LoraTrainExtras`, `LorasOverrides`, `QualityOverrides`, `ImageModelsOverrides` interfaces + matching normalizers. `QualityOverrides.assemble_preset` validates against the 9 known ffmpeg presets. All Args + JobInput types carry the new fields; all builders forward them.
- `src/index.ts`: `RenderSubmitRequest` accepts the four new fields; both render and finalize handlers read them and forward through.

### Frontend

- `public/planner.html`: new "LoRA training extras + encoding + image profile (advanced)" disclosure with all 8 controls.
- `public/planner.js`: four new builders read + validate, attached alongside the other override builders.

### Tests

464/464 still passing, type-check clean.

## v0.78.0

Phase 11 of the worker-pod config pull. Three more config.yaml regions become routable from the web Worker: the `character_bible.*` block (3 keys; the auto-condensed cast bible prepended to every shot), `production.*` top-level sub-keys (6 keys; hand-fix / adetailer master switches + character-ref count gates + LoRA training threshold), and five top-level switches (`production_mode`, `always_use_style_reference`, `assemble_use_crossfade`, `auto_render_clips`, `auto_bootstrap_start_image`). Pod side landed in vivijure-serverless 0.4.35, which ALSO fixes the Phase 10 reach gap: `movie_mode`, `character_bible`, `production_gates`, and `hand_fix` all re-read `config.yaml` from disk per call, so Phase 10's `max_scenes` / movie-block overrides never propagated to them. 0.4.35 makes those modules delegate to `core.CONFIG`, fixing Phase 10 retroactively.

### Backend

- `src/runpod-submit.ts`: `CharacterBibleOverrides`, `ProductionOverrides`, `TopLevelSwitches` interfaces + matching normalizers. All three Args + JobInput types carry the new fields; all builders forward them.
- `src/index.ts`: `RenderSubmitRequest` accepts the three new fields; both render and finalize handlers read them and forward through.

### Frontend

- `public/planner.html`: new "cast bible + production gates + top-level switches (advanced)" disclosure with all 14 controls.
- `public/planner.js`: `buildCharacterBibleOverrides()` + `buildProductionOverrides()` + `buildTopLevelSwitches()` read + validate, attached alongside the other override builders.

### Tests

464/464 still passing, type-check clean.

## v0.77.0

Phase 10 of the worker-pod config pull. Two more config.yaml regions become routable from the web Worker: five top-level scene-length scalars (`target_scene_seconds`, `min_scene_seconds`, `max_scene_seconds`, `max_video_seconds`, `max_scenes`) and the `movie.*` block (10 keys; the movie-mode chain + per-clip Wan defaults). Pod side landed in vivijure-serverless 0.4.34.

### Backend

- `src/runpod-submit.ts`: `SceneLengthOverrides` + `MovieOverrides` interfaces + `normalizeSceneLengthOverrides` / `normalizeMovieOverrides` with per-field union / range / length-cap validation. Both Args + JobInput types carry the new fields; all builders forward them.
- `src/index.ts`: `RenderSubmitRequest` accepts `sceneLengthOverrides` + `movieOverrides`; both render and finalize handlers read them and forward through.

### Frontend

- `public/planner.html`: new "scene length + movie (advanced)" disclosure with all 15 controls.
- `public/planner.js`: `buildSceneLengthOverrides()` + `buildMovieOverrides()` read + validate, attached alongside the other override builders.

### Tests

464/464 still passing, type-check clean.

## v0.76.0

Phase 9 of the worker-pod config pull. The `local_diffusion.*` block (12 keys; SDXL base + keyframe-SDXL knobs) and the `generation.*` block (3 keys; seed handling) become routable from the web Worker. Pod side landed in vivijure-serverless 0.4.32, which also fixes the v0.4.31 parse-block gap (the `adetailer_overrides` + `wan_diffusion_overrides` kwargs were referencing variables that were never parsed off the input — a NameError at runtime any time those overrides reached the handler).

### Backend

- `src/runpod-submit.ts`: `LocalDiffusionOverrides` + `GenerationOverrides` interfaces + `normalizeLocalDiffusionOverrides` / `normalizeGenerationOverrides` with per-field union / range / length-cap validation and "WIDTHxHEIGHT" resolution-string check. Both Args + JobInput types carry the new fields; all three builders forward them.
- `src/index.ts`: `RenderSubmitRequest` accepts `localDiffusionOverrides` + `generationOverrides`; both render and finalize handlers read them and forward through.

### Frontend

- `public/planner.html`: new "SDXL base + keyframe + seeds (advanced)" disclosure with all 15 controls.
- `public/planner.js`: `buildLocalDiffusionOverrides()` + `buildGenerationOverrides()` read + validate, attached alongside the other override builders.

### Tests

464/464 still passing, type-check clean.

## v0.75.0

Phase 8 of the worker-pod config pull. Two more config.yaml blocks become routable from the web Worker: `production.adetailer.*` (7 keys; the hand/face inpaint refinement pass) and `wan_diffusion.*` (11 keys; the Wan I2V / T2V model + inference knobs). Pod side landed in vivijure-serverless 0.4.31.

### Backend

- `src/runpod-submit.ts`: `AdetailerOverrides` and `WanDiffusionOverrides` interfaces + `normalizeAdetailerOverrides` / `normalizeWanDiffusionOverrides` with per-field union / range / length-cap validation. Both Args + JobInput types carry the new fields; all three builders forward them.
- `src/index.ts`: `RenderSubmitRequest` accepts `adetailerOverrides` and `wanDiffusionOverrides`; both render and finalize handlers read them and forward through.

### Frontend

- `public/planner.html`: two new disclosures, "adetailer hand/face fix (advanced)" (7 controls) and "Wan diffusion model + inference (advanced)" (11 controls). The wan_diffusion block is distinct from the flat `wan_inference_steps` / `wan_num_frames` `render_overrides` keys above it; the flat keys still win on key conflict since they apply after the quality tier's per-shot adjustment.
- `public/planner.js`: `buildAdetailerOverrides()` and `buildWanDiffusionOverrides()` read + validate, attach alongside the other override builders.

### Tests

464/464 still passing, type-check clean.

## v0.74.0

Phase 7 of the worker-pod config pull. `face_lock.*` (5 top-level keys) plus the nested `face_lock.instantid.*` (8 keys) become routable from the web Worker. Pod side landed in vivijure-serverless 0.4.30. Useful for tuning the IP-Adapter / InstantID identity-lock pipeline when per-cast LoRAs aren't dominant enough on their own.

### Backend

- `src/runpod-submit.ts`: `FaceLockOverrides` interface with optional nested `instantid` sub-block; `normalizeFaceLockOverrides` deep-validates both levels (unions for mode, 0..2 ranges for the scales, length caps on the model-id strings). Both Args + JobInput types carry the field; both builders forward it.
- `src/index.ts`: `RenderSubmitRequest` accepts `faceLockOverrides`; both render and finalize handlers read it and forward through.

### Frontend

- `public/planner.html`: new "face lock + InstantID (advanced)" disclosure with five controls (face_lock_mode, ip_adapter_scale, instantid.enabled, instantid.controlnet_scale, instantid.ip_adapter_scale). The five-of-thirteen surface area covers the iteration-worthy knobs; the model-id / weight-file strings stay raw-JSON only since they're install-time defaults.
- `public/planner.js`: `buildFaceLockOverrides()` reads + validates, attaches alongside other override builders. The instantid sub-block is only included when at least one of its three fields is set.

### Tests

464/464 still passing, type-check clean.

## v0.73.0

Phase 6 of the worker-pod config pull. Three more config.yaml blocks become routable from the web Worker: `continuity.*` (8 keys), `image_prompting.*` (4 keys), `character_generation.*` (2 keys). Pod side landed in vivijure-serverless 0.4.29.

### Backend

- `src/runpod-submit.ts`: `ContinuityOverrides`, `ImagePromptingOverrides`, `CharacterGenerationOverrides` interfaces + three normalizers. Per-field validation (booleans strict, numeric ranges, suffix-string length caps). All three Args + JobInput types carry the fields; both builders forward them.
- `src/index.ts`: `RenderSubmitRequest` accepts the three new fields; both render and finalize handlers read them and forward through.

### Frontend

- `public/planner.html`: new "continuity + prompting (advanced)" disclosure with ten controls (continuity enabled, use_last_frame, max_anchor_frames, chain_denoising; anatomy_guard, negative_mode, positive_extra, negative_extra; portrait reference_denoising, reference_prompt_suffix).
- `public/planner.js`: `buildContinuityOverrides`, `buildImagePromptingOverrides`, `buildCharacterGenerationOverrides` read + validate, attach to the submit body alongside the other override builders.

### Tests

464/464 still passing, type-check clean.

## v0.72.0

Phase 5 of the worker-pod config pull. `consistency.*` (8 keys) and `video_consistency.*` (5 keys) become routable from the web Worker via two new optional submit-body fields. Pod side landed in vivijure-serverless 0.4.28.

### Backend

- `src/runpod-submit.ts`: new `ConsistencyOverrides` + `VideoConsistencyOverrides` interfaces, `normalizeConsistencyOverrides` + `normalizeVideoConsistencyOverrides` validators. Per-key unions + ranges; both builders + Args types + JobInputs carry the fields.
- `src/index.ts`: `RenderSubmitRequest` accepts both; `handleRenderSubmit` and `handleFinalizeSubmit` read them and forward through.

### Frontend

- `public/planner.html`: new "consistency + chaining (advanced)" disclosure with eight controls (strict mode default, chain denoising, keyframe suffix, motion suffix, chain scenes, regenerate keyframe each shot, movie-mode motion suffix, IP-Adapter scale). Other keys that overlap with existing first-class controls (identity_lock, seed_mode, face_lock_mode, quality_tier) stay accessible via the raw-JSON textarea to avoid double-UI.
- `public/planner.js`: `buildConsistencyOverrides()` + `buildVideoConsistencyOverrides()` read + validate, attach to the submit body alongside the other override builders.

### Tests

464/464 still passing, type-check clean.

## v0.71.0

Phase 4 of the worker-pod config pull. Five render-output and Wan-inference knobs become first-class fields in the planner's advanced render block instead of hiding behind the raw-JSON textarea. Pod side landed in vivijure-serverless 0.4.27 (which made the previously-hardcoded `KEYFRAME_SDXL_SIZE` and friends payload-routable).

### Frontend

- `public/planner.html`: new "render output + Wan (advanced)" disclosure with eight controls (`keyframe_sdxl_size`, `output_width`, `output_height`, `fps`, `crossfade_seconds`, `wan_num_frames`, `wan_inference_steps`, `wan_guidance_scale`). Each shows the pod default in its placeholder so empty == "use default" is obvious.
- `public/planner.js`: `buildRenderOverrides` extended with the eight new fields. Each validates (positive int / positive float in a sensible UI range) and goes onto the wire as a flat `render_overrides.<key>` entry. The pod's existing render_overrides → CONFIG / KEYFRAME_SDXL_SIZE install (0.4.27) picks them up transparently.

### Wire shape

These are already routable as raw JSON. v0.71.0 promotes them to first-class for discoverability + validation:

  `keyframe_sdxl_size`  → "WxH" string (e.g. "1216x832")
  `output_width`        → integer 64..7680
  `output_height`       → integer 64..7680
  `fps`                 → integer 1..120
  `crossfade_seconds`   → float 0..5
  `wan_num_frames`      → integer 1..256
  `wan_inference_steps` → integer 1..64
  `wan_guidance_scale`  → float 0..30

464/464 still passing, type-check clean.

## v0.70.0

Phase 3 of the worker-pod config pull (Phase 1: LoRA training, Phase 2: multi_character). The `loras.quality_gate` block from the pod's `config.yaml` becomes routable from the web Worker via a new `qualityGateOverrides` field on render + finalize + train-lora submit bodies. Pod side landed in vivijure-serverless 0.4.25.

### Backend

- `src/runpod-submit.ts`: new `QualityGateOverrides` interface + `normalizeQualityGateOverrides` validator. Per-key validation: `enabled` / `allow_warn` strict booleans; `probe_count` 1..16; `min_ssim` / `pass_ssim` 0..1; `probe_lora_scale` 0..2; `min_file_bytes` / `base_seed` non-negative integers; `default_trigger` 1..64 chars. `RenderJobInput`, `FinalizeJobInput`, `TrainLoraJobInput`, all three Args types carry the field; all three builders forward it through.
- `src/index.ts`: `RenderSubmitRequest` accepts `qualityGateOverrides`; `handleRenderSubmit`, `handleFinalizeSubmit`, `handleCastTrainLora` all read it and forward through.

### Frontend

- `public/planner.html`: new "LoRA quality gate (advanced)" disclosure with seven controls (enabled, probe_count, min_ssim, pass_ssim, probe_lora_scale, base_seed, allow_warn). Each shows the pod default in placeholder.
- `public/planner.js`: `buildQualityGateOverrides()` reads + validates, attaches alongside the other override builders.

### Tests

464/464 still passing, type-check clean.

## v0.69.0

Phase 2 of the worker-pod config pull (Phase 1 was LoRA training in v0.68.0 / vivijure-serverless 0.4.19). The `production.multi_character` block from the pod's `config.yaml` becomes routable from the web Worker via a new `multiCharacterOverrides` field on render + finalize submit bodies. Pod side landed in vivijure-serverless 0.4.23.

### Backend

- `src/runpod-submit.ts`: new `MultiCharacterOverrides` interface + `normalizeMultiCharacterOverrides` validator. Per-key validation: `mode` must be one of `"auto"|"always"|"off"`; `layout` must be `"layer"|"side_by_side"`; `max_slots` is 1..4 (integer); `feather_px` is 0..256 (rounded); `auto_when_multi_slot` is a strict boolean. Anything else is silently dropped client-side; the pod re-validates and 400s on a coercion error. `RenderJobInput`, `FinalizeJobInput`, `RenderSubmitArgs`, `FinalizeArgs` all carry the field; `buildSubmitPayload` and `buildFinalizePayload` forward it through.
- `src/index.ts`: `RenderSubmitRequest` accepts `multiCharacterOverrides`; `handleRenderSubmit` and `handleFinalizeSubmit` read it off the body and forward through to the submit args.

### Frontend

- `public/planner.html`: new "multi-character composite (advanced)" disclosure inside the existing advanced render-settings block, with five controls: mode (select), layout (select), max slots (number), feather px (number), auto when multi-slot (select). Each shows the pod default in its placeholder so an empty / "(use pod default)" entry is obviously a fallback.
- `public/planner.js`: `buildMultiCharacterOverrides()` reads the five inputs, coerces / validates, returns undefined when nothing is set. Attached to the submit body alongside `loraTrainOverrides`, `castLoras`, and `audioKey`.

### Tests

464/464 still passing, type-check clean.

## v0.68.0

Phase 1 of the worker-pod config pull. LoRA training hyperparams (steps, learning_rate, rank, resolution, timeout_seconds) become routable from the web Worker to the GPU pod via a new `lora_train_overrides` wire field. Pod side landed in vivijure-serverless 0.4.19. Web-Worker side this version: types, builders, route handlers, and a small UI block in the planner's advanced render-settings.

**Also includes a critical hot-fix:** `buildSubmitPayload` was missing the `pretrained_loras` pass-through that `buildFinalizePayload` already had. The `castLoras` -> resolver -> args path populated the response envelope (`pretrainedSlots`) but the wire body never carried the actual `{slot: r2_key}` map, so the GPU's `_stage_pretrained_loras` short-circuit never fired and Stage 1 re-trained every time. Found while plumbing the new override field through.

### Backend

- `src/runpod-submit.ts`: new `LoraTrainOverrides` interface, optional `loraTrainOverrides` on `RenderSubmitArgs` / `FinalizeArgs` / `TrainLoraArgs`. `normalizeLoraTrainOverrides` drops non-positive / non-finite values clientside before they hit the wire. Builders (`buildSubmitPayload`, `buildFinalizePayload`, `buildTrainLoraPayload`) all forward the normalized map; `buildSubmitPayload` also picks up the missing `pretrained_loras` pass-through.
- `src/index.ts`: `RenderSubmitRequest` accepts `loraTrainOverrides`; `handleRenderSubmit`, `handleFinalizeSubmit`, `handleCastTrainLora` all read it out of the request body and forward through to the submit args. Bad shape (non-object, array) silently drops to undefined - the builder normalizer is the second line of defense.

### Frontend

- `public/planner.html`: new "LoRA training (advanced)" disclosure inside the existing render-settings advanced block, with four number inputs: steps / learning_rate / rank / resolution. Each shows the pod default in its placeholder so an empty field is obviously "use the default".
- `public/planner.js`: `buildLoraTrainOverrides()` reads the four inputs, coerces to positive finite numbers, returns undefined when nothing is set. Attached to the submit body alongside `castLoras` and `audioKey`.

### Tests

464/464 still passing, type-check clean. UI is behavior-tested manually in browser (no vitest for planner.js form reads yet, matching existing convention).

## v0.67.1

Hot-fix for v0.66.0's shared topbar: on the cast page the Vivijure logo rendered at the BOTTOM of the page instead of the top. Root cause: `.cast-layout` is a CSS Grid with an explicit `grid-template-areas: "header header" / "list editor"`, and the `<header class="wv-topbar">` had no `grid-area` assigned so it auto-placed into the implicit row below the named rows.

Fix: pull the topbar OUT of `<main>` and make it a body-level sibling. Sticky `top: 0` still pins it to the top of the viewport. Done on both cast.html and planner.html for consistency; on planner this also frees the topbar from the 960px `.planner-layout` max-width so the blur background spans the full viewport.

464/464 still passing.

## v0.67.0

Planner page layout cleanup. Recent renders moved to the bottom of the page so the live workflow (project -> plan -> ... -> render) sits at the top and history is a reference area below it, not the first thing the user scrolls past on every load. Stage-title numbering ("1. plan", "1a. refine via chat", "2. assemble bundle", "3. render", etc.) dropped - the visual order on the page already conveys the sequence and the numbering looked dated next to the new topbar chrome.

### Frontend

- `public/planner.html`: reordered. Old: history, project, plan, refine, scenes, audio, preflight, bundle, render. New: project, plan, refine, scenes, audio, preflight, bundle, render, history. No JS changes - the section IDs are unchanged, so planner.js's selectors keep working.
- Stage titles renamed: `1. plan -> plan`, `1a. refine via chat -> refine via chat`, `1b. scene editor -> scene editor`, `1c. audio bed + beat timing -> audio bed + beat timing`, `1d. preflight -> preflight`, `2. assemble bundle -> assemble bundle`, `3. render -> render`.

464/464 still passing.

## v0.66.0

Shared Vivijure topbar across the planner and cast pages. Brings the legacy `Wave` + `vryn` wordmark forward (the styled-text logo from the legacy FastAPI app's `vivijure-runpod/static/index.html`, gradient + cyan glow preserved) and gives every page a single header chrome with logo, page nav, and signed-in user pill. The pill is wrapped in a `<button>` so future User Options (preferences, sign-out, theme) can hang off it without revisiting markup.

### Backend

- `src/index.ts`: new `GET /api/whoami` returning `{user: getUserEmail(request)}`. Tiny route so the topbar can populate without pulling /api/models' full 38-model payload or /api/cast's full list just to read the user email.

### Frontend

- `public/styles.css`: new `.wv-topbar` block at the bottom (sticky, blurred background, grid-of-3 layout) plus matching `.wv-topbar-logo` with the Wave (gradient) + vryn (white + cyan glow) wordmark from the legacy CSS, ported byte-for-byte on the gradient and glow values.
- `public/topbar.js` (new, framework-free, ~25 lines): fetches /api/whoami once per page load and writes the email into `#wv-topbar-user-email`. Fails open: a transport error leaves the pill in `(offline)` state but the page still works because Cloudflare Access already gated the request before this code ran.
- `public/planner.html` + `public/cast.html`: drop the bespoke page headers in favor of the shared `.wv-topbar`, with the relevant page nav-link marked `is-active`. Existing inner page headers (`#cast-list-pane` etc.) are unchanged.

464/464 still passing; topbar.js syntax-checks.

## v0.65.0

Training-set generator model picker. Pre-v0.65 the /cast training-image generator hardcoded `@cf/black-forest-labs/flux-2-dev` based on a stale comment claiming Dev was the only @cf multi-reference model in the catalog. Empirical test against `/api/chat` proved both FLUX 2 Klein variants (9B frontier + 4B faster) accept the attached portrait and identity-condition on it the same way Dev does, with a coherent likeness of the source character coming out. This cost us a fallback option during the smoke test when the FLUX 2 Dev gateway was returning 502s and the training set kept failing partway through. (nano-banana-pro and gpt-image-1.5 also accept the attachment but IGNORE it for identity, so they are NOT surfaced here even though /api/chat would happily return a generic young-person image from them.)

### Frontend

- `public/cast.html`: new `<select id="cast-training-model">` next to the training-set button. Hint updated to drop the stale "(FLUX 2 Dev)" parenthetical and bump the time estimate.
- `public/cast.js`: `TRAINING_MODEL_ID` hardcode replaced with a `TRAINING_MODELS` list (Klein-9b default, then Klein-4b, then Dev). `ensureTrainingModelOptions()` populates the dropdown lazily on disclosure toggle (same pattern as the existing portrait-gen model picker). `generateTrainingSet` reads the selected model via `getSelectedTrainingModelId()`; missing or unrecognized value falls back to the default.

### Why Klein-9b is the default

In the post-v0.60 smoke test, FLUX-2-Dev hit a string of 502s for ~30 minutes that left two cast members with 7/10 and 2/10 refs (need ≥8). Klein-9b completed cleanly during the same window. Side-by-side identity coherence on the same prompt was comparable. The user can flip back to Dev whenever Dev is healthy.

464/464 still passing; cast.js syntax-checks.

## v0.64.0

Diversify the LoRA training-image generator's prompt set. Surfaced during the post-v0.60 smoke test of cast-member rendering: the pre-v0.64 `TRAINING_PROMPTS` were 8/10 "portrait, ... clean background" with only minor expression / lighting tweaks, so the 10 generated images came back as near-duplicates. The GPU-side LoRA quality gate scored both smoke-test cast members at ~0 SSIM (well below the 0.28 threshold), and SDXL collapsed the two characters into one fused face on the multi-character keyframe because neither LoRA's identity was anchored strongly enough to override the prompt's "two people" pull.

### Why this matters

A LoRA learns to associate a trigger word with whatever varies AND whatever stays constant across the training set. If every training image is the same framing, lighting, and background, the LoRA learns "trigger -> clean-background head-and-shoulders portrait" instead of "trigger -> this person's identity in any setting." At inference time the trigger then carries the BACKGROUND distribution, which is useless when the render prompt wants two characters at a campfire.

### Frontend

- `public/cast.js` `TRAINING_PROMPTS`: replaces the 10 portrait-leaning templates with 10 spanning orthogonal axes - framing (close-up, medium, three-quarter, full-body, profile), camera angle (eye-level, low, high, slight tilt), lighting (studio neutral, golden hour, side window, dramatic side, harsh midday, warm interior), expression (neutral, slight smile, serious, contemplative), pose (standing, sitting, mid-action), background (clean grey, blurred outdoor, neutral indoor, plain wall, soft bokeh). The bible is still appended to each via the unchanged `composeTrainingPrompt` so character-specific clothing / features come through.

The /api/chat surface and FLUX-2-Dev model are unchanged; this is a pure prompt-set swap. Existing cast members with LoRAs trained against the old prompt set are NOT auto-retrained; the user can hit "regenerate training images" + "retrain" on /cast to get a stronger LoRA against the new set.

464/464 still passing; cast.js syntax-checks.

## v0.63.0

UX hot-fix: the render-result panel at the top of the planner sticks around after a render reaches a terminal state (COMPLETED / FAILED / CANCELLED / TIMED_OUT), and because the in-flight `jobId` is persisted to localStorage, it survives a page reload too. So a render that died days ago can still show "job 9f295c7b... status: FAILED" on top of the page after several successful renders have happened since. The history list below already shows all rows; the top panel duplicating a stale failed row is just visual noise.

### Frontend

- `public/planner.html`: new `#planner-render-dismiss` button next to "cancel job" in the render-result panel actions row. Hidden by default.
- `public/planner.js`: `setJobStatusBadge` shows the dismiss button only when the status is terminal (and the cancel button only when it is in-flight, mirroring the existing rule). `dismissRenderResult()` closes any open SSE stream / poll timer / tick timer, clears `renderState.jobId` + `currentProject` + `currentLabel` + `startedAt`, hides the result / log / output / error / progress sub-panels, and calls `savePersistedState()` so the next reload starts clean.

In-flight jobs are not dismissable - the user has to click "cancel job" first - so a click on dismiss can never accidentally orphan a running RunPod job.

464/464 still passing.

## v0.62.0

Second hot-fix surfaced during the end-to-end smoke test: MiniMax music-2.6 returns AI Gateway error 7003 ("User Input Error") when the `lyrics` field is empty or missing, even for instrumental requests. The planner's music-gen UI submits with no `system_prompt`, so every "generate music" click was failing seconds after submit.

### Backend

- `src/index.ts` `runMusic`: when the caller omits `system_prompt` (or sends an empty / whitespace-only string), default `lyrics` to `[Instrumental]` - MiniMax's own marker syntax for an instrumental track. A non-empty system_prompt (real lyrics) still wins, so users who want vocals can keep doing so.

No UI change needed: the existing music-gen button sends `{model, user_input}` only, and the Worker now fills in the lyrics default behind it. Future UI work could surface an explicit lyrics input, but the implicit default unblocks the common case immediately.

464/464 still passing.

## v0.61.0

Hot-fix surfaced during the v0.61.0-era end-to-end smoke test: the standalone LoRA training gate at `POST /api/cast/:id/train-lora` accepted cast members with as few as 4 reference images, but the GPU side (`orchestrator.py:39 MIN_TRAINING_IMAGES = 8`) rejects them with `train_loras returned {}` after the bundle is built and uploaded. Two test characters with 5 and 7 refs each FAILED in ~5 seconds with no .safetensors produced.

### Backend

- `src/index.ts`: bump the `cast.ref_keys.length < 4` gate in `handleCastTrainLora` to `< 8`, with an error message that names the GPU constant and points the user at the `/cast` training-set generator (which produces 10 refs in one click).

No GPU/serverless change. The /cast training-set UI already iterates 10 pose templates so users who go through the UI path comfortably clear the floor; the gate change only catches partial-set / manually-uploaded edge cases earlier.

464/464 still passing.

## v0.60.0

One-click retry on FAILED / CANCELLED / TIMED_OUT history rows. Eliminates the "render died at 18 minutes, do I have to start over" frustration: the new button re-POSTs with the failed row's stored args (project, bundle_key, quality_tier, render_overrides, mode) and the GPU side (vivijure-serverless) resumes incrementally off the persistent network volume.

### Why this is cheap

The serverless worker already does the right thing on a same-project resubmit:

- `lora_already_trained` (`orchestrator.py:61`) short-circuits Stage 1 for any slot whose `.safetensors` still lives on the volume.
- `_indices_skip_locked` (`studio_service.py:1192`) skips shots whose clips were already rendered.

So a retry on the same endpoint within the volume's retention window picks up almost exactly where the failure happened. No GPU/serverless change required.

### Backend

- `POST /api/storyboard/renders/:id/retry` (new): ownership-scoped 404 on miss, 400 on non-terminal-failure status (COMPLETED / IN_QUEUE / IN_PROGRESS), 400 on `mode='finalized'` (finalize rows already have a retry path via clicking finalize on their parent preview). Inserts a NEW history row so the failed row stays for the audit trail. Audio bed and cast LoRA bindings are NOT inherited (neither is persisted on the row); a user who needs to change those should use the regular render button.

### Frontend

- `public/planner.js`: `retryFailedRender(row, btnEl)` posts the retry, confirms first (the message names the resume-from-volume behavior explicitly so the user knows the cost characteristic), refreshes history on success. The row's `view` / `re-render` / `delete` actions are unchanged; `retry` slots in between `re-render` and `delete` only when the row is in a terminal-failure status and is not a finalize child.

### Tests

No new unit tests. The retry handler is a small composition of pieces with their own coverage (`getRenderByIdForUser`, `submitRenderJob`, `insertRender`); the end-to-end correctness is verified by submitting a deliberately-failing render in production and clicking retry. 464/464 passing, type-check clean.

## v0.59.0

Named render-override knobs migrated from the legacy FastAPI "Make" panel. The planner's "render settings" advanced block now exposes first-class controls for the four pipeline knobs the GPU side (vivijure-serverless / `studio_service.py:1080-1092`) already consumed via `render_overrides` but the Worker had no UI for: `seed_mode`, `multi_character_mode`, `identity_lock`, `face_lock_mode`. The freeform JSON textarea stays as the power-user escape hatch and still wins on key conflict.

### Cross-repo coordination

None. Every promoted key is already accepted by the GPU side; the bump is Worker + planner only. Pre-v0.59 callers (curl, scripts) that omit the new fields keep the v0.58 behavior verbatim.

### Frontend

- `public/planner.html`: 4 new `<select>` controls under "render settings (advanced, optional)" alongside seed / adetailer / lora-scale / consistency. Each defaults to "(use bundle default)" so unset == bundle/GPU default wins; explicit values land on the named `render_overrides.*` key.
  - **seed mode** → `seed_mode`: `locked` | `sequential` | `random`
  - **multi-character composite** → `multi_character_mode`: `auto` | `always` | `off`
  - **identity lock (keyframes)** → `identity_lock`: `true` | `false`
  - **face lock mode** → `face_lock_mode`: `img2img` | `ip_adapter` | `instantid` | `both`
- `public/planner.js`: `buildRenderOverrides({...})` extended with the four new branches (each gated by an exact-string match against the accepted value set; anything else, including empty string, is dropped). Both persistence paths updated: `gatherPersistedState` / `restorePersistedState` (in-flight render survives a page refresh) and `gatherProjectPrefs` / `applyProjectPrefs` (per-project dial-in settings).

### Tests

No new unit tests. `buildRenderOverrides` lives in `public/planner.js` and is exercised end-to-end at submit time; the existing pre-v0.59 fields had no tests either. 464/464 still passing, type-check clean.

## v0.58.0

Phase 3 of the standalone-LoRA work: render and finalize submits now carry the bindings for cast members whose LoRA was already trained via the `/cast` flow, and the GPU side (vivijure-serverless 0.4.14+) stages the existing `.safetensors` so Stage 1 short-circuits for those slots.

### Cross-repo coordination

Requires **vivijure-serverless 0.4.14** on the RunPod endpoint. The `_stage_pretrained_loras` helper there reads the `pretrained_loras` field on the job input, downloads each value from R2 into `loras/<project>/`, and writes a synthetic `characters/jobs/lora_train_<SLOT>.json` so the existing ready-slot guard treats the slot as already trained. Pre-0.4.14 workers ignore the unknown field and re-train normally (silent forward-compatibility).

### Backend

- `src/lora-resolver.ts` (new, pure): `resolveCastLoraBindings(bindings, loadedCast)` reshapes a caller-supplied `{slot: cast_id}` map into the wire-format `{slot: r2_key}` shape, dropping bindings whose loaded `CastMember` is missing, not owned, not `ready`, or lacks a `loras/`-prefixed `lora_key`. `uniqueCastIds(bindings)` extracts the unique ids the route needs to load.
- `src/runpod-submit.ts`: `RenderSubmitArgs.pretrainedLoras` + `RenderJobInput.pretrained_loras` + `FinalizeArgs.pretrainedLoras` + `FinalizeJobInput.pretrained_loras`, with non-empty maps wired through `buildSubmitPayload` and `buildFinalizePayload`.
- `src/index.ts`: `handleRenderSubmit` and `handleFinalizeSubmit` now accept an optional top-level `castLoras` object on the request body, resolve it server-side (ownership-scoped via `getCastById`), and pass the result through to the submitters. The response carries `castLoraSkipped` (per-slot drop reasons) and `pretrainedSlots` (the slots actually included on the wire).

### Frontend

- `public/planner.js`: `buildCastLoraSubmit()` filters `planState.castBindings` against the locally cached `castCatalog` (only `lora_status === "ready"` with a `loras/`-prefixed `lora_key` makes it onto the wire); the render-submit `reqBody` and the finalize body both include `castLoras` when the filter produces any entries. The Worker still re-validates server-side so a stale client cannot point at a not-ready row.

### Tests

14 new vitest tests in `tests/lora-resolver.test.ts` covering the empty-input path, slot normalization (case + invalid characters), invalid cast ids, the four skip reasons (`not_found`, `not_ready`, `no_lora_key`, plus the validation reasons), mixed ready/non-ready bindings, and the two-slots-same-id case.

464/464 passing, type-check clean.

## v0.57.0

Standalone LoRA training for cast members. The user can now kick off a LoRA training run from `/cast` without going through a full render; the trained `.safetensors` is uploaded to R2 and the cast row tracks status across sessions. Future renders (Phase 3, a follow-up PR) will be able to skip Stage 1 by passing the pre-trained LoRA in the bundle.

### Cross-repo coordination

Needs **vivijure-serverless 0.4.13** on the RunPod endpoint (the new `train_lora` action). Pre-0.4.13 endpoints reject the action with "unknown action".

### Schema

- `cast_members.lora_key TEXT NULL` — R2 key of the trained `.safetensors`. Convention: `loras/cast-<id>/<timestamp>.safetensors`.
- `cast_members.lora_status TEXT NOT NULL DEFAULT 'idle'` — one of `idle | training | ready | failed`.
- `cast_members.lora_job_id TEXT NULL` — RunPod job id while training is in flight.
- `cast_members.lora_error TEXT NULL` — capped error string on failed runs.
- `cast_members.lora_trained_at TEXT NULL` — ISO timestamp when the row flipped to `ready`.
- Migration delta at `migrations/v0.57.0-cast-lora.sql`.

### Backend

- `src/lora-bundle.ts` (new, pure): `buildLoraTrainingBundleArgs(cast, suffix)` builds the synthesized single-slot bundle (storyboard with one shot, characterRefs.A from the cast member's portrait + ref keys); `deriveLoraDestKey(castId, ts)` returns the destination R2 key.
- `src/cast-db.ts`: `LoraStatus` type + new fields on `CastMember`/`CastRow`; helpers `setLoraJob`, `markLoraReady`, `markLoraFailed`.
- `src/runpod-submit.ts`: `TrainLoraArgs` + `TrainLoraJobInput` + `buildTrainLoraPayload` + `submitTrainLoraJob`. Validates `lora_dest_key` starts with `loras/` on the worker side; the Worker handler enforces it again before submitting.
- `src/index.ts`: `POST /api/cast/:id/train-lora` validates ownership + readiness (portrait + ≥4 refs), assembles the bundle, submits the RunPod job, persists `job_id` + `status=training`. `GET /api/cast/:id/lora-status` polls RunPod with the stored job id and adopts `lora_key` into the row on COMPLETED, flips to `failed` on FAILED/TIMED_OUT/CANCELLED.

### Frontend

- `public/cast.html`: new "LoRA training" section under "training references" with a status badge (idle / training / ready / failed), meta line, train button, and a download `.safetensors` link when ready.
- `public/cast.js`: `renderLoraPane` + `trainLora` + a 5s polling loop (`pollLoraStatus`) that kicks in when the cast row is in `training` state and stops automatically on terminal status. Switching to another character cancels the previous poller.

### Tests

7 new vitest tests in `tests/cast-db.test.ts`:

- `buildLoraTrainingBundleArgs` — storyboard shape, characterRefs mapping, bible fallback to name, portrait omission, slug fallback
- `deriveLoraDestKey` — namespace + version format

450/450 passing, type-check clean, cast.js syntax-checks.

### Deploy

Apply the D1 delta first:

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrations/v0.57.0-cast-lora.sql
npm run deploy
```

### What is NOT in this PR (Phase 3 follow-up)

- Renders skipping Stage 1 when the cast members in their bundle have a pre-trained `lora_key`. Right now the trained LoRA is downloadable + tracked but not yet wired into the render-time bundle. The Phase 3 PR will add `cast_lora_keys` to the bundle assembler and have the vivijure-serverless side detect them in `train_loras` to skip retraining.
- "Train all cast members in this project" batch action.
- Versioned download/inspect UI (currently the most recent training is what `lora_key` points at; older versions stay in R2 but are not surfaced).

## v0.56.0

Auto-preflight on edit. The v0.54.0 preflight panel runs on a successful plan + on the manual "run preflight" button. v0.56.0 wires it into every edit path that affects the storyboard, cast bindings, or audio bed so the panel stays current without the user clicking.

### Edit paths that auto-trigger preflight

- Every scene-editor edit (prompt, target_seconds, act, character_slots, delete) via `onSceneChanged`
- Scene snap-to-beats (`snapAllScenes`)
- Refinement chat success (a refine rewrites the storyboard)
- Cast binding changes (`bindSlotToCast` / `unbindSlot` — a binding affects the cast readiness check)
- Audio bed set / clear / MiniMax completion (audio key affects the audio HEAD warning)

### Debounce + in-flight rerun queue

`schedulePreflight()` debounces at 600ms so rapid edits coalesce into one run. If a run is already in flight when a new fire arrives, a `preflightRerunQueued` flag is set; when the current run completes, it schedules another. This avoids both the "ten edits → ten preflights" spam case AND the "edited during preflight → stale panel" case.

### Toggle + persistence

A new "auto-run on edit" checkbox sits next to the "run preflight" button in the toolbar. Default-on. Persists via the existing planForm stash; turning off keeps the manual run path working. Turning it back on triggers an immediate run so the panel catches up to whatever edits the user made while auto was off.

### No backend / schema change

Pure frontend. Deploy is just `npm run deploy`; no D1 migration.

### Tests

No new vitest tests — the debounce + rerun logic is DOM-glue + setTimeout, which the existing Node-only test pool doesn't model. The existing 444 tests still pass; manual smoke covered.

### What is NOT in this PR

- "Preflight pending..." indicator while debounce is waiting. The current status line transitions clear → running → ok, but during the debounce window it shows whatever the previous run reported, which can lag the actual storyboard state by up to 600ms.
- Per-edit-type preflight invalidation (e.g., a prompt edit only needs the prompt-length warning re-checked, not the cast readiness). The current implementation re-runs the full check; small enough to not matter at typical storyboard sizes.

## v0.55.0

Pin render history rows to storyboard projects. Adds an optional `project_id` column to `renders` (FK to `storyboard_projects.id`), threads it through the submit handlers + `insertRender`, and teaches the planner's history list to filter by the active project. Finalize child rows inherit the parent preview row's `project_id` so a v0.42.0 preview + finalize pair stay grouped under the same project filter.

### Schema

- `renders.project_id INTEGER NULL` — added via `ALTER TABLE`. Backfill is intentionally NOT done; pre-v0.55 rows stay NULL and surface in the unfiltered list (the pre-v0.55 default). New rows pick up the active project when one is set at submit time.
- New partial index `renders_by_user_project ON (user_email, project_id, submitted_at DESC) WHERE project_id IS NOT NULL`. Serves the project-filtered list query directly without scanning unrelated rows.
- Migration delta at `migrations/v0.55.0-renders-project-id.sql`.

### Backend

- `src/renders-db.ts`: `NewRenderRow.projectId?`, `RenderRow.project_id`, normalizer parses the int back. `listRendersForUser` grows an optional `projectId` param; when set, the WHERE clause adds `AND project_id = ?` and the SELECT statement uses the new partial index. Pure helper `normalizeProjectIdInput(raw)` covers the "accept positive integer or numeric string, else null" contract.
- `src/index.ts`:
  - `RenderSubmitRequest.projectId?: unknown` validated as positive integer; the route looks the project up via `getProjectById` (404 on miss-or-not-owned) and passes the id into `insertRender`.
  - `handleFinalizeSubmit` reads `row.project_id` off the parent preview and propagates it on the new child row — finalize chains stay grouped.
  - `handleRendersList` reads `?project_id=N` query param via `normalizeProjectIdInput` and threads it to the DB helper.

### Frontend

- `public/planner.js`:
  - Render-submit body now sets `projectId: planState.activeProjectId` when one is selected.
  - `loadHistory()` builds the URL with `URLSearchParams`; appends `project_id` when an active project is set. Changing the active project re-fetches.
  - `selectProject()` triggers `loadHistory()` so swapping projects updates the visible list immediately.

### Tests

5 new vitest tests for `normalizeProjectIdInput`: positive integers, numeric strings, zero/negative/fractional rejection, empty/null/undefined, non-numeric strings and non-number types. 444/444 passing, type-check clean, planner.js syntax-checks.

### Deploy

D1 delta first, then deploy:

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrations/v0.55.0-renders-project-id.sql
npm run deploy
```

### What is NOT in this PR

- Backfilling pre-v0.55 rows to a project. The slug string in `renders.project` could heuristically match `storyboard_projects.slug`, but that's a destructive guess and existing renders are already accessible via the unfiltered list. Skipped.
- "Move render to project" affordance on history rows. Useful for organizing legacy rows; a small PATCH route + UI button can ship later.
- Counting / showing the per-project render count on the project picker. Cosmetic; UI follow-up.

## v0.54.0

Pre-render preflight + project dial-in expansion. The legacy
`/api/project/{p}/preflight` and `/dial-in` routes had no Worker
equivalent until now. v0.54.0 adds a pre-render validation surface
that catches schema / shape / readiness errors before the user spends
GPU time, and broadens the project-prefs round-trip from the small
v0.53.0 set (model + brief + BPM) to the full render preset.

### Preflight

- `src/preflight.ts` (new, pure): `checkStoryboardShape` walks every scene checking for empty / very short prompts, slots not in `use_characters`, target_seconds outside the renderable range (<= 0, < 1.5s warning, > 12s warning). `checkCastBindingsReady` resolves slot → cast_id → catalog and flags missing portraits, missing refs, and sparse refs (<4). `summarize` produces a `{ok, counts, issues[]}` envelope (`ok = no errors`).
- `POST /api/storyboard/preflight` (new): body `{storyboard, bundleKey?, audioKey?, castBindings?}`. Runs validator + pure checks; adds R2 HEAD checks on the bundle key (must exist in `R2_RENDERS`) and the audio key (resolves to `R2` for `out/...`, `R2_RENDERS` for `audio/...`; mismatched owner = error, missing = warning since the GPU just falls back to silent). Returns the summarize envelope.
- Frontend (`#planner-preflight`): new section between the audio block and the bundle stage. Visible when a storyboard exists. Auto-runs on every successful plan and on demand via the "run preflight" button. Issues render with severity-colored badges (error red, warning amber, info dim) and a scope tag. When `counts.error > 0`, the bundle button gets disabled to gate the submit; warnings pass through.

### Dial-in expansion

The v0.53.0 prefs covered model id, brief, BPM, beats-per-shot. v0.54.0 adds the full render preset:

- quality tier
- keyframes-only checkbox
- seed (text)
- adetailer select
- lora scale (number)
- consistency select
- render overrides JSON textarea (verbatim)

`gatherProjectPrefs` reads them on save; `applyProjectPrefs` writes them on load. Saving a project after configuring the render form once means a future "Load project" restores the same render preset across sessions / browsers.

### Tests

20 new vitest tests:

- `checkStoryboardShape` — empty prompt, very short prompt, slot mismatch, target_seconds <= 0, target_seconds < 1.5, target_seconds > 12, clean-pass, empty scenes
- `checkCastBindingsReady` — happy path, no portrait, no refs, sparse refs, deleted binding, null bindings
- `summarize` — ok-true on warnings only, ok-false on any error, empty list

439/439 passing, type-check clean, planner.js syntax-checks.

### No schema change

Pure planner-side surface. Deploy is just `npm run deploy`; no D1 migration.

### What is NOT in this PR

- Auto-preflight on every scene edit (currently only on plan + refine + manual click). A debounced auto-run after edits would be a small follow-up.
- Bundle button styling change beyond `disabled` (the gate works; an explicit "blocked by preflight: N errors" tooltip would polish the UX).
- Pinning render-history rows to a `storyboard_projects.id` (still tracked from v0.53.0).

## v0.53.0

Two legacy gaps closed in one PR: NLE markers export (one marker per scene, downloads as CSV ready for Premiere or DaVinci Resolve) and persisted storyboard projects (D1-backed, separate from the chat-side projects table). The planner gains a small project picker at the top ("(none) | <projects> | + new") and an "export markers" button in the scene editor toolbar.

### Backend

- `src/markers.ts` (new, pure): `formatTimecode`, `buildMarkers`, `emitPremiereCsv`, `emitResolveCsv`, and `emitMarkers` (returns body + contentType + filename). Cumulative `in/out` times across scenes (uses `target_seconds`, falls back to `clip_seconds`, default 5s). Premiere CSV is tab-separated with a Comment marker type column; Resolve CSV is comma-separated with an act-driven Color column (opening=Blue, rising=Green, turn=Yellow, climax=Red, resolution=Cyan).
- `src/storyboard-projects-db.ts` (new): D1 helpers mirroring `src/cast-db.ts`. `listProjectsForUser`, `getProjectById`, `createProject`, `updateProjectMeta`, `setLastStoryboard`, `deleteProject`, plus `slugifyProject` + `allocateProjectSlug` for per-user slug uniqueness.
- `src/index.ts`: new routes
  - `POST /api/storyboard/markers` — runs `validateStoryboard` then `emitMarkers`; returns the file body with `Content-Disposition: attachment; filename=<title>-<format>-markers.csv`. Pure compute; no D1 or R2.
  - `GET /api/storyboard/projects` — list user's projects
  - `POST /api/storyboard/projects` — create with `{name, prefs?}`
  - `GET /api/storyboard/projects/:id` — get one
  - `PATCH /api/storyboard/projects/:id` — update `name` and/or `prefs`
  - `POST /api/storyboard/projects/:id/storyboard` — save a snapshot of the current storyboard as the project's `last_storyboard`
  - `DELETE /api/storyboard/projects/:id` — remove (returns the deleted row)

### Schema

- `schema.sql`: new `storyboard_projects` table + two indexes (user-scoped chronological + per-user unique slug). Migration delta at `migrations/v0.53.0-projects.sql`.

### Frontend

- `public/planner.html`: new `<section class="planner-project">` above the brief form: dropdown + `+ new project` / `save storyboard to project` / `delete project` buttons. Scene-editor toolbar gets a format picker + `export markers` button.
- `public/planner.js`: project catalog fetched on page load, picker hydrated, save/load wired. Picking a project pulls in its `prefs` (model id, brief, BPM, beats-per-shot) and, if a `last_storyboard` was saved, loads it into the JSON / YAML / scene-editor panes (with a YAML refresh via `/api/storyboard/yaml`). `activeProjectId` is added to the localStorage stash so a tab reopen reselects the project. Markers export builds a blob, sets `download=<filename>`, clicks an anchor.

### Tests

15 new vitest tests:

- `formatTimecode` — zero, fractional frames, minute/hour rollover, non-24 fps, invalid inputs
- `buildMarkers` — cumulative time, act-prefix in description, synthesized scene names, empty input
- `emitPremiereCsv` / `emitResolveCsv` — header shape, marker type, act-color mapping
- `emitMarkers` — content-type + filename for both formats
- `slugifyProject` — basic + empty fallback

422/422 passing, type-check clean, planner.js syntax-checks.

### Deploy

Apply the D1 delta first:

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrations/v0.53.0-projects.sql
npm run deploy
```

### What is NOT in this PR

- Per-project preflight / dial-in routes (the legacy had `POST /preflight` to validate render readiness; this PR ships persistence + prefs but not the pre-render validation surface). Tracked.
- Render history rows pinned to a project (current `renders` table has a `project: TEXT` column, but it is a slug string from the bundle key, not a foreign key into `storyboard_projects`). Joining the two is a follow-up; would surface "filter render history by project" in the planner.
- Project-scoped cast bindings (the v0.48.0 cast-binding feature persists in localStorage; v0.53.0 prefs could carry them but the planner does not write them yet).

## v0.52.0

Closes the audio loop end-to-end. v0.51.0 shipped the audio + beat-snap surface (generate / upload / snap on the planner). v0.4.11 on the GPU side accepts an `audio_key` job field and muxes via `export_film(with_audio=True)`. v0.52.0 wires the two together: the planner now passes `planState.audioKey` to both the render-submit and finalize routes, and the Worker cross-bucket-copies MiniMax-generated tracks into the GPU's bucket before submit so the GPU's R2 client can resolve them.

### Cross-repo coordination

Needs **vivijure-serverless 0.4.11** on the RunPod endpoint (live as of 2026-06-01).

### Backend

- `src/audio-routing.ts` (new): pure helper `needsAudioCrossBucketCopy(key)`. Returns true for `out/...` (MiniMax / `/api/chat` artifacts in `env.R2`), false for `audio/...` (BYO uploads already in `env.R2_RENDERS`) and everything else. Pure so vitest covers it without the `cloudflare:workers` runtime.
- `src/index.ts`: new async `placeAudioForGpu(env, key, userEmail)` wrapper. Pass-through for keys that don't need a copy; for `out/...` keys, it reads bytes from `env.R2` (ownership-checked via customMetadata.user_email, 4xx on miss / mismatch), writes to `env.R2_RENDERS` at `audio/<uuid>.<ext>`, and returns the new key. The submit handlers call this before constructing the RunPod payload so the GPU side sees only `audio/...` keys.
- `handleRenderSubmit` (POST `/api/storyboard/render`): accepts `audioKey: string` in the request body. Validates type, runs `placeAudioForGpu`, threads the resulting key through `args.audioKey` to `buildSubmitPayload`. A staging error (404 / 403) returns 400 with the explicit cause before the GPU job is created.
- `handleFinalizeSubmit` (POST `/api/storyboard/renders/:id/finalize`): defensive body parse (the route still accepts an empty body for v0.42.0 compatibility) extracts an optional `audioKey`. Same staging path; threads through `args.audioKey` on `submitFinalizeJob`.
- `src/runpod-submit.ts`: `RenderSubmitArgs.audioKey`, `FinalizeArgs.audioKey`, `RenderJobInput.audio_key`, `FinalizeJobInput.audio_key`. Both `buildSubmitPayload` and `buildFinalizePayload` include the field only when non-empty (stays off the wire when unset; pre-0.4.11 workers ignore unknown fields anyway).

### Frontend

- `public/planner.js`: render-submit body now carries `audioKey: planState.audioKey` when set. The finalize-button handler (`finalizeRender`) does the same with a defensive JSON body that pre-v0.52 callers can still skip. No UI change; the planner's v0.51.0 audio section already manages `planState.audioKey`.

### Tests

5 new vitest tests for `needsAudioCrossBucketCopy` (chat-side prefix, audio-side prefix, empty / null, unrelated prefixes, anchor at start). 407/407 passing, type-check clean, planner.js syntax-checks.

### What is NOT in this PR

- BPM + beat-snap metadata is not yet propagated to the GPU side. The snap mutates `scene.target_seconds` in `planState.storyboard` which already flows through the bundle, so the rhythm reaches the renderer; but the BPM number itself is not sent. If we ever want a per-shot audio sync envelope (cuts at exact sample offsets vs second offsets) that's a future PR + worker-side change.
- No UI confirmation that the audio survived to the GPU; the user just sees `has_audio: true` on the finished render row. A small `audio_key` echo in the renders list would tighten the feedback loop; tracked for v0.52.x.

## v0.51.0

Audio bed + beat-driven shot timing on the planner. The user can generate a track via MiniMax Music 2.6 through the existing /api/chat music dispatcher, or upload their own mp3/wav/aac/m4a/ogg, then set a BPM and snap all scene durations to a musical-phrase multiple so cuts land on the beat.

This PR is the audio + timing surface. Server-side ffmpeg muxing (gluing the generated audio onto the silent_full.mp4 the GPU worker produces) is intentionally NOT in scope; that's a vivijure-serverless change for a follow-up. For now the workflow is: generate or upload audio → snap shots to it → render the silent video on RunPod → mux locally with `ffmpeg -i silent.mp4 -i track.mp3 -c:v copy -c:a aac out.mp4` (or wait for the future mux PR).

### Backend

- `POST /api/storyboard/audio-upload`: accepts binary audio via Content-Type header (mp3, wav, aac, m4a, ogg, webm). 32 MB cap. Writes to env.R2_RENDERS at `audio/<uuid>.<ext>` with customMetadata.user_email. Returns `{key, mime, size, user}`.
- `src/r2-routing.ts`: `isRendersKey` now also matches `audio/`, so `/api/artifact/audio/<key>` resolves to the right bucket. Two new vitest assertions cover the prefix.
- Music generation goes through the EXISTING `/api/chat` route with `model: "minimax/music-2.6"` (catalog entry was already shipped pre-v0.51.0). Returns the same `{id, job_id, status: "pending"}` envelope; the planner polls `/api/job/:id` on the v0.12.0 LongRunWorkflow pattern.

### Frontend (`#planner-audio`)

New section between the scene editor and the bundle stage. Hidden until a plan resolves. Three sub-blocks:

1. **Current audio bed** (visible only when planState.audioKey is set): label, R2 key, inline `<audio controls>`, clear button.
2. **Generate via MiniMax** disclosure: prompt textarea + Generate button. Submits to `/api/chat` and polls; the chat id is persisted via localStorage so a refresh mid-job resumes polling. On success, adopts `output_artifact.key` as `planState.audioKey`. ~30-90s wall-clock per generation.
3. **Upload your own** disclosure: file picker, POSTs to `/api/storyboard/audio-upload`. The returned R2 key becomes the audio bed.

Below the source blocks: BPM number input (default 120, range 20-300) + beats-per-shot select (1, 2, 4, 8, 16; default 4 = one bar of 4/4). The **snap all scene durations** button mutates every `scene.target_seconds` in `planState.storyboard.scenes` via `snapToBeats(seconds, bpm, beats)`, rounds to the nearest phrase, and floors at one phrase so a 0.1s scene does not collapse to zero. Snap goes through the existing `onSceneChanged` flow so the v0.49.0 YAML preview + dirty badge stay current; the v0.49.0 "discard all edits" still rolls back snap mutations.

### Persistence

`audioKey`, `audioMime`, `audioSourceLabel`, `bpm`, `beatsPerShot`, and `pendingMusicChatId` are added to the localStorage stash. Refreshing the tab restores all of them; an in-flight music-gen job auto-resumes polling.

### Tests

5 new vitest tests for the pure `snapToBeats` helper: 4-beat snap at 120 BPM, 1-beat snap at 90 BPM, floor protection on tiny / zero seconds, return-original on invalid BPM, return-original on invalid beats. 402/402 passing.

### What is NOT in this PR

- Server-side mux (combining generated audio with the GPU's silent_full.mp4 — needs a vivijure-serverless 0.4.11 step or a worker-side WASM ffmpeg). The audio key is staged in R2 ready for that pipeline.
- Real beat detection from an uploaded waveform (current snap uses user-supplied BPM; auto-detect would need an audio-analysis library).
- Per-scene per-beat override (current snap is uniform; advanced editors can already type a custom target_seconds in the v0.49.0 scene editor).

## v0.50.0

Iterative refinement chat on a planned storyboard. The plan route is single-shot: brief in, storyboard out. After v0.50.0 the user can keep talking to the model ("add a fight before the ending", "make scene 2 darker", "swap who appears in scene 4") and each turn rewrites the in-flight storyboard. Closes the legacy `/api/plan/chat/*` gap with a stateless backend variant: the chat history is a UI concern (shown to the user as a turn log) and is NOT replayed to the model. The current storyboard already reflects every accepted change, so the model only needs the current JSON + the latest user message to compute the next state.

### Backend

- `src/planner-prompt.ts`: two new pure helpers, `buildRefinementSystemPrompt()` and `buildRefinementUserMessage(storyboard, message)`. The system prompt repeats the storyboard schema (same one the planning prompt uses) and adds a strict "preserve unchanged fields bit-for-bit" rule so the model does not silently paraphrase prompts the user did not touch.
- `src/planner.ts`: `refineStoryboard(env, args)` mirrors `planStoryboard`'s provider dispatch (Anthropic / xAI / Workers AI), JSON-fence strip, parse, and `validateStoryboard` flow; returns the same `PlanStoryboardResult` shape so the route handler reuses the existing error envelope.
- `src/index.ts`: `POST /api/storyboard/refine`. Body `{model, storyboard, message}`. Validates each field at the route boundary (model in catalog, message non-empty, storyboard present); rejects 400 on missing fields, 502 on upstream failure, 200 with `ok:false` on a validator / parse miss, 200 with `ok:true, storyboard, yaml` on success. Identical envelope shape to `/api/storyboard/plan`.

### Frontend (`#planner-refine`)

New section between the plan output panes and the scene editor. Hidden until a plan resolves. Layout: a scrollable turn list (user turns highlighted with the accent border, assistant turns dimmed) + a 2-row textarea + a send button. Cmd/Ctrl+Enter submits.

Each turn:
1. Optimistically append the user message to the log so the UI does not feel frozen during the model call.
2. POST `/api/storyboard/refine` with the current `planState.storyboard` + the message.
3. On success, replace `planState.storyboard` with the returned draft, refresh the JSON + YAML panes, re-render the scene editor, append an assistant turn (`"updated storyboard (N scenes)"`) to the log.
4. On validator / parse failure, append the error list as an assistant turn so the user can correct the request without losing the conversation.

A fresh plan resets the chat log; the conversation is per-storyboard. Both `refineHistory` and the v0.49.0 `originalStoryboard` snapshot are saved in the localStorage stash so a tab close keeps the editing context.

### Tests

4 new vitest tests for the refinement prompt builders: system prompt contains the preserve-unchanged rule + the schema + no-prose/markdown/fences guardrails; user message includes the storyboard JSON + the trimmed user request + the close-out instruction. 397/397 passing.

### What is NOT in this PR

- D1-backed conversation persistence per project (the chat log lives in localStorage; it dies on storage clear and is not shared across browsers).
- Conversational history replay to the model (each turn is stateless; the model sees only the current storyboard + new message).
- Streaming responses (the route is a single POST/response; UI shows a "refining..." status for the 5-15s call).
- "Undo last turn" affordance (the scene editor's "discard all edits" already restores the original plan output; per-turn undo would need a snapshot stack).

## v0.49.0

Per-scene editor between plan output and bundle. After the planner returns a validated storyboard, the user can now tweak individual scenes (prompt text, target seconds, per-shot character slots, act label) and delete unwanted shots before the bundle assembles. Edits flow into the bundle automatically since the bundle POST already uses `planState.storyboard`; the YAML preview pane refreshes via a new `/api/storyboard/yaml` route so the user sees the canonical wire format after each edit.

### Frontend (`#planner-scenes`)

A new section sits between `#planner-output` (the plan-result panes) and `#planner-bundle` (the upload + bundle step). Hidden until a plan resolves. For each scene in `planState.storyboard.scenes`:

- shot id (read-only header) + optional act label
- prompt textarea (mono font, 3 rows by default; this is the main edit target)
- target seconds number input
- act text input (empty = remove the field)
- character_slots checkboxes, one per slot in `storyboard.use_characters` (empty = narration shot, the validator allows that)
- delete button (confirm, then splice the scene out)

Edits mutate `planState.storyboard.scenes[i]` in place; the bundle POST at submit time consumes the edited shape. A dirty badge appears in the toolbar when edits diverge from the original plan output; a "discard all edits" button restores `planState.originalStoryboard` (snapshotted on each fresh plan). Both `originalStoryboard` and the dirty state survive a tab close via the existing localStorage stash.

### Backend (`POST /api/storyboard/yaml`)

Pure compute route. Body `{storyboard: <json>}`; runs `validateStoryboard` then `serializeStoryboardYaml` and returns `{ok: true, yaml, storyboard}` on success. On validator failure: 400 with `{ok: false, errors: [...]}`. No D1, no R2; the frontend calls it on a 500ms debounce after each scene edit so the YAML pane stays in sync, and on a validator error it shows the message under the scene editor so the user sees why their edit broke the schema.

### Tests

3 new vitest tests for the storyboard yaml route helpers: validates + emits a minimal multi-scene storyboard, rejects a scene with a blanked prompt, rejects a scene referencing a slot not in `use_characters`. 393/393 passing.

### What is NOT in this PR

- Adding a new scene (requires a "where to insert" UX; tracked).
- Reordering scenes (drag-and-drop is involved).
- Per-shot regen WITH a new prompt at render-history time (current regen-shot route uses the saved storyboard prompt; surfacing a prompt override is a small backend tweak + UI for a follow-up).
- Persistent project storyboards (the planner is still single-storyboard-per-session; a proper /projects/<slug>/storyboard surface is the bigger lift).

## v0.48.0

Planner reads from the persisted cast. The /cast page (v0.46.0+) was a standalone surface up to v0.47.1: users could create characters, generate portraits, and build LoRA training sets there, but the planner still required typing the name + bible inline and re-uploading training images for every storyboard. v0.48.0 wires the two together: each plan-stage cast slot grows a "from cast" dropdown, and a picked cast member auto-fills name + bible and pre-populates the bundle stage's per-slot training-image set with the cast's portrait + ref keys.

### Plan stage (`#planner-cast`)

Each slot row now has a `<select>` between the include checkbox and the name input. Options are `inline (type here)` plus one entry per persisted cast member (`Name (portrait, N refs)`). Picking a cast member:

- Fills the name field with `cast.name`
- Fills the bible textarea with `cast.bible`
- Marks both fields readonly so they cannot drift out of sync with /cast
- Records the binding in `planState.castBindings[slot] = cast_id`

Picking `inline (type here)` reverses the above: removes the binding, clears readonly, and the user can type a one-off character that does not need persisting.

### Bundle stage (`#planner-bundle-cast`)

For every slot bound to a cast member, `bundleState.perSlotUploads[slot]` is synthesized from the cast's `portrait_key` + `ref_keys[]` (each as a `{key, status: "done", fromCast: true}` entry). The slot's row hides the file picker entirely and shows a small badge: `linked to cast member: <name> (1 portrait, N refs). manage at /cast.`

The bundle assembler code at the submit path is unchanged: it reads keys out of `perSlotUploads`, doesn't care whether they came from an inline upload (`character-refs/<uuid>`) or a persisted cast member (`cast/<id>/portrait.<ext>`, `cast/<id>/refs/<uuid>.<ext>`). The v0.47.1 routing patch (`cast/` keys go to `R2_RENDERS`) is what makes the GPU worker resolve those keys at render time.

### Persistence + reconciliation

`castBindings` is added to the localStorage stash so a tab close keeps each slot linked. On reload, the planner fetches `/api/cast` first and runs `reconcileCastBindings(saved, catalog)`: any binding whose `cast_id` was deleted out of band falls back to inline (the slot row goes editable again, the user is not stuck with a stale character).

### Backend

No backend changes. The `/api/storyboard/bundle` route accepts the existing `characterRefs: {slot: {name, prompt, trainingImages: [{key}]}}` shape; the keys just happen to be persisted ones now.

### Tests

5 new vitest unit tests for `reconcileCastBindings` (kept / dropped / empty catalog / empty bindings / missing bindings). 390/390 passing.

### What is NOT in this PR

- Cast picker on /cast itself (the /cast page is the editor; the planner is the consumer; not the other way around).
- Drag-and-drop reordering of bound slots.
- Bulk "set all slots to defaults" affordance.
- A "create cast member from this inline character" shortcut (would close the loop the other way; tracked for a follow-up).

## v0.47.1

Hotfix on v0.47.0: GET `/api/artifact/cast/<id>/portrait.<ext>` returned 404 because `isRendersKey` (the artifact-route bucket-picker) did not know about the new `cast/` prefix. Cast portraits and refs are physically in env.R2_RENDERS (the vivijure bucket), where the GPU worker also reads them; the read path was selecting env.R2 (the chat bucket) by default and missing. Adds `cast/` to the renders-bucket prefix list and a regression test. Smoke test on prod with a v0.47.1 deploy: portrait save round-trips through /api/artifact correctly; the training-set generator can now resolve the portrait URL the same way the browser does.

## v0.47.0

In-page portrait generation + automated 10-image LoRA training-set generation on /cast. The v0.46.0 backend supported "save a chat-side image as portrait" via `{from_chat_artifact: key}`, but the user had to go to /, generate via chat, then come back. v0.47.0 wires both flows directly into /cast so the inner loop stays on one page.

### Portrait generation

Inside the portrait pane, a disclosure ("generate a portrait via chat") shows a model picker (every entry from `/api/models` with `type=="image"`, fetched on first open) plus a prompt textarea (auto-falls back to the bible if empty). The Generate button POSTs to `/api/chat` with the picked model + prompt; the returned `output_artifact.key` shows up in a preview. Accept saves it as the portrait via the existing `from_chat_artifact` path; discard throws it away (the chat row stays in the chat history regardless).

### Training-set generation (10 images)

A second disclosure ("generate a 10-image training set") becomes active once the character has a saved portrait. The button fetches the portrait bytes from `/api/artifact/`, downscales it to 512px on the longest edge in a `<canvas>` (FLUX 2's input cap), and fires 10 sequential `/api/chat` calls against `@cf/black-forest-labs/flux-2-dev` (the only multi-reference model in the catalog). Each call passes the portrait as `input_image_0` plus a prompt of `<pose template>. <bible>`. As each returns, the artifact is auto-saved as a training ref via `POST /api/cast/:id/refs` with `{from_chat_artifact: key}`.

The 10 prompts are fixed templates covering neutral / smile / left-profile / right-profile / look-up / serious-low-angle / laughing / medium-action / contemplative-overhead / surprised, each with consistent lighting + "clean background" guidance to keep the LoRA training data uniform. Sequential (not parallel) to avoid upstream rate-limit hits at 10 simultaneous generations.

The progress UI shows a 2-column grid (1/10..10/10) with each row flipping pending → running → done / fail. Total wall-time is roughly 2-4 minutes depending on model. Failures don't halt the batch; the user gets a count of saved vs failed at the end and the partially-populated ref set on the character.

### Backend

`POST /api/cast/:id/refs` gains the same JSON branch the portrait route already had: `{from_chat_artifact: key}` copies an env.R2 chat-side artifact into env.R2_RENDERS under `cast/<id>/refs/<uuid>.<ext>` and appends to `ref_keys_json`. Without this, the training-set generator would have to download each generated image to the browser and re-upload it as binary.

No schema changes; v0.46.0 migration is sufficient.

### Tests

5 new vitest unit tests for `composeTrainingPrompt` (the pure helper that joins pose template + bible with the 600-char cap). 385/385 passing.

### Why scope ended here

Per the cast-manager direction memo, the right thing is fewer-but-deeper iterations. v0.47.0 keeps the planner unchanged (still uses its inline cast slots, doesn't read from this table yet). The planner rewiring + cast picker on the planning page is the next slice; queuing the 10-image batch as a real background job (so the user can navigate away cleanly) is a follow-up if the sequential-blocking UX proves rough.

## v0.46.0

Persisted cast manager. New `/cast` page (cast.html + cast.js) plus an `/api/cast` REST surface lets a character (name, bible text, portrait, multi-image training-ref set) be drawn once and reused across every storyboard. Replaces the inline-only cast-slot model the planner had, where characters were transient form fields that vanished after each render submit.

This PR is the persistence + CRUD + standalone-page slice. The planner still uses its inline cast-slot UI today; switching the planner to read from the persisted cast is a follow-up PR (kept scoped so this lands without sprawl).

### Why

Today the planner takes name + bible inline on every submit and stages refs to ephemeral R2 keys. A user who runs five projects with the same Kira has to retype her bible and re-upload her training refs five times. The legacy vivijure-serverless FastAPI UI had per-project cast slots (A-D); this is the upgrade to global per-user cast that survives across projects, since reuse is the normal case, not the exception.

### Backend

- `schema.sql`: new `cast_members` table mirroring the projects pattern (user_email scoping, per-user unique slug, ISO TEXT timestamps). `ref_keys_json` defaults to `'[]'` so a fresh row has a well-formed JSON empty array without a NULL check at the read site.
- `src/cast-db.ts` (new): typed helpers + `slugifyCharacter` + `allocateCastSlug`. Mirrors src/renders-db.ts shape: pure-row interface, user_email in every WHERE, no cross-user leak path.
- `src/index.ts`: `/api/cast` (GET, POST), `/api/cast/:id` (GET, PATCH, DELETE), `/api/cast/:id/portrait` (POST, DELETE), `/api/cast/:id/refs` (POST), `/api/cast/:id/refs/:key` (DELETE). The PATCH writes to `cast_members` directly; DELETE cleans up R2 objects under `cast/<id>/...` best-effort after the row delete commits.
- Portrait upload accepts two body shapes: raw image bytes (the simple drag/drop path), and `{from_chat_artifact: "out/<uuid>.png"}` which copies an existing chat-side artifact from env.R2 to env.R2_RENDERS with the same ownership check used elsewhere. This is the "use the portrait I just generated via /api/chat with an image model" path; no GPU spend required.

### Frontend

- `public/cast.html`, `public/cast.js`, plus styles appended to `public/styles.css`. Hand-rolled vanilla JS matching the planner.js / app.js idiom (no framework, no bundler).
- Two-column layout: sidebar list (name + portrait thumb) + editor pane (name input, bible textarea, portrait drag/drop with image preview, refs grid with per-thumbnail remove). One-pane fallback under 720px.
- Nav links added: index.html sidebar gets a "cast" link next to "storyboard planner"; planner.html header gets a "cast" link.

### Storage layout

R2_RENDERS bucket:
- `cast/<id>/portrait.<ext>` for the canonical portrait.
- `cast/<id>/refs/<uuid>.<ext>` for each training-ref image.

Both with customMetadata.user_email so the existing /api/artifact ownership check authorizes the user back to their own bytes. The bundle assembler can read these directly at render time; no cross-bucket copy needed.

### Tests

- `tests/cast-db.test.ts`: 7 unit tests for `slugifyCharacter` (lowercase, punctuation, whitespace runs, diacritics, empty / all-punctuation fallback, digit preservation). DB-touching helpers are exercised via dev smoke until / unless we add @cloudflare/vitest-pool-workers for D1-bound integration tests.

### What is NOT in this PR

- Planner rewiring: planner.js still takes inline cast slots. Switching it to "pick from existing cast" is a follow-up PR so this one lands clean.
- LoRA training kickoff and status (GPU-side action; separate scope).
- Per-scene editing on a project's storyboard (next major surface from the legacy gap analysis).

## v0.45.0

Lock state actually gates finalize. v0.42.0 shipped the lock pin as metadata-only ("the GPU runs Wan I2V over every shot regardless"); v0.45.0 makes it load-bearing. When the user has locked any shots in a keyframes-only preview, clicking finalize now restricts the I2V pass + silent-MP4 assembly to ONLY those shots. The unlocked shots are skipped: they get no clip and they do not appear in the final movie. When nothing is locked, the GPU runs the existing all-scenes flow (v0.42.0 back-compat).

### Why

v0.42.0 shipped the per-shot lock pin and a finalize button but left a noticeable semantic gap: the lock state was decorative, the GPU ran I2V on every shot anyway, and the user had no way to actually exclude a shot they did not approve from the final movie. The natural mental model ("lock = include, unlocked = exclude") is what v0.45.0 implements. Combined with v0.41.0's per-shot regen the loop is finally:

  preview keyframes → regen the bad ones → lock the good ones → finalize a movie of just the locked shots

A user who locks 4 of 6 shots gets a 4-shot movie. The unlocked 2 stay on the volume as keyframes; the user can regen them, lock them, and finalize again (the second finalize would be a separate history row with 6 shots, since locking the formerly-unlocked shots changes the locked set).

### Cross-repo coordination

Needs **vivijure-serverless 0.4.5** on the RunPod endpoint.

GPU side adds:

- `orchestrator.finalize` now accepts an optional `process_shot_ids: list[str]`. Resolves shot_ids → scene_indices via the manifest (raises a clear RuntimeError on unknown shot_ids so a Worker / client typo surfaces before assembly silently drops shots). When non-empty, drives the I2V pass via `core.render_scenes_gen(name, indices)` (the same generator `studio_service._i2v_pass_worker` uses, minus the threading + global state). When None / empty, the existing `_render_worker_body(payload)` all-scenes path runs unchanged.
- New `_render_selected_indices(name, indices, quality_tier, on_log)` mirrors `_i2v_pass_worker`'s body for the headless path (no `_render_thread` / `_render_lock` bookkeeping; we run blocking on the RunPod job worker).
- New `_assemble_selected(name, indices)` writes a temp `manifest_finalize.json` filtered to the selected scenes, validates each has a clip on disk (raises a clear error naming the missing shot_id when I2V failed for one), then calls `assemble.assemble_silent(tmp_manifest, output_path)` directly. The original `manifest.json` is left untouched.
- `rp_handler._handle_finalize` reads `process_shot_ids` from job input, validates it is a list of non-empty strings (400 on bad shape), passes through to `orchestrator.finalize`. Job envelope is unchanged from v0.4.4 (same `output_key`, `seconds`, `state_key`, `keyframes`, `mode: "finalized"`).

Pre-0.4.5 GPU endpoints ignore the new field and run the full all-scenes flow; back-compat is one-directional safe.

### Worker

- `src/runpod-submit.ts`: `FinalizeArgs.processShotIds?: string[]` + `FinalizeJobInput.process_shot_ids?: string[]`. `buildFinalizePayload` includes the field only when non-empty (so an empty array stays off the wire and the GPU does the full all-scenes flow); also clones the input array so a subsequent caller-side mutation does not leak into the built payload.
- `src/index.ts`: `handleFinalizeSubmit` reads `row.locked_shots` (the same column the PATCH route writes via v0.42.0's lock pin) and forwards as `processShotIds`. When the column is null / empty, the field is omitted; the GPU runs the full all-scenes flow. No new Worker route. No new D1 migration.

### UI

- `public/planner.js`: `finalizeRender(row, btnEl)`'s confirm dialog rewritten to reflect the new semantic. When `lockedCount > 0`, the dialog reads "this will assemble the silent MP4 from N of M keyframes (only the LOCKED shots). Wan I2V + assembly takes roughly X to Y minutes on the final tier. the unlocked shots (M - N) will NOT appear in the final movie. continue?". When nothing is locked, the dialog reads "no shots are locked, so all M keyframes will be included." The minute estimate scales with the processed shot count (5-10 minutes minimum for the assembly overhead; ~4-6 minutes per shot of I2V).
- `buildHistoryRow`'s finalize-row summary text and `toggleShotLock`'s in-place summary refresh both update to say "(finalize will assemble these only)" / "or finalize as-is to include all", so the user can see at a glance what the next finalize will include without opening the confirm dialog.

### Tests

`tests/runpod-submit.test.ts` gets 3 new cases under the `buildFinalizePayload` describe block:

- `process_shot_ids` included when set and non-empty
- `process_shot_ids` omitted when undefined / empty (so the wire stays clean)
- Input array is cloned so a subsequent mutation does not leak into the payload

Total 373 (370 prior + 3 new). Typecheck clean. No D1 migration.

### Behavior notes

- **Single-shot finalize**: locking exactly one shot produces a single-shot movie. The estimate scales accordingly.
- **All-locked finalize**: locking every shot produces the same output as the v0.42.0 unlocked-default behavior (no shots skipped). The wire payload differs (the field is sent) but the GPU side runs through the same `render_scenes_gen` generator either way.
- **Locked-but-no-keyframe**: not possible by construction (the lock pin only appears on keyframes that exist). Defensive: the GPU's `orchestrator.finalize` re-checks via `_assemble_selected`'s validation pass and surfaces a clear `shot_id has no clip on disk` error if a clip went missing between lock and finalize.
- **Re-finalize**: each finalize creates a NEW history row (v0.42.0 behavior). Re-finalizing with a different locked set produces a separate row with the new shot count.

### Apply

```
npm run deploy
```

Then push vivijure-serverless 0.4.5 (Jenkins auto-builds on the version-bump commit subject) and bump the RunPod endpoint to the new tag.

## v0.44.0

Live progress bar + elapsed + ETA on in-flight renders. The render-stage panel grows a `[##########____] 42% · elapsed 5m 12s · eta ~7m 30s` strip between the meta block and the cancel button. The bar fills from the GPU's existing `progress` field (a 0-1 float `render_control.render_fraction()` writes to `render_status.json`); ETA is a linear extrapolation from elapsed-so-far. A 1-second tick timer re-renders the elapsed + ETA text between SSE / poll updates so the counter advances smoothly instead of freezing for 3-8s at a time.

### Why

In-flight feedback was minimal: a status pill, a "scene 3/6" line, a log tail. A user submitting a final-tier render had to keep the tab open for 30+ minutes with no sense of how much was left, or guess from the log. The legacy `studio_api.py` UI had a progress bar driven off the same `progress` field; this commit restores parity. ETA is a new addition (legacy did not show one); a linear extrapolation from elapsed is rough but useful once a render is past ~3% complete.

### What

- `public/planner.html`: new `<div id="planner-render-progress">` between the meta block and the cancel-actions row. Contains a `.planner-render-progress-bar` (6px tall, accent fill) and a text line with percentage + elapsed + ETA. Hidden by default; revealed on the first non-IN_QUEUE observation.
- `public/planner.js`:
  - `renderState.startedAt` (ms since epoch, set lazily on the first non-IN_QUEUE status update so a long queue wait does not skew the ETA baseline). Persisted via the v0.38.0 localStorage stash; restored on reload. Cleared on terminal status and on a fresh submit.
  - `renderState.tickTimer` drives a 1s `setInterval` that calls `refreshProgressWidget(renderState.lastOut)` so the elapsed / ETA advance smoothly between snapshots. Cleaned up on terminal status, cancel, and re-submit.
  - `computeProgressFraction(out)` (new, pure): prefers `out.progress` (the GPU's `render_fraction()` value), falls back to `(scene_index - 1) / scene_total` when progress is absent, returns null when neither is available (UI shows the bar at 0% with `computing...`).
  - `refreshProgressWidget(out)` paints the bar fill + percentage + elapsed + ETA. ETA waits until both `frac >= 3%` and `elapsed >= 10s` before showing a number; below that it stays `computing...` so an early-stage render doesn't show a wildly-wrong estimate (the first minute is dominated by model-load time).
  - `hideProgressWidget()` is the idempotent teardown: clears the tick timer, drops `lastOut`, nulls `startedAt`, hides the widget element, saves persisted state. Called on terminal status.
  - `updateRenderProgress(data)` (existing) now also: anchors `startedAt` on first non-IN_QUEUE status, ensures the tick timer is running, caches `lastOut` for the timer to re-render against, and routes terminal status to `hideProgressWidget`.
  - `submitRender` resets `startedAt` and tears down any prior tick timer on a fresh submission.
- `public/styles.css`: `.planner-render-progress` flex column with 6px gap; `.planner-render-progress-bar` (full width, accent border, hidden overflow) holding `.planner-render-progress-fill` (accent background, animated `transition: width 0.4s ease-out` so the bar slides rather than jumps); monospace text line with subtle separators.

### Behavior notes

- **Progress source**: `out.progress` is the canonical signal. The GPU writes it via `render_control._set_phase` -> `status_snapshot()` (`render_control.py:246-255`). rp_handler's `_forward_progress` thread reads `render_status.json` every 3s and forwards via `runpod.serverless.progress_update(job, payload)`. RunPod surfaces it under `output` on the status endpoint, and the Worker passes it through unchanged.
- **Fallback when GPU is older**: if a pre-v0.4.x image is on RunPod and `out.progress` is absent, the bar falls back to `(scene_index - 1) / scene_total`. Coarser (only updates per shot completion) but better than nothing.
- **ETA accuracy**: linear extrapolation. The first shot is slow (model load + cold caches); subsequent shots are faster. Real wall-clock often comes in 15-30% under the early estimate and within 10% of the late estimate. Shown as `~Nm Ns` to signal it's an approximation.
- **Refresh resilience**: `startedAt` persists across page reloads. A user who refreshes mid-render sees the bar resume at the correct elapsed (computed from `Date.now() - startedAt`) without restarting the counter at 0.
- **Terminal cleanup**: when status transitions to COMPLETED / FAILED / CANCELLED / TIMED_OUT, the widget hides + the tick timer stops. The existing render-output panel handles the post-terminal "download MP4" affordance.

No backend change. No D1 migration. No cross-repo coordination. The GPU already writes `progress` and the Worker already passes it through; v0.44.0 just reads it. Tests 370/370 unchanged. Typecheck clean.

### Apply

```
npm run deploy
```

## v0.43.0

Render settings as first-class UI fields. The render-stage `render overrides (advanced)` collapsible used to be a freeform JSON textarea; v0.43.0 promotes the four most-tweaked fields to discoverable inputs (seed, adetailer face fix on keyframes, lora scale, consistency mode) and keeps the textarea below them as the power-user escape hatch. Empty / "use bundle default" entries are omitted from `render_overrides` so the bundle's own defaults win; explicit values land on the wire as the structured object. Textarea content wins on key conflict with the structured fields.

### Why

v0.39.1's gap analysis vs the legacy `studio_api.py` UI flagged the render-settings panel as the largest remaining surface mismatch. The textarea hint listed common keys but a user had to remember the exact field names + acceptable values, and a typo silently 400'd the render submit. Surfacing seed / lora_scale / consistency_mode / adetailer as labeled inputs means a user can land on those settings without consulting the docs, and validation messages now name the field that failed (`lora scale must be a number between 0.0 and 1.5`).

The four fields chosen were the legacy UI's "render-time" tuning knobs: seed (reproducibility), adetailer (anatomy / face fix on SDXL output), lora scale (character identity strength), consistency mode (locked seed + identity lock + anatomy guards). The other legacy knobs (motion engine picker, cloud API keys, multi-character mode) are not in scope: we're Wan-only by design, cloud keys do not apply to the serverless model, and multi-character is auto-detected from cast size.

### What

- `public/planner.html`: the `<details class="planner-overrides-details">` panel now contains:
  - `.planner-overrides-fields` block with four labeled inputs: seed (number + randomize button), adetailer face fix (select: `(use bundle default)` / `on` / `off`), lora scale (number, 0.0-1.5), consistency mode (select: `(use bundle default)` / `off` / `standard` / `strict (locked seed + identity lock + anatomy guards)`).
  - A nested `<details class="planner-overrides-raw-details">` for the raw JSON textarea, marked `(wins on conflict)` so the precedence is explicit.
- `public/planner.js`:
  - `buildRenderOverrides({ seedText, adetailer, loraScaleText, consistency, textareaText })` (new, pure): merges the structured inputs + parsed textarea into one object. Empty / "use bundle default" inputs are omitted. Validates seed is an integer (throws `seed must be an integer` on `1.5` or `"abc"`), lora_scale is a finite number in `[0, 1.5]` (throws `lora scale must be a number between 0.0 and 1.5` on `-1` or `2`). Textarea is parsed as JSON and merged last so it wins on key conflict. Throws `raw JSON textarea is invalid: <reason>` on bad JSON or `raw JSON textarea must be a JSON object` on a non-object value.
  - `submitRender` swaps the old textarea-only parse for a `buildRenderOverrides` call; on error it sets the render-stage status to the thrown message and focuses the textarea only when the message mentions JSON / textarea (so a seed / lora_scale validation error lands in the status bar without grabbing focus).
  - Empty `renderOverrides` (no structured fields set + empty textarea) returns `{}`; submit gates `reqBody.renderOverrides` on `Object.keys(...).length > 0` so the wire stays clean.
  - `collectRenderStageState` + `restoreRenderStagePanel` extend to persist each of the four new fields by their raw input string (`seedText`, `adetailer`, `loraScaleText`, `consistency`). Any non-empty restored field auto-opens the outer details panel so a reload does not bury the carried-across state inside a collapsed panel.
  - New `#planner-seed-randomize` button generates a fresh 32-bit unsigned int into the seed input + triggers `persistSoon`.
  - `readVal(selector)` tiny helper centralizes the empty-string fallback so adding a fifth structured field is a single edit instead of three.
- `public/styles.css`:
  - `.planner-overrides-fields` flex column with 10px gap.
  - Field inputs share the monospace + dark background + 1px border treatment so the structured panel reads as one cohesive surface.
  - `.planner-overrides-row` for the seed input + randomize button flex pair; `.planner-overrides-secondary` for the randomize button itself (subdued, accent on hover).
  - `.planner-overrides-raw-details` gets a 1px top border so the nested panel is visibly separated from the structured fields.

### Behavior notes

- **Precedence on key conflict**: structured fields fill `render_overrides` first; textarea content (if present) is `Object.assign`ed on top, so a textarea `{"seed": 100}` wins over a structured `seed: 42`. This matches the user's likely intent: structured fields are the curated UX, textarea is the explicit escape hatch.
- **Persistence**: each field's raw input string survives a page refresh via the existing v0.38.0 localStorage stash. The randomize button writes the new value AND persists immediately (no debounce; this is a single-click event the user expects to round-trip across a reload).
- **Empty = no override**: a select left on `(use bundle default)` does NOT send `adetailer_keyframes: false` (which would be an explicit override). Same for the other three fields. This is the "do nothing" state and lets the bundle's `studio_prefs.json` (and the GPU config defaults under it) win.
- **Tests**: no new test cases for `buildRenderOverrides` (it lives in `planner.js`, browser-only; we do not stand up a DOM test pool for the planner JS). The function is small and the contract is exercised end-to-end by every render submit. Total 370/370 unchanged. Typecheck clean.

No backend change. No D1 migration. No cross-repo coordination. Pure frontend.

### Apply

```
npm run deploy
```

## v0.42.1

Inline video player on completed history rows. Any row with `status: "COMPLETED"` and an `output_key` (silent MP4 produced) now renders a `<video controls>` element in the expanded view, sitting between the keyframe strip and the finalize row. Visual order is meta -> stills -> motion -> finalize, so the user can scrub a row from concept to finished movie without leaving the planner page.

### Why

The download MP4 -> open-locally dance was the only way to actually watch a finished render. For a 6-shot 20-second cut that takes 5 seconds to render in the system audio path but 30 seconds of clicking through. Inline play is just an `<video>` tag away, and it pairs naturally with the keyframe strip we already show.

### What

- `public/planner.js`: `buildHistoryRow` gains one block that creates a `.planner-history-player` div containing a `<video>` element when `r.status === "COMPLETED" && r.output_key`. Inserted between the keyframe strip and the finalize row, so the existing collapsed / expanded gating + finalize ordering work unchanged.
- `<video>` config: `preload="metadata"` (do NOT auto-pull the whole MP4 on row expand; only the metadata block needed to render the controls and duration), `controls` (native browser playback chrome), `playsInline` (iOS Safari does not try to go full-screen on play). `src` is the existing `/api/artifact/<output_key>` route; the ownership check there already authorizes the user to their own MP4 via the customMetadata user_email stamp the GPU sets at upload.
- `public/styles.css`: `.planner-history-player` (rounded border + black background so a portrait or aspect-mismatched video stays visually contained), `.planner-history-player-video` (full width, max-height 480px). Gated by the existing `.planner-history-item-collapsed` class so a collapsed row stays one line.

### Behavior notes

- Network: `preload="metadata"` is supported across all current browsers; for very large MP4s some browsers fall back to fetching the first chunk anyway. Worst case the player triggers a short range request when the row expands. The download button (when `output_key` is present) still works for the actual offline copy.
- Mobile: `playsInline` keeps playback in the row instead of taking over the screen. Tap-to-play is the user's choice; we never autoplay.
- Failure path: a 403 or 404 from `/api/artifact` shows the browser's native broken-video icon inside the player frame. The download button under the actions row also fails the same way, so the player is consistent with the rest of the row.

No backend change. No D1 change. No cross-repo change. Tests 370/370 unchanged. Typecheck clean.

### Apply

```
npm run deploy
```

## v0.42.0

Lock + finalize. Completes the per-shot loop: preview keyframes (v0.40.0), regen the bad ones (v0.41.0), lock the good ones, then click finalize to run Wan I2V + assemble the silent MP4 over every keyframe on the volume.

### Why

v0.40-v0.41 let the user iterate on keyframes individually but had no terminal step. The only path from a keyframes-only preview to a finished movie was "submit a fresh full render," which re-runs SDXL on every shot and burns 30+ minutes losing any per-shot regen work. Finalize uses the keyframes already on the GPU volume as Wan I2V init images, skipping SDXL gen entirely; on `final` tier it takes about 20 to 30 minutes for a typical 6-shot storyboard.

Lock state is metadata-only in v0.42.0. The UI lets the user click a `lock` pin on each keyframe to mark it as approved; the locked set is persisted to the renders row via PATCH so it survives across sessions. v0.42.0 does NOT pass the locked set to the GPU at finalize time, and the GPU runs Wan I2V over every shot regardless. A future commit may make the lock state actually gate selective rendering (skip / keep per shot).

### Cross-repo coordination

Needs **vivijure-serverless 0.4.4** on the RunPod endpoint.

GPU side adds a new `action: "finalize"` dispatch in rp_handler:

- `orchestrator.finalize(name, *, quality_tier, overrides, on_log)` sets `core.set_render_phase(name, "i2v_only")`, calls `_render_worker_body` (the existing render loop reads `_i2v_only_render(project)` per scene and reuses `clips/<sid>_keyframe.png` from disk instead of regenerating), then `studio_service.export_film` for assembly. Returns `{train, export, mode: "finalized"}`.
- `_handle_finalize` in rp_handler pulls the bundle (idempotent; the project state on the volume from the preview pass is preserved), runs `orchestrator.finalize`, uploads the silent MP4 + state tarball + keyframes (re-uploaded to the finalize job's own R2 key shape so the new row's `keyframes_json` references its own job id, not the preview's).
- The render and regen_shot branches are untouched. Pre-0.4.4 GPU endpoints reject the new action with `unknown action 'finalize'`; the Worker surfaces the 502 as a clear error.

### Worker

- `migrate-v0.42.0.sql` + `schema.sql`: new `locked_shots_json TEXT` column on `renders`. NULL means "nothing locked"; otherwise a JSON array of shot_id strings. Idempotency caveat: SQLite ALTER ADD COLUMN raises "duplicate column" on re-run; wrangler treats it as a warning.
- `src/renders-db.ts`: `RenderRow.mode` widened to `"full" | "keyframes-only" | "finalized"`. `RenderRow.locked_shots: string[] | null` added. `normalizeLockedShots(raw)` pure helper validates each entry (string, 1-80 chars, deduped, capped at 200) and is exported for the route's PATCH validation. `setRenderLockedShots(env, id, userEmail, lockedShots)` mirrors `setRenderLabel`. The row normalizer parses the JSON column back, dropping malformed entries silently.
- `src/runpod-submit.ts`: `FinalizeArgs` + `FinalizeJobInput` types, pure `buildFinalizePayload(args)` builder, `submitFinalizeJob(env, args)` dispatcher mirroring `submitRenderJob`'s contract.
- `src/index.ts`:
  - `handleRenderRowPatch` (existing label PATCH) extends to also accept `lockedShots`. Either field may be present alone or together; missing fields are not touched. Empty array clears the column. Validates the array (400 if not), normalizes via `normalizeLockedShots`, calls `setRenderLockedShots`. Response echoes the row's current `label` + `lockedShots`.
  - New `POST /api/storyboard/renders/<id>/finalize` route. Same ownership pattern as the other `/renders/<id>/*` routes (404 on miss-or-not-owned). Requires `row.status === "COMPLETED"` and `row.mode === "keyframes-only"` (400 otherwise; finalize is only meaningful from a preview). Submits via `submitFinalizeJob`, inserts a NEW history row for the finalize job at submit time with `mode: "full"`; the GPU envelope's `mode: "finalized"` lands via `updateRenderFromView` on the COMPLETED poll. Returns the new jobId + `parentId: <preview id>`.

### UI

- `public/planner.js`:
  - Each keyframe wrap (v0.41.0) now also gets a `lock` button next to the `regen` button. The button text is `lock` when unlocked, `locked` (with accent-tinted styling) when locked. Click flips the state optimistically and PATCHes the row's `lockedShots`. On PATCH failure the toggle is reverted with an alert.
  - `toggleShotLock(row, shotId, btnEl)` handles the optimistic flip + PATCH round-trip. Mutates `row.locked_shots` in place so subsequent re-renders see the new value. Refreshes the finalize-row summary text in place so the "N of M shots locked" count updates without an auto-refresh wait.
  - Completed keyframes-only rows get a finalize affordance beneath the keyframe strip. The row shows "N of M shots locked" on the left and a primary `finalize (Wan I2V + assemble)` button on the right. Click prompts for confirmation (warns about the 20-30 min duration + that v0.42.0 ignores lock state at finalize), POSTs to the new route, and reloads the history list so the new in-flight row appears next to its preview parent.
- `public/styles.css`:
  - `.planner-history-keyframe-lock` + `.planner-history-keyframe-lock-on` (chip sister to regen; accent-tinted when locked).
  - `.planner-history-finalize-row` (subtle accent background, flex space-between), `.planner-history-finalize-summary` (dim left text), `.planner-history-finalize-btn` (primary accent button).
  - Finalize row is gated by the existing `.planner-history-item-collapsed` class so collapsed rows stay one line.

### Tests

- `tests/runpod-submit.test.ts`: 6 new cases under `buildFinalizePayload (v0.42.0)` describe block (canonical shape, qualityTier default + explicit, render_overrides pass-through, user_email present / missing / empty, action always 'finalize').
- `tests/renders-db.test.ts`: 7 new cases on `normalizeLockedShots` (non-array, canonical array, trim + drop empties, drop wrong-type + over-length entries, dedupe preserves order, MAX_LOCKED_SHOTS cap).

Total 370 (357 prior + 13 new). Typecheck clean.

### Apply

```
wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.42.0.sql
npm run deploy
```

Then push vivijure-serverless 0.4.4 (Jenkins auto-builds on the version-bump commit subject) and bump the RunPod endpoint to the new tag.

## v0.41.1

In-flight regen jobs survive a page refresh. `historyState.regenJobs` is now serialized into the existing localStorage stash on every `.set()` / `.delete()`, and `restorePersistedState()` rehydrates the Map + resumes polling for each surviving entry. The button comes back disabled with `regen...`, the thumbnail with its warn-tinted outline, and the poll picks up from wherever the GPU job is at without the user noticing the reload happened.

### Why

v0.41.0 shipped per-shot regen but kept the in-flight state in memory only. A reload between submit and the COMPLETED poll stranded the regen: the button was reset, the polling was lost, and the thumbnail never refreshed. The user would have to manually click `regen` again on a job that was probably going to finish on its own anyway. This commit closes that loop with the same persistence machinery v0.38.0 already uses for the rest of the form state.

### What

- `collectRegenJobs()` (new, pure): `Array.from(historyState.regenJobs.entries())`. Map -> array of `[key, value]` pairs so JSON.stringify round-trips it cleanly. Added to `savePersistedState`'s snapshot.
- `restoreRegenJobs(saved)` (new): rebuilds the Map from the persisted entries, dropping malformed entries silently (defensive: a corrupted stash shouldn't crash startup). Each surviving entry triggers `pollRegenJob(key)` to resume the poll loop.
- Age cap: `REGEN_RESTORE_MAX_AGE_MS = 6h`. Entries with a `startedAt` older than the cap are dropped on restore (matches roughly the longest plausible regen wall-clock; a regen specifically should be a 30-60s operation, so anything older is almost certainly abandoned or hit RunPod's 24h job TTL). The user can re-click `regen` if they really want to restart a stale one.
- `regenShot()` calls `savePersistedState()` immediately after the `regenJobs.set()` (skipping the debounce; this is a low-frequency event and we want it durable before the poll's first tick).
- `pollRegenJob()` calls `savePersistedState()` immediately after the `regenJobs.delete()` on terminal status so a reload mid-tick does not re-poll a finished job.

No GPU side change. No Worker side change. Pure frontend persistence. Tests 357/357 (same as v0.41.0; the new persistence code is exercised through the existing regen flow, no dedicated unit tests since it touches `localStorage` and the polling fetch).

### Apply

```
npm run deploy
```

## v0.41.0

Per-shot SDXL keyframe regeneration. Each thumbnail in the history-row keyframe strip gains a `regen` button (visible only when the row is COMPLETED and has a bundle_key). Click -> confirm -> POST submits a regen job to the vivijure-serverless GPU (0.4.3+), which clears just that shot's keyframe, re-runs SDXL with the existing trained LoRA on the volume, and overwrites the same R2 key the planner already has in D1. The UI polls the job and cache-busts the thumbnail src on COMPLETED so the user sees the new pixels in place. No new R2 keys, no new D1 rows; the originating render's row keeps its existing `keyframes_json` array.

### Why

v0.40.0 shipped the keyframes-only preview pass, letting the user see SDXL output before committing to motion + assembly. But a user looking at a strip of 6 keyframes and seeing one bad shot still has no surgical fix; they have to re-render everything. This commit closes that loop: regen the one bad shot in 30 to 60 seconds, leave the other 5 untouched. The per-shot lock + finalize-from-locked-keyframes flow (v0.42.0) builds on this; the lock concept maps cleanly onto "shots whose regen button you DID NOT press."

### Cross-repo coordination

Needs **vivijure-serverless 0.4.3** on the RunPod endpoint. The GPU-side change:

- `rp_handler.handler` dispatches by `action` (default `render`, new `regen_shot`). The render path is byte-identical to 0.4.2; only jobs that pass `action: "regen_shot"` enter the new branch.
- `rp_handler._handle_regen_shot` pulls the bundle (download_and_extract is idempotent and preserves prior clips + keyframes for other shots), calls `orchestrator.regen_shot(name, shot_id)`, then re-uploads the produced PNG to the SAME R2 key the original render produced. The key shape (`renders/<project>/<parent_job_id>/keyframes/<shot_id>.png`) is reconstructed from the inbound `parent_job_id` so it matches what skyphusion has in D1 verbatim.
- `orchestrator.regen_shot` resolves the scene_index by scanning the manifest for a matching `id`, ensures the manifest exists (building it from storyboard.yaml if a fresh worker has never rendered the project), calls the existing `core.regen_scene_keyframe(project, scene_index)` (which itself calls `clear_scene_output` then `_ensure_scene_keyframe`), and verifies the PNG landed on disk. Raises RuntimeError on any failure; rp_handler catches and surfaces it as `error` on the envelope.

Pre-0.4.3 GPU endpoints will reject the new action with `unknown action 'regen_shot'`. The Worker translates the RunPod 502 into a 502 with a clear error string so the planner UI can show it.

### Worker

- `src/runpod-submit.ts`: new `RegenShotArgs` + `RegenShotJobInput` types, pure `buildRegenShotPayload(args)` builder, dispatcher `submitRegenShotJob(env, args)` mirroring `submitRenderJob`'s contract (never throws on HTTP errors).
- `src/index.ts`: new `POST /api/storyboard/renders/<id>/regen-shot` route. Same ownership pattern as the PATCH route (404 on miss-or-not-owned so a guessed id cannot enumerate other users' rows). Validates `shotId` is a non-empty string, validates it is one of the row's known keyframes (the `keyframes_json` array), then submits via `submitRegenShotJob`. Returns `{ ok: true, jobId, status, statusRaw, parentId, shotId, user }`. No new D1 row is inserted; the regen is a sub-action of the existing row, not a separate render.

### UI

- `public/planner.js`:
  - `historyState.regenJobs` Map tracks in-flight regen state keyed by `<rowId>:<shotId>`. Survives row re-renders on the 30s auto-refresh: `buildHistoryRow` checks the Map and renders the regen button as `regen...` + disabled when an active job is found.
  - `buildHistoryRow` now wraps each keyframe anchor in a `.planner-history-keyframe-wrap` and appends a `regen` button. Button visibility is gated on `r.status === "COMPLETED" && r.bundle_key` so in-flight or bundle-less rows omit it.
  - New `regenShot(row, kf, btnEl, imgEl)` submits the POST, parks state in `regenJobs`, kicks off `pollRegenJob(regenKey)`.
  - `pollRegenJob` hits the existing `GET /api/storyboard/render/<jobId>` route every 4s. On COMPLETED, re-queries the DOM via `querySelector` (NOT the stored refs, which may be stale after a row re-render), cache-busts the `<img>` src with `?v=<now>`, restores the button, and clears the Map entry. On any other terminal status (FAILED, CANCELLED, TIMED_OUT) it restores the button and surfaces the error via `window.alert`.
  - Minimal `cssEscape` helper for the dataset-attribute selectors (CSS.escape is widely supported but worth not crashing the loop on older agents).
- `public/styles.css`: `.planner-history-keyframe-wrap` (flex column so the regen button sits beneath the thumbnail at the same width), `.planner-history-keyframe-regen` (small monospace pill, dim default, accent on hover, progress cursor when disabled), `.planner-history-keyframe-img-regen-pending` (0.55 opacity + warn-tinted outline so the user sees which shot is regenerating).

### Tests

`tests/runpod-submit.test.ts` gets 4 new cases under a `buildRegenShotPayload (v0.41.0)` describe block:

- Canonical input shape
- `user_email` included when set, omitted when missing or empty
- `action: "regen_shot"` is always present

Total 357 (353 prior + 4 new). Typecheck clean. No D1 migration; the regen flow uses existing columns and reuses the existing render-poll route.

### Apply

```
npm run deploy
```

Then push vivijure-serverless 0.4.3 to RunPod (Jenkins auto-builds on the `vivijure-serverless 0.4.3:` commit subject).

## v0.40.0

Keyframes-only preview pass. Render-stage gets a `[ ] render keyframes only (preview before generating motion)` checkbox. When set, the job submits with `keyframes_only: true` merged into `render_overrides`, the GPU side (vivijure-serverless 0.4.2+) skips Wan I2V and silent-MP4 assembly after the SDXL pass, and the COMPLETED envelope returns `mode: "keyframes-only"` with `output_key: null` plus the populated `keyframes` array. The history row shows a `kf only` badge in the meta line and the download MP4 button stays hidden (no MP4 to download).

### Why

A final-tier full render is 30+ minutes per job. The user has no way to see SDXL output until everything has run, so a bad anchor or off-prompt look costs the whole pipeline. With the preview pass they can submit, see thumbnails, decide if the keyframes are good, then commit to motion + assembly with a separate job. v0.40.0 ships the preview path; per-shot regenerate (v0.41.0) and finalize-from-locked (v0.42.0) build on top.

### Cross-repo coordination

Needs **vivijure-serverless 0.4.2** on the RunPod endpoint. The GPU-side change is in two files:

- `orchestrator.run_project` reads `keyframes_only` from `overrides`, logs `Stage 2/2` instead of `Stage 2/3`, skips `export_film`, and counts keyframes on disk instead of clips for the success check.
- `rp_handler.handler` returns `output_key: None` + `seconds: None` + `has_audio: False` for keyframes-only runs, and surfaces `mode: "keyframes-only"` on the envelope.

Pre-0.4.2 GPU endpoints will ignore the `keyframes_only` payload field and run the full pipeline, so a user who unintentionally checks the box on an old endpoint still gets a complete render (just slower than the preview was supposed to be).

### Worker

- `migrate-v0.40.0.sql` + `schema.sql`: new `mode TEXT` column on `renders`. Legacy rows stay NULL; the row normalizer collapses NULL to `"full"` so callers can treat the field as non-null. Same idempotency caveat as the v0.36/v0.39 ALTERs.
- `src/renders-db.ts`: `NewRenderRow.mode` optional ("full" | "keyframes-only"; defaults "full" when omitted). `RenderRow.mode` always present. `insertRender` writes the column at submit time. `updateRenderFromView` extracts `output.mode` from the GPU envelope and writes through `COALESCE(?, mode)` so re-polls stay idempotent and a missing-mode poll (e.g. from a pre-0.4.2 GPU) does not blank the column.
- `src/runpod-submit.ts`: `RenderSubmitArgs.keyframesOnly?: boolean`. `buildSubmitPayload` merges into `render_overrides.keyframes_only=true`; a `render_overrides.keyframes_only` already supplied via the freeform overrides textarea wins so a power-user override is never silently dropped.
- `src/index.ts`: `handleRenderSubmit` validates `keyframesOnly` is a boolean (400 if not), threads it through to `submitRenderJob`, and stores `mode: "keyframes-only" | "full"` on the new D1 row at submit time. The mode column gets a value before the GPU envelope echoes one back, so the history list can render the badge immediately on the in-flight row.

### UI

- `public/planner.html`: new `<input id="planner-keyframes-only" type="checkbox" />` under the quality-tier select.
- `public/planner.js`: render submit reads the checkbox and includes `keyframesOnly: true` in the request body. The checkbox value is persisted in localStorage alongside the rest of the render-stage form state (extends `collectRenderStageState` + `restoreRenderStagePanel`). `buildHistoryRow` adds a `kf only` badge in the meta line when `r.mode === "keyframes-only"`. The download MP4 button is already gated on `r.output_key` so it stays hidden for keyframes-only rows without an extra check.
- `public/styles.css`: `.planner-history-mode` + `.planner-history-mode-keyframes-only` (warn-tinted background, matches the visual weight of `.planner-history-tier`). `.planner-field-check` for the inline checkbox row.

### Tests

`tests/runpod-submit.test.ts` gets 4 new cases:

- `keyframesOnly: true` merges to `render_overrides.keyframes_only: true`
- A pre-existing `render_overrides.keyframes_only: false` wins over `keyframesOnly: true`
- `keyframesOnly: true` merges alongside other overrides without dropping them
- `keyframesOnly: false` / undefined leaves `render_overrides` undefined

Total 353 (349 prior + 4 new). Typecheck clean.

### Apply

```
wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.40.0.sql
npm run deploy
```

Then build + push vivijure-serverless 0.4.2 to the RunPod endpoint.

## v0.39.1

Separate R2 binding for storyboard / render artifacts (`R2_RENDERS`). Fixes the 404 on `/api/artifact/renders/...` and `/api/artifact/bundles/...` URLs: the GPU side writes to its own R2 bucket (default `vivijure` per the vivijure-serverless docs), the Worker was only bound to the chat-side bucket (`skyphusion-llm`), so even when D1 had the right key the lookup hit the wrong bucket and returned 404.

### Why

v0.39.0 wired the keyframes column and the planner UI, but the Worker still served every `/api/artifact` GET through the chat bucket. The render history list showed thumbnails the browser then 404'd on, the silent MP4 download link was dead, and the bundle assembler had also been writing bundles into the chat bucket where the GPU could not reach them (the user worked around it by manual bundle staging into `vivijure` and submitting via the "use bundle key..." path; that workaround should no longer be needed).

The chat side of R2 stays on the existing binding so nothing in `/api/chat` / attachments / generated images / ZIP exports changes.

### Routing rule

Pure prefix matcher, lives in `src/r2-routing.ts`:

| Prefix | Bucket | What it is |
|---|---|---|
| `renders/` | `R2_RENDERS` | silent MP4 + SDXL keyframes the GPU writes |
| `bundles/` | `R2_RENDERS` | assembled project bundles the Worker stages, the GPU pulls |
| `projects/` | `R2_RENDERS` | per-project state tarball the GPU writes at COMPLETED |
| `character-refs/` | `R2_RENDERS` | character ref images staged from the planner UI |
| anything else | `R2` | chat input + output artifacts (`in/`, `out/`, `zip/`, ...) |

### Behavior changes

- **`POST /api/storyboard/character-ref`** now writes to `R2_RENDERS` under a `character-refs/<uuid>.<ext>` prefix instead of the chat-shared `in/<uuid>` prefix. A client that staged refs against v0.39.0 will need to re-upload them; the old keys reference the wrong bucket and return 404 from the bundle assembler. (No production data depends on this; the rename is for visual / operational clarity in the R2 dashboard.)
- **`POST /api/storyboard/bundle`** writes the bundle to `R2_RENDERS`. The GPU side already reads from this bucket (`R2_BUCKET=vivijure` matches `bucket_name = "vivijure"`); no GPU-side change needed.
- **`DELETE /api/storyboard/renders/<id>?artifact=true`** now deletes the silent MP4 from `R2_RENDERS` instead of the chat bucket (where the object never existed; the delete was a silent no-op).
- **`GET /api/artifact/<key>`** routes by prefix. Storyboard keys go to `R2_RENDERS`; chat keys stay on `R2`. Ownership check (`customMetadata.user_email === userEmail`) is unchanged; a renders bucket object uploaded by a pre-0.4.0 GPU worker (no `user_email` stamped) will 403 even after this fix. Either re-render with vivijure-serverless 0.4.0+ (which stamps the metadata) or set the customMetadata manually.

### Files

- `wrangler.toml`, `wrangler.example.toml`: second `[[r2_buckets]]` for `R2_RENDERS`. The real config points it at `vivijure`; the example points at `skyphusion-llm-renders` (a fresh bucket name to avoid collisions in a new deployment).
- `src/env.ts`: `R2_RENDERS: R2Bucket` added.
- `src/r2-routing.ts` (new): `isRendersKey(key)` pure helper.
- `src/index.ts`: `r2RendersPut` helper for character-ref uploads; `pickArtifactBucket(env, key)` selector; `handleArtifact` / `handleCharacterRefUpload` / `handleRenderRowDelete` updated.
- `src/bundle-assembler.ts`: `resolveImage`'s `env.R2.get` and the final `env.R2.put` of the bundle both moved to `env.R2_RENDERS`.
- `tests/renders-bucket.test.ts` (new): 4 cases covering prefix anchoring, empty input, partial matches.
- `tests/bundle-assembler.test.ts`: stub env now exposes `R2_RENDERS` instead of `R2` so a regression that re-introduces an `env.R2` call surfaces immediately.

Tests 349/349 (345 prior + 4 new). Typecheck clean. Migration: only redeploy, no D1 change, no R2 data migration; existing renders rows in D1 keep working because their keys were always storyboard-prefixed and now resolve to the right bucket. Pre-existing chat artifacts in `R2` keep working because the matcher leaves their prefixes alone.

## v0.39.0

SDXL keyframe thumbnails on completed history rows. The GPU side (vivijure-serverless 0.4.0+) uploads each scene's keyframe PNG to R2 at COMPLETED, returns the list in its job-output envelope, and the Worker mirrors them on the renders row as a JSON column. When the user expands a row that has keyframes, the planner shows a horizontal thumbnail strip below the action buttons, one thumb per shot, each opening the full PNG via /api/artifact in a new tab.

### Why

The render history at v0.38.x identifies each row by project + label + tier + status, but with no visual cue. Two renders of "cherry" look identical in the list even when they produced very different storyboards. Thumbnails let the user scan the list by content, not by metadata. This is also the first step toward the studio-mode preview + regen + lock workflow (planned v0.41-v0.42), where the user needs to see keyframes before deciding which shots to redo.

### Cross-repo coordination

The GPU side (vivijure-serverless) needed two changes to unlock this on the Worker:

- Accept `user_email` in the job input and stamp it as `x-amz-meta-user_email` on every R2 upload it produces (silent MP4, state.tar.gz, and now keyframes). The Worker's `/api/artifact` route authorizes by reading that header, so pre-0.4.0 jobs (which omitted the metadata) produced artifacts the route returns 403 on. With 0.4.0 + this Worker change, every artifact a render produces is fetchable by the submitter via the existing ownership-checked route, including the silent MP4 download that v0.34.0 first wired.
- After `assemble.py` finishes, walk the manifest's scene list, upload `clips/<sid>_keyframe.png` to `renders/<project>/<jobId>/keyframes/<sid>.png` for each scene that has one on disk, and return `keyframes: [{shot_id, key}, ...]` in the output envelope. Job-id-scoped so re-renders of the same project never overwrite an earlier job's thumbs. Best-effort: keyframe upload failures log via `progress_update` but never fail the otherwise-complete render.

### Worker (this repo)

- `schema.sql`: add `keyframes_json TEXT` to `renders`.
- `migrate-v0.39.0.sql`: `ALTER TABLE renders ADD COLUMN keyframes_json TEXT;`. Same idempotency caveat as `migrate-v0.36.0.sql` (re-run surfaces "duplicate column" as a non-fatal warning).
- `src/renders-db.ts`: new `KeyframeRef` type. `RenderRow` gains a parsed `keyframes` field. `normalizeKeyframes(raw)` exported pure helper validates each entry's `shot_id` + `key`, drops anything malformed, tolerates extra fields. `updateRenderFromView` pulls the `keyframes` array out of the GPU envelope and writes it through `COALESCE(?, keyframes_json)` so a re-poll that returns the same envelope re-writes the same content (idempotent), but a poll that loses the field (older GPU side) does not blank it out. SELECT lists, the row normalizer, and the row-by-id getter all include `keyframes_json` and decode it back.
- `src/runpod-submit.ts`: `RenderSubmitArgs.userEmail` + `RenderJobInput.user_email`. `buildSubmitPayload` propagates it through. Empty / undefined drops the field entirely so a pre-0.39.0 GPU receives the same shape it did before.
- `src/index.ts`: `handleRenderSubmit` passes `userEmail` (already pulled from `cf-access-authenticated-user-email`) into the submit args.
- `public/planner.js`: `buildHistoryRow` appends a `.planner-history-keyframes` strip when `r.keyframes` is a non-empty array. Each thumb is an anchor wrapping an `<img loading="lazy">` plus a monospace caption with the shot id; clicking opens the full PNG. CSS gates the strip the same way the sub line and action row are gated by `-collapsed`.
- `public/styles.css`: `.planner-history-keyframes` horizontal scroller, `.planner-history-keyframe` thumb chip with hover accent, fixed 96x54 image (16:9 cover crop so mixed aspects align).
- `tests/renders-db.test.ts`: new file. `normalizeKeyframes` covered for the wire-shape contract: canonical entries, missing fields, wrong-type fields, extra fields, null/non-object entries, non-array input.
- `tests/runpod-submit.test.ts`: three new cases for `buildSubmitPayload.userEmail`.

### Apply

```
wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.39.0.sql
npm run deploy
```

Then build + push vivijure-serverless 0.4.0 to the RunPod endpoint. Pre-0.4.0 endpoints still work; their renders just produce no thumbnails (the field stays NULL on the row, the UI omits the strip).

Tests 345/345 (335 prior + 10 new). Typecheck clean.

## v0.38.1

History rows collapse / expand. Every row starts collapsed for a scannable list; clicking the meta bar toggles expand. The collapsed bar shows project + tier + status + (if set) an inline italic label preview; the expanded view reveals the editable label input, the timestamps line, and the action buttons (view, download, re-render, delete). Frontend-only.

### Why

The history list at v0.37.1 + v0.37.x renders 4 lines per row (meta + label input + sub line + actions). At 5 rows that fills a screen; at 20 rows the list is a wall. The v0.36.0 labels gave each row a readable identity but reading the identity still required scrolling past the noise. Collapsing terminal rows by default lets you see 4x more renders per screen of vertical real estate, with the label preview ensuring you can still scan for "cherry-final-take1" without expanding.

### Behavior

- Default state on every page load: all rows collapsed. Toggle state is per-session (not persisted), so a refresh resets the view back to the scannable baseline.
- Click the meta bar (or Enter / Space when focused) to expand. Click again to collapse.
- Chevron updates in place: `▶` when collapsed, `▼` when expanded. `aria-expanded` updates so screen readers track state.
- Hover lifts the meta bar slightly with a 2% white tint on the bg-elev tone so it's visibly clickable.
- Label preview appears inline in the meta bar (italic, dimmed, monospace, in quotes) ONLY when collapsed. When expanded, the editable input takes over and the preview hides.
- Action buttons sit below the label input, so clicking them never bubbles up to the toggle handler. The editable label input is also outside the toggle target so clicking inside the input never collapses the row.
- Auto-refresh (v0.35.2) interaction: each 30s refresh re-renders the list from `historyState.rows`. User-toggled `expandedIds` survive the re-render because we read state from the set in `buildHistoryRow` before applying classes.

### Code

- `public/planner.js`: `historyState.expandedIds` Set added (per-session, not persisted). `buildHistoryRow` now starts each row in `.planner-history-item-collapsed` unless the id is in the Set, adds a chevron + inline label preview to the meta bar, wires a click + keydown handler on the meta bar to call `toggleHistoryRowExpand(id, liEl)`. New `toggleHistoryRowExpand` updates the chevron text, the `aria-expanded` attribute, and the collapse class.
- `public/styles.css`: `.planner-history-meta` becomes a clickable region with hover state. `.planner-history-chevron` and `.planner-history-label-preview` styles added. Two collapse / expand visibility rules toggle the label input, sub line, actions, and preview based on the parent's `.planner-history-item-collapsed` class.
- `package.json`: 0.38.0 -> 0.38.1.

No backend change. Tests / typecheck unchanged. Tests 335/335. PATCH per the convention: UI polish follow-through on the history list; no new endpoint, no new module.

## v0.38.0

`localStorage` form-state persistence on `/planner.html`. Every meaningful state-changing event (brief edit, cast field change, model picker change, plan success, image upload completion, bundle assembly, render submit, filter toggle, render overrides edit, quality tier change) snapshots to localStorage under `skyphusion.planner.state.v1`. On page load, `restorePersistedState()` rebuilds the plan, bundle, and render panels and reattaches a live SSE stream to in-flight renders. Tab close no longer eats the user's work. Frontend-only.

### Why

The pipeline at v0.37.1 had a load-bearing hole: an accidental tab close after writing a 500-word brief, uploading 24 character refs (~50 MB), validating a storyboard, and submitting a render lost everything except the row in the D1 history. The user had to redo the plan ($ tokens), re-upload (50 MB), and click "view" on the right history row to get back to the render they were watching. This commit closes that hole entirely: open the page, see your work, click render.

### What gets persisted

- **Plan form**: model id, brief textarea contents, four cast rows (checked + name + bible per slot).
- **Plan result**: validated `StoryboardValidated` JSON + the bundle-ready YAML string + the cast at plan-time. Restoring shows the JSON / YAML panel in `(restored from previous session)` state without re-running the model call.
- **Bundle stage**: per-slot upload entries (filename, size, mime, R2 key, status), the assembled `bundleKey`. On restore, "uploading"-status entries are filtered out (the upload was interrupted by the reload; the bytes never landed); "done" entries hydrate the file list with their R2 keys preserved so the bundle can assemble without re-upload.
- **Render stage**: jobId, bundleKey, qualityTier, renderOverrides textarea, currentProject + currentLabel (for notifications), last-known status. Restoring with a non-terminal jobId calls `resumeRender(synthetic row)` which reattaches the SSE stream.
- **History filters**: v0.37.1's text + three checkboxes. Restored before the first `loadHistory()` so the initial render uses the saved view.

### What is NOT persisted

- Live SSE / poll timers (browser GC handles them on tab close; reload reattaches via `resumeRender` if the render is still in flight).
- Validation errors (transient by design; re-running plan refreshes them).
- Notification permission state (the browser already persists this).
- Notification `alreadyNotified` set (per-session; a reload IS a new session, so a render that finished while the tab was closed will fire its terminal notification on first poll/stream event after reload).
- Modal / dialog visibility (always computed from state).

### Edge cases handled

- **Quota exceeded** (`localStorage` full): `savePersistedState` catches, logs, and silently no-ops. The planner still works; just no persistence until next reload.
- **Corrupted stash** (JSON.parse fails): `loadPersistedState` clears the key and returns null. Next save replaces it.
- **Interrupted uploads** on reload: filtered out so the user sees only the entries whose R2 ingest completed. Re-add the missing files; the existing keys are intact.
- **Stale render row** (D1 row deleted, but localStorage still has jobId): `resumeRender` polls RunPod directly, not D1, so the status still streams. The row simply doesn't appear in the history list.
- **R2 bundle key now invalid**: render submit returns the GPU side's error; user can re-bundle. Detection at the render call, not on restore.
- **Async data races**: model picker value restored after `loadModels()` resolves (the picker has no options until then); history filter checkboxes restored before `loadHistory()` so the first render uses the saved filter set.

### Code

- `public/planner.js`: ~880 -> ~1180 lines. New module-level constants `STORAGE_KEY` and `PERSIST_DEBOUNCE_MS`. New section with `savePersistedState`, `persistSoon` (500ms debounce), `loadPersistedState`, four `collect*State` snapshotters, four `restore*` rebuilders, and `restorePersistedState` orchestrator. `showBundleStage` signature gains an optional `initialUploads` param so restoration can pre-populate the per-slot file list without going through `handleSlotFiles`. Save calls added at the touchpoints: cast field change listeners, brief input, model change, plan success, upload completion, bundle assembly, render submit, filter changes, override / tier edits. Restoration wired in `DOMContentLoaded` ahead of the async loaders.
- `package.json`: 0.37.1 -> 0.38.0.

No backend change. Tests / typecheck unchanged (pure browser API code). Tests 335/335. MINOR per the convention: substantial new capability with real UX impact.

## v0.37.1

Filter + search on the history list. A small filter bar above the render rows: text input matches `project` and `label` substring (case-insensitive), three checkboxes gate the status buckets (in-flight / done / failed), and a counter on the right reads `12 renders` when everything is visible or `showing 3 of 12` when filtered. All client-side over the already-loaded rows; no fetch on filter change. Frontend-only addition.

### Why

Once the history list passes ~12 rows of "cherry, cherry, cherry, cherry-final-take1, cherry-blue-dress..." scrolling to find the one you want gets old. The text filter is the fastest path to "cherry-blue-dress"; the status buckets compress the list to just the in-flight queue or just the failures you need to inspect. Filtering does not refetch (the row data is already in memory from the last `loadHistory`), so checkbox toggles and keystrokes are O(rows) in pure JS.

### Filter rules

- **text**: case-insensitive substring match on `project` OR `label`. Empty string matches everything.
- **in-flight** (default on): rows with `status` in `{IN_QUEUE, IN_PROGRESS}`.
- **done** (default on): rows with `status === "COMPLETED"`.
- **failed** (default on): rows with `status` in `{FAILED, CANCELLED, TIMED_OUT}`.
- Defaults mean a fresh page load shows everything, same as before.
- Filters are session-state; reload clears them. localStorage persistence is a future commit (would overlap with the broader form-state persistence option still on the menu).

### Counter copy

- All visible: `12 renders` (singular when 1: `1 render`).
- Filtered: `showing 3 of 12`.
- Empty: counter cleared, section hidden (same as before).
- Filtered to zero: `showing 0 of 12` + a dashed-border "no renders match the current filters" placeholder where the list would be, so the user can clear filters without the section disappearing.

### Code

- `public/planner.html`: `<div class="planner-history-filters">` above the list. Text input + three checkboxes (each checked by default) + counter span.
- `public/planner.js`: new `historyState` module-level object holding `rows` (last fetch result) and `filters` (the four current settings). `loadHistory` now stores rows in `historyState.rows` and calls `applyHistoryFilters()`; that function runs the pure `filterRows` and calls `renderHistoryList(filtered, totalRows)`. `renderHistoryList` signature gains `totalRows` for the counter. Filter inputs wired to update `historyState.filters` and call `applyHistoryFilters()` (no fetch). `maybeScheduleHistoryRefresh` continues to receive the full row set (not the filtered subset) so auto-refresh fires based on real in-flight state.
- `public/styles.css`: `.planner-history-filters`, `#planner-history-search`, `.planner-history-filter-check`, `.planner-history-counter`, `.planner-history-empty` styles appended. Reuses existing CSS tokens; the bar wraps on narrow viewports thanks to `flex-wrap`.
- `package.json`: 0.37.0 -> 0.37.1.

No backend change. Tests / typecheck unchanged. Tests 335/335.

## v0.37.0

Browser notifications when a render reaches a terminal status. Permission asked once at first-submit time (not on page load); subsequent renders auto-notify. Title carries the row's label / project so a glance at the OS notification tells you *which* render finished and how it ended (COMPLETED / FAILED / CANCELLED / TIMED_OUT). Click the notification to focus the planner tab and scroll to the render result. Frontend-only addition.

### Why

Wan renders take 10-30 minutes at `final` tier. The pattern is: submit, wait, switch to something else, eventually remember to check. Pull-the-tab-back-up checks waste attention; OS notifications close the loop properly. The permission prompt is deferred to first-submit so it arrives at the moment its value is most obvious ("you're about to wait 20 minutes; let us ping you?") rather than on page load when users routinely deny anything that asks unprompted.

### Behavior

- On page load, `initNotifications()` reads `Notification.permission`. If `default` (never asked), the "enable notifications" button in the render section header reveals. If `granted` or `denied`, it stays hidden (no nagging).
- The button click calls `Notification.requestPermission()`. On grant, fires a tiny "Notifications enabled" confirmation toast that auto-dismisses after 4 seconds so the user sees the wiring works.
- First time the user clicks "render" in a session, if permission is still `default`, the request fires automatically. Same prompt as the manual toggle; just folded into the natural workflow.
- On a terminal status arriving from the SSE stream OR the poll fallback, `maybeNotifyTerminal(payload)`:
  - `payload.jobId` is deduped via `notifyState.alreadyNotified` (set per session) so a stream re-fire never double-pings.
  - `tag: jobId` on the Notification options gives the OS its own dedupe layer.
  - Title format: `<status-prefix> <status-lowercase>: <identity>` where identity is `renderState.currentLabel || renderState.currentProject || jobId`. Prefixes: ✓ COMPLETED, ✗ FAILED, ○ CANCELLED, ⏱ TIMED_OUT.
  - Body: `job <jobId> · ran <duration>` when `executionTimeMs` is present.
  - Click handler: `window.focus()` plus a smooth scroll to `#planner-render` so the user lands on the result pane.
- `submitRender` sets `renderState.currentProject` from the bundle key slug. `rerunBundle` and `resumeRender` overwrite with the history row's label + project so a resumed in-flight render carries the right identity through to its terminal notification.
- Silently no-op when `Notification` is undefined (unsupported browser) or `permission === "denied"`. Never throws into the SSE handler; permission failures log and proceed.

### Code

- `public/planner.html`: `<button id="planner-notify-toggle">` in the render section header, hidden by default.
- `public/planner.js`: new `notifyState` module-level object holding `permission` and `alreadyNotified`. `renderState` gains `currentProject` and `currentLabel`. New `initNotifications`, `requestNotificationPermission`, and `maybeNotifyTerminal` functions. `submitRender` / `rerunBundle` / `resumeRender` set the identity fields; SSE message handler and `pollRender` terminal branches call `maybeNotifyTerminal`. Wired in `DOMContentLoaded`.
- `public/styles.css`: `.planner-notify-toggle` styles (transparent ghost button, matches existing tokens).
- `package.json`: 0.36.0 -> 0.37.0.

No backend change. Tests / typecheck unchanged: pure HTML / JS / CSS. Tests 335/335. MINOR per the convention: new user-visible capability with permission-flow plumbing.

## v0.36.0

Render labels. New `label TEXT` column on the `renders` table lets each history row carry a free-form user-authored name. `PATCH /api/storyboard/renders/<id>` body `{ label: string | null }` saves it (ownership enforced via `user_email`; 200 char max; empty/null clears). The planner UI exposes an inline-editable input on every history row; click to edit, Enter or blur saves, Escape reverts. So a list of "cherry, cherry, cherry" can become "cherry-final-take1", "cherry-blue-dress", "cherry-seed-424242".

### Migration

```bash
wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.36.0.sql
```

The migration is a single `ALTER TABLE renders ADD COLUMN label TEXT`. SQLite's `ALTER TABLE ADD COLUMN` is NOT idempotent (re-running surfaces "duplicate column name"), but wrangler d1 execute treats it as a non-fatal warning and continues past, same as the v0.20.3 chunks ALTERs. Safe to re-apply.

### Why

Once you cycle through "cherry-final, cherry-final, cherry-final" trying different overrides or quality tiers, the history list becomes useless because every row looks identical. The label gives each render a human-readable identity without changing the project slug (which still drives the bundle key, the artifact path, and the RunPod payload). A label is purely metadata; the renderer never sees it.

### Endpoint

**`PATCH /api/storyboard/renders/<id>`** body `{ label: string | null }`. Returns `{ ok: true, id, label, user }` on success.

- 400 on invalid id (`/api/storyboard/renders/abc`), missing `label` key in body, non-string-non-null `label`, or label longer than 200 chars
- 404 on a not-found-or-not-owned row (ownership check happens via `getRenderByIdForUser` before the UPDATE, same as DELETE)
- 200 on success, with the saved label echoed back so the UI can confirm round-trip without a second GET

Only `label` is patchable today. Other columns would need their own PATCH-field validation; left as a follow-up if it ever matters.

### UI behavior

- Each history row now renders an `<input type="text">` styled as text-by-default (transparent border, italic dimmed placeholder `+ label`). On hover / focus the background and border become visible to signal "click to edit".
- On blur (or Enter) the value is compared to the last server-acknowledged value; if changed, fires a PATCH. Empty / whitespace-only trims to `null` (clears the label). On failure, the input reverts to the last saved value and the error surfaces in a `window.alert`.
- Escape reverts to the last saved value and blurs without firing the network call.
- The 200 char cap is enforced both client-side (`maxLength="200"`) and server-side (the route returns 400 if it slips past). Labels longer than the visible width clip to a 320px max with text-overflow falling on the browser's default.

### Code

- `migrate-v0.36.0.sql`: new. The single `ALTER TABLE renders ADD COLUMN label TEXT`.
- `schema.sql`: append `label TEXT` to the renders CREATE TABLE block so fresh DBs come up with the column.
- `src/renders-db.ts`: add `label: string | null` to the `RenderRow` type and parse from the row in `normalizeRow` (empty string or absent column collapses to `null` so the UI does not need to guard both). New `setRenderLabel(env, id, userEmail, label)` function bumping `updated_at` alongside the label set. SELECT statements in `getRenderByIdForUser` and `listRendersForUser` extended with `label`.
- `src/index.ts`: imports `setRenderLabel`. The existing `/renders/<id>` route regex now matches `PATCH` alongside the existing `DELETE`. New `handleRenderRowPatch` handler in a v0.36.0 section above "Chat (text generation, multimodal in)". Validates body, resolves the row (404 on miss), runs `setRenderLabel`, returns the saved label.
- `public/planner.js`: `buildHistoryRow` appends an `<input>` between the meta line and the sub line via a new `buildHistoryLabelInput(row)`. The input owns its own save dispatcher (PATCH, error handling, optimistic local update). No global state needed.
- `public/styles.css`: `.planner-history-label-input` styles. Reuses existing CSS tokens; behaves as text until focused.
- `package.json`: 0.35.4 -> 0.36.0.

MINOR per the convention: new schema column + new endpoint + new user-visible capability. Typecheck clean; tests 335/335 (D1-touching code not unit-tested in this codebase, matching the v0.34.0 / v0.35.4 pattern).

## v0.35.4

`DELETE /api/storyboard/renders/<id>` removes one render row from D1 history. Optional `?artifact=true` query parameter also drops the silent MP4 from R2 when no other history row references the same `output_key`. Ownership is enforced via `user_email`; non-owners see 404 (indistinguishable from "row does not exist"). The planner UI gains a "delete" button on every history row with a confirmation prompt before any destructive call leaves the page.

### Why

Once a user accumulates a dozen renders the list gets unwieldy. Manual D1 surgery via `wrangler d1 execute` is awkward and bypasses the artifact cleanup. This commit lands the per-row delete cleanly:

- D1 row delete is the primary action; the row is the canonical history record.
- R2 artifact delete is opt-in (`?artifact=true`); the UI sets it when the row has an `output_key`.
- The bundle at `row.bundle_key` is NEVER deleted: re-renders share it by design, and accidentally pruning a bundle would break "re-render" on any other row pointing at it. Bundles can be removed via `wrangler r2 object delete` if the user wants.
- The artifact cleanup is sharing-aware: `countOtherRowsWithOutputKey` checks if any other row references the same `output_key` before issuing the R2 delete. Rp_handler.py writes outputs at `renders/<project>/<filename>`, so a re-render with the same filename overwrites; we never strand a still-referenced artifact.

### Endpoint

**`DELETE /api/storyboard/renders/<id>`** — `id` is the D1 autoincrement PK (the `id` column on the `renders` table, NOT the RunPod `job_id`). 400 on a malformed id (`/api/storyboard/renders/abc` returns "invalid id"); 404 on a not-found-or-not-owned row; 200 on success with `{ ok: true, id, artifactDeleted, artifactSkippedReason, user }`. `artifactSkippedReason` carries a human-readable explanation when `?artifact=true` was set but the R2 delete did not happen (no `output_key`, shared by N other rows, or the R2 call itself failed). A row that vanished between resolve and delete (race condition) is treated as success with a `note: "row was already gone"` because the end state matches the request.

### URL naming

`/api/storyboard/render/<jobId>` (singular, with the RunPod jobId) handles things RunPod knows about: poll, cancel. `/api/storyboard/renders/<id>` (plural, with the D1 row id) handles things only our DB knows about: list, delete. The two endpoints are intentionally distinct so a route handler never has to disambiguate "is this a jobId or a row id".

### UI behavior

- Each history row gains a "delete" button styled with the `--error` token so it stands apart from the existing "view" / "download" / "re-render" actions.
- Click fires a `window.confirm` with copy that depends on whether the row has an `output_key`: with artifact, the prompt mentions "the silent MP4 in R2 if no other row references it"; without, just "delete this render from history?".
- Confirmed: `fetch DELETE` against the route with the artifact query flag, then refresh the history list so the row disappears immediately. The auto-refresh loop (v0.35.2) re-arms from the new state.
- `artifactSkippedReason` on the response is `console.info`'d so a power user inspecting the dev tools sees why a particular file stayed on R2.

### Code

- `src/renders-db.ts`: three new functions exported. `getRenderByIdForUser` resolves a row by PK + user_email; returns null for not-found or not-owned (one query, ownership baked in). `countOtherRowsWithOutputKey` counts rows sharing an `output_key` excluding the current id, used by the artifact-cleanup gate. `deleteRenderRow` runs the DELETE and returns true when a row was actually removed.
- `src/index.ts`: route `DELETE /api/storyboard/renders/<id>` registered next to the existing list endpoint. New `handleRenderRowDelete` handler in a v0.35.4 section above "Chat (text generation, multimodal in)". The handler resolves the row (404 on miss), optionally deletes the R2 artifact gated by the sharing check, then deletes the row.
- `public/planner.js`: `buildHistoryRow` appends a "delete" button to the actions div. `deleteHistoryRow(row)` prompts via `window.confirm`, fires the DELETE, and calls `loadHistory()` on success.
- `public/styles.css`: `.planner-history-action-delete` variant tinted with the `--error` token.
- `package.json`: 0.35.3 -> 0.35.4.

No new binding, no new schema column, no new runtime dep. Tests / typecheck unchanged: D1 paths are not unit-tested in this codebase (matches the existing pattern for D1-heavy code). Tests 335/335.

## v0.35.3

`renderOverrides` JSON textarea in the render stage on `/planner.html`. Collapsible `<details>` wrapper labeled "render overrides (advanced, optional)"; empty by default. Submit parses as JSON object on the way out, errors stay in the panel without leaving the stage. Re-render from history pre-fills the textarea from the row's stored `render_overrides` and opens the details so the user sees we are carrying overrides forward. Frontend-only.

### Why

The submit route accepted `renderOverrides` (`{[k]: unknown}` merged into rp_handler.py's render payload at the GPU side) since v0.32.0, but the planner UI had no way to set them. Power users curl'd them in; everyone else got the bundle's defaults. Now you can tweak per-shot Wan or SDXL params (steps, frames, seed, style_prefix) without leaving the page, and "re-render" on a row that used overrides reproduces them automatically.

### Behavior

- Textarea is a `<textarea>` inside a `<details>`, collapsed by default so the render stage stays clean for the common no-overrides path. Click the summary to expand.
- On submit: empty textarea -> request body has no `renderOverrides` field, same as before. Non-empty -> parse with `JSON.parse`; reject non-object / array values. Bad JSON sets the status pill to `renderOverrides invalid JSON: <reason>` and focuses the textarea so the user sees where to fix.
- `rerunBundle(row)` (the v0.35.1 history re-render action): if `row.render_overrides` exists and has at least one key, pre-fill the textarea with `JSON.stringify(row.render_overrides, null, 2)` and force the `<details>` open. Otherwise clear and collapse.
- `resetRenderStage()` (called on re-plan): clear the textarea and collapse the details. Prevents stale overrides from carrying silently into the next submit when the user starts a fresh plan.
- The bundle's `storyboard.yaml` is NOT touched. Overrides only modify the render-time payload sent to RunPod; the bundle on R2 stays as authored.

### Common keys

The UI's placeholder + hint surface the common ones (mirrors what rp_handler.py merges into the vivijure-serverless render payload):

- `wan_inference_steps` (int): override the diffusion-step count per Wan I2V pass. Lower = faster + less refined.
- `wan_num_frames` (int): override the per-clip frame count.
- `seed` (int): pin the seed for reproducible renders.
- `style_prefix` (string): override the storyboard's style_prefix without re-bundling.

Anything not in this list still flows through; the worker merges by key, so any payload field the storyboard / config defines is reachable via overrides.

### Code

- `public/planner.html`: new `<details class="planner-overrides-details">` block between the quality tier picker and the render button. Contains a labeled textarea and an inline hint listing the common keys.
- `public/planner.js`: `submitRender` parses the textarea before any other mutation (a malformed JSON does not progress the UI to a half-submitted state); `rerunBundle` pre-fills + auto-opens when the row has overrides; `resetRenderStage` clears + collapses.
- `public/styles.css`: `.planner-overrides-details` / `.planner-overrides-summary` / `.planner-overrides-hint` styles. Reuses existing CSS tokens; matches the rest of the planner panel's spacing.
- `package.json`: 0.35.2 -> 0.35.3.

No backend change. Tests / typecheck unchanged. Tests 335/335.

## v0.35.2

History list on `/planner.html` auto-refreshes every 30 seconds while at least one row is in a non-terminal status. Goes idle (no more polling) once every visible row has reached `COMPLETED` / `FAILED` / `CANCELLED` / `TIMED_OUT`. Pauses when the tab is backgrounded and resumes with an immediate refresh on return. Frontend-only addition.

### Why

Until now, a user who left `/planner.html` open with one or more in-flight renders had to click "refresh" (or open each render's view to engage the SSE stream) to see their queue progress. The v0.35.0 stream already kept the actively-viewed render's row current in D1, but other in-flight rows in the same list stayed stale. This commit closes that gap: the list keeps itself current with one cheap GET every 30s for as long as any row needs it, then goes silent.

### Behavior

- After every successful `loadHistory`, `maybeScheduleHistoryRefresh(rows)` inspects the freshly-rendered list. If at least one row's `status` is non-terminal, it sets a 30-second timer for the next `loadHistory`. If every row is terminal (or the list is empty), no timer is scheduled.
- `loadHistory` dedupes concurrent calls via `isLoadingHistory`. Refresh button + auto-refresh tick + post-submit refresh can all overlap; only one fetch runs at a time.
- `visibilitychange` listener: tab going hidden cancels the pending timer (no point hitting the worker for an invisible UI). Tab returning to visible fires an immediate `loadHistory` so the user sees the current state without waiting for the next 30s tick, then the loop re-arms from the fresh data.
- Failed history fetch does NOT auto-retry. A transient blip is silently logged; the user can hit refresh manually. Reduces the noise of a flaky network making the list churn.

### Code

- `public/planner.js`: new `HISTORY_AUTO_REFRESH_MS = 30000` constant. New `isLoadingHistory` flag and `historyRefreshTimer` handle in module scope. `loadHistory` reworked to dedupe via the flag and clear any pending auto-refresh at entry. New `maybeScheduleHistoryRefresh(rows)` helper called at the end of `renderHistoryList`. `visibilitychange` listener wired in the existing `DOMContentLoaded` block.
- `package.json`: 0.35.1 -> 0.35.2.

No backend change. Tests / typecheck unchanged. Tests 335/335.

## v0.35.1

Reuse an existing bundle without re-running plan + bundle. Two new affordances on `/planner.html`: a "re-render" button on every history row, and a "use bundle key..." button in the history header that opens a prompt for an arbitrary R2 bundle key. Both load the bundle key into the render stage, pre-select the same quality tier the previous run used (for the history-row path), and let the user pick a tier and click "render" to submit a fresh job against the same `.tar.gz`. Frontend-only addition.

### Why

Once a project's bundle is on R2, re-rendering at a different `qualityTier` or with tweaked `renderOverrides` does not need any of the previous stages re-run. Before this commit, the planner UI made you re-plan and re-upload to render the same bundle again. After this commit:

- The history row's "re-render" button takes the user from a glance at the list to a render-stage-with-tier-picker in one click, with the previous tier pre-selected so a single follow-up click reproduces the previous run.
- The "use bundle key..." button covers the cases not in history: a bundle staged by curl outside the UI, a bundle from before the v0.34.0 history migration, or a key shared by another user. The prompt dialog is intentionally low-fi (`window.prompt` against the bundles/ prefix); a slug derive picks the project name out of `bundles/<name>.tar.gz` so the synthetic row passes through `rerunBundle` cleanly.

### What it does NOT do

- Does NOT re-validate the storyboard. The bundle's `storyboard.yaml` is whatever was packed when the bundle was staged; if the original board is desirable, this is correct. If the user wants to change the storyboard, the plan stage is right there.
- Does NOT pre-fill `renderOverrides`. The history row carries the prior overrides on the DB row but the render-stage form does not surface them as editable today. Adding an "overrides" textarea is a follow-up.
- Does NOT alter the bundle assembler or the submit route. `bundleState.bundleKey` is just set from the row and the existing `submitRender()` flow consumes it.

### Code

- `public/planner.html`: history header gains a `.planner-history-tools` wrapper holding the existing "refresh" button plus the new "use bundle key..." button. Each row's actions panel gains a "re-render" button.
- `public/planner.js`: new `rerunBundle(row)` (closes any active stream, sets `bundleState.bundleKey`, reveals the render stage with the prior tier pre-selected, scrolls into view) and `promptCustomBundle` (wraps `window.prompt`, derives project from the bundle key, builds a synthetic row, delegates to `rerunBundle`). Wired in `DOMContentLoaded`. Each history row's `buildHistoryRow` appends a "re-render" action.
- `public/styles.css`: tiny `.planner-history-tools` flex wrapper so the two header buttons sit next to each other.
- `package.json`: 0.35.0 -> 0.35.1.

No backend change. Tests / typecheck unchanged: pure HTML / JS / CSS. Tests 335/335.

## v0.35.0

`GET /api/storyboard/render/<jobId>/stream` returns a server-sent-event stream of render status snapshots. The Worker polls RunPod every 3 seconds and emits each result verbatim (same JSON shape the one-shot poll endpoint produces); the planner UI consumes the stream via EventSource and falls back to the v0.32.0 8-second poll on any stream error. D1 persistence runs on every snapshot so `/api/storyboard/renders` stays current without a separate background job. Subjectively much snappier than the old 8-second client poll while reducing the total request count over the life of a 10-15 minute render.

### Why

The 8-second poll worked but felt sluggish: scene transitions in the rp_handler log lagged the UI by up to 8 seconds, and a 10-minute render produced 75+ HTTP round trips. SSE collapses that to one long-lived connection with 3-second snapshots; the client gets updates roughly 2.5x faster, the Worker dispatches fewer (but longer) fetches, and the existing `pollRender()` code path becomes a fallback for environments where SSE is blocked (corporate proxies stripping `text/event-stream`, EventSource-disabled browsers, edge cases where the connection won't survive Cloudflare's intermediate buffering).

The fallback pattern is important: stream first, poll only on failure. That keeps the UX snappy in the common case without losing the safety net for an in-flight render when the stream cannot stay open.

### Endpoint

- **`GET /api/storyboard/render/<jobId>/stream`** — `text/event-stream` response. Each event's `data:` field is a JSON payload with the same shape as `GET /api/storyboard/render/<jobId>` (`{ok, jobId, status, statusRaw, output, error, executionTimeMs, delayTimeMs, user}` on success; `{ok: false, errors, user}` on RunPod failure). Two sentinel events bookend the stream: `STREAM_OPENED` (immediately on connect, so the client knows the stream is live even before the first RunPod round-trip) and `STREAM_DURATION_CAP` (when the 25-minute cap is reached; EventSource auto-reconnects to a fresh stream). On terminal RunPod status the worker closes cleanly; EventSource on the client sees `readyState === CLOSED` and stops reconnecting.

### Worker implementation

- Standard `TransformStream` / writer pattern, same as `runChatStream`. The polling loop runs as an unawaited closure so the Response can return immediately.
- `STREAM_POLL_MS = 3000` (3 seconds between RunPod polls). Tuned for the planner UI's perceptual sweet spot; lower would just hammer RunPod for marginal gain.
- `MAX_STREAM_DURATION_MS = 25 * 60 * 1000` (25 minutes). Bounds a single stream's wall-clock life to avoid runaway connections. EventSource reconnect transparently picks up a new stream, so a 30-minute render rotates streams once and the user never notices.
- Each successful upstream poll is also persisted through `updateRenderFromView`. A failure to write to D1 logs but does not interrupt the stream (the render history is strictly less important than the live status feed).
- `request.signal.aborted` checked on each iteration so the loop exits cleanly when the client closes the tab.

### Planner UI rewire

- `submitRender()` no longer calls `pollRender()` directly; it calls `startStream()`.
- `startStream()` opens an `EventSource` on `/api/storyboard/render/<jobId>/stream`. Each message event runs through `updateRenderProgress` and `finalizeRender` (same code paths the poll loop used). Terminal status closes the EventSource and refreshes the history list.
- `STREAM_DURATION_CAP` sentinel transparently re-opens a fresh stream so the user never sees the rotation. `STREAM_OPENED` updates the status pill to "stream open; awaiting first status update".
- Stream errors fall back to `pollRender()` after one attempt (gated by `renderState.streamFallbackHit` so we do not bounce between stream and poll on every blip). EventSource's built-in transient-error reconnect handles short network drops without engaging the fallback.
- `resumeRender(row)` (the v0.34.1 history "view" action) opens a stream for in-flight rows instead of polling, so resumed renders also benefit from the snappier cadence.
- `cancelRender()` closes the stream before firing DELETE and re-opens one after, so the user sees the CANCELLED status as soon as RunPod reports it.

### Code

- `src/index.ts`: new `handleRenderStream(request, env, jobId)` handler in a v0.35.0 section above the existing `handleRendersList`. Route registered for `GET /api/storyboard/render/<jobId>/stream` alongside the existing GET poll and DELETE cancel matchers.
- `public/planner.js`: ~880 -> ~1010 lines. Adds `startStream()` and `closeStream()`. Refactors `submitRender`, `resumeRender`, `cancelRender`, and `resetRenderStage` to drive the stream as the primary live-update channel with `pollRender()` as the fallback.
- `package.json`: 0.34.1 -> 0.35.0.

No backend schema change, no new binding, no new runtime dep. Tests / typecheck unchanged: streaming handler skips the unit-test pattern (matches `runChatStream`); existing pollRender / updateRenderFromView tests cover the underlying primitives. Typecheck clean; tests 335/335.

## v0.34.1

`/planner.html` surfaces the render history that v0.34.0 persists. A "recent renders" section reveals at the top of the page when the user has past renders. Each row shows project, quality tier, status, relative submitted / completed timestamps, executionTime, plus a "view" action that resumes the render stage with the row's stored snapshot and re-starts polling for in-flight jobs, and a "download" link directly to the silent MP4 when `output_key` is set. Closes the user-visible loop on render history. No backend change.

### Why

v0.34.0 made renders survive a tab close on the backend; v0.34.1 makes that survival visible. Before this commit, a user who reloaded `/planner.html` lost access to any in-flight render (the planner.js `renderState.jobId` lived only in memory). Now the page loads recent renders on open, the user clicks "view" on the one they want, and the render stage picks up where it left off with the live poll loop reattached.

### Layout

- A new `<section id="planner-history">` at the top of the planner layout (between the page header and the plan form). Hidden by default; revealed only when `/api/storyboard/renders` returns at least one row.
- Each row is a flex card with: project name (bold) + quality tier (chip) + status (color-coded), submitted/finished/duration metadata line, action buttons (`view` always, `download` when the silent MP4 is in R2). Status colors match the render-pane convention (`--warn` for in-flight, `--accent` for COMPLETED, `--error` for terminal failures).
- A "refresh" button in the section header pulls a fresh snapshot from `/api/storyboard/renders?limit=25`. The list also auto-refreshes after a successful render submit so the new job appears at the top without manual intervention.

### Resume flow

Clicking "view" on a history row calls `resumeRender(row)`:

1. Stops any active poll loop on a different jobId.
2. Sets `renderState.jobId` and `bundleState.bundleKey` from the row.
3. Reveals the render stage and populates the result panel from the stored snapshot (status badge, scene index / phase / log / output / error all rehydrated when present).
4. If the row's status is terminal (`COMPLETED` / `FAILED` / `CANCELLED` / `TIMED_OUT`), the panel renders the final state and the panel status reads `... (from history)`. If still in flight, the panel reads `resumed; polling every 8s` and the live poll loop reattaches.
5. Scrolls the render stage into view.

`resumeRender` reuses the existing render-stage DOM and the `pollRender` loop, so any future behavior added to a live poll (e.g. cancel button visibility per the v0.33.1 work) flows through to resumed history rows automatically.

### Code

- `public/planner.html`: new `<section id="planner-history">` block above the plan form. Hidden by default; the page-load `loadHistory()` call reveals it when rows exist.
- `public/planner.js`: ~720 lines (v0.33.x) -> ~880 lines. Adds `loadHistory`, `renderHistoryList`, `buildHistoryRow`, `historyStatusKind`, `resumeRender`, `formatRelative`. Wires `loadHistory()` into init, after a successful submit, and to the refresh button click.
- `public/styles.css`: ~125 lines appended. `.planner-history*` styles reuse the existing CSS tokens; status colors mirror the render-pane convention.
- `package.json`: 0.34.0 -> 0.34.1.

Tests / typecheck unchanged: pure HTML / JS / CSS addition. Tests 335/335. The page is reachable the moment the next `npx wrangler deploy` ships the updated `public/` assets bundle.

## v0.34.0

D1-backed render history. Every `POST /api/storyboard/render` now writes a row to a new `renders` table keyed by the RunPod job_id; poll and cancel update the row with the latest status, output, error, and timing. `GET /api/storyboard/renders` returns the authenticated user's renders newest first, ownership-enforced via `user_email = cf-access-authenticated-user-email`. Renders survive a tab close, a worker restart, and the planner UI losing its in-memory `renderState.jobId`. No new binding, no new runtime dep; uses the existing `env.DB` binding.

### Why

The existing `/api/storyboard/render` flow was stateless: submit returned a `jobId`, the UI held it in memory, and a tab close lost the reference. The user could still poll via curl with the saved jobId, but for the planner UI to be usable by someone who is not you, history needed to survive sessions. This commit lands the persistence layer; v0.34.1 will wire the sidebar list into `/planner.html`.

### Schema migration

Apply with:

```bash
wrangler d1 execute skyphusion-llm-public --remote --file=migrate-v0.34.0.sql
```

The migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), safe to re-run.

Schema:

```sql
CREATE TABLE IF NOT EXISTS renders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email        TEXT NOT NULL,
  job_id            TEXT NOT NULL UNIQUE,
  project           TEXT NOT NULL,
  bundle_key        TEXT NOT NULL,
  quality_tier      TEXT NOT NULL,
  render_overrides  TEXT,           -- JSON-encoded
  status            TEXT NOT NULL,
  output_key        TEXT,           -- silent MP4 R2 key on COMPLETED
  output_json       TEXT,           -- last poll's output envelope
  error             TEXT,
  execution_time_ms INTEGER,
  delay_time_ms     INTEGER,
  submitted_at      INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  completed_at      INTEGER
);

CREATE INDEX IF NOT EXISTS renders_by_user
  ON renders(user_email, submitted_at DESC);

CREATE INDEX IF NOT EXISTS renders_by_user_status
  ON renders(user_email, status);
```

`UNIQUE(job_id)` lets `insertRender` use `ON CONFLICT(job_id) DO NOTHING` so a retried submit is idempotent without a transaction wrapper. Both indexes serve the list endpoint (the second is a head start for a future "in-flight only" filter).

### Endpoints

- **`POST /api/storyboard/render`** (existing) — now also persists a new row on success. DB failure does NOT fail the response; the job is already submitted to RunPod and the history miss is a strictly less-bad outcome than a 500 that the user reads as "submit failed".
- **`GET /api/storyboard/render/<jobId>`** (existing) — now also `UPDATE`s the row with each fresh status snapshot. The UPDATE is a no-op when no row exists, so polling jobs submitted before v0.34.0 still works (back-compat).
- **`DELETE /api/storyboard/render/<jobId>`** (existing) — same UPDATE pattern as poll.
- **`GET /api/storyboard/renders`** (new) — returns `{ renders: RenderRow[], user }`. Optional `?limit=N` query parameter, clamped to `[1, 200]`, default 50. Rows are sorted by `submitted_at DESC`. `render_overrides` and `output` are parsed back from their JSON-encoded TEXT columns into JS objects (or `null` if the stored string was malformed or empty).

### Ownership

The list endpoint filters by `user_email` so a user only sees their own renders. Poll and cancel do NOT check ownership (they only proxy to RunPod), so a user who happens to know another user's jobId can poll it; that is fine because the jobId is not predictable, the Cloudflare Access gate already authenticates every request, and the UI never exposes other users' jobIds. If you want strict ownership on poll later, the row's `user_email` is the lookup key.

### Code

- `migrate-v0.34.0.sql`: new. The delta-only migration (`CREATE TABLE IF NOT EXISTS renders` + the two indexes).
- `schema.sql`: same definitions appended at the end so fresh DBs come up with the table.
- `src/renders-db.ts`: new. `NewRenderRow` / `RenderRow` types, `insertRender`, `updateRenderFromView` (driven from the `RunpodJobView` shape `runpod-submit.ts` already produces), `listRendersForUser`. Pure DB layer, no fetch.
- `src/index.ts`: imports `deriveProjectFromBundleKey` from `runpod-submit` (already exported, used in `insertRender`'s project field) and the three new helpers from `renders-db`. `handleRenderSubmit` calls `insertRender` after a successful submit; `handleRenderPoll` and `handleRenderCancel` call `updateRenderFromView` after a successful upstream call. New `GET /api/storyboard/renders` route + `handleRendersList` handler.
- `package.json`: 0.33.1 -> 0.34.0.

D1 paths are not unit-tested under the plain-Node vitest pool (no D1 emulator). Coverage of the pure pieces (normalization, JSON round-trip) is exercised through the route handlers and manual smoke. Typecheck clean; tests 335/335.

## v0.33.1

`DELETE /api/storyboard/render/<jobId>` cancels a render job by proxying RunPod's `POST /v2/<endpointId>/cancel/<jobId>`. The planner UI's render panel now surfaces a "cancel job" button while the job is in `IN_QUEUE` or `IN_PROGRESS`, hiding it once a terminal status arrives. The chat UI sidebar gets a one-line cross-link to `/planner.html` for discoverability. PATCH bump (follow-throughs on the v0.32.0 / v0.33.0 render flow; no new module).

### Why

A long-running render is expensive: `final` tier on cherry takes ~10-15 minutes per job. If you submit a render, then notice the bundle was off (wrong bible, wrong scene count) before it picks up workers, the only options before this commit were "wait for `executionTimeout`" or "burn the slot and hope". A cancel endpoint lets you free the queued slot immediately and resubmit with the right bundle.

The chat UI cross-link is the one-line discoverability fix I noted as deferred in the v0.30.0 CHANGELOG. Without it, `/planner.html` is reachable only if you already know about it, which is exactly the wrong gate for a tool you want people to use.

### Endpoint

- **`DELETE /api/storyboard/render/<jobId>`** — proxies to RunPod's cancel. Same 400/502/503 semantics as the rest of the storyboard routes: 400 for malformed `jobId`, 502 if RunPod rejects the cancel (e.g. the job is already terminal), 503 if `RUNPOD_API_KEY` / `RUNPOD_ENDPOINT_ID` are not configured. On success, returns the normalized RunpodJobView (`{ok: true, jobId, status, statusRaw, user}`) reflecting whatever state RunPod reported, which will usually be `CANCELLED` but can be a different terminal state if the worker finished between the poll loop's last snapshot and the cancel request.

### UI behavior

The cancel button shows only when `setJobStatusBadge` sees `IN_QUEUE` or `IN_PROGRESS`. Click sequence:

1. Button disabled, status set to `requesting cancel...`, the active poll loop's timeout is cleared.
2. `fetch DELETE /api/storyboard/render/<jobId>` fires.
3. On success, the status flips to `cancel requested; polling for final status` and the poll loop resumes; the next poll picks up `CANCELLED` (or another terminal state) and `setJobStatusBadge` hides the button.
4. On failure (network error or 502 from a too-late cancel), the button re-enables, the status shows the error, and polling resumes so the panel never gets stuck.

### Sidebar cross-link

`public/index.html` gains a tiny `<nav class="sidebar-tools">` block under the user badge containing one link: `→ storyboard planner` pointing at `/planner.html`. The styles reuse the existing `--fg-dim` and `--accent` tokens so the link picks up theme changes automatically. No layout shift in the existing history / projects / documents sections.

### Code

- `src/runpod-submit.ts`: new `cancelRenderJob(env, jobId)` mirroring `pollRenderJob`. Reuses the already-exported `buildCancelUrl` helper. Returns a tagged result with the same shape as the submit / poll dispatchers so the route handler stays uniform.
- `src/index.ts`: import `cancelRenderJob`. The existing `rj` route regex now matches both `GET` and `DELETE`; `DELETE` dispatches to a new `handleRenderCancel` handler in the same v0.32.0 section as `handleRenderPoll`.
- `public/planner.html`: a "cancel job" button inside the render-result panel, hidden by default.
- `public/planner.js`: new `cancelRender()` dispatcher. `setJobStatusBadge` extended to show / hide the cancel button based on terminal-state detection. Cancel button wired in the `DOMContentLoaded` init block.
- `public/index.html`: `<nav class="sidebar-tools">` block under the user badge pointing at `/planner.html`.
- `public/styles.css`: `.planner-render-cancel` (warn-tinted secondary button) and `.sidebar-tools` / `.sidebar-tools-link` styles appended at the end. Both reuse the existing CSS tokens.
- `package.json`: 0.33.0 -> 0.33.1.

Tests / typecheck unchanged: only TypeScript is in `src/`; the JS / HTML / CSS additions are not unit-tested per the established pattern. Tests 335/335; the existing `buildCancelUrl` test (added in v0.32.0) already covers the URL shape. The cancel-dispatcher path matches the poll / submit pattern (skipped per the planner.ts convention).

## v0.33.0

End-to-end planning UI at `/planner.html`. The page now walks the three-stage pipeline in the browser: plan -> bundle -> render. After the validated storyboard JSON / YAML appears, per-slot upload widgets reveal for each character in `use_characters`; selecting files immediately stages each one through `POST /api/storyboard/character-ref` to R2. Clicking "bundle" assembles via `POST /api/storyboard/bundle`. Clicking "render" submits via `POST /api/storyboard/render` and starts an 8-second poll loop on `GET /api/storyboard/render/<jobId>`, showing scene index, phase, the live render log, and an "open silent MP4" download link when the job hits `COMPLETED`. No backend change, no new endpoint, no new runtime dep.

### Why

v0.29.x through v0.32.x built the backend surface for the planning pipeline. v0.30.0 surfaced the plan stage in a browser; until now the bundle + render stages were only callable via curl. This commit closes the loop so someone who is not you can drive a render entirely from the browser, with no shell required and no API key in the page. The Cloudflare Access cookie that gates `/planner.html` is the same one that gates every `/api/storyboard/*` route, so authn and authz are unchanged.

### Layout

Three stages, each a numbered section that reveals on the previous stage's success:

1. **plan** (always visible) -- model picker, brief textarea, four cast rows (slot A through D with check-to-include, name input, bible textarea). On success the validated JSON + YAML render in the existing side-by-side panel, and the bundle stage reveals.

2. **assemble bundle** -- per-slot upload widget for each character in `storyboard.use_characters`, pre-populated with the name + bible from the plan-stage cast form (read-only summary; edit by re-planning). The widget accepts PNG / JPEG / WEBP via a multi-file input; each selected file uploads immediately, with per-file status (`uploading...` / `staged` / `failed: <reason>`). When every slot has at least one staged image, the "bundle" button assembles the `.tar.gz` and reveals the render stage. Unsupported file types fail loudly without contacting the worker.

3. **render** -- quality-tier dropdown (`draft` / `standard` / `final`, defaulting to `final` to match the smoke-tested cherry path) and a "render" button. After submit, a result panel reveals with the RunPod job id, status badge (`IN_QUEUE` / `IN_PROGRESS` / `COMPLETED` / `FAILED` / `CANCELLED` / `TIMED_OUT`), live scene index, phase, and the tail of the render log. The 8-second poll loop runs until the job hits a terminal status. On `COMPLETED` the silent MP4 surfaces as a download link plus an "open in new tab" link, both pointing at `/api/artifact/<output_key>`. On any terminal failure status the panel shows the error and the executionTime so the user can decide whether to re-bundle or re-plan.

### State and reset behavior

Re-running "plan" clears both the bundle stage and the render stage and stops any active poll loop. Re-running "bundle" against new uploads stops the prior render stage from showing stale state. The pollTimer is cleaned up on every dispatcher entry so two concurrent polls never overlap.

### Code

- `public/planner.html`: new "bundle" and "render" sections appended after the existing output panel. Plan section labeled "1. plan", bundle "2. assemble bundle", render "3. render" for stage clarity. Same head boilerplate and footer script include as before.
- `public/planner.js`: previously ~280 lines (v0.30.0); now ~720 lines. Adds module-scope state objects (`planState`, `bundleState`, `renderState`), per-slot upload widget builder + file-upload dispatcher, bundle assembly call, render submit + poll loop with live log + scene / phase display, plus helpers (`formatBytes`, `formatDuration`, `setJobStatusBadge`, terminal-state detection). Uses DOM construction over innerHTML for any text that flows from server responses; no escape-and-stringify pattern needed.
- `public/styles.css`: ~210 lines appended at the end. Reuses the existing CSS tokens; responsive collapse via the existing 800px breakpoint already covers the new stages. Stages share the same border-top + spacing convention so the visual rhythm matches the existing plan output panel.
- `package.json`: 0.32.0 -> 0.33.0.

Tests / typecheck unchanged: only TypeScript is in `src/`; this addition is pure HTML / JS / CSS. Tests 335/335. The page is reachable the moment the next `npx wrangler deploy` ships the updated `public/` assets bundle.

## v0.32.0

`POST /api/storyboard/render` submits a bundle to the vivijure-serverless RunPod endpoint and returns the RunPod-issued jobId. `GET /api/storyboard/render/<jobId>` polls one job's status (proxied through the Worker so the API key never leaves Cloudflare). Closes the loop on the planning pipeline: plan -> validate -> assemble bundle -> render -> poll. No new binding, no schema change, no new runtime dep. Adds two optional secrets to the Env interface: `RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID`. Configure via `npx wrangler secret put RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID`; the routes return 503 with a clear configure-via message when either is missing.

### Why

v0.31.0 made the bundle land on R2; the GPU worker on RunPod just needs the bundle key + the project name + the quality tier. RunPod's submit / poll surface is small and well-documented, so this is a thin proxy layer: take the bundleKey from the assembler's response, wrap it in the rp_handler.py-shaped input (`{project, bundle_key, quality_tier, render_overrides?}`), POST to `/v2/<endpointId>/run` with the user's stored Bearer token, return the jobId. The poll proxy keeps the API key on the worker rather than baking it into the browser.

Persistence is deliberately omitted in this pass. The UI holds the jobId (in memory plus localStorage if it wants), polls the proxy, and downloads the rendered MP4 from R2 via the existing `/api/artifact/<key>` route. A D1-backed render-history table is a clean follow-up once the flow stabilizes; the planner UI does not need it for first-pass operation.

### Endpoints

- **`POST /api/storyboard/render`** — body `{ bundleKey, qualityTier?, renderOverrides?, project? }`. `bundleKey` is required. `qualityTier` is `"draft" | "standard" | "final"`, default `"final"`. `renderOverrides` is an opaque object passed through to rp_handler.py for per-shot tuning (Wan step count, seed, etc.). `project` defaults to the slug derived from `bundleKey` (stripping the `bundles/` prefix and `.tar.gz` suffix) so the bundle assembler and the render submit form one consistent project namespace; pass it explicitly only if the bundle was staged under a custom key. Returns `{ ok: true, jobId, status, statusRaw, user }` on success.

- **`GET /api/storyboard/render/<jobId>`** — proxies RunPod's `/v2/<endpointId>/status/<jobId>`. Returns `{ ok: true, jobId, status, statusRaw, output?, error?, executionTimeMs?, delayTimeMs?, user }`. Status enum is the RunPod platform's literal strings: `IN_QUEUE | IN_PROGRESS | COMPLETED | FAILED | CANCELLED | TIMED_OUT`. Unknown status strings (in case RunPod adds new states) collapse to `IN_PROGRESS` for the typed `status` field but pass through verbatim as `statusRaw` so the UI can see what RunPod actually returned.

### Response semantics (mirrors the /api/storyboard/plan matrix)

- **200 + `{ok: true, ...}`** — Job accepted (submit) or status fetched (poll).
- **400 + `{error}`** — Malformed request body, missing `bundleKey`, invalid `qualityTier`, or malformed `jobId` on poll. `jobId` is validated against `^[A-Za-z0-9_-]{1,128}$` at the route boundary so a malformed id never reaches RunPod as a path-traversal attempt.
- **502 + `{ok: false, errors, ...}`** — RunPod's API rejected the call (auth, rate limit, endpoint id wrong) or the network request failed. Distinct from a *job-level* failure (which arrives via poll as `status: "FAILED"` with HTTP 200).
- **503 + `{error}`** — `RUNPOD_API_KEY` or `RUNPOD_ENDPOINT_ID` is not configured on the worker. Error message names the secrets and the `wrangler secret put` commands.

### Code

- `src/runpod-submit.ts`: new. Pure helpers (`buildSubmitPayload`, `buildSubmitUrl`, `buildStatusUrl`, `buildCancelUrl`, `deriveProjectFromBundleKey`, `isValidJobId`, `normalizeRunpodResponse`) plus the two fetch dispatchers (`submitRenderJob`, `pollRenderJob`). The dispatchers never throw on HTTP 4xx / 5xx; they return a tagged result the route translates to a Worker response with the right status code.
- `src/env.ts`: two new optional secrets, `RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID`, with inline-doc pointers to the RunPod console paths to create them.
- `src/index.ts`: one new route (`POST /api/storyboard/render`) plus one parameterized route (`GET /api/storyboard/render/<jobId>`); two new handlers `handleRenderSubmit` and `handleRenderPoll` in a v0.32.0 section between `/api/storyboard/bundle` and "Chat (text generation, multimodal in)". Both handlers do request-shape validation, 503 fail-fast on missing secrets, then call the dispatcher and shape the response per the matrix.
- `tests/runpod-submit.test.ts`: new. 25 tests covering the pure helpers (payload shape with / without overrides; URL builders; project derivation from bundleKey, including the canonical bundle layout and the fallback path; jobId validation including path-traversal rejection; RunPod envelope normalization for queued / progress / completed / failed / unknown states). Dispatchers (which touch fetch + env) are not unit-tested in this pass, matching the planner.ts pattern; coverage of the wire shape comes from the pure helpers plus manual smoke against a real endpoint.
- `package.json`: 0.31.0 -> 0.32.0.

Tests 335/335 (310 existing + 25 new). Typecheck clean. Configuring the worker post-deploy is two `wrangler secret put` calls; no schema change, no new binding, no new runtime dep. After the secrets are set the planning surface closes the loop end to end.

## v0.31.0

Storyboard bundle assembler. `POST /api/storyboard/bundle` takes a validated storyboard plus per-slot character refs (R2 keys or inline data URLs) and produces the `.tar.gz` the vivijure-serverless GPU worker pulls via `r2_io.download_and_extract`. Bundle is staged to R2 at `bundles/<projectName>.tar.gz`. `POST /api/storyboard/character-ref` uploads one image (PNG/JPEG/WEBP), returns the R2 key. No new binding, no schema change, no new runtime dep (POSIX ustar tar is hand-written, gzip via Workers-native `CompressionStream`).

### Why

v0.29.x produced a validated storyboard JSON; v0.30.0 surfaced it through the UI. To actually feed it to the GPU worker, skyphusion needs to assemble the project bundle the worker's `r2_io.download_and_extract` expects: `storyboard.yaml` + `characters/registry.json` + the canonical per-slot portrait at `characters/char_<SLOT>_<safe-name>.png` + the LoRA / IP-Adapter training set at `characters/refs/<SLOT>/ref_NN.<ext>`. The GPU side's `characters.list_character_references` globs that refs directory for the readiness check that gates LoRA training, so getting the layout right is load-bearing for identity.

The path of least dependency is to assemble the tar on the Worker, gzip it via the Workers-native `CompressionStream("gzip")`, and `R2.put` the result. No external tar lib, no codegen, no extra runtime dep. The POSIX ustar format is small enough (one fixed 512-byte header per file plus padded content plus two trailing empty blocks) that a hand-written emitter is cleaner than pulling in a dependency.

### Bundle layout

Mirrors what `characters.py` / `orchestrator.py` in the GPU repo expects:

```
storyboard.yaml                            (top-level)
characters/registry.json                   (per-slot {name, prompt, image})
characters/char_<SLOT>_<safe-name>.png     (canonical portrait, registry.image points here)
characters/refs/<SLOT>/ref_NN.<ext>        (training + IP-Adapter refs; list_character_references
                                            globs this dir for the >=8 readiness check that
                                            lora_train fires on)
start_image.png                            (optional top-level film start; auto-bootstrapped
                                            by the GPU worker if absent)
```

`safeCharFilename` mirrors `characters.slot_image_path`'s convention byte-for-byte: `name.strip().replace(" ", "_")[:40]`. Each training ref's extension is sniffed from the file's magic bytes (PNG, JPEG, WEBP), falling back to `.png` on an unrecognized signature.

### Endpoints

- **`POST /api/storyboard/character-ref`** — body is raw binary (PNG/JPEG/WEBP per Content-Type), max 16 MB. Returns `{ key, mime, size, user }`. Stages to R2 at `in/<uuid>.<ext>` via the existing `r2Put` helper so the staged object is visible to the same artifact-cleanup paths that already exist. 400 on wrong / missing MIME, 400 on empty body, 413 on > 16 MB.
- **`POST /api/storyboard/bundle`** — body is `{ storyboard, characterRefs, startImage? }`. `characterRefs` is a sparse `{ "A": CharacterRef, "B": ..., ... }` keyed by slot id. Each `CharacterRef` has `{ name, prompt, trainingImages: TrainingImage[], portrait?: TrainingImage }`. Each `TrainingImage` is `{ key }` (R2 reference) or `{ dataUrl }` (inline base64) plus an optional `filename` override. Returns `{ ok: true, bundleKey, sizeBytes, fileCount, user }` on success or `{ ok: false, errors, user }` (200) on input-resolution failures, 400 on malformed request body, 500 on assembler exceptions.

### What the assembler enforces

- Defensive re-validation of `storyboard` through `validateStoryboard`, so a tampered or skipped-validation body cannot ship a structurally invalid board to the GPU worker. Failures come back as `storyboard: <validator error>` so they are distinguishable from ref-resolution errors.
- Every slot in `storyboard.use_characters` must have a matching `characterRefs[slot]` entry with a non-empty `name` and at least one training image. Missing slots fail loudly rather than ship a half-cast bundle the GPU side would silently skip identity on.
- Each `TrainingImage` resolves through R2 (when `key`) or base64 (when `dataUrl`); errors name the offending slot, training image index, and the underlying cause (R2 miss, bad data URL).
- Portrait defaults to `trainingImages[0]` when omitted, matching the GPU side's project-bootstrap behavior.

### Code

- `src/tar-emit.ts`: new. Pure POSIX ustar emitter, ~150 lines, no dep. Filename limit 100 bytes (the bundle's paths max out around 30); regular files only. Throws on empty / too-long names.
- `src/bundle-assembler.ts`: new. `assembleBundle(env, args)` dispatcher plus exported pure helpers `safeCharFilename`, `detectImageExt`, `decodeDataUrl`. The dispatcher resolves images, builds the file list, calls `emitTar`, gzips via `CompressionStream("gzip")`, and `R2.put`s the bundle.
- `tests/tar-emit.test.ts`: new. 14 tests, including a round-trip through a minimal in-test ustar parser. Verifies magic bytes, version, typeflag, checksum, 512-byte padding, end-of-archive marker, multi-file order, binary content fidelity, filename length limits, mode/mtime preservation.
- `tests/bundle-assembler.test.ts`: new. 27 tests covering the pure helpers (safeCharFilename byte-for-byte vs the Python convention, image format sniffing, data URL decoding) and the dispatcher pipeline using an in-memory R2 stub. Bundles unpack via `node:zlib.gunzipSync` plus the in-test tar parser to verify the file layout matches the GPU worker contract.
- `src/index.ts`: two new routes (`POST /api/storyboard/character-ref` and `POST /api/storyboard/bundle`) registered after `/api/storyboard/plan`; two new handlers `handleCharacterRefUpload` and `handleStoryboardBundle` in a v0.31.0 section between `/api/storyboard/plan` and "Chat (text generation, multimodal in)".
- `package.json`: 0.30.0 -> 0.31.0.

Tests: 310/310 (269 existing plus 14 tar-emit plus 27 bundle-assembler). Typecheck clean.

## v0.30.0

Storyboard planner UI at `/planner.html`. Hydrates the model picker from `GET /api/storyboard/models`, takes a brief plus up to four character entries (slots A through D), POSTs to `/api/storyboard/plan`, and renders the validated JSON + bundle-ready YAML on success or the validator errors plus the raw model output on failure. One-click "re-prompt with errors" button appends the error list to the brief and re-submits. Frontend-only addition; no backend change, no new binding, no new runtime dep.

### Why

v0.29.x added the planner endpoints but the only way to call them was curl. A dedicated page makes the planner usable end-to-end from the browser, lets a real planning iteration happen in seconds, and gives the validator errors a visible failure surface so the model can be re-prompted with them as additional constraints. Page is reachable directly at `/planner.html`. No link from the chat UI yet; that's a one-line change in `index.html` to add when the planner moves out of MVP and the cross-link makes sense for discoverability.

### Layout

- Single-page form: model picker, brief textarea, four cast rows (slot A through D, check-to-include, name input, bible textarea), plan button, status line.
- Output panel revealed after the first plan call. Two columns on desktop, single column on phones (`<800px`), showing the validated JSON and the bundle-ready YAML side by side. The YAML is what a future bundle assembler will write into the project `.tar.gz`.
- On validator failure: errors panel with the full error list and a "re-prompt with these errors" button that appends the list to the brief verbatim so the user retries without retyping. Raw model output shown below so the user can see what actually came back when the JSON did not parse or did not validate.
- On HTTP 502 (upstream provider failure): same errors panel but labeled "upstream error" rather than "model output invalid", so the user knows it's a service issue rather than a model-retry case. Matches the response-semantics matrix the v0.29.0 route defines.

### Code

- `public/planner.html`: new. Static HTML mirroring the chat UI's head boilerplate (favicons, manifest, theme color). Single `<main>` with form + output sections; no modals needed.
- `public/planner.js`: new. Vanilla JS, single file. `renderCast()` builds the four slot rows; `loadModels()` hydrates the picker; `plan()` posts to `/api/storyboard/plan` and routes the response through `renderResult()` based on HTTP status + `ok` field. `repromptWithErrors()` appends the error list to the brief in a clearly delimited block (`PREVIOUS ATTEMPT FAILED VALIDATION...`) so the model sees the prior failure on the next single-shot call. Ctrl/Cmd+Enter inside the brief textarea submits.
- `public/styles.css`: planner section appended at the end (~210 lines). Reuses the existing CSS tokens (`--bg`, `--bg-elev`, `--accent`, `--error`, `--warn`, `--border`, `--fg`, `--fg-dim`) so the planner picks up theme changes for free. Responsive breakpoint at 800px collapses the two-column result pane into a stack and the three-column cast rows into a single column.
- `package.json`: 0.29.1 -> 0.30.0.

Tests / typecheck unchanged: the only TypeScript is in `src/`; this addition is pure HTML / JS / CSS. Tests 269/269. The page is reachable the moment the next `npx wrangler deploy` ships the updated `public/` assets bundle.

## v0.29.1

`GET /api/storyboard/models` returns the planner-only model catalog so the planner UI picker does not re-render the full 38-model chat catalog. Response shape mirrors `/api/models`: `{ models: PLANNING_MODELS, user: <email> }`. No new binding, no schema change, no new runtime dep.

### Why

The frontend planner picker needs the same nine rows that `findPlanningModel` accepts. Hitting `/api/models` and filtering client-side works but bakes the curated id list into two places (here and in the UI), so the moment we swap a model out of `PLANNING_MODELS` the picker still offers the old one until the JS bundle is rebuilt. A dedicated route makes the curated subset the single source of truth: the UI fetches once, renders the picker, and `POST /api/storyboard/plan` rejects with the same catalog list (400 + catalog) if anything desyncs.

### Code

- `src/index.ts`: new inline route at `GET /api/storyboard/models`, registered right before `POST /api/storyboard/plan` so all storyboard routes are co-located. Mirrors the `/api/models` pattern (inline, one-line handler).
- `package.json`: 0.29.0 -> 0.29.1.

PATCH bump per the convention (follow-through on v0.29.0's planner wiring; same surface area, one additional read-only endpoint, no new module). Typecheck clean; tests 269/269.

## v0.29.0

`POST /api/storyboard/plan` wires the v0.28.0 storyboard planner into the Worker's HTTP surface. The frontend calls a single endpoint with `{brief, characters, model}` and gets back either `{ok: true, storyboard, yaml}` (a validated `StoryboardValidated` JSON plus a bundle-ready storyboard.yaml string) or `{ok: false, errors, raw}` (validator failures plus the raw model output so the UI can show what went wrong and re-prompt). No new binding, no schema change, no new runtime dep.

### Why

v0.28.0 added `planStoryboard` as a callable module but no Worker route invoked it. Without a route, the planner is dead code from the frontend's perspective. Wiring it directly into the existing fetch handler keeps the addition tiny (one route line, one handler function), follows the same pattern as `/api/chat` and `/api/chat/stream`, and lets the planner UI iterate against a real endpoint immediately.

### Response semantics

The route distinguishes four cases by status code AND the `ok` field, so the UI can branch correctly:

- **200 + `{ok: true, storyboard, yaml, provider, model, logId, user}`** — The model produced JSON that passed `validateStoryboard`. `storyboard` is the validated normalized form (with `style_category`/`style_preset` collapsed to `"None"` per the schema rule, `projectName` derived from `normalizeProjectName(title)`, etc.). `yaml` is the bundle-ready storyboard.yaml string produced by `serializeStoryboardYaml(storyboard)`, ready to drop into the R2 bundle the GPU worker pulls.
- **200 + `{ok: false, errors, raw, provider, model, logId, user}`** — The model executed but its output did not parse as JSON or did not satisfy the schema. The UI shows the errors, optionally appends them to the next user message, and re-prompts. This is the normal "model did not follow the schema" path, not an HTTP error.
- **400 + `{error, catalog?}`** — Malformed request body, missing required field, malformed character entry, or a `model` id not in the planning catalog. When the failure is an unknown model, the response includes the list of valid catalog ids so the picker can refresh.
- **502 + `{ok: false, errors, raw, ...}`** — Upstream provider call failed (network, auth, rate limit, model rejection). Distinct from "model output bad" so the UI can show a "service error, retry" affordance rather than "model said no, try again". The dispatcher tags these errors with `provider call failed:` or `model execution failed:` prefixes.

### Auth and observability

Same Cloudflare Access path as every other route (gateway-enforced upstream; the route reads `cf-access-authenticated-user-email` for attribution, echoed as `user` on the response). No new secret, no new env var. The AI Gateway log id flows back to the client as `logId` so a UI debug surface or a future persistence layer can link each plan back to the gateway entry.

### Code

- `src/index.ts`: import `planStoryboard`, `PlannerCharacter`, `findPlanningModel`, `PLANNING_MODELS`, `serializeStoryboardYaml`, and `SlotId`. Route registered at `POST /api/storyboard/plan` right after `/api/chat/stream`. New `handleStoryboardPlan(request, env)` handler in a v0.29.0 section between `/api/chat/stream` and "Chat (text generation, multimodal in)". The handler does request-shape validation (model present and non-empty, brief present and non-empty, characters an array, each character has a valid slot id and string name+bible), catalog membership check (400 fail-fast instead of letting the dispatcher return ok:false), then awaits `planStoryboard(env, ...)` and shapes the response per the table above.
- `package.json`: 0.28.0 -> 0.29.0.

The handler itself sits inside `src/index.ts` (which the plain-Node vitest pool cannot load), so it follows the same no-route-tests pattern as `/api/chat` and `/api/chat/stream`; coverage comes from the underlying module tests (`planner-prompt`, `planner-yaml`, `planner-catalog`, plus the `storyboard-validate` tests it transitively exercises) plus manual smoke. Typecheck clean; tests 269/269.

## v0.28.0

Provider-selectable storyboard planner. `planStoryboard({brief, characters, model})` drafts a board as JSON via Anthropic BYOK, xAI BYOK, or Workers AI (one non-streaming completion), strips `\`\`\`json` fences, JSON.parses the completion, runs it through `validateStoryboard` from v0.27.0, and returns the validated `StoryboardValidated` or the error list. `serializeStoryboardYaml` emits the storyboard.yaml the vivijure-serverless GPU worker reads. No new runtime dependency. No new binding, no schema change. Does NOT submit anything to RunPod; the caller decides whether to re-prompt the model with the validator errors or hand off to the bundle assembler.

### Why

The previous step (v0.27.0) gave the planner Worker a structural validator for storyboard input. This step gives the Worker a way to *produce* that input: pick a model, draft a board, validate, retry. The schema-constrained system prompt encodes the three behaviors the GPU renderer cares about and the model would otherwise get wrong:

1. Style language goes in `style_prefix` exactly once. The renderer prepends `style_prefix` to every scene at manifest-build time (`core.build_manifest` in the GPU repo), so any style word repeated inside a scene prompt is double-applied and biases the keyframe.
2. Slot ids are exactly `"A" | "B" | "C" | "D"` and every per-scene `character_slots` is a subset of top-level `use_characters`. Without this in the prompt, models guess slot conventions like `"slot_a"` or invent labels.
3. `style_category` and `style_preset` default to the literal string `"None"`. The renderer's disable path keys on the string, not on `null`, so a `null` falls through to the default profile lookup instead of disabling style.

### Catalog and dispatch

Nine models in the planner picker, three per provider, all curated for JSON-schema discipline rather than catalog completeness:

- **Anthropic BYOK**: Claude Opus 4.7, Sonnet 4.6, Haiku 4.5.
- **xAI BYOK**: Grok 4.3, Grok 4.20 Multi-Agent, Grok Build 0.1 (coding-trained).
- **Workers AI**: GLM-4.7 Flash, GPT-OSS 120B, Llama 4 Scout.

Reuses the existing `callAnthropic` / `callXai` / `aiRun` paths from `src/providers/` and `src/ai-binding.ts`; the planner does not introduce its own provider plumbing. BYOK secrets (`ANTHROPIC_API_KEY`, `XAI_API_KEY`) are consumed inside the provider modules, never read by the planner module.

The catalog is filtered from the existing `MODELS` table by id, so labels and capabilities stay in sync with the rest of the chat picker for free. Adding a planning model is one id in `PLANNING_MODEL_IDS`; the catalog test fails fast if the id does not resolve in `MODELS`.

### Output parsing

`stripJsonFences` handles bare JSON, single fenced blocks (with or without the `json` language tag), and multiple fenced blocks. When the model emits an example block before the final answer, the helper picks the LAST fence, not the first. When no fence is present, it slices between the first `{` and the last `}` so prose wrappers ("Sure, here you go: ... Hope that helps!") still parse cleanly.

`serializeStoryboardYaml` double-quotes every string unconditionally so colons inside scene prompts ("Featuring: Kira: protagonist"), embedded quote characters, backslashes, and newlines all round-trip cleanly through PyYAML on the GPU worker. No general-purpose YAML library, no codegen.

### Code

- `src/planner.ts`: new. `planStoryboard(env, args)` dispatcher; `PlanStoryboardArgs`, `PlanStoryboardResult` types; re-exports `PlannerCharacter` and `PlanningProvider` for callers.
- `src/planner-catalog.ts`: new. `PLANNING_MODELS` (subset of `MODELS`), `findPlanningModel`, `plannerProviderFor`, `PlanningProvider` type.
- `src/planner-prompt.ts`: new. `buildPlanningSystemPrompt`, `buildPlanningUserMessage`, `stripJsonFences`, `PlannerCharacter` type. Pure string functions, no env / fetch dependencies.
- `src/planner-yaml.ts`: new. `serializeStoryboardYaml` emits storyboard.yaml from a `StoryboardValidated`. Pure, no runtime dependency.
- `tests/planner-prompt.test.ts`: new. 26 tests covering the system prompt, user message, and fence stripping (including multi-fence "last block" preference).
- `tests/planner-catalog.test.ts`: new. 11 tests verifying every PLANNING_MODELS id resolves in MODELS, all three provider paths are represented, and `plannerProviderFor` / `findPlanningModel` behave correctly.
- `tests/planner-yaml.test.ts`: new. 17 tests covering minimal and full storyboard shapes, "None" literal preservation, string escaping (quotes, backslashes, newlines, colons), flow vs block style, optional-field omission, scene ordering, and the deliberate non-emission of the internal `projectName` field.
- `package.json`: 0.27.0 -> 0.28.0.

No new runtime dependency, no new binding, no schema change. The dispatcher itself touches `env.AI.run` / `fetch` so it is not unit-tested in this pass (matches the existing pattern for `src/index.ts` and the provider modules; their own provider-level tests cover the underlying calls). Typecheck clean; tests 269/269 (215 existing plus 54 new).

## v0.27.0

Hand-written storyboard validator for the planner Worker. Validates the structural shape of a planner output before it is serialized to `storyboard.yaml` and bundled for the vivijure-serverless GPU worker. Pure, synchronous, no I/O. Slot readiness (registry prompt plus >=8 reference images on disk) is intentionally out of scope; that lives in a later R2 pre-flight against the bundle's `characters/registry.json` and `characters/training/<SLOT>/` listings.

### Why

The GPU render pipeline silently degrades when a planner output is structurally invalid. A missing scene prompt produces a no-op shot at manifest build time. A `character_slots` entry that references a slot not in `use_characters` ships an unloaded slot to the worker, which then bypasses identity lock for that scene because the LoRA prefs do not carry that slot. Missing `style_category` or `style_preset` reach the renderer as `null` when the renderer's disable path keys on the literal string `"None"`, so a `null` falls through to the default profile lookup instead of disabling style. Catching all three at planner exit, before the bundle hits R2, gives the planner a single deterministic place to surface fixable schema errors with line-precise messages, instead of waiting for the GPU job to render garbage and reading the diagnostic from the worker log half an hour later.

The validator's structural rules came straight from reading the consumers in the GPU repo (`vivijure-serverless/build/vivijure-src`): `orchestrator.build_render_payload` for the top-level keys actually consumed, `core.build_manifest` for the per-scene keys, `orchestrator.slots_ready_for_training` for the readiness rule that is deliberately not enforced here, and `characters.SLOTS = ["A","B","C","D"]` for the slot-id enum. `normalizeProjectName` mirrors `studio_service.norm_project` exactly so the slug the planner emits matches what the worker writes on disk.

### What it enforces

- `title` is a non-empty string; normalized to a safe project slug via `normalizeProjectName` (collapse whitespace runs to `_`, fall back to `"project"` for empty input).
- `scenes` is a non-empty array; every entry has a non-empty `prompt`.
- `use_characters`, if present, is an array of slot ids in `["A","B","C","D"]`; duplicates rejected.
- Every per-scene `character_slots` is a subset of top-level `use_characters`. The error names the offending slot and the loaded set.
- `style_category` / `style_preset`: `undefined` / `null` / `""` / whitespace-only collapse to the literal string `"None"`. Non-empty strings preserved.
- `duration_seconds`, `clip_seconds`, scene `target_seconds`, scene `end` must be positive finite numbers if provided; scene `start` must be non-negative finite (zero is a legal film-time origin); `end > start` when both present; `NaN` / `Infinity` rejected throughout.
- All errors accumulate in one pass; the validator does not bail on the first failure.

### Code

- `src/storyboard-validate.ts`: new. `SlotId` / `SLOT_IDS` enum, `StoryboardScene` / `StoryboardInput` / `StoryboardValidated` / `ValidationResult` types, `validateStoryboard(input: unknown)` and `normalizeProjectName(title)` exported. Minimal-dep convention (no zod, no ajv) per `src/env.ts` and `src/longrun-params.ts`. Returns `{ok:true,value} | {ok:false,errors:string[]}` with human-readable messages naming the offending field, index, and slot.
- `tests/storyboard-validate.test.ts`: new. 43 vitest tests grouped by surface (happy path, title, scenes, use_characters, character_slots subset rule, None-normalization, duration_seconds / clip_seconds, scene timing, non-object inputs, error accumulation, invariants). Locks in the SLOT_IDS sync with `characters.SLOTS` in the GPU repo.
- `package.json`: 0.26.0 -> 0.27.0.

No new runtime dependency, no new binding, no schema change. Typecheck clean; tests 215/215 (172 existing plus 43 new).

## v0.26.0

ZIP import now runs durably in the `LongRunWorkflow` instead of synchronously, so large archives import without approaching the Worker per-invocation subrequest limit (the caveat noted in v0.25.0). Backend + frontend. No new binding, no schema change.

### Why

The v0.25.0 path expanded a zip and ingested every inner file in a single request. Each file's embedding is several subrequests, so a large archive could approach the per-invocation subrequest ceiling. Cloudflare Workflows run each step in its own context with a fresh subrequest budget, so moving each file's ingest into its own step removes that ceiling and makes the import durable (each step retries independently).

### How it works

1. `POST /api/documents` with a `.zip` stages the archive to R2 (the bytes can't ride the workflow event payload) and starts a `LongRunWorkflow` instance, returning `{ zip: true, async: true, job_id }` immediately.
2. The workflow (`kind: "zip_import"`, reusing the existing `LONGRUN` binding) runs: step `unzip-and-stage` decompresses the archive and stages each inner file to a temp R2 object, returning only the small name+key list; one `ingest-<i>` step per file then ingests it with a fresh subrequest budget; a final `cleanup` step deletes the temp objects and the staged zip. The run returns an import summary.
3. The client polls `GET /api/import/:id`, which maps the workflow instance status to `pending` / `done` / `failed` and returns the summary on completion. The summary records `user_email`, and the status endpoint only returns it to that user, so a guessed instance id can't read another user's import result. The documents list refreshes as files land, showing progress.

A failed single-file ingest is still recorded as a skip (with reason), not a workflow failure. The zip-bomb and size guards from v0.25.0 are unchanged.

### Code

- `src/index.ts`: `LongRunParams` is now a union (`LongRunGenParams | ZipImportParams`); `LongRunWorkflow.run` branches on `kind`, with the existing video/music logic moved verbatim into `runGen` and a new `runZipImport`; `handleZipImport` stages the zip and starts the workflow instead of importing inline; new `handleImportStatus` + `GET /api/import/:id` route; new `ZipImportSummary` type.
- `public/app.js`: `uploadDocument` recognizes the async response and polls `pollImport`; added a `sleep` helper.
- `README.md`, `CLAUDE.md`: document the durable import path and the new route.
- `package.json`: 0.25.0 -> 0.26.0.

`ingestDocument`, `unzip`, the ZIP limits, and the binary guard are reused unchanged. No new dependency, no new binding (the existing `LONGRUN` workflow handles the new kind), no schema change. Workflows do not run under `wrangler dev --remote`; local dev mode and deploys are fine. Typecheck clean; tests 172/172.

## v0.25.0

ZIP import for RAG: upload a `.zip` to the documents sidebar and each file inside is expanded and ingested as its own document. Backend + frontend.

### What changed

`POST /api/documents` now detects a ZIP by magic bytes and expands it, running every inner file through the existing ingest pipeline (PDF per-page, XLSX per-sheet, everything else as UTF-8 text, with the v0.23.0 binary guard). Each inner file becomes its own `documents` row, so it lists separately, retrieves under its own filename (the in-zip path), and deletes individually.

### Zero-dependency decompression

No new runtime dependency. `src/zip.ts` parses the ZIP central directory by hand and inflates entries with the Workers-native `DecompressionStream("deflate-raw")`. Driving off the central directory (not local headers) means streaming data descriptors are handled for free, since the central directory always carries the real sizes. Stored (method 0) and deflate (method 8) entries are supported; encrypted, zip64, and other compression methods are skipped per-entry with a reason. The 10 MB compressed upload cap keeps real archives well under the zip64 threshold.

### Guards

- Compressed archive still rides the 10 MB `DOC_MAX_BYTES` cap.
- Decompressed expansion is bounded (zip-bomb guard): max 200 entries, 50 MB total uncompressed, 10 MB per inner file, all checked against the declared uncompressed size *before* inflating.
- Files that can't be imported (binary, encrypted, empty, over a limit) are skipped with a reason and reported in the response; the import does not abort on a single bad file.
- Inner files are ingested sequentially to bound Worker subrequest usage. Very large archives can still approach the per-invocation subrequest limit; moving bulk import to the `LongRunWorkflow` is a possible future enhancement.

### Code

- `src/zip.ts` (new): `isZip` magic-byte check + `unzip` (central-directory parser, `DecompressionStream` inflate, limit enforcement).
- `tests/zip.test.ts` (new): stored + deflate round-trips, directory skipping, per-file/entry-count limits, invalid-zip handling (8 tests).
- `src/index.ts`: extracted the single-file ingest into a reusable `ingestDocument` returning a structured result; new `handleZipImport`; `handleDocumentUpload` branches on `isZip`; ZIP limit constants and a `mimeFromName` helper.
- `public/app.js`: `uploadDocument` recognizes the aggregate zip response and reports imported / chunk / skipped counts. (The picker already accepts any file as of v0.23.0.)
- `README.md`: RAG docs note ZIP import.
- `package.json`: 0.24.0 -> 0.25.0.

No schema, no migration, no new dependency, no new binding. Typecheck clean; tests 172/172.

## v0.24.0

Chat attachments now accept text-based files (yaml, json, csv, source code, logs, etc.), inlined into the prompt for analysis. Backend + frontend.

### What changed

The chat paperclip / drag-drop previously accepted only image, audio, and video; anything else threw `Unsupported file type`. Now any text-based file can be attached to a chat turn and its contents are folded into the prompt as a fenced block, the same mechanism used for audio transcripts. Works on any chat model (no vision capability required).

This is a separate path from RAG document upload (the sidebar, made type-agnostic in v0.23.0):

- **Inline chat attachment** (this change): the whole file goes into *this one turn's* context. Best for "explain this config", "find the bug in this script", "summarize this log".
- **RAG document upload** (sidebar): the file is chunked and embedded for *retrieval across turns*. Best for large or many documents you query repeatedly.

### Guards

- Binary input is rejected with the same `looksBinary` heuristic the RAG uploader uses (decided on the decoded bytes, not the extension), so a `.docx`/image/archive returns a clear 400 instead of inlining garbage.
- Files past 200k chars (`MAX_DOC_ATTACHMENT_CHARS`) are truncated with a marker so one attachment can't blow the context window. Browser-side upload cap is 2 MB.

### Code

- `src/types.ts`: new `InputDocumentAttachment` (`{ type: "document", text, mime?, filename? }`) added to the `InputAttachment` union.
- `src/index.ts`: new `PersistedDocumentAttachment` (metadata only, no R2/full-text storage); `MAX_DOC_ATTACHMENT_CHARS`; shared `buildDocumentAttachment` helper; `document` branch added to both the non-streaming and streaming chat attachment loops.
- `public/app.js`: `handleFiles` treats non-media files on chat as text documents; `MAX_DOC_ATTACHMENT_BYTES`; preview + stored-history renderers for the `document` type; chat file picker (set dynamically in `updateAffordance`) no longer filters by accept and the hints mention text files.
- `README.md`: new "Text files" entry under Multimodal handling.
- `package.json`: 0.23.0 -> 0.24.0.

No schema, no migration, no new dependency, no new binding. Typecheck clean; tests 164/164.

## v0.23.0

RAG document upload now accepts any file type, not just `.txt`/`.md`/`.pdf`/`.xlsx`/`.xls`. Backend + frontend.

### What changed

The document uploader previously rejected anything outside a fixed allowlist (`ALLOWED_DOC_MIMES` / `ALLOWED_DOC_EXT_RE`) with a `400 Unsupported file type`. That allowlist is gone. Any file can now be uploaded for RAG:

- **PDF** and **XLSX/XLS** keep their native extractors (per-page and per-sheet, with source-location metadata) unchanged.
- **Everything else** is decoded as UTF-8 text and chunked. This transparently covers CSV, JSON, HTML, XML, source code, logs, config files, and any other text-based format, regardless of extension or reported mime type.

### Not actually "no restriction": the binary guard

Accepting any file does not mean embedding garbage. The text fallback runs a content-based check (`looksBinary`): if the decoded bytes are more than 10% U+FFFD replacement characters or C0 control codes (the signature of a zipped/binary format like `.docx`, `.png`, `.zip`), extraction throws and the upload is rejected with a clear message. This is decided on the bytes, not the extension, so it never rejects a text file with an unusual name but always catches an unreadable binary before it pollutes the vector store. (Scanned/image-only PDFs remain unsupported pending OCR, as before.)

### Code

- `src/index.ts`: removed `ALLOWED_DOC_MIMES` / `ALLOWED_DOC_EXT_RE` and the allowlist gate in `handleDocumentUpload`; added the `looksBinary` heuristic; `extractChunks` text fallback now rejects binary input instead of decoding it to junk.
- `public/index.html`: dropped the `accept="..."` allowlist on `#doc-file-input`.
- `public/app.js`: removed the client-side `allowedExt` regex check in `uploadDocument`.
- `README.md`: RAG file-type docs updated to "any file type" with the binary-guard caveat.
- `package.json`: 0.22.1 -> 0.23.0.

No schema, no migration, no new dependency, no new binding. The 10MB upload cap (`DOC_MAX_BYTES`) is unchanged. Typecheck clean.

## v0.22.1

Fix + follow-through on v0.22.0: gpt-image-1.5 transparency now works via a BYOK direct call, and the broken proxy params are fixed. Backend only.

### The v0.22.0 bug

`openai/gpt-image-1.5` 7003-errored on every call: `Unsupported fields passed: background, output_format. Valid fields: prompt, images, quality, size, style`. The CF Unified Billing proxy for gpt-image-1.5 does NOT forward `background`/`output_format`, despite CF's catalog note ("use 1.5 for transparent PNGs"), which refers to the underlying model, not the proxy surface. So native transparency is unavailable through the proxy on both Recraft and gpt-image-1.5.

### The fix (two parts)

1. The proxy path for `openai` now sends only proxy-valid fields (`{ prompt, quality, size }`), so gpt-image-1.5 works again as an OPAQUE model with no key required.
2. Transparency is delivered by a BYOK direct call that bypasses the proxy. OpenAI's own `/v1/images/generations` accepts `background: "transparent"` + `output_format: "png"` and returns base64 (`data[0].b64_json`); GPT image models never return a URL. New `src/providers/openai-image.ts`. `runImage` uses it when `OPENAI_API_KEY` is set, and falls back to the opaque proxy path when it is not. So nothing breaks without the key; setting the key opts into transparent PNGs.

### To enable transparent assets (the one action required)

```
npx wrangler secret put OPENAI_API_KEY
```

Then redeploy. With the key set, gpt-image-1.5 generations come back as transparent RGBA PNGs (billed to your OpenAI account, BYOK, not CF credits). Verify:

```
curl -sS https://<worker-host>/api/chat -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-image-1.5","user_input":"a single cartoon gold coin sprite, centered, nothing else"}'
# then on the stored artifact:
python3 -c "from PIL import Image; im=Image.open('coin.png'); print(im.mode, im.getextrema())"   # expect RGBA + non-trivial alpha
```

### Code

- `src/env.ts`: optional `OPENAI_API_KEY` (image-only; chat stays on the proxy).
- `src/providers/openai-image.ts` (new): `generateOpenAIImage(apiKey, modelId, prompt)` -> `{ bytes, mime }`.
- `src/index.ts`: `runImage` proxied branch gains an `openai` + key sub-branch (BYOK transparent) ahead of the opaque proxy fallback.
- `src/proxied-image-params.ts`: `openai` case drops the proxy-rejected fields.
- `tests/proxied-image-params.test.ts`: openai case asserts the opaque proxy shape and that `background`/`output_format` are absent.
- `package.json`: 0.22.0 -> 0.22.1.

No schema, no migration, no new dependency, no new binding. Typecheck clean; tests 164/164.

### Recraft / GIF unchanged

recraftv4 stays opaque (no alpha on the CF proxy), returns webp. GIF remains out of scope; PNG-with-alpha is the deliverable.

## v0.22.0

Proxied image-gen, part 1: transparent PNG via gpt-image-1.5, plus Recraft V4. Backend only.

### What this adds

Two new Image Gen models and one new provider slug (`recraft`):

- `openai/gpt-image-1.5` (provider `openai`): the transparent-PNG model. CF's own catalog routes transparency here (the `openai/gpt-image-2` page states transparent backgrounds are unsupported there and to use 1.5). The worker requests `background: "transparent"` + `output_format: "png"`.
- `recraft/recraftv4` (provider `recraft`): opaque, art-directed (strong composition and text rendering, style controls). The CF Recraft proxy exposes no alpha flag, only an opaque `background_color`, so this is NOT a transparency model. Returns webp. Added for logos, icons on solid backgrounds, and style-controlled scene art.

### Why not Recraft for transparency

The original plan was Recraft. Verifying `recraft/recraftv4` against the CF model page showed its only background control is `controls.background_color: { rgb: [...] }` (opaque), with no alpha option, and it returns webp. Recraft's own platform supports transparent generation; the CF proxy surface does not pass it through. gpt-image-1.5 is the supported path on CF.

### The code

- `src/models.ts`: `"recraft"` added to the `Provider` union; the two entries above added to the Image Gen group.
- `src/proxied-image-params.ts` (new): `buildProxiedImageParams(provider, prompt)` returns the per-provider request shape. Each proxied schema is `additionalProperties:false`, so each provider gets only its accepted keys; the `@cf` `{ width, height, steps, negative_prompt }` shape is rejected by all three. Lives in its own module (like `output-extract.ts`) so it is unit-testable without importing `cloudflare:workers`.
- `src/index.ts`: `runImage`'s proxied branch generalized from `if (model.provider === "google")` to `if (model.provider)` (the `@cf` entries carry no `provider`, so this is exactly the proxied set), and the hardcoded google params replaced with the helper. The shared tail (`detectProviderFailure` -> `extractProxiedImageUrl` -> `fetch` -> mime from response content-type) is unchanged; reading mime from the header already handles recraftv4's webp.
- `tests/proxied-image-params.test.ts` (new): asserts the three provider shapes, that no shape leaks the `@cf` keys, and that the openai shape carries `background:"transparent"`.

### Touch points

- `src/models.ts`, `src/index.ts` (import + one branch + a stale-comment fix), `src/proxied-image-params.ts` (new), `tests/proxied-image-params.test.ts` (new).
- `package.json`: 0.21.10 -> 0.22.0.

No schema, no migration (v0.22.0 adds no D1 statements), no new dependency, no new binding, no `worker-configuration.d.ts` regen.

### Verify live before trusting transparency in prod (NOT yet done)

1. Confirm the proxy forwards `background: transparent` and the output is real RGBA, not an opaque PNG. CF's rendered parameter table for gpt-image-1.5 lists prompt/quality/size/style but does not surface `background`/`output_format`, though the underlying OpenAI model supports both:

   ```
   curl -sS https://<worker-host>/api/chat \
     -H 'content-type: application/json' \
     -d '{"model":"openai/gpt-image-1.5","user_input":"a single cartoon gold coin sprite, centered, nothing else"}'
   ```

   Then on the stored artifact: `python3 -c "from PIL import Image; im=Image.open('coin.png'); print(im.mode, im.getextrema())"` and expect `RGBA` with a non-trivial alpha channel. If it comes back `RGB`/opaque, the proxy dropped `background`; fall back to a generate-then-matte pass (Recraft remove-background or RMBG/BiRefNet).

2. Confirm BYOK vs Unified Billing for `openai/*` image. The CF raw-response example shows `gatewayMetadata.keySource: "BYOK"`, suggesting an OpenAI key may need to be configured on the gateway rather than CF credits. If so it is a gateway config item, not code; until configured it fails with a credentials error, same as the other proxied models.

3. recraftv4 returns webp, not png (the CF output schema's `image/svg+xml` is a docs typo). Harmless as wired since mime comes from the response header; if a downstream consumer needs png, add a transcode for `provider === "recraft"`.

GIF is intentionally out of scope: PNG-with-alpha is the deliverable (8-bit alpha, standard sprite format); GIF transparency is 1-bit and no model emits GIF.

## v0.21.10

Fix: actually allow image upload / drag-drop / paste on i2v models. Completes the incomplete v0.21.9 fix. Frontend only.

### What v0.21.9 missed

v0.21.9 fixed the i2v affordance (showed the upload), the per-file handler (accepted the image), and the send gate (shipped it) — but all of that lives *after* an early guard at the top of `handleFiles`:

```js
if (m.type !== "chat" && m.type !== "stt" && !isFlux2) return;
```

A video i2v model is none of those, so `handleFiles` returned immediately and the file was dropped before any of the v0.21.9 handling ran. Because the picker, drag-drop, and paste all funnel through `handleFiles`, all three were dead — matching the report of "can't attach OR drag/drop."

### The fix

The guard now also lets `image-input` (i2v) models through:

```js
const isImageInput = (m.capabilities || []).includes("image-input");
if (m.type !== "chat" && m.type !== "stt" && !isFlux2 && !isImageInput) return;
```

With the guard opened, the rest of the v0.21.9 path runs: the image is accepted as the i2v source (single image, replaces any prior pick), sent to the worker, and animated. Upload still wins over the conversation-image carry-forward; carry-forward applies only when nothing is uploaded.

### Verified path (end to end)

1. Affordance: attach row + image accept shown for i2v (v0.21.9).
2. `handleFiles` guard: allows image-input models (v0.21.10, this release).
3. Per-file branch: pushes the image for image-input models (v0.21.9).
4. Send gate: video image-input models send attachments (v0.21.9).

### Touch points

- `public/app.js`: one-line guard fix in `handleFiles`.
- `package.json`: 0.21.9 -> 0.21.10.

No backend change. Worker tests: 159/159 (unchanged; frontend-only).

## v0.21.9

Fix: image-to-video models now accept an uploaded source image. Frontend only.

### The bug

You could not upload an image to animate with an i2v model (e.g. hh1-i2v). Three things combined, all introduced with the v0.21.7 carry-forward work:

1. The i2v branch of `updateAffordance` hid the file input outright, on the assumption the source would always be a prior generated image carried forward from the conversation.
2. The attachment handler rejected uploaded images for i2v models with "Current model doesn't support vision" (it only allowed images for vision chat or FLUX.2).
3. The attachments send-gate dropped attachments for `video`-type models, so even a populated image never reached the worker.

Net effect: a user starting a fresh conversation had no way to animate their own image, only an image generated earlier in that same conversation. Manual upload to i2v had in fact never been wired; the v0.21.7 carry-forward just made the gap visible by putting a hint where the upload should be.

### The fix

i2v now supports both paths, upload-wins:

- The i2v input shows the file picker (image accept). Hint: "upload an image to animate, or leave empty to animate the previous generated image in this conversation."
- The attachment handler accepts a single image for `image-input` models (replaces any prior pick, so re-selecting just swaps the source).
- The send-gate includes `video` + `image-input` models, so the uploaded image reaches the worker, which already resolves an attachment image as an i2v source (attachment -> R2; or `image_key` for the carry-forward; or `image_url`).
- If the user uploads, that image is the source; if not, the most recent conversation image is carried forward via `image_key` as before.

### Touch points

- `public/app.js`: i2v affordance shows the upload; attachment handler accepts images for image-input models; send-gate includes video image-input models.
- `package.json`: 0.21.8 -> 0.21.9.

No backend change (the worker already accepted an attachment image as an i2v source). Worker tests: 159/159 (unchanged; frontend-only).

## v0.21.8

Output video is muted by default in the UI, and a note on hh1-i2v audio. Tiny release.

### Muted video playback

The output `<video>` now renders with `muted` (controls still allow unmuting). hh1-i2v bakes a generated audio track into its output, and that soundtrack was playing on preview. Muting by default stops the throwaway audio from blasting; anyone who wants it can unmute via the controls.

### hh1-i2v has no audio toggle (documented so we don't re-probe it)

There is no way to stop hh1-i2v from generating audio. Probed live: sending `audio: false` (or any audio field) fails with "Unsupported field passed: audio. Valid fields: image, prompt, negative_prompt, resolution, duration, seed, watermark." The model always generates a soundtrack, and it bills for it under Unified Billing whether or not the track is used.

If you need a silent file (e.g. to add your own music or dialogue when assembling videos), strip or replace the audio downstream with ffmpeg, where the video is assembled (the OVH box), not in the worker (Workers have no ffmpeg; a WASM remux would be disproportionate):

- Drop audio, keep video untouched: `ffmpeg -i in.mp4 -c copy -an out.mp4`
- Add your own track and drop the generated one in one pass: `ffmpeg -i in.mp4 -i track.mp3 -map 0:v:0 -map 1:a:0 -c:v copy -shortest out.mp4`

The second is the assembly step you'd run anyway; the explicit `-map` simply never carries the generated audio forward, so stripping is not separate work.

### Touch points

- `public/app.js`: `muted` on the output video element.
- `package.json`: 0.21.7 -> 0.21.8.

Worker tests: 159/159 (unchanged; UI-only change). The v0.21.8 audio-param probe in `buildGenParams` was reverted after the live probe confirmed the field is rejected; the i2v param shape is unchanged from v0.21.6.

## v0.21.7

Cross-model artifact reuse: a model can consume what a previous model generated in the same conversation, with no download/re-upload. Confirmed live. No schema, no migration, no new dependencies, no new worker secrets.

### The mechanism: attachment-by-reference

An image or full-video attachment may now carry an R2 `key` (an artifact already produced in the conversation) instead of inline `data`. `resolveAttachmentKeys` hydrates `key` -> `data` once, at the request dispatch chokepoint, before routing, so every downstream consumer (vision chat, FLUX.2 reference images, Pegasus video-Q&A, image-to-video) works unchanged. Ownership is enforced by `r2KeyToDataUri` (the object's `customMetadata.user_email` must match the requester), so a client can't reference another user's artifact.

### What's wired

- **Backend (general):** `InputImageAttachment` and `InputVideoFullAttachment` gain an optional `key` (with `data` now optional); `resolveAttachmentKeys` at the dispatch boundary resolves them. One place, all consumers benefit.
- **Frontend (images, end to end):** switching to any image-consuming model carries the most recent conversation image forward automatically, by reference, unless the user attached their own. Image-to-video receives it via `image_key`; vision chat and FLUX.2 reference receive it as an image attachment-by-key. The i2v input surfaces a visible "will animate the previous generated image" hint so the carry-forward isn't silent.

The end-to-end flow now works in the UI: generate an image with `google/nano-banana-pro`, switch to `alibaba/hh1-i2v` (or a vision chat model, or FLUX.2), and the image is already the source. Confirmed live.

### Incidental fix

The attachments send-gate in the frontend only fired for `chat`/`stt` model types, which meant FLUX.2 reference images attached in the UI for an `image`-type model were collected but never sent. The gate now also includes FLUX.2 image models, so user-attached reference images actually reach the worker.

### Touch points

- `src/types.ts`: `key` on image + video_full attachments; `data` optional.
- `src/index.ts`: `resolveAttachmentKeys`; resolution at the dispatch chokepoint.
- `src/providers/bedrock.ts`: guard for now-optional video data in Pegasus.
- `public/app.js`: `latestArtifactKey`, `modelConsumesImage`, `isFlux2Model` helpers; carry-forward in the request build (`image_key` for i2v, attachment-by-key for vision/FLUX.2); send-gate fix; i2v carry-forward indicator.
- `package.json`: 0.21.6 -> 0.21.7.

Worker typecheck clean. Worker tests: 159/159 (unchanged; the new backend logic is a thin map over the already-tested `r2KeyToDataUri`, and the frontend is not under tsc/vitest).

### Deferred

- **Video-as-input carry-forward** is backend-ready (the `key` mechanism covers video_full) but not auto-wired in the frontend, detecting "this model consumes video" cleanly wants a capability flag rather than a guess. Small follow-up.
- Per-model carry-forward indicators for vision chat and FLUX.2 (i2v has one; the others carry forward silently).

## v0.21.6

Image-to-video source flows: uploads and chaining. Completes hh1-i2v (whose v0.21.5 first pass took only a fetchable URL). The headline is a fully Cloudflare-side image-to-video pipeline, confirmed live end to end (~100s). No schema, no migration, no new dependencies, no new worker secrets.

### What changed

The probe answered the deferred fork: hh1-i2v accepts base64 `data:` URIs for `image` (the upstream re-uploads them to its own object store), so the presigned-R2 GET signer is NOT needed. The worker just inlines R2 bytes as a data URI.

- **`src/utils.ts`**: `bytesToBase64`, chunked (0x8000 window) so a multi-MB image doesn't overflow the call stack the way `btoa(String.fromCharCode(...bytes))` would. Round-trips with `base64ToBytes`.
- **`src/index.ts`**: `r2KeyToDataUri(env, key, userEmail)` reads an R2 object, enforces the `/api/artifact` ownership check (`customMetadata.user_email` must match), and returns a `data:` URI. `runVideo` now resolves three source flows for `image-input` models: an uploaded attachment (stored to R2 via `r2Put`), an `image_key` (an existing R2 key, e.g. a prior nano-banana output), or an `image_url` (external, passed through). The R2-key resolution to a data URI happens **inside the workflow step**, so the big base64 never rides the Workflow event payload (~1 MiB cap); only the short key travels through `LongRunParams`. `ChatRequest` gains `image_key`.
- **`tests/utils.test.ts`** (new): 4 base64 round-trip tests, including across the chunk boundary and through a `parseDataUrl` data URI.

### The pipeline

`google/nano-banana-pro` generates an image (stored to R2). Pass its `output_artifact.key` as `image_key` to `alibaba/hh1-i2v`. The image is read from R2 and inlined inside the workflow step, animated, and the MP4 is stored back to R2. The image never becomes a public URL, never leaves Cloudflare, and both stages bill through the one gateway. Verified live: nano-banana-pro -> R2 key -> data URI -> hh1-i2v -> MP4.

### Touch points

- `src/utils.ts`: `bytesToBase64`.
- `src/index.ts`: `r2KeyToDataUri`; three-source resolution in `runVideo`; `image_key` on `ChatRequest`; `imageKey` through `LongRunParams`; workflow resolves the key in-step.
- `tests/utils.test.ts`: new, 4 tests.
- `README.md`: image-to-video section updated (source flows + pipeline).
- `package.json`: 0.21.5 -> 0.21.6.

Worker typecheck clean. Worker tests: 159/159 (155 prior + 4 new).

### Known follow-ups

- A source-image dimension check (hh1-i2v wants >=300x300, aspect 1:2.5 to 2.5:1) would fail fast at submit instead of ~100s into a job. Currently a bad image surfaces as a clean `job_error` after the upstream rejects it.
- A one-call "animate this artifact" convenience endpoint (pass an existing row's artifact key, infer the model) would be a nice ergonomic layer on top.

## v0.21.5

First image-to-video model: `alibaba/hh1-i2v`. Animates a source image. Confirmed live (~113s for a 720P / 5s clip). No schema, no migration, no new dependencies, no new worker secrets.

### What changed

- **`src/longrun-params.ts`** (new): `buildGenParams(kind, { prompt, lyrics, imageUrl })`, a pure param builder extracted from the workflow so the per-model shapes are unit-testable. The shapes genuinely differ and the wrong one is a rejected upstream call: text-to-video sends `{ prompt, duration:"8s", aspect_ratio, resolution:"720p", generate_audio }` (string duration), while hh1-i2v sends `{ image, resolution:"720P", duration:<int 3-15> }` and (per its `additionalProperties:false` schema) must NOT carry the t2v fields. i2v is selected by the presence of `imageUrl`, so the workflow keeps a single `video` kind.
- **`src/index.ts`**: `image_url` added to `ChatRequest`; `imageUrl` threaded through `LongRunParams` and the workflow; `runVideo` requires `image_url` for models flagged `image-input` (400 if missing, before a row is created); the workflow now calls `buildGenParams`.
- **`src/models.ts`**: `alibaba/hh1-i2v` added (`capabilities: ["image-input"]`); the capability type extended to `"vision" | "image-input"`. Also fixed a pre-existing mislabel: `alibaba/hh1-t2v` was labeled "img2vid" in the catalog and "image-to-video only" in the README, but it is text-to-video.
- **`tests/longrun-params.test.ts`** (new): 5 tests (t2v vs i2v vs music shapes; i2v carries no t2v fields; optional prompt/lyrics omitted when blank).
- **`README.md`**: video summary + matrix updated; new image-to-video subsection.
- **`package.json`**: 0.21.4 -> 0.21.5.

Worker typecheck clean. Worker tests: 155/155 (150 prior + 5 new).

### Scope (first pass) and what's deferred

This pass takes a fetchable `image_url` only, the lowest-unknown slice, which isolates and proves the param shape and the output-to-R2 path. Two source flows remain, both blocked on the same enabler (getting a private R2 object to hh1-i2v as a fetchable URL):

1. **User-uploaded source image:** store the upload to R2, then presign a GET URL or read-and-inline as a base64 data URI. One probe decides which hh1-i2v accepts (`image` is `format: uri`; a `data:` URI may satisfy it and skip presigning).
2. **Chaining from Nano Banana Pro:** feed a generated image (already in R2) into hh1-i2v, the Cloudflare-side front of an image-to-video pipeline. Same presigned-R2 dependency.

Both are specced in the session notes. The presigned-R2 GET helper is the shared unlock and is worth building once for both.

## v0.21.4

Gemini SSE streaming. Gemini 3.1 Pro (added non-streaming in v0.21.3) now streams. Confirmed live in the UI. No schema, no migration, no new dependencies, no new worker secrets.

### What changed

`src/parsers/gemini-sse.ts` (new): `interpretGeminiSSEFrame` extracts `candidates[0].content.parts[].text` and `usageMetadata` per frame (stateless), mirroring the other SSE interpreters. `callGeminiStream` (new, in `src/providers/google.ts`) is structurally identical to `callOpenAIStream`: binding path with `stream: true`, reader loop, `extractSSEDataPayloads`, same abort bridge. The stream gate in `handleChatStream` was opened for provider `google`, a `provider === "google"` branch was added to the `runChatStream` dispatch, and `streaming: true` is now set on `google/gemini-3.1-pro`.

### The incremental-vs-cumulative reconciler

Gemini stream chunks can be either incremental (each chunk is the new piece) or cumulative (each chunk is the full text so far), and which one the binding emits isn't contractually documented. Rather than probe-then-build, this release handles both with `makeGeminiDeltaReconciler` (in `gemini-sse.ts`): per frame, if the new text extends what's already been emitted (`startsWith`) it slices the new suffix (cumulative); otherwise it emits the piece whole (incremental). Both modes reconstruct the correct, non-repeating output. This is the same defensive-dual-shape approach that made the OpenAI SSE parser work first try. The reconciliation lives in the stream caller (it needs cross-frame state); the interpreter stays stateless and testable.

Edge case, documented in the code: an incremental piece that exactly equals `emitted + suffix` would be mis-sliced, astronomically unlikely in natural-language token streams. If a live stream ever shows repeated or truncated text, the raw-frame probe identifies the true mode and the reconciler can be pinned to one branch.

### Touch points

- `src/parsers/gemini-sse.ts`: new. `interpretGeminiSSEFrame` + `makeGeminiDeltaReconciler`.
- `src/providers/google.ts`: `callGeminiStream` added.
- `src/index.ts`: import; `provider === "google"` branch in the stream dispatch; gate opened.
- `src/models.ts`: `streaming: true` on `google/gemini-3.1-pro`.
- `tests/gemini-sse.test.ts`: new, 9 tests (interpreter shapes + both reconciler modes + final-text equivalence).
- `README.md`: SSE bullet now six providers; chat catalog 37 stream-capable; Gemini section flipped to streaming.
- `package.json`: 0.21.3 -> 0.21.4.

Worker typecheck clean. Worker tests: 150/150 (141 prior + 9 new).

### Notes / next

- The one failure mode the reconciler can't cover is if the binding doesn't return `data:`-framed SSE at all (e.g. a JSON-array stream); `extractSSEDataPayloads` would then find nothing and output would be empty. UI streaming confirms this is not the case for gemini-3.1-pro.
- The rest of the Gemini family (`gemini-3-flash`, `gemini-2.5-pro/flash`, the lites), when added on `src/providers/google.ts`, inherits this streaming path for free.
- Gemini vision input still deferred.

## v0.21.3

Google Gemini chat via Unified Billing: Gemini 3.1 Pro. Confirmed live. No schema, no migration, no new dependencies, no new worker secrets.

### Why this needed a provider module, not a catalog line

The plan from v0.21.0 assumed Gemini might be "near-free" if the binding normalized it to the OpenAI `{choices}` shape the OpenAI proxied models use. Checking the CF model page first (rather than assuming) showed it does not: through `env.AI.run`, Gemini is native in both directions.

- **Request:** `{ contents: [{ role, parts: [{ text }] }], systemInstruction?, generationConfig? }`, not `{ messages }`. Roles are `user`/`model` (no `assistant`), and the system prompt lives in `systemInstruction`, not a turn.
- **Response:** `{ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount, candidatesTokenCount, thoughtsTokenCount } }`.

So Gemini needs a transform layer like Anthropic and Bedrock, not the generic proxied path. `src/providers/google.ts` provides it: `prepareGeminiRequest` maps the internal OpenAI-style message array to Gemini `contents` (`assistant -> model`, system hoisted to `systemInstruction`, defensive text coercion), and `callGemini` invokes the binding. `extractOutput`/`extractUsage` gained `candidates[].content.parts[].text` and `usageMetadata` branches.

### Dispatch note

`provider: "google"` is now used by three model types: Veo (video), Nano Banana (image), and Gemini (chat). This is unambiguous because handlers dispatch on model type first, so a `type: "chat"` Google model only reaches `runChat`, where the new `provider === "google"` branch calls `callGemini`. `runChat` also now keeps the system prompt out of `messages` for Google (as it already did for Anthropic), since it's hoisted to `systemInstruction`.

### Touch points

- `src/providers/google.ts`: new. `geminiContentsFromMessages` (exported, pure), `prepareGeminiRequest`, `callGemini`.
- `src/output-extract.ts`: Gemini branches in `extractOutput` and `extractUsage`.
- `src/index.ts`: import; `google` excluded from system-in-messages; `provider === "google"` dispatch branch in `runChat`.
- `src/models.ts`: `google/gemini-3.1-pro` in the Chat · Google group.
- `tests/google-gemini.test.ts`: new, 7 tests (role mapping, system drop, array coercion, unknown-role fallback, systemInstruction presence/absence).
- `tests/output-extract.test.ts`: 2 tests (Gemini output + usage).
- `README.md`: chat catalog now 38 models / 6 providers; new Gemini section.
- `package.json`: 0.21.2 -> 0.21.3; description to 38 / 6.

Non-streaming this pass (stream gate returns 501 for `google`). Text-only (`capabilities: []`); the model is multimodal but vision input is deferred. Worker typecheck clean. Worker tests: 141/141 (132 prior + 9 new).

### Notes / next

- `ai_gateway_log_id` is null on these rows, same proxied-billing behavior as nano-banana-pro (routing info is in `gatewayMetadata`, not the field `aiLogId()` reads). Cosmetic.
- The rest of the Gemini family (`gemini-3-flash`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-3.1-flash-lite`, `gemini-2.5-flash-lite`) share this request/response shape, so they are catalog-only additions on `src/providers/google.ts`, each still worth one live spot-check.
- Gemini streaming and vision input both deferred.

## v0.21.2

First proxied (Unified Billing) image model: Google Nano Banana Pro. Confirmed live (~21s, PNG stored to R2). No schema, no migration, no new dependencies, no new worker secrets.

### Google Nano Banana Pro

`google/nano-banana-pro` added to the Image Gen catalog. It's a proxied partner model, not Workers AI hosted, and its schema differs enough from the `@cf` image models that `runImage` needed a dedicated branch rather than a catalog line. The schema was verified against the CF model page before writing the branch:

- **Input:** `{ prompt, output_format }`, `additionalProperties: false`. The `@cf` param shape (`width`/`height`/`steps`/`negative_prompt`) would be rejected, so the branch sends only the supported fields. `system_prompt` has no `negative_prompt` slot here and is ignored.
- **Output:** a URL, not base64, in the `{ state, result }` envelope shared with video/music: `{ state: "Completed", result: { image: "<url>" } }`. The branch fetches the URL and stores the bytes in R2, the way the video path does.
- **Failure handling:** reuses `detectProviderFailure` (v0.21.1) for the `{ state: "Failed" }` case, surfacing a 502 instead of persisting a broken row.

The branch dispatches on `model.provider === "google"` inside `runImage` (only image-type models reach `runImage`, and Google video goes through `runVideo`, so the check is unambiguous). The existing `@cf` path is unchanged, wrapped in the `else`.

First pass is text-to-image only; the schema's `image_input[]` (up to 3 reference images for editing) is deferred, mirroring how the FLUX.2 reference-image support was staged. `capabilities` is empty so the picker offers no attach affordance for it yet.

### Touch points

- `src/output-extract.ts`: new `extractProxiedImageUrl` (reads `result.result.image` or bare `result.image`).
- `src/index.ts`: import; `provider === "google"` branch in `runImage`.
- `src/models.ts`: `google/nano-banana-pro` at the top of Image Gen.
- `tests/output-extract.test.ts`: 5 tests for the URL extractor.
- `README.md`: image catalog now eight models; new Nano Banana Pro subsection; catalog summary line.
- `package.json`: 0.21.1 -> 0.21.2.

Worker typecheck clean. Worker tests: 132/132 (127 prior + 5 new).

### Notes / known gaps

- **Latency.** Observed ~21s for a 1024-ish gen. Synchronous (`runImage` holds the request open), same as the `@cf` image path. If a higher resolution or busier moment pushes past the worker wall-clock budget, route Google image through `LongRunWorkflow` like video. Not needed at current latencies.
- **`ai_gateway_log_id` is null** on these rows. The proxied response carries routing info in `gatewayMetadata` rather than the field `aiLogId()` reads. Cosmetic observability gap, not a functional issue.

### Next image models (same branch, near-free)

`google/nano-banana` and `google/nano-banana-2` are the same family: same `{ state, result: { image } }` output and `{ prompt, output_format }` input, so they work through this branch as catalog-only additions (each still worth one live check). `google/imagen-4` is a different Google image schema (aspect-ratio / count params) and would need its own verification. Non-Google proxied image families (OpenAI gpt-image, BFL FLUX.2 pro/max/flex, Recraft, ByteDance Seedream) each need their own branch + schema check; Recraft's vector models additionally return SVG, which needs separate mime/R2 handling.

## v0.21.1

OpenAI proxied chat streaming. The OpenAI models added in v0.21.0 shipped non-streaming because the stream path had no OpenAI parser; this release adds one and turns streaming on for all four. Confirmed live against `gpt-5.5`. No schema, no migration, no new dependencies, no new worker secrets.

### What changed

The streaming path for OpenAI is the `env.AI.run` binding path (same as Workers AI), not a direct provider-endpoint fetch (the way Anthropic and xAI stream), because OpenAI here is Unified Billing, not BYOK. New `src/providers/openai.ts` (`callOpenAIStream`) is structurally identical to `callWorkersAIStream`; only the frame interpreter differs.

The interpreter, `interpretOpenAISSEFrame` in `src/parsers/openai-sse.ts`, handles **both** frame shapes the binding may emit for a streamed proxied model, rather than guessing:

- OpenAI-native delta: `{ "choices": [{ "delta": { "content": "..." } }], "usage"?: {...} }`
- CF-normalized flat: `{ "response": "...", "usage"?: {...} }`

The two don't share keys (a native frame has no `response`, a flat frame has no `choices`), so checking each independently is unambiguous. This made the release shape-agnostic: it would have worked whichever shape the proxy turned out to use. Live verification against `gpt-5.5` returned incremental deltas plus a final frame carrying token usage (`tokens_in`/`tokens_out` both populated), confirming both the text and usage branches fire end to end.

`streaming: true` is now set on `openai/gpt-5.5`, `openai/gpt-5.4`, `openai/gpt-5.4-mini`, and `openai/o4-mini`. The streaming gate in `handleChatStream` was opened for provider `openai` (previously it returned `501`). `POST /api/chat` (non-streaming) remains as a fallback.

### Touch points

- `src/parsers/openai-sse.ts`: new. Dual-shape interpreter, null-guarded.
- `src/providers/openai.ts`: new. `callOpenAIStream`, mirrors `callWorkersAIStream`.
- `src/index.ts`: import; `provider === "openai"` branch in the stream dispatch; gate opened (Pass 5).
- `src/models.ts`: `streaming: true` on the four OpenAI entries; provisional comment replaced with the confirmed-live note.
- `tests/openai-sse.test.ts`: new, 9 tests (both shapes, usage naming variants, empty-delta drops, null/string safety).
- `README.md`: SSE feature bullet now lists five providers; chat catalog 36 stream-capable; OpenAI section streaming note; `/api/chat/stream` count updated.
- `package.json`: 0.21.0 -> 0.21.1; description corrected to 37 chat models / 5 providers.

Worker typecheck clean. Worker tests: 127/127 (118 prior + 9 new).

### Note on the dual-shape parser

It's deliberate, not speculative generality. The shape was genuinely unknown at write time (the AI binding doesn't contractually document which it returns for proxied streaming), and the two candidates are the only shapes `env.AI.run` is known to emit. Handling both cost ~6 lines and removed a deploy-then-discover round trip. If a third shape ever appears, add a branch with a fixture test.

## v0.21.0

Catalog additions plus a testability extraction. Adds Claude Opus 4.8, Google Veo 3.1 / 3.1 Fast, and a first pass at OpenAI proxied chat (non-streaming). No schema, no migration, no new dependencies, no new worker secrets.

### Claude Opus 4.8

Added `anthropic/claude-opus-4-8` as the flagship Anthropic chat entry, above Opus 4.7. The API model id was verified as `claude-opus-4-8` against the Anthropic skills repo, the AWS Bedrock model card, and the Claude Code docs rather than from memory (released 2026-05-28; 1M context, 128K max output, adaptive thinking). It routes through the existing `anthropic/` prefix strip in `src/providers/anthropic.ts`, so no dispatch change was needed; it streams like the other Claude entries.

### Veo 3.1 / 3.1 Fast

Added `google/veo-3.1` and `google/veo-3.1-fast` to Video Gen. These are zero-code drop-ins: `runVideo` hands `model.id` straight to the `LongRunWorkflow`, which calls `aiRun()` with no per-provider allowlist, and `google` was already in the `Provider` union. They use the same Unified Billing route and the same text-to-video param baseline (8s / 16:9 / 720p / audio) as the preserved `veo-3` / `veo-3-fast` entries.

Note on history: Veo 3.1 previously shipped as a BYOK path and was removed in v0.14.0. This re-add is on the Unified Billing side (no `byok_alias`, keyless `provider: "google"`), the same shape v0.14.0 explicitly preserved for `veo-3`, so it is consistent with that consolidation rather than a reversal of it.

### OpenAI proxied chat (non-streaming)

Added `openai/gpt-5.5`, `openai/gpt-5.4`, `openai/gpt-5.4-mini`, and `openai/o4-mini`, all `provider: "openai"`, via Cloudflare Unified Billing. They route through the generic `else` branch in `runChat` (`aiRun(env, model.id, { messages })`), the same call surface as the Workers AI hosted chat models, with no OpenAI dispatch helper and no `OPENAI_API_KEY` secret.

This is a deliberate re-introduction. OpenAI chat shipped as BYOK in v0.11.0 (GPT-5.5 / 5.4 / 5.4 mini / 4.1) and was removed in v0.14.0, which dropped all non-Anthropic/xAI/Bedrock BYOK paths to consolidate around "Anthropic + xAI + Bedrock BYOK and Unified Billing for everything else." These entries come back on the Unified Billing side of that decision; the BYOK path stays gone. Future readers seeing `openai/gpt-5.5` return three releases after a breaking removal: this is why.

Two deliberate constraints:

- **Non-streaming.** The streaming gate (`handleChatStream`) returns `501` for provider `openai` because there is no OpenAI SSE parser yet, so a stream request can't slip through to a parser that doesn't exist. `streaming` is left off the entries; the picker routes them to `POST /api/chat`.
- **`capabilities: []` (no vision).** Multimodal input through the proxied binding is unverified, so the attach affordance stays off rather than offering something that might 502 on an image.

### Refactor: `extractOutput` / `extractUsage` -> `src/output-extract.ts`

Pulled both pure functions out of `src/index.ts` into a new `src/output-extract.ts`, imported back in. The motivation is testability: `src/index.ts` imports `cloudflare:workers`, which can't load under the plain-Node vitest pool, so the functions couldn't be unit-tested in place (the same reason parsers, chunking, and ai-binding were extracted earlier). Behavior is unchanged; the only edit to the logic was a clarifying comment on the OpenAI Responses-API branch. The whole OpenAI re-introduction rests on these two functions parsing the OpenAI shapes correctly, so locking them with tests was the point.

New `tests/output-extract.test.ts` (17 tests). Load-bearing cases are the two OpenAI shapes (chat-completions `{choices[0].message.content}` and Responses API `{output[].content[]}`). The rest is regression coverage that the extraction didn't alter the Anthropic / Bedrock / Workers AI shapes, plus a guard that the array-shaped Responses `output` and the object-shaped Bedrock `output` don't cross-fire.

### Touch points

- `src/models.ts`: `"openai"` added to the `Provider` union; seven new entries (Opus 4.8, Veo 3.1, Veo 3.1 Fast, and the four OpenAI chat models).
- `src/output-extract.ts`: new. `extractOutput` + `extractUsage`, moved verbatim modulo `export` and the one comment.
- `src/index.ts`: import added; the two inline function definitions removed (replaced with a pointer comment).
- `tests/output-extract.test.ts`: new, 17 tests.
- `README.md`: chat catalog now 37 models / 5 providers / 32 stream-capable; Opus 4.8 and the OpenAI line added; new "OpenAI models (Unified Billing)" section; Veo 3.1 in the video summary and the availability matrix.
- `package.json`: 0.20.4 -> 0.21.0.

Worker typecheck clean. Worker tests: 112/112 (95 prior + 17 new).

### Outstanding (carried in the v0.21.0 session notes)

1. **Live-verify the OpenAI response shape before trusting OpenAI chat in prod.** **[Resolved in v0.21.1]** Confirmed live: non-streaming returns the `{choices}` shape and streaming returns parseable frames with usage. The tests prove that *if* `env.AI.run("openai/gpt-5.5", { messages })` returns the `{choices}` shape, it parses; they can't prove the shape. One live call against the deployed worker settles it: `curl -sS https://<host>/api/chat -H 'content-type: application/json' -d '{"model":"openai/gpt-5.5","user_input":"reply with the single word: pong"}'`. If `output` comes back as a JSON blob, the proxied shape differs; capture it and add a branch plus a test. (v0.11.0 ran OpenAI through the gateway's OpenAI proxy and the `{choices}` branch handled it then, so confidence is reasonable, but that path was BYOK-proxy and this one is Unified Billing `env.AI.run`.)
2. **Gemini deferred.** Its native shape (`candidates[].content.parts[].text`, `usageMetadata.*`) isn't handled by `extractOutput`/`extractUsage`. Whether the binding normalizes it to OpenAI shape is an open question; resolve that (CF AI-binding docs or one live call) and add the branches with tests before adding any `google/gemini-*` entries. `google` is already in the union, so those are catalog-only once parsing is confirmed.
3. **OpenAI streaming** (optional, larger): an OpenAI SSE parser under `src/parsers/`, wired into `runChatStream`, then open the gate for provider `openai` and flip `streaming: true`. **[Done in v0.21.1.]**

## v0.20.4

Frontend Discord import button, plus a correction to the migration guidance in the v0.20.2 and v0.20.3 notes below. The DCE import shipped in v0.20.3 as a curl-only endpoint; this release adds a file picker so importing an export is a click, which is what makes validating the parser against a real export practical.

### Correction to v0.20.2 / v0.20.3 migration notes

Those entries claimed re-running the full `schema.sql` against an existing database produces a "non-fatal warning that wrangler continues past." That is wrong. `wrangler d1 execute --file` runs the whole file as a single transaction; a non-idempotent statement (e.g. `ALTER TABLE chats ADD COLUMN project_id` when the column already exists) raises `SQLITE_ERROR: duplicate column name` and aborts the entire transaction, rolling back every statement in the file including the ones you actually needed.

The correct pattern, used from v0.20.3's migration onward: ship a per-release delta file (`migrate-vX.Y.Z.sql`) containing only that release's new statements, and run that. `schema.sql` remains the canonical full schema for standing up a fresh database, but is never re-run against an existing one. v0.20.3's `migrate-v0.20.3.sql` (project_messages + the four chunks columns, no chats.project_id) is the reference example.

v0.20.4 itself adds no schema, so it ships no migration file.

### Import button

Added to the project documents modal (the "docs" action on a project row), below the document checkbox list:

- "choose JSON export" button opens a file picker scoped to .json.
- An "include bot messages" checkbox (default on) maps to the import's includeBots option.
- On selection, the file is read as base64 in-browser and POSTed to the v0.20.3 endpoint `POST /api/projects/:id/import-discord`.
- A status line reports progress (reading / importing) and the result: channel, imported message count, chunk count, and how many system/empty messages were skipped. Errors (bad file, parse failure, embedding failure) surface inline in red rather than as an alert.
- On success the doc list and sidebar project counts refresh in place; the imported export appears as a new attached document.

No worker changes; the endpoint already existed. The button is a client of it.

### Touch points

- `public/index.html`: import section markup in the docs modal (button, bots checkbox, hidden file input, status div).
- `public/app.js`: element refs, `renderDocsPickerList` extracted from `openDocsPicker` for in-place refresh, `handleDiscordImportFile` (FileReader -> base64 -> POST -> refresh), button/file listeners.
- `public/styles.css`: import section, button, status (ok/error variants).
- `package.json`: 0.20.3 -> 0.20.4.

No new dependencies, no schema, no worker change, no migration. Worker tests: 95/95 unchanged.

### Smoke test (browser)

1. Open a project's "docs" modal. The "import a Discord export" section appears below the document list.
2. Click "choose JSON export", pick a DCE export. Status shows "reading...", then "importing...", then a green summary line.
3. The export appears as a checked document in the list above; the sidebar project doc count increments.
4. Start a chat with that project active and use_docs on; ask about the channel's content. Retrieved chunks should include the imported conversation.
5. Error path: pick a non-DCE JSON (or any .json that isn't an export). Status shows a red parse error; nothing is added.

### What's next

- v0.20.5: retrieval filters (author / channel / date), reading the chunk metadata columns v0.20.3 added. Deferred deliberately so the filter UI is designed against the shape of real imported data.
- v0.20.6: presigned R2 upload for exports over the 10MB worker request limit.

## v0.20.3

Discord ingestion: import a DiscordChatExporter (DCE) JSON export into a project, parse it into messages, chunk it conversation-aware, and embed it into the project's retrieval scope. Backend only; the import is curl-driven for now, with a frontend file-picker button planned for v0.20.4 alongside the retrieval filters.

This is the first half of the original v0.20.3 scope. Retrieval filters (author/channel/date) and presigned R2 upload for large exports move to v0.20.4.

### What it does

A DCE JSON export (one channel, exported WITHOUT `--markdown false` so mentions/emoji render readably) is uploaded to a project. The worker parses it into normalized messages, groups consecutive messages into conversation units, formats each unit as a readable transcript, embeds those, and attaches the result to the project so project-scoped chat retrieval picks it up immediately.

The DCE JSON schema was verified against the JsonMessageWriter source and documented CSV column set (as of the Feb 2026 DCE index) rather than from memory, since the parser is load-bearing. The parser is defensive: it validates the top-level shape and throws a diagnostic error naming the problem instead of producing garbage chunks.

### New module: src/discord.ts

Standalone, fully unit-tested (17 tests). Two public functions:

`parseDiscordExport(json)` -> normalized messages. Resolves channel name (category / name when both present), uses author nickname when set else name, marks bot messages, keeps Default + Reply message types, drops system notifications (joins, pins, thread-created, calls, etc.) and empty-content (attachment-only) messages. Handles migrated usernames (discriminator "0"). Throws on non-DCE input.

`chunkDiscordMessages(messages, options)` -> conversation chunks. Groups consecutive same-channel messages into a unit; a gap over `gapMinutes` (default 15) or a channel change starts a new unit. Each chunk is formatted with a channel header and `Author (timestamp): content` lines. Units over `targetChars` (default 1000) split on message boundaries with the header repeated; a single oversized message is hard-split on word boundaries. Each chunk carries channel, distinct authors (first-seen order), and time range metadata. `includeBots` (default true) keeps bot messages.

Defaults that are tuning knobs, not laws: 15-minute conversation gap (DCE's own HTML export groups same-author messages within 7 minutes, but this chunker groups across authors so a wider gap fits), 1000-char target (2x the 500-char document default, since conversation units benefit from more context), include bots (MUDD likely uses bots for game mechanics). All overridable per-import via the options body.

### Schema

`project_messages` table: raw parsed messages, first-class, so the corpus can be re-chunked later (e.g. with an improved chunker) without re-uploading. Retrieval does NOT read this table; it reads chunks. The table is purely for re-processing and audit. Tied to both project and document, cascading on delete of either.

Four nullable columns added to `chunks`: `channel`, `authors`, `sent_at_start`, `sent_at_end`. Document chunks leave these NULL; Discord chunks populate them. The v0.20.4 retrieval filters read these. As with v0.20.2's `chats.project_id`, the ALTER statements aren't idempotent in SQLite. **[Corrected in v0.20.4]** This entry originally said re-applying schema.sql surfaces warnings wrangler treats as non-fatal; that is wrong (a duplicate-column ALTER aborts the whole transaction). Apply schema changes via the per-release delta file `migrate-v0.20.3.sql`, never by re-running `schema.sql` against an existing database.

### New endpoint

```
POST /api/projects/:id/import-discord
Body: { filename?, data: base64, options?: { gapMinutes, includeBots } }
Response: { document_id, project_id, guild, channel,
            raw_message_count, imported_message_count, chunk_count }
```

Pipeline mirrors handleDocumentUpload: validate project ownership, decode + size-check, parse, chunk, store the export in R2, insert a documents row, attach it to the project, persist raw messages to project_messages, embed chunks and upsert to Vectorize, insert chunk rows with the metadata columns. Full rollback on embedding failure (vectors, project_messages, project_documents, documents row, R2 object).

The chunk embed/store loop is a deliberate near-duplicate of handleDocumentUpload's rather than a shared helper: the document path is higher-traffic and has no integration tests, so refactoring it to share code risks regression disproportionate to ~30 saved lines. Consolidation is noted as a future cleanup once integration tests exist.

### Cascade updates

`handleDocumentDelete` now also deletes `project_messages` for the document. `handleProjectDelete` now also deletes `project_messages` for the project. Both keep behavior consistent with the existing membership cascades.

### Touch points

- `src/discord.ts`: new, 320 lines. Parser + chunker.
- `tests/discord.test.ts`: new, 17 tests covering parse filtering, nickname resolution, bot marking, reply handling, malformed input, channel grouping, gap splitting, oversized-message splitting, author ordering, time ranges, includeBots.
- `src/index.ts`: 3474 -> ~3700 lines. Import, handleDiscordImport, route registration, two cascade additions.
- `schema.sql`: 191 -> 237 lines. project_messages table + two indexes, four chunks columns.
- `package.json`: 0.20.2 -> 0.20.3.

No new dependencies. No new bindings. Worker tests: 95/95 pass (78 prior + 17 new).

### Apply order

```
patch -p1 < v0.20.3-schema.patch
wrangler d1 execute skyphusion-llm --remote --file=schema.sql
patch -p1 < v0.20.3-discord-ts.patch
patch -p1 < v0.20.3-discord-test.patch
patch -p1 < v0.20.3-worker.patch
patch -p1 < v0.20.3-changelog.patch
npm test && npm run typecheck
patch -p1 < v0.20.3-package-json.patch
```

### Smoke test (curl, with a real export)

```
TOKEN=$(cloudflared access token --app=https://skyphusion.org)
B64=$(base64 -w0 mudd-export.json)
printf '{"filename":"mudd-export.json","data":"%s"}' "$B64" > /tmp/import-body.json
curl -X POST https://skyphusion.org/api/projects/<PID>/import-discord \
  -H "cf-access-token: $TOKEN" \
  -H "content-type: application/json" \
  --data @/tmp/import-body.json
```

Expect a summary with raw_message_count, imported_message_count, and chunk_count. Then query the project with use_docs to confirm Discord chunks are retrieved:

```
curl -X POST https://skyphusion.org/api/chat \
  -H "cf-access-token: $TOKEN" -H "content-type: application/json" \
  -d '{"model":"@cf/meta/llama-3.2-3b-instruct","user_input":"<question about the channel>","project_id":<PID>,"use_docs":true}' \
  | jq '.retrieved_chunks | map({document_id, filename, chunk_index})'
```

### What's next: v0.20.4

- Frontend "import Discord export" button in the project view (file picker -> base64 -> this endpoint).
- Retrieval filters on the chat request: author / channel / date range, reading the chunk metadata columns this release added.
- Presigned R2 upload for exports over the 10MB worker request limit.

## v0.20.2

Conversation -> project association. Chats started while a project is active now persist that project_id; the sidebar shows a project chip on each conversation; conversations can be moved between projects (or out of any project) via a per-row dropdown. Half of the original v0.20.2 scope; Discord JSON ingestion moves to v0.20.3.

### Why the split

Original v0.20.2 was scoped at 5-7 days (Discord ingestion + conversation association + retrieval filters + presigned uploads). That breaks the 1-3 day release cadence. Splitting at the natural seam:

- v0.20.2 (this release): conversation association. Small, well-defined, makes the sidebar feel project-aware. No new tables; one column added.
- v0.20.3 (next sprint): Discord ingestion stack. New table, JSON parser, conversation-aware chunker, retrieval filters, presigned upload for >10MB exports.

The two are independent and don't share code paths.

### Schema

One column added to `chats`, one partial index:

```sql
ALTER TABLE chats ADD COLUMN project_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_chats_project
  ON chats(project_id, created_at DESC) WHERE project_id IS NOT NULL;
```

`ALTER TABLE ADD COLUMN` is NOT idempotent in SQLite (no `IF NOT EXISTS` syntax for it). **[Corrected in v0.20.4]** This entry originally claimed re-applying `schema.sql` against an already-migrated DB produces a non-fatal warning that wrangler continues past. That is wrong: `wrangler d1 execute --file` runs the whole file as one transaction, so a duplicate-column `ALTER` raises `SQLITE_ERROR` and aborts the entire transaction, rolling back every statement. Do not re-run `schema.sql` against an existing database. The correct path is a per-release delta file containing only the new statements; see the v0.20.4 entry and the "Migrating an existing deployment" section of the README.

Pre-v0.20.2 chats carry `project_id = NULL` and continue to work unchanged. The column is nullable; there's no migration to backfill historical chats.

### Worker

`PersistArgs` interface gains `project_id?: number | null`. The `INSERT INTO chats` statement gains the `project_id` column and bind value. Both `runChat` and `runChatStream` pass `project_id: scopedProjectId ?? null` from their existing `resolveProjectForChat()` result. Non-chat dispatchers (image, TTS, video, music, STT) don't pass project_id, so non-chat rows continue to carry NULL.

`handleConversationList` gains a subquery selecting the conversation's first turn's `project_id` and returns it on each row. The convention: a conversation's "project membership" is the project_id of its first turn. The move endpoint updates ALL turns atomically, so within a single conversation this value is uniform; reads need only the first turn.

New endpoint:

```
PATCH /api/conversations/:id/project
Body: { project_id: number | null }
Response: { conversation_id, project_id, rows_updated }
```

Validation:
- `project_id = null` clears the assignment.
- `project_id = positive integer`: project must exist and be owned by the same user. Cross-user / unknown project_id returns 404.
- The conversation itself must exist and be owned by the user. Stale conversation_id returns 404 rather than silently no-oping.

The actual mutation is one statement: `UPDATE chats SET project_id = ? WHERE conversation_id = ? AND user_email = ?`. All turns in the conversation are updated in one DB call.

### Frontend

Conversation rows in the sidebar:

- Show a small project chip (`.conv-proj-chip`) when the conversation's first turn has `project_id`. The chip resolves the id to a name from the cached `state.projects` list, avoiding an extra API call per row.
- Stale chip (project deleted) renders muted (`.conv-proj-chip-stale`) with the placeholder text "project" rather than blowing up.
- A new "move" button (^ arrow) appears on hover. Clicking opens a dropdown menu (`.move-menu`) listing "(no project)" plus every project the user has, with the current selection highlighted (.current with a checkmark).

The dropdown:

- Position-attached to the move button via `position: fixed` with `getBoundingClientRect()` coordinates. Appended to `<body>` so the sidebar's overflow doesn't clip it.
- Flips above the button when there's not enough room below.
- Closes on outside click, Escape key, or selecting an item.
- Outside-click listener is registered on `setTimeout(..., 0)` so the click that opened the menu doesn't immediately close it.

`moveConversationToProject(convId, projectId)` PATCHes the new endpoint, then re-runs `loadConversations()` to refresh the list.

Chats started while a project is active already include `project_id` in the chat request body (v0.20.1 wiring). What changed in v0.20.2 is that the worker now PERSISTS this field on the chat row.

### Touch points

- `schema.sql`: 161 -> 191 lines (+30). Column add + partial index.
- `src/index.ts`: 3391 -> 3474 lines (+83). PersistArgs field, INSERT extension, two persistChat call sites, conversation list subquery + result type, handleConversationMoveToProject (new), route registration.
- `public/app.js`: 1781 -> 1911 lines (+130). Chip rendering in loadConversations, move button + handler in history-list listener, move-menu open/close/render/PATCH functions appended at end.
- `public/styles.css`: 1387 -> 1489 lines (+102). Chip and stale-chip variants, move button, move-menu dropdown.
- `package.json`: 0.20.1.1 -> 0.20.2.

No new dependencies. No new bindings. No new secrets. 78/78 tests still pass.

### Smoke test (manual)

After deploying v0.20.2 (apply schema first):

1. Start a NEW chat with MUDD project active. Submit a turn. Refresh the page.
2. The conversation appears in the sidebar with the "MUDD" chip visible next to the preview.
3. Open a different chat that has NO project_id (any pre-v0.20.2 conversation). Hover the row -> the ^ button appears at the right.
4. Click ^ -> dropdown opens below the button with "(no project)" highlighted and "MUDD" as an option.
5. Click "MUDD" -> dropdown closes. The chip appears on that row.
6. Click ^ again -> dropdown opens; "MUDD" is now highlighted (checkmark).
7. Click "(no project)" -> chip disappears.
8. Delete the MUDD project. Refresh. Any conversation previously tagged with MUDD now shows a muted "project" chip (stale).

### curl verification

```bash
WORKER=https://your-worker

# Move conversation to project 1
curl -X PATCH $WORKER/api/conversations/<conv-id>/project \
  -H "content-type: application/json" \
  -d '{"project_id":1}'
# Expect { conversation_id, project_id: 1, rows_updated: N }

# Clear assignment
curl -X PATCH $WORKER/api/conversations/<conv-id>/project \
  -H "content-type: application/json" \
  -d '{"project_id":null}'
# Expect { conversation_id, project_id: null, rows_updated: N }

# Bad project_id
curl -X PATCH $WORKER/api/conversations/<conv-id>/project \
  -H "content-type: application/json" \
  -d '{"project_id":99999}'
# Expect 404 {"error":"Project not found"}

# Verify list returns project_id
curl $WORKER/api/conversations | jq '.conversations[] | {conversation_id, first_input, project_id}'
```

### What's next: v0.20.3

- New `project_messages` table for raw Discord rows (author, channel, timestamp, content).
- Apify and DiscordChatExporter JSON shape parsers.
- Conversation-aware chunker that groups messages by author+time+topic boundaries, rather than the current naive token-window split.
- Optional retrieval filters: `?author=`, `?channel=`, `?after=`, `?before=` on the chat request body so Megan can ask "what did Player1 say about the underground city last week?".
- Presigned R2 upload for Discord exports larger than the worker request limit (~10MB).

Bake v0.20.2 first. Megan should be able to tag her chats by project before adding Discord ingestion on top.

## v0.20.1.1

Hotfix: modals were always-visible after v0.20.1 deploy, including immediately on page load with no way to dismiss them. Bug found by Conrad right after deploying v0.20.1.

### The bug

In v0.20.1's CSS, the `.modal { display: flex }` rule overrode the user-agent stylesheet's `[hidden] { display: none }`, which meant modals rendered always regardless of whether the JS set `el.hidden = true`. The JS hide/show logic was correct (every `openX()` and `closeX()` function set `.hidden` appropriately), but the CSS specificity made the JS state irrelevant to the rendered DOM.

Same bug on `.active-project-chip` (`display: inline-flex`).

### The fix

Two CSS rules added, three lines total:

```css
.modal[hidden] { display: none; }
.active-project-chip[hidden] { display: none; }
```

The `[hidden]` attribute selector beats the unqualified class selector, so the hidden contract is restored. Every existing JS call to `el.hidden = true` immediately works again.

### Touch points

- `public/styles.css`: 1387 -> 1398 lines (+11; two attribute-selector rules with explanatory comments).
- `package.json`: version bump 0.20.1 -> 0.20.1.1.

No JS changes, no HTML changes, no worker changes. No new tests. The fix is pure CSS.

### Lesson

When using the `hidden` HTML attribute as the toggle for an element, any CSS rule that sets `display: <anything other than initial/inherit>` on that element MUST be paired with `el[hidden] { display: none }`. Better default for future modals/chips: lead with the attribute-respect rule, then the layout rule, in that order.

## v0.20.1

Second half of projects + knowledge stores: frontend UI. The backend from v0.20.0 was verified end-to-end via curl before this work started (5/5 chunks correctly scoped to a single attached document on prod). v0.20.1 makes the feature usable through the browser.

Also fixes one bug found during v0.20.0 testing: `handleDocumentDelete` did not cascade to `project_documents`, so deleting a document that was attached to a project would leave an orphan membership row pointing at a non-existent document.

### UI surface

**Sidebar projects section** (between history and documents):
- List of all projects with name + document count.
- Active project is visually highlighted (left-edge accent bar).
- Hovering a row reveals `docs` and `edit` action buttons.
- `+ new` button at the section header opens the project modal in create mode.
- Empty state ("no projects yet...") when the user has no projects.

**Active project chip** (next to the model picker in the composer):
- Visible only when a project is active.
- Shows `project: <name>` with an `x` to clear.
- Chat requests automatically include `project_id` while active (chat-type models only; the field is silently dropped server-side for non-chat).

**Project modal** (create + edit, single component):
- Fields: name (required, max 200), description, system prompt.
- Cmd/Ctrl+Enter from any field submits.
- Edit mode adds a Delete button (deletes the project; documents stay).
- Modal closes on Escape, backdrop click, Cancel, or successful save.

**Document picker modal** (manage which docs belong to a project):
- Opens via the `docs` action button on a project row.
- Shows ALL the user's documents as checkboxes; ticking attaches, unticking detaches.
- Each toggle is sent immediately (no batched save). Project doc counts in the sidebar update live as the picker is used.
- Empty state ("no documents uploaded yet...") when the user has no documents.

### Persistence

The active project id is stored in `localStorage` under `skyphusion.activeProjectId`. On page load:
- If the saved id matches an existing project, that project becomes active automatically.
- If the saved id is stale (project deleted in another tab, etc.), the key is silently cleared.
- If `localStorage` is unavailable (private mode, denied permissions), the feature degrades to in-memory-only without errors.

### Chat integration

The `run()` function in `app.js` was extended to include `project_id` in the chat request body when a project is active and the current model is `type: "chat"`. Other model types (image gen, TTS, video, music, STT) drop the field server-side regardless; the frontend doesn't need to gate on type.

### Backend bug fix

`handleDocumentDelete` now includes a `DELETE FROM project_documents WHERE document_id = ?` in its cascade batch. Prior to this, deleting a doc that was attached to one or more projects left orphan rows in the join table. Those rows were harmless to retrieval (the chunks JOIN to documents would drop them when the doc was gone) but cluttered the DB and could show up in raw queries. The cascade is now consistent with project deletion's handling of memberships.

### Touch points

- `public/app.js`: 1391 -> 1781 lines (+390). New section for projects state, API helpers, renderers, modal handlers, document picker, localStorage persistence, and event wiring. One-line addition in `run()` for project_id.
- `public/index.html`: 81 -> 116 lines (+35). Projects section in sidebar, active-project chip in composer, two modal blocks before `</body>`.
- `public/styles.css`: 1046 -> 1387 lines (+341). Project list styling, active-project chip, modal scaffolding, document picker.
- `src/index.ts`: 3391 -> 3392 lines (+1 net; +3 lines for the cascade, +1 comment line, -2 lines collapsed). `handleDocumentDelete` cascade fix.
- `package.json`: version bump 0.20.0 -> 0.20.1.

No new dependencies. No new D1 migrations. No new R2 prefixes. No new secrets. Worker tests: 78/78 still pass.

### Smoke test (manual, browser)

After deploying v0.20.1:

1. Open the app in a browser. Empty Projects section appears in the sidebar with "no projects yet..." message.
2. Click `+ new`. Modal opens. Fill name "MUDD", system prompt "You are a creative writing collaborator. Write scenes in second person." Save.
3. Project appears in the list, becomes active, the chip appears next to the model picker.
4. Upload a document via the existing Documents section.
5. Click `docs` on the MUDD project row. Picker opens. Tick the doc. Watch the doc count in the sidebar go from "0 docs" to "1 doc".
6. Click `done` to close picker.
7. Pick a chat model, type a prompt that matches the doc content, submit. Verify:
   - The response reflects the project system prompt (second-person scene description).
   - The retrieved chunks (visible in the transcript if present) come only from the attached doc.
8. Click the `x` on the project chip to clear. Chip disappears.
9. Click MUDD again in the sidebar to reactivate. Chip reappears.
10. Reload the page. MUDD should still be active (localStorage worked).
11. Click `edit` on MUDD. Rename to "MUDD: Worldbuilding". Save. Sidebar updates.
12. Click `edit` again. Click `delete`. Confirm. Project disappears; doc stays in Documents section.
13. (Cascade fix verification) Upload another doc. Attach to a new project. Then delete the doc. Verify the project's `docs` count drops to 0 (the orphan row would have kept it at 1 before this fix).

### What's next: v0.20.2

- Discord JSON ingestion (Apify shape) with conversation-aware chunking.
- Conversation `project_id` association (chats inherit the active project when started); "move chat to project" affordance in the conversation list.
- Save-output-to-knowledge: image gen / FLUX output can be saved into a project's doc set (metadata only for v0.20.2; thumbnail rendering deferred).

## v0.20.0

First half of the projects + knowledge stores feature: schema, worker API, and RAG project-scoping. **Backend only; no UI yet.** v0.20.1 adds the frontend. v0.20.0 is testable end-to-end with curl; running the migration against a production DB is safe (additive schema only).

This release was scoped as "stage 1 of v0.20.0" rather than the full feature because shipping the backend alone bakes independently. A schema or scoping bug caught at this stage doesn't cascade into UI work that depended on it.

### What a project is

A project groups documents (and in v0.20.1+, conversations) under a shared system prompt and retrieval scope. Documents can belong to multiple projects (many-to-many via `project_documents`). Each user has private projects scoped by `user_email`; cross-user access is rejected at the route layer.

The intended use case: split organizational contexts. A legal-research project bundles case PDFs and a system prompt that frames the assistant as a paralegal; a worldbuilding project bundles fiction notes and frames it as a creative collaborator. The same documents can live in both projects if you want them to.

### Schema (`schema.sql`)

Two new tables appended. The file is still a single `schema.sql` (no migration sequence), applied via `wrangler d1 execute --file=schema.sql`. New tables use `CREATE TABLE IF NOT EXISTS` so applying against an existing database is idempotent.

```sql
CREATE TABLE projects (
  id, user_email, name, slug, description, system_prompt,
  created_at, updated_at
);
CREATE UNIQUE INDEX idx_projects_slug_user ON projects(user_email, slug);

CREATE TABLE project_documents (
  project_id, document_id, added_at,
  PRIMARY KEY (project_id, document_id)
);
```

Slug is per-user-unique (two different users can both have `mudd`). Slug is derived from name at create time and stable across renames so URLs/storage keys don't shift if the user later renames "MUDD" to "MUDD: Worldbuilding".

### Worker API

Eight new endpoints, two modified endpoints. All scope by `user_email`; cross-user reads return 404, cross-user writes 400. Project handlers live next to the document handlers in `src/index.ts`.

```
GET    /api/projects                          list projects + document counts
POST   /api/projects                          create (body: {name, description?, system_prompt?})
GET    /api/projects/:id                      get project + its documents
PATCH  /api/projects/:id                      update name/description/system_prompt
DELETE /api/projects/:id                      cascade-delete memberships, keep documents
POST   /api/projects/:pid/documents/:did      attach document to project
DELETE /api/projects/:pid/documents/:did      detach document from project
GET    /api/documents?project_id=N            scope document list to project
POST   /api/chat        (accepts project_id)  project-aware chat (see below)
POST   /api/chat/stream (accepts project_id)  same, streaming
```

### Chat dispatch changes

`ChatRequest` gains an optional `project_id: number` field. Both `runChat` and `runChatStream` now call `resolveProjectForChat()` near the top of the function, which:

1. Looks up the project row (scoped to `user_email`). Unknown / cross-user `project_id` is logged and treated as no-project; the chat completes normally instead of erroring.
2. Computes the effective system prompt:
   - Per-turn `system_prompt` (after trim, non-empty): wins outright.
   - Otherwise, if a project resolved and its `system_prompt` is non-null: use that.
   - Otherwise: undefined (no system prompt).
3. Returns `scopedProjectId` for `retrieveContext`.

The effective prompt is mutated back onto `body.system_prompt` so all downstream code (provider call, persistence, conversation history) sees the same string. Project prompt changes do not retroactively edit older turns: each chat row persists what was actually sent.

### Retrieval scoping (`retrieveContext`)

When `projectId` is set:
- Vectorize is queried with `topK * 3` (overfetch) since project filtering happens in D1 after.
- The D1 join adds `JOIN project_documents pd ON pd.document_id = d.id` and filters by `pd.project_id = ?`.
- The output is then capped back to the caller's `topK` so chat-prompt size doesn't grow.

Without `projectId`, behavior is unchanged from v0.19.5: full-corpus retrieval scoped only by `user_email`. Existing chat requests that don't send `project_id` keep working identically.

The error-path message now distinguishes the two reasons for a Vectorize-matches-but-D1-empty result: (a) `user_email` mismatch, (b) project has no matching member documents. Both surface in `console.warn`.

### Slug allocation

`slugify("MUDD: Worldbuilding")` returns `"mudd-worldbuilding"`. Collision handling: if the slug is already taken for this user, suffix with `-2`, `-3`, etc. Bounded at 200 attempts; beyond that, the create handler throws (would indicate a degenerate input or pathological state).

### Touch points

- `schema.sql`: 99 -> 161 lines (+62). `projects` + `project_documents` tables and three indexes appended.
- `src/index.ts`: 2939 -> 3391 lines (+452). Project handlers, `resolveProjectForChat` helper, slugify + findFreeSlug helpers, retrieveContext scoping, project_id in chat dispatch, route registration, ProjectRow type.
- `package.json`: version bump 0.19.5 -> 0.20.0.

No new dependencies. No new secrets. No new bindings. Existing 78 tests still pass; the new code paths are exercised via the curl smoke test below since route handler tests aren't part of the suite.

### Smoke test (apply order matters)

1. Apply schema first: `wrangler d1 execute YOUR_DB --remote --file=schema.sql` (or `--local` for wrangler dev).
2. Deploy the worker.
3. Create a project:
   ```bash
   curl -X POST https://your-worker/api/projects \
     -H "content-type: application/json" \
     -d '{"name":"MUDD","description":"MUDD worldbuilding","system_prompt":"You are a creative writing collaborator helping flesh out a Discord-based interactive fiction world. Write in second person when describing scenes."}'
   ```
   Expect 201 with the project object including `id`, `slug` ("mudd"), and timestamps.

4. List projects: `curl https://your-worker/api/projects` - should show the new project with `document_count: 0`.

5. Pick an existing document id, attach it: `curl -X POST https://your-worker/api/projects/1/documents/5` (project id 1, doc id 5). Confirm via GET.

6. Send a chat with `project_id`:
   ```bash
   curl -X POST https://your-worker/api/chat \
     -H "content-type: application/json" \
     -d '{"model":"@cf/meta/llama-3.2-3b-instruct","user_input":"Describe the entrance to the underground city.","project_id":1,"use_docs":true}'
   ```
   The assistant response should reflect the project's system prompt (second-person scene description). Retrieved context (if any) should come only from the attached doc, not all your other docs.

7. Try a cross-user attack: create a project as user A, then with user B's auth, GET `/api/projects/<A's id>`. Should return 404.

8. Delete the project: `curl -X DELETE https://your-worker/api/projects/1`. Confirm the document still exists in `/api/documents`.

### What's next: v0.20.1 (frontend)

- Sidebar `Projects` section above `Documents`, listing existing projects.
- "+ new project" button -> modal with name/description/system_prompt.
- Click a project to expand: shows its docs, the system prompt (editable inline), and a "+ attach doc" picker.
- Composer shows a subtle indicator when a project is active ("project: MUDD"); send button includes `project_id` in the chat request.
- "New chat in this project" button in the project view; new conversations started while a project is selected auto-include the project_id.

After v0.20.1, v0.20.2 takes on Discord JSON ingestion + conversation-aware chunking.

## v0.19.5

Frontend-only release: adds drag-and-drop and clipboard-paste attachment paths, and fixes a latent guard in `handleFiles` that silently dropped attachments for STT and FLUX-2 image gen despite the UI showing the attach affordance.

### Drag-and-drop + paste

Two new ways to attach files:

- **Drag-and-drop**: drag any file onto the input area. While dragging, the input area gets a blue inset border and a "drop to attach" label in the upper-right corner. Drop anywhere in the input area to attach. Works for images (downscaled to 1280px for vision, 512px for FLUX-2 references), audio (becomes auto-transcribed input or STT source), and video (frame-extracted for vision-capable chat, or full file for Pegasus).
- **Paste**: paste images directly into the textarea (Cmd/Ctrl-V). Most common case is pasting a screenshot from Cmd/Ctrl-Shift-4 on macOS or the equivalent on Linux/Windows. Pure-text pastes pass through to the textarea normally; only paste events that contain a file are intercepted.

Both paths funnel into the existing `handleFiles()` function. All validation, size limits, downscaling, frame extraction, Pegasus full-video routing, and FLUX-2 reference-image caps apply identically to drag-drop and paste as they do to the existing attach button.

The drop zone is gated on `attachRow.style.display !== "none"` so models that don't accept attachments (TTS, video gen, music gen, non-FLUX-2 image gen) don't get a misleading drop-zone affordance.

### Bug fix: STT and FLUX-2 attachments

Discovered during the v0.19.5 work: `handleFiles()` had a top-level guard `if (m.type !== "chat") return;` that bailed out before the function reached its STT (audio attachment for transcription) and FLUX-2 (reference image for image gen) branches. The UI was showing the attach button for both model types (per `updateAffordance`), but clicking it and choosing a file resulted in a silent no-op because the click path went through `handleFiles`, which returned early.

The fix extends the guard to allow chat + STT + FLUX-2:

```js
const isFlux2 = m.id.startsWith("@cf/black-forest-labs/flux-2-");
if (m.type !== "chat" && m.type !== "stt" && !isFlux2) return;
```

This restores the behavior the UI was already advertising. The inner FLUX-2 image-handling branch (already present in the function but unreachable) now actually runs.

### Touch points

- `public/app.js`: 1310 -> 1391 lines (+81). One DOM reference added, one guard fixed, drag-drop block + paste handler added.
- `public/styles.css`: 1022 -> 1046 lines (+24). `.input-area` gets `position: relative` and a transition; `.input-area.drop-active` rules added for the inset border + "drop to attach" overlay label.
- `package.json`: version bump 0.19.4 -> 0.19.5.

No worker changes. No D1 migration. No R2 migration. No new dependencies. No new worker secrets. Existing 78 tests still pass (no test coverage of frontend; manual smoke test is the verification path).

### Smoke test

Manual checks after deploy:

1. Pick a vision-capable chat model. Drag an image from your file manager onto the input area. Verify the blue border appears during drag and the image shows in the attachment chip strip below the textarea.
2. With the same model, take a screenshot (Cmd/Ctrl-Shift-4) and paste into the textarea. Verify the image is captured as an attachment, not pasted as a filename string.
3. Switch to a TTS model. Try to drag a file onto the input area. Verify no blue border appears and the drop is rejected silently.
4. Switch to FLUX-2 (image gen). Drag a reference image. Verify the attachment chip appears (this would have silently failed in v0.19.4 and earlier).
5. Switch to an STT model. Drag an audio file. Verify the attachment chip appears (also previously silently failing).

### What's next

- v0.20.x: projects + knowledge stores. First v0.20.x sprint will be the schema + project CRUD UI; second sprint adds Discord JSON ingestion and per-project knowledge.

## v0.19.4

Chunking quality pass: replaces the fixed-window chunker with a recursive separator splitter (the LangChain `RecursiveCharacterTextSplitter` shape). Improves retrieval quality on prose-heavy corpora and lays the groundwork for v0.20.x project knowledge stores, where the chunker has to handle worldbuilding fiction and structured reference docs alongside legal documents.

### Why this changed

The previous fixed-window chunker had one design flaw: it searched for natural break points only in the last 1/3 of the 500-char window. If a paragraph break landed earlier (e.g. char 50 of a 500-char window), the chunker ignored it and dumped both paragraphs into one chunk. For inputs with many short paragraphs (Discord exports, dialog, lore notes), that produced chunks that mashed unrelated content together.

The new chunker respects ALL paragraph breaks, then falls back through a separator hierarchy when needed: paragraph -> line -> sentence -> clause -> word -> hard character split. Chunks can be smaller than target when a clean boundary makes them so; the merge step greedily combines adjacent fragments back up to target size with optional tail-overlap.

### Worker

- New `src/chunking.ts` exports `chunkText(text)`. Module-private helpers: `recursiveCharSplit` (separator hierarchy walker) and `mergeFragments` (greedy fragment combiner with tail-overlap). Constants `CHUNK_TARGET_CHARS` (500) and `CHUNK_OVERLAP_CHARS` (50) preserved from the previous implementation; behavior at default settings is similar on well-paragraph'd input but substantially better on Discord-style short-paragraph content.
- `src/index.ts` removes the local `chunkText` function (~30 lines) plus the two chunking constants. Adds one import line for the new module. Net diff: -32 lines.

### Test infrastructure

- `tests/chunking.test.ts`: 13 new tests organized into 6 describe blocks: edge cases (empty/short/exact-target), paragraph boundaries (respected ALL breaks, not just late-window), fallback separator hierarchy (line -> sentence -> word -> hard), overlap behavior, realistic content (worldbuilding paragraph + markdown), and size constraints (no chunk wildly exceeds target).
- Total test count: 65 -> 78. Suite still completes in ~60ms.

### Touch points

- `src/index.ts`: 2971 -> 2939 lines (-32).
- `src/chunking.ts`: new file, 161 lines.
- `tests/chunking.test.ts`: new file, 217 lines.
- `package.json`: version bump 0.19.3 -> 0.19.4.

No D1 migration. No R2 migration. No new dependencies. No new worker secrets. `npm run typecheck` still clean (zero errors).

### One behavior change to be aware of

Existing documents in your D1/Vectorize store were chunked by the old algorithm. They keep working - retrieval against them is unchanged - but their chunk boundaries reflect the old chunker. Re-uploading a document re-chunks it with the new algorithm; the old vectors stay until you delete the old document or re-ingest. If you want consistent chunking quality across an entire corpus, plan to re-ingest important documents at some point. The two coexist fine in the meantime.

### What's next

- v0.19.5: drag-drop + paste attachments (frontend-only, half-day-ish job)
- v0.20.x: projects + knowledge stores (the big feature, ~10-12 days)

## v0.19.3

Final stage of the chat provider dispatcher split. Extracts Workers AI streaming chat dispatch (`callWorkersAIStream`) into `src/providers/workers-ai.ts`, and extracts the env.AI binding wrappers (`aiRun`, `aiLogId`) into `src/ai-binding.ts` since they're used by every Workers AI code path (chat, STT, image gen, TTS, embeddings, the LongRun workflow), not just the chat provider. Also cleans up four stale parser imports that accumulated in `src/index.ts` through v0.19.0-2 extractions.

After v0.19.3, all per-provider chat dispatch logic lives in `src/providers/`, and `src/index.ts` no longer contains any provider-specific code paths for chat models. Non-chat dispatchers (image, TTS, STT, video, music) remain in `src/index.ts`; they entangle with the LongRun workflow and R2/D1 job state and are out of scope for the v0.19.x series.

Note on the Workers AI asymmetry: unlike the other three providers, this module only exports the streaming caller, not a non-streaming caller. Workers AI's non-streaming chat path calls `aiRun(env, model.id, { messages })` directly inline in the dispatch flow with no surrounding helper, so there's no `callWorkersAI` function to extract. Forcing symmetry by introducing a one-line wrapper would add code without adding clarity; the asymmetry honestly reflects the difference in how Workers AI's binding works versus the BYOK providers' direct fetch flow.

### Extraction summary

- `src/ai-binding.ts`: new file, ~30 lines. Exports `aiRun(env, model, params, returnRaw?)` and `aiLogId(env)`. The `RunOpts` and `RunFn` type aliases stay module-private. Used from `src/index.ts` (six call sites across chat, STT, image gen, TTS, embeddings, and the LongRunWorkflow) and from `src/providers/workers-ai.ts`.
- `src/providers/workers-ai.ts`: new file, ~83 lines. Exports `callWorkersAIStream`. Imports `aiRun` from `../ai-binding`, plus the standard parser modules.
- Inline type for the one remaining `env.AI.run` bypass-gateway call site in the image gen path (used for stream-incompatible models that need to skip gateway routing). Three lines of inline `type BypassRunFn` declaration rather than re-exporting `RunFn` from `ai-binding.ts` for a single use.

### Cleanup of stale parser imports

Through v0.19.0-2, `src/index.ts` accumulated four parser-related imports (`parseBedrockEventStreamFrames`, `interpretXaiSSEFrame`, `interpretWorkersAISSEFrame`, `interpretAnthropicSSEFrame`) that became unused as each provider was extracted. They're all removed in v0.19.3. `extractSSEDataPayloads` also removed since `callWorkersAIStream` was its last consumer in the worker entry.

### Touch points

- `src/index.ts`: 3055 -> 2971 lines (-84). One block of 5 stale parser imports collapsed to 0; new imports added for `ai-binding` and `workers-ai`; local `aiRun`/`aiLogId`/`RunOpts`/`RunFn` removed (12 lines); `callWorkersAIStream` section removed (~70 lines); inline `BypassRunFn` type added at one call site (3 lines).
- `src/ai-binding.ts`: new file, 30 lines.
- `src/providers/workers-ai.ts`: new file, 83 lines.
- `package.json`: version bump 0.19.2 -> 0.19.3.

No D1 migration. No R2 migration. No new dependencies. No new worker secrets. All 65 tests still pass. `npm run typecheck` still clean (zero errors).

### v0.19.x series summary

The chat provider dispatcher split is complete. `src/index.ts` has shrunk from 4100 lines (v0.17.2 baseline) to 2971 lines (v0.19.3), a 27% reduction. New layout:

```
src/
  index.ts           (worker entry, dispatch, persistence, RAG, workflow class)
  env.ts             (Env interface)
  types.ts           (InputAttachment family)
  models.ts          (catalog of 59 models)
  utils.ts           (parseDataUrl, base64ToBytes, extFromMime)
  ai-binding.ts      (aiRun, aiLogId)
  parsers/
    types.ts                  (ProviderStreamEvent)
    bedrock-eventstream.ts    (binary frame parser)
    sse-framer.ts             (shared SSE framer)
    xai-sse.ts                (OpenAI-compatible delta interpreter)
    workers-ai-sse.ts         (Workers AI delta interpreter)
    anthropic-sse.ts          (named-event interpreter)
  providers/
    anthropic.ts     (Claude chat: BYOK via AI Gateway)
    xai.ts           (Grok chat: BYOK via AI Gateway)
    bedrock.ts       (Nova chat + Pegasus video-Q&A: AWS SigV4)
    workers-ai.ts    (Workers AI chat: env.AI.run binding)
tests/
  ... (65 tests covering parsers; provider modules untested by design)
```

The architecture supports adding new chat providers by dropping a new file in `src/providers/`; the only worker-entry change needed is an import line and dispatch case.

## v0.19.2

Third stage of the chat provider dispatcher split. Extracts Bedrock chat dispatch (Nova Converse / ConverseStream + Pegasus 1.2 InvokeModel) into `src/providers/bedrock.ts`. Both API paths share AWS SigV4 credential setup, so they live in one module. Also extracts the `InputAttachment` discriminated union into a new `src/types.ts` so providers that consume attachments directly (Pegasus needs the raw video bytes) can typecheck without round-tripping through the worker entry.

This is the most complex extraction of the v0.19.x series:
- Two coexisting API paths (Converse for Nova chat, InvokeModel for Pegasus video-Q&A)
- AWS SigV4 via the `aws4fetch` dynamic import, so the bundle isn't loaded for users who only use other providers
- Pegasus path inspects `InputAttachment[]` directly (finds the `video_full` variant via type predicate), which is why the attachment types had to land in `src/types.ts` first
- Nova streaming pulls from the v0.18.0 binary eventstream parser (`parseBedrockEventStreamFrames`)

### Touch points

- `src/index.ts`: 3370 -> 3055 lines (-315). Removes attachment type definitions (29 lines), the Bedrock Nova section (192 lines), and the Pegasus section (91 lines). Adds import block for `./types` and `./providers/bedrock` (8 lines).
- `src/types.ts`: new file, 42 lines. Five exported types: `InputImageAttachment`, `InputAudioAttachment`, `InputVideoFramesAttachment`, `InputVideoFullAttachment`, `InputAttachment` (discriminated union). PersistedAttachment family stays in `src/index.ts` since only the persistence layer there uses it.
- `src/providers/bedrock.ts`: new file, 259 lines. Exports `callBedrockNova`, `callBedrockNovaStream`, `callBedrockPegasus`. The shared `prepareBedrockNovaRequest` (v0.17.2 dedup) stays module-private.
- `package.json`: version bump 0.19.1 -> 0.19.2.

No D1 migration. No R2 migration. No new dependencies. No new worker secrets. All 65 tests still pass. `npm run typecheck` still clean (zero errors). No behavior change (AWS request signing, Converse API message transform, eventstream parsing, and Pegasus video size validation are byte-equivalent to the v0.19.1 inline implementation).

### What's next

- v0.19.3: `src/providers/workers-ai.ts` (extracts `aiRun` wrapper, `callWorkersAI`, `callWorkersAIStream`). This is the final stage of the chat provider split; after it lands, `src/index.ts` no longer holds any per-provider dispatch logic for chat models. Non-chat dispatchers (image, TTS, STT, video, music) stay in `src/index.ts` for now.

## v0.19.1

Second stage of the chat provider dispatcher split. Extracts xAI chat dispatch (`prepareXaiRequest`, `callXai`, `callXaiStream`) into `src/providers/xai.ts` following the v0.19.0 pattern set by `src/providers/anthropic.ts`. Mechanical extraction; no behavior change.

xAI's API is OpenAI-compatible (same wire format as the underlying GPT spec) so no message transform is needed; the module is meaningfully simpler than the Anthropic one. Imports `Env` from `../env`, `ModelEntry` from `../models`, `ProviderStreamEvent` from `../parsers/types`, and the v0.18.1 SSE pipeline (`extractSSEDataPayloads` + `interpretXaiSSEFrame`) from `../parsers/`.

### Touch points

- `src/index.ts`: 3515 -> 3370 lines (-145). One import line added, full xAI section (comment header + `prepareXaiRequest` + `callXai` + `callXaiStream` plus their helpers) removed.
- `src/providers/xai.ts`: new file, ~154 lines (functions moved verbatim modulo `export` keywords and import block).
- `package.json`: version bump 0.19.0 -> 0.19.1 (patch bump; the scaffolding shipped in v0.19.0, this is a mechanical follow-on).

No D1 migration. No R2 migration. No new dependencies. No new worker secrets. All 65 tests still pass. `npm run typecheck` still clean (zero errors). No behavior change (request building, auth header construction, fetch flow, and SSE pipeline are byte-equivalent to the v0.19.0 inline implementation).

### What's next

- v0.19.2: `src/providers/bedrock.ts` (Nova Converse API + Pegasus 1.2 InvokeModel, both via aws4fetch SigV4)
- v0.19.3: `src/providers/workers-ai.ts` (env.AI.run wrapper, Llama / Qwen / DeepSeek / Mistral / etc.)

Each follows the same shape: import `Env`/`ModelEntry`/`ProviderStreamEvent` + relevant parser modules, export the non-streaming and streaming callers, remove the inline implementation from `src/index.ts`.

## v0.19.0

First stage of the chat provider dispatcher split. Extracts shared scaffolding (`src/env.ts`, `src/utils.ts`) and the first provider (`src/providers/anthropic.ts`) out of `src/index.ts`. v0.19.1-3 land the remaining three chat providers (xAI, Bedrock, Workers AI) following this same pattern; non-chat dispatchers (image, TTS, STT, video, music) stay in `src/index.ts` for now.

Staged this way intentionally: chat providers have well-bounded surface area (request build + transform + fetch + parser), so they can move one at a time with a reversibility point between each release. Non-chat dispatchers entangle with Workflows, R2, and D1 job state, so they need a different approach and are deferred.

### Scaffolding (one-time work, used by all v0.19.x releases)

- New `src/env.ts` exports the `Env` interface. Single authoritative source for the worker's binding shape; all provider modules will import it. Optional secret fields stay optional so deployers can leave BYOK keys unset without TypeScript complaining.
- New `src/utils.ts` exports `parseDataUrl`, `base64ToBytes`, `extFromMime`. Pure helpers with no I/O or env dependencies, callable from any module.
- New `src/providers/` directory holds per-provider chat dispatch modules. Convention: each exports the non-streaming caller (`callX`) and streaming caller (`callXStream`); request builders, transforms, and helper interfaces stay private to the module.

### Anthropic extraction (v0.19.0)

- New `src/providers/anthropic.ts` (~180 lines) owns `prepareAnthropicRequest`, `transformToAnthropic`, `AnthropicMessage` interface (now module-private), `callAnthropic`, and `callAnthropicStream`. Imports `Env` from `../env`, `ModelEntry` from `../models`, `ProviderStreamEvent` from `../parsers/types`, `parseDataUrl` from `../utils`, and the SSE framer + Anthropic interpreter from `../parsers/`.
- `src/index.ts` removes the local `Env` interface (~25 lines), three local utility functions (`parseDataUrl`, `base64ToBytes`, `extFromMime`, ~30 lines), and the entire Anthropic block (`prepareAnthropicRequest`, `callAnthropic`, `AnthropicMessage`, `transformToAnthropic`, `callAnthropicStream` plus their comment headers, ~210 lines). Adds three import statement groups at the top (~3 lines). Net diff: -262 lines.

### Touch points

- `src/index.ts`: 3777 -> 3515 lines (-262).
- `src/env.ts`: new file, ~40 lines.
- `src/utils.ts`: new file, ~60 lines.
- `src/providers/anthropic.ts`: new file, ~180 lines.
- `package.json`: version bump 0.18.4 -> 0.19.0 (minor bump because the new `src/providers/` directory establishes a pattern that v0.19.1-3 extend; contributors will want to know which provider lives where after the split).

No D1 migration. No R2 migration. No new dependencies. No new worker secrets. All 65 tests still pass. `npm run typecheck` still clean (zero errors). No behavior change (code moved verbatim modulo formatting; the Anthropic provider module is byte-equivalent to the v0.18.4 inline implementation plus exports).

### What's deferred to v0.19.1-3

- v0.19.1: `src/providers/xai.ts` (extract `prepareXaiRequest`, `callXai`, `callXaiStream`)
- v0.19.2: `src/providers/bedrock.ts` (extract `prepareBedrockNovaRequest`, `callBedrockNova`, `callBedrockNovaStream`, plus the Pegasus 1.2 video-Q&A dispatcher since it shares the same AWS SigV4 setup)
- v0.19.3: `src/providers/workers-ai.ts` (extract `aiRun` wrapper, `callWorkersAI`, `callWorkersAIStream`)

Each follow-on release is largely mechanical now that the scaffolding lives in `src/env.ts` and `src/utils.ts`; the provider files just absorb their respective code blocks and add appropriate imports.

## v0.18.4

Organizational refactor: move the MODELS catalog (and the `ModelType`, `Provider`, `ModelEntry` types it depends on) from `src/index.ts` into a new `src/models.ts` module. Pure relocation, no behavior change.

The catalog was the single largest contiguous block in `src/index.ts` at ~125 lines, growing every release as new models land. Pulling it into its own file makes catalog edits a localized diff instead of a wide change against the worker entry, makes the file easy to find for contributors, and gives a natural home for catalog-related comments (conventions for adding models, BYOK vs Unified Billing tagging, etc.).

- New `src/models.ts` exports `ModelType`, `Provider`, `ModelEntry`, and `MODELS`. File header documents the catalog conventions explicitly (label prefixes, BYOK markers, streaming flag, byok_alias for Bedrock chat and BYOK video).
- `src/index.ts` imports all four from `./models` at the top of file alongside the parser imports. Net diff: 2 lines added (the two import statements), 126 lines removed (the catalog block).

### Touch points

- `src/index.ts`: 3904 -> 3777 lines (-127, the catalog block plus one orphaned section header).
- `src/models.ts`: new file, 153 lines (28 lines of header documentation + 125 lines of catalog content moved verbatim from index.ts).
- `package.json`: version bump 0.18.3 -> 0.18.4.

No D1 migration. No R2 migration. No new dependencies. No new worker secrets. All 65 tests still pass. `npm run typecheck` still clean (zero errors).

## v0.18.3

Internal refactor: close the v0.17.2-era request-builder-dedup thread by factoring `callAnthropic` and `callAnthropicStream` to share a `prepareAnthropicRequest(env, model, systemPrompt, messages, { stream })` builder. Mirrors the existing v0.17.2 `prepareXaiRequest` and `prepareBedrockNovaRequest` pattern. No behavior change.

The Anthropic transform is the most involved of the four BYOK providers (system prompt extracted to a top-level field, OpenAI-style `image_url` content blocks rewritten as Anthropic-style `image` blocks with base64 source). All of that lives in `transformToAnthropic`, called from the new builder so both callers share it. Body fields (`stream: true`) and headers (`accept: text/event-stream`) conditional on `opts.stream`. Auth headers (`x-api-key`, `cf-aig-authorization`) constructed the same way for both callers.

- New `prepareAnthropicRequest(env, model, systemPrompt, messages, { stream })` returns `{ url, headers, body }`. Body is JSON-stringified; the callers just pass it to `fetch` without further processing.
- `callAnthropic` now calls the builder with `{ stream: false }`, then runs the standard non-streaming fetch -> JSON.parse -> return `{ raw, logId }` flow.
- `callAnthropicStream` now calls the builder with `{ stream: true }`, then runs the standard streaming fetch -> reader loop -> `extractSSEDataPayloads` -> `interpretAnthropicSSEFrame` flow (the v0.18.1 SSE pipeline).
- `cf-aig-log-id` extraction stays in `callAnthropic`'s non-streaming caller. AI Gateway doesn't surface that header on proxied SSE responses, so `callAnthropicStream` correctly continues to not look for it (returns no logId from the streaming path; D1 stores `ai_gateway_log_id: null` on streamed turns, matching existing behavior).
- `cf-aig-authorization` (set when `CF_AIG_TOKEN` is present) and `x-api-key` (set when `ANTHROPIC_API_KEY` is present, stored-keys-first auth) work identically across both callers via the shared builder.

### Touch points

- `src/index.ts`: 2 hunks (+34 / -30, net +4 lines). The builder is ~50 lines including the v0.18.3 explanatory comment; combined caller reductions outweigh it minus the comment.

No D1 migration. No R2 migration. No new dependencies. No new worker secrets. All 65 tests still pass. `npm run typecheck` still clean (zero errors).

## v0.18.2

Type hygiene fix: tighten `base64ToBytes` return type from `Uint8Array` (TS5.7+ default `Uint8Array<ArrayBufferLike>`) to `Uint8Array<ArrayBuffer>`. The implementation already returns an owned `ArrayBuffer` (`new Uint8Array(bin.length)` always allocates a fresh owned backing buffer), but the loose annotation erased that information at every call site. Concrete consequence: the `new Blob([base64ToBytes(...)], ...)` call in the FLUX.2 reference-image path failed strict typecheck because `Blob` constructors expect `ArrayBuffer`-backed views, not `ArrayBufferLike` (which includes `SharedArrayBuffer`).

Net effect: `npm run typecheck` is now clean (zero errors) for the first time since the TS5.7 `Uint8Array` generic change shipped. This makes typecheck a useful signal again; previously any new type error would have been masked by the persistent line-884 error in CI output.

### Touch points

- `src/index.ts`: 1 hunk, 1 line changed (function signature only).
- `package.json`: version bump 0.18.1 -> 0.18.2.

No behavior change. No D1 migration. No R2 migration. No new dependencies. All 65 tests still pass.

## v0.18.1

Completes the parser test story started in v0.18.0. Extracts SSE parsing for xAI, Workers AI, and Anthropic streaming into pure functions, refactors the three streaming generators to delegate to them, and adds 43 tests across four new test files. All three generators now share one SSE framer; per-provider event-type semantics live in dedicated interpreters.

### Worker

- New `src/parsers/sse-framer.ts` exports `extractSSEDataPayloads(buffer)` returning `{ payloads, remainder }`. Pure string-in/string-out function with no I/O. Handles the `\n\n` event-boundary split, `data:` line extraction (both spaced and compact prefix), `[DONE]` sentinel filtering, whitespace-only event filtering, and partial-event-as-remainder behavior. Multi-line `data:` "last wins" semantics preserved (none of our three providers emit multi-line data, but the inline implementations behaved that way and the framer matches exactly).
- New `src/parsers/xai-sse.ts` exports `interpretXaiSSEFrame(data)`. OpenAI-compatible chat completions delta format: extracts text from `choices[0].delta.content` and usage from `usage.prompt_tokens` / `usage.completion_tokens`. Empty-string deltas (typical for the final pre-usage frame) are dropped.
- New `src/parsers/workers-ai-sse.ts` exports `interpretWorkersAISSEFrame(data)`. Workers AI's flat `response` field rather than OpenAI's nested choices. Usage naming varies by underlying adapter; the interpreter accepts both `prompt_tokens`/`completion_tokens` and `input_tokens`/`output_tokens`, preferring OpenAI naming when both are present. Reasoning-model `<think>` blocks pass through unchanged for the UI to fold.
- New `src/parsers/anthropic-sse.ts` exports `interpretAnthropicSSEFrame(data)`. Named-event semantics distinguished by `data.type`: `message_start` (initial usage), `content_block_delta` with `delta.type=text_delta` (text), `message_delta` (final usage). `content_block_start`, `content_block_stop`, `message_stop`, `ping`, and unknown types ignored.
- `callXaiStream`, `callWorkersAIStream`, and `callAnthropicStream` in `src/index.ts` collapse to thin shells around `extractSSEDataPayloads` + JSON.parse + per-provider interpreter. Each generator's parsing loop is now ~10 lines instead of ~30-40.

### Test infrastructure

- `tests/sse-framer.test.ts`: 13 tests covering buffer states (empty, no-boundary, partial trailing), payload extraction (single, multiple, compact prefix, mixed prefixes, ignored `event:`/`id:`/`retry:` lines), dropped events (`[DONE]`, whitespace-only, empty `data:`), multi-data-line "last wins" semantics, and split-across-reads behavior.
- `tests/xai-sse.test.ts`: 7 tests covering text delta extraction, usage extraction, both-in-one-frame (rare but supported), empty content filtering, missing choices, missing delta content, and null token fallback.
- `tests/workers-ai-sse.test.ts`: 8 tests covering text via `response`, empty response filtering, OpenAI-naming usage, Anthropic-naming usage fallback, OpenAI-wins-when-both, reasoning-model `<think>` passthrough, and combined text+usage frames.
- `tests/anthropic-sse.test.ts`: 15 tests covering `message_start` usage (with and without), `content_block_delta` text vs tool-use vs missing text, `message_delta` usage (with and without, with null fallbacks), all five ignored event types, and a realistic eight-frame conversation sequence.

Total test count across the suite is now 65 (22 Bedrock from v0.18.0 + 43 new in v0.18.1), running in ~60ms.

### Touch points

- `src/index.ts`: 5 hunks (+47 / -134, net -87 lines). Imports gain four new lines for the new parser modules; three generator parsing loops each shrink by ~30 lines.
- `src/parsers/sse-framer.ts`: new file, ~35 lines.
- `src/parsers/xai-sse.ts`: new file, ~35 lines.
- `src/parsers/workers-ai-sse.ts`: new file, ~45 lines.
- `src/parsers/anthropic-sse.ts`: new file, ~50 lines.
- `tests/sse-framer.test.ts`: new file, ~115 lines.
- `tests/xai-sse.test.ts`: new file, ~55 lines.
- `tests/workers-ai-sse.test.ts`: new file, ~70 lines.
- `tests/anthropic-sse.test.ts`: new file, ~135 lines.
- `package.json`: version bump 0.18.0 -> 0.18.1. No new devDeps (Vitest already installed by v0.18.0).

No D1 migration. No R2 migration. No new worker secrets. No behavior change (parser logic is byte-identical to the v0.18.0 inline implementations; pure mechanical extraction validated by 43 new tests).

## v0.18.0

Adds test infrastructure (Vitest) and unit tests for the Bedrock Nova binary eventstream parser. The parser was extracted from `callBedrockNovaStream` into its own module to make it testable in isolation without loading the entire 4000-line worker module graph (which imports `cloudflare:workers`, unavailable in Node Vitest). 22 tests cover frame extraction, ignored frame types, error handling, and the realistic conversation event sequence.

### Worker

- New `src/parsers/types.ts` exports `ProviderStreamEvent`, the normalized envelope every streaming parser yields. Moved from `src/index.ts` so parsers can import it without circular reference. This is the contract for `/api/chat/stream` envelope events; adding a field is a breaking change for the wire format.
- New `src/parsers/bedrock-eventstream.ts` exports `parseBedrockEventStreamFrames(buf)` returning `{ events, remainder }`. Pure function with no I/O. Handles: partial frames split across reads, unknown header types (length-tabulated and skipped per AWS spec), `:message-type=exception` frames (throws), bogus frame lengths (throws), malformed JSON payloads (silently ignored), empty text deltas (ignored), and all event types Nova currently emits (`messageStart`, `contentBlockStart`, `contentBlockDelta`, `contentBlockStop`, `messageStop`, `metadata`, plus the `tool_use`-style delta variant that has no text field).
- `callBedrockNovaStream` in `src/index.ts` is now a thin shell that handles fetch I/O and AbortSignal, then delegates parsing to the pure function via one call to `parseBedrockEventStreamFrames(buf)`. The inline `append`/`readU32BE`/`parseHeaders` closure helpers are gone; the generator body is ~20 lines now instead of ~140.
- One incidental type fix: `let buf` in `callBedrockNovaStream` got an explicit `Uint8Array` annotation. Without it, TypeScript 5.7+ infers `Uint8Array<ArrayBuffer>` from `new Uint8Array(0)` but the parser's `remainder` return is `Uint8Array<ArrayBufferLike>` (the default generic), so reassignment fails strict typecheck. Pre-existing line-880 error on `new Blob([Uint8Array])` is untouched and not part of this change (it's a TS5.7 ergonomics issue tracked separately).

### Test infrastructure

- New `vitest.config.ts` at repo root. Node environment, `tests/**/*.test.ts` pattern. No `@cloudflare/vitest-pool-workers` adapter; pure-function parser tests don't need a Workers runtime. The adapter would slot in later if we wanted to test the worker fetch handler end-to-end.
- New `tests/bedrock-eventstream.test.ts` with 22 tests organized into 5 `describe` blocks: buffer states (3), event extraction (5), ignored frames (6), error frames with synchronous throws (5), and a realistic conversation stream walking the messageStart -> contentBlockDelta x N -> messageStop -> metadata sequence. Fixtures are hand-crafted per the AWS EventStream binary format spec via a `buildFrame(headers, payload)` helper.
- New `package.json` scripts: `test` (one-shot, for CI) and `test:watch` (continuous, for development).
- New devDeps: `vitest@^2.1.0` and `@types/node@^22.0.0`. `npm install` after applying the patch will pull both.

### Why split parsers into their own module

Originally I planned to keep parsers in `src/index.ts` and just `export` them, on the principle of preserving the single-Worker-file property. That broke in practice when Vitest tried to load the test file: Vite resolves the entire module graph during transform, and `src/index.ts` imports `cloudflare:workers` (Workers-runtime-only, unavailable in Node). Three ways out:

1. Stub `cloudflare:workers` via Vitest `resolve.alias` config.
2. Add `@cloudflare/vitest-pool-workers`, requiring miniflare just to run pure-function tests.
3. Split parsers out so tests only load what they need.

Option 3 is cleanest: faster test runs (no transform of xlsx/unpdf/aws4fetch), no test-only adapters or stubs, and v0.18.1 SSE parsers slot in alongside this one in the same directory.

The "one Worker file" property was about deployment simplicity (still preserved; esbuild bundles `src/index.ts` and its imports into one Worker .js bundle), not about literally one source file. The `src/parsers/` directory is the natural seam.

### What's deferred to v0.18.1

SSE parser extraction and tests for xAI, Workers AI, and Anthropic streaming. All three currently share the same `\n\n`-delimited SSE framer with provider-specific JSON interpretation; the pattern will follow the same shape as Bedrock (pure functions in `src/parsers/`, tests in `tests/`).

### Touch points

- `src/index.ts`: 4 hunks (+5 / -126, net -121 lines). Imports at top of file (+2 lines), `ProviderStreamEvent` local type removed (-3 lines), `callBedrockNovaStream` body collapsed (+0 / -125 effective).
- `src/parsers/types.ts`: new file, ~20 lines.
- `src/parsers/bedrock-eventstream.ts`: new file, ~150 lines (parser body identical to the old inline implementation, factored as exported function with imported type).
- `tests/bedrock-eventstream.test.ts`: new file, ~280 lines (22 tests + frame-construction helper).
- `vitest.config.ts`: new file, ~22 lines.
- `package.json`: version bump 0.17.2 -> 0.18.0, +2 devDeps, +2 scripts.

No D1 migration. No R2 migration. No new worker secrets. No behavior change (parser logic is byte-identical to the v0.17.2 inline implementation; pure mechanical extraction validated by 22 tests).

## v0.17.2

Internal refactor: extract shared request builders for the xAI and Bedrock Nova providers. Streaming and non-streaming callers for each pair now share their URL/headers/body construction instead of duplicating ~30 lines per pair. No behavior change.

- New `prepareXaiRequest(env, model, messages, { stream })` returns `{ url, headers, body }`. Body fields (`stream: true`, `stream_options.include_usage: true`) conditional on `opts.stream`. Both `callXai` and `callXaiStream` now call this and differ only in how they consume the response body (one `await resp.json()`, the other a `ReadableStream` reader loop).
- New `prepareBedrockNovaRequest(env, model, systemPrompt, messages, { stream })` returns `{ awsClient, url, bodyJson }`. Endpoint suffix (`converse` vs `converse-stream`) conditional on `opts.stream`. Both `callBedrockNova` and `callBedrockNovaStream` now call this. The Converse message transform (system message stripping, multi-part content flattening) lives in the builder, no longer duplicated.
- `cf-aig-log-id` extraction stays in `callXai`'s non-streaming caller. AI Gateway doesn't surface that header on proxied SSE responses, so `callXaiStream` correctly continues to not look for it. Same for `logId: null` in `callBedrockNova`'s return shape; the streaming variant continues to not return a logId at all (different return shape from the non-streaming caller).
- Anthropic helpers NOT yet deduped. `callAnthropic` and `callAnthropicStream` share the same pattern (both call `env.AI.gateway(...).getUrl("anthropic")` independently) but the transform is more involved (system prompt extraction, content-block flattening for vision attachments). Deferred to a follow-up commit so the diff stays surgical.
- Workers AI helpers NOT deduped. `runAi` already abstracts the binding call; `callWorkersAIStream` is the only place that uses `env.AI.run({stream:true})`, so there's no duplication to factor out.
- No new types exported. `awsClient` type inferred from the dynamic import, same as before.
- Net diff: 8 hunks (+57 / -65, net -8 lines) in `src/index.ts`.
- No behavior change. No D1 migration. No new dependencies.

## v0.17.1

Internal refactor: `InputAttachment` becomes a discriminated union, matching the existing `PersistedAttachment` style already used in the project. No behavior change.

- The old shape was a flat interface with all variant-specific fields optional (`data?`, `frames?`), which forced inline narrowing (`if (att.type !== "image" || !att.data) continue`) and prevented filter-callback type predicates from working cleanly. A v0.16.0 attempt to cast against a fictional `InputImageAttachment` failed to compile and had to fall back to inline `att.type !== "image" || !att.data` narrowing.
- New shape: four variant interfaces (`InputImageAttachment`, `InputAudioAttachment`, `InputVideoFramesAttachment`, `InputVideoFullAttachment`) discriminated on `type`, combined via a `type InputAttachment = | ... | ...` union alias. Mirrors the `PersistedAttachment` family exactly. TypeScript now narrows automatically inside `if (att.type === "image") { ... }` blocks, and type predicates on `find` / `filter` callbacks (e.g., `(a): a is InputVideoFullAttachment => a.type === "video_full"`) narrow the result.
- Cleanups enabled by the new shape:
  - `runChat` (around line 610): `imageDataUrls.push(att.data!)` becomes `imageDataUrls.push(att.data)`; the non-null assertion is no longer needed because the union narrows `att.data` to `string` after `att.type === "image"`.
  - `runChatStream` (around line 1471): same.
  - `runVideo` Pegasus `find` (around line 2428): added type predicate `(a): a is InputVideoFullAttachment => a.type === "video_full"`. The `?? ""` fallback on `videoAtt.data` is now superfluous (type is `string`, not `string | undefined`) and removed.
- Defensive runtime checks (`att.data ? parseDataUrl(att.data) : null`, `att.frames ?? []`) kept in place. They guard against malformed JSON arriving at the API boundary, which the type system can't prevent. Removing them would shift behavior, not just types.
- Net diff: 4 hunks (+40 / -9) in `src/index.ts`.
- No behavior change. No D1 migration. No new dependencies.

## v0.17.0

Adds web-search as an opt-in retrieval source alongside RAG. Tavily (general web) + Wikipedia (reference and lore) queried in parallel; results folded into the system prompt the same way RAG chunks already are. Designed for creative work and worldbuilding, where you want the model to do synthesis rather than a search engine's pre-summary.

### Worker

- New `searchWeb()` helper hitting Tavily (POST `/search` with `include_answer:false`, `include_raw_content:false`, max 5 snippets) and Wikipedia (MediaWiki search API, max 3 snippets, HTML-stripped). Both run via `Promise.all` with per-source 8-second timeouts and per-source try/catch, so one failing or timing out never kills the other.
- `ChatRequest` gains `use_web_search?: boolean`. `Env` gains optional `TAVILY_API_KEY`. When the key is unset, Tavily is silently skipped and only Wikipedia runs.
- `RetrievedChunk` extended with an optional `source_type?: "rag"` discriminator (existing rows without the field are treated as RAG for back-compat). New `RetrievedWebResult` type with `source_type: "web"`, `source: "tavily" | "wikipedia"`, `url`, `title`, `snippet`, optional `score`. Union type `RetrievedItem` covers both.
- Effective system prompt assembly in both `runChat` and `runChatStream` becomes a three-part filter+join: user prompt, then RAG block (if present), then web block (if present). Either or both retrieval blocks may be empty.
- Persistence: the existing `retrieved_context` D1 column now stores a unified `RetrievedItem[]` array combining RAG chunks and web results from the same turn, discriminated by `source_type`. No schema migration; the column was already JSON.
- New chat response field `web_results` (parallel to existing `retrieved_chunks`). Diagnostics: `effective_system_prompt` now surfaces when either `use_docs` or `use_web_search` was on; new `web_search_error` field mirrors the existing `retrieval_error` field.

### Frontend

- `index.html`: new `<label id="use-web-search-row">` next to the existing `<label id="use-docs-row">` in the bottom row.
- `app.js`: new element refs (`useWebSearchRow`, `useWebSearchCheckbox`). `updateAffordance` enables the toggle for chat models only (no doc-count gate). `sendChat` request body plumbs `use_web_search: true` when toggle is checked and model is chat. `renderRetrievedChunksHTML` branches on `source_type`: web results show title + clickable URL + snippet with a `retrieved-web` class modifier; RAG chunks render unchanged. Mixed-source label ("retrieved context (N docs + M web)") handles turns that use both.

### Wikipedia compliance

The worker sends a descriptive `User-Agent` identifying the project and repo URL per Wikimedia's User-Agent policy. If you fork to a different repo name, update the UA string in `searchWikipedia`.

### Token budget

A turn with `use_web_search:true` adds roughly 1500-3000 tokens to the system prompt (Tavily 5 + Wikipedia 3 by default). The per-turn toggle is intentional; auto-search every turn would waste tokens and Tavily credits.

### What this is not

This is query-time web search for creative work and current-events questions. It is NOT designed for legal research, citation-accurate work, or anywhere paraphrase drift or hallucinated URLs could cause harm. For that pattern, curated periodic ingest into Vectorize (with `source_type`, `source_url`, `content_hash` columns on `documents`) is the right shape.

### Touch points

- `src/index.ts`: 16 hunks (+207 / -18)
- `public/index.html`: 1 hunk (+4 / -0)
- `public/app.js`: 5 hunks (+42 / -2)
- `wrangler.example.toml`: 1 hunk (+2 / -1, comment block only)

No D1 migration. No new dependencies. New optional worker secret: `TAVILY_API_KEY` (skip it and Wikipedia-only is the fallback).

## v0.16.0

Three additions filling in gaps from v0.13.0 (streaming foundation) and v0.14.0 (BYOK simplification). Each lands as its own commit; the v0.16.0 tag goes on the third.

### SSE Pass 3: xAI Grok streaming

All four xAI catalog entries (grok-4.3, grok-4.20-multi-agent-0309, grok-4.20-0309-reasoning, grok-build-0.1) gain `streaming: true` and route to a new `callXaiStream` async generator.

xAI exposes standard OpenAI-compatible SSE: `data: {choices:[{delta:{content}}]}` frames terminated by `data: [DONE]`. With `stream_options.include_usage: true` (which we set), the final frame before [DONE] carries token counts. The generator parses both and yields normalized text + usage events into the existing flat ProviderStreamEvent envelope.

Transport is direct fetch through AI Gateway's xAI proxy (`/v1/chat/completions`), not the env.AI binding; same shape as the non-streaming `callXai` it sits beside. AbortSignal is forwarded to fetch() so client disconnect cancels the upstream call mid-generation (saving tokens).

handleChatStream's provider gate now allows "xai" alongside "anthropic" and Workers AI. runChatStream dispatch refactored from a ternary to if/else-if/else chain so adding providers is a one-line append.

### SSE Pass 4: Bedrock Nova streaming

The four Nova catalog entries (nova-2-lite, nova-2-pro, nova-lite, nova-pro) gain `streaming: true` and route to a new `callBedrockNovaStream` async generator. Pegasus stays as-is; it's single-shot video Q&A using InvokeModel, not ConverseStream-eligible.

The hard part is the wire format. Bedrock uses `application/vnd.amazon.eventstream`, a binary framing protocol. Each frame:

  [4 bytes BE]  total_length
  [4 bytes BE]  headers_length
  [4 bytes BE]  prelude_crc       (CRC32 of first 8 bytes, skipped)
  [N bytes]     headers           (name/type/value triplets)
  [M bytes]     payload           (JSON for the events we care about)
  [4 bytes BE]  message_crc       (skipped)

  payload_bytes M = total_length - 16 - headers_length

The header parser handles type 7 (UTF-8 string with 2-byte BE length prefix) directly; that's what `:message-type`, `:event-type`, and `:content-type` use. Other header types (booleans, integers, byte arrays, UUIDs) are length-tabulated and skipped defensively, so an unknown header type can't desync the stream.

Event types we react to:
- `contentBlockDelta` produces a text delta (`{delta:{text:"..."}}`)
- `metadata` produces a usage event (`{usage:{inputTokens, outputTokens}}`)
- `exception` (via `:message-type=exception`) throws with the payload's `message` field

Other event types (messageStart, contentBlockStart, contentBlockStop, messageStop) carry no info for the flat envelope and are ignored.

Endpoint suffix is `converse-stream` (not `converse`). aws4fetch signs the request with SigV4 and forwards the `signal` option to fetch(), so AbortSignal-based cancellation works the same as xAI and Workers AI.

The handleChatStream gate now also permits "bedrock". The catalog `streaming` flag is the real filter; Pegasus would fail the `model.streaming` check above the provider gate anyway.

### FLUX.2 reference images

Cloudflare's FLUX.2 models (Klein 9B, Klein 4B, Dev) accept up to 4 reference images as multipart form fields `input_image_0` through `input_image_3`, each at most 512x512 px.

**Worker (src/index.ts):** runImage's FLUX.2 multipart branch now iterates `body.attachments` after the prompt/width/height/negative_prompt fields. For each image attachment (`type === "image"` with `data` set, up to 4), parse the data URL via `parseDataUrl`, decode base64 to bytes, wrap in a Blob, and append as `input_image_{0..3}`. Beyond 4 silently skipped; the frontend caps client-side too.

**Frontend (public/app.js):** Two new constants at the top: `FLUX2_REF_IMAGE_MAX_DIM = 512` and `MAX_FLUX2_REF_IMAGES = 4`. Then two function patches.

First, `updateAffordance` for image-mode models now detects FLUX.2 (id prefix `@cf/black-forest-labs/flux-2-`) and shows the attach row with the hint `"optional: up to 4 reference images (downscaled to 512px)"`. Other image-gen models still hide the attach row.

Second, `handleFiles` for image uploads has a FLUX.2 branch that bypasses the `modelSupports("vision")` check; the vision capability flag is for input analysis, not for using images as generation references. The branch counts existing image attachments, throws on the 5th, and downscales to 512 px (via `FLUX2_REF_IMAGE_MAX_DIM`) instead of the chat-side 1280.

### Touch points

- `src/index.ts`: 9 hunks total (+361 / -17)
- `public/app.js`: 3 hunks (+40 / -8)

No D1 migration. No R2 migration. No new dependencies. No new worker secrets.

## v0.15.0

UI: replace the flat `<select>` model dropdown with a collapsible picker.

The catalog reached ~50 models across 6 modalities; finding Opus 4.7 by scrolling past every video and music model became friction. The new picker groups by catalog `group` field with `<details>` accordion sections, expands the first group by default, and surfaces capability badges (vision, stream) next to each item.

**Architecture:**

- `<select id="model">` becomes `<div id="model" class="model-picker">`. The element ID stays so existing `document.getElementById("model")` lookups still resolve.
- `modelSelect` is now a JS shim exposing the same surface the rest of `app.js` already uses: `.value` getter and setter, plus `addEventListener("change", fn)`. Programmatic `modelSelect.value = "..."` does NOT fire `change`, matching native `<select>` behavior; user-driven clicks do.
- `loadModels()` switched from `modelSelect.innerHTML = ...` (assembling `<option>` / `<optgroup>` strings) to `modelSelect.populate(grouped)`. Every other call site (`loadConversation`, `loadTurnIntoComposer`, `currentModel`, the change listener wired to `updateAffordance`) needs no changes.

**UI behavior:**

- Trigger button shows the current model label and a chevron; click to open the panel.
- Panel holds one `<details>` per catalog `group` field. First group open on load; rest collapsed. Click a group header to expand or collapse.
- Each item shows the model label plus capability badges where relevant: `vision` (accent color) for image-accepting models, `stream` (warn color) for the 23 currently-streamable chat models (4 Anthropic + 19 Workers AI).
- Selected item is highlighted in the accent color with a checkmark on the right.
- Panel closes on outside click, item click (auto-close on select), or Escape (also returns focus to the trigger).

**Styling:**

- All colors via existing CSS custom properties (`--bg-elev`, `--bg-elev2`, `--fg`, `--fg-dim`, `--accent`, `--warn`, `--border`). No new design tokens.
- Removed orphaned select-only rules (`select, textarea`, `select optgroup`, `select option`, `select:focus, textarea:focus`). The shared `select, textarea` rule was split: the `textarea` portion folded into the existing dedicated textarea block.
- Panel uses `position: absolute` anchored to the picker root (the root is `position: relative`). Trigger spans the controls-grid cell width; panel matches.
- Mobile: panel `max-height: 70vh` (up from 60vh desktop) since the controls grid collapses to single column at <=768px.

**Touch points:**

- `public/index.html`: 1 line changed (the `<select>` tag).
- `public/app.js`: 2 hunks. Picker IIFE replaces the `modelSelect` declaration (~140 lines including comments); `loadModels` innerHTML block replaced with a one-liner.
- `public/styles.css`: 1 hunk. Collapses 4 select-related rules into the textarea rule, then appends ~170 lines of picker styles.

**Browser support:** uses `<details>` / `<summary>`, `CSS.escape()`, and `color-mix()`. Supported in Firefox 113+ and Chromium 111+ (May 2023 baseline). No fallback needed for a 2026 deployment.

No D1 migration, no R2 migration, no new dependencies, no new worker secrets. Pure frontend change. Net diff: +274 / -26 across 5 hunks in 3 files.

## v0.14.0

**Breaking:** removes OpenAI BYOK and the Gemini chat / Veo 3.1 video BYOK paths to consolidate around Anthropic + xAI + Bedrock BYOK and Unified Billing for everything else. Deployers who used OpenAI or Google BYOK will need to migrate to one of the remaining providers.

- Catalog entries removed (13 total):
  - OpenAI BYOK: `openai/gpt-5.5`, `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/gpt-image-2-2026-04-21`, `openai/gpt-4o-mini-tts-2025-12-15`, `openai/gpt-4o-transcribe`, `openai/gpt-4o-mini-transcribe-2025-12-15`.
  - Google BYOK: `google/gemini-3.5-flash`, `google/gemini-3.1-pro-preview`, `google/gemini-3.1-flash`, `google/gemini-2.5-pro`, `google/veo-3.1`, `google/veo-3.1-fast`.
- Preserved: `google/veo-3` and `google/veo-3-fast` (no `byok_alias`, route through Unified Billing via the `LongRunWorkflow` step pattern; still need CF credits to actually fire).
- Worker code deletions: `callOpenAI`, `imageGenOpenAI`, `ttsOpenAI`, `sttOpenAI`, `callGoogle`, `transformToGoogle`, `GooglePart` / `GoogleContent` interfaces, `submitVideoGoogle`, `pollVideoGoogle`. All BYOK dispatch branches in `runChat`, `runImage`, `runTts`, `runStt`, `runVideo`, and `handleJobPoll` collapsed accordingly. Google fallback removed from both `extractOutput` (candidates[0].content.parts[].text) and `extractUsage` (usageMetadata).
- `Env` interface: `OPENAI_API_KEY` and `GOOGLE_API_KEY` removed.
- `Provider` type union: `"openai"` removed. `"google"` kept for the two veo-3 Unified Billing entries.
- `runChat` `wantsSystemInMessages` simplified from `!(model.provider === "anthropic" || model.provider === "google")` to `model.provider !== "anthropic"`. Anthropic still takes system as a top-level field; everything else gets `role: "system"` in the messages array.
- `runVideo` `isBYOK` simplified to `!!(model.byok_alias && model.provider === "xai")`. Only xAI Grok Imagine Video uses the per-provider BYOK video path now; everything else goes through the Workflow.
- `handleJobPoll` BYOK branch reduced to `row.job_provider === "xai"` (was xai-or-google).
- README, CONTRIBUTING, and `wrangler.example.toml` updated to drop OpenAI / Google BYOK references. The orphaned "Google Gemini models (BYOK)" content that was sitting headerless under the xAI section (likely from an earlier edit losing the `##` header) is also removed.
- Net diff against `src/index.ts`: +26 / -388 lines across 24 hunks.

**Deployer migration (existing v0.13.x deployments):**

After deploying v0.14.0, drop the obsolete secrets so they don't sit unused:

```
npx wrangler secret delete OPENAI_API_KEY
npx wrangler secret delete GOOGLE_API_KEY
```

Neither is fatal if forgotten; they're just inert.

No D1 migration. No R2 migration. Existing rows that reference removed models will still render in history (the row stores the model ID as a string, not a foreign key into the catalog); attempting to continue or retry one of those conversations will fail at submit time with a clear error.

## v0.13.0

Rolls up four patches landed between v0.12.0 and v0.14.0: hot-path latency, SSE streaming Pass 1 (Anthropic), SSE streaming Pass 2 (Workers AI), and the image-gen workarounds for FLUX.2 plus the gateway-incompatible streaming-output models.

**Hot-path latency:**

- `runChat` prelude now overlaps the D1 prior-turns SELECT, the Vectorize RAG retrieve, and the attachment normalization walk. Previously these ran sequentially even though they're independent. Hoisted `priorTurnsPromise` and `retrievePromise` to fire at the top of the function and awaited only at the message-array assembly point.
- Video-frame attachments now upload to R2 in parallel via `Promise.all` instead of an in-order `for await` loop. For an 8-frame video, this collapses ~600ms of sequential PUTs into a single round trip.
- `handleJobPoll` streams the upstream artifact directly into R2 via a new `r2PutStream` helper that pipes `aresp.body` through the bucket without buffering the whole video into memory. Cuts peak memory on a 30MB video gen from ~30MB to a few hundred KB and shaves one full body-read pass off the latency.
- Two try-blocks in `handleJobPoll` collapsed into one (the separation was historical and prevented sharing the streaming pipe).

**SSE streaming (chat models only):**

- New `POST /api/chat/stream` endpoint returns `text/event-stream`. Same request body shape as `POST /api/chat`. Response is a sequence of envelope events emitted via a `TransformStream`:
  - `{ "type": "delta", "text": "..." }` for each token chunk as the model emits it.
  - `{ "type": "done", "row_id": ..., "latency_ms": ..., "tokens_in": ..., "tokens_out": ..., "conversation_id": ..., "turn_index": ... }` once the model finishes. Token counts mirror the non-stream path.
  - `{ "type": "error", "message": "..." }` on upstream failure.
- New optional `streaming: boolean` flag on `ModelEntry`. Frontend can filter the catalog to streamable models for routing; the worker rejects stream requests for non-streaming models with HTTP 501.
- Streaming wired for two providers in this release:
  - **Pass 1 (Anthropic):** all four Claude entries (Opus 4.7 / 4.6, Sonnet 4.6, Haiku 4.5). Uses `callAnthropicStream` async generator that strips Anthropic's native SSE envelope (`message_start`, `content_block_delta`, etc.) and re-emits our flat envelope.
  - **Pass 2 (Workers AI):** 19 `@cf/*` and `@hf/*` chat models flagged streaming. Uses `callWorkersAIStream` which calls `env.AI.run({stream: true})` and reads the returned `ReadableStream` of OpenAI-compatible SSE. The `AnthropicStreamEvent` internal type was renamed to `ProviderStreamEvent` since it now serves both backends.
  - **Pass 3 (xAI Grok) and Pass 4 (Bedrock Nova):** still on the backlog. The `handleChatStream` validator returns 501 with a clear message for those.
- Client disconnect handling: the worker holds an `AbortController` and aborts the upstream fetch when the SSE pipe closes. Partial tokens already buffered are dropped; no D1 row is persisted for an aborted stream. This matches the non-stream path's behavior (no partial rows).
- Reasoning models (`@cf/openai/gpt-oss-120b`, `@cf/openai/gpt-oss-20b`, `@hf/.../qwq-32b`, `@cf/deepseek/deepseek-r1-distill-qwen-32b`) stream `<think>...</think>` blocks as part of the delta text. The frontend can fold these in the UI; the worker passes them through unchanged.
- AI Gateway log ID is null on streaming rows. The gateway does not yet surface `cf-aig-log-id` on SSE responses. Once Cloudflare exposes it, plumbing it through is a one-line change.

**Streaming client module (new file):**

- `public/streaming-client.js`, a vanilla JS module with no dependencies. Exposes `streamChat(body, { onDelta, onDone, onError })` returning a `cancel()` function. Drop-in for any frontend that wants to wire the new endpoint without rewriting its existing chat code path. About 7.6KB. Includes integration notes in the file header.

**Image generation workarounds:**

- FLUX.2 (`@cf/black-forest-labs/flux-2-klein-9b`, `-klein-4b`, `-dev`) requires multipart input to `env.AI.run`. Two errors had been masking this: `AiError 5006: "required properties at '/' are 'multipart'"` from the AI binding, and `"AI Gateway does not support ReadableStreams yet"` when the gateway tried to proxy a stream-shaped input. Fix: build `FormData`, wrap it in `new Response(form)` to extract the boundary-bearing `Content-Type`, then pass `{ multipart: { body, contentType } }` to `env.AI.run`. Detected per-call via `model.id.startsWith("@cf/black-forest-labs/flux-2-")`.
- Streaming-output models (`@cf/leonardo/phoenix-1.0`, `@cf/lykon/dreamshaper-8-lcm`) return a `ReadableStream` of PNG bytes rather than the usual `{ image: base64 }` JSON. The AI Gateway cannot proxy stream-output bodies either. Same fix as FLUX.2 input: bypass the gateway by calling `env.AI.run` directly without the `gateway: { id }` option, then detect the response shape at runtime (`result instanceof ReadableStream` -> drain to `Uint8Array`; else extract `result.image` as base64).
- Five models now bypass the AI Gateway: the three FLUX.2 entries plus phoenix-1.0 and dreamshaper-8-lcm. Cost: `ai_gateway_log_id` is null on rows generated by these. Cloudflare's error text says "yet," so the bypass is expected to be temporary. The other two image models (`@cf/black-forest-labs/flux-1-schnell` and `@cf/leonardo/lucid-origin`) still route through the gateway normally.

**Internal:**

- No D1 migration. No R2 migration. No new worker secrets.
- New worker file: `public/streaming-client.js` (must be served by the Assets binding, which already covers `public/*`).
- Net diff against v0.12.0 across the four patches: roughly +700 / -100 lines. Most of it is the SSE machinery and the FLUX.2 multipart construction.

## v0.12.0

- Unblock Unified Billing video and music generation by migrating from `ctx.waitUntil` to Cloudflare Workflows. Resolves the long-standing `waitUntil` cancellation issue: previously, jobs whose `env.AI.run` call exceeded the ~30-second post-response budget were cancelled mid-flight, leaving D1 rows stuck in `pending`. The new `LongRunWorkflow` class holds the blocking call alive across step boundaries (unlimited wall-clock per step for I/O-bound work) and retries each phase independently.
- Affected providers (now durable): Google Veo 3 / Veo 3 Fast, ByteDance Seedance 2.0 / 2.0 Fast, MiniMax Hailuo 2.3 / 2.3 Fast, RunwayML Gen-4.5, Alibaba HappyHorse 1.0, PixVerse v6 / v5.6, Vidu Q3 Pro / Q3 Turbo, MiniMax Music 2.6. xAI Grok Imagine Video and Google Veo BYOK paths are unchanged (still use the submit-and-poll pattern from v0.10.2, which already works).
- Workflow steps: (1) `invoke-model` calls `env.AI.run` with 1 retry on 30s linear backoff; (2) `download-and-store` fetches the upstream artifact and uploads to R2 in one combined step (Workflows cap step return values at 1 MiB so we can't pass bytes between steps - video files are 5-15MB, music 3-5MB); (3) `finalize-d1` writes status, `output_artifact`, and latency to the chats row.
- D1 `chats.job_id` now stores the Workflow instance ID for Unified Billing jobs (BYOK rows still store the upstream provider's job ID). Useful for cross-referencing with `npx wrangler workflows instances describe skyphusion-longrun <id>`.
**Frontend:**

- Per-turn action buttons: each completed (or failed) assistant message now shows three small icon buttons. **Copy** writes the response text to the clipboard (hidden on pure-artifact turns like image/audio/video without text output). **Edit** restores the model picker, system prompt, and user input to match the historical turn, then focuses the input so the user can tweak before re-running; does NOT auto-submit. **Retry** does the same restore but fires `run()` immediately for one-click resubmit. Attachments from the original turn are not carried forward (multi-turn continuation is text-only across all paths), so retry on an image-bearing chat turn submits text only. Click handler is delegated on `#transcript` since the transcript is re-rendered via `innerHTML` on each turn change. Clipboard write uses `navigator.clipboard.writeText` with an `execCommand` fallback for non-secure contexts.

**Frontend unchanged:**

- The existing `GET /api/job/:id` polling endpoint still works. The workflow updates D1 directly when complete, so the poll endpoint just reads the current state.
- Removed: `generateVideoUnified`, `generateMusicBackground`, `MusicGenResult`, `VideoGenResult` (replaced by inline workflow logic).
- No D1 migration required.

**Config restructuring (deploy-impacting):**

- `wrangler.toml` is now gitignored. The repo ships `wrangler.example.toml` as the committed template; deployer-specific values (D1 `database_id`, worker `name`) live in your local `wrangler.toml` and are no longer overwritten when you pull a new version. Bootstrap a new clone with `npm run bootstrap` (copies the example to a real `wrangler.toml`).
- `GATEWAY_ID` moved out of `[vars]` in the wrangler config and into a worker secret. Set it with `echo "your-gateway-slug" | npx wrangler secret put GATEWAY_ID`. For local development, also add `GATEWAY_ID=your-gateway-slug` to `.dev.vars`.
- New `npm run bootstrap` script idempotently creates `wrangler.toml` from the template.

**wrangler.toml migration for existing deployers (v0.11.x -> v0.12.0):**

Apply these changes to your live `wrangler.toml`. Paste the two new blocks anywhere after the `[assets]` block. Then delete the `[vars]` block (since `GATEWAY_ID` is now a secret), and run the `secret put` command at the end.

```toml
# Add these two blocks to your wrangler.toml:

[[workflows]]
name = "skyphusion-longrun"
binding = "LONGRUN"
class_name = "LongRunWorkflow"

[observability]
enabled = true
```

Then:

```
# Delete the [vars] block from wrangler.toml (it only had GATEWAY_ID).
# Move GATEWAY_ID to a secret:
echo "your-gateway-slug" | npx wrangler secret put GATEWAY_ID

# Add it to .dev.vars too if you do local dev:
echo "GATEWAY_ID=your-gateway-slug" >> .dev.vars

# Regenerate types and deploy:
npx wrangler types
npm run deploy
```

Workflows are not supported on `wrangler dev --remote`, so the Unified Billing video and music paths can only be exercised in deployed mode.

**Known limitations carried into v0.12.0:**

- Per-provider param mapping is still Veo-baseline (`prompt / duration / aspect_ratio / resolution / generate_audio`) for all video models. ByteDance/RunwayML/Alibaba/PixVerse/Vidu may reject or ignore some of those parameters; expect param-shape iteration as each provider is exercised in production. Errors will surface in `chats.job_error` rather than getting silently swallowed.
- Bedrock Nova vision attachments are still text-only (`callBedrockNova` strips image content parts). Frontend gates uploads on the `vision` capability flag so the UI lets users attach images, but the worker drops them silently. Backlog item.

## v0.11.1

- Expand OpenAI BYOK across model types per Conrad's confirmed model list:
  - Image gen: `gpt-image-2-2026-04-21` via `/v1/images/generations` (returns base64 PNG; stored in R2 via the same artifact pipeline as Workers AI image gen).
  - TTS: `gpt-4o-mini-tts-2025-12-15` via `/v1/audio/speech` (returns MP3 bytes; default voice "alloy", configurable later).
  - STT: `gpt-4o-transcribe` and `gpt-4o-mini-transcribe-2025-12-15` via `/v1/audio/transcriptions` (multipart upload using native FormData/Blob).
- Removed `openai/gpt-4.1` from the catalog since Conrad's confirmed list doesn't include it. Chat models remain GPT-5.5, GPT-5.4, GPT-5.4 mini.
- New OpenAI-specific dispatch helpers: `imageGenOpenAI`, `ttsOpenAI`, `sttOpenAI`. Each routes through Cloudflare AI Gateway's OpenAI proxy using the existing `OPENAI_API_KEY` secret.

**Not implemented this turn (deferred for architectural reasons):**

OpenAI Realtime API models (`gpt-realtime-2`, `gpt-realtime-1.5`, `gpt-realtime-mini-2025-12-15`, `gpt-realtime-translate`, `gpt-realtime-whisper`) use WebSocket-based bidirectional audio streaming, not HTTP request/response. A Cloudflare Worker handler cannot hold a persistent duplex stream (same `waitUntil` cancellation problem we hit with video gen). The right architecture is:

1. Worker endpoint mints an ephemeral session token via OpenAI's `/v1/realtime/sessions` server-side.
2. Browser opens WebSocket directly to `wss://api.openai.com/v1/realtime?model=...` using that token.
3. Browser handles full-duplex audio capture (MediaRecorder / WebRTC), playback, and transcript display.

This is a substantial separate feature (~400-500 LOC across worker + frontend + UI). Deferred to a focused future session.

## v0.11.0

- Add OpenAI BYOK chat. Catalog ships GPT-5.5, GPT-5.4, GPT-5.4 mini, GPT-4.1. Routes through Cloudflare AI Gateway's OpenAI proxy. New `OPENAI_API_KEY` worker secret. Standard OpenAI messages-array format, no transform needed.
- Add Amazon Bedrock BYOK chat (Nova family). Catalog ships Nova 2 Lite, Nova 2 Pro, Nova Lite, Nova Pro. All routed through Bedrock's Converse API which normalizes request/response shapes across model families. SigV4 signing handled by `aws4fetch` (compact, designed for Workers runtime; eliminates ~150 LOC of manual crypto signing).
- Add TwelveLabs Pegasus 1.2 on Bedrock (video-Q&A). Different architecture from chat: uses `InvokeModel` (not Converse) with a `{inputPrompt, mediaSource}` body shape. Frontend uploads the full video as a new `video_full` attachment type (not the default frame-extraction used for vision-capable chat models). Limitations: Bedrock InvokeModel has a 25MB request limit (~18MB binary after base64); Pegasus is only available in us-west-2 and eu-west-1; Pegasus is single-shot per call so multi-turn requires re-attaching the video on each follow-up.
- New worker secrets: `OPENAI_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. New optional env vars: `AWS_REGION` (default us-east-1, used for Nova), `AWS_REGION_PEGASUS` (default us-west-2, used for Pegasus calls specifically).
- New dependency: `aws4fetch ^1.0.18`. Run `npm install` after pulling.
- New attachment type `video_full` (raw video upload) for Pegasus. Existing `video_frames` (canvas-extracted JPG frames) unchanged for other vision-capable chat models.
- `extractOutput` and `extractUsage` extended to handle Bedrock's response shape (`output.message.content[].text`) and camelCase token fields (`inputTokens`/`outputTokens`).
- No D1 migration required.

## v0.10.4

- Add project favicon and PWA manifest. The mark is a stylized Greek phi (the first letter of "phusion" in skyphusion) in cyan and magenta on a deep navy rounded square. Ships as `favicon.svg` (vector, used by all modern browsers) with PNG fallbacks at 16/32/180/192/512 for older browsers, iOS, and Android home-screen installs. `manifest.webmanifest` lets the app be installed as a standalone PWA on mobile.
- No worker code changes. Cloudflare Workers Assets binding serves the new `public/*.png`, `public/favicon.svg`, and `public/manifest.webmanifest` files automatically; no wrangler config change needed.

## v0.10.3

- Fix videos downloading as `.bin` instead of `.mp4`. Three compounding causes:
  1. `extFromMime` had no entry for `mp4` (or `mov` / `mkv`), so any video mime fell through to the `"bin"` fallback. R2 keys got `out/<uuid>.bin`, and the browser's `<a download>` used the URL's filename, so saves went to disk as `.bin`.
  2. In the BYOK video poll path, we were trusting the upstream CDN's `Content-Type` header. xAI's CDN can serve MP4 as `application/octet-stream`, which would have failed `extFromMime` even after fix #1. We know contextually it's a video gen result, so the mime is now hardcoded to `video/mp4` in this path.
  3. `handleArtifact` wasn't setting a `Content-Disposition` header, so browsers had no filename hint other than the URL path. Now it sets `Content-Disposition: inline; filename="<r2 key tail>"`.
- Limitation: existing video artifacts already stored in R2 with `.bin` keys won't be retroactively renamed. They'll still download as `.bin`. New videos generated after deploy will save as `.mp4` correctly.

## v0.10.2

- Fix Grok Imagine Video failing for the actual underlying reason. The "not found" error was the *symptom*; the *cause* was Cloudflare Workers' `waitUntil()` having a ~30-second post-response budget, while video generation takes 1-3 minutes. The background poll loop was getting cancelled mid-run, leaving rows stuck in "pending" until the client gave up.
- Refactored BYOK video architecture: submit happens synchronously in `POST /api/chat` (one fast HTTP call), upstream `job_id` persists to D1, then each client poll of `GET /api/job/:id` triggers ONE upstream poll in its own fresh worker invocation. Each invocation has its own ~30s budget, well within reach. When the upstream reports "done", the same invocation downloads the video, uploads to R2, and finalizes D1.
- Also fix Bug 1 from the diagnostic: the v0.10.0 multi-turn refactor neglected to add `conversation_id` to non-chat response shapes (image, TTS, video, music, STT). The frontend was seeing `result.conversation_id === undefined`, stringifying it to "undefined", and fetching `/api/conversations/undefined`. Now all non-chat handlers return `conversation_id` from the persisted row.
- Removed obsolete `generateVideoBYOK` background task function and `BYOK_POLL_INTERVAL_MS` / `BYOK_POLL_MAX_MS` constants. No longer needed.
- Known limitation: Unified Billing video models (bytedance, runwayml, alibaba, pixverse, vidu, etc.) and music gen (`minimax/music-2.6`) still use the old waitUntil-based pattern and are subject to the same cancellation issue. A future Cloudflare Workflows refactor will fix these. BYOK works reliably now; Unified Billing models won't until they're funded AND the architecture is reworked.

## v0.10.1

- Fix Grok Imagine Video failing with "not found": Cloudflare AI Gateway's xAI proxy only supports the OpenAI-compatible chat schema (`/v1/chat/completions`). It doesn't proxy `/v1/videos/generations` or `/v1/videos/:id`, so every video submit returned 404. Now we call `https://api.x.ai` directly for these endpoints, bypassing the gateway. The XAI_API_KEY secret is still used; the workaround means no gateway caching/analytics for video gen specifically, but those features were marginal for 1-3 minute generations.
- The fix requires `XAI_API_KEY` to be set as a worker secret (previously the AI Gateway "Stored Keys" feature could fill it in transparently for chat; with direct calls we need the actual secret).

## v0.10.0

- Multi-turn conversations. Each conversation is a sequence of turns sharing a `conversation_id` and ordered by `turn_index`. Continuing a conversation pulls prior turns from D1 and assembles a `[system, user1, assistant1, user2, assistant2, ..., userN]` message array for the model.
- New schema columns on `chats`: `conversation_id TEXT` and `turn_index INTEGER`. Backfill migration assigns `'legacy-<id>'` and `turn_index = 0` to existing rows so they remain accessible.
- New API endpoints: `GET /api/conversations` (list, summarized), `GET /api/conversations/:id` (all turns of a conversation), `DELETE /api/conversations/:id` (cascade delete of all turns + R2 artifacts).
- Frontend rework: the output area is now a scrolling transcript that renders alternating user / assistant turns instead of a single most-recent response. The sidebar lists conversations (one entry per conversation with first prompt + turn count + last activity) instead of individual chat rows. "+ new" starts a fresh conversation.
- ChatRequest gained optional `conversation_id`. If omitted, the worker generates a UUID and starts a new conversation. If present, the worker continues the existing one (and writes the next turn under it).
- Chat response gained `conversation_id` and `turn_index` so the frontend can track and continue.
- Decisions made for v1: per-turn retrieval (each turn can independently use_docs); text-only history (image/audio/video attachments from prior turns are not re-sent on continuation, only the user's text and the assistant's text reply); mixed-model conversations allowed (switch models between turns freely); no automatic summarization of older turns.
- Required migrations: `ALTER TABLE chats ADD COLUMN conversation_id TEXT`, `ALTER TABLE chats ADD COLUMN turn_index INTEGER`, then `UPDATE chats SET conversation_id = 'legacy-' || id, turn_index = 0 WHERE conversation_id IS NULL`, and `CREATE INDEX IF NOT EXISTS idx_chats_conversation ON chats(conversation_id, turn_index)`.

## v0.9.5

- Added Claude Opus 4.7 (`claude-opus-4-7`) as the top Anthropic entry. Opus 4.7 is Anthropic's flagship as of April 16, 2026, with a 1M-token context window, 128K max output, and adaptive thinking. Existing Opus 4.6, Sonnet 4.6, and Haiku 4.5 entries are preserved. BYOK via the same Anthropic dispatch path; no code or config changes needed beyond the catalog entry.

## v0.9.4

- Fix the actual RAG retrieval bug. Vectorize V2 API expects `returnMetadata` to be a string enum (`'none'` | `'indexed'` | `'all'`), not a boolean. Passing `returnMetadata: false` caused Vectorize to reject every query with `VECTOR_QUERY_ERROR (40026): Failed to parse the request body as JSON: returnMetadata: expected value at line 1 column 28`. The error was silent until v0.9.3 surfaced it. Dropped the option entirely - `'none'` is the default and what we wanted.

## v0.9.3

- Critical fix: `retrieveContext` was silently swallowing errors at every step (embed failure, Vectorize query failure). When anything in the retrieval pipeline threw, the function returned an empty array with no logging and no error surfaced to the user ,  making it look like retrieval just "wasn't finding anything" when in fact it was hard-failing.
- New return shape: `retrieveContext` now returns `{ chunks, error }`. Errors are logged to `console.error`/`console.warn` (visible via `wrangler tail`) and surfaced in the chat response as `retrieval_error` when `use_docs` is on.
- New explicit diagnostic case: when Vectorize returns matches but the D1 join returns nothing, the error message includes the user_email and sample vector_ids so a user_email mismatch (vectors written under one identity, query made under another) is immediately visible.

## v0.9.2

- Fix duplicate-system-prompt bug introduced in Pass 2: when use_docs was on for Anthropic or Google models, the effective system prompt (user prompt + retrieval block) was being sent BOTH as the API's top-level system parameter AND as a system message in the messages array. The transforms concatenate these, so the model saw the same content twice. While not fatal, it may have confused some models into deprioritizing the retrieved context. Now the system role is only added to the messages array for providers that don't accept a separate system parameter (xAI, Workers AI).
- Add `effective_system_prompt` diagnostic field to the chat response when `use_docs` is true. Lets you verify via browser DevTools (Network tab → /api/chat → Response) that the retrieval block reached the worker correctly.

## v0.9.1

- Fix dependency versions in package.json that I made up in v0.9.0
  - `unpdf`: bumped from invalid `^0.13.0` (doesn't exist) to `^1.6.0` (current major); also dropped `{ useSystemFonts: true }` arg to `getDocumentProxy` which is not part of the unpdf wrapper API
  - `xlsx`: switched from `^0.20.3` (npm version is stuck at 0.18.5, SheetJS stopped publishing) to the SheetJS CDN tarball URL `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. This is SheetJS's own recommended install pattern. The package still imports as `xlsx`.

## v0.9.0

- Phase 3A: PDF and XLSX/XLS support for document ingestion
- Added `unpdf` (~500KB) for PDF text extraction; per-page extraction with page numbers stored as chunk metadata. Modern text-extractable PDFs only; scanned/image-only PDFs need OCR (Phase 3B, deferred)
- Added `xlsx` (SheetJS, ~500KB) for XLSX (Office Open XML) and XLS (legacy BIFF binary) support; per-sheet CSV extraction with sheet name stored as chunk metadata
- New `ExtractedChunk` shape carries optional `page` and `sheet` metadata through the ingestion pipeline; `chunkText` now runs per-page or per-sheet so chunks never cross those boundaries
- Source location surfaced everywhere: chunks displayed in the UI show "chunk N · page 7" or "chunk N · sheet \"Q3\""; the system prompt block injected into chat shows "from filename.pdf, page 7"; the new `chunks.page` and `chunks.sheet` columns persist this
- Vectorize metadata also stores page/sheet (alongside the existing user_email/document_id/chunk_index) for any future server-side filtering
- Upload byte cap raised from 5MB to 10MB to accommodate larger PDFs
- **Bundle size note**: with unpdf + xlsx bundled, the worker exceeds the free-tier 1MB compressed limit. Workers paid plan is now required.
- Required migration: `ALTER TABLE chunks ADD COLUMN page INTEGER` and `ALTER TABLE chunks ADD COLUMN sheet TEXT`; also `npm install` to pick up the new dependencies

## v0.8.2

- Fix typecheck failure in `handleDocumentUpload`: Workers' `TextDecoder` types don't accept `{ fatal: false }` as a constructor option. Dropped the explicit option (non-fatal is the default), keeping the existing try/catch for defensive handling.

## v0.8.1

- RAG Pass 2: chat retrieval injection now wired end-to-end
- New `use_docs` flag on `POST /api/chat`; when true, worker embeds the user prompt, queries Vectorize for top-5 chunks, looks up text in D1, and folds them into the effective system prompt
- Effective system prompt threading: combined user-provided prompt + retrieval block, passed through cleanly to all four provider dispatch paths (Anthropic top-level system, Google systemInstruction, xAI / Workers AI system message in messages array)
- Per-user retrieval scoping enforced at the D1 layer (chunks JOIN with `WHERE user_email = ?`), so no Vectorize metadata index is required
- New `retrieved_context` column on `chats` table stores the retrieved chunks as JSON for each turn that used RAG; restored on history reload
- New chat response field `retrieved_chunks`: array of `{ document_id, filename, chunk_index, text, score }` returned alongside the model output
- Frontend: new "use my docs" checkbox in the input bottom row, visible only for chat models when the user has at least one document; checkbox auto-clears when the doc list becomes empty
- Retrieved chunks render above the model output as a collapsible block with filename, chunk index, and similarity score per chunk; persists across history reloads
- Required migration: `ALTER TABLE chats ADD COLUMN retrieved_context TEXT` if upgrading from v0.8.0

## v0.8.0

- RAG Pass 1: document ingestion pipeline (no chat integration yet, that's Pass 2)
- New `Vectorize` binding (`VEC`) with 768-dim index `skyphusion-llm-vec` for embedding storage
- New D1 tables: `documents` (per-doc metadata) and `chunks` (per-chunk text + Vectorize vector_id link)
- New endpoints: `GET /api/documents` (list), `POST /api/documents` (upload + chunk + embed + store), `GET /api/documents/:id` (metadata + chunk preview), `DELETE /api/documents/:id` (cascade-cleanup of Vectorize + D1 + R2)
- Chunking: ~500 chars per chunk with 50-char overlap, breaks preferred at paragraph/newline/sentence boundaries
- Embedding: `@cf/baai/bge-base-en-v1.5` (768-dim, free Workers AI), batched 16 chunks per call
- File support: `.txt`, `.md`, `.markdown` only; 5MB max upload (PDF and other formats deferred to a follow-on)
- Knowledge base scope: per-user (single corpus per user), scoped by Cf-Access-Authenticated-User-Email
- Frontend: new Documents section in sidebar below History with upload button, doc list with chunk count + size + date, per-doc delete with confirmation
- Vectorize cleanup: deleting a document removes all its vector IDs from Vectorize via `deleteByIds`, chunk rows from D1, and the original file from R2
- Setup commands documented in README; requires one-time `npx wrangler vectorize create` and `wrangler d1 execute --file=schema.sql`

## v0.7.5

- Flip workspace layout: output now sits in the middle (1fr, fills available space) and the input pins to the bottom. Controls (model picker, system prompt) stay at the top. Chat-style layout.

## v0.7.4

- Clear the user-input box and refocus it after a successful submit so the next prompt can be typed immediately. Output, attachments, and system prompt all remain visible.

## v0.7.3

- Rename `Image gen` / `Music gen` / `Video gen` group labels to title case (`Image Gen` / `Music Gen` / `Video Gen`) for visual consistency in the model dropdown
- Fix typecheck failure in `runStt`: `PersistedAudioAttachment.filename` is `string | undefined`, so dropped the unnecessary `?? null` fallback

## v0.7.2

- Added speech-to-text (Whisper) as a standalone model type, with 3 variants: `@cf/openai/whisper-large-v3-turbo`, `@cf/openai/whisper`, `@cf/openai/whisper-tiny-en`. Synchronous (no polling); user attaches audio, worker calls Whisper directly, returns transcript as output text.
- Added music generation (`minimax/music-2.6`) using the same fire-and-forget architecture as video gen. User provides a style/mood description and optional lyrics; worker schedules generation via `ctx.waitUntil`, downloads the resulting MP3, stores in R2. Requires Unified Billing (third-party proxied model).
- New `ModelType` variants: `"stt"` and `"music"`.
- Frontend: type-specific affordances for STT (audio attachment required) and music (lyrics field in system_prompt slot). Pending music jobs resume polling on history reload. New emoji icons in history list: musical note for music output, memo for transcripts.

## v0.7.1

- Expanded Workers AI catalog by 10 entries
- Chat additions: `glm-4.7-flash` (Z.AI multilingual), `nemotron-3-120b-a12b` (NVIDIA agentic), `gemma-3-12b-it` (Google vision, 128K context), `granite-4.0-h-micro` (IBM, function calling), `hermes-2-pro-mistral-7b` (function calling specialist), `llama-3.2-1b-instruct` (tiny test model)
- Image additions: `flux-2-klein-9b` (Flux 2 frontier, 9B distilled), `flux-2-klein-4b` (smaller, faster), `flux-2-dev` (multi-reference), `dreamshaper-8-lcm` (fast SD fine-tune)
- Total catalog now 55 models across chat / image / TTS / video (30 / 7 / 3 / 15)

## v0.7.0

- Add text-to-video generation across 15 models from 9 providers, with a dual-route architecture: Cloudflare Unified Billing (via `env.AI.run`) for all 15 models, and BYOK (per-provider AI Gateway endpoints) for the 3 models with documented direct provider APIs
- Providers: Google (Veo 3.1, Veo 3.1 Fast, Veo 3, Veo 3 Fast), ByteDance (Seedance 2.0, Seedance 2.0 Fast), MiniMax (Hailuo 2.3, Hailuo 2.3 Fast), xAI (Grok Imagine Video), RunwayML (Gen-4.5), Alibaba (HappyHorse 1.0), PixVerse (v6, v5.6), Vidu (Q3 Pro, Q3 Turbo)
- BYOK route (works today with existing keys): xAI Grok Imagine Video, Google Veo 3.1, Google Veo 3.1 Fast
- Unified Billing route (requires CF credits): all 15 models, including the 12 CF-partner-only models without public APIs
- Per-model `byok_alias` field in the catalog controls routing; if present, worker uses per-provider endpoints with stored gateway keys or env-var keys; if absent, worker uses `env.AI.run` which requires Unified Billing
- New `model_type: "video"` dispatches to one of two background functions via `ctx.waitUntil`: `generateVideoUnified` (single blocking `env.AI.run` call) or `generateVideoBYOK` (submit + poll loop up to 5 minutes + download)
- Both routes share the same fire-and-forget pattern: write `status='pending'` row, schedule background work, return immediately, frontend polls D1 for state changes
- D1 schema gains `status`, `job_id`, `job_provider`, `job_error`, `job_started_at` columns; old rows default to `status='done'`
- New `GET /api/job/:id` endpoint just reads D1 (cheap polling, no provider calls)
- Frontend polls every 5 seconds while pending, with elapsed-time counter
- Loading a still-pending chat from history resumes polling automatically
- History list shows hourglass for pending jobs, warning icon for failed, film clapboard for completed video output
- `<video controls>` rendering in the output artifact area, with download link

## v0.6.0

- Mobile-responsive layout with breakpoints at 768px and 420px
- Sidebar collapses into a slide-in drawer below 768px; hamburger toggle button fixed at top-left
- Tap backdrop to close drawer; selecting a history item auto-closes it
- Touch-friendly button sizes (44px minimum height where it matters)
- Always-visible delete button on history items in mobile (no hover available on touch)
- 16px input font to prevent iOS focus auto-zoom
- `viewport-fit=cover` and `env(safe-area-inset-*)` padding for notched iPhones
- Workspace padding pulls in on narrow phones (<420px)
- Generated image output capped at 50vh on mobile (was 60vh) so other UI stays visible

## v0.5.0

- Add Google Gemini models (Gemini 3.5 Flash, Gemini 3.1 Pro, Gemini 3.1 Flash, Gemini 2.5 Pro) via BYOK
- New `provider: "google"` dispatch routes to AI Gateway's `google-ai-studio` provider endpoint
- New `transformToGoogle` converts OpenAI-style messages to Google's `contents`/`parts` format, system prompt to top-level `systemInstruction`, image blocks to `inline_data`, assistant role to `model`
- `extractOutput` extended to handle Gemini's `candidates[0].content.parts[].text` shape
- `extractUsage` extended to handle Gemini's `usageMetadata.promptTokenCount` / `candidatesTokenCount`
- Same stored-keys-first auth pattern as Anthropic and xAI: optional `GOOGLE_API_KEY` Worker secret overrides stored keys; absence falls back to whatever's configured at the gateway

## v0.4.1

- Correct Grok model IDs to match the actual xAI catalog: `grok-4.3`, `grok-4.20-multi-agent-0309`, `grok-4.20-0309-reasoning`, `grok-build-0.1`
- Remove the v0.3.0 stub IDs (`grok-4.20`, `grok-4.1-fast`) that didn't resolve at xAI

## v0.4.0

- Provider keys now preferred via AI Gateway dashboard (BYOK Store Keys) rather than Worker secrets
- Worker auth headers are conditional: if `ANTHROPIC_API_KEY` / `XAI_API_KEY` is set, the inline key is sent; if not, the request goes through with no provider auth header and the gateway injects the stored key from Provider Keys configuration
- Added optional `CF_AIG_TOKEN` Worker secret for Authenticated Gateway support (sends `cf-aig-authorization` header when set)
- Removed the hard error when keys are missing; selecting an Anthropic or xAI model with no provider auth configured anywhere now surfaces the upstream provider's 401, which is more informative

## v0.3.0

- Add xAI / Grok models (Grok 4.20, Grok 4.3, Grok 4.1 Fast) via BYOK
- `provider` field on model entries gains `"xai"` value
- xAI dispatch is simpler than Anthropic: OpenAI-compatible wire format, no message transform, standard Bearer token auth
- `max_completion_tokens` used instead of `max_tokens` to support reasoning models (Grok 4.x)
- `XAI_API_KEY` worker secret required to enable xAI models; absence returns a clear error
- README documents the BYOK setup parallel to Anthropic's section

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
