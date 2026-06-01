// RunPod serverless submit / poll helpers (v0.32.0).
//
// Pure URL + payload builders + response normalizer plus a thin dispatcher
// that calls fetch. The dispatcher is not unit-tested (it would require
// mocking the fetch global); the pure helpers are tested in their own file
// and the dispatcher mirrors them. Reuses the project's "no zod / ajv at
// runtime, hand-authored types" convention from src/env.ts.
//
// The vivijure-serverless GPU worker is a RunPod queue-based endpoint. The
// job input shape is fixed in rp_handler.py:
//
//   { "project": "<name>", "bundle_key": "bundles/<name>.tar.gz",
//     "quality_tier": "draft|standard|final", "render_overrides": {...} }
//
// RunPod wraps this in `{ "input": {...} }` on submit. Polling returns an
// envelope { id, status, output?, error?, executionTime?, delayTime? }.

import type { Env } from "./env";

// What the planner / UI sends to /api/storyboard/render.
export interface RenderSubmitArgs {
  // Project slug; if omitted, derived from bundleKey by stripping prefix.
  project?: string;
  bundleKey: string;
  qualityTier?: "draft" | "standard" | "final";
  renderOverrides?: Record<string, unknown>;
  // v0.39.0: stamped on every R2 upload the GPU side produces (MP4,
  // state.tar.gz, keyframes) as x-amz-meta-user_email, so the existing
  // /api/artifact route can authorize the user back to their own
  // artifacts. Pre-0.39.0 jobs (no user_email) still render, but their
  // artifacts are not fetchable through the ownership-checked route.
  userEmail?: string;
  // v0.40.0: skip Wan I2V + silent-MP4 assembly; produce only SDXL
  // keyframes so the user can preview shots before committing to the
  // full render. Merged into render_overrides.keyframes_only=true on
  // the wire; the GPU side (vivijure-serverless 0.4.2+) reads it from
  // the payload and short-circuits the orchestrator after the SDXL
  // pass. A render_overrides.keyframes_only set via the freeform
  // overrides textarea wins over an unset top-level keyframesOnly.
  keyframesOnly?: boolean;
  // v0.52.0: optional R2 key for an audio bed to mux onto the final
  // video. Vivijure-serverless 0.4.11+ downloads from R2_BUCKET and
  // muxes via export_film(with_audio=True). Caller (handleRenderSubmit)
  // is responsible for ensuring the key lives in R2_RENDERS (audio/
  // prefix); MiniMax-generated artifacts (out/<uuid>.<ext> in env.R2)
  // get cross-bucket-copied before this builder sees them.
  audioKey?: string;
  // v0.58.0: pretrained-LoRA passthrough. Resolved by the route from a
  // body-side {slot: cast_id} map; keys are R2 paths under loras/...
  pretrainedLoras?: Record<string, string>;
  // v0.68.0: LoRA training overrides. Routes through to vivijure-
  // serverless 0.4.19+'s run_training_subprocess so the user can dial
  // hyperparams without an image rebuild. Unset/empty fields fall back
  // to the pod's config.yaml defaults.
  loraTrainOverrides?: LoraTrainOverrides;
  // v0.69.0: multi_character composite overrides. Routes through to
  // vivijure-serverless 0.4.23+'s multi_character.set_overrides which
  // every existing reader (mode_from_prefs, should_composite, layout,
  // generate_composite_keyframe) merges over config.yaml.
  multiCharacterOverrides?: MultiCharacterOverrides;
  // v0.70.0: lora_quality_gate overrides. Routes through to vivijure-
  // serverless 0.4.25+'s lora_quality_gate.set_overrides; gate_cfg()
  // merges these over config.yaml's loras.quality_gate block.
  qualityGateOverrides?: QualityGateOverrides;
  // v0.72.0: consistency block override (vivijure-serverless 0.4.28+).
  consistencyOverrides?: ConsistencyOverrides;
  // v0.72.0: video_consistency block override (vivijure-serverless 0.4.28+).
  videoConsistencyOverrides?: VideoConsistencyOverrides;
  // v0.73.0: continuity / image_prompting / character_generation
  // (vivijure-serverless 0.4.29+).
  continuityOverrides?: ContinuityOverrides;
  imagePromptingOverrides?: ImagePromptingOverrides;
  characterGenerationOverrides?: CharacterGenerationOverrides;
}

export interface LoraTrainOverrides {
  steps?: number;
  learning_rate?: number;
  rank?: number;
  resolution?: number;
  timeout_seconds?: number;
}

// v0.70.0: matching loras.quality_gate config that the pod previously
// read from config.yaml. Routes through to vivijure-serverless 0.4.25+'s
// lora_quality_gate.set_overrides. All fields optional.
export interface QualityGateOverrides {
  // Master switch for the gate. When false, evaluate_lora returns a
  // skipped verdict and the render proceeds without checking SSIM.
  enabled?: boolean;
  // Sanity floor on the .safetensors file size. Below this the gate
  // verdicts "bad_file" and the render fails loudly.
  min_file_bytes?: number;
  // How many probe images SDXL generates per slot to score against
  // the portrait. Pod default 2; raising costs gate time per slot.
  probe_count?: number;
  // SSIM floor: average below this -> verdict="fail" (render still
  // continues since allow_warn defaults true; raise to gate harder).
  min_ssim?: number;
  // SSIM cap for pass: average >= this -> verdict="pass". Pod default 0.38.
  pass_ssim?: number;
  // Fallback trigger word when the slot's catalog entry has none.
  default_trigger?: string;
  // LoRA scale used for the probe gens. Lower = the gate is more
  // forgiving; higher = stricter identity check.
  probe_lora_scale?: number;
  // Base seed for probe gens; the probe loop adds i to it.
  base_seed?: number;
  // When true the render proceeds even on verdict="fail". When false
  // a hard fail blocks the render.
  allow_warn?: boolean;
}

