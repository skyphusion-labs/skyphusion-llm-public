// Storyboard bundle assembler (v0.31.0).
//
// Takes a validated storyboard + per-slot character refs (either R2 keys
// or inline data URLs) and produces the .tar.gz the vivijure-serverless
// GPU worker pulls via r2_io.download_and_extract().
//
// Bundle layout (mirrors what characters.py and orchestrator.py expect):
//
//   storyboard.yaml                           film board (serializeStoryboardYaml)
//   characters/registry.json                  per-slot {name, prompt, image}
//   characters/char_<SLOT>_<safe-name>.png    canonical portrait
//                                              (registry's `image` field points here;
//                                               characters.slot_image_path convention)
//   characters/refs/<SLOT>/ref_NN.<ext>       training + IP-Adapter refs
//                                              (characters.list_character_references
//                                               globs this dir for the readiness
//                                               check that lora_train fires on)
//   start_image.png                           optional top-level film start;
//                                              auto-bootstrapped by the GPU worker
//                                              if absent
//
// Returns the R2 key at bundles/<projectName>.tar.gz on success.

import type { Env } from "./env";
import {
  validateStoryboard,
  type SlotId,
  type StoryboardValidated,
} from "./storyboard-validate";
import { serializeStoryboardYaml } from "./planner-yaml";
import { emitTar, type TarFile } from "./tar-emit";

// One training image, supplied either as a pre-staged R2 object key
// (preferred for large sets to avoid base64 inflation through the worker
// request body) or as an inline data URL (browser convenience).
export interface TrainingImage {
  key?: string;
  dataUrl?: string;
  // Optional override of the inner filename in characters/refs/<SLOT>/.
  // Default is ref_NN.<detected-ext>.
  filename?: string;
}

export interface CharacterRef {
  name: string;
  prompt: string;
  trainingImages: TrainingImage[];
  // Canonical portrait. Defaults to trainingImages[0] when omitted.
  portrait?: TrainingImage;
}

export interface AssembleBundleArgs {
  storyboard: StoryboardValidated;
  characterRefs: Partial<Record<SlotId, CharacterRef>>;
  startImage?: TrainingImage;
}

export type AssembleBundleResult =
  | {
      ok: true;
      bundleKey: string;
      sizeBytes: number;
      fileCount: number;
    }
  | {
      ok: false;
      errors: string[];
    };

// Mirrors characters.slot_image_path's filename convention:
//   safe = name.strip().replace(" ", "_")[:40] or slot
//   "char_<SLOT>_<safe>.png"
// We use literal-space replacement (not \s+) so multi-space names match
// the Python str.replace(" ", "_") behavior byte-for-byte.
export function safeCharFilename(slot: SlotId, name: string): string {
  const trimmed = name.trim();
  const safe = trimmed.replace(/ /g, "_").slice(0, 40) || slot;
  return `char_${slot}_${safe}.png`;
}

// Sniff the image format from the first few bytes so the inner filename
// inside the tarball gets the right extension. The GPU side's
// list_character_references globs *.png, *.jpg, *.jpeg, *.webp; falling
// back to .png on an unrecognized signature is safe (the file is still
// readable by PIL, which the GPU side uses).
export function detectImageExt(bytes: Uint8Array): "png" | "jpg" | "webp" {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "webp";
  }
  return "png";
}

