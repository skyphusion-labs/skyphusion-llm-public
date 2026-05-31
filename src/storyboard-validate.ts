// Storyboard input validator for the planning Worker (v0.27.0).
//
// Pure, synchronous, no I/O. Validates the structural shape of a planner
// output before it is serialized to storyboard.yaml and bundled for the
// vivijure-serverless GPU worker. Slot readiness (registry prompt plus
// >=8 reference images on disk) is checked separately as a pre-flight
// against R2; this validator does not touch the filesystem or network.
//
// Schema source of truth: vivijure-serverless/build/vivijure-src/
// storyboard.example.yaml, plus what orchestrator.build_render_payload
// and core.build_manifest in that repo actually consume. Slot IDs
// ("A", "B", "C", "D") mirror characters.SLOTS in the same repo.
// normalizeProjectName mirrors studio_service.norm_project.
//
// Minimal-dep convention (matches src/env.ts, src/longrun-params.ts):
// hand-authored interfaces, no zod / ajv at runtime, no codegen.

export type SlotId = "A" | "B" | "C" | "D";
export const SLOT_IDS: readonly SlotId[] = ["A", "B", "C", "D"] as const;

const SLOT_SET: ReadonlySet<string> = new Set(SLOT_IDS);

// One entry per shot. Only `prompt` is required; the rest flow through
// to core.build_manifest's per-scene reader unchanged.
export interface StoryboardScene {
  id?: string;
  prompt: string;
  character_slots?: SlotId[];
  start?: number;
  end?: number;
  target_seconds?: number;
  act?: string;
  start_image?: string;
}

// Top-level storyboard. Mirrors storyboard.example.yaml. The serverless
// worker does not consume any key not listed here, so this is the full
// authored surface.
export interface StoryboardInput {
  title: string;
  full_prompt?: string;
  duration_seconds?: number;
  clip_seconds?: number;
  style_prefix?: string;
  style_category?: string | null;
  style_preset?: string | null;
  use_characters?: SlotId[];
  cast_rules?: string;
  refs_dir?: string;
  scenes: StoryboardScene[];
}

// Normalized form returned on success. style_category / style_preset are
// forced to the literal string "None" when missing, null, or empty after
// trim (the renderer disables on the string, not on null). projectName
// is the studio_service.norm_project equivalent; safe to use as a
// directory or R2 key segment.
export interface StoryboardValidated {
  title: string;
  projectName: string;
  full_prompt: string;
  duration_seconds: number | undefined;
  clip_seconds: number | undefined;
  style_prefix: string;
  style_category: string;
  style_preset: string;
  use_characters: SlotId[];
  cast_rules: string;
  refs_dir?: string;
  scenes: StoryboardScene[];
}

export type ValidationResult =
  | { ok: true; value: StoryboardValidated }
  | { ok: false; errors: string[] };