// v0.73.0: matching continuity block from config.yaml. Routes through to
// vivijure-serverless 0.4.29+'s continuity_refs.set_overrides.
export interface ContinuityOverrides {
  enabled?: boolean;
  use_last_frame?: boolean;
  max_anchor_frames?: number;       // int 1..32
  style_blend_corner?: boolean;
  anchor_strip?: boolean;
  chain_denoising?: number;         // float 0..1
  trim_join_frame?: boolean;
  trim_join_frames?: number;        // int 0..16
}

// v0.73.0: image_prompting block (negative-prompt mode + anatomy guard +
// suffix-extras the renderer appends to every SDXL prompt).
export interface ImagePromptingOverrides {
  anatomy_guard?: boolean;
  negative_mode?: "focused" | "full";
  positive_extra?: string;          // max 512 chars
  negative_extra?: string;          // max 512 chars
}

// v0.73.0: character_generation block - the two knobs on the portrait
// img2img path.
export interface CharacterGenerationOverrides {
  reference_denoising?: number;     // float 0..1
  reference_prompt_suffix?: string; // max 512 chars
}

// v0.72.0: matching consistency block from config.yaml. Routes through to
// vivijure-serverless 0.4.28+'s consistency.set_overrides. All optional.
export interface ConsistencyOverrides {
  // When true, the renderer flips into a stricter mode (locked seed,
  // identity_lock on, anatomy guards on, fewer regens). Matches the
  // consistency_mode="strict" preset from v0.59.0's render_overrides.
  default_strict?: boolean;
  // Cast portrait gets applied to keyframes when true (uses an IP-Adapter
  // for cross-shot face consistency).
  identity_lock?: boolean;
  // "locked" / "sequential" / "random". When omitted the pod uses the
  // consistency block's seed_mode (which already defaults locked).
  seed_mode?: "locked" | "sequential" | "random";
  // "img2img" | "ip_adapter" | "instantid" | "both". Same union as the
  // top-level face_lock_mode override that v0.59.0 already exposed; this
  // is the consistency-block-level version which the chain logic reads.
  face_lock_mode?: "img2img" | "ip_adapter" | "instantid" | "both";
  // Hard-pin the consistency profile to a specific quality tier
  // ("draft"|"standard"|"final"). Pod default "standard".
  quality_tier?: "draft" | "standard" | "final";
  // Denoise strength when chaining a previous shot's last frame into the
  // next shot's keyframe gen. Lower = more carryover of the prior shot.
  // 0..1; pod default 0.24.
  chain_denoising?: number;
  // String appended to the keyframe prompt to remind SDXL about identity
  // (face + costume) coherence. Free-form; pod default "same face and
  // costume, single clear subject".
  keyframe_suffix?: string;
  // String appended to the motion prompt for Wan I2V to encourage
  // stable identity through animation. Pod default "subtle natural
  // motion, preserve face and outfit, stable identity, no morphing,
  // temporal consistency".
  motion_suffix?: string;
}

// v0.72.0: matching video_consistency block. Same shape contract.
export interface VideoConsistencyOverrides {
  // Chain shots in render order (previous shot's last frame becomes the
  // next shot's keyframe init). Pod default true.
  chain_scenes?: boolean;
  // Regenerate the SDXL keyframe at the start of every shot vs reusing
  // the previous shot's last frame. Pod default true.
  regenerate_keyframe_each_shot?: boolean;
  // Append the consistency.motion_suffix to the Wan I2V prompt on every
  // shot (movie-mode behavior). Pod default true.
  motion_suffix_movie?: boolean;
  // Per-block override of identity_lock (the consistency block also has
  // one; the video_consistency one wins for the chain logic). Pod
  // default true.
  identity_lock?: boolean;
  // IP-Adapter strength on the chained-portrait gen. 0..1; pod default
  // 0.62.
  ip_adapter_scale?: number;
}

// v0.69.0: matching multi_character config that the pod previously read
// from config.yaml's production.multi_character block. Routes through
// to vivijure-serverless 0.4.23+'s _parse_multi_character_overrides.
// All fields optional; missing entries fall back to the pod's defaults.
export interface MultiCharacterOverrides {
  // "auto" composites only when a scene has 2+ slots; "always" forces
  // composite mode whenever any slot is present; "off" skips composite
  // entirely so SDXL renders the scene's natural multi-subject prompt.
  mode?: "auto" | "always" | "off";
  // Affects "auto" mode only: when true (the pod default), composite
  // fires automatically as soon as 2+ slots are present in a scene.
  auto_when_multi_slot?: boolean;
  // Cap on slots-per-composite. Pod default 2 (SDXL's hard limit for
  // coherent two-subject prompts). Lifting this is experimental.
  max_slots?: number;
  // Feather width in pixels at the layer / side-by-side boundary.
  // Pod default 48. Lower = sharper seam, higher = softer blend.
  feather_px?: number;
  // "layer" overlays the panels with a feathered alpha mask;
  // "side_by_side" tiles them horizontally.
  layout?: "layer" | "side_by_side";
}

