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
