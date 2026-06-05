// Tests for the RunPod submit / poll pure helpers (v0.32.0). The
// dispatcher (submitRenderJob / pollRenderJob) touches fetch and is
// not unit-tested in this pass, matching the planner.ts pattern.

import { describe, it, expect } from "vitest";
import {
  buildFinalizePayload,
  buildRegenShotPayload,
  buildSubmitPayload,
  buildSubmitUrl,
  buildStatusUrl,
  buildCancelUrl,
  deriveProjectFromBundleKey,
  isValidJobId,
  normalizeMultiCharacterOverrides,
  normalizeQualityGateOverrides,
  normalizeRunpodResponse,
} from "../src/runpod-submit";

describe("deriveProjectFromBundleKey", () => {
  it("extracts the project slug from a canonical bundle key", () => {
    expect(deriveProjectFromBundleKey("bundles/cherry.tar.gz")).toBe("cherry");
    expect(deriveProjectFromBundleKey("bundles/my_film.tar.gz")).toBe("my_film");
  });

  it("returns the full key when it does not match the canonical shape", () => {
    expect(deriveProjectFromBundleKey("staged/whatever.tar.gz")).toBe(
      "staged/whatever.tar.gz",
    );
    expect(deriveProjectFromBundleKey("bundles/cherry.tar")).toBe(
      "bundles/cherry.tar",
    );
  });

  it("handles slugs with dots in them (only the final .tar.gz is the suffix)", () => {
    expect(deriveProjectFromBundleKey("bundles/v1.2.tar.gz")).toBe("v1.2");
  });
});

describe("buildSubmitPayload", () => {
  it("uses the provided project when present", () => {
    const out = buildSubmitPayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
    });
    expect(out.input.project).toBe("cherry");
    expect(out.input.bundle_key).toBe("bundles/cherry.tar.gz");
  });

  it("derives project from bundleKey when project is omitted", () => {
    const out = buildSubmitPayload({ bundleKey: "bundles/cherry.tar.gz" });
    expect(out.input.project).toBe("cherry");
  });

  it("derives project from bundleKey when project is empty / whitespace", () => {
    expect(
      buildSubmitPayload({ project: "", bundleKey: "bundles/cherry.tar.gz" }).input.project,
    ).toBe("cherry");
    expect(
      buildSubmitPayload({ project: "   ", bundleKey: "bundles/cherry.tar.gz" }).input.project,
    ).toBe("cherry");
  });

  it("defaults qualityTier to 'final'", () => {
    const out = buildSubmitPayload({ bundleKey: "bundles/cherry.tar.gz" });
    expect(out.input.quality_tier).toBe("final");
  });

  it("preserves an explicit qualityTier", () => {
    expect(
      buildSubmitPayload({ bundleKey: "bundles/cherry.tar.gz", qualityTier: "draft" })
        .input.quality_tier,
    ).toBe("draft");
    expect(
      buildSubmitPayload({ bundleKey: "bundles/cherry.tar.gz", qualityTier: "standard" })
        .input.quality_tier,
    ).toBe("standard");
  });

  it("omits render_overrides when undefined or empty", () => {
    const out1 = buildSubmitPayload({ bundleKey: "bundles/cherry.tar.gz" });
    expect("render_overrides" in out1.input).toBe(false);
    const out2 = buildSubmitPayload({
      bundleKey: "bundles/cherry.tar.gz",
      renderOverrides: {},
    });
    expect("render_overrides" in out2.input).toBe(false);
  });

  it("passes render_overrides through verbatim when non-empty", () => {
    const out = buildSubmitPayload({
      bundleKey: "bundles/cherry.tar.gz",
      renderOverrides: { wan_inference_steps: 12, seed: 424242 },
    });
    expect(out.input.render_overrides).toEqual({
      wan_inference_steps: 12,
      seed: 424242,
    });
  });

  it("wraps the input in the RunPod-required envelope", () => {
    const out = buildSubmitPayload({ bundleKey: "bundles/cherry.tar.gz" });
    expect(Object.keys(out)).toEqual(["input"]);
  });

  it("passes user_email through when set (v0.39.0)", () => {
    const out = buildSubmitPayload({
      bundleKey: "bundles/cherry.tar.gz",
      userEmail: "alice@example.com",
    });
    expect(out.input.user_email).toBe("alice@example.com");
  });

  it("omits user_email when not set (v0.39.0)", () => {
    const out = buildSubmitPayload({ bundleKey: "bundles/cherry.tar.gz" });
    expect("user_email" in out.input).toBe(false);
  });

  it("omits user_email when set to empty string (v0.39.0)", () => {
    const out = buildSubmitPayload({
      bundleKey: "bundles/cherry.tar.gz",
      userEmail: "",
    });
    expect("user_email" in out.input).toBe(false);
  });

  it("merges keyframesOnly:true into render_overrides.keyframes_only (v0.40.0)", () => {
    const out = buildSubmitPayload({
      bundleKey: "bundles/cherry.tar.gz",
      keyframesOnly: true,
    });
    expect(out.input.render_overrides).toEqual({ keyframes_only: true });
  });

  it("preserves an existing render_overrides.keyframes_only over keyframesOnly (v0.40.0)", () => {
    const out = buildSubmitPayload({
      bundleKey: "bundles/cherry.tar.gz",
      keyframesOnly: true,
      renderOverrides: { keyframes_only: false, seed: 42 },
    });
    expect(out.input.render_overrides).toEqual({ keyframes_only: false, seed: 42 });
  });

  it("merges keyframesOnly:true alongside other overrides (v0.40.0)", () => {
    const out = buildSubmitPayload({
      bundleKey: "bundles/cherry.tar.gz",
      keyframesOnly: true,
      renderOverrides: { seed: 42, wan_inference_steps: 12 },
    });
    expect(out.input.render_overrides).toEqual({
      seed: 42,
      wan_inference_steps: 12,
      keyframes_only: true,
    });
  });

  it("omits keyframes_only when keyframesOnly is false / undefined (v0.40.0)", () => {
    const out1 = buildSubmitPayload({ bundleKey: "bundles/cherry.tar.gz" });
    expect(out1.input.render_overrides).toBeUndefined();
    const out2 = buildSubmitPayload({
      bundleKey: "bundles/cherry.tar.gz",
      keyframesOnly: false,
    });
    expect(out2.input.render_overrides).toBeUndefined();
  });
});