// What the vivijure-serverless rp_handler.py reads off the job input. Field
// names mirror the Python side (snake_case) so any change there propagates
// here without a layer of remapping.
export interface RenderJobInput {
  project: string;
  bundle_key: string;
  quality_tier: "draft" | "standard" | "final";
  render_overrides?: Record<string, unknown>;
  user_email?: string;
  audio_key?: string;
  // v0.58.0: {slot: r2_key} of pretrained LoRAs the worker should
  // stage to skip Stage 1 training. Resolved server-side from cast
  // bindings against cast_members rows the user owns.
  pretrained_loras?: Record<string, string>;
  // v0.68.0: LoRA training hyperparam overrides (vivijure-serverless
  // 0.4.19+). Sent over the wire only when non-empty so older pods
  // (which ignore unknown keys) keep working.
  lora_train_overrides?: LoraTrainOverrides;
  // v0.69.0: multi_character composite overrides (vivijure-serverless
  // 0.4.23+). Same forward-compat rule.
  multi_character_overrides?: MultiCharacterOverrides;
  // v0.70.0: lora_quality_gate overrides (vivijure-serverless 0.4.25+).
  quality_gate_overrides?: QualityGateOverrides;
  // v0.72.0: consistency / video_consistency overrides (0.4.28+).
  consistency_overrides?: ConsistencyOverrides;
  video_consistency_overrides?: VideoConsistencyOverrides;
  // v0.73.0: continuity / image_prompting / character_generation (0.4.29+).
  continuity_overrides?: ContinuityOverrides;
  image_prompting_overrides?: ImagePromptingOverrides;
  character_generation_overrides?: CharacterGenerationOverrides;
}

// v0.41.0: per-shot SDXL keyframe regeneration. The Worker derives the
// parentJobId from the originating renders row so the GPU side (vivijure-
// serverless 0.4.3+) overwrites the same R2 key the planner UI already
// has in D1; a cache-bust on the <img> src picks up the new pixels.
export interface RegenShotArgs {
  project: string;
  bundleKey: string;
  shotId: string;
  parentJobId: string;
  userEmail?: string;
}

export interface RegenShotJobInput {
  action: "regen_shot";
  project: string;
  bundle_key: string;
  shot_id: string;
  parent_job_id: string;
  user_email?: string;
}

// v0.42.0: finalize. Runs Wan I2V over the keyframes already on the
// volume from a prior keyframes-only preview, then assembles the
// silent MP4. Same wire shape as RenderSubmitArgs (qualityTier +
// renderOverrides pass through to the GPU); only the action field
// distinguishes it from a fresh render at the dispatcher.
export interface FinalizeArgs {
  project: string;
  bundleKey: string;
  qualityTier?: "draft" | "standard" | "final";
  renderOverrides?: Record<string, unknown>;
  userEmail?: string;
  // v0.45.0: optional shot_id list to restrict the I2V pass + final
  // assembly to. When non-empty the GPU (vivijure-serverless 0.4.5+)
  // processes ONLY these shots and assembles the silent MP4 from a
  // temp manifest filtered to them. When undefined / empty, the GPU
  // runs the full all-scenes flow (v0.4.4 behavior). Sourced from
  // the originating row's locked_shots column in the handler.
  processShotIds?: string[];
  // v0.52.0: same audio-mux opt-in as RenderSubmitArgs.audioKey.
  audioKey?: string;
  // v0.58.0: same pretrained-LoRA passthrough as RenderSubmitArgs.
  pretrainedLoras?: Record<string, string>;
  // v0.68.0: same LoRA training overrides as RenderSubmitArgs.
  loraTrainOverrides?: LoraTrainOverrides;
  // v0.69.0: same multi_character overrides as RenderSubmitArgs.
  multiCharacterOverrides?: MultiCharacterOverrides;
  // v0.70.0: same quality_gate overrides as RenderSubmitArgs.
  qualityGateOverrides?: QualityGateOverrides;
  // v0.72.0: same consistency / video_consistency overrides.
  consistencyOverrides?: ConsistencyOverrides;
  videoConsistencyOverrides?: VideoConsistencyOverrides;
  // v0.73.0: same as RenderSubmitArgs.
  continuityOverrides?: ContinuityOverrides;
  imagePromptingOverrides?: ImagePromptingOverrides;
  characterGenerationOverrides?: CharacterGenerationOverrides;
}

export interface FinalizeJobInput {
  action: "finalize";
  project: string;
  bundle_key: string;
  quality_tier: "draft" | "standard" | "final";
  render_overrides?: Record<string, unknown>;
  user_email?: string;
  process_shot_ids?: string[];
  audio_key?: string;
  pretrained_loras?: Record<string, string>;
  lora_train_overrides?: LoraTrainOverrides;
  multi_character_overrides?: MultiCharacterOverrides;
  quality_gate_overrides?: QualityGateOverrides;
  consistency_overrides?: ConsistencyOverrides;
  video_consistency_overrides?: VideoConsistencyOverrides;
  continuity_overrides?: ContinuityOverrides;
  image_prompting_overrides?: ImagePromptingOverrides;
  character_generation_overrides?: CharacterGenerationOverrides;
}

// v0.57.0: standalone LoRA training. The cast manager UI on /cast
// submits this via POST /api/cast/:id/train-lora; the GPU
// (vivijure-serverless 0.4.13+) dispatches on action=="train_lora",
// pulls the synthesized single-slot bundle, runs orchestrator.train_
// lora_only, and uploads the .safetensors to lora_dest_key.
export interface TrainLoraArgs {
  project: string;
  bundleKey: string;
  userEmail?: string;
  // R2 key the GPU side should upload the trained .safetensors to.
  // Must start with "loras/" (the worker validates the prefix so a
  // misbehaving client cannot redirect writes elsewhere in the bucket).
  loraDestKey: string;
  // v0.68.0: same LoRA training hyperparam overrides as the render
  // path. Lets the cast manager's "train LoRA" button iterate on
  // steps / lr / rank / resolution / timeout without an image rebuild.
  loraTrainOverrides?: LoraTrainOverrides;
  // v0.70.0: same quality_gate overrides as the render path. The
  // gate evaluation runs after standalone training too.
  qualityGateOverrides?: QualityGateOverrides;
}

export interface TrainLoraJobInput {
  action: "train_lora";
  project: string;
  bundle_key: string;
  user_email?: string;
  lora_dest_key: string;
  lora_train_overrides?: LoraTrainOverrides;
  quality_gate_overrides?: QualityGateOverrides;
}

