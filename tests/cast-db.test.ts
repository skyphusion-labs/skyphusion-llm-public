// Tests for the pure helpers in src/cast-db.ts (v0.46.0).
//
// The DB-touching functions (listCastForUser, createCast, etc.) need a D1
// binding to test meaningfully, which would require @cloudflare/vitest-pool-
// workers. Per the convention established in vitest.config.ts comment, we
// keep the unit suite Node-only and cover the pure helpers here. DB layer
// gets exercised by manual smoke + the existing route paths in dev.

import { describe, it, expect } from "vitest";
import { slugifyCharacter } from "../src/cast-db";

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
