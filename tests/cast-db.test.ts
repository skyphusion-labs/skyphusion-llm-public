// Tests for the pure helpers in src/cast-db.ts (v0.46.0) and the
// composeTrainingPrompt helper that drives the /cast training-set
// generator (v0.47.0). The latter lives in public/cast.js (not a TS
// module); we duplicate the pure logic here so vitest can lock it in
// without spinning up jsdom. Any divergence between the two copies is
// a maintenance bug, but the alternative (loading cast.js into the
// Node pool) requires DOM globals it can't honor.
//
// The DB-touching functions (listCastForUser, createCast, etc.) need a D1
// binding to test meaningfully, which would require @cloudflare/vitest-pool-
// workers. Per the convention established in vitest.config.ts comment, we
// keep the unit suite Node-only and cover the pure helpers here. DB layer
// gets exercised by manual smoke + the existing route paths in dev.

import { describe, it, expect } from "vitest";
import { slugifyCharacter } from "../src/cast-db";

// Mirror of composeTrainingPrompt in public/cast.js. Keep in sync.
function composeTrainingPrompt(template: string, bible: string | null | undefined): string {
  const safeBible = String(bible || "").trim();
  if (!safeBible) return template;
  const trimmed = safeBible.length > 600 ? safeBible.slice(0, 600) : safeBible;
  return template + ". " + trimmed;
}

// Mirror of reconcileCastBindings in public/planner.js (v0.48.0).
// Keep in sync. Returns the bindings whose cast_id still exists in the
// fresh catalog plus the slot ids that lost their binding.
function reconcileCastBindings(
  bindings: Record<string, number>,
  catalog: Array<{ id: number }>,
): { kept: Record<string, number>; dropped: string[] } {
  const live = new Set((catalog || []).map((c) => c.id));
  const kept: Record<string, number> = {};
  const dropped: string[] = [];
  for (const slot of Object.keys(bindings || {})) {
    const id = bindings[slot];
    if (live.has(id)) kept[slot] = id;
    else dropped.push(slot);
  }
  return { kept, dropped };
}

describe("slugifyCharacter", () => {
  it("lowercases and dashes a normal name", () => {
    expect(slugifyCharacter("Kira Voss")).toBe("kira-voss");
  });

  it("strips punctuation", () => {
    expect(slugifyCharacter("Dr. Strange!")).toBe("dr-strange");
  });

  it("collapses repeated whitespace and dashes", () => {
    expect(slugifyCharacter("  big   --   bad  ")).toBe("big-bad");
  });

  it("normalizes diacritics", () => {
    expect(slugifyCharacter("Renée")).toBe("renee");
  });

  it("falls back to 'character' on empty input", () => {
    expect(slugifyCharacter("")).toBe("character");
    expect(slugifyCharacter("   ")).toBe("character");
  });

  it("falls back to 'character' on all-punctuation input", () => {
    expect(slugifyCharacter("!!!")).toBe("character");
    expect(slugifyCharacter("---")).toBe("character");
  });

  it("preserves digits", () => {
    expect(slugifyCharacter("Kira 2")).toBe("kira-2");
  });
});

describe("composeTrainingPrompt", () => {
  it("returns the template unchanged when bible is empty", () => {
    expect(composeTrainingPrompt("portrait, smiling", "")).toBe("portrait, smiling");
    expect(composeTrainingPrompt("portrait, smiling", null)).toBe("portrait, smiling");
    expect(composeTrainingPrompt("portrait, smiling", undefined)).toBe("portrait, smiling");
  });

  it("treats whitespace-only bible as empty", () => {
    expect(composeTrainingPrompt("portrait, smiling", "   \n  ")).toBe("portrait, smiling");
  });

  it("appends the bible after a separator", () => {
    expect(composeTrainingPrompt("portrait, smiling", "tall, green eyes")).toBe(
      "portrait, smiling. tall, green eyes",
    );
  });

  it("trims a long bible to 600 chars", () => {
    const long = "x".repeat(800);
    const out = composeTrainingPrompt("template", long);
    // template + ". " + trimmed (600 chars)
    expect(out.length).toBe("template. ".length + 600);
    expect(out.startsWith("template. ")).toBe(true);
  });

  it("does not trim a bible at exactly 600 chars", () => {
    const exact = "y".repeat(600);
    const out = composeTrainingPrompt("template", exact);
    expect(out).toBe("template. " + exact);
  });
});