// RunPod queue-based job status. The platform uses these literal strings
// across submit / poll / cancel responses. Anything else surfaces as the
// raw string in `statusRaw` so the UI can show it without us silently
// dropping a new RunPod-side state.
export type RunpodStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

// Normalized response shape returned by both submit and poll. `output` /
// `error` populate per RunPod's envelope; `executionTime` and `delayTime`
// are pass-throughs (milliseconds, integers) when RunPod returns them.
export interface RunpodJobView {
  jobId: string;
  status: RunpodStatus;
  statusRaw: string;
  output?: unknown;
  error?: string;
  executionTimeMs?: number;
  delayTimeMs?: number;
}

const RUNPOD_BASE = "https://api.runpod.ai";

// Bundle key shape (mirrors bundle-assembler.assembleBundle's output):
//   bundles/<projectName>.tar.gz
// Extracts <projectName> for the rp_handler `project` field when the caller
// did not provide one explicitly. Falls back to the full bundleKey when the
// shape does not match, which lets a caller stage a custom-keyed bundle
// outside the assembler and still submit it.
export function deriveProjectFromBundleKey(bundleKey: string): string {
  const m = bundleKey.match(/^bundles\/(.+)\.tar\.gz$/);
  if (m) return m[1];
  return bundleKey;
}

export function buildSubmitPayload(args: RenderSubmitArgs): { input: RenderJobInput } {
  const project =
    args.project && args.project.trim().length > 0
      ? args.project.trim()
      : deriveProjectFromBundleKey(args.bundleKey);
  const input: RenderJobInput = {
    project,
    bundle_key: args.bundleKey,
    quality_tier: args.qualityTier ?? "final",
  };
  if (args.renderOverrides && Object.keys(args.renderOverrides).length > 0) {
    input.render_overrides = args.renderOverrides;
  }
  // v0.40.0: merge the top-level keyframesOnly flag into render_overrides.
  // A render_overrides.keyframes_only already in the textarea wins (so a
  // power-user override is never silently dropped), otherwise we set the
  // GPU-side flag from the boolean.
  if (args.keyframesOnly) {
    const existing = (input.render_overrides ?? {}) as Record<string, unknown>;
    if (existing.keyframes_only === undefined) {
      input.render_overrides = { ...existing, keyframes_only: true };
    }
  }
  if (typeof args.userEmail === "string" && args.userEmail.length > 0) {
    input.user_email = args.userEmail;
  }
  // v0.52.0: pass through the audio bed key. Already-empty values stay
  // off the wire so 0.4.10 and earlier workers (which ignore unknown
  // fields anyway) see no diff.
  if (typeof args.audioKey === "string" && args.audioKey.length > 0) {
    input.audio_key = args.audioKey;
  }
  // v0.68.0 hot-fix: buildSubmitPayload was missing the pretrained_loras
  // pass-through that buildFinalizePayload already had. That meant the
  // v0.58.0 castLoras feature populated the route's response envelope
  // (pretrainedSlots) but the wire body never carried the actual
  // {slot: r2_key} map, so the GPU never staged the LoRAs and Stage 1
  // re-trained from scratch every time. Identified during the post-
  // 0.4.16 smoke-test investigation - we were chasing
  // _stage_pretrained_loras silently failing on the GPU when the bug
  // was that the field never reached it.
  if (args.pretrainedLoras && Object.keys(args.pretrainedLoras).length > 0) {
    input.pretrained_loras = { ...args.pretrainedLoras };
  }
  // v0.68.0: LoRA training hyperparam overrides. Empty/missing stays off
  // the wire so pre-0.4.19 pods (which ignore unknown keys anyway) see
  // no diff.
  const lto = normalizeLoraTrainOverrides(args.loraTrainOverrides);
  if (lto) input.lora_train_overrides = lto;
  // v0.69.0: multi_character composite overrides. Same wire-omit rule.
  const mco = normalizeMultiCharacterOverrides(args.multiCharacterOverrides);
  if (mco) input.multi_character_overrides = mco;
  // v0.70.0: lora_quality_gate overrides. Same wire-omit rule.
  const qgo = normalizeQualityGateOverrides(args.qualityGateOverrides);
  if (qgo) input.quality_gate_overrides = qgo;
  // v0.72.0: consistency + video_consistency overrides.
  const co = normalizeConsistencyOverrides(args.consistencyOverrides);
  if (co) input.consistency_overrides = co;
  const vco = normalizeVideoConsistencyOverrides(args.videoConsistencyOverrides);
  if (vco) input.video_consistency_overrides = vco;
  // v0.73.0: continuity / image_prompting / character_generation.
  const cont = normalizeContinuityOverrides(args.continuityOverrides);
  if (cont) input.continuity_overrides = cont;
  const ip = normalizeImagePromptingOverrides(args.imagePromptingOverrides);
  if (ip) input.image_prompting_overrides = ip;
  const cg = normalizeCharacterGenerationOverrides(args.characterGenerationOverrides);
  if (cg) input.character_generation_overrides = cg;
  return { input };
}

