// Tests for the POSIX ustar emitter (v0.31.0). Pure bytes in / bytes out;
// no I/O. We also write a minimal in-test parser to round-trip and verify
// the GPU side's Python tarfile module will read it back unchanged.

import { describe, it, expect } from "vitest";
import { emitTar, type TarFile } from "../src/tar-emit";

const BLOCK = 512;

function readString(bytes: Uint8Array, start: number, width: number): string {
  let end = start;
  while (end < start + width && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.slice(start, end));
}

// Minimal ustar parser. Only handles regular files (typeflag '0' or '\0'),
// which is all the emitter produces.
function parseUstarTar(bytes: Uint8Array): TarFile[] {
  const out: TarFile[] = [];
  let offset = 0;
  while (offset + BLOCK <= bytes.length) {
    // Check end-of-archive marker (two empty blocks).
    let allZero = true;
    for (let i = 0; i < BLOCK; i++) {
      if (bytes[offset + i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const name = readString(bytes, offset, 100);
    const modeStr = readString(bytes, offset + 100, 8).trim();
    const mode = modeStr ? parseInt(modeStr, 8) : 0;
    const sizeStr = readString(bytes, offset + 124, 12).trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const mtimeStr = readString(bytes, offset + 136, 12).trim();
    const mtime = mtimeStr ? parseInt(mtimeStr, 8) : 0;

    offset += BLOCK;
    const content = bytes.slice(offset, offset + size);
    out.push({ name, content, mode, mtime });
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

describe("emitTar", () => {
  it("emits the ustar magic at the right offset", () => {
    const out = emitTar([{ name: "x", content: new Uint8Array(1) }]);
    expect(readString(out, 257, 5)).toBe("ustar");
    expect(out[262]).toBe(0); // null terminator after "ustar"
  });

  it("emits the POSIX version '00'", () => {
    const out = emitTar([{ name: "x", content: new Uint8Array(1) }]);
    expect(String.fromCharCode(out[263], out[264])).toBe("00");
  });

  it("emits typeflag '0' (regular file) at offset 156", () => {
    const out = emitTar([{ name: "x", content: new Uint8Array(1) }]);
    expect(out[156]).toBe(0x30);
  });

  it("computes a valid header checksum", () => {
    const out = emitTar([{
      name: "hello.txt",
      content: new TextEncoder().encode("Hello, world!\n"),
    }]);
    // Recompute checksum from bytes[0..512] with chksum field = spaces.
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
      if (i >= 148 && i < 156) sum += 0x20;
      else sum += out[i];
    }
    const writtenStr = readString(out, 148, 6);
    const written = parseInt(writtenStr, 8);
    expect(written).toBe(sum);
  });

  it("pads content to a 512-byte boundary", () => {
    const out = emitTar([{ name: "x", content: new Uint8Array(100) }]);
    // 512 (header) + 512 (content padded) + 1024 (end-of-archive) = 2048
    expect(out.length).toBe(2048);
  });

  it("emits two trailing empty blocks (end-of-archive marker)", () => {
    const out = emitTar([{ name: "x", content: new Uint8Array(0) }]);
    for (let i = out.length - 1024; i < out.length; i++) {
      expect(out[i]).toBe(0);
    }
  });

  it("handles zero-byte content", () => {
    const out = emitTar([{ name: "empty", content: new Uint8Array(0) }]);
    expect(out.length).toBe(512 + 0 + 1024);
    const parsed = parseUstarTar(out);
    expect(parsed.length).toBe(1);
    expect(parsed[0].content.length).toBe(0);
  });

  it("preserves multiple files in declared order", () => {
    const files: TarFile[] = [
      { name: "a.txt", content: new TextEncoder().encode("A") },
      { name: "b.txt", content: new TextEncoder().encode("BB") },
      { name: "c.txt", content: new TextEncoder().encode("CCC") },
    ];
    const out = emitTar(files);
    const parsed = parseUstarTar(out);
    expect(parsed.length).toBe(3);
    expect(parsed[0].name).toBe("a.txt");
    expect(parsed[1].name).toBe("b.txt");
    expect(parsed[2].name).toBe("c.txt");
    expect(new TextDecoder().decode(parsed[0].content)).toBe("A");
    expect(new TextDecoder().decode(parsed[1].content)).toBe("BB");
    expect(new TextDecoder().decode(parsed[2].content)).toBe("CCC");
  });

  it("round-trips arbitrary binary content byte-for-byte", () => {
    const content = new Uint8Array(2000);
    for (let i = 0; i < content.length; i++) content[i] = i & 0xff;
    const out = emitTar([{ name: "binary.bin", content }]);
    const parsed = parseUstarTar(out);
    expect(parsed[0].content.length).toBe(2000);
    for (let i = 0; i < content.length; i++) {
      expect(parsed[0].content[i]).toBe(content[i]);
    }
  });

  it("handles ASCII path-style filenames (the bundle layout case)", () => {
    const out = emitTar([{
      name: "characters/refs/A/ref_01.png",
      content: new Uint8Array(0),
    }]);
    const parsed = parseUstarTar(out);
    expect(parsed[0].name).toBe("characters/refs/A/ref_01.png");
  });

  it("throws for filenames longer than 100 bytes", () => {
    const longName = "x".repeat(101);
    expect(() => emitTar([{ name: longName, content: new Uint8Array(0) }])).toThrow(/too long/);
  });

  it("throws for empty filenames", () => {
    expect(() => emitTar([{ name: "", content: new Uint8Array(0) }])).toThrow(/empty/);
  });

  it("preserves explicit mode and mtime in the header", () => {
    const out = emitTar([{
      name: "x",
      content: new Uint8Array(0),
      mode: 0o755,
      mtime: 1700000000,
    }]);
    const parsed = parseUstarTar(out);
    expect(parsed[0].mode).toBe(0o755);
    expect(parsed[0].mtime).toBe(1700000000);
  });

  it("uses default mode 0o644 when unspecified", () => {
    const out = emitTar([{ name: "x", content: new Uint8Array(0) }]);
    const parsed = parseUstarTar(out);
    expect(parsed[0].mode).toBe(0o644);
  });
});
