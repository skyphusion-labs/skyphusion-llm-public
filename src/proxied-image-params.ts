// Per-provider request params for proxied (non-@cf) image models (v0.22.0).
//
// Every proxied image schema is additionalProperties:false (verified against
// the CF model pages), so each provider gets ONLY the keys it accepts; the @cf
// { width, height, steps, negative_prompt } shape is rejected by all of them.
//
// Lives in its own module (not inline in index.ts) for the same reason
// output-extract.ts does: index.ts imports cloudflare:workers and can't load
// under the plain-Node vitest pool, so an inline helper wouldn't be unit-
// testable. This takes the two primitives it needs rather than the ModelEntry/
// ChatRequest objects, keeping it free of any Workers-runtime import.
//
//   google   (nano-banana family): { prompt, output_format } -> PNG URL
//   openai   (gpt-image-1.5):       transparent PNG. CF's catalog routes
//                                   transparency here. background:"transparent"
//                                   + output_format:"png". The underlying OpenAI
//                                   model supports both; whether the proxy
//                                   forwards them is the live-verify item in the
//                                   v0.22.0 CHANGELOG entry.
//   recraft  (recraftv4):           opaque, art-directed. No alpha flag exists
//                                   on the CF proxy schema (only an opaque
//                                   background_color). Returns webp.
import type { Provider } from "./models";

export function buildProxiedImageParams(
  provider: Provider | undefined,
  prompt: string,
): Record<string, unknown> {
  switch (provider) {
    case "google":
      return { prompt, output_format: "png" };
    case "openai":
      // gpt-image-1.5 via the CF proxy. The proxy's schema is strictly
      // { prompt, images, quality, size, style } and 7003-rejects anything
      // else, so background/output_format CANNOT be requested here despite
      // CF's catalog note. This path is therefore OPAQUE. Transparent PNG
      // needs the OpenAI direct (BYOK) endpoint, which forwards `background`
      // (see CHANGELOG v0.22.1 / proposed openai-image BYOK path).
      return { prompt, quality: "high", size: "1024x1024" };
    case "recraft":
      return { prompt, size: "1024x1024", style: "digital_illustration" };
    default:
      return { prompt };
  }
}