describe("buildRegenShotPayload (v0.41.0)", () => {
  it("wraps the canonical regen_shot input shape", () => {
    const out = buildRegenShotPayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
      shotId: "shot_01",
      parentJobId: "abc-123-u1",
    });
    expect(out).toEqual({
      input: {
        action: "regen_shot",
        project: "cherry",
        bundle_key: "bundles/cherry.tar.gz",
        shot_id: "shot_01",
        parent_job_id: "abc-123-u1",
      },
    });
  });

  it("includes user_email when set", () => {
    const out = buildRegenShotPayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
      shotId: "shot_01",
      parentJobId: "abc-123-u1",
      userEmail: "alice@example.com",
    });
    expect(out.input.user_email).toBe("alice@example.com");
  });

  it("omits user_email when missing / empty", () => {
    const out1 = buildRegenShotPayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
      shotId: "shot_01",
      parentJobId: "abc-123-u1",
    });
    expect("user_email" in out1.input).toBe(false);
    const out2 = buildRegenShotPayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
      shotId: "shot_01",
      parentJobId: "abc-123-u1",
      userEmail: "",
    });
    expect("user_email" in out2.input).toBe(false);
  });

  it("always sets action='regen_shot' so the GPU dispatcher routes correctly", () => {
    const out = buildRegenShotPayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
      shotId: "shot_01",
      parentJobId: "abc-123-u1",
    });
    expect(out.input.action).toBe("regen_shot");
  });
});

describe("normalizeQualityGateOverrides (v0.128.0: defaults the gate OFF)", () => {
  it("defaults enabled:false when nothing is passed", () => {
    expect(normalizeQualityGateOverrides(undefined)).toEqual({ enabled: false });
    expect(normalizeQualityGateOverrides({})).toEqual({ enabled: false });
  });
  it("honors an explicit opt-in (enabled:true)", () => {
    expect(normalizeQualityGateOverrides({ enabled: true })).toEqual({ enabled: true });
  });
  it("keeps validated fields and still defaults enabled:false", () => {
    expect(normalizeQualityGateOverrides({ probe_count: 4 })).toEqual({
      enabled: false,
      probe_count: 4,
    });
  });
});