// v0.42.0: pure builder for the finalize RunPod payload. Action gates
// the GPU dispatcher into the Wan-I2V-only + assemble branch (no
// fresh SDXL). Identical wire fields to buildSubmitPayload otherwise.
export function buildFinalizePayload(args: FinalizeArgs): { input: FinalizeJobInput } {
  const input: FinalizeJobInput = {
    action: "finalize",
    project: args.project,
    bundle_key: args.bundleKey,
    quality_tier: args.qualityTier ?? "final",
  };
  if (args.renderOverrides && Object.keys(args.renderOverrides).length > 0) {
    input.render_overrides = args.renderOverrides;
  }
  if (typeof args.userEmail === "string" && args.userEmail.length > 0) {
    input.user_email = args.userEmail;
  }
  // v0.45.0: only include the shot list when there is at least one
  // shot to process. An empty array stripped to undefined means "run
  // the full all-scenes flow" on the GPU side; that matches the
  // semantic the Worker route surfaces ("if nothing is locked, run
  // everything").
  if (Array.isArray(args.processShotIds) && args.processShotIds.length > 0) {
    input.process_shot_ids = [...args.processShotIds];
  }
  // v0.52.0: same audio_key passthrough as buildSubmitPayload.
  if (typeof args.audioKey === "string" && args.audioKey.length > 0) {
    input.audio_key = args.audioKey;
  }
  if (args.pretrainedLoras && Object.keys(args.pretrainedLoras).length > 0) {
    input.pretrained_loras = { ...args.pretrainedLoras };
  }
  const ltoF = normalizeLoraTrainOverrides(args.loraTrainOverrides);
  if (ltoF) input.lora_train_overrides = ltoF;
  const mcoF = normalizeMultiCharacterOverrides(args.multiCharacterOverrides);
  if (mcoF) input.multi_character_overrides = mcoF;
  const qgoF = normalizeQualityGateOverrides(args.qualityGateOverrides);
  if (qgoF) input.quality_gate_overrides = qgoF;
  const coF = normalizeConsistencyOverrides(args.consistencyOverrides);
  if (coF) input.consistency_overrides = coF;
  const vcoF = normalizeVideoConsistencyOverrides(args.videoConsistencyOverrides);
  if (vcoF) input.video_consistency_overrides = vcoF;
  const contF = normalizeContinuityOverrides(args.continuityOverrides);
  if (contF) input.continuity_overrides = contF;
  const ipF = normalizeImagePromptingOverrides(args.imagePromptingOverrides);
  if (ipF) input.image_prompting_overrides = ipF;
  const cgF = normalizeCharacterGenerationOverrides(args.characterGenerationOverrides);
  if (cgF) input.character_generation_overrides = cgF;
  return { input };
}

// v0.57.0: pure builder for the standalone LoRA training payload.
// Same wire shape as the render/finalize/regen actions; the GPU
// dispatcher routes on the `action` field.
export function buildTrainLoraPayload(args: TrainLoraArgs): { input: TrainLoraJobInput } {
  const input: TrainLoraJobInput = {
    action: "train_lora",
    project: args.project,
    bundle_key: args.bundleKey,
    lora_dest_key: args.loraDestKey,
  };
  if (typeof args.userEmail === "string" && args.userEmail.length > 0) {
    input.user_email = args.userEmail;
  }
  const lto = normalizeLoraTrainOverrides(args.loraTrainOverrides);
  if (lto) input.lora_train_overrides = lto;
  const qgo = normalizeQualityGateOverrides(args.qualityGateOverrides);
  if (qgo) input.quality_gate_overrides = qgo;
  return { input };
}

