// Tests for the cast-LoRA binding resolver (v0.58.0). The helper is
// pure and lives in src/lora-resolver.ts; the route in src/index.ts
// loads CastMember rows via getCastById then hands the result here for
// reshaping into the `pretrained_loras` wire shape the vivijure-
// serverless 0.4.14+ GPU worker reads.

import { describe, it, expect } from "vitest";
import { resolveCastLoraBindings, uniqueCastIds } from "../src/lora-resolver";
import type { CastMember } from "../src/cast-db";

function makeCast(overrides: Partial<CastMember>): CastMember {
  return {
    id: 1,
    user_email: "u@example.com",
    slug: "kira",
    name: "Kira",
    bible: null,
    portrait_key: null,
    portrait_mime: null,
    ref_keys: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    lora_key: null,
    lora_status: "idle",
    lora_job_id: null,
    lora_error: null,
    lora_trained_at: null,
    ...overrides,
  };
}

describe("uniqueCastIds", () => {
  it("returns an empty array for undefined / null / non-object input", () => {
    expect(uniqueCastIds(undefined)).toEqual([]);
    expect(uniqueCastIds(null)).toEqual([]);
  });

  it("dedupes ids that appear under multiple slots", () => {
    expect(uniqueCastIds({ A: 1, B: 1, C: 2 }).sort()).toEqual([1, 2]);
  });

  it("drops non-integer / non-positive values silently", () => {
    expect(uniqueCastIds({ A: 1, B: 0, C: -1, D: 2.5 } as unknown as Record<string, number>))
      .toEqual([1]);
  });
});

describe("resolveCastLoraBindings", () => {
  it("returns empty maps for undefined / null / non-object bindings", () => {
    const out = resolveCastLoraBindings(undefined, new Map());
    expect(out.pretrained).toEqual({});
    expect(out.skipped).toEqual([]);
  });

  it("includes a ready cast member's lora_key under the requested slot", () => {
    const cast = makeCast({ id: 1, lora_status: "ready", lora_key: "loras/cast-1/foo.safetensors" });
    const loaded = new Map<number, CastMember | null>([[1, cast]]);
    const out = resolveCastLoraBindings({ A: 1 }, loaded);
    expect(out.pretrained).toEqual({ A: "loras/cast-1/foo.safetensors" });
    expect(out.skipped).toEqual([]);
  });

  it("uppercases lowercase slots before matching the A..Z rule", () => {
    const cast = makeCast({ id: 1, lora_status: "ready", lora_key: "loras/x.safetensors" });
    const out = resolveCastLoraBindings({ b: 1 }, new Map([[1, cast]]));
    expect(out.pretrained).toEqual({ B: "loras/x.safetensors" });
  });

  it("drops slots that are not single letters (digits, multi-char, symbols)", () => {
    const cast = makeCast({ id: 1, lora_status: "ready", lora_key: "loras/x.safetensors" });
    const loaded = new Map<number, CastMember | null>([[1, cast]]);
    const out = resolveCastLoraBindings(
      { "1": 1, AB: 1, "@": 1 },
      loaded,
    );
    expect(out.pretrained).toEqual({});
    expect(out.skipped.map((s) => s.reason)).toEqual([
      "invalid_slot", "invalid_slot", "invalid_slot",
    ]);
  });

  it("drops cast_ids that are not positive integers", () => {
    const out = resolveCastLoraBindings(
      { A: 0, B: -1, C: 2.5 } as unknown as Record<string, number>,
      new Map(),
    );
    expect(out.pretrained).toEqual({});
    expect(out.skipped.map((s) => s.reason)).toEqual([
      "invalid_cast_id", "invalid_cast_id", "invalid_cast_id",
    ]);
  });

  it("marks not_found when the loaded map has null for that id (not owned or absent)", () => {
    const out = resolveCastLoraBindings(
      { A: 99 },
      new Map<number, CastMember | null>([[99, null]]),
    );
    expect(out.pretrained).toEqual({});
    expect(out.skipped).toEqual([{ slot: "A", cast_id: 99, reason: "not_found" }]);
  });

  it("marks not_found when the id is missing from the loaded map", () => {
    const out = resolveCastLoraBindings({ A: 7 }, new Map());
    expect(out.skipped).toEqual([{ slot: "A", cast_id: 7, reason: "not_found" }]);
  });

  it("marks not_ready when lora_status is anything other than 'ready'", () => {
    const training = makeCast({ id: 1, lora_status: "training", lora_key: "loras/x.safetensors" });
    const failed = makeCast({ id: 2, lora_status: "failed", lora_key: "loras/x.safetensors" });
    const idle = makeCast({ id: 3, lora_status: "idle", lora_key: "loras/x.safetensors" });
    const loaded = new Map<number, CastMember | null>([
      [1, training], [2, failed], [3, idle],
    ]);
    const out = resolveCastLoraBindings({ A: 1, B: 2, C: 3 }, loaded);
    expect(out.pretrained).toEqual({});
    expect(out.skipped.map((s) => s.reason)).toEqual([
      "not_ready", "not_ready", "not_ready",
    ]);
  });

  it("marks no_lora_key when lora_key is missing or has the wrong prefix", () => {
    const noKey = makeCast({ id: 1, lora_status: "ready", lora_key: null });
    const wrongPrefix = makeCast({ id: 2, lora_status: "ready", lora_key: "out/x.safetensors" });
    const loaded = new Map<number, CastMember | null>([[1, noKey], [2, wrongPrefix]]);
    const out = resolveCastLoraBindings({ A: 1, B: 2 }, loaded);
    expect(out.pretrained).toEqual({});
    expect(out.skipped.map((s) => s.reason)).toEqual(["no_lora_key", "no_lora_key"]);
  });

  it("mixes ready and not-ready bindings without dropping the ready ones", () => {
    const ready = makeCast({ id: 1, lora_status: "ready", lora_key: "loras/cast-1/r.safetensors" });
    const training = makeCast({ id: 2, lora_status: "training" });
    const loaded = new Map<number, CastMember | null>([[1, ready], [2, training]]);
    const out = resolveCastLoraBindings({ A: 1, B: 2 }, loaded);
    expect(out.pretrained).toEqual({ A: "loras/cast-1/r.safetensors" });
    expect(out.skipped).toEqual([{ slot: "B", cast_id: 2, reason: "not_ready" }]);
  });

  it("preserves slot characters when two slots bind to the same id", () => {
    const ready = makeCast({ id: 1, lora_status: "ready", lora_key: "loras/cast-1/r.safetensors" });
    const loaded = new Map<number, CastMember | null>([[1, ready]]);
    const out = resolveCastLoraBindings({ A: 1, C: 1 }, loaded);
    expect(out.pretrained).toEqual({
      A: "loras/cast-1/r.safetensors",
      C: "loras/cast-1/r.safetensors",
    });
  });
});