describe("reconcileCastBindings", () => {
  it("keeps bindings whose cast_id is still in the catalog", () => {
    const bindings = { A: 1, B: 2 };
    const catalog = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const { kept, dropped } = reconcileCastBindings(bindings, catalog);
    expect(kept).toEqual({ A: 1, B: 2 });
    expect(dropped).toEqual([]);
  });

  it("drops bindings whose cast_id was deleted", () => {
    const bindings = { A: 1, B: 99, C: 3 };
    const catalog = [{ id: 1 }, { id: 3 }];
    const { kept, dropped } = reconcileCastBindings(bindings, catalog);
    expect(kept).toEqual({ A: 1, C: 3 });
    expect(dropped).toEqual(["B"]);
  });

  it("handles empty catalog", () => {
    const { kept, dropped } = reconcileCastBindings({ A: 1, B: 2 }, []);
    expect(kept).toEqual({});
    expect(dropped.sort()).toEqual(["A", "B"]);
  });

  it("handles empty bindings", () => {
    const { kept, dropped } = reconcileCastBindings({}, [{ id: 1 }]);
    expect(kept).toEqual({});
    expect(dropped).toEqual([]);
  });

  it("tolerates a missing bindings argument", () => {
    const { kept, dropped } = reconcileCastBindings(
      undefined as unknown as Record<string, number>,
      [{ id: 1 }],
    );
    expect(kept).toEqual({});
    expect(dropped).toEqual([]);
  });
});

// v0.49.0: storyboard yaml route round-trip. Exercises the full pipeline
// validateStoryboard -> serializeStoryboardYaml that the route handler
// wraps; not the route handler itself (which needs no test beyond
// "wraps two pure functions").
import { validateStoryboard } from "../src/storyboard-validate";
import { serializeStoryboardYaml } from "../src/planner-yaml";

describe("storyboard yaml route helpers", () => {
  const minimalStoryboard = {
    title: "test film",
    use_characters: ["A"],
    scenes: [
      { id: "shot_01", prompt: "wide establishing shot", character_slots: ["A"], target_seconds: 5 },
      { id: "shot_02", prompt: "close-up reaction", character_slots: ["A"], target_seconds: 3 },
    ],
  };

  it("validates a minimal storyboard + emits yaml that re-parses to the same shape", () => {
    const result = validateStoryboard(minimalStoryboard);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const yaml = serializeStoryboardYaml(result.value);
    expect(yaml).toContain('title: "test film"');
    expect(yaml).toContain('use_characters: [A]');
    expect(yaml).toContain('prompt: "wide establishing shot"');
    expect(yaml).toContain('prompt: "close-up reaction"');
  });

  it("rejects a storyboard whose edit blanked a required prompt", () => {
    const broken = {
      ...minimalStoryboard,
      scenes: [
        { id: "shot_01", prompt: "", character_slots: ["A"], target_seconds: 5 },
      ],
    };
    const result = validateStoryboard(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => /prompt/i.test(e))).toBe(true);
  });

  it("rejects a scene referencing a slot not in use_characters", () => {
    const broken = {
      ...minimalStoryboard,
      scenes: [
        { id: "shot_01", prompt: "ok", character_slots: ["B"], target_seconds: 5 },
      ],
    };
    const result = validateStoryboard(broken);
    expect(result.ok).toBe(false);
  });
});

// v0.50.0: refinement prompt builders. Test the pure helpers so changes
// to the prompt language are noticed at PR-review time.
import { buildRefinementSystemPrompt, buildRefinementUserMessage } from "../src/planner-prompt";

describe("refinement prompt builders", () => {
  it("system prompt includes the preserve-unchanged rule", () => {
    const sys = buildRefinementSystemPrompt();
    expect(sys.toLowerCase()).toContain("preserve");
    expect(sys.toLowerCase()).toMatch(/keep the old value|do not paraphrase/);
    // Same schema as the planning system prompt, so the JSON shape rules
    // are still in here.
    expect(sys).toContain('"title": string');
    expect(sys).toContain('"scenes":');
  });

  it("system prompt forbids prose, markdown, and code fences", () => {
    const sys = buildRefinementSystemPrompt();
    expect(sys.toLowerCase()).toContain("no prose");
    expect(sys.toLowerCase()).toContain("no markdown");
    expect(sys.toLowerCase()).toContain("no fences");
  });

  it("user message includes the current storyboard JSON + the user request", () => {
    const sb = { title: "test", scenes: [{ prompt: "wide" }] };
    const msg = "make scene 1 closer";
    const built = buildRefinementUserMessage(sb, msg);
    expect(built).toContain("CURRENT STORYBOARD:");
    expect(built).toContain('"title": "test"');
    expect(built).toContain('"prompt": "wide"');
    expect(built).toContain("USER REQUEST:");
    expect(built).toContain(msg);
    expect(built).toContain("Return the updated storyboard JSON now.");
  });

  it("user message trims leading/trailing whitespace on the user request", () => {
    const built = buildRefinementUserMessage({}, "   \n  add a fight  \n  ");
    expect(built).toContain("add a fight");
    // Should not contain the surrounding whitespace verbatim
    expect(built).not.toMatch(/USER REQUEST:\n\s+\n/);
  });
});

