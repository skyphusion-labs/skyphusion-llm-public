// Tests for validateStoryboard and normalizeProjectName (v0.27.0).
//
// Pure structural validation. Slot readiness (registry + >=8 refs) is
// out of scope by design; tested separately in the R2 pre-flight.

import { describe, it, expect } from "vitest";
import {
  SLOT_IDS,
  normalizeProjectName,
  validateStoryboard,
} from "../src/storyboard-validate";

describe("normalizeProjectName", () => {
  it("strips outer whitespace and replaces internal spaces with underscores", () => {
    expect(normalizeProjectName("My Project")).toBe("My_Project");
    expect(normalizeProjectName("  hello world  ")).toBe("hello_world");
  });

  it("collapses internal whitespace runs to a single underscore", () => {
    expect(normalizeProjectName("a   b")).toBe("a_b");
    expect(normalizeProjectName("a\tb")).toBe("a_b");
  });

  it("returns 'project' for empty / all-whitespace / null / undefined input", () => {
    expect(normalizeProjectName("")).toBe("project");
    expect(normalizeProjectName("   ")).toBe("project");
    expect(normalizeProjectName(null)).toBe("project");
    expect(normalizeProjectName(undefined)).toBe("project");
  });

  it("leaves a single-word title unchanged", () => {
    expect(normalizeProjectName("cherry")).toBe("cherry");
  });
});

