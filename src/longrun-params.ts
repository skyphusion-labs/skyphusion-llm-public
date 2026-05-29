// Param construction for the long-run video/music workflow (v0.21.5).
//
// Extracted as a pure function so the per-model param shapes are unit-testable
// without importing index.ts (cloudflare:workers). The shapes differ enough
// that getting them wrong means a rejected upstream call:
//   - text-to-video (Veo/Seedance/etc): { prompt, duration:"8s", aspect_ratio,
//     resolution:"720p", generate_audio } -- duration is a STRING here.
//   - image-to-video (alibaba/hh1-i2v): { image, resolution:"720P", duration:N }
//     -- image is required (a fetchable URL), duration is an INTEGER 3-15, and
//     additionalProperties is false so the t2v fields (aspect_ratio,
//     generate_audio, string duration) would be rejected. Verified against the
//     CF hh1-i2v model page.
//   - music (minimax/music-2.6): { prompt, lyrics? }
//
// i2v is selected by the presence of imageUrl, not a separate kind, so the
// workflow keeps a single "video" kind.

export type GenKind = "video" | "music";

export interface GenParamOpts {
  prompt: string;
  lyrics?: string;
  imageUrl?: string;   // present => image-to-video
}

export function buildGenParams(kind: GenKind, opts: GenParamOpts): Record<string, unknown> {
  const { prompt, lyrics, imageUrl } = opts;

  if (kind === "video" && imageUrl) {
    // image-to-video (hh1-i2v shape)
    const params: Record<string, unknown> = {
      image: imageUrl,
      resolution: "720P",
      duration: 5,
    };
    if (prompt && prompt.trim()) params.prompt = prompt; // optional motion prompt
    return params;
  }

  if (kind === "video") {
    // text-to-video (existing shape)
    return {
      prompt,
      duration: "8s",
      aspect_ratio: "16:9",
      resolution: "720p",
      generate_audio: true,
    };
  }

  // music
  const params: Record<string, unknown> = { prompt };
  if (lyrics && lyrics.trim()) params.lyrics = lyrics;
  return params;
}
