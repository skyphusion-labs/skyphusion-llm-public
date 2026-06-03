import { describe, expect, it, vi } from "vitest";
import { callVideoFinish, parseVideoFinishInput } from "../src/video-finish";
import type { Env } from "../src/env";

describe("parseVideoFinishInput", () => {
  it("accepts bare key strings and {key,targetSeconds}", () => {
    const r = parseVideoFinishInput({
      clips: ["renders/p/clips/shot_01.mp4", { key: "renders/p/clips/shot_02.mp4", targetSeconds: 4.5 }],
      audioKey: "audio/x.mp3",
      outputKey: "renders/p/full.mp4",
      crossfade: 0.5,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.clips).toEqual([
        { key: "renders/p/clips/shot_01.mp4" },
        { key: "renders/p/clips/shot_02.mp4", targetSeconds: 4.5 },
      ]);
      expect(r.value.audioKey).toBe("audio/x.mp3");
      expect(r.value.crossfade).toBe(0.5);
    }
  });

  it("works with no audio (silent finish)", () => {
    const r = parseVideoFinishInput({ clips: ["a.mp4"], outputKey: "out.mp4" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.audioKey).toBeUndefined();
  });

  it("rejects empty / non-array clips", () => {
    expect(parseVideoFinishInput({ clips: [], outputKey: "o" }).ok).toBe(false);
    expect(parseVideoFinishInput({ outputKey: "o" }).ok).toBe(false);
  });

  it("rejects missing outputKey", () => {
    expect(parseVideoFinishInput({ clips: ["a.mp4"] }).ok).toBe(false);
  });

  it("rejects a clip with non-positive targetSeconds", () => {
    expect(parseVideoFinishInput({ clips: [{ key: "a.mp4", targetSeconds: 0 }], outputKey: "o" }).ok).toBe(false);
  });

  it("rejects a bad preset / numeric type", () => {
    expect(parseVideoFinishInput({ clips: ["a.mp4"], outputKey: "o", crf: "18" }).ok).toBe(false);
    expect(parseVideoFinishInput({ clips: ["a.mp4"], outputKey: "o", preset: 5 }).ok).toBe(false);
  });
});

// Fake DO stub so callVideoFinish's cold-start guard is testable without a real
// container. /health always 200; /finish returns the queued sequence of statuses.
function fakeEnv(finishStatuses: number[]): { env: Env; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const stub = {
    fetch: vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/health")) return new Response("{}", { status: 200 });
      const status = finishStatuses[Math.min(i, finishStatuses.length - 1)];
      i++;
      return new Response(JSON.stringify({ ok: status === 200 }), { status });
    }),
  };
  const env = {
    VIDEO_FINISH: { idFromName: () => "id", get: () => stub },
  } as unknown as Env;
  return { env, calls };
}

describe("callVideoFinish cold-start guard", () => {
  it("warms /health then succeeds on first /finish", async () => {
    const { env, calls } = fakeEnv([200]);
    const resp = await callVideoFinish(env, {}, { backoffMs: 0 });
    expect(resp?.status).toBe(200);
    expect(calls[0]).toContain("/health");
    expect(calls[1]).toContain("/finish");
  });

  it("retries /finish on 503 then returns the 200", async () => {
    const { env, calls } = fakeEnv([503, 503, 200]);
    const resp = await callVideoFinish(env, {}, { backoffMs: 0, retries: 3 });
    expect(resp?.status).toBe(200);
    // 1 health + 3 finish attempts
    expect(calls.filter((c) => c.endsWith("/finish")).length).toBe(3);
  });

  it("gives up after retries exhausted on persistent 503", async () => {
    const { env } = fakeEnv([503]);
    const resp = await callVideoFinish(env, {}, { backoffMs: 0, retries: 2 });
    expect(resp?.status).toBe(503);
  });
});
