// Tests for the pure helpers in renders-db.ts (v0.39.0). The DB calls
// themselves hit the D1 binding and are not unit-tested here; the
// keyframe-normalizer is pure and covers the wire-shape contract with
// the GPU side's COMPLETED envelope.

import { describe, it, expect } from "vitest";
import { normalizeKeyframes } from "../src/renders-db";

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
