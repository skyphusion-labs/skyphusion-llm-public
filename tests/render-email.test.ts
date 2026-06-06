import { describe, it, expect } from "vitest";
import { buildRenderEmail, type RenderNotifyInfo } from "../src/render-email";

const BASE = "https://skyphusion.org";

function info(overrides: Partial<RenderNotifyInfo> = {}): RenderNotifyInfo {
  return {
    userEmail: "u@example.com",
    project: "no_winner",
    status: "COMPLETED",
    outputKey: "renders/no_winner/full-abc.mp4",
    error: null,
    executionTimeMs: 3418000,
    mode: "full",
    ...overrides,
  };
}

describe("buildRenderEmail", () => {
  it("COMPLETED: subject + watch link + duration, in text and html", () => {
    const m = buildRenderEmail(info(), BASE);
    expect(m.subject).toBe('Your render "no_winner" is ready');
    expect(m.text).toContain(`${BASE}/api/artifact/renders/no_winner/full-abc.mp4`);
    expect(m.text).toContain("56m 58s"); // 3418s -> 56m 58s
    expect(m.html).toContain("Watch the video");
    expect(m.html).toContain(`${BASE}/planner`);
  });

  it("formats duration sensibly", () => {
    expect(buildRenderEmail(info({ executionTimeMs: 45000 }), BASE).text).toContain("45s");
    expect(buildRenderEmail(info({ executionTimeMs: 125000 }), BASE).text).toContain("2m 5s");
    expect(buildRenderEmail(info({ executionTimeMs: 120000 }), BASE).text).toContain("2m");
  });

  it("FAILED: subject + reason, no watch link", () => {
    const m = buildRenderEmail(
      info({ status: "FAILED", outputKey: null, error: "GPU exploded" }),
      BASE,
    );
    expect(m.subject).toBe('Your render "no_winner" failed');
    expect(m.text).toContain("GPU exploded");
    expect(m.text).not.toContain("/api/artifact/");
    expect(m.html).not.toContain("Watch the video");
    expect(m.html).toContain("Open in History");
  });

  it("keyframe preview wording", () => {
    const m = buildRenderEmail(info({ mode: "keyframes-only" }), BASE);
    expect(m.subject).toContain("keyframe preview");
  });

  it("escapes html in project + error", () => {
    const m = buildRenderEmail(
      info({ status: "FAILED", project: "<b>x</b>", error: "<script>", outputKey: null }),
      BASE,
    );
    expect(m.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).not.toContain("<b>x</b>");
  });

  it("contains no em-dashes or en-dashes (house style)", () => {
    const m = buildRenderEmail(info(), BASE);
    expect(m.html.includes("—") || m.html.includes("–")).toBe(false);
    expect(m.text.includes("—") || m.text.includes("–")).toBe(false);
  });
});