// studio_service.norm_project (vivijure-serverless studio_service.py):
//   return (name or "project").strip().replace(" ", "_") or "project"
// Collapses internal whitespace runs (\s+) rather than only literal
// spaces, since YAML parsers can hand us tabs or other whitespace too.
export function normalizeProjectName(title: string | undefined | null): string {
  const raw = typeof title === "string" ? title : "";
  const slug = raw.trim().replace(/\s+/g, "_");
  return slug || "project";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sceneLabel(scene: Record<string, unknown>, index: number): string {
  const id =
    typeof scene.id === "string" && scene.id.trim().length > 0
      ? scene.id.trim()
      : null;
  return id ? `scenes[${index}] (id="${id}")` : `scenes[${index}]`;
}

// missing / null / empty / whitespace-only collapse to "None" (the literal
// string the renderer treats as "no style lookup"). Non-string types
// silently collapse too; the planner's TypeScript types disallow them at
// authoring time, so reaching this branch at runtime is a programmer
// error worth defending against rather than rejecting.
function normalizeStyleNone(value: unknown): string {
  if (typeof value !== "string") return "None";
  const trimmed = value.trim();
  return trimmed.length === 0 ? "None" : value;
}

export function validateStoryboard(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [
        `storyboard must be an object (got ${describeType(input)})`,
      ],
    };
  }

  // ---- title ------------------------------------------------------------
  let title = "";
  let projectName = "project";
  const rawTitle = input.title;
  if (typeof rawTitle !== "string" || rawTitle.trim().length === 0) {
    errors.push("title is required and must be a non-empty string");
  } else {
    title = rawTitle;
    projectName = normalizeProjectName(rawTitle);
  }

  // ---- use_characters ---------------------------------------------------
  const useCharacters: SlotId[] = [];
  if (input.use_characters !== undefined) {
    if (!Array.isArray(input.use_characters)) {
      errors.push(
        `use_characters must be an array of slot ids if provided (got ${describeType(input.use_characters)})`,
      );
    } else {
      const seen = new Set<string>();
      input.use_characters.forEach((slot, i) => {
        if (typeof slot !== "string") {
          errors.push(
            `use_characters[${i}] must be a string (got ${describeType(slot)})`,
          );
          return;
        }
        if (!SLOT_SET.has(slot)) {
          errors.push(
            `use_characters[${i}] = "${slot}" is not a valid slot id (allowed: ${SLOT_IDS.join(", ")})`,
          );
          return;
        }
        if (seen.has(slot)) {
          errors.push(`use_characters[${i}] = "${slot}" is duplicated`);
          return;
        }
        seen.add(slot);
        useCharacters.push(slot as SlotId);
      });
    }
  }

  // ---- scenes -----------------------------------------------------------
  const validatedScenes: StoryboardScene[] = [];
  if (!Array.isArray(input.scenes)) {
    errors.push(
      `scenes is required and must be a non-empty array (got ${describeType(input.scenes)})`,
    );
  } else if (input.scenes.length === 0) {
    errors.push(
      "scenes is required and must be a non-empty array (got empty array)",
    );
  } else {
    input.scenes.forEach((scene, i) => {
      if (!isPlainObject(scene)) {
        errors.push(
          `scenes[${i}] must be an object (got ${describeType(scene)})`,
        );
        return;
      }
      const label = sceneLabel(scene, i);
      const out: StoryboardScene = { prompt: "" };

      // prompt: required, non-empty after trim
      if (
        typeof scene.prompt !== "string" ||
        scene.prompt.trim().length === 0
      ) {
        errors.push(`${label} is missing prompt (must be a non-empty string)`);
      } else {
        out.prompt = scene.prompt;
      }

      // id: optional string
      if (scene.id !== undefined) {
        if (typeof scene.id !== "string") {
          errors.push(
            `${label} id must be a string if provided (got ${describeType(scene.id)})`,
          );
        } else {
          out.id = scene.id;
        }
      }

      // character_slots: optional array of SlotId, must be subset of useCharacters
      if (scene.character_slots !== undefined) {
        if (!Array.isArray(scene.character_slots)) {
          errors.push(
            `${label} character_slots must be an array if provided (got ${describeType(scene.character_slots)})`,
          );
        } else {
          const slotsOut: SlotId[] = [];
          const seenLocal = new Set<string>();
          scene.character_slots.forEach((slot, j) => {
            if (typeof slot !== "string") {
              errors.push(
                `${label} character_slots[${j}] must be a string (got ${describeType(slot)})`,
              );
              return;
            }
            if (!SLOT_SET.has(slot)) {
              errors.push(
                `${label} character_slots[${j}] = "${slot}" is not a valid slot id (allowed: ${SLOT_IDS.join(", ")})`,
              );
              return;
            }
            if (seenLocal.has(slot)) {
              errors.push(
                `${label} character_slots[${j}] = "${slot}" is duplicated within the scene`,
              );
              return;
            }
            // Subset rule: every per-scene slot must be loaded for the render.
            if (!useCharacters.includes(slot as SlotId)) {
              const loaded =
                useCharacters.length > 0 ? useCharacters.join(", ") : "(none)";
              errors.push(
                `${label} character_slots references slot "${slot}" which is not in use_characters (loaded: ${loaded})`,
              );
              return;
            }
            seenLocal.add(slot);
            slotsOut.push(slot as SlotId);
          });
          out.character_slots = slotsOut;
        }
      }

      // start: optional non-negative number (0.0 is a legal film-time origin)
      if (scene.start !== undefined) {
        if (!isNonNegativeFiniteNumber(scene.start)) {
          errors.push(
            `${label} start must be a non-negative finite number if provided`,
          );
        } else {
          out.start = scene.start;
        }
      }

      // end / target_seconds: optional positive numbers
      for (const key of ["end", "target_seconds"] as const) {
        const v = scene[key];
        if (v !== undefined) {
          if (!isPositiveFiniteNumber(v)) {
            errors.push(
              `${label} ${key} must be a positive finite number if provided`,
            );
          } else {
            out[key] = v;
          }
        }
      }

      // Cross-field: if both start and end are valid, end must be > start.
      if (
        typeof out.start === "number" &&
        typeof out.end === "number" &&
        out.end <= out.start
      ) {
        errors.push(
          `${label} end (${out.end}) must be greater than start (${out.start})`,
        );
      }

      // act / start_image: optional strings
      for (const key of ["act", "start_image"] as const) {
        const v = scene[key];
        if (v !== undefined) {
          if (typeof v !== "string") {
            errors.push(
              `${label} ${key} must be a string if provided (got ${describeType(v)})`,
            );
          } else {
            out[key] = v;
          }
        }
      }

      validatedScenes.push(out);
    });
  }

  // ---- top-level optional fields ---------------------------------------
  let fullPrompt = "";
  if (input.full_prompt !== undefined) {
    if (typeof input.full_prompt !== "string") {
      errors.push(
        `full_prompt must be a string if provided (got ${describeType(input.full_prompt)})`,
      );
    } else {
      fullPrompt = input.full_prompt;
    }
  }

  let stylePrefix = "";
  if (input.style_prefix !== undefined) {
    if (typeof input.style_prefix !== "string") {
      errors.push(
        `style_prefix must be a string if provided (got ${describeType(input.style_prefix)})`,
      );
    } else {
      stylePrefix = input.style_prefix;
    }
  }

  let castRules = "";
  if (input.cast_rules !== undefined) {
    if (typeof input.cast_rules !== "string") {
      errors.push(
        `cast_rules must be a string if provided (got ${describeType(input.cast_rules)})`,
      );
    } else {
      castRules = input.cast_rules;
    }
  }

  let durationSeconds: number | undefined;
  if (input.duration_seconds !== undefined) {
    if (!isPositiveFiniteNumber(input.duration_seconds)) {
      errors.push(
        "duration_seconds must be a positive finite number if provided",
      );
    } else {
      durationSeconds = input.duration_seconds;
    }
  }

  let clipSeconds: number | undefined;
  if (input.clip_seconds !== undefined) {
    if (!isPositiveFiniteNumber(input.clip_seconds)) {
      errors.push(
        "clip_seconds must be a positive finite number if provided",
      );
    } else {
      clipSeconds = input.clip_seconds;
    }
  }

  let refsDir: string | undefined;
  if (input.refs_dir !== undefined) {
    if (
      typeof input.refs_dir !== "string" ||
      input.refs_dir.trim().length === 0
    ) {
      errors.push(
        "refs_dir must be a non-empty string if provided",
      );
    } else {
      refsDir = input.refs_dir;
    }
  }

  // None-normalization for the two style fields. The renderer disables on
  // the literal string "None", not on null/undefined, so we collapse to it.
  const styleCategory = normalizeStyleNone(input.style_category);
  const stylePreset = normalizeStyleNone(input.style_preset);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const value: StoryboardValidated = {
    title,
    projectName,
    full_prompt: fullPrompt,
    duration_seconds: durationSeconds,
    clip_seconds: clipSeconds,
    style_prefix: stylePrefix,
    style_category: styleCategory,
    style_preset: stylePreset,
    use_characters: useCharacters,
    cast_rules: castRules,
    scenes: validatedScenes,
  };
  if (refsDir !== undefined) value.refs_dir = refsDir;
  return { ok: true, value };
}
