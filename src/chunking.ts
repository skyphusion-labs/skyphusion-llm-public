// Text chunking for RAG ingestion (v0.19.4).
//
// Extracted and rewritten from the fixed-window chunker in src/index.ts.
// The previous implementation used a 500-char window with break-point
// search restricted to the last 1/3 of the window: if a paragraph break
// appeared earlier than that, the chunker ignored it and forced a chunk
// that spanned the paragraph. For fiction, worldbuilding, and Discord
// message corpora (v0.20.x), this produced chunks that broke mid-thought
// even when clean semantic boundaries existed.
//
// The new chunker uses recursive separator splitting (the LangChain
// `RecursiveCharacterTextSplitter` shape). A separator hierarchy is tried
// in priority order; for each separator, the text is split and any piece
// still too large is recursively split using the next-priority separator.
// Adjacent fragments are then greedily merged back up to the target size
// with optional tail-overlap.
//
// Result: chunks respect ALL paragraph breaks (not just ones in the last
// third of the window), can be smaller than target when a clean boundary
// makes them so, and degrade gracefully on text with no useful separators.

const CHUNK_TARGET_CHARS = 500;
const CHUNK_OVERLAP_CHARS = 50;

// Separator priority hierarchy. Earlier separators are tried first; the
// chunker prefers paragraph breaks over line breaks over sentence breaks
// over word breaks. The empty-string separator is the last-resort hard
// character split.
const CHUNK_SEPARATORS: readonly string[] = [
  "\n\n",   // paragraph breaks (highest priority - never break a paragraph)
  "\n",     // line breaks (preserve list items, dialog lines, code lines)
  ". ",     // sentence end (period)
  "? ",     // sentence end (question)
  "! ",     // sentence end (exclamation)
  "; ",     // clause break (semicolon - useful for legal prose)
  ", ",     // weaker break (comma fallback for run-on text)
  " ",      // word break
  "",       // last resort: hard character split
];

/**
 * Split text into chunks targeting CHUNK_TARGET_CHARS each, with tail-overlap
 * between consecutive chunks. Public entry point; replaces the v0.10.x
 * fixed-window chunker.
 *
 * Returns an empty array for empty input. Otherwise returns at least one
 * chunk. Chunks are returned in source order. Each chunk is trimmed of
 * leading/trailing whitespace.
 */
export function chunkText(text: string): string[] {
  if (!text) return [];
  const fragments = recursiveCharSplit(text, CHUNK_SEPARATORS, CHUNK_TARGET_CHARS);
  return mergeFragments(fragments, CHUNK_TARGET_CHARS, CHUNK_OVERLAP_CHARS);
}

/**
 * Recursively split text using a separator hierarchy until all fragments
 * are at most `targetSize` characters. Tries separators in order; for each
 * separator that appears in the text, splits and re-attaches the separator
 * to the trailing side of each piece (so the split is non-destructive).
 * Pieces still too large after a split are recursively re-split using the
 * next-priority separator.
 *
 * If no separator in the list appears in the text and the text still
 * exceeds targetSize, falls back to a hard character split.
 */
function recursiveCharSplit(
  text: string,
  separators: readonly string[],
  targetSize: number,
): string[] {
  if (text.length <= targetSize) {
    return text ? [text] : [];
  }

  // Find the first separator that appears in the text. The empty-string
  // separator always matches (it's the hard-split fallback).
  let separator = "";
  let separatorIdx = separators.length;
  for (let i = 0; i < separators.length; i++) {
    const s = separators[i];
    if (s === "" || text.includes(s)) {
      separator = s;
      separatorIdx = i;
      break;
    }
  }

  // Hard character split as the absolute last resort.
  if (separator === "") {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += targetSize) {
      out.push(text.slice(i, i + targetSize));
    }
    return out;
  }

  // Split on the chosen separator and re-attach it to the trailing side
  // of each piece (except the last, which has nothing trailing).
  const rawParts = text.split(separator);
  const parts: string[] = [];
  for (let i = 0; i < rawParts.length; i++) {
    const piece = rawParts[i] + (i < rawParts.length - 1 ? separator : "");
    if (piece) parts.push(piece);
  }

  // Recurse on any piece that's still too large, using the next-priority
  // separators only (the current one already didn't reduce it enough).
  const nextSeps = separators.slice(separatorIdx + 1);
  const out: string[] = [];
  for (const part of parts) {
    if (part.length <= targetSize) {
      out.push(part);
    } else {
      out.push(...recursiveCharSplit(part, nextSeps, targetSize));
    }
  }
  return out;
}

/**
 * Greedily merge adjacent fragments back up to the target size. Adds a
 * tail-overlap from the previous chunk to the next when overlap > 0 and
 * the previous chunk is large enough to carry one.
 *
 * The merge stays under targetSize whenever possible. If a single fragment
 * exceeds targetSize on its own (which happens when recursiveCharSplit
 * had to hard-split), it gets its own chunk regardless.
 */
function mergeFragments(
  fragments: string[],
  targetSize: number,
  overlap: number,
): string[] {
  const out: string[] = [];
  let buffer = "";

  for (const frag of fragments) {
    if (!buffer) {
      buffer = frag;
      continue;
    }
    if (buffer.length + frag.length <= targetSize) {
      buffer += frag;
    } else {
      const finalized = buffer.trim();
      if (finalized) out.push(finalized);
      // Optional tail-overlap: carry the last `overlap` characters of the
      // previous chunk into the start of the next. Helps RAG retrieval
      // find passages that straddle chunk boundaries.
      if (overlap > 0 && buffer.length > overlap) {
        buffer = buffer.slice(-overlap) + frag;
      } else {
        buffer = frag;
      }
    }
  }
  const finalized = buffer.trim();
  if (finalized) out.push(finalized);
  return out;
}