// v0.68.0: drop empty / non-positive entries before sending. The pod's
// _parse_lora_train_overrides accepts an empty object but we'd rather
// omit it entirely from the wire so older pods (no knowledge of the
// field) see the same bytes they always did. Only positive finite
// numbers are kept; everything else is silently dropped (clientside is
// best-effort - the pod also validates).
export function normalizeLoraTrainOverrides(
  raw: LoraTrainOverrides | undefined,
): LoraTrainOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: LoraTrainOverrides = {};
  const keys: Array<keyof LoraTrainOverrides> = [
    "steps", "learning_rate", "rank", "resolution", "timeout_seconds",
  ];
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.73.0: normalize continuity overrides.
export function normalizeContinuityOverrides(
  raw: ContinuityOverrides | undefined,
): ContinuityOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: ContinuityOverrides = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.use_last_frame === "boolean") out.use_last_frame = raw.use_last_frame;
  if (typeof raw.max_anchor_frames === "number" && Number.isInteger(raw.max_anchor_frames) && raw.max_anchor_frames >= 1 && raw.max_anchor_frames <= 32) {
    out.max_anchor_frames = raw.max_anchor_frames;
  }
  if (typeof raw.style_blend_corner === "boolean") out.style_blend_corner = raw.style_blend_corner;
  if (typeof raw.anchor_strip === "boolean") out.anchor_strip = raw.anchor_strip;
  if (typeof raw.chain_denoising === "number" && Number.isFinite(raw.chain_denoising) && raw.chain_denoising >= 0 && raw.chain_denoising <= 1) {
    out.chain_denoising = raw.chain_denoising;
  }
  if (typeof raw.trim_join_frame === "boolean") out.trim_join_frame = raw.trim_join_frame;
  if (typeof raw.trim_join_frames === "number" && Number.isInteger(raw.trim_join_frames) && raw.trim_join_frames >= 0 && raw.trim_join_frames <= 16) {
    out.trim_join_frames = raw.trim_join_frames;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.73.0: normalize image_prompting overrides.
export function normalizeImagePromptingOverrides(
  raw: ImagePromptingOverrides | undefined,
): ImagePromptingOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: ImagePromptingOverrides = {};
  if (typeof raw.anatomy_guard === "boolean") out.anatomy_guard = raw.anatomy_guard;
  if (raw.negative_mode === "focused" || raw.negative_mode === "full") {
    out.negative_mode = raw.negative_mode;
  }
  if (typeof raw.positive_extra === "string" && raw.positive_extra.length <= 512) {
    out.positive_extra = raw.positive_extra;
  }
  if (typeof raw.negative_extra === "string" && raw.negative_extra.length <= 512) {
    out.negative_extra = raw.negative_extra;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.73.0: normalize character_generation overrides.
export function normalizeCharacterGenerationOverrides(
  raw: CharacterGenerationOverrides | undefined,
): CharacterGenerationOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: CharacterGenerationOverrides = {};
  if (typeof raw.reference_denoising === "number" && Number.isFinite(raw.reference_denoising) && raw.reference_denoising >= 0 && raw.reference_denoising <= 1) {
    out.reference_denoising = raw.reference_denoising;
  }
  if (typeof raw.reference_prompt_suffix === "string" && raw.reference_prompt_suffix.length <= 512) {
    out.reference_prompt_suffix = raw.reference_prompt_suffix;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.72.0: normalize consistency overrides. Per-field unions /ranges.
export function normalizeConsistencyOverrides(
  raw: ConsistencyOverrides | undefined,
): ConsistencyOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: ConsistencyOverrides = {};
  if (typeof raw.default_strict === "boolean") out.default_strict = raw.default_strict;
  if (typeof raw.identity_lock === "boolean") out.identity_lock = raw.identity_lock;
  if (raw.seed_mode === "locked" || raw.seed_mode === "sequential" || raw.seed_mode === "random") {
    out.seed_mode = raw.seed_mode;
  }
  if (
    raw.face_lock_mode === "img2img" || raw.face_lock_mode === "ip_adapter"
    || raw.face_lock_mode === "instantid" || raw.face_lock_mode === "both"
  ) {
    out.face_lock_mode = raw.face_lock_mode;
  }
  if (raw.quality_tier === "draft" || raw.quality_tier === "standard" || raw.quality_tier === "final") {
    out.quality_tier = raw.quality_tier;
  }
  if (typeof raw.chain_denoising === "number" && Number.isFinite(raw.chain_denoising) && raw.chain_denoising >= 0 && raw.chain_denoising <= 1) {
    out.chain_denoising = raw.chain_denoising;
  }
  if (typeof raw.keyframe_suffix === "string" && raw.keyframe_suffix.length <= 512) {
    out.keyframe_suffix = raw.keyframe_suffix;
  }
  if (typeof raw.motion_suffix === "string" && raw.motion_suffix.length <= 512) {
    out.motion_suffix = raw.motion_suffix;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.72.0: normalize video_consistency overrides.
export function normalizeVideoConsistencyOverrides(
  raw: VideoConsistencyOverrides | undefined,
): VideoConsistencyOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: VideoConsistencyOverrides = {};
  if (typeof raw.chain_scenes === "boolean") out.chain_scenes = raw.chain_scenes;
  if (typeof raw.regenerate_keyframe_each_shot === "boolean") {
    out.regenerate_keyframe_each_shot = raw.regenerate_keyframe_each_shot;
  }
  if (typeof raw.motion_suffix_movie === "boolean") out.motion_suffix_movie = raw.motion_suffix_movie;
  if (typeof raw.identity_lock === "boolean") out.identity_lock = raw.identity_lock;
  if (typeof raw.ip_adapter_scale === "number" && Number.isFinite(raw.ip_adapter_scale) && raw.ip_adapter_scale >= 0 && raw.ip_adapter_scale <= 2) {
    out.ip_adapter_scale = raw.ip_adapter_scale;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.70.0: same shape, applied to lora_quality_gate overrides.
export function normalizeQualityGateOverrides(
  raw: QualityGateOverrides | undefined,
): QualityGateOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: QualityGateOverrides = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.min_file_bytes === "number" && Number.isInteger(raw.min_file_bytes) && raw.min_file_bytes >= 0) {
    out.min_file_bytes = raw.min_file_bytes;
  }
  if (typeof raw.probe_count === "number" && Number.isInteger(raw.probe_count) && raw.probe_count >= 1 && raw.probe_count <= 16) {
    out.probe_count = raw.probe_count;
  }
  if (typeof raw.min_ssim === "number" && Number.isFinite(raw.min_ssim) && raw.min_ssim >= 0 && raw.min_ssim <= 1) {
    out.min_ssim = raw.min_ssim;
  }
  if (typeof raw.pass_ssim === "number" && Number.isFinite(raw.pass_ssim) && raw.pass_ssim >= 0 && raw.pass_ssim <= 1) {
    out.pass_ssim = raw.pass_ssim;
  }
  if (typeof raw.default_trigger === "string" && raw.default_trigger.trim().length > 0 && raw.default_trigger.length <= 64) {
    out.default_trigger = raw.default_trigger;
  }
  if (typeof raw.probe_lora_scale === "number" && Number.isFinite(raw.probe_lora_scale) && raw.probe_lora_scale >= 0 && raw.probe_lora_scale <= 2) {
    out.probe_lora_scale = raw.probe_lora_scale;
  }
  if (typeof raw.base_seed === "number" && Number.isInteger(raw.base_seed) && raw.base_seed >= 0) {
    out.base_seed = raw.base_seed;
  }
  if (typeof raw.allow_warn === "boolean") out.allow_warn = raw.allow_warn;
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.69.0: same shape, applied to multi_character overrides. Validates
// each field's union/range; drops anything that doesn't conform so a
// UI typo doesn't reach the pod. The pod re-validates anyway.
export function normalizeMultiCharacterOverrides(
  raw: MultiCharacterOverrides | undefined,
): MultiCharacterOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: MultiCharacterOverrides = {};
  if (raw.mode === "auto" || raw.mode === "always" || raw.mode === "off") {
    out.mode = raw.mode;
  }
  if (typeof raw.auto_when_multi_slot === "boolean") {
    out.auto_when_multi_slot = raw.auto_when_multi_slot;
  }
  if (typeof raw.max_slots === "number" && Number.isInteger(raw.max_slots) && raw.max_slots >= 1 && raw.max_slots <= 4) {
    out.max_slots = raw.max_slots;
  }
  if (typeof raw.feather_px === "number" && Number.isFinite(raw.feather_px) && raw.feather_px >= 0 && raw.feather_px <= 256) {
    out.feather_px = Math.round(raw.feather_px);
  }
  if (raw.layout === "layer" || raw.layout === "side_by_side") {
    out.layout = raw.layout;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.41.0: pure builder for the per-shot regen RunPod payload. Mirrors
// buildSubmitPayload's shape so the dispatcher can use the same fetch
// surface. The GPU side dispatches by `action` and ignores fields
// irrelevant to its branch.
export function buildRegenShotPayload(args: RegenShotArgs): { input: RegenShotJobInput } {
  const input: RegenShotJobInput = {
    action: "regen_shot",
    project: args.project,
    bundle_key: args.bundleKey,
    shot_id: args.shotId,
    parent_job_id: args.parentJobId,
  };
  if (typeof args.userEmail === "string" && args.userEmail.length > 0) {
    input.user_email = args.userEmail;
  }
  return { input };
}

export function buildSubmitUrl(endpointId: string): string {
  return `${RUNPOD_BASE}/v2/${endpointId}/run`;
}

export function buildStatusUrl(endpointId: string, jobId: string): string {
  return `${RUNPOD_BASE}/v2/${endpointId}/status/${jobId}`;
}

export function buildCancelUrl(endpointId: string, jobId: string): string {
  return `${RUNPOD_BASE}/v2/${endpointId}/cancel/${jobId}`;
}

// Validate a job id at the route boundary so a malformed id does not
// produce a RunPod 404 we have to translate back. RunPod ids are
// alphanumeric with hyphens / underscores; the cap is generous since the
// platform has not published an exact format.
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidJobId(jobId: string): boolean {
  return JOB_ID_RE.test(jobId);
}

// Map RunPod's envelope to RunpodJobView. Tolerates missing fields and
// surfaces unknown status strings via `statusRaw`. Does not throw; the
// dispatcher decides how to translate transport errors to HTTP semantics.
export function normalizeRunpodResponse(raw: unknown): RunpodJobView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const jobId = typeof r.id === "string" ? r.id : "";
  const statusRaw = typeof r.status === "string" ? r.status : "";
  if (!jobId || !statusRaw) return null;
  const knownStatuses: RunpodStatus[] = [
    "IN_QUEUE",
    "IN_PROGRESS",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
  ];
  const status: RunpodStatus = knownStatuses.includes(statusRaw as RunpodStatus)
    ? (statusRaw as RunpodStatus)
    : "IN_PROGRESS"; // best-effort: keep the UI polling on unknown states
  const view: RunpodJobView = { jobId, status, statusRaw };
  if (r.output !== undefined) view.output = r.output;
  if (typeof r.error === "string" && r.error.length > 0) view.error = r.error;
  if (typeof r.executionTime === "number") view.executionTimeMs = r.executionTime;
  if (typeof r.delayTime === "number") view.delayTimeMs = r.delayTime;
  return view;
}

// Submit a job to the vivijure-serverless RunPod endpoint. Returns the
// normalized view or a transport error string. Does not throw on HTTP
// 4xx / 5xx; the caller decides how to translate to a Worker response.
export async function submitRenderJob(
  env: Env,
  args: RenderSubmitArgs,
): Promise<{ ok: true; view: RunpodJobView } | { ok: false; error: string; status?: number }> {
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) {
    return {
      ok: false,
      error:
        "RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID must be set on the Worker (npx wrangler secret put ...)",
    };
  }
  const url = buildSubmitUrl(env.RUNPOD_ENDPOINT_ID);
  const body = JSON.stringify(buildSubmitPayload(args));
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RUNPOD_API_KEY}`,
      },
      body,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `RunPod submit network error: ${m}` };
  }
  let raw: unknown;
  try {
    raw = await resp.json();
  } catch {
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      error: `RunPod submit returned non-JSON (status ${resp.status}): ${text.slice(0, 300)}`,
      status: resp.status,
    };
  }
  if (!resp.ok) {
    const errStr =
      raw && typeof raw === "object" && "error" in raw
        ? String((raw as Record<string, unknown>).error)
        : `HTTP ${resp.status}`;
    return { ok: false, error: `RunPod submit failed: ${errStr}`, status: resp.status };
  }
  const view = normalizeRunpodResponse(raw);
  if (!view) {
    return { ok: false, error: "RunPod submit returned an unrecognized envelope" };
  }
  return { ok: true, view };
}

// v0.42.0: submit a finalize job. Same transport contract as
// submitRenderJob (never throws on HTTP; returns a normalized result).
export async function submitFinalizeJob(
  env: Env,
  args: FinalizeArgs,
): Promise<{ ok: true; view: RunpodJobView } | { ok: false; error: string; status?: number }> {
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) {
    return {
      ok: false,
      error:
        "RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID must be set on the Worker (npx wrangler secret put ...)",
    };
  }
  const url = buildSubmitUrl(env.RUNPOD_ENDPOINT_ID);
  const body = JSON.stringify(buildFinalizePayload(args));
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RUNPOD_API_KEY}`,
      },
      body,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `RunPod finalize submit network error: ${m}` };
  }
  let raw: unknown;
  try {
    raw = await resp.json();
  } catch {
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      error: `RunPod finalize submit returned non-JSON (status ${resp.status}): ${text.slice(0, 300)}`,
      status: resp.status,
    };
  }
  if (!resp.ok) {
    const errStr =
      raw && typeof raw === "object" && "error" in raw
        ? String((raw as Record<string, unknown>).error)
        : `HTTP ${resp.status}`;
    return { ok: false, error: `RunPod finalize submit failed: ${errStr}`, status: resp.status };
  }
  const view = normalizeRunpodResponse(raw);
  if (!view) {
    return { ok: false, error: "RunPod finalize submit returned an unrecognized envelope" };
  }
  return { ok: true, view };
}

