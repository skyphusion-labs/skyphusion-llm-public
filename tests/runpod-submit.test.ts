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