describe("buildFinalizePayload (v0.42.0)", () => {
  it("wraps the canonical finalize input shape with quality_tier defaulting to 'final'", () => {
    const out = buildFinalizePayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
    });
    expect(out).toEqual({
      input: {
        action: "finalize",
        project: "cherry",
        bundle_key: "bundles/cherry.tar.gz",
        quality_tier: "final",
        // v0.128.0: the LoRA quality gate now defaults OFF (no GPU probe renders).
        quality_gate_overrides: { enabled: false },
      },
    });
  });

  it("preserves an explicit qualityTier", () => {
    expect(
      buildFinalizePayload({
        project: "cherry",
        bundleKey: "bundles/cherry.tar.gz",
        qualityTier: "draft",
      }).input.quality_tier,
    ).toBe("draft");
  });

  it("passes render_overrides through when non-empty", () => {
    const out = buildFinalizePayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
      renderOverrides: { wan_inference_steps: 12, seed: 424242 },
    });
    expect(out.input.render_overrides).toEqual({
      wan_inference_steps: 12,
      seed: 424242,
    });
  });

  it("omits render_overrides when undefined or empty", () => {
    const out1 = buildFinalizePayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
    });
    expect("render_overrides" in out1.input).toBe(false);
    const out2 = buildFinalizePayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
      renderOverrides: {},
    });
    expect("render_overrides" in out2.input).toBe(false);
  });

  it("includes user_email when set, omits when missing or empty", () => {
    const out1 = buildFinalizePayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
      userEmail: "alice@example.com",
    });
    expect(out1.input.user_email).toBe("alice@example.com");
    const out2 = buildFinalizePayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
    });
    expect("user_email" in out2.input).toBe(false);
    const out3 = buildFinalizePayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
      userEmail: "",
    });
    expect("user_email" in out3.input).toBe(false);
  });

  it("always sets action='finalize' so the GPU dispatcher routes correctly", () => {
    const out = buildFinalizePayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
    });
    expect(out.input.action).toBe("finalize");
  });

  it("includes process_shot_ids when set and non-empty (v0.45.0)", () => {
    const out = buildFinalizePayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
      processShotIds: ["shot_01", "shot_03", "shot_05"],
    });
    expect(out.input.process_shot_ids).toEqual([
      "shot_01",
      "shot_03",
      "shot_05",
    ]);
  });

  it("omits process_shot_ids when empty or undefined (v0.45.0)", () => {
    const out1 = buildFinalizePayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
    });
    expect("process_shot_ids" in out1.input).toBe(false);
    const out2 = buildFinalizePayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
      processShotIds: [],
    });
    expect("process_shot_ids" in out2.input).toBe(false);
  });

  it("clones process_shot_ids so subsequent mutations of the input do not bleed (v0.45.0)", () => {
    const ids = ["shot_01", "shot_02"];
    const out = buildFinalizePayload({
      project: "cherry",
      bundleKey: "bundles/cherry.tar.gz",
      processShotIds: ids,
    });
    ids.push("shot_03");
    expect(out.input.process_shot_ids).toEqual(["shot_01", "shot_02"]);
  });
});

describe("URL builders", () => {
  it("buildSubmitUrl returns /v2/<id>/run on api.runpod.ai", () => {
    expect(buildSubmitUrl("abc123xyz")).toBe(
      "https://api.runpod.ai/v2/abc123xyz/run",
    );
  });

  it("buildStatusUrl returns /v2/<id>/status/<job>", () => {
    expect(buildStatusUrl("abc123xyz", "job-id-1")).toBe(
      "https://api.runpod.ai/v2/abc123xyz/status/job-id-1",
    );
  });

  it("buildCancelUrl returns /v2/<id>/cancel/<job>", () => {
    expect(buildCancelUrl("abc123xyz", "job-id-1")).toBe(
      "https://api.runpod.ai/v2/abc123xyz/cancel/job-id-1",
    );
  });
});

describe("isValidJobId", () => {
  it("accepts alphanumerics, hyphens, and underscores", () => {
    expect(isValidJobId("abc123")).toBe(true);
    expect(isValidJobId("abc-123_xyz")).toBe(true);
    expect(isValidJobId("5a317cd3-1861-42af-937f-0eb2cd6d05c8-u2")).toBe(true);
  });

  it("rejects empty strings and slashes / dots / spaces", () => {
    expect(isValidJobId("")).toBe(false);
    expect(isValidJobId("../../etc/passwd")).toBe(false);
    expect(isValidJobId("job id with spaces")).toBe(false);
    expect(isValidJobId("a.b.c")).toBe(false);
  });

  it("rejects ids longer than 128 chars", () => {
    expect(isValidJobId("a".repeat(128))).toBe(true);
    expect(isValidJobId("a".repeat(129))).toBe(false);
  });
});

