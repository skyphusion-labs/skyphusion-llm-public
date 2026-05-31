// POSIX ustar tar emitter (v0.31.0).
//
// Pure, no runtime dep, no codegen. Emits a tar bytestream that gzip-wraps
// cleanly via CompressionStream("gzip") for upload to R2. The serverless
// GPU worker's r2_io.download_and_extract() reads it back via Python's
// tarfile module in "r:gz" mode; POSIX ustar is universally supported.
//
// Format reference: POSIX 1003.1-1990 ustar interchange format. Each entry
// is a 512-byte header + content padded to a 512-byte block; the archive
// ends with two empty 512-byte blocks.
//
// Limitations (intentional for the storyboard bundle's small fixed schema):
// - File names must be <= 100 bytes. The ustar prefix field is not used.
//   Bundle layout uses paths like "characters/refs/A/ref_01.png" (~30 b),
//   well under the limit.
// - Regular files only (no directories, symlinks, devices). The Python
//   tarfile extractor creates parent dirs on extraction.

const BLOCK_SIZE = 512;

export interface TarFile {
  name: string;     // path inside the tarball (e.g. "characters/registry.json")
  content: Uint8Array;
  mode?: number;    // file mode (default 0o644)
  mtime?: number;   // Unix seconds (default Date.now()/1000)
}

function writeOctal(bytes: Uint8Array, offset: number, width: number, value: number): void {
  // POSIX ustar: octal string with leading zeros, terminated by a null byte.
  // The width includes the terminator, so the numeric portion is width-1.
  const oct = value.toString(8).padStart(width - 1, "0");
  for (let i = 0; i < width - 1; i++) {
    bytes[offset + i] = oct.charCodeAt(i);
  }
  bytes[offset + width - 1] = 0;
}

function writeString(bytes: Uint8Array, offset: number, width: number, s: string): void {
  // ASCII fields are written verbatim; remainder of the slot stays zero.
  for (let i = 0; i < s.length && i < width; i++) {
    bytes[offset + i] = s.charCodeAt(i) & 0xff;
  }
}

function checksumHeader(header: Uint8Array): number {
  // POSIX ustar checksum: unsigned sum of all 512 bytes of the header with
  // the 8-byte chksum field at offset 148 treated as ASCII spaces (0x20).
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (i >= 148 && i < 156) sum += 0x20;
    else sum += header[i];
  }
  return sum;
}

function buildHeader(file: TarFile): Uint8Array {
  if (file.name.length === 0) {
    throw new Error("tar: empty file name");
  }
  if (file.name.length > 100) {
    throw new Error(
      `tar: filename too long (${file.name.length} > 100): ${file.name}`,
    );
  }
  const header = new Uint8Array(BLOCK_SIZE);

  // name @ 0, width 100
  writeString(header, 0, 100, file.name);

  // mode @ 100, width 8
  writeOctal(header, 100, 8, file.mode ?? 0o644);

  // uid @ 108, gid @ 116, both width 8 (zero)
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);

  // size @ 124, width 12
  writeOctal(header, 124, 12, file.content.length);

  // mtime @ 136, width 12 (Unix seconds)
  const mtime = file.mtime ?? Math.floor(Date.now() / 1000);
  writeOctal(header, 136, 12, mtime);

  // typeflag @ 156: "0" for regular file
  header[156] = 0x30;

  // linkname @ 157, width 100 (zero)

  // magic @ 257: "ustar\0"
  writeString(header, 257, 5, "ustar");
  header[262] = 0;

  // version @ 263, width 2: "00"
  header[263] = 0x30;
  header[264] = 0x30;

  // uname @ 265, gname @ 297, width 32 (zero)

  // devmajor @ 329, devminor @ 337, width 8 (zero)
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);

  // prefix @ 345, width 155 (unused; we bail on name > 100 above)

  // chksum @ 148, width 8: 6 octal digits + null + space (POSIX form).
  const sum = checksumHeader(header);
  const sumStr = sum.toString(8).padStart(6, "0");
  for (let i = 0; i < 6; i++) header[148 + i] = sumStr.charCodeAt(i);
  header[148 + 6] = 0;     // null
  header[148 + 7] = 0x20;  // space

  return header;
}

export function emitTar(files: TarFile[]): Uint8Array {
  // Pre-compute total size so we can allocate one buffer (avoids a fragile
  // chain of concatenations and lets the caller hand a single Uint8Array to
  // CompressionStream).
  let total = 0;
  for (const f of files) {
    total += BLOCK_SIZE; // header
    total += BLOCK_SIZE * Math.ceil(f.content.length / BLOCK_SIZE); // padded content
  }
  total += BLOCK_SIZE * 2; // trailing two empty blocks

  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of files) {
    const header = buildHeader(f);
    out.set(header, offset);
    offset += BLOCK_SIZE;
    out.set(f.content, offset);
    offset += BLOCK_SIZE * Math.ceil(f.content.length / BLOCK_SIZE);
  }
  // Trailing two blocks already zero (Uint8Array initializes to 0).
  return out;
}
