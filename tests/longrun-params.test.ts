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

  it("Seedance 2.0 i2v shape: `image` field, integer duration, lowercase 720p", () => {
    const p = buildGenParams("video", {
      modelId: "bytedance/seedance-2.0",
      prompt: "rain falls",
      imageUrl: "https://x/k.png",
    });
    expect(p).toEqual({
      image: "https://x/k.png",
      prompt: "rain falls",
      aspect_ratio: "16:9",
      duration: 5,
      resolution: "720p",
      fps: 24,
      camera_fixed: false,
      watermark: false,
      generate_audio: false,
    });
    expect(p).not.toHaveProperty("first_frame_image");
    expect(p).not.toHaveProperty("image_input");
  });

  it("Hailuo 2.3 i2v shape: `first_frame_image` field, 768P resolution", () => {
    const p = buildGenParams("video", {
      modelId: "minimax/hailuo-2.3-fast",
      prompt: "she turns",
      imageUrl: "https://x/k.png",
    });
    expect(p).toEqual({
      first_frame_image: "https://x/k.png",
      prompt: "she turns",
      duration: 6,
      resolution: "768P",
      fast_pretreatment: false,
      prompt_optimizer: true,
    });
    expect(p).not.toHaveProperty("image");
  });

  it("Runway Gen-4.5 i2v shape: `image_input` field, `ratio` not resolution", () => {
    const p = buildGenParams("video", {
      modelId: "runwayml/gen-4.5",
      prompt: "drift",
      imageUrl: "https://x/k.png",
    });
    expect(p).toEqual({
      image_input: "https://x/k.png",
      prompt: "drift",
      duration: 5,
      ratio: "1280:720",
      content_moderation: { public_figure_threshold: "low" },
    });
    expect(p).not.toHaveProperty("resolution");
  });

  it("prompt-required i2v models get a default motion prompt when none is given", () => {
    const p = buildGenParams("video", {
      modelId: "bytedance/seedance-2.0",
      prompt: "  ",
      imageUrl: "https://x/k.png",
    });
    expect(typeof p.prompt).toBe("string");
    expect((p.prompt as string).length).toBeGreaterThan(0);
  });

  it("explicit hh1-i2v modelId yields the hh1 shape (same as the default)", () => {
    const explicit = buildGenParams("video", {
      modelId: "alibaba/hh1-i2v",
      prompt: "p",
      imageUrl: "https://x/k.png",
    });
    const dflt = buildGenParams("video", { prompt: "p", imageUrl: "https://x/k.png" });
    expect(explicit).toEqual(dflt);
    expect(explicit).toEqual({ image: "https://x/k.png", resolution: "720P", duration: 5, prompt: "p" });
  });

  it("builds the music shape, with lyrics only when non-empty", () => {
    expect(buildGenParams("music", { prompt: "lofi beat" })).toEqual({ prompt: "lofi beat" });
    expect(buildGenParams("music", { prompt: "ballad", lyrics: "la la" }))
      .toEqual({ prompt: "ballad", lyrics: "la la" });
    expect(buildGenParams("music", { prompt: "x", lyrics: "  " })).toEqual({ prompt: "x" });
  });
});
