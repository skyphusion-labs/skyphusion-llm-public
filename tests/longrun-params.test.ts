// Tests for buildGenParams (v0.21.5).
//
// The point of these is that hh1-i2v's param shape differs from the
// text-to-video shape and getting it wrong means a rejected upstream call:
// i2v needs `image` + integer `duration` + "720P", and must NOT carry the
// t2v fields (aspect_ratio, generate_audio, string duration), which hh1-i2v's
// additionalProperties:false would reject.

import { describe, it, expect } from "vitest";
import { buildGenParams } from "../src/longrun-params";

describe("buildGenParams", () => {
  it("builds the text-to-video shape when no imageUrl", () => {
    expect(buildGenParams("video", { prompt: "a dragon flying" })).toEqual({
      prompt: "a dragon flying",
      duration: "8s",
      aspect_ratio: "16:9",
      resolution: "720p",
      generate_audio: true,
    });
  });

  it("builds the image-to-video shape when imageUrl is present", () => {
    const p = buildGenParams("video", { prompt: "slow push-in", imageUrl: "https://x/cat.png" });
    expect(p).toEqual({
      image: "https://x/cat.png",
      resolution: "720P",
      duration: 5,
      prompt: "slow push-in",
    });
  });

  it("i2v does NOT carry any text-to-video fields", () => {
    const p = buildGenParams("video", { prompt: "x", imageUrl: "https://x/y.png" });
    expect(p).not.toHaveProperty("aspect_ratio");
    expect(p).not.toHaveProperty("generate_audio");
    expect(p.duration).toBe(5); // integer, not "8s"
    expect(p.resolution).toBe("720P"); // capital P
  });

  it("i2v omits an empty prompt (it's optional)", () => {
    const p = buildGenParams("video", { prompt: "   ", imageUrl: "https://x/y.png" });
    expect(p).not.toHaveProperty("prompt");
    expect(p).toEqual({ image: "https://x/y.png", resolution: "720P", duration: 5 });
  });

  it("builds the music shape, with lyrics only when non-empty", () => {
    expect(buildGenParams("music", { prompt: "lofi beat" })).toEqual({ prompt: "lofi beat" });
    expect(buildGenParams("music", { prompt: "ballad", lyrics: "la la" }))
      .toEqual({ prompt: "ballad", lyrics: "la la" });
    expect(buildGenParams("music", { prompt: "x", lyrics: "  " })).toEqual({ prompt: "x" });
  });
});