// Decode a "data:<mime>;base64,<...>" URL to raw bytes. Returns null if
// the URL is malformed or the base64 fails to decode.
export function decodeDataUrl(dataUrl: string): Uint8Array | null {
  const m = dataUrl.match(/^data:([\w./+-]+);base64,(.+)$/);
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function resolveImage(
  env: Env,
  img: TrainingImage,
  label: string,
): Promise<{ bytes: Uint8Array; ext: "png" | "jpg" | "webp" } | { error: string }> {
  if (img.dataUrl) {
    const bytes = decodeDataUrl(img.dataUrl);
    if (!bytes) return { error: `${label}: invalid data URL` };
    return { bytes, ext: detectImageExt(bytes) };
  }
  if (img.key) {
    // v0.39.1: staged character refs live in R2_RENDERS (the bucket the
    // GPU worker also reads + writes); this used to read env.R2 and miss
    // refs uploaded via the new /api/storyboard/character-ref path.
    const obj = await env.R2_RENDERS.get(img.key);
    if (!obj) return { error: `${label}: R2 object not found at key "${img.key}"` };
    const bytes = new Uint8Array(await obj.arrayBuffer());
    return { bytes, ext: detectImageExt(bytes) };
  }
  return { error: `${label}: must provide either { key } or { dataUrl }` };
}

// Stream a single Uint8Array through CompressionStream("gzip"). Workers
// expose this as a global; Node 18+ does too, which is what vitest runs
// the test pool under. No external dep, no codegen.
async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  // Fire-and-forget the write so the writer's close() can flush regardless
  // of the reader's pace. Errors propagate via the reader chain.
  void writer.write(bytes).then(() => writer.close());
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function assembleBundle(
  env: Env,
  args: AssembleBundleArgs,
): Promise<AssembleBundleResult> {
  // Defensive re-validation. The caller may have skipped validateStoryboard
  // or the storyboard could have been edited between plan and bundle. We
  // accept the cost of re-running because validation is cheap and lets the
  // assembler refuse a board that would crash the GPU worker mid-render.
  const validation = validateStoryboard(args.storyboard);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors.map((e) => `storyboard: ${e}`) };
  }
  const storyboard = validation.value;
  const errors: string[] = [];
  const files: TarFile[] = [];

  // storyboard.yaml at top level.
  files.push({
    name: "storyboard.yaml",
    content: new TextEncoder().encode(serializeStoryboardYaml(storyboard)),
  });

  // Per-slot files + registry entries. Walk use_characters in the storyboard
  // (not Object.keys(characterRefs)) so a stray extra slot in characterRefs
  // does not end up in the registry, and a missing slot in characterRefs
  // surfaces as an error here rather than silently shipping an unloaded
  // slot to the GPU worker.
  const registryCharacters: Record<string, unknown> = {};
  for (const slot of storyboard.use_characters) {
    const ref = args.characterRefs[slot];
    if (!ref) {
      errors.push(
        `characterRefs missing entry for slot "${slot}" (referenced in storyboard.use_characters)`,
      );
      continue;
    }
    if (!ref.name || ref.name.trim().length === 0) {
      errors.push(`characterRefs[${slot}].name is required (non-empty string)`);
      continue;
    }
    if (!Array.isArray(ref.trainingImages) || ref.trainingImages.length === 0) {
      errors.push(
        `characterRefs[${slot}].trainingImages is required (non-empty array)`,
      );
      continue;
    }

    // Portrait: defaults to trainingImages[0] when omitted, matching how
    // a fresh project bootstrap on the GPU side picks the first ref.
    const portraitSrc = ref.portrait ?? ref.trainingImages[0];
    const portraitResolved = await resolveImage(
      env,
      portraitSrc,
      `characterRefs[${slot}].portrait`,
    );
    if ("error" in portraitResolved) {
      errors.push(portraitResolved.error);
      continue;
    }
    const portraitFilename = safeCharFilename(slot, ref.name);
    files.push({
      name: `characters/${portraitFilename}`,
      content: portraitResolved.bytes,
    });

    // Training refs at characters/refs/<SLOT>/ref_NN.<ext>. Each image's
    // ext is sniffed independently so a mixed PNG/JPEG set comes through
    // intact. The order matches the input order (the GPU side's sorted glob
    // re-orders alphabetically anyway, so ref_01 ... ref_NN is stable).
    for (let i = 0; i < ref.trainingImages.length; i++) {
      const img = ref.trainingImages[i];
      const resolved = await resolveImage(
        env,
        img,
        `characterRefs[${slot}].trainingImages[${i}]`,
      );
      if ("error" in resolved) {
        errors.push(resolved.error);
        continue;
      }
      const num = String(i + 1).padStart(2, "0");
      const innerName = img.filename ?? `ref_${num}.${resolved.ext}`;
      files.push({
        name: `characters/refs/${slot}/${innerName}`,
        content: resolved.bytes,
      });
    }

    registryCharacters[slot] = {
      name: ref.name,
      prompt: ref.prompt ?? "",
      image: `characters/${portraitFilename}`,
    };
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // characters/registry.json. Pretty-printed for human introspection
  // when debugging a bundle; the GPU side's json.load doesn't care.
  files.push({
    name: "characters/registry.json",
    content: new TextEncoder().encode(
      JSON.stringify({ characters: registryCharacters }, null, 2) + "\n",
    ),
  });

  // Optional top-level start_image.png.
  if (args.startImage) {
    const startResolved = await resolveImage(env, args.startImage, "startImage");
    if ("error" in startResolved) {
      return { ok: false, errors: [startResolved.error] };
    }
    files.push({
      name: "start_image.png",
      content: startResolved.bytes,
    });
  }

  // Emit tar, gzip, upload.
  const tarBytes = emitTar(files);
  const gz = await gzipBytes(tarBytes);
  const bundleKey = `bundles/${storyboard.projectName}.tar.gz`;
  // v0.39.1: bundles land in R2_RENDERS so the GPU worker (which reads
  // from its own R2_BUCKET) sees them. Pre-0.39.1 wrote to env.R2 and
  // the GPU could only pull bundles after a manual copy between buckets.
  await env.R2_RENDERS.put(bundleKey, gz, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { source: "skyphusion-planner" },
  });

  return {
    ok: true,
    bundleKey,
    sizeBytes: gz.length,
    fileCount: files.length,
  };
}