// v0.41.0: submit a per-shot regen job. Same transport contract as
// submitRenderJob (never throws on HTTP errors; returns a normalized
// result for the caller to shape into a Worker response). Hits the
// same /v2/<endpointId>/run; the GPU side dispatches by action.
export async function submitRegenShotJob(
  env: Env,
  args: RegenShotArgs,
): Promise<{ ok: true; view: RunpodJobView } | { ok: false; error: string; status?: number }> {
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) {
    return {
      ok: false,
      error:
        "RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID must be set on the Worker (npx wrangler secret put ...)",
    };
  }
  const url = buildSubmitUrl(env.RUNPOD_ENDPOINT_ID);
  const body = JSON.stringify(buildRegenShotPayload(args));
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RUNPOD_API_KEY}`,
      },
      body,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `RunPod regen submit network error: ${m}` };
  }
  let raw: unknown;
  try {
    raw = await resp.json();
  } catch {
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      error: `RunPod regen submit returned non-JSON (status ${resp.status}): ${text.slice(0, 300)}`,
      status: resp.status,
    };
  }
  if (!resp.ok) {
    const errStr =
      raw && typeof raw === "object" && "error" in raw
        ? String((raw as Record<string, unknown>).error)
        : `HTTP ${resp.status}`;
    return { ok: false, error: `RunPod regen submit failed: ${errStr}`, status: resp.status };
  }
  const view = normalizeRunpodResponse(raw);
  if (!view) {
    return { ok: false, error: "RunPod regen submit returned an unrecognized envelope" };
  }
  return { ok: true, view };
}

// v0.57.0: submit a standalone LoRA training job. Same transport
// shape as the render / finalize / regen submitters; differs only in
// the payload builder.
export async function submitTrainLoraJob(
  env: Env,
  args: TrainLoraArgs,
): Promise<{ ok: true; view: RunpodJobView } | { ok: false; error: string; status?: number }> {
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) {
    return {
      ok: false,
      error:
        "RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID must be set on the Worker (npx wrangler secret put ...)",
    };
  }
  const url = buildSubmitUrl(env.RUNPOD_ENDPOINT_ID);
  const body = JSON.stringify(buildTrainLoraPayload(args));
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RUNPOD_API_KEY}`,
      },
      body,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `RunPod train-lora submit network error: ${m}` };
  }
  let raw: unknown;
  try {
    raw = await resp.json();
  } catch {
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      error: `RunPod train-lora submit returned non-JSON (status ${resp.status}): ${text.slice(0, 300)}`,
      status: resp.status,
    };
  }
  if (!resp.ok) {
    const errStr =
      raw && typeof raw === "object" && "error" in raw
        ? String((raw as Record<string, unknown>).error)
        : `HTTP ${resp.status}`;
    return { ok: false, error: `RunPod train-lora submit failed: ${errStr}`, status: resp.status };
  }
  const view = normalizeRunpodResponse(raw);
  if (!view) {
    return { ok: false, error: "RunPod train-lora submit returned an unrecognized envelope" };
  }
  return { ok: true, view };
}

