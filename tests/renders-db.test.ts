// Tests for the pure helpers in renders-db.ts (v0.39.0). The DB calls
// themselves hit the D1 binding and are not unit-tested here; the
// keyframe-normalizer is pure and covers the wire-shape contract with
// the GPU side's COMPLETED envelope.

import { describe, it, expect } from "vitest";
import {
  normalizeKeyframes,
  normalizeLockedShots,
  normalizeFolderPath,
  normalizeTags,
} from "../src/renders-db";

describe("normalizeKeyframes", () => {
  it("returns [] for non-array input", () => {
    expect(normalizeKeyframes(undefined)).toEqual([]);
    expect(normalizeKeyframes(null)).toEqual([]);
    expect(normalizeKeyframes({})).toEqual([]);
    expect(normalizeKeyframes("string")).toEqual([]);
    expect(normalizeKeyframes(42)).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(normalizeKeyframes([])).toEqual([]);
  });

  it("accepts the canonical {shot_id, key} entries", () => {
    expect(
      normalizeKeyframes([
        { shot_id: "shot_01", key: "renders/cherry/job-1/keyframes/shot_01.png" },
        { shot_id: "shot_02", key: "renders/cherry/job-1/keyframes/shot_02.png" },
      ]),
    ).toEqual([
      { shot_id: "shot_01", key: "renders/cherry/job-1/keyframes/shot_01.png" },
      { shot_id: "shot_02", key: "renders/cherry/job-1/keyframes/shot_02.png" },
    ]);
  });

  it("drops entries missing shot_id or key", () => {
    expect(
      normalizeKeyframes([
        { shot_id: "shot_01", key: "renders/cherry/k/shot_01.png" },
        { shot_id: "shot_02" }, // missing key
        { key: "renders/cherry/k/shot_03.png" }, // missing shot_id
        {}, // both missing
      ]),
    ).toEqual([
      { shot_id: "shot_01", key: "renders/cherry/k/shot_01.png" },
    ]);
  });

  it("drops entries with wrong-type shot_id or key", () => {
    expect(
      normalizeKeyframes([
        { shot_id: 42, key: "renders/x.png" },
        { shot_id: "shot_02", key: 42 },
        { shot_id: "", key: "renders/x.png" },
        { shot_id: "shot_03", key: "" },
        { shot_id: "shot_04", key: "renders/ok.png" },
      ]),
    ).toEqual([{ shot_id: "shot_04", key: "renders/ok.png" }]);
  });

  it("tolerates extra fields the GPU side may add later", () => {
    expect(
      normalizeKeyframes([
        {
          shot_id: "shot_01",
          key: "renders/x.png",
          width: 1024,
          height: 1024,
          scene_index: 0,
        },
      ]),
    ).toEqual([{ shot_id: "shot_01", key: "renders/x.png" }]);
  });

  it("drops null / non-object entries without throwing", () => {
    expect(
      normalizeKeyframes([
        null,
        undefined,
        "string-entry",
        42,
        { shot_id: "shot_01", key: "renders/x.png" },
      ]),
    ).toEqual([{ shot_id: "shot_01", key: "renders/x.png" }]);
  });
});

describe("normalizeLockedShots (v0.42.0)", () => {
  it("returns [] for non-array input", () => {
    expect(normalizeLockedShots(undefined)).toEqual([]);
    expect(normalizeLockedShots(null)).toEqual([]);
    expect(normalizeLockedShots({})).toEqual([]);
    expect(normalizeLockedShots("shot_01")).toEqual([]);
    expect(normalizeLockedShots(42)).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(normalizeLockedShots([])).toEqual([]);
  });

  it("accepts a canonical shot_id array", () => {
    expect(normalizeLockedShots(["shot_01", "shot_02", "shot_03"])).toEqual([
      "shot_01",
      "shot_02",
      "shot_03",
    ]);
  });

  it("trims surrounding whitespace and drops empty / whitespace-only entries", () => {
    expect(normalizeLockedShots([" shot_01 ", "", "  ", "shot_02"])).toEqual([
      "shot_01",
      "shot_02",
    ]);
  });

  it("drops non-string entries and entries longer than 80 chars", () => {
    expect(
      normalizeLockedShots([
        "shot_01",
        42,
        null,
        { id: "shot_02" },
        "shot_02",
        "x".repeat(81),
        "x".repeat(80),
      ]),
    ).toEqual(["shot_01", "shot_02", "x".repeat(80)]);
  });

  it("dedupes identical entries while preserving first-seen order", () => {
    expect(
      normalizeLockedShots(["shot_02", "shot_01", "shot_02", "shot_01"]),
    ).toEqual(["shot_02", "shot_01"]);
  });

  it("caps the list at 200 entries (MAX_LOCKED_SHOTS)", () => {
    const overflow = Array.from({ length: 250 }, (_, i) => `shot_${i}`);
    const out = normalizeLockedShots(overflow);
    expect(out).toHaveLength(200);
    expect(out[0]).toBe("shot_0");
    expect(out[199]).toBe("shot_199");
  });
});

describe("normalizeFolderPath", () => {
  it("returns null for non-string / empty / slash-only", () => {
    expect(normalizeFolderPath(undefined)).toBeNull();
    expect(normalizeFolderPath(null)).toBeNull();
    expect(normalizeFolderPath(42)).toBeNull();
    expect(normalizeFolderPath("")).toBeNull();
    expect(normalizeFolderPath("   ")).toBeNull();
    expect(normalizeFolderPath("///")).toBeNull();
  });

  it("trims segments and collapses leading/trailing/doubled slashes", () => {
    expect(normalizeFolderPath("/clients/acme/")).toBe("clients/acme");
    expect(normalizeFolderPath("clients//acme")).toBe("clients/acme");
    expect(normalizeFolderPath("  clients / acme  ")).toBe("clients/acme");
    expect(normalizeFolderPath("promo")).toBe("promo");
  });

  it("caps length at 200 chars", () => {
    const long = "a/".repeat(300);
    expect(normalizeFolderPath(long).length).toBe(200);
  });
});

describe("normalizeTags", () => {
  it("returns [] for non-array input", () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags("final")).toEqual([]);
    expect(normalizeTags({})).toEqual([]);
  });

  it("lowercases, trims, drops empties, and dedupes order-preserving", () => {
    expect(normalizeTags(["Final", " hero ", "FINAL", "", "  ", "hero"])).toEqual([
      "final",
      "hero",
    ]);
  });

  it("drops non-string entries and caps each tag at 40 chars", () => {
    expect(normalizeTags(["ok", 5, null, { x: 1 }])).toEqual(["ok"]);
    expect(normalizeTags(["a".repeat(80)])[0].length).toBe(40);
  });

  it("caps the total tag count at 24", () => {
    const many = Array.from({ length: 50 }, (_, i) => `tag${i}`);
    expect(normalizeTags(many)).toHaveLength(24);
  });
});
