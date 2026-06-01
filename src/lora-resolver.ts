// LoRA binding resolver (v0.58.0).
//
// The planner/UI sends a {slot: cast_id} map on render+finalize submit. The
// route loads each referenced cast_members row (scoped to the caller via the
// same getCastById ownership check used everywhere else) and this helper
// reduces the loaded set to the {slot: lora_key} shape the vivijure-
// serverless `pretrained_loras` field on the wire expects.
//
// Kept pure (no env, no DB, no cloudflare:workers import) so it can be
// vitest-covered in the node pool. The route handler is responsible for
// loading rows and for the not-owned 404 semantics; we just filter and
// reshape what was loaded.

import type { CastMember } from "./cast-db";

// Caller-facing input. Slots are single uppercase letters on the wire
// (A..Z); cast ids are positive integers. The map may be empty / undefined.
export type CastLoraBindings = Record<string, number>;

// What the GPU side reads. Slots preserved verbatim, values are R2 keys
// that MUST start with "loras/" (validated on the worker side).
export type PretrainedLorasMap = Record<string, string>;

export interface ResolveResult {
  pretrained: PretrainedLorasMap;
  // Diagnostics: slots that were dropped and why. The route surfaces these
  // in the response so the UI can warn "skipped slot B (not ready)" instead
  // of silently rendering Stage 1 for it.
  skipped: Array<{ slot: string; cast_id: number; reason: SkipReason }>;
}

export type SkipReason =
  | "not_found"
  | "not_ready"
  | "no_lora_key"
  | "invalid_slot"
  | "invalid_cast_id";

const SLOT_RE = /^[A-Z]$/;

// Reshape loaded cast rows into the wire-format pretrained_loras map.
//
// - `bindings` is the caller's {slot: cast_id} map (already validated for
//   shape at the route boundary; this helper double-checks individual
//   entries for robustness)
// - `loadedCast` is a Map<cast_id, CastMember | null> the route built by
//   awaiting getCastById for each unique id; null entries here represent
//   "not found OR not owned by the caller" (the route does not distinguish
//   for security, and neither do we)
//
// A slot is included on the wire only when ALL of:
//   - the slot is a single uppercase letter A..Z (case-normalized first)
//   - the cast_id is a positive integer
//   - the loaded row exists (not null)
//   - lora_status === "ready"
//   - lora_key is a non-empty string starting with "loras/"
//
// Everything else lands in `skipped` with a categorical reason.
export function resolveCastLoraBindings(
  bindings: CastLoraBindings | undefined | null,
  loadedCast: Map<number, CastMember | null>,
): ResolveResult {
  const pretrained: PretrainedLorasMap = {};
  const skipped: ResolveResult["skipped"] = [];
  if (!bindings || typeof bindings !== "object") {
    return { pretrained, skipped };
  }
  for (const [slotRaw, castIdRaw] of Object.entries(bindings)) {
    const slot = typeof slotRaw === "string" ? slotRaw.toUpperCase() : "";
    if (!SLOT_RE.test(slot)) {
      skipped.push({
        slot: typeof slotRaw === "string" ? slotRaw : String(slotRaw),
        cast_id: typeof castIdRaw === "number" ? castIdRaw : 0,
        reason: "invalid_slot",
      });
      continue;
    }
    if (typeof castIdRaw !== "number" || !Number.isInteger(castIdRaw) || castIdRaw <= 0) {
      skipped.push({ slot, cast_id: 0, reason: "invalid_cast_id" });
      continue;
    }
    const cast = loadedCast.get(castIdRaw);
    if (!cast) {
      skipped.push({ slot, cast_id: castIdRaw, reason: "not_found" });
      continue;
    }
    if (cast.lora_status !== "ready") {
      skipped.push({ slot, cast_id: castIdRaw, reason: "not_ready" });
      continue;
    }
    if (typeof cast.lora_key !== "string" || !cast.lora_key.startsWith("loras/")) {
      skipped.push({ slot, cast_id: castIdRaw, reason: "no_lora_key" });
      continue;
    }
    // Last-write-wins on slot collision (two bindings to the same letter
    // is a client bug; the typed input shape already rules it out, but
    // Object.entries iteration order is well-defined so the result is
    // at least deterministic).
    pretrained[slot] = cast.lora_key;
  }
  return { pretrained, skipped };
}

// Helper for the route: extract the unique cast ids it needs to load. Useful
// so the route can do one Promise.all over getCastById instead of looping.
export function uniqueCastIds(bindings: CastLoraBindings | undefined | null): number[] {
  if (!bindings || typeof bindings !== "object") return [];
  const seen = new Set<number>();
  for (const v of Object.values(bindings)) {
    if (typeof v === "number" && Number.isInteger(v) && v > 0) seen.add(v);
  }
  return [...seen];
}
