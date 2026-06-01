// R2 bucket routing for the storyboard / chat split (v0.39.1).
//
// The Worker has two R2 bindings: env.R2 (chat artifacts) and
// env.R2_RENDERS (storyboard / render artifacts the GPU worker also
// reads and writes). A request that wants an artifact by key needs to
// know which bucket it lives in. The rule is by prefix:
//
//   renders/*         -> R2_RENDERS  (silent MP4s, SDXL keyframes)
//   bundles/*         -> R2_RENDERS  (assembled project bundles)
//   projects/*        -> R2_RENDERS  (project state tarballs)
//   character-refs/*  -> R2_RENDERS  (staged cast portraits + ref images)
//   everything else   -> R2          (in/, out/, zip/, ...)
//
// Lives in its own file so vitest can unit-test the helper without
// importing src/index.ts (which references the cloudflare:workers
// runtime module and cannot be loaded under the node test pool).

export function isRendersKey(key: string): boolean {
  return (
    key.startsWith("renders/") ||
    key.startsWith("bundles/") ||
    key.startsWith("projects/") ||
    key.startsWith("character-refs/")
  );
}
