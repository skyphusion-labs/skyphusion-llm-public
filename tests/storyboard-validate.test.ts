// Tests for validateStoryboard and normalizeProjectName (v0.27.0).
//
// Pure structural validation. Slot readiness (registry + >=8 refs) is
// out of scope by design; tested separately in the R2 pre-flight.

import { describe, it, expect } from "vitest";
import {
  SLOT_IDS,
  normalizeProjectName,
  normalizePerShotModels,
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
        // v0.80.0: scenes always carry an id (coerced to shot_NN
        // when LLM Assist omits it or emits a non-matching string).
        expect(result.value.scenes).toEqual([
          { id: "shot_01", prompt: "Wide shot of a hilltop." },
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

  // v0.80.0: content-shape guards that protect the GPU renderer from
  // LLM Assist outputs that pass structural validation but break
  // downstream constraints (CLIP-77 token cap, scene count, shot_NN
  // pattern, free-text bloat).
  describe("v0.80.0 content guards", () => {
    const sceneOk = (prompt: string) => ({ prompt });
    const baseOk = {
      title: "demo",
      scenes: [sceneOk("Aria sits beside Marcus around a small campfire.")],
    };

    it("rejects scene prompt over 50 words (SDXL CLIP-77 budget)", () => {
      const longPrompt = Array.from({ length: 60 }, (_, i) => `word${i}`).join(
        " ",
      );
      const r = validateStoryboard({
        ...baseOk,
        scenes: [sceneOk(longPrompt)],
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(
        r.errors.some((e) => /60 words/.test(e) && /cap is 50/.test(e)),
      ).toBe(true);
    });

    it("accepts a scene prompt at exactly 50 words", () => {
      const fiftyPrompt = Array.from({ length: 50 }, (_, i) => `word${i}`).join(
        " ",
      );
      const r = validateStoryboard({
        ...baseOk,
        scenes: [sceneOk(fiftyPrompt)],
      });
      expect(r.ok).toBe(true);
    });

    it("rejects more than 50 scenes (hard cap)", () => {
      const r = validateStoryboard({
        ...baseOk,
        scenes: Array.from({ length: 51 }, () => sceneOk("ok scene")),
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(
        r.errors.some(
          (e) => /scenes count 51/.test(e) && /hard cap of 50/.test(e),
        ),
      ).toBe(true);
    });

    it("accepts 50 scenes (at the cap)", () => {
      const r = validateStoryboard({
        ...baseOk,
        scenes: Array.from({ length: 50 }, () => sceneOk("ok scene")),
      });
      expect(r.ok).toBe(true);
    });

    it("coerces a non-shot_NN scene id to shot_NN (LLM emits 'scene_a')", () => {
      const r = validateStoryboard({
        ...baseOk,
        scenes: [
          { id: "scene_a", prompt: "Aria walks in." },
          { id: "shot_42", prompt: "Marcus appears." },
          { id: "", prompt: "campfire." },
        ],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // First scene's bad id becomes shot_01; second is preserved;
      // third (empty) becomes shot_03.
      expect(r.value.scenes[0].id).toBe("shot_01");
      expect(r.value.scenes[1].id).toBe("shot_42");
      expect(r.value.scenes[2].id).toBe("shot_03");
    });

    it("coerces an undefined scene id to shot_NN in declaration order", () => {
      const r = validateStoryboard({
        ...baseOk,
        scenes: [
          { prompt: "first" },
          { prompt: "second" },
        ],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.scenes[0].id).toBe("shot_01");
      expect(r.value.scenes[1].id).toBe("shot_02");
    });

    it("rejects full_prompt over 1024 chars", () => {
      const r = validateStoryboard({
        ...baseOk,
        full_prompt: "a".repeat(1025),
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(
        r.errors.some((e) => /full_prompt is 1025 chars/.test(e)),
      ).toBe(true);
    });

    it("accepts full_prompt at 1024 chars", () => {
      const r = validateStoryboard({
        ...baseOk,
        full_prompt: "a".repeat(1024),
      });
      expect(r.ok).toBe(true);
    });

    it("rejects style_prefix over 256 chars (CLIP-77 budget in bg-pass)", () => {
      const r = validateStoryboard({
        ...baseOk,
        style_prefix: "b".repeat(257),
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(
        r.errors.some(
          (e) => /style_prefix is 257 chars/.test(e) && /cap is 256/.test(e),
        ),
      ).toBe(true);
    });
  });
});

describe("normalizePerShotModels", () => {
  const allowed = new Set([
    "runwayml/gen-4.5",
    "minimax/hailuo-2.3-fast",
    "bytedance/seedance-2.0",
  ]);

  it("treats missing / empty input as no overrides", () => {
    expect(normalizePerShotModels(undefined, allowed)).toEqual({ perShot: {}, errors: [] });
    expect(normalizePerShotModels(null, allowed)).toEqual({ perShot: {}, errors: [] });
    expect(normalizePerShotModels({}, allowed)).toEqual({ perShot: {}, errors: [] });
  });

  it("keeps valid shot->model entries", () => {
    const r = normalizePerShotModels(
      { shot_01: "runwayml/gen-4.5", shot_02: "bytedance/seedance-2.0" },
      allowed,
    );
    expect(r.errors).toEqual([]);
    expect(r.perShot).toEqual({
      shot_01: "runwayml/gen-4.5",
      shot_02: "bytedance/seedance-2.0",
    });
  });

  it("rejects an unknown model id with an error and omits it", () => {
    const r = normalizePerShotModels({ shot_01: "openai/sora" }, allowed);
    expect(r.perShot).toEqual({});
    expect(r.errors.some((e) => /shot_01/.test(e) && /not an image-input/.test(e))).toBe(true);
  });

  it("rejects a non-string model value and a non-object input", () => {
    expect(normalizePerShotModels({ shot_01: 7 }, allowed).errors.length).toBe(1);
    expect(normalizePerShotModels([1, 2], allowed).errors[0]).toMatch(/must be an object/);
  });
});
