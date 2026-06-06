import { describe, it, expect } from "vitest";
import { buildRenderLogText, renderLogKey } from "../src/render-log";
import type { RunpodJobView } from "../src/runpod-submit";

const ISO = "2026-06-06T21:00:00.000Z";

describe("renderLogKey", () => {
  it("derives the conventional R2 key from the job id", () => {
    expect(renderLogKey("abc-123-u2")).toBe("renders/logs/abc-123-u2.txt");
  });
});

describe("buildRenderLogText", () => {
  it("includes status, timing, and a pretty-printed output block", () => {
    const view: RunpodJobView = {
      jobId: "j1",
      status: "COMPLETED",
      statusRaw: "COMPLETED",
      output: { output_key: "renders/x/full-j1.mp4", seconds: 21.9 },
      executionTimeMs: 302000,
      delayTimeMs: 9000,
    };
    const txt = buildRenderLogText(view, ISO);
    expect(txt).toContain("Render log - job j1");
    expect(txt).toContain(`Generated: ${ISO}`);
    expect(txt).toContain("Status: COMPLETED");
    expect(txt).toContain("Execution: 302.0s");
    expect(txt).toContain("Queue delay: 9.0s");
    expect(txt).toContain("renders/x/full-j1.mp4");
    expect(txt.endsWith("\n")).toBe(true);
    // status equals statusRaw -> no parenthetical
    expect(txt).not.toContain("(COMPLETED)");
  });

  it("surfaces the error and shows raw status when it differs", () => {
    const view: RunpodJobView = {
      jobId: "j2",
      status: "FAILED",
      statusRaw: "FAILED_OOM",
      error: "Missing clip",
      output: "diagnostics tail here",
    };
    const txt = buildRenderLogText(view, ISO);
    expect(txt).toContain("Status: FAILED (FAILED_OOM)");
    expect(txt).toContain("Error:");
    expect(txt).toContain("Missing clip");
    // string output is emitted verbatim, not JSON-stringified
    expect(txt).toContain("diagnostics tail here");
    expect(txt).not.toContain('"diagnostics tail here"');
  });

  it("omits optional blocks when absent", () => {
    const view: RunpodJobView = { jobId: "j4", status: "IN_QUEUE", statusRaw: "IN_QUEUE" };
    const txt = buildRenderLogText(view, ISO);
    expect(txt).toContain("Status: IN_QUEUE");
    expect(txt).not.toContain("Execution:");
    expect(txt).not.toContain("Error:");
    expect(txt).not.toContain("Output / diagnostics:");
  });
});