// Cancel one job. RunPod's cancel endpoint is POST /v2/<id>/cancel/<job>;
// we expose it under our DELETE /api/storyboard/render/<jobId> route. Same
// transport contract as submitRenderJob and pollRenderJob: never throws on
// HTTP errors; returns a normalized result for the caller to shape into a
// Worker response. Calling cancel on a job that is already terminal (or
// never existed) returns RunPod's error envelope; we surface it verbatim.
export async function cancelRenderJob(
  env: Env,
  jobId: string,
): Promise<{ ok: true; view: RunpodJobView } | { ok: false; error: string; status?: number }> {
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) {
    return {
      ok: false,
      error:
        "RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID must be set on the Worker (npx wrangler secret put ...)",
    };
  }
  const url = buildCancelUrl(env.RUNPOD_ENDPOINT_ID, jobId);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${env.RUNPOD_API_KEY}` },
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `RunPod cancel network error: ${m}` };
  }
  let raw: unknown;
  try {
    raw = await resp.json();
  } catch {
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      error: `RunPod cancel returned non-JSON (status ${resp.status}): ${text.slice(0, 300)}`,
      status: resp.status,
    };
  }
  if (!resp.ok) {
    const errStr =
      raw && typeof raw === "object" && "error" in raw
        ? String((raw as Record<string, unknown>).error)
        : `HTTP ${resp.status}`;
    return { ok: false, error: `RunPod cancel failed: ${errStr}`, status: resp.status };
  }
  const view = normalizeRunpodResponse(raw);
  if (!view) {
    return { ok: false, error: "RunPod cancel returned an unrecognized envelope" };
  }
  return { ok: true, view };
}

// Poll one job's status. Same transport contract as submitRenderJob: never
// throws on HTTP errors; returns a normalized result for the caller to
// shape into a Worker response.
export async function pollRenderJob(
  env: Env,
  jobId: string,
): Promise<{ ok: true; view: RunpodJobView } | { ok: false; error: string; status?: number }> {
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) {
    return {
      ok: false,
      error:
        "RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID must be set on the Worker (npx wrangler secret put ...)",
    };
  }
  const url = buildStatusUrl(env.RUNPOD_ENDPOINT_ID, jobId);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${env.RUNPOD_API_KEY}` },
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `RunPod poll network error: ${m}` };
  }
  let raw: unknown;
  try {
    raw = await resp.json();
  } catch {
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      error: `RunPod poll returned non-JSON (status ${resp.status}): ${text.slice(0, 300)}`,
      status: resp.status,
    };
  }
  if (!resp.ok) {
    const errStr =
      raw && typeof raw === "object" && "error" in raw
        ? String((raw as Record<string, unknown>).error)
        : `HTTP ${resp.status}`;
    return { ok: false, error: `RunPod poll failed: ${errStr}`, status: resp.status };
  }
  const view = normalizeRunpodResponse(raw);
  if (!view) {
    return { ok: false, error: "RunPod poll returned an unrecognized envelope" };
  }
  return { ok: true, view };
}