describe("normalizeMultiCharacterOverrides (v0.85.0: Phase R fields)", () => {
  // The pre-v0.85.0 normalizer only whitelisted mode, auto_when_multi_slot,
  // max_slots, feather_px, layout. Phase R added engine, lora_scale_per_
  // slot, ip_adapter_scale_per_slot on the pod side back in 0.4.42 but
  // the Worker normalizer was never updated, so every Worker request that
  // tried to tune Phase R was silently sending an empty payload and the
  // pod fell through to its built-in defaults. Caught when pod 0.4.52
  // refused to default and surfaced the missing fields. These tests pin
  // the contract so the same gap cannot reopen.
  it("passes engine='regional' through", () => {
    const out = normalizeMultiCharacterOverrides({ engine: "regional" });
    expect(out).toEqual({ engine: "regional" });
  });

  it("passes engine='composite_legacy' through", () => {
    const out = normalizeMultiCharacterOverrides({ engine: "composite_legacy" });
    expect(out).toEqual({ engine: "composite_legacy" });
  });

  it("drops an unrecognized engine string", () => {
    const out = normalizeMultiCharacterOverrides({
      engine: "experimental" as unknown as "regional",
    });
    expect(out).toBeUndefined();
  });

  it("passes lora_scale_per_slot at the smoke v15 baseline", () => {
    const out = normalizeMultiCharacterOverrides({ lora_scale_per_slot: 0.3 });
    expect(out).toEqual({ lora_scale_per_slot: 0.3 });
  });

  it("passes ip_adapter_scale_per_slot at the smoke v15 baseline", () => {
    const out = normalizeMultiCharacterOverrides({ ip_adapter_scale_per_slot: 0.7 });
    expect(out).toEqual({ ip_adapter_scale_per_slot: 0.7 });
  });

  it("accepts the regional bundle the smoke v20 script sends", () => {
    const out = normalizeMultiCharacterOverrides({
      engine: "regional",
      lora_scale_per_slot: 0.3,
      ip_adapter_scale_per_slot: 0.7,
    });
    expect(out).toEqual({
      engine: "regional",
      lora_scale_per_slot: 0.3,
      ip_adapter_scale_per_slot: 0.7,
    });
  });

  // v0.136.3: regional center gap (vivijure-serverless 0.4.86+).
  it("passes region_gap_px and rounds it", () => {
    expect(normalizeMultiCharacterOverrides({ region_gap_px: 180 })).toEqual({
      region_gap_px: 180,
    });
    expect(normalizeMultiCharacterOverrides({ region_gap_px: 159.6 })).toEqual({
      region_gap_px: 160,
    });
  });

  it("drops region_gap_px out of range", () => {
    expect(normalizeMultiCharacterOverrides({ region_gap_px: -1 })).toBeUndefined();
    expect(normalizeMultiCharacterOverrides({ region_gap_px: 601 })).toBeUndefined();
  });

  // v0.136.6: OpenPose ControlNet pose conditioning (vivijure-serverless 0.4.87+).
  it("passes pose_conditioning + controlnet_conditioning_scale", () => {
    expect(
      normalizeMultiCharacterOverrides({
        pose_conditioning: true,
        controlnet_conditioning_scale: 0.55,
      }),
    ).toEqual({ pose_conditioning: true, controlnet_conditioning_scale: 0.55 });
  });

  it("drops a non-boolean pose_conditioning and out-of-range cn scale", () => {
    expect(
      normalizeMultiCharacterOverrides({ pose_conditioning: "yes" as unknown as boolean }),
    ).toBeUndefined();
    expect(
      normalizeMultiCharacterOverrides({ controlnet_conditioning_scale: 2.1 }),
    ).toBeUndefined();
  });

  it("drops lora_scale_per_slot below 0", () => {
    const out = normalizeMultiCharacterOverrides({ lora_scale_per_slot: -0.1 });
    expect(out).toBeUndefined();
  });

  it("drops lora_scale_per_slot above 2", () => {
    const out = normalizeMultiCharacterOverrides({ lora_scale_per_slot: 2.1 });
    expect(out).toBeUndefined();
  });

  it("drops ip_adapter_scale_per_slot above 2", () => {
    const out = normalizeMultiCharacterOverrides({ ip_adapter_scale_per_slot: 2.5 });
    expect(out).toBeUndefined();
  });

  it("drops non-numeric scale values", () => {
    const out = normalizeMultiCharacterOverrides({
      lora_scale_per_slot: "0.3" as unknown as number,
      ip_adapter_scale_per_slot: "0.7" as unknown as number,
    });
    expect(out).toBeUndefined();
  });

  it("still passes pre-Phase-R fields (mode / layout / feather_px) alongside Phase R", () => {
    const out = normalizeMultiCharacterOverrides({
      mode: "auto",
      layout: "layer",
      feather_px: 48,
      engine: "regional",
      lora_scale_per_slot: 0.3,
      ip_adapter_scale_per_slot: 0.7,
    });
    expect(out).toEqual({
      mode: "auto",
      layout: "layer",
      feather_px: 48,
      engine: "regional",
      lora_scale_per_slot: 0.3,
      ip_adapter_scale_per_slot: 0.7,
    });
  });

  it("returns undefined when raw is undefined", () => {
    expect(normalizeMultiCharacterOverrides(undefined)).toBeUndefined();
  });

  it("returns undefined when raw is empty", () => {
    expect(normalizeMultiCharacterOverrides({})).toBeUndefined();
  });
});