describe("validateStoryboard", () => {
  describe("happy path", () => {
    it("accepts a minimal valid storyboard (just title + one scene with prompt)", () => {
      const result = validateStoryboard({
        title: "my project",
        scenes: [{ prompt: "Wide shot of a hilltop." }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.title).toBe("my project");
        expect(result.value.projectName).toBe("my_project");
        expect(result.value.scenes).toEqual([
          { prompt: "Wide shot of a hilltop." },
        ]);
        // Defaults
        expect(result.value.style_category).toBe("None");
        expect(result.value.style_preset).toBe("None");
        expect(result.value.use_characters).toEqual([]);
        expect(result.value.style_prefix).toBe("");
        expect(result.value.cast_rules).toBe("");
        expect(result.value.full_prompt).toBe("");
        expect(result.value.duration_seconds).toBeUndefined();
        expect(result.value.clip_seconds).toBeUndefined();
        expect(result.value.refs_dir).toBeUndefined();
      }
    });

    it("accepts the full storyboard.example.yaml shape", () => {
      const result = validateStoryboard({
        title: "cherry",
        full_prompt: "Three-shot vignette: hilltop, hero enters, close-up.",
        duration_seconds: 22,
        clip_seconds: 7,
        style_prefix: "cinematic 35mm film, soft golden hour light",
        style_category: "Anime",
        style_preset: "None",
        use_characters: ["A"],
        cast_rules: "",
        scenes: [
          {
            id: "shot_01",
            prompt: "Wide establishing shot.",
            character_slots: ["A"],
            start: 0,
            end: 7,
            target_seconds: 7,
            act: "opening",
          },
          {
            id: "shot_02",
            prompt: "Hero enters frame.",
            character_slots: ["A"],
          },
          {
            id: "shot_03",
            prompt: "Close-up.",
            character_slots: ["A"],
          },
        ],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.duration_seconds).toBe(22);
        expect(result.value.clip_seconds).toBe(7);
        expect(result.value.style_category).toBe("Anime");
        expect(result.value.style_preset).toBe("None");
        expect(result.value.use_characters).toEqual(["A"]);
        expect(result.value.scenes.length).toBe(3);
        expect(result.value.scenes[0].start).toBe(0);
        expect(result.value.scenes[0].end).toBe(7);
        expect(result.value.scenes[0].target_seconds).toBe(7);
        expect(result.value.scenes[0].act).toBe("opening");
      }
    });

    it("accepts multi-character storyboards (two slots loaded, scenes lock to subsets)", () => {
      const result = validateStoryboard({
        title: "duet",
        use_characters: ["A", "B"],
        scenes: [
          { prompt: "Hero A solo wide.", character_slots: ["A"] },
          { prompt: "Hero B solo medium.", character_slots: ["B"] },
          { prompt: "Both close-up.", character_slots: ["A", "B"] },
          { prompt: "Empty frame, no characters." },
        ],
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("title", () => {
    it("rejects missing title", () => {
      const result = validateStoryboard({
        scenes: [{ prompt: "p" }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => /title/i.test(e))).toBe(true);
      }
    });

    it("rejects empty title", () => {
      const result = validateStoryboard({
        title: "",
        scenes: [{ prompt: "p" }],
      });
      expect(result.ok).toBe(false);
    });

    it("rejects whitespace-only title", () => {
      const result = validateStoryboard({
        title: "   ",
        scenes: [{ prompt: "p" }],
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("scenes", () => {
    it("rejects missing scenes", () => {
      const result = validateStoryboard({ title: "x" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) => /scenes/i.test(e) && /non-empty array/i.test(e),
          ),
        ).toBe(true);
      }
    });

    it("rejects empty scenes array", () => {
      const result = validateStoryboard({ title: "x", scenes: [] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) => /scenes/i.test(e) && /empty/i.test(e)),
        ).toBe(true);
      }
    });

    it("rejects scenes given as non-array", () => {
      const result = validateStoryboard({ title: "x", scenes: {} });
      expect(result.ok).toBe(false);
    });

    it("rejects a scene missing prompt (with id present, error names the id)", () => {
      const result = validateStoryboard({
        title: "x",
        scenes: [{ id: "shot_01" }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) => /prompt/i.test(e) && /shot_01/.test(e),
          ),
        ).toBe(true);
      }
    });

    it("rejects a scene missing prompt (no id, error names the index)", () => {
      const result = validateStoryboard({
        title: "x",
        scenes: [{}],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) => /prompt/i.test(e) && /scenes\[0\]/.test(e),
          ),
        ).toBe(true);
      }
    });

    it("rejects a scene whose prompt is empty / whitespace-only", () => {
      const empty = validateStoryboard({
        title: "x",
        scenes: [{ prompt: "" }],
      });
      expect(empty.ok).toBe(false);

      const ws = validateStoryboard({
        title: "x",
        scenes: [{ prompt: "   " }],
      });
      expect(ws.ok).toBe(false);
    });

    it("rejects a scene that is not an object", () => {
      const result = validateStoryboard({
        title: "x",
        scenes: ["a string is not a scene"],
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("use_characters", () => {
    it("rejects use_characters given as non-array", () => {
      const result = validateStoryboard({
        title: "x",
        use_characters: "A",
        scenes: [{ prompt: "p" }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) => /use_characters/i.test(e)),
        ).toBe(true);
      }
    });

    it("rejects use_characters with an invalid slot id", () => {
      const result = validateStoryboard({
        title: "x",
        use_characters: ["A", "Z"],
        scenes: [{ prompt: "p" }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) =>
              /use_characters/i.test(e) &&
              /"Z"/.test(e) &&
              /allowed/i.test(e),
          ),
        ).toBe(true);
      }
    });

    it("rejects duplicate slot ids in use_characters", () => {
      const result = validateStoryboard({
        title: "x",
        use_characters: ["A", "A"],
        scenes: [{ prompt: "p" }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) => /duplicated/i.test(e)),
        ).toBe(true);
      }
    });
  });

  describe("character_slots subset rule", () => {
    it("rejects character_slots referencing a slot not in use_characters", () => {
      const result = validateStoryboard({
        title: "x",
        use_characters: ["A"],
        scenes: [{ prompt: "p", character_slots: ["A", "B"] }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) =>
              /character_slots/i.test(e) &&
              /"B"/.test(e) &&
              /not in use_characters/i.test(e),
          ),
        ).toBe(true);
      }
    });

    it("rejects character_slots when use_characters is omitted entirely", () => {
      const result = validateStoryboard({
        title: "x",
        scenes: [{ prompt: "p", character_slots: ["A"] }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) =>
              /character_slots/i.test(e) &&
              /not in use_characters/i.test(e) &&
              /none/i.test(e),
          ),
        ).toBe(true);
      }
    });

    it("rejects character_slots with an invalid slot id (before subset check)", () => {
      const result = validateStoryboard({
        title: "x",
        use_characters: ["A"],
        scenes: [{ prompt: "p", character_slots: ["A", "Q"] }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) => /"Q"/.test(e) && /allowed/i.test(e),
          ),
        ).toBe(true);
      }
    });

    it("accepts an empty character_slots array (scene with no character lock)", () => {
      const result = validateStoryboard({
        title: "x",
        use_characters: ["A"],
        scenes: [{ prompt: "p", character_slots: [] }],
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("None normalization", () => {
    it("normalizes undefined style_category / style_preset to 'None'", () => {
      const result = validateStoryboard({
        title: "x",
        scenes: [{ prompt: "p" }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.style_category).toBe("None");
        expect(result.value.style_preset).toBe("None");
      }
    });

    it("normalizes null style_category / style_preset to 'None'", () => {
      const result = validateStoryboard({
        title: "x",
        style_category: null,
        style_preset: null,
        scenes: [{ prompt: "p" }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.style_category).toBe("None");
        expect(result.value.style_preset).toBe("None");
      }
    });

    it("normalizes empty / whitespace style_category / style_preset to 'None'", () => {
      const result = validateStoryboard({
        title: "x",
        style_category: "",
        style_preset: "   ",
        scenes: [{ prompt: "p" }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.style_category).toBe("None");
        expect(result.value.style_preset).toBe("None");
      }
    });

    it("preserves non-empty style_category / style_preset", () => {
      const result = validateStoryboard({
        title: "x",
        style_category: "Anime",
        style_preset: "Vibrant",
        scenes: [{ prompt: "p" }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.style_category).toBe("Anime");
        expect(result.value.style_preset).toBe("Vibrant");
      }
    });
  });

  describe("duration_seconds / clip_seconds", () => {
    it("accepts positive numbers", () => {
      const result = validateStoryboard({
        title: "x",
        duration_seconds: 22,
        clip_seconds: 7.5,
        scenes: [{ prompt: "p" }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.duration_seconds).toBe(22);
        expect(result.value.clip_seconds).toBe(7.5);
      }
    });

    it("rejects zero", () => {
      const result = validateStoryboard({
        title: "x",
        duration_seconds: 0,
        scenes: [{ prompt: "p" }],
      });
      expect(result.ok).toBe(false);
    });

    it("rejects negative numbers", () => {
      const result = validateStoryboard({
        title: "x",
        clip_seconds: -3,
        scenes: [{ prompt: "p" }],
      });
      expect(result.ok).toBe(false);
    });

    it("rejects non-finite numbers", () => {
      const nan = validateStoryboard({
        title: "x",
        clip_seconds: Number.NaN,
        scenes: [{ prompt: "p" }],
      });
      expect(nan.ok).toBe(false);

      const inf = validateStoryboard({
        title: "x",
        duration_seconds: Number.POSITIVE_INFINITY,
        scenes: [{ prompt: "p" }],
      });
      expect(inf.ok).toBe(false);
    });

    it("rejects non-numeric values", () => {
      const result = validateStoryboard({
        title: "x",
        duration_seconds: "22",
        scenes: [{ prompt: "p" }],
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("scene timing", () => {
    it("accepts start: 0 (legal film-time origin)", () => {
      const result = validateStoryboard({
        title: "x",
        scenes: [{ prompt: "p", start: 0, end: 7 }],
      });
      expect(result.ok).toBe(true);
    });

    it("rejects end <= start", () => {
      const result = validateStoryboard({
        title: "x",
        scenes: [{ prompt: "p", start: 7, end: 7 }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some(
            (e) => /end/i.test(e) && /greater than start/i.test(e),
          ),
        ).toBe(true);
      }
    });

    it("rejects negative start", () => {
      const result = validateStoryboard({
        title: "x",
        scenes: [{ prompt: "p", start: -1 }],
      });
      expect(result.ok).toBe(false);
    });

    it("rejects zero target_seconds", () => {
      const result = validateStoryboard({
        title: "x",
        scenes: [{ prompt: "p", target_seconds: 0 }],
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("non-object inputs", () => {
    it("rejects null", () => {
      expect(validateStoryboard(null).ok).toBe(false);
    });
    it("rejects array", () => {
      expect(validateStoryboard([]).ok).toBe(false);
    });
    it("rejects string", () => {
      expect(validateStoryboard("storyboard").ok).toBe(false);
    });
    it("rejects number", () => {
      expect(validateStoryboard(42).ok).toBe(false);
    });
  });

  describe("error accumulation", () => {
    it("collects multiple structural errors in one pass", () => {
      const result = validateStoryboard({
        // Missing title.
        use_characters: ["A", "Z"], // invalid slot
        scenes: [
          { prompt: "" }, // empty prompt
          { id: "shot_02", character_slots: ["B"] }, // missing prompt + slot not loaded
        ],
        duration_seconds: -1, // not positive
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // At least: title, use_characters[Z], scenes[0] prompt, scenes[1]
        // (shot_02) prompt + character_slots subset, duration_seconds.
        expect(result.errors.length).toBeGreaterThanOrEqual(5);
      }
    });
  });

  describe("invariants", () => {
    it("SLOT_IDS matches characters.SLOTS = ['A', 'B', 'C', 'D']", () => {
      expect([...SLOT_IDS]).toEqual(["A", "B", "C", "D"]);
    });
  });
});
