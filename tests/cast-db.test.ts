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