describe("normalizeRunpodResponse", () => {
  it("normalizes a freshly-submitted job (IN_QUEUE)", () => {
    const v = normalizeRunpodResponse({ id: "abc123", status: "IN_QUEUE" });
    expect(v).not.toBeNull();
    expect(v?.jobId).toBe("abc123");
    expect(v?.status).toBe("IN_QUEUE");
    expect(v?.statusRaw).toBe("IN_QUEUE");
    expect(v?.output).toBeUndefined();
    expect(v?.error).toBeUndefined();
  });

  it("normalizes a completed job with output and executionTime", () => {
    const v = normalizeRunpodResponse({
      id: "abc123",
      status: "COMPLETED",
      output: { project: "cherry", output_key: "renders/cherry/full.mp4" },
      executionTime: 1931280,
      delayTime: 11412,
    });
    expect(v?.status).toBe("COMPLETED");
    expect(v?.executionTimeMs).toBe(1931280);
    expect(v?.delayTimeMs).toBe(11412);
    expect(v?.output).toEqual({
      project: "cherry",
      output_key: "renders/cherry/full.mp4",
    });
  });

  it("normalizes a failed job with error and executionTime", () => {
    const v = normalizeRunpodResponse({
      id: "abc123",
      status: "FAILED",
      error: "executionTimeout exceeded",
      executionTime: 608597,
    });
    expect(v?.status).toBe("FAILED");
    expect(v?.error).toBe("executionTimeout exceeded");
    expect(v?.executionTimeMs).toBe(608597);
  });

  it("returns null for non-object inputs", () => {
    expect(normalizeRunpodResponse(null)).toBeNull();
    expect(normalizeRunpodResponse("nope")).toBeNull();
    expect(normalizeRunpodResponse([])).toBeNull();
  });

  it("returns null when id or status is missing", () => {
    expect(normalizeRunpodResponse({ status: "IN_QUEUE" })).toBeNull();
    expect(normalizeRunpodResponse({ id: "abc123" })).toBeNull();
    expect(normalizeRunpodResponse({ id: 123, status: "IN_QUEUE" })).toBeNull();
  });

  it("preserves statusRaw and falls back to IN_PROGRESS on unknown status", () => {
    const v = normalizeRunpodResponse({ id: "abc123", status: "SOMETHING_NEW" });
    expect(v?.status).toBe("IN_PROGRESS");
    expect(v?.statusRaw).toBe("SOMETHING_NEW");
  });

  it("does not include empty error strings", () => {
    const v = normalizeRunpodResponse({
      id: "abc123",
      status: "COMPLETED",
      error: "",
    });
    expect(v?.error).toBeUndefined();
  });

  it("recognizes all known RunPod statuses verbatim", () => {
    for (const s of ["IN_QUEUE", "IN_PROGRESS", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"] as const) {
      const v = normalizeRunpodResponse({ id: "x", status: s });
      expect(v?.status).toBe(s);
      expect(v?.statusRaw).toBe(s);
    }
  });
});