// v0.51.0: snapToBeats helper. Pure; lives in public/planner.js. Mirror
// here so vitest can lock it in without spinning up jsdom.
function snapToBeats(seconds: number, bpm: number, beatsPerShot: number): number {
  const safeBpm = Number(bpm);
  const safeBeats = Number(beatsPerShot);
  if (!Number.isFinite(safeBpm) || safeBpm <= 0) return seconds;
  if (!Number.isFinite(safeBeats) || safeBeats <= 0) return seconds;
  const phraseSeconds = (60 / safeBpm) * safeBeats;
  const snapped = Math.round((Number(seconds) || 0) / phraseSeconds) * phraseSeconds;
  return Math.max(phraseSeconds, Number.parseFloat(snapped.toFixed(3)));
}

describe("snapToBeats", () => {
  it("snaps a typical scene to the nearest 4-beat phrase at 120 BPM (phrase = 2s)", () => {
    // 5s / 2s = 2.5 -> rounds to 3 (JS Math.round) -> 3 * 2 = 6s
    expect(snapToBeats(5, 120, 4)).toBe(6);
    // 5.5s / 2 = 2.75 -> 3 -> 6s
    expect(snapToBeats(5.5, 120, 4)).toBe(6);
    // 7s / 2 = 3.5 -> 4 -> 8s
    expect(snapToBeats(7, 120, 4)).toBe(8);
    // exact phrase boundary stays put
    expect(snapToBeats(4, 120, 4)).toBe(4);
  });

  it("snaps to 1-beat at 90 BPM (phrase ~= 0.667s)", () => {
    // 1s / 0.667 = 1.5 -> 2 -> 1.333s
    expect(snapToBeats(1, 90, 1)).toBeCloseTo(1.333, 2);
  });

  it("floors at one phrase so a tiny scene does not collapse to zero", () => {
    expect(snapToBeats(0.1, 120, 4)).toBe(2); // never below one phrase
    expect(snapToBeats(0, 120, 4)).toBe(2);
  });

  it("returns the original seconds when BPM is invalid", () => {
    expect(snapToBeats(5, 0, 4)).toBe(5);
    expect(snapToBeats(5, -1, 4)).toBe(5);
    expect(snapToBeats(5, NaN, 4)).toBe(5);
  });

  it("returns the original seconds when beatsPerShot is invalid", () => {
    expect(snapToBeats(5, 120, 0)).toBe(5);
    expect(snapToBeats(5, 120, NaN)).toBe(5);
  });
});

// v0.52.0: audio key cross-bucket-copy decision. Pure helper, lives in
// src/audio-routing.ts so vitest can import without the
// cloudflare:workers runtime dep that src/index.ts carries.
import { needsAudioCrossBucketCopy } from "../src/audio-routing";

describe("needsAudioCrossBucketCopy", () => {
  it("returns true for MiniMax chat-side audio keys (out/...)", () => {
    expect(needsAudioCrossBucketCopy("out/abc-123.mp3")).toBe(true);
    expect(needsAudioCrossBucketCopy("out/uuid.wav")).toBe(true);
  });

  it("returns false for BYO uploads already in R2_RENDERS (audio/...)", () => {
    expect(needsAudioCrossBucketCopy("audio/abc-123.mp3")).toBe(false);
    expect(needsAudioCrossBucketCopy("audio/uuid.wav")).toBe(false);
  });

  it("returns false for empty / null / undefined", () => {
    expect(needsAudioCrossBucketCopy("")).toBe(false);
    expect(needsAudioCrossBucketCopy(null)).toBe(false);
    expect(needsAudioCrossBucketCopy(undefined)).toBe(false);
  });

  it("returns false for unrelated prefixes (no surprise copies)", () => {
    expect(needsAudioCrossBucketCopy("renders/x/silent_full.mp4")).toBe(false);
    expect(needsAudioCrossBucketCopy("bundles/x.tar.gz")).toBe(false);
    expect(needsAudioCrossBucketCopy("cast/1/portrait.png")).toBe(false);
  });

  it("anchors prefix matching at the start (does not match mid-string)", () => {
    expect(needsAudioCrossBucketCopy("foo/out/audio.mp3")).toBe(false);
  });
});

// v0.53.0: markers export. Pure helpers in src/markers.ts (no env / D1).
import { formatTimecode, buildMarkers, emitPremiereCsv, emitResolveCsv, emitMarkers } from "../src/markers";
import { slugifyProject } from "../src/storyboard-projects-db";

