// Tests for the planner catalog (v0.28.0). Validates that every id in
// PLANNING_MODELS resolves against the full MODELS catalog and that the
// catalog spans all three dispatch paths the planner supports.

import { describe, it, expect } from "vitest";
import { MODELS } from "../src/models";
import {
  PLANNING_MODELS,
  findPlanningModel,
  plannerProviderFor,
} from "../src/planner-catalog";

describe("PLANNING_MODELS", () => {
  it("is non-empty", () => {
    expect(PLANNING_MODELS.length).toBeGreaterThan(0);
  });

  it("contains only chat models", () => {
    for (const m of PLANNING_MODELS) {
      expect(m.type).toBe("chat");
    }
  });

  it("every catalog entry resolves to an existing MODELS row (no dangling ids)", () => {
    const allIds = new Set(MODELS.map((m) => m.id));
    for (const m of PLANNING_MODELS) {
      expect(allIds.has(m.id)).toBe(true);
    }
  });

  it("contains at least one Anthropic, one xAI, and one Workers AI row", () => {
    const providers = new Set(PLANNING_MODELS.map((m) => plannerProviderFor(m)));
    expect(providers.has("anthropic")).toBe(true);
    expect(providers.has("xai")).toBe(true);
    expect(providers.has("workers-ai")).toBe(true);
  });

  it("contains no duplicate ids", () => {
    const ids = PLANNING_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("findPlanningModel", () => {
  it("returns the entry for a known catalog id", () => {
    const m = findPlanningModel("anthropic/claude-opus-4-7");
    expect(m?.id).toBe("anthropic/claude-opus-4-7");
  });

  it("returns undefined for an id outside the catalog", () => {
    expect(findPlanningModel("not/in/catalog")).toBeUndefined();
  });

  it("returns undefined for a MODELS id that is not in the planner subset", () => {
    // Pick any MODELS entry that is not in PLANNING_MODELS, to verify the
    // catalog is a real subset rather than an alias.
    const planningIds = new Set(PLANNING_MODELS.map((m) => m.id));
    const outsider = MODELS.find((m) => !planningIds.has(m.id));
    if (outsider) {
      expect(findPlanningModel(outsider.id)).toBeUndefined();
    }
  });
});

describe("plannerProviderFor", () => {
  it("maps anthropic provider rows to 'anthropic'", () => {
    const m = PLANNING_MODELS.find((x) => x.provider === "anthropic");
    expect(m).toBeDefined();
    if (m) expect(plannerProviderFor(m)).toBe("anthropic");
  });

  it("maps xai provider rows to 'xai'", () => {
    const m = PLANNING_MODELS.find((x) => x.provider === "xai");
    expect(m).toBeDefined();
    if (m) expect(plannerProviderFor(m)).toBe("xai");
  });

  it("maps Workers AI rows (no explicit provider) to 'workers-ai'", () => {
    const m = PLANNING_MODELS.find((x) => !x.provider);
    expect(m).toBeDefined();
    if (m) expect(plannerProviderFor(m)).toBe("workers-ai");
  });
});
