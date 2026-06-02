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

  // v0.89.0: Conrad asked specifically for Kimi, Llama 4 Scout, Gemma 4,
  // and Qwen in the planner picker. Pin them as a regression net so a
  // future curation pass cannot silently drop any of them.
  it("includes Kimi K2.6", () => {
    expect(PLANNING_MODELS.some((m) => m.id === "@cf/moonshotai/kimi-k2.6")).toBe(true);
  });

  it("includes Llama 4 Scout", () => {
    expect(PLANNING_MODELS.some((m) => m.id === "@cf/meta/llama-4-scout-17b-16e-instruct")).toBe(true);
  });

  it("includes Gemma 4 26B", () => {
    expect(PLANNING_MODELS.some((m) => m.id === "@cf/google/gemma-4-26b-a4b-it")).toBe(true);
  });

  it("includes Qwen3 30B MoE", () => {
    expect(PLANNING_MODELS.some((m) => m.id === "@cf/qwen/qwen3-30b-a3b-fp8")).toBe(true);
  });

  // v0.94.0: Conrad asked to add the frontier hosted flagships (Opus 4.8,
  // GPT-5.5, Gemini 3.1 Pro) and to drop the Grok Build coding model. Pin
  // them so a future curation pass cannot silently regress the decision.
  it("includes Claude Opus 4.8", () => {
    expect(PLANNING_MODELS.some((m) => m.id === "anthropic/claude-opus-4-8")).toBe(true);
  });

  it("includes GPT-5.5", () => {
    expect(PLANNING_MODELS.some((m) => m.id === "openai/gpt-5.5")).toBe(true);
  });

  it("includes Gemini 3.1 Pro", () => {
    expect(PLANNING_MODELS.some((m) => m.id === "google/gemini-3.1-pro")).toBe(true);
  });

  it("excludes the Grok Build coding model", () => {
    expect(PLANNING_MODELS.some((m) => m.id === "xai/grok-build-0.1")).toBe(false);
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

  it("maps google provider rows to 'google'", () => {
    const m = PLANNING_MODELS.find((x) => x.provider === "google");
    expect(m).toBeDefined();
    if (m) expect(plannerProviderFor(m)).toBe("google");
  });

  it("maps openai provider rows to 'workers-ai' (they ride aiRun)", () => {
    const m = PLANNING_MODELS.find((x) => x.provider === "openai");
    expect(m).toBeDefined();
    if (m) expect(plannerProviderFor(m)).toBe("workers-ai");
  });
});
