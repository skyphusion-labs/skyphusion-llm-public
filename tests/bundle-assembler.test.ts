// Tests for the bundle assembler (v0.31.0). Covers the pure helpers
// (safeCharFilename, detectImageExt, decodeDataUrl) and the dispatcher's
// pipeline using a stubbed env.R2 (in-memory Map). Bundles round-trip
// through gzip + tar back to the original file list to confirm the GPU
// worker's Python tarfile will read it.

import { describe, it, expect } from "vitest";
import { gunzipSync } from "node:zlib";
import {
  assembleBundle,
  safeCharFilename,
  detectImageExt,
  decodeDataUrl,
  type CharacterRef,
  type TrainingImage,
} from "../src/bundle-assembler";
import type { Env } from "../src/env";
import type { StoryboardValidated } from "../src/storyboard-validate";

// ---------- Test fixtures ----------

function pngBytes(): Uint8Array {
  // 8-byte PNG signature + IHDR-ish bytes. Doesn't need to be a real
  // image - the assembler only sniffs the first 4 bytes for the magic.
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    // IHDR length + chunk
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00,
  ]);
}

function jpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}

function webpBytes(): Uint8Array {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    0x00, 0x00, 0x00, 0x00, // size (zero is fine for the sniff)
    0x57, 0x45, 0x42, 0x50, // "WEBP"
  ]);
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function pngDataUrl(): string {
  return "data:image/png;base64," + b64(pngBytes());
}

function minimalSb(use: Array<"A" | "B" | "C" | "D"> = []): StoryboardValidated {
  return {
    title: "cherry",
    projectName: "cherry",
    full_prompt: "",
    duration_seconds: undefined,
    clip_seconds: undefined,
    style_prefix: "",
    style_category: "None",
    style_preset: "None",
    use_characters: use,
    cast_rules: "",
    scenes: [{ prompt: "Wide hilltop." }],
  };
}

function trainingImages(n: number): TrainingImage[] {
  return Array.from({ length: n }, () => ({ dataUrl: pngDataUrl() }));
}

function ref(name: string, prompt: string, n = 8): CharacterRef {
  return { name, prompt, trainingImages: trainingImages(n) };
}

// In-memory R2 stub. Implements the subset of R2Bucket the assembler uses.
// v0.39.1: assembler now reads staged refs from env.R2_RENDERS and writes
// bundles to env.R2_RENDERS too. Stub only that binding; env.R2 stays
// undefined so a regression that re-introduces an env.R2 call here would
// blow up immediately with a clear error.
function makeStubEnv() {
  const refs = new Map<string, Uint8Array>();
  const bundles = new Map<string, { bytes: Uint8Array; mime: string }>();
  const bucket = {
    get: async (key: string) => {
      const bytes = refs.get(key);
      if (!bytes) return null;
      return {
        arrayBuffer: async () => {
          const buf = new ArrayBuffer(bytes.length);
          new Uint8Array(buf).set(bytes);
          return buf;
        },
      };
    },
    put: async (
      key: string,
      value: Uint8Array | ArrayBuffer | string,
      opts?: { httpMetadata?: { contentType?: string } },
    ) => {
      const bytes =
        value instanceof Uint8Array
          ? value
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new TextEncoder().encode(value as string);
      bundles.set(key, { bytes, mime: opts?.httpMetadata?.contentType ?? "" });
      return { key };
    },
  };
  const env = { R2_RENDERS: bucket } as unknown as Env;
  return { env, refs, bundles };
}

