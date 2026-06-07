# CPU prep containers

Vivijure's render pipeline keeps the expensive RunPod GPU worker purely GPU-bound by
offloading the steps that only need a CPU to three **Cloudflare Containers** (built
from `containers/`). Each is fronted by its own Durable Object and reaches R2 over
presigned S3 URLs (it holds no R2 binding), so the Worker stays the only thing that
touches storage directly.

| Container | Binding / class | Stage | Image |
|---|---|---|---|
| **image-prep** | `IMAGE_PREP` / `ImagePrepContainer` | background-remove cast portraits at bundle time | `containers/image-prep/` |
| **audio-beat-sync** | `AUDIO_BEAT_SYNC` / `AudioBeatSyncContainer` | detect BPM + downbeats from the music bed | `containers/audio-beat-sync/` |
| **video-finish** | `VIDEO_FINISH` / `VideoFinishContainer` | concat clips, crossfade, mux audio (the final cut) | `containers/video-finish/` |

All three are declared in `wrangler.toml` (`[[containers]]` + a matching
`[[durable_objects.bindings]]`), listen on **port 8000**, use the `standard-1`
instance type, and evict after ~10 min idle.

## Shared patterns

- **No R2 binding.** The Worker presigns short-lived GET/PUT URLs (SigV4 over Web
  Crypto, `src/r2-presign.ts`) and hands them to the container, which streams R2
  directly. Inputs/outputs are plain R2 keys on the Worker side.
- **Cold-start guard.** Each call first pings `POST /health` to ride out the
  port-bind window, then retries the heavy request up to 3x with ~1.5s backoff on a
  `503` (a fully-cold container can 503 while it binds). See `callImagePrep`
  (`src/bundle-assembler.ts`) and `runVideoFinish` (`src/video-finish.ts`).
- **numba cache (image-prep + audio-beat-sync only).** Both bake a CPU-portable
  numba JIT cache into the image; numba's kernels otherwise compile for ~26-46s on a
  cold cache, which blew the port-bind window until the cache was pinned with a
  whole-second source mtime and a generic CPU target. `video-finish` is a plain
  ffmpeg subprocess and needs no warmup.

---

## image-prep (`IMAGE_PREP`)

Background-removes a cast portrait (rembg / u2net) so the renderer gets a clean
alpha subject. The cleaned PNG is content-addressed in R2 (`cast-clean/<sha256>.png`)
and reused across bundles. Wrapper: `src/containers/image-prep.ts`; caller:
`callImagePrep` in `src/bundle-assembler.ts`.

- `POST /health` -- warmup ping.
- `POST /portrait/prep`
  - Request: `{ inputUrl, outputUrl, outputKey, background: "alpha" | "black" }`
    (`inputUrl`/`outputUrl` are presigned R2 GET/PUT; `outputKey` is the R2 key).
  - Response: JSON success; the container PUTs the cleaned PNG to `outputUrl`.
  - On a container-path failure the caller falls back to the original portrait bytes
    rather than failing the whole bundle.

## audio-beat-sync (`AUDIO_BEAT_SYNC`)

Runs librosa to detect tempo + downbeats from the uploaded music bed and proposes a
per-scene timing plan, so cuts can land on the beat. Wrapper:
`src/containers/audio-beat-sync.ts`; caller: `handleAudioAnalyze`
(`POST /api/audio/analyze`, `src/index.ts`). The plan shape +
`parseAudioBeatPlan` live in `src/runpod-submit.ts`.

- `POST /analyze`
  - Request: `{ audioUrl, audioKey, clipSeconds?=8.0, mode: "beat" | "duration",
    minSceneS?=2.5, maxSceneS?=12.0, forceShots? }` (`audioUrl` is a presigned GET of
    an `audio/` or `out/` key; `forceShots` is duration-mode only).
  - Response (`AudioBeatPlan`): `{ mode, audioKey, durationSeconds, bpm?, beatCount?,
    suggestedShots, clipSeconds, filmSeconds, remainderSeconds, timedScenes:
    [{ index, start, end, targetSeconds }], note }`.
  - The planner applies `timedScenes[].targetSeconds` onto the storyboard scenes
    (`applyBeatTiming`), which is what makes a later render/animation beat-trimmed.

## video-finish (`VIDEO_FINISH`)

The final cut, off the GPU (ffmpeg): concat an ordered list of clips, crossfade the
joins, normalize size/fps, and optionally mux an audio bed. Wrapper:
`src/containers/video-finish.ts`; the typed input + caller live in
`src/video-finish.ts` (`VideoFinishInput`, `runVideoFinish`, `parseVideoFinishInput`).
Public endpoint: `POST /api/video/finish`. Also used internally by add-audio /
add-narration and by the cloud/hybrid animate assembly step.

- `POST /health` -- warmup ping.
- `POST /finish`
  - Request (translated from `VideoFinishInput`): `{ clips: [{ url, targetSeconds? }],
    audioUrl?, outputUrl, outputKey, width?, height?, fps?, crf?, preset?, crossfade?,
    trimJoinFrames?, remuxAudioOnly? }`. On the Worker side clips are `{ key,
    targetSeconds? }` R2 keys; `targetSeconds` beat-trims that clip.
  - Response: JSON success; the container PUTs the finished MP4 to `outputUrl`. The
    Worker then re-PUTs it with `customMetadata.user_email` so `/api/artifact` will
    serve it.

### `remuxAudioOnly` (important)

By default the container **normalizes** every clip to `width`/`height`/`fps`, so a
muxing pass would re-encode and could rescale a finished render (e.g. a 1280x720
cloud/hybrid cut up to the container's default). When you only need to lay audio onto
an already-finished video, set **`remuxAudioOnly: true`**: the container
**stream-copies the video** (no re-encode, no rescale) and only adds the audio track.
It requires **exactly one clip**. The add-audio / add-narration paths
(`src/index.ts`) set this so scoring a render never changes its resolution.

---

## Building + deploying

The container images live under `containers/<name>/` (each with its own Dockerfile).
They deploy with the Worker via `wrangler deploy` (the `[[containers]]` entries point
`wrangler` at each Dockerfile). The two numba images carry the pinned JIT cache;
rebuild them if the numba/librosa versions change.
