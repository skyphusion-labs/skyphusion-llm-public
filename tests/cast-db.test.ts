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