// Read filenames out of an unpacked tar (we gunzip first, then walk
// 512-byte blocks). Used to verify the in-bundle layout.
function listTarNames(tarBytes: Uint8Array): string[] {
  const names: string[] = [];
  let offset = 0;
  const BLOCK = 512;
  while (offset + BLOCK <= tarBytes.length) {
    let allZero = true;
    for (let i = 0; i < BLOCK; i++) {
      if (tarBytes[offset + i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;
    let end = offset;
    while (end < offset + 100 && tarBytes[end] !== 0) end++;
    names.push(new TextDecoder().decode(tarBytes.slice(offset, end)));
    const sizeStr = new TextDecoder()
      .decode(tarBytes.slice(offset + 124, offset + 124 + 12))
      .replace(/\0.*$/, "")
      .trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return names;
}

function readTarFile(tarBytes: Uint8Array, name: string): Uint8Array | null {
  let offset = 0;
  const BLOCK = 512;
  while (offset + BLOCK <= tarBytes.length) {
    let allZero = true;
    for (let i = 0; i < BLOCK; i++) {
      if (tarBytes[offset + i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;
    let end = offset;
    while (end < offset + 100 && tarBytes[end] !== 0) end++;
    const entryName = new TextDecoder().decode(tarBytes.slice(offset, end));
    const sizeStr = new TextDecoder()
      .decode(tarBytes.slice(offset + 124, offset + 124 + 12))
      .replace(/\0.*$/, "")
      .trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    if (entryName === name) {
      return tarBytes.slice(offset + BLOCK, offset + BLOCK + size);
    }
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return null;
}

// ---------- Pure helpers ----------

describe("safeCharFilename", () => {
  it("replaces single spaces with underscores", () => {
    expect(safeCharFilename("A", "Kira Smith")).toBe("char_A_Kira_Smith.png");
  });

  it("trims leading and trailing whitespace", () => {
    expect(safeCharFilename("A", "  Kira  ")).toBe("char_A_Kira.png");
  });

  it("matches Python str.replace(' ', '_') for runs of spaces", () => {
    // Python preserves each space as a separate underscore; we do too.
    expect(safeCharFilename("A", "Kira  Smith")).toBe("char_A_Kira__Smith.png");
  });

  it("falls back to the slot when the name is empty", () => {
    expect(safeCharFilename("A", "")).toBe("char_A_A.png");
    expect(safeCharFilename("B", "   ")).toBe("char_B_B.png");
  });

  it("truncates safe names to 40 characters", () => {
    const long = "x".repeat(60);
    const result = safeCharFilename("A", long);
    expect(result).toBe("char_A_" + "x".repeat(40) + ".png");
  });
});

describe("detectImageExt", () => {
  it("detects PNG by signature", () => {
    expect(detectImageExt(pngBytes())).toBe("png");
  });

  it("detects JPEG by signature", () => {
    expect(detectImageExt(jpegBytes())).toBe("jpg");
  });

  it("detects WEBP by RIFF + WEBP", () => {
    expect(detectImageExt(webpBytes())).toBe("webp");
  });

  it("falls back to png on unknown bytes", () => {
    expect(detectImageExt(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))).toBe("png");
  });
});

describe("decodeDataUrl", () => {
  it("decodes a valid PNG data URL", () => {
    const decoded = decodeDataUrl(pngDataUrl());
    expect(decoded).not.toBeNull();
    if (decoded) {
      expect(decoded[0]).toBe(0x89);
      expect(decoded[1]).toBe(0x50);
    }
  });

  it("returns null on a malformed data URL", () => {
    expect(decodeDataUrl("not a data url")).toBeNull();
    expect(decodeDataUrl("data:image/png;something,xyz")).toBeNull();
  });

  it("returns null on invalid base64", () => {
    expect(decodeDataUrl("data:image/png;base64,!@#$%^")).toBeNull();
  });
});

// ---------- assembleBundle dispatcher ----------

describe("assembleBundle", () => {
  it("assembles a minimal one-character bundle with all required files", async () => {
    const { env, bundles } = makeStubEnv();
    const result = await assembleBundle(env, {
      storyboard: minimalSb(["A"]),
      characterRefs: { A: ref("Kira", "short, blue hair, leather jacket", 8) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundleKey).toBe("bundles/cherry.tar.gz");
    expect(result.fileCount).toBe(11); // storyboard + portrait + 8 refs + registry
    expect(bundles.has("bundles/cherry.tar.gz")).toBe(true);

    const gz = bundles.get("bundles/cherry.tar.gz")!.bytes;
    const tar = new Uint8Array(gunzipSync(gz));
    const names = listTarNames(tar);
    expect(names).toContain("storyboard.yaml");
    expect(names).toContain("characters/registry.json");
    expect(names).toContain("characters/char_A_Kira.png");
    expect(names).toContain("characters/refs/A/ref_01.png");
    expect(names).toContain("characters/refs/A/ref_08.png");
  });

  it("emits a registry.json with the correct shape per slot", async () => {
    const { env, bundles } = makeStubEnv();
    await assembleBundle(env, {
      storyboard: minimalSb(["A"]),
      characterRefs: { A: ref("Kira", "blue hair", 8) },
    });
    const tar = new Uint8Array(gunzipSync(bundles.get("bundles/cherry.tar.gz")!.bytes));
    const registryBytes = readTarFile(tar, "characters/registry.json");
    expect(registryBytes).not.toBeNull();
    const registry = JSON.parse(new TextDecoder().decode(registryBytes!));
    expect(registry).toEqual({
      characters: {
        A: {
          name: "Kira",
          prompt: "blue hair",
          image: "characters/char_A_Kira.png",
        },
      },
    });
  });

  it("includes storyboard.yaml with the validated, normalized values", async () => {
    const { env, bundles } = makeStubEnv();
    await assembleBundle(env, {
      storyboard: minimalSb(["A"]),
      characterRefs: { A: ref("Kira", "blue hair", 8) },
    });
    const tar = new Uint8Array(gunzipSync(bundles.get("bundles/cherry.tar.gz")!.bytes));
    const yamlBytes = readTarFile(tar, "storyboard.yaml");
    expect(yamlBytes).not.toBeNull();
    const yaml = new TextDecoder().decode(yamlBytes!);
    expect(yaml).toContain('title: "cherry"');
    expect(yaml).toContain('style_category: "None"');
    expect(yaml).toContain("use_characters: [A]");
  });

  it("rejects when use_characters has no matching characterRefs entry", async () => {
    const { env } = makeStubEnv();
    const result = await assembleBundle(env, {
      storyboard: minimalSb(["A", "B"]),
      characterRefs: { A: ref("Kira", "blue hair", 8) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => /missing entry for slot "B"/i.test(e)),
      ).toBe(true);
    }
  });

  it("rejects when characterRefs[slot].name is empty", async () => {
    const { env } = makeStubEnv();
    const result = await assembleBundle(env, {
      storyboard: minimalSb(["A"]),
      characterRefs: {
        A: { name: "", prompt: "x", trainingImages: trainingImages(8) },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /name is required/i.test(e))).toBe(true);
    }
  });

  it("rejects when trainingImages is empty", async () => {
    const { env } = makeStubEnv();
    const result = await assembleBundle(env, {
      storyboard: minimalSb(["A"]),
      characterRefs: {
        A: { name: "Kira", prompt: "x", trainingImages: [] },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => /trainingImages.*required.*non-empty/i.test(e)),
      ).toBe(true);
    }
  });

  it("rejects when a training image has neither key nor dataUrl", async () => {
    const { env } = makeStubEnv();
    const result = await assembleBundle(env, {
      storyboard: minimalSb(["A"]),
      characterRefs: {
        A: { name: "Kira", prompt: "x", trainingImages: [{}] },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => /must provide either.*key.*dataUrl/i.test(e)),
      ).toBe(true);
    }
  });

  it("rejects when an R2 key points to a missing object", async () => {
    const { env } = makeStubEnv();
    const result = await assembleBundle(env, {
      storyboard: minimalSb(["A"]),
      characterRefs: {
        A: {
          name: "Kira",
          prompt: "x",
          trainingImages: [{ key: "in/nonexistent.png" }],
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => /R2 object not found/i.test(e)),
      ).toBe(true);
    }
  });

  it("resolves R2 keys when the object exists", async () => {
    const { env, refs, bundles } = makeStubEnv();
    refs.set("in/abc.png", pngBytes());
    const trainImgs: TrainingImage[] = Array.from({ length: 8 }, () => ({
      key: "in/abc.png",
    }));
    const result = await assembleBundle(env, {
      storyboard: minimalSb(["A"]),
      characterRefs: {
        A: { name: "Kira", prompt: "x", trainingImages: trainImgs },
      },
    });
    expect(result.ok).toBe(true);
    const tar = new Uint8Array(gunzipSync(bundles.get("bundles/cherry.tar.gz")!.bytes));
    expect(listTarNames(tar)).toContain("characters/refs/A/ref_01.png");
  });

  it("uses portrait override when supplied (not trainingImages[0])", async () => {
    const { env, bundles } = makeStubEnv();
    const portraitBytes = jpegBytes();
    await assembleBundle(env, {
      storyboard: minimalSb(["A"]),
      characterRefs: {
        A: {
          name: "Kira",
          prompt: "x",
          trainingImages: trainingImages(8),
          portrait: { dataUrl: "data:image/jpeg;base64," + b64(portraitBytes) },
        },
      },
    });
    const tar = new Uint8Array(gunzipSync(bundles.get("bundles/cherry.tar.gz")!.bytes));
    // Portrait file is at characters/char_A_Kira.png (always .png suffix
    // by convention). The bytes inside should be the JPEG bytes we passed
    // as the portrait override.
    const portrait = readTarFile(tar, "characters/char_A_Kira.png");
    expect(portrait).not.toBeNull();
    if (portrait) {
      expect(portrait[0]).toBe(0xff);
      expect(portrait[1]).toBe(0xd8);
    }
  });

  it("emits training refs with extensions matching the detected format", async () => {
    const { env, bundles } = makeStubEnv();
    await assembleBundle(env, {
      storyboard: minimalSb(["A"]),
      characterRefs: {
        A: {
          name: "Kira",
          prompt: "x",
          trainingImages: [
            { dataUrl: pngDataUrl() },
            { dataUrl: "data:image/jpeg;base64," + b64(jpegBytes()) },
            { dataUrl: "data:image/webp;base64," + b64(webpBytes()) },
            ...trainingImages(5),
          ],
        },
      },
    });
    const tar = new Uint8Array(gunzipSync(bundles.get("bundles/cherry.tar.gz")!.bytes));
    const names = listTarNames(tar);
    expect(names).toContain("characters/refs/A/ref_01.png");
    expect(names).toContain("characters/refs/A/ref_02.jpg");
    expect(names).toContain("characters/refs/A/ref_03.webp");
  });

  it("re-validates the storyboard defensively and refuses an invalid one", async () => {
    const { env } = makeStubEnv();
    // Hand it a storyboard with scenes empty (validator should catch).
    const bad = { ...minimalSb(["A"]), scenes: [] } as StoryboardValidated;
    const result = await assembleBundle(env, {
      storyboard: bad,
      characterRefs: { A: ref("Kira", "x", 8) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /storyboard:.*scenes/i.test(e))).toBe(true);
    }
  });

  it("includes a top-level start_image.png when supplied", async () => {
    const { env, bundles } = makeStubEnv();
    await assembleBundle(env, {
      storyboard: minimalSb(["A"]),
      characterRefs: { A: ref("Kira", "x", 8) },
      startImage: { dataUrl: pngDataUrl() },
    });
    const tar = new Uint8Array(gunzipSync(bundles.get("bundles/cherry.tar.gz")!.bytes));
    expect(listTarNames(tar)).toContain("start_image.png");
  });

  it("does not include start_image.png when omitted", async () => {
    const { env, bundles } = makeStubEnv();
    await assembleBundle(env, {
      storyboard: minimalSb(["A"]),
      characterRefs: { A: ref("Kira", "x", 8) },
    });
    const tar = new Uint8Array(gunzipSync(bundles.get("bundles/cherry.tar.gz")!.bytes));
    expect(listTarNames(tar)).not.toContain("start_image.png");
  });

  it("uses projectName (slugified title) in the bundle key", async () => {
    const { env, bundles } = makeStubEnv();
    const sb = minimalSb(["A"]);
    sb.title = "my film";
    sb.projectName = "my_film";
    const result = await assembleBundle(env, {
      storyboard: sb,
      characterRefs: { A: ref("Kira", "x", 8) },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundleKey).toBe("bundles/my_film.tar.gz");
      expect(bundles.has("bundles/my_film.tar.gz")).toBe(true);
    }
  });
});
