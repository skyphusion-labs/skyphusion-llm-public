import { describe, it, expect } from "vitest";
import {
  buildRenderLogText,
  buildCloudAnimateLogText,
  renderLogKey,
} from "../src/render-log";
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

describe("buildCloudAnimateLogText", () => {
  it("renders a per-shot section with the gateway log id, clip url, and log body", () => {
    const txt = buildCloudAnimateLogText(
      {
        jobId: "cloud-abc",
        model: "runwayml/gen-4.5",
        status: "COMPLETED",
        executionTimeMs: 390000,
        shots: [
          {
            shot_id: "shot_01",
            model: "runwayml/gen-4.5",
            status: "ok",
            log_id: "log-111",
            video_url: "https://cdn/clip01.mp4",
            gateway_log: { id: "log-111", success: true, cost: 0.2 },
          },
        ],
      },
      ISO,
    );
    expect(txt).toContain("Render log - cloud animation job cloud-abc");
    expect(txt).toContain("Status: COMPLETED");
    expect(txt).toContain("Model: runwayml/gen-4.5");
    expect(txt).toContain("Execution: 390.0s");
    expect(txt).toContain("Shots: 1");
    expect(txt).toContain("--- shot_01 (ok) ---");
    expect(txt).toContain("AI Gateway log id: log-111");
    expect(txt).toContain("https://cdn/clip01.mp4");
    expect(txt).toContain('"success": true');
    expect(txt.endsWith("\n")).toBe(true);
  });

  it("surfaces a top-level error and a missing-log-id placeholder on failure", () => {
    const txt = buildCloudAnimateLogText(
      {
        jobId: "cloud-xyz",
        model: "minimax/hailuo-2.3-fast",
        status: "FAILED",
        error: "fetch clip 500 for shot_02",
        shots: [
          { shot_id: "shot_01", model: "minimax/hailuo-2.3-fast", status: "ok", log_id: null },
        ],
      },
      ISO,
    );
    expect(txt).toContain("Status: FAILED");
    expect(txt).toContain("Error:");
    expect(txt).toContain("fetch clip 500 for shot_02");
    expect(txt).toContain("AI Gateway log id: (none captured)");
  });
});
