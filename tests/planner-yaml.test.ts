// Tests for serializeStoryboardYaml (v0.28.0). Pure emitter, no I/O.

import { describe, it, expect } from "vitest";
import { serializeStoryboardYaml } from "../src/planner-yaml";
import type { StoryboardValidated } from "../src/storyboard-validate";

function minimal(): StoryboardValidated {
  return {
    title: "cherry",
    projectName: "cherry",
    full_prompt: "",
    duration_seconds: undefined,
    clip_seconds: undefined,
    style_prefix: "",
    style_category: "None",
    style_preset: "None",
    use_characters: [],
    cast_rules: "",
    scenes: [{ prompt: "Wide hilltop." }],
  };
}

describe("serializeStoryboardYaml", () => {
  it("emits a minimal storyboard with all required keys present", () => {
    const yaml = serializeStoryboardYaml(minimal());
    expect(yaml).toContain('title: "cherry"');
    expect(yaml).toContain('full_prompt: ""');
    expect(yaml).toContain('style_prefix: ""');
    expect(yaml).toContain('style_category: "None"');
    expect(yaml).toContain('style_preset: "None"');
    expect(yaml).toContain("use_characters: []");
    expect(yaml).toContain('cast_rules: ""');
    expect(yaml).toContain("scenes:");
    expect(yaml).toContain('  - prompt: "Wide hilltop."');
  });

  it("emits the full storyboard.example.yaml shape", () => {
    const board: StoryboardValidated = {
      title: "cherry",
      projectName: "cherry",
      full_prompt: "Three-shot vignette.",
      duration_seconds: 22,
      clip_seconds: 7,
      style_prefix: "cinematic 35mm film",
      style_category: "Anime",
      style_preset: "None",
      use_characters: ["A"],
      cast_rules: "",
      scenes: [
        {
          id: "shot_01",
          prompt: "Wide hilltop at dawn.",
          character_slots: ["A"],
          act: "opening",
          start: 0,
          end: 7,
          target_seconds: 7,
        },
      ],
    };
    const yaml = serializeStoryboardYaml(board);
    expect(yaml).toContain('title: "cherry"');
    expect(yaml).toContain('full_prompt: "Three-shot vignette."');
    expect(yaml).toContain("duration_seconds: 22");
    expect(yaml).toContain("clip_seconds: 7");
    expect(yaml).toContain('style_prefix: "cinematic 35mm film"');
    expect(yaml).toContain('style_category: "Anime"');
    expect(yaml).toContain("use_characters: [A]");
    expect(yaml).toContain('  - prompt: "Wide hilltop at dawn."');
    expect(yaml).toContain('    id: "shot_01"');
    expect(yaml).toContain("    character_slots: [A]");
    expect(yaml).toContain('    act: "opening"');
    expect(yaml).toContain("    start: 0");
    expect(yaml).toContain("    end: 7");
    expect(yaml).toContain("    target_seconds: 7");
  });

  it("preserves the literal 'None' string for style_category / style_preset", () => {
    const yaml = serializeStoryboardYaml(minimal());
    expect(yaml).toContain('style_category: "None"');
    expect(yaml).toContain('style_preset: "None"');
    expect(yaml).not.toContain("style_category: null");
    expect(yaml).not.toContain("style_preset: null");
  });

  it("escapes double quotes inside string values", () => {
    const board = minimal();
    board.scenes[0].prompt = `She says "hello"`;
    const yaml = serializeStoryboardYaml(board);
    expect(yaml).toContain('- prompt: "She says \\"hello\\""');
  });

  it("escapes backslashes inside string values", () => {
    const board = minimal();
    board.scenes[0].prompt = "Path C:\\Users\\test";
    const yaml = serializeStoryboardYaml(board);
    expect(yaml).toContain(`- prompt: "Path C:\\\\Users\\\\test"`);
  });

  it("escapes newlines inside string values", () => {
    const board = minimal();
    board.scenes[0].prompt = "Line one\nLine two";
    const yaml = serializeStoryboardYaml(board);
    expect(yaml).toContain('- prompt: "Line one\\nLine two"');
  });

  it("quotes strings that contain colons (no bare unquoted scalars)", () => {
    const board = minimal();
    board.scenes[0].prompt = "Featuring: Kira: protagonist";
    const yaml = serializeStoryboardYaml(board);
    expect(yaml).toContain('- prompt: "Featuring: Kira: protagonist"');
  });

  it("emits use_characters as a flow-style sequence", () => {
    const board = minimal();
    board.use_characters = ["A", "B", "C"];
    const yaml = serializeStoryboardYaml(board);
    expect(yaml).toContain("use_characters: [A, B, C]");
  });

  it("emits empty use_characters as []", () => {
    const yaml = serializeStoryboardYaml(minimal());
    expect(yaml).toContain("use_characters: []");
  });

  it("omits duration_seconds and clip_seconds when undefined", () => {
    const yaml = serializeStoryboardYaml(minimal());
    expect(yaml).not.toMatch(/^duration_seconds:/m);
    expect(yaml).not.toMatch(/^clip_seconds:/m);
  });

  it("emits duration_seconds and clip_seconds when defined (positive numbers, no units)", () => {
    const board = minimal();
    board.duration_seconds = 22;
    board.clip_seconds = 7.5;
    const yaml = serializeStoryboardYaml(board);
    expect(yaml).toContain("duration_seconds: 22");
    expect(yaml).toContain("clip_seconds: 7.5");
    expect(yaml).not.toContain('duration_seconds: "22"');
  });

  it("omits refs_dir when undefined", () => {
    const yaml = serializeStoryboardYaml(minimal());
    expect(yaml).not.toContain("refs_dir:");
  });

  it("emits refs_dir when defined", () => {
    const board = minimal();
    board.refs_dir = "refs";
    const yaml = serializeStoryboardYaml(board);
    expect(yaml).toContain('refs_dir: "refs"');
  });

  it("emits scene optional fields only when defined", () => {
    const board = minimal();
    board.scenes = [
      {
        prompt: "Bare scene.",
      },
      {
        id: "shot_02",
        prompt: "Scene with id only.",
      },
    ];
    const yaml = serializeStoryboardYaml(board);
    // First scene: no id, no character_slots, no act, etc.
    const firstSceneBlock = yaml.split("scenes:\n")[1].split("  - prompt: \"Scene with id only.\"")[0];
    expect(firstSceneBlock).not.toContain("id:");
    expect(firstSceneBlock).not.toContain("character_slots:");
    expect(firstSceneBlock).not.toContain("act:");
    // Second scene has id only.
    expect(yaml).toContain('    id: "shot_02"');
  });

  it("emits multiple scenes in order", () => {
    const board = minimal();
    board.scenes = [
      { prompt: "First." },
      { prompt: "Second." },
      { prompt: "Third." },
    ];
    const yaml = serializeStoryboardYaml(board);
    const firstIdx = yaml.indexOf('- prompt: "First."');
    const secondIdx = yaml.indexOf('- prompt: "Second."');
    const thirdIdx = yaml.indexOf('- prompt: "Third."');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });

  it("ends with a trailing newline", () => {
    expect(serializeStoryboardYaml(minimal()).endsWith("\n")).toBe(true);
  });

  it("does not emit the internal projectName field (planner-only, not in storyboard.yaml)", () => {
    const board = minimal();
    board.projectName = "cherry_project";
    const yaml = serializeStoryboardYaml(board);
    expect(yaml).not.toContain("projectName:");
    expect(yaml).not.toContain("project_name:");
  });
});
