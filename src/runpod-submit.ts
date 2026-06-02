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
  // v0.74.0: face_lock + instantid (vivijure-serverless 0.4.30+).
  faceLockOverrides?: FaceLockOverrides;
  // v0.75.0: production.adetailer sub-block + wan_diffusion block
  // (vivijure-serverless 0.4.31+).
  adetailerOverrides?: AdetailerOverrides;
  wanDiffusionOverrides?: WanDiffusionOverrides;
  // v0.76.0: local_diffusion block + generation block
  // (vivijure-serverless 0.4.32+).
  localDiffusionOverrides?: LocalDiffusionOverrides;
  generationOverrides?: GenerationOverrides;
  // v0.77.0: top-level scene-length scalars + movie block
  // (vivijure-serverless 0.4.34+).
  sceneLengthOverrides?: SceneLengthOverrides;
  movieOverrides?: MovieOverrides;
  // v0.78.0: character_bible block + production sub-keys + top-level
  // switches (vivijure-serverless 0.4.35+).
  characterBibleOverrides?: CharacterBibleOverrides;
  productionOverrides?: ProductionOverrides;
  topLevelSwitches?: TopLevelSwitches;
  // v0.79.0: loras.training extras + loras top-level + quality
  // (ffmpeg encoding) + image_models default profile
  // (vivijure-serverless 0.4.37+).
  loraTrainExtras?: LoraTrainExtras;
  lorasOverrides?: LorasOverrides;
  qualityOverrides?: QualityOverrides;
  imageModelsOverrides?: ImageModelsOverrides;
  // v0.82.0 (Phase 13): prompt-template overrides (vivijure-
  // serverless 0.4.49+).
  promptTemplatesOverrides?: PromptTemplatesOverrides;
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

// v0.79.0: loras.training extras - the four loras.training keys
// the v0.68.0 LoraTrainOverrides interface doesn't cover (enabled,
// min_images, max_images, trigger_template). Routes through
// vivijure-serverless 0.4.37+ via the lora_train module-global.
export interface LoraTrainExtras {
  // Master switch for the LoRA training pass. Pod default false on
  // a stock config; the orchestrator flips it on per-job when slots
  // need training, so the explicit override is rarely needed.
  enabled?: boolean;
  // Minimum image count before training proceeds. Pod default 8.
  // Below this the gate hard-fails the slot.
  min_images?: number;             // int 1..64
  // Cap on training image count. Pod default 30.
  max_images?: number;             // int 1..256
  // Pattern used to derive the trigger word from the character name.
  // Pod default "chr_{name}" produces e.g. "chr_aria" for "Aria".
  // Changing this affects all NEW LoRA training runs (existing
  // .safetensors keep their trigger).
  trigger_template?: string;       // max 64 chars
}

// v0.79.0: loras top-level - default LoRA scale fallback. Pod default
// 0.75 applies when no per-row scale is set in the catalog. The
// flat render_overrides.lora_scale key still wins per-render.
export interface LorasOverrides {
  default_scale?: number;          // 0..2
}

// v0.79.0: quality block - the ffmpeg encoding knobs the assembly
// step uses. Pod default crf=18 + preset=medium.
export interface QualityOverrides {
  // ffmpeg CRF. 0=lossless, 18=visually-lossless, 23=ffmpeg default,
  // 51=worst. Pod default 18.
  assemble_crf?: number;           // int 0..51
  // ffmpeg preset. ultrafast / superfast / veryfast / faster / fast /
  // medium / slow / slower / veryslow. Pod default "medium".
  assemble_preset?: string;        // max 32 chars
}

// v0.79.0: image_models.default_profile - the SDXL profile id the
// renderer picks when the manifest has style_category="None".
// Discoverable via GET /api/image-models on the pod UI (legacy).
export interface ImageModelsOverrides {
  default_profile?: string;        // max 64 chars; e.g. "anime_sdxl"
}

// v0.78.0: character_bible block - the auto-condensed cast bible
// the renderer prepends to every shot. Routes through vivijure-
// serverless 0.4.35+'s in-place CONFIG mutation.
export interface CharacterBibleOverrides {
  // Master switch for the cast-bible injection. Pod default true.
  enabled?: boolean;
  // Cap on per-character bible length (chars). Pod default 220.
  max_chars_per_character?: number; // int 1..2000
  // Header string prepended to the bible. Pod default
  // "CHARACTER BIBLE - same face, hair, outfit in every shot"
  header?: string;                  // max 256 chars
}

// v0.78.0: production block - the top-level production knobs
// (NOT the adetailer / multi_character sub-blocks, which have their
// own overrides). Routes through vivijure-serverless 0.4.35+.
export interface ProductionOverrides {
  // Master switch for the hand-fix inpaint pass on keyframes. Pod default true.
  hand_fix_keyframes?: boolean;
  // Master switch for the adetailer inpaint pass on keyframes. Pod default true.
  adetailer_keyframes?: boolean;
  // Minimum reference images per character before render proceeds. Pod default 3.
  min_character_refs?: number;      // int 0..32
  // Cap on reference images per character. Pod default 12.
  max_character_refs?: number;      // int 1..64
  // Reference count target for character-bible quality. Pod default 8.
  bible_reference_target?: number;  // int 0..32
  // Shot-count floor that triggers LoRA training. Pod default 30.
  lora_shot_threshold?: number;     // int 0..500
}

// v0.78.0: top-level boolean / string switches that affect overall
// pipeline behavior. Routes through vivijure-serverless 0.4.35+'s
// direct CONFIG mutation; movie_mode + production_gates + hand_fix
// all delegate to core.CONFIG now (0.4.35 fix).
export interface TopLevelSwitches {
  // "clips" (per-scene independent) vs "movie" (chained narrative). Pod default "movie".
  production_mode?: "clips" | "movie";
  // Always apply the style reference image (when one is set). Pod default false.
  always_use_style_reference?: boolean;
  // Crossfade between assembled clips. Pod default true.
  assemble_use_crossfade?: boolean;
  // Auto-trigger the render-clips pass on bundle. Pod default true.
  auto_render_clips?: boolean;
  // Auto-bootstrap a start image from the first cast portrait when none provided. Pod default true.
  auto_bootstrap_start_image?: boolean;
}