describe("formatTimecode", () => {
  it("renders zero as 00:00:00:00", () => {
    expect(formatTimecode(0, 24)).toBe("00:00:00:00");
  });

  it("rounds frames at 24 fps", () => {
    expect(formatTimecode(1, 24)).toBe("00:00:01:00");
    expect(formatTimecode(0.5, 24)).toBe("00:00:00:12");
  });

  it("handles minute + hour rollover", () => {
    expect(formatTimecode(60, 24)).toBe("00:01:00:00");
    expect(formatTimecode(3600, 24)).toBe("01:00:00:00");
    expect(formatTimecode(3661, 24)).toBe("01:01:01:00");
  });

  it("respects non-24 fps", () => {
    expect(formatTimecode(1, 30)).toBe("00:00:01:00");
    expect(formatTimecode(0.5, 30)).toBe("00:00:00:15");
  });

  it("falls back on invalid inputs", () => {
    expect(formatTimecode(-1, 24)).toBe("00:00:00:00");
    expect(formatTimecode(Infinity, 24)).toBe("00:00:00:00");
    expect(formatTimecode(1, 0)).toBe("00:00:01:00"); // fps falls back to 24
  });
});

describe("buildMarkers", () => {
  const sb = {
    title: "test",
    clip_seconds: 5,
    scenes: [
      { id: "shot_01", prompt: "wide", target_seconds: 4, act: "opening" },
      { id: "shot_02", prompt: "close", target_seconds: 3 },
      { id: "shot_03", prompt: "fight", act: "turn" },
    ],
  };

  it("computes cumulative in/out times across scenes", () => {
    const m = buildMarkers(sb);
    expect(m).toHaveLength(3);
    expect(m[0].inSeconds).toBe(0);
    expect(m[0].outSeconds).toBe(4);
    expect(m[1].inSeconds).toBe(4);
    expect(m[1].outSeconds).toBe(7);
    expect(m[2].inSeconds).toBe(7);
    // shot_03 has no target_seconds -> falls back to clip_seconds (5)
    expect(m[2].outSeconds).toBe(12);
  });

  it("emits scene id + act + prompt in description", () => {
    const m = buildMarkers(sb);
    expect(m[0].name).toBe("shot_01");
    expect(m[0].description).toBe("[opening] wide");
    expect(m[2].description).toBe("[turn] fight");
  });

  it("synthesizes a name when scene id is missing", () => {
    const m = buildMarkers({ scenes: [{ prompt: "x", target_seconds: 1 }] });
    expect(m[0].name).toBe("scene_01");
  });

  it("returns empty array when scenes are missing", () => {
    expect(buildMarkers({})).toEqual([]);
  });
});

describe("emitPremiereCsv / emitResolveCsv", () => {
  const sb = {
    title: "test",
    scenes: [
      { id: "shot_01", prompt: "wide establishing", target_seconds: 4, act: "opening" },
      { id: "shot_02", prompt: "close-up", target_seconds: 3 },
    ],
  };

  it("Premiere CSV uses tab-separated header + Comment marker type", () => {
    const out = emitPremiereCsv(sb, 24);
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("Marker Name\tDescription\tIn\tOut\tDuration\tMarker Type");
    expect(lines[1].split("\t")[0]).toBe("shot_01");
    expect(lines[1].split("\t").pop()).toBe("Comment");
  });

  it("Resolve CSV uses comma-separated header + color column", () => {
    const out = emitResolveCsv(sb, 24);
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("#,Color,Name,Time");
    // shot_01 act=opening -> Blue
    expect(lines[1].split(",")[1]).toBe("Blue");
    // shot_02 no act -> Blue default
    expect(lines[2].split(",")[1]).toBe("Blue");
  });

  it("Resolve CSV picks act-specific colors", () => {
    const out = emitResolveCsv({
      title: "x",
      scenes: [
        { id: "a", prompt: "p", target_seconds: 1, act: "climax" },
        { id: "b", prompt: "p", target_seconds: 1, act: "turn" },
      ],
    });
    const lines = out.trim().split("\n");
    expect(lines[1].split(",")[1]).toBe("Red");
    expect(lines[2].split(",")[1]).toBe("Yellow");
  });

  it("emitMarkers returns the right contentType + filename", () => {
    const a = emitMarkers(sb, "premiere_csv");
    expect(a.contentType).toBe("text/csv; charset=utf-8");
    expect(a.filename).toBe("test-premiere-markers.csv");
    const b = emitMarkers(sb, "resolve_csv");
    expect(b.filename).toBe("test-resolve-markers.csv");
  });
});

describe("slugifyProject", () => {
  it("lowercases and dashes a normal name", () => {
    expect(slugifyProject("Cherry Pie")).toBe("cherry-pie");
  });
  it("falls back to 'project' on empty", () => {
    expect(slugifyProject("")).toBe("project");
    expect(slugifyProject("---")).toBe("project");
  });
});
