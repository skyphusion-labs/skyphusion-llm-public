// Tests for the audio beat-sync pure helpers (v0.105.0). The dispatcher
// (submitAnalyzeAudioJob) touches fetch and is not unit-tested, matching the
// runpod-submit.test.ts pattern. See docs/audio-beat-sync.md.

import { describe, it, expect } from "vitest";
import { buildAnalyzeAudioPayload, parseAudioBeatPlan } from "../src/runpod-submit";

describe("buildAnalyzeAudioPayload", () => {
  it("defaults: only action + audio_key, beat mode implied by omission", () => {
    const { input } = buildAnalyzeAudioPayload({ audioKey: "audio/x.mp3" });
    expect(input).toEqual({ action: "analyze_audio", audio_key: "audio/x.mp3" });
    expect(input.mode).toBeUndefined();
  });

  it("includes clip_seconds only when a positive number", () => {
    expect(buildAnalyzeAudioPayload({ audioKey: "audio/x.mp3", clipSeconds: 4 }).input.clip_seconds).toBe(4);
    expect(buildAnalyzeAudioPayload({ audioKey: "audio/x.mp3", clipSeconds: 0 }).input.clip_seconds).toBeUndefined();
    expect(buildAnalyzeAudioPayload({ audioKey: "audio/x.mp3", clipSeconds: -2 }).input.clip_seconds).toBeUndefined();
  });

  it("sets mode=duration only when explicitly requested", () => {
    expect(buildAnalyzeAudioPayload({ audioKey: "audio/x.mp3", mode: "duration" }).input.mode).toBe("duration");
    expect(buildAnalyzeAudioPayload({ audioKey: "audio/x.mp3", mode: "beat" }).input.mode).toBeUndefined();
  });

  it("passes min/max scene bounds through", () => {
    const { input } = buildAnalyzeAudioPayload({ audioKey: "audio/x.mp3", minSceneS: 2.5, maxSceneS: 12 });
    expect(input.min_scene_s).toBe(2.5);
    expect(input.max_scene_s).toBe(12);
  });

  it("includes force_shots only for a positive integer", () => {
    expect(buildAnalyzeAudioPayload({ audioKey: "audio/x.mp3", forceShots: 10 }).input.force_shots).toBe(10);
    expect(buildAnalyzeAudioPayload({ audioKey: "audio/x.mp3", forceShots: 0 }).input.force_shots).toBeUndefined();
    expect(buildAnalyzeAudioPayload({ audioKey: "audio/x.mp3", forceShots: 3.5 }).input.force_shots).toBeUndefined();
  });
});

describe("parseAudioBeatPlan", () => {
  it("parses a valid beat-mode response (snake -> camel)", () => {
    const raw = {
      mode: "beat", audio_key: "audio/track.mp3", duration_seconds: 248,
      bpm: 124.5, beat_count: 516, suggested_shots: 32, clip_seconds: 4,
      film_seconds: 248, remainder_seconds: 0,
      timed_scenes: [
        { index: 0, start: 0, end: 3.875, target_seconds: 3.88 },
        { index: 1, start: 3.875, end: 7.75, target_seconds: 3.88 },
      ],
      note: "Beat sync",
    };
    const plan = parseAudioBeatPlan(raw);
    expect(plan).not.toBeNull();
    expect(plan!.mode).toBe("beat");
    expect(plan!.audioKey).toBe("audio/track.mp3");
    expect(plan!.bpm).toBe(124.5);
    expect(plan!.beatCount).toBe(516);
    expect(plan!.suggestedShots).toBe(32);
    expect(plan!.timedScenes).toHaveLength(2);
    expect(plan!.timedScenes[1]).toEqual({ index: 1, start: 3.875, end: 7.75, targetSeconds: 3.88 });
  });

  it("parses a valid duration-mode response with empty timed_scenes", () => {
    const plan = parseAudioBeatPlan({
      mode: "duration", audio_key: "audio/x.mp3", duration_seconds: 60,
      suggested_shots: 10, clip_seconds: 6, film_seconds: 60, remainder_seconds: 0,
      timed_scenes: [], note: "Duration",
    });
    expect(plan).not.toBeNull();
    expect(plan!.mode).toBe("duration");
    expect(plan!.bpm).toBeUndefined();
    expect(plan!.timedScenes).toEqual([]);
  });

  it("returns null when mode is missing or wrong", () => {
    expect(parseAudioBeatPlan({ audio_key: "audio/x.mp3" })).toBeNull();
    expect(parseAudioBeatPlan({ mode: "nonsense" })).toBeNull();
    expect(parseAudioBeatPlan(null)).toBeNull();
    expect(parseAudioBeatPlan("not an object")).toBeNull();
  });

  it("drops malformed timed_scenes entries but keeps valid ones", () => {
    const plan = parseAudioBeatPlan({
      mode: "beat", timed_scenes: [
        { index: 0, start: 0, end: 4, target_seconds: 4 },
        null,
        "garbage",
        { start: 4, end: 8, target_seconds: 4 }, // missing index -> defaults to 0, still kept
      ],
    });
    expect(plan).not.toBeNull();
    // null + "garbage" filtered out; two object entries survive.
    expect(plan!.timedScenes).toHaveLength(2);
    expect(plan!.timedScenes[1].index).toBe(0); // missing index defaulted
  });
});