// v0.77.0: top-level scene-length scalars. Affect clip-duration
// computation in the renderer + scene-cap gates in story planning.
// Routed through vivijure-serverless 0.4.34+'s in-place mutation
// of the five flat keys on core.CONFIG.
export interface SceneLengthOverrides {
  // Target seconds per scene when no explicit duration. Pod default 8.0.
  target_scene_seconds?: number; // 0.5..60
  // Lower bound for scene length. Pod default 6.0.
  min_scene_seconds?: number;    // 0.5..60
  // Upper bound for scene length. Pod default 10.0.
  max_scene_seconds?: number;    // 0.5..60
  // Hard cap on total video length. Pod default 900s.
  max_video_seconds?: number;    // int 1..7200
  // Hard cap on scene count. Pod default 100.
  max_scenes?: number;           // int 1..500
}

// v0.77.0: movie block - the chained-scenes / motion / per-clip Wan
// defaults used in movie production mode. Routes through vivijure-
// serverless 0.4.34+'s in-place CONFIG mutation.
export interface MovieOverrides {
  // Target clip seconds (movie mode). Pod default 8.0.
  default_clip_seconds?: number; // 0.5..60
  // Lower bound for movie-mode clips. Pod default 6.0.
  min_clip_seconds?: number;     // 0.5..60
  // When >0, forces exactly N shots ignoring duration math. Pod default 0 (off).
  default_force_shots?: number;  // int 0..500
  // Default movie duration when not specified by the user. Pod default 2 minutes.
  default_duration_minutes?: number; // int 0..120
  // Crossfade seconds between movie clips. Pod default 0.45.
  crossfade_seconds?: number;    // 0..5
  // Whether to chain scenes (previous shot's last frame seeds the next). Pod default true.
  chain_scenes?: boolean;
  // Movie-mode Wan frame count per clip. Pod default 97 (~6s at 16fps).
  wan_num_frames?: number;       // int 1..256
  // Movie-mode Wan inference steps per clip. Pod default 22.
  wan_inference_steps?: number;  // int 1..64
  // Movie-mode Wan fps. Pod default 16.
  wan_fps?: number;              // int 1..120
  // Movie-mode motion-prompt suffix appended to every shot. Pod default
  // "smooth cinematic camera motion, natural movement, temporal consistency, film sequence".
  motion_suffix?: string;        // max 512 chars
}

// v0.76.0: local_diffusion block - the SDXL base + keyframe-SDXL knobs
// the pod uses for keyframe generation. Routes through to vivijure-
// serverless 0.4.32+'s in-place mutation of core.CONFIG["local_diffusion"].
export interface LocalDiffusionOverrides {
  // Base SDXL model id. Pod default stabilityai/sdxl-turbo.
  model_id?: string;
  // "WIDTHxHEIGHT" string. Pod default "1920x1080".
  resolution?: string;
  // "WIDTHxHEIGHT" string. Pod default "1080x1920".
  portrait_resolution?: string;
  // Inference steps for the base SDXL path. Pod default 6 (turbo).
  steps?: number;             // int 1..64
  // CFG guidance. Pod default 0.0 for turbo.
  guidance_scale?: number;    // 0..30
  // img2img denoise. Pod default 0.46.
  denoising_strength?: number; // 0..1
  // "gpu" | "cpu". Pod default "gpu".
  device?: string;
  // "float16" | "float32" | "bfloat16". Pod default float16.
  dtype?: string;
  // Offload SDXL to CPU between calls to free VRAM for Wan. Pod default false.
  sequential_cpu_offload?: boolean;
  // Override keyframe-stage SDXL model. Empty = auto-detect a CFG-capable
  // base (turbo is refused because it drops the unconditional pass).
  keyframe_model_id?: string;
  // CFG for the keyframe stage. Pod default 6.0.
  keyframe_guidance_scale?: number; // 0..30
  // Steps for the keyframe stage. Pod default 28.
  keyframe_steps?: number;          // int 1..128
}

// v0.76.0: generation block - seed handling. seed_mode is already exposed
// as a flat render_overrides key (v0.71.0); this lets seed + seed_per_
// shot_step also be Worker-driven without a pod rebuild.
export interface GenerationOverrides {
  // "random" | "locked" | "sequential". Pod default "locked".
  seed_mode?: "random" | "locked" | "sequential";
  // Base RNG seed. Pod default 424242.
  seed?: number;                // int >=0
  // sequential mode only: seed + shot_index*step. Pod default 1.
  seed_per_shot_step?: number;  // int 1..1000
}

// v0.75.0: production.adetailer sub-block - the hand/face inpaint
// pass that runs after the SDXL keyframe. Routes through to vivijure-
// serverless 0.4.31+'s adetailer_fix.set_overrides; adetailer_cfg()
// merges these over config.yaml's production.adetailer block.
export interface AdetailerOverrides {
  // Master switch for the adetailer hand/face fix pass.
  enabled?: boolean;
  // When true, scan keyframes for malformed hands and inpaint them.
  fix_hands?: boolean;
  // When true, scan keyframes for face artifacts and inpaint them.
  fix_face?: boolean;
  // Cap on detected regions to fix per keyframe. Pod default 3; higher
  // = more passes per image (slower but catches more artifacts).
  max_regions?: number;     // int 1..8
  // Padding multiplier around each detected bbox before inpaint.
  // 0..1 typical; higher = more context for inpaint coherence.
  bbox_pad?: number;        // float 0..1
  // SDXL inpaint denoising strength on the patch. 0..1; higher =
  // more aggressive rewrite, lower = preserve more of the original.
  inpaint_strength?: number;
  // Detector confidence floor before a region is treated as a hand.
  // 0..1; lower = catches subtle malformations, higher = fewer
  // false positives.
  hand_confidence?: number;
  // v0.82.0 (Phase 13): face detector confidence floor; same shape
  // as hand_confidence. Pod default 0.5.
  face_confidence?: number;
  // Extra SDXL steps added to the inpaint pass for each detected
  // region. Pod default 2. 0..16.
  extra_steps?: number;
}

