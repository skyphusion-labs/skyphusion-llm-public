// Tests for buildPlanningSystemPrompt / buildPlanningUserMessage /
// stripJsonFences (v0.28.0). Pure string functions, no env / fetch.

import { describe, it, expect } from "vitest";
import {
  buildPlanningSystemPrompt,
  buildPlanningUserMessage,
  stripJsonFences,
} from "../src/planner-prompt";

describe("buildPlanningSystemPrompt", () => {
  const prompt = buildPlanningSystemPrompt();

  it("returns a non-trivial string", () => {
    expect(prompt.length).toBeGreaterThan(500);
  });

  it("names every top-level schema field", () => {
    for (const field of [
      "title",
      "full_prompt",
      "duration_seconds",
      "clip_seconds",
      "style_prefix",
      "style_category",
      "style_preset",
      "use_characters",
      "cast_rules",
      "scenes",
    ]) {
      expect(prompt).toContain(field);
    }
  });

  it("names every per-scene field", () => {
    for (const field of [
      "prompt",
      "character_slots",
      "act",
      "start",
      "end",
      "target_seconds",
    ]) {
      expect(prompt).toContain(field);
    }
  });

  it("documents the slot id enum verbatim", () => {
    expect(prompt).toContain(`"A"`);
    expect(prompt).toContain(`"B"`);
    expect(prompt).toContain(`"C"`);
    expect(prompt).toContain(`"D"`);
  });

  it("includes the literal 'None' rule for style fields", () => {
    expect(prompt).toContain(`"None"`);
    expect(prompt).toMatch(/never null/i);
    expect(prompt).toMatch(/never empty string/i);
  });

  it("includes the style_prefix once-only rule", () => {
    expect(prompt).toMatch(/style_prefix is the ONLY place/i);
    expect(prompt).toMatch(/prepended to every scene/i);
  });

  it("forbids markdown, YAML, and code fences in the output", () => {
    expect(prompt).toMatch(/No markdown/i);
    expect(prompt).toMatch(/No YAML/i);
    expect(prompt).toMatch(/code fences/i);
  });

  it("includes the character_slots subset rule", () => {
    expect(prompt).toMatch(/character_slots/i);
    expect(prompt).toMatch(/must appear in the top-level\s+use_characters/i);
  });

  it("includes the scenes-required rule", () => {
    expect(prompt).toMatch(/scenes:\s*REQUIRED/i);
  });

  it("ends with the 'return ONLY the JSON object' instruction", () => {
    expect(prompt.trimEnd()).toMatch(
      /Return ONLY the JSON object\. Nothing before it\. Nothing after it\.$/,
    );
  });
});

describe("buildPlanningUserMessage", () => {
  it("includes the brief verbatim", () => {
    const message = buildPlanningUserMessage(
      "A two-minute vignette set on a hilltop at dawn.",
      [],
    );
    expect(message).toContain("A two-minute vignette set on a hilltop at dawn.");
  });

  it("emits '(none)' when the cast is empty", () => {
    const message = buildPlanningUserMessage("brief", []);
    expect(message).toMatch(/CAST LOADED FOR THIS RENDER:\n\(none\)/);
  });

  it("lists characters in slot order regardless of input order", () => {
    const message = buildPlanningUserMessage("brief", [
      { slot: "C", name: "Mara", bible: "tall, silver hair" },
      { slot: "A", name: "Kira", bible: "short, blue hair" },
      { slot: "B", name: "Rin", bible: "freckles, red coat" },
    ]);
    const aIdx = message.indexOf("A) Kira");
    const bIdx = message.indexOf("B) Rin");
    const cIdx = message.indexOf("C) Mara");
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(bIdx);
  });

  it("formats each character as 'Slot) Name: bible'", () => {
    const message = buildPlanningUserMessage("brief", [
      { slot: "A", name: "Kira", bible: "short, blue hair, leather jacket" },
    ]);
    expect(message).toContain(
      "A) Kira: short, blue hair, leather jacket",
    );
  });

  it("trims leading and trailing whitespace from the brief", () => {
    const message = buildPlanningUserMessage(
      "   brief with padding   \n",
      [],
    );
    expect(message).toContain("BRIEF:\nbrief with padding\n");
  });

  it("ends with the explicit return-JSON instruction", () => {
    const message = buildPlanningUserMessage("brief", []);
    expect(message).toMatch(/Plan the storyboard and return the JSON now\.$/);
  });
});

describe("stripJsonFences", () => {
  it("returns bare JSON unchanged", () => {
    const raw = `{"title":"x"}`;
    expect(stripJsonFences(raw)).toBe(`{"title":"x"}`);
  });

  it("strips ```json ... ``` fences", () => {
    const raw = '```json\n{"title":"x"}\n```';
    expect(stripJsonFences(raw)).toBe(`{"title":"x"}`);
  });

  it("strips bare ``` ... ``` fences", () => {
    const raw = '```\n{"title":"x"}\n```';
    expect(stripJsonFences(raw)).toBe(`{"title":"x"}`);
  });

  it("strips prose before a fence", () => {
    const raw = 'Here you go:\n```json\n{"title":"x"}\n```';
    expect(stripJsonFences(raw)).toBe(`{"title":"x"}`);
  });

  it("strips prose after a fence", () => {
    const raw =
      '```json\n{"title":"x"}\n```\nLet me know if you need changes.';
    expect(stripJsonFences(raw)).toBe(`{"title":"x"}`);
  });

  it("slices to the first { and last } when no fences are present", () => {
    const raw = 'Sure! Here you go:\n{"title":"x"}\nThanks!';
    expect(stripJsonFences(raw)).toBe(`{"title":"x"}`);
  });

  it("preserves nested objects and arrays", () => {
    const raw = `{"title":"x","scenes":[{"prompt":"a"},{"prompt":"b"}]}`;
    expect(stripJsonFences(raw)).toBe(raw);
  });

  it("returns the input unchanged when no JSON-looking content is found", () => {
    const raw = "I cannot help with that.";
    expect(stripJsonFences(raw)).toBe("I cannot help with that.");
  });

  it("trims leading and trailing whitespace from the result", () => {
    const raw = `   \n  {"title":"x"}   \n`;
    expect(stripJsonFences(raw)).toBe(`{"title":"x"}`);
  });

  it("prefers the LAST fence when multiple are present (model gave an example before the final answer)", () => {
    const raw =
      'Example:\n```json\n{"example":true}\n```\n\nActual:\n```json\n{"title":"real"}\n```';
    expect(stripJsonFences(raw)).toBe(`{"title":"real"}`);
  });
});
