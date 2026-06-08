import { describe, it, expect } from "vitest";
import { renderSlug, progressSnapshotKey, progressLogKey } from "../src/render-progress";

// These cases must match vivijure_backend/harness/keys.py `_slug` byte for byte;
// any drift means the control plane reads a key the GPU worker never wrote (404).
describe("renderSlug (mirrors vivijure-backend keys._slug)", () => {
  it("passes a clean slug through unchanged", () => {
    expect(renderSlug("neon-smoke-v015")).toBe("neon-smoke-v015");
  });

  it("collapses whitespace runs to a single underscore", () => {
    expect(renderSlug("neon rain")).toBe("neon_rain");
    expect(renderSlug("  a   b  ")).toBe("a_b");
  });

  it("replaces slashes so a name cannot scatter across phantom prefixes", () => {
    expect(renderSlug("a/b")).toBe("a_b");
    expect(renderSlug("  a  b/c  ")).toBe("a_b_c");
  });

  it("falls back to 'untitled' for empty or whitespace-only names", () => {
    expect(renderSlug("")).toBe("untitled");
    expect(renderSlug("   ")).toBe("untitled");
  });

  it("leaves a RunPod job id untouched", () => {
    expect(renderSlug("f6314346-7e5b-46cf-93fd-d5f384a7e518-u1")).toBe(
      "f6314346-7e5b-46cf-93fd-d5f384a7e518-u1",
    );
  });
});

describe("progress keys (must match what the worker writes)", () => {
  it("builds the snapshot key", () => {
    expect(progressSnapshotKey("neon rain", "job-1")).toBe(
      "renders/neon_rain/progress/job-1.json",
    );
  });

  it("builds the event-log key", () => {
    expect(progressLogKey("neon-smoke-v015", "f6314346-u1")).toBe(
      "renders/neon-smoke-v015/progress/f6314346-u1.ndjson",
    );
  });
});
