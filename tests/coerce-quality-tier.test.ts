import { describe, it, expect } from "vitest";
import { coerceQualityTier } from "../src/runpod-submit";

// The real tiers are keyframe (a separate keyframesOnly flag) + three the pod's for_tier
// genuinely distinguishes: draft, standard (the middle), final. v0.156.1 wrongly dropped
// standard; v0.156.3 restores it, so all three pass through unchanged.
describe("coerceQualityTier", () => {
  it("passes draft, standard, and final through", () => {
    expect(coerceQualityTier("draft")).toBe("draft");
    expect(coerceQualityTier("standard")).toBe("standard");
    expect(coerceQualityTier("final")).toBe("final");
  });

  it("returns undefined for absent or invalid tiers", () => {
    expect(coerceQualityTier(undefined)).toBeUndefined();
    expect(coerceQualityTier("")).toBeUndefined();
    expect(coerceQualityTier("ultra")).toBeUndefined();
    expect(coerceQualityTier(3)).toBeUndefined();
    expect(coerceQualityTier(null)).toBeUndefined();
  });
});