// v0.75.0: wan_diffusion block - Wan 2.1 I2V/T2V model + inference
// knobs. Routes through to vivijure-serverless 0.4.31+'s in-place
// mutation of core.CONFIG["wan_diffusion"] (same approach as the
// Phase 4 render constants).
export interface WanDiffusionOverrides {
  // Default T2V model. Pod default Wan-AI/Wan2.1-T2V-1.3B-Diffusers.
  t2v_model_id?: string;
  // Default I2V model. Pod default Wan-AI/Wan2.1-I2V-14B-480P-Diffusers.
  i2v_model_id?: string;
  // When true and a keyframe is provided, the renderer uses I2V; else T2V.
  use_i2v_when_start_image?: boolean;
  // Frames per Wan shot. Pod default 33 (~2s at 16fps).
  num_frames?: number;      // int 1..256
  // Hard ceiling on Wan's per-shot frame count. Pod default 121.
  max_frames?: number;      // int 1..256
  // Wan video frame rate. Pod default 16.
  fps?: number;             // int 1..120
  // Wan inference steps per shot. Pod default 16. Higher = slower
  // but cleaner motion.
  num_inference_steps?: number; // int 1..64
  // Wan CFG guidance. Pod default 5.0. 0..30 typical.
  guidance_scale?: number;
  // Wan flow-matching shift. Pod default 5.0.
  flow_shift?: number;
  // Offload the Wan pipeline to CPU between shots to save VRAM. Pod default true.
  cpu_offload?: boolean;
  // Target seconds per shot used to derive num_frames if no shot
  // duration is specified. Pod default 5.0.
  seconds_per_shot?: number;
  // v0.82.0 (Phase 13): override the vivijure-pinned WAN_DEFAULT_
  // NEGATIVE prompt that ships with Wan I2V/T2V. Pre-Phase-13 the
  // pod read wan_negative_prompt off the wan_diffusion config but
  // the key was never in the override schema, so it was unreachable
  // from the payload. Pod default: "duplicate, multi-subject,
  // deformed, ..." (see WAN_DEFAULT_NEGATIVE in wan_video.py).
  wan_negative_prompt?: string;
}

// v0.82.0 (Phase 13): prompt-template overrides. Vivijure pre-Phase-13
// had ~10 hardcoded prompt strings in prompt_engine.py + 2 in hand_
// fix.py used as positive / negative scaffolding around every keyframe
// render. Changing them required a docker rebuild. Phase 13 makes them
// payload-routable via vivijure-serverless 0.4.49+'s
// prompt_engine.set_template_overrides + hand_fix.set_prompt_overrides
// (dispatched by orchestrator._install_prompt_templates_overrides).
//
// Most fields are flat strings; framing_hints is a list (string per
// shot, cycled by shot_index % len); act_mood is a {act-name: phrase}
// map. The pod re-validates structure on receipt.
export interface PromptTemplatesOverrides {
  // Quality preamble appended to every keyframe positive (default
  // "masterpiece, best quality, extremely detailed, sharp focus,
  //  professional composition").
  anatomy_positive_base?: string;
  // Human-subject anatomy positive (default "perfect anatomy,
  // correct human proportions, symmetrical face, well-drawn hands,
  // five fingers on each hand..."). Applied when the scene mentions
  // a human.
  anatomy_positive_human?: string;
  // Anime-style anatomy positive (default "anime key visual, clean
  // linework..."). Applied when style is anime.
  anatomy_positive_anime?: string;
  // Global negative used when image_prompting.negative_mode is
  // "full".
  anatomy_negative_global?: string;
  // Focused negative used when image_prompting.negative_mode is
  // "focused".
  anatomy_negative_focused?: string;
  // Portrait-only negative appended for character portraits (e.g.
  // "long neck, uncanny valley, ...").
  anatomy_negative_portrait?: string;
  // Anime-style negative appended when style is anime.
  anatomy_negative_anime?: string;
  // Portrait positive ("solo, centered, clear face, single
  // subject").
  portrait_positive?: string;
  // Hand-fix positive injected by the ADetailer hand pass (default
  // "well-drawn hands, five fingers per hand, ...").
  hand_positive?: string;
  // Hand-fix negative injected by the ADetailer hand pass.
  hand_negative?: string;
  // List of framing phrases cycled per shot index. Pod default 10
  // entries: "wide establishing shot", "medium shot", "close-up",
  // etc. Pass a non-empty list to replace entirely.
  framing_hints?: string[];
  // Per-act mood phrases. Pod default keys "Opening", "Rising
  // Action", "Climax", "Falling Action", "Resolution".
  act_mood?: Record<string, string>;
}

// v0.74.0: matching face_lock block from config.yaml. Routes through to
// vivijure-serverless 0.4.30+'s face_lock.set_overrides which deep-
// merges the instantid sub-block. All fields optional.
export interface FaceLockOverrides {
  mode?: "img2img" | "ip_adapter" | "instantid" | "both";
  ip_adapter_repo?: string;
  ip_adapter_subfolder?: string;
  ip_adapter_weight?: string;
  // IP-Adapter strength; pod default 0.65. Higher = more identity
  // pull. 0..1 is the sensible range.
  ip_adapter_scale?: number;
  instantid?: {
    enabled?: boolean;
    base_model_id?: string;
    controlnet_model_id?: string;
    adapter_repo?: string;
    adapter_weight?: string;
    // 0..1.5 typical. Pod default 0.8.
    controlnet_scale?: number;
    // 0..1.5 typical. Pod default 0.8.
    ip_adapter_scale?: number;
    antelope_root?: string;
  };
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
  // v0.74.0: face_lock + instantid (0.4.30+).
  face_lock_overrides?: FaceLockOverrides;
  // v0.75.0: adetailer + wan_diffusion (0.4.31+).
  adetailer_overrides?: AdetailerOverrides;
  wan_diffusion_overrides?: WanDiffusionOverrides;
  // v0.76.0: local_diffusion + generation (0.4.32+).
  local_diffusion_overrides?: LocalDiffusionOverrides;
  generation_overrides?: GenerationOverrides;
  // v0.77.0: scene-length scalars + movie block (0.4.34+).
  scene_length_overrides?: SceneLengthOverrides;
  movie_overrides?: MovieOverrides;
  // v0.78.0: character_bible + production sub-keys + top-level switches (0.4.35+).
  character_bible_overrides?: CharacterBibleOverrides;
  production_overrides?: ProductionOverrides;
  top_level_switches?: TopLevelSwitches;
  // v0.79.0: lora_train_extras + loras + quality + image_models (0.4.37+).
  lora_train_extras?: LoraTrainExtras;
  loras_overrides?: LorasOverrides;
  quality_overrides?: QualityOverrides;
  image_models_overrides?: ImageModelsOverrides;
  // v0.82.0 (Phase 13): prompt_templates (vivijure-serverless 0.4.49+).
  prompt_templates_overrides?: PromptTemplatesOverrides;
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
  // v0.74.0: same face_lock override.
  faceLockOverrides?: FaceLockOverrides;
  // v0.75.0: same adetailer + wan_diffusion overrides as RenderSubmitArgs.
  adetailerOverrides?: AdetailerOverrides;
  wanDiffusionOverrides?: WanDiffusionOverrides;
  // v0.76.0: same local_diffusion + generation overrides as RenderSubmitArgs.
  localDiffusionOverrides?: LocalDiffusionOverrides;
  generationOverrides?: GenerationOverrides;
  // v0.77.0: same scene_length + movie overrides as RenderSubmitArgs.
  sceneLengthOverrides?: SceneLengthOverrides;
  movieOverrides?: MovieOverrides;
  // v0.78.0: same character_bible + production + switches as RenderSubmitArgs.
  characterBibleOverrides?: CharacterBibleOverrides;
  productionOverrides?: ProductionOverrides;
  topLevelSwitches?: TopLevelSwitches;
  // v0.79.0: same lora_train_extras + loras + quality + image_models as RenderSubmitArgs.
  loraTrainExtras?: LoraTrainExtras;
  // v0.82.0 (Phase 13): same prompt_templates as RenderSubmitArgs.
  promptTemplatesOverrides?: PromptTemplatesOverrides;
  lorasOverrides?: LorasOverrides;
  qualityOverrides?: QualityOverrides;
  imageModelsOverrides?: ImageModelsOverrides;
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
  face_lock_overrides?: FaceLockOverrides;
  adetailer_overrides?: AdetailerOverrides;
  wan_diffusion_overrides?: WanDiffusionOverrides;
  local_diffusion_overrides?: LocalDiffusionOverrides;
  generation_overrides?: GenerationOverrides;
  scene_length_overrides?: SceneLengthOverrides;
  movie_overrides?: MovieOverrides;
  character_bible_overrides?: CharacterBibleOverrides;
  production_overrides?: ProductionOverrides;
  top_level_switches?: TopLevelSwitches;
  lora_train_extras?: LoraTrainExtras;
  prompt_templates_overrides?: PromptTemplatesOverrides;
  loras_overrides?: LorasOverrides;
  quality_overrides?: QualityOverrides;
  image_models_overrides?: ImageModelsOverrides;
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
  // v0.74.0: face_lock + instantid.
  const fl = normalizeFaceLockOverrides(args.faceLockOverrides);
  if (fl) input.face_lock_overrides = fl;
  // v0.75.0: adetailer + wan_diffusion.
  const ad = normalizeAdetailerOverrides(args.adetailerOverrides);
  if (ad) input.adetailer_overrides = ad;
  const wd = normalizeWanDiffusionOverrides(args.wanDiffusionOverrides);
  if (wd) input.wan_diffusion_overrides = wd;
  // v0.76.0: local_diffusion + generation.
  const ld = normalizeLocalDiffusionOverrides(args.localDiffusionOverrides);
  if (ld) input.local_diffusion_overrides = ld;
  const gen = normalizeGenerationOverrides(args.generationOverrides);
  if (gen) input.generation_overrides = gen;
  // v0.77.0: scene-length + movie.
  const sl = normalizeSceneLengthOverrides(args.sceneLengthOverrides);
  if (sl) input.scene_length_overrides = sl;
  const mv = normalizeMovieOverrides(args.movieOverrides);
  if (mv) input.movie_overrides = mv;
  // v0.78.0: character_bible + production + switches.
  const cb = normalizeCharacterBibleOverrides(args.characterBibleOverrides);
  if (cb) input.character_bible_overrides = cb;
  const pr = normalizeProductionOverrides(args.productionOverrides);
  if (pr) input.production_overrides = pr;
  const tls = normalizeTopLevelSwitches(args.topLevelSwitches);
  if (tls) input.top_level_switches = tls;
  // v0.79.0: lora train extras + loras + quality + image_models.
  const lte = normalizeLoraTrainExtras(args.loraTrainExtras);
  if (lte) input.lora_train_extras = lte;
  const lor = normalizeLorasOverrides(args.lorasOverrides);
  if (lor) input.loras_overrides = lor;
  const ql = normalizeQualityOverrides(args.qualityOverrides);
  if (ql) input.quality_overrides = ql;
  const im = normalizeImageModelsOverrides(args.imageModelsOverrides);
  if (im) input.image_models_overrides = im;
  // v0.82.0 (Phase 13): prompt-template overrides.
  const pt = normalizePromptTemplatesOverrides(args.promptTemplatesOverrides);
  if (pt) input.prompt_templates_overrides = pt;
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
  const flF = normalizeFaceLockOverrides(args.faceLockOverrides);
  if (flF) input.face_lock_overrides = flF;
  const adF = normalizeAdetailerOverrides(args.adetailerOverrides);
  if (adF) input.adetailer_overrides = adF;
  const wdF = normalizeWanDiffusionOverrides(args.wanDiffusionOverrides);
  if (wdF) input.wan_diffusion_overrides = wdF;
  const ldF = normalizeLocalDiffusionOverrides(args.localDiffusionOverrides);
  if (ldF) input.local_diffusion_overrides = ldF;
  const genF = normalizeGenerationOverrides(args.generationOverrides);
  if (genF) input.generation_overrides = genF;
  const slF = normalizeSceneLengthOverrides(args.sceneLengthOverrides);
  if (slF) input.scene_length_overrides = slF;
  const mvF = normalizeMovieOverrides(args.movieOverrides);
  if (mvF) input.movie_overrides = mvF;
  const cbF = normalizeCharacterBibleOverrides(args.characterBibleOverrides);
  if (cbF) input.character_bible_overrides = cbF;
  const prF = normalizeProductionOverrides(args.productionOverrides);
  if (prF) input.production_overrides = prF;
  const tlsF = normalizeTopLevelSwitches(args.topLevelSwitches);
  if (tlsF) input.top_level_switches = tlsF;
  const lteF = normalizeLoraTrainExtras(args.loraTrainExtras);
  if (lteF) input.lora_train_extras = lteF;
  const lorF = normalizeLorasOverrides(args.lorasOverrides);
  if (lorF) input.loras_overrides = lorF;
  const qlF = normalizeQualityOverrides(args.qualityOverrides);
  if (qlF) input.quality_overrides = qlF;
  const imF = normalizeImageModelsOverrides(args.imageModelsOverrides);
  if (imF) input.image_models_overrides = imF;
  const ptF = normalizePromptTemplatesOverrides(args.promptTemplatesOverrides);
  if (ptF) input.prompt_templates_overrides = ptF;
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

// v0.79.0: normalize lora train extras.
export function normalizeLoraTrainExtras(
  raw: LoraTrainExtras | undefined,
): LoraTrainExtras | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: LoraTrainExtras = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.min_images === "number" && Number.isInteger(raw.min_images) && raw.min_images >= 1 && raw.min_images <= 64) {
    out.min_images = raw.min_images;
  }
  if (typeof raw.max_images === "number" && Number.isInteger(raw.max_images) && raw.max_images >= 1 && raw.max_images <= 256) {
    out.max_images = raw.max_images;
  }
  if (typeof raw.trigger_template === "string" && raw.trigger_template.length > 0 && raw.trigger_template.length <= 64) {
    out.trigger_template = raw.trigger_template;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.79.0: normalize loras top-level.
export function normalizeLorasOverrides(
  raw: LorasOverrides | undefined,
): LorasOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: LorasOverrides = {};
  if (typeof raw.default_scale === "number" && Number.isFinite(raw.default_scale) && raw.default_scale >= 0 && raw.default_scale <= 2) {
    out.default_scale = raw.default_scale;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.79.0: normalize quality (ffmpeg) overrides.
const _FFMPEG_PRESETS = new Set([
  "ultrafast", "superfast", "veryfast", "faster", "fast",
  "medium", "slow", "slower", "veryslow",
]);
export function normalizeQualityOverrides(
  raw: QualityOverrides | undefined,
): QualityOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: QualityOverrides = {};
  if (typeof raw.assemble_crf === "number" && Number.isInteger(raw.assemble_crf) && raw.assemble_crf >= 0 && raw.assemble_crf <= 51) {
    out.assemble_crf = raw.assemble_crf;
  }
  if (typeof raw.assemble_preset === "string" && _FFMPEG_PRESETS.has(raw.assemble_preset)) {
    out.assemble_preset = raw.assemble_preset;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.79.0: normalize image_models overrides.
export function normalizeImageModelsOverrides(
  raw: ImageModelsOverrides | undefined,
): ImageModelsOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: ImageModelsOverrides = {};
  if (typeof raw.default_profile === "string" && raw.default_profile.length > 0 && raw.default_profile.length <= 64) {
    out.default_profile = raw.default_profile;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.78.0: normalize character_bible overrides.
export function normalizeCharacterBibleOverrides(
  raw: CharacterBibleOverrides | undefined,
): CharacterBibleOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: CharacterBibleOverrides = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.max_chars_per_character === "number" && Number.isInteger(raw.max_chars_per_character) && raw.max_chars_per_character >= 1 && raw.max_chars_per_character <= 2000) {
    out.max_chars_per_character = raw.max_chars_per_character;
  }
  if (typeof raw.header === "string" && raw.header.length <= 256) {
    out.header = raw.header;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.78.0: normalize production sub-key overrides (top-level keys
// inside the production block; NOT the adetailer / multi_character
// sub-blocks which have their own normalizers).
export function normalizeProductionOverrides(
  raw: ProductionOverrides | undefined,
): ProductionOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: ProductionOverrides = {};
  if (typeof raw.hand_fix_keyframes === "boolean") out.hand_fix_keyframes = raw.hand_fix_keyframes;
  if (typeof raw.adetailer_keyframes === "boolean") out.adetailer_keyframes = raw.adetailer_keyframes;
  if (typeof raw.min_character_refs === "number" && Number.isInteger(raw.min_character_refs) && raw.min_character_refs >= 0 && raw.min_character_refs <= 32) {
    out.min_character_refs = raw.min_character_refs;
  }
  if (typeof raw.max_character_refs === "number" && Number.isInteger(raw.max_character_refs) && raw.max_character_refs >= 1 && raw.max_character_refs <= 64) {
    out.max_character_refs = raw.max_character_refs;
  }
  if (typeof raw.bible_reference_target === "number" && Number.isInteger(raw.bible_reference_target) && raw.bible_reference_target >= 0 && raw.bible_reference_target <= 32) {
    out.bible_reference_target = raw.bible_reference_target;
  }
  if (typeof raw.lora_shot_threshold === "number" && Number.isInteger(raw.lora_shot_threshold) && raw.lora_shot_threshold >= 0 && raw.lora_shot_threshold <= 500) {
    out.lora_shot_threshold = raw.lora_shot_threshold;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.78.0: normalize top-level switches.
export function normalizeTopLevelSwitches(
  raw: TopLevelSwitches | undefined,
): TopLevelSwitches | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: TopLevelSwitches = {};
  if (raw.production_mode === "clips" || raw.production_mode === "movie") {
    out.production_mode = raw.production_mode;
  }
  if (typeof raw.always_use_style_reference === "boolean") out.always_use_style_reference = raw.always_use_style_reference;
  if (typeof raw.assemble_use_crossfade === "boolean") out.assemble_use_crossfade = raw.assemble_use_crossfade;
  if (typeof raw.auto_render_clips === "boolean") out.auto_render_clips = raw.auto_render_clips;
  if (typeof raw.auto_bootstrap_start_image === "boolean") out.auto_bootstrap_start_image = raw.auto_bootstrap_start_image;
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.77.0: normalize scene-length overrides. All 5 keys are top-level
// scalars on the pod's config.yaml; the integer keys must be integers.
export function normalizeSceneLengthOverrides(
  raw: SceneLengthOverrides | undefined,
): SceneLengthOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: SceneLengthOverrides = {};
  if (typeof raw.target_scene_seconds === "number" && Number.isFinite(raw.target_scene_seconds) && raw.target_scene_seconds >= 0.5 && raw.target_scene_seconds <= 60) {
    out.target_scene_seconds = raw.target_scene_seconds;
  }
  if (typeof raw.min_scene_seconds === "number" && Number.isFinite(raw.min_scene_seconds) && raw.min_scene_seconds >= 0.5 && raw.min_scene_seconds <= 60) {
    out.min_scene_seconds = raw.min_scene_seconds;
  }
  if (typeof raw.max_scene_seconds === "number" && Number.isFinite(raw.max_scene_seconds) && raw.max_scene_seconds >= 0.5 && raw.max_scene_seconds <= 60) {
    out.max_scene_seconds = raw.max_scene_seconds;
  }
  if (typeof raw.max_video_seconds === "number" && Number.isInteger(raw.max_video_seconds) && raw.max_video_seconds >= 1 && raw.max_video_seconds <= 7200) {
    out.max_video_seconds = raw.max_video_seconds;
  }
  if (typeof raw.max_scenes === "number" && Number.isInteger(raw.max_scenes) && raw.max_scenes >= 1 && raw.max_scenes <= 500) {
    out.max_scenes = raw.max_scenes;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.77.0: normalize movie overrides.
export function normalizeMovieOverrides(
  raw: MovieOverrides | undefined,
): MovieOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: MovieOverrides = {};
  if (typeof raw.default_clip_seconds === "number" && Number.isFinite(raw.default_clip_seconds) && raw.default_clip_seconds >= 0.5 && raw.default_clip_seconds <= 60) {
    out.default_clip_seconds = raw.default_clip_seconds;
  }
  if (typeof raw.min_clip_seconds === "number" && Number.isFinite(raw.min_clip_seconds) && raw.min_clip_seconds >= 0.5 && raw.min_clip_seconds <= 60) {
    out.min_clip_seconds = raw.min_clip_seconds;
  }
  if (typeof raw.default_force_shots === "number" && Number.isInteger(raw.default_force_shots) && raw.default_force_shots >= 0 && raw.default_force_shots <= 500) {
    out.default_force_shots = raw.default_force_shots;
  }
  if (typeof raw.default_duration_minutes === "number" && Number.isInteger(raw.default_duration_minutes) && raw.default_duration_minutes >= 0 && raw.default_duration_minutes <= 120) {
    out.default_duration_minutes = raw.default_duration_minutes;
  }
  if (typeof raw.crossfade_seconds === "number" && Number.isFinite(raw.crossfade_seconds) && raw.crossfade_seconds >= 0 && raw.crossfade_seconds <= 5) {
    out.crossfade_seconds = raw.crossfade_seconds;
  }
  if (typeof raw.chain_scenes === "boolean") out.chain_scenes = raw.chain_scenes;
  if (typeof raw.wan_num_frames === "number" && Number.isInteger(raw.wan_num_frames) && raw.wan_num_frames >= 1 && raw.wan_num_frames <= 256) {
    out.wan_num_frames = raw.wan_num_frames;
  }
  if (typeof raw.wan_inference_steps === "number" && Number.isInteger(raw.wan_inference_steps) && raw.wan_inference_steps >= 1 && raw.wan_inference_steps <= 64) {
    out.wan_inference_steps = raw.wan_inference_steps;
  }
  if (typeof raw.wan_fps === "number" && Number.isInteger(raw.wan_fps) && raw.wan_fps >= 1 && raw.wan_fps <= 120) {
    out.wan_fps = raw.wan_fps;
  }
  if (typeof raw.motion_suffix === "string" && raw.motion_suffix.length <= 512) {
    out.motion_suffix = raw.motion_suffix;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.76.0: normalize local_diffusion overrides. The resolution strings
// are validated against "WIDTHxHEIGHT" with dimensions in 64..7680.
export function normalizeLocalDiffusionOverrides(
  raw: LocalDiffusionOverrides | undefined,
): LocalDiffusionOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: LocalDiffusionOverrides = {};
  if (typeof raw.model_id === "string" && raw.model_id.length > 0 && raw.model_id.length <= 256) {
    out.model_id = raw.model_id;
  }
  const resRe = /^\d{2,5}x\d{2,5}$/;
  if (typeof raw.resolution === "string" && resRe.test(raw.resolution)) {
    out.resolution = raw.resolution;
  }
  if (typeof raw.portrait_resolution === "string" && resRe.test(raw.portrait_resolution)) {
    out.portrait_resolution = raw.portrait_resolution;
  }
  if (typeof raw.steps === "number" && Number.isInteger(raw.steps) && raw.steps >= 1 && raw.steps <= 64) {
    out.steps = raw.steps;
  }
  if (typeof raw.guidance_scale === "number" && Number.isFinite(raw.guidance_scale) && raw.guidance_scale >= 0 && raw.guidance_scale <= 30) {
    out.guidance_scale = raw.guidance_scale;
  }
  if (typeof raw.denoising_strength === "number" && Number.isFinite(raw.denoising_strength) && raw.denoising_strength >= 0 && raw.denoising_strength <= 1) {
    out.denoising_strength = raw.denoising_strength;
  }
  if (raw.device === "gpu" || raw.device === "cpu") out.device = raw.device;
  if (raw.dtype === "float16" || raw.dtype === "float32" || raw.dtype === "bfloat16") {
    out.dtype = raw.dtype;
  }
  if (typeof raw.sequential_cpu_offload === "boolean") {
    out.sequential_cpu_offload = raw.sequential_cpu_offload;
  }
  if (typeof raw.keyframe_model_id === "string" && raw.keyframe_model_id.length <= 256) {
    out.keyframe_model_id = raw.keyframe_model_id;
  }
  if (typeof raw.keyframe_guidance_scale === "number" && Number.isFinite(raw.keyframe_guidance_scale) && raw.keyframe_guidance_scale >= 0 && raw.keyframe_guidance_scale <= 30) {
    out.keyframe_guidance_scale = raw.keyframe_guidance_scale;
  }
  if (typeof raw.keyframe_steps === "number" && Number.isInteger(raw.keyframe_steps) && raw.keyframe_steps >= 1 && raw.keyframe_steps <= 128) {
    out.keyframe_steps = raw.keyframe_steps;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.76.0: normalize generation overrides.
export function normalizeGenerationOverrides(
  raw: GenerationOverrides | undefined,
): GenerationOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: GenerationOverrides = {};
  if (raw.seed_mode === "random" || raw.seed_mode === "locked" || raw.seed_mode === "sequential") {
    out.seed_mode = raw.seed_mode;
  }
  if (typeof raw.seed === "number" && Number.isInteger(raw.seed) && raw.seed >= 0) {
    out.seed = raw.seed;
  }
  if (typeof raw.seed_per_shot_step === "number" && Number.isInteger(raw.seed_per_shot_step) && raw.seed_per_shot_step >= 1 && raw.seed_per_shot_step <= 1000) {
    out.seed_per_shot_step = raw.seed_per_shot_step;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.75.0: normalize adetailer overrides.
export function normalizeAdetailerOverrides(
  raw: AdetailerOverrides | undefined,
): AdetailerOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: AdetailerOverrides = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.fix_hands === "boolean") out.fix_hands = raw.fix_hands;
  if (typeof raw.fix_face === "boolean") out.fix_face = raw.fix_face;
  if (typeof raw.max_regions === "number" && Number.isInteger(raw.max_regions) && raw.max_regions >= 1 && raw.max_regions <= 8) {
    out.max_regions = raw.max_regions;
  }
  if (typeof raw.bbox_pad === "number" && Number.isFinite(raw.bbox_pad) && raw.bbox_pad >= 0 && raw.bbox_pad <= 1) {
    out.bbox_pad = raw.bbox_pad;
  }
  if (typeof raw.inpaint_strength === "number" && Number.isFinite(raw.inpaint_strength) && raw.inpaint_strength >= 0 && raw.inpaint_strength <= 1) {
    out.inpaint_strength = raw.inpaint_strength;
  }
  if (typeof raw.hand_confidence === "number" && Number.isFinite(raw.hand_confidence) && raw.hand_confidence >= 0 && raw.hand_confidence <= 1) {
    out.hand_confidence = raw.hand_confidence;
  }
  // v0.82.0 (Phase 13).
  if (typeof raw.face_confidence === "number" && Number.isFinite(raw.face_confidence) && raw.face_confidence >= 0 && raw.face_confidence <= 1) {
    out.face_confidence = raw.face_confidence;
  }
  if (typeof raw.extra_steps === "number" && Number.isInteger(raw.extra_steps) && raw.extra_steps >= 0 && raw.extra_steps <= 16) {
    out.extra_steps = raw.extra_steps;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.75.0: normalize wan_diffusion overrides. Per-field union / range
// checks; drops anything that doesn't conform. Pod re-validates.
export function normalizeWanDiffusionOverrides(
  raw: WanDiffusionOverrides | undefined,
): WanDiffusionOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: WanDiffusionOverrides = {};
  if (typeof raw.t2v_model_id === "string" && raw.t2v_model_id.length > 0 && raw.t2v_model_id.length <= 256) {
    out.t2v_model_id = raw.t2v_model_id;
  }
  if (typeof raw.i2v_model_id === "string" && raw.i2v_model_id.length > 0 && raw.i2v_model_id.length <= 256) {
    out.i2v_model_id = raw.i2v_model_id;
  }
  if (typeof raw.use_i2v_when_start_image === "boolean") {
    out.use_i2v_when_start_image = raw.use_i2v_when_start_image;
  }
  if (typeof raw.num_frames === "number" && Number.isInteger(raw.num_frames) && raw.num_frames >= 1 && raw.num_frames <= 256) {
    out.num_frames = raw.num_frames;
  }
  if (typeof raw.max_frames === "number" && Number.isInteger(raw.max_frames) && raw.max_frames >= 1 && raw.max_frames <= 256) {
    out.max_frames = raw.max_frames;
  }
  if (typeof raw.fps === "number" && Number.isInteger(raw.fps) && raw.fps >= 1 && raw.fps <= 120) {
    out.fps = raw.fps;
  }
  if (typeof raw.num_inference_steps === "number" && Number.isInteger(raw.num_inference_steps) && raw.num_inference_steps >= 1 && raw.num_inference_steps <= 64) {
    out.num_inference_steps = raw.num_inference_steps;
  }
  if (typeof raw.guidance_scale === "number" && Number.isFinite(raw.guidance_scale) && raw.guidance_scale >= 0 && raw.guidance_scale <= 30) {
    out.guidance_scale = raw.guidance_scale;
  }
  if (typeof raw.flow_shift === "number" && Number.isFinite(raw.flow_shift) && raw.flow_shift >= 0 && raw.flow_shift <= 30) {
    out.flow_shift = raw.flow_shift;
  }
  if (typeof raw.cpu_offload === "boolean") out.cpu_offload = raw.cpu_offload;
  if (typeof raw.seconds_per_shot === "number" && Number.isFinite(raw.seconds_per_shot) && raw.seconds_per_shot >= 0.5 && raw.seconds_per_shot <= 60) {
    out.seconds_per_shot = raw.seconds_per_shot;
  }
  // v0.82.0 (Phase 13). 1024-char cap mirrors the pod-side limit.
  if (typeof raw.wan_negative_prompt === "string" && raw.wan_negative_prompt.length > 0 && raw.wan_negative_prompt.length <= 1024) {
    out.wan_negative_prompt = raw.wan_negative_prompt;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.82.0 (Phase 13): normalize prompt-template overrides. Scalar
// templates get 1024-char caps so a runaway override can't bloat any
// scene's prompt past CLIP-77 by itself. framing_hints accepts up to
// 32 entries each <= 128 chars. act_mood accepts string-keyed string
// values with a 256-char value cap. Drop-on-invalid; pod re-validates.
const _TEMPLATE_SCALAR_KEYS = [
  "anatomy_positive_base",
  "anatomy_positive_human",
  "anatomy_positive_anime",
  "anatomy_negative_global",
  "anatomy_negative_focused",
  "anatomy_negative_portrait",
  "anatomy_negative_anime",
  "portrait_positive",
  "hand_positive",
  "hand_negative",
] as const;

export function normalizePromptTemplatesOverrides(
  raw: PromptTemplatesOverrides | undefined,
): PromptTemplatesOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: PromptTemplatesOverrides = {};
  for (const k of _TEMPLATE_SCALAR_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "string" && v.length > 0 && v.length <= 1024) {
      (out as Record<string, string>)[k] = v;
    }
  }
  if (Array.isArray(raw.framing_hints)) {
    const cleaned = raw.framing_hints
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= 128)
      .slice(0, 32);
    if (cleaned.length > 0) out.framing_hints = cleaned;
  }
  if (raw.act_mood && typeof raw.act_mood === "object" && !Array.isArray(raw.act_mood)) {
    const moodOut: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.act_mood)) {
      if (typeof k === "string" && k.trim().length > 0
        && typeof v === "string" && v.trim().length > 0 && v.length <= 256) {
        moodOut[k.trim()] = v.trim();
      }
    }
    if (Object.keys(moodOut).length > 0) out.act_mood = moodOut;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v0.74.0: normalize face_lock overrides; deep-validates the optional
// instantid sub-block. Drops anything that doesn't conform; the pod
// re-validates.
export function normalizeFaceLockOverrides(
  raw: FaceLockOverrides | undefined,
): FaceLockOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: FaceLockOverrides = {};
  if (raw.mode === "img2img" || raw.mode === "ip_adapter" || raw.mode === "instantid" || raw.mode === "both") {
    out.mode = raw.mode;
  }
  if (typeof raw.ip_adapter_repo === "string" && raw.ip_adapter_repo.length <= 256) {
    out.ip_adapter_repo = raw.ip_adapter_repo;
  }
  if (typeof raw.ip_adapter_subfolder === "string" && raw.ip_adapter_subfolder.length <= 256) {
    out.ip_adapter_subfolder = raw.ip_adapter_subfolder;
  }
  if (typeof raw.ip_adapter_weight === "string" && raw.ip_adapter_weight.length <= 256) {
    out.ip_adapter_weight = raw.ip_adapter_weight;
  }
  if (typeof raw.ip_adapter_scale === "number" && Number.isFinite(raw.ip_adapter_scale) && raw.ip_adapter_scale >= 0 && raw.ip_adapter_scale <= 2) {
    out.ip_adapter_scale = raw.ip_adapter_scale;
  }
  if (raw.instantid && typeof raw.instantid === "object" && !Array.isArray(raw.instantid)) {
    const inst: NonNullable<FaceLockOverrides["instantid"]> = {};
    const i = raw.instantid;
    if (typeof i.enabled === "boolean") inst.enabled = i.enabled;
    if (typeof i.base_model_id === "string" && i.base_model_id.length <= 256) inst.base_model_id = i.base_model_id;
    if (typeof i.controlnet_model_id === "string" && i.controlnet_model_id.length <= 256) inst.controlnet_model_id = i.controlnet_model_id;
    if (typeof i.adapter_repo === "string" && i.adapter_repo.length <= 256) inst.adapter_repo = i.adapter_repo;
    if (typeof i.adapter_weight === "string" && i.adapter_weight.length <= 256) inst.adapter_weight = i.adapter_weight;
    if (typeof i.controlnet_scale === "number" && Number.isFinite(i.controlnet_scale) && i.controlnet_scale >= 0 && i.controlnet_scale <= 2) {
      inst.controlnet_scale = i.controlnet_scale;
    }
    if (typeof i.ip_adapter_scale === "number" && Number.isFinite(i.ip_adapter_scale) && i.ip_adapter_scale >= 0 && i.ip_adapter_scale <= 2) {
      inst.ip_adapter_scale = i.ip_adapter_scale;
    }
    if (typeof i.antelope_root === "string" && i.antelope_root.length <= 256) inst.antelope_root = i.antelope_root;
    if (Object.keys(inst).length > 0) out.instantid = inst;
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
