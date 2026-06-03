# Audio beat-sync — Worker-side wiring spec

> **Backend pivoted.** The pod action this spec pairs with was reverted
> in `vivijure-serverless 0.4.60` (no reason to spin a GPU pod to read
> an MP3). The current backend is a Cloudflare Container; see
> `audio-beat-sync-container.md` for the live spec. The Worker
> contracts and planner UI sections below mostly still apply, but the
> submit/poll dance is replaced by a single synchronous POST in the
> container spec. Treat this file as historical context.

Pairs with the pod action shipped in `vivijure-serverless 0.4.59`. Implementable end-to-end from this doc without further questions; mirrors the existing `/api/storyboard/render` flow.

## Goal

Give the planner an "analyze beats" action that takes an audio R2 key, calls the new pod `analyze_audio` action, and writes the returned beat-aligned scene targets into the current storyboard so each rendered clip lands on a downbeat span.

## Pod contract (already shipped, `vivijure-serverless 0.4.59`)

```jsonc
// Submit to RunPod endpoint:
{
  "input": {
    "action":       "analyze_audio",
    "audio_key":    "audio/<file>.mp3",   // R2_BUCKET key, required
    "clip_seconds": 4.0,                   // optional, default 8.0
    "mode":         "beat",                // "beat" | "duration", default "beat"
    "min_scene_s":  2.5,                   // optional, beat-mode clamp
    "max_scene_s":  12.0                   // optional, beat-mode clamp
  }
}

// Response:
{
  "mode":              "beat",
  "audio_key":         "audio/<file>.mp3",
  "duration_seconds":  248.0,
  "bpm":               124.5,
  "beat_count":        516,
  "suggested_shots":   32,
  "clip_seconds":      4.0,
  "film_seconds":      248.0,
  "remainder_seconds": 0.0,
  "timed_scenes": [
    { "index": 0, "start": 0.0,   "end": 3.875, "target_seconds": 3.88 },
    { "index": 1, "start": 3.875, "end": 7.75,  "target_seconds": 3.88 }
    // ...
  ],
  "note": "Beat sync · 124 BPM · 516 beats → 32 shots (boundaries on downbeats)."
}
```

Wall-clock: librosa `beat_track` on a 4-minute MP3 is ~2-5s; total RunPod round-trip with cold-start is 10-60s depending on whether the endpoint instance is warm. Poll like `/api/storyboard/render` does, do not synchronously wait in the HTTP handler.

## API surface

### `POST /api/audio/analyze`

Body:

```ts
interface AudioAnalyzeRequest {
  audioKey: string;                    // required; R2 key
  clipSeconds?: number;                // default 8.0
  mode?: "beat" | "duration";          // default "beat"
  minSceneS?: number;                  // default 2.5
  maxSceneS?: number;                  // default 12.0
  forceShots?: number;                 // duration mode only; override even-slice count
}
```

Response (immediate, same shape as the storyboard render submit):

```ts
interface AudioAnalyzeSubmitResponse {
  ok: true;
  jobId: string;                       // RunPod job id, for polling
  status: "IN_QUEUE" | "IN_PROGRESS";
}
```

Error shape: `{ ok: false, error: string, status?: number }` to mirror `submitRender`.

### `GET /api/audio/analyze/:jobId`

Mirrors `GET /api/storyboard/render/:jobId`. Returns the polled RunPod state plus, on COMPLETED, the parsed beat plan:

```ts
interface AudioAnalyzePollResponse {
  ok: true;
  jobId: string;
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  statusRaw: string;
  output?: AudioBeatPlan;              // present when status === "COMPLETED"
  error?: string;
}

interface AudioBeatPlan {
  mode: "beat" | "duration";
  audioKey: string;
  durationSeconds: number;
  bpm?: number;                        // beat mode only
  beatCount?: number;                  // beat mode only
  suggestedShots: number;
  clipSeconds: number;
  filmSeconds: number;
  remainderSeconds: number;
  timedScenes: TimedScene[];
  note: string;
}

interface TimedScene {
  index: number;
  start: number;
  end: number;
  targetSeconds: number;
}
```

## TypeScript work

### 1. `src/runpod-submit.ts`

Three new pieces:

**a) Interface for the pod request input (mirrors the python contract):**

```ts
export interface AnalyzeAudioJobInput {
  action: "analyze_audio";
  audio_key: string;
  clip_seconds?: number;
  mode?: "beat" | "duration";
  min_scene_s?: number;
  max_scene_s?: number;
  force_shots?: number;
}
```

**b) Builder pure function (testable, no env/fetch):**

```ts
export function buildAnalyzeAudioPayload(args: AudioAnalyzeRequest): { input: AnalyzeAudioJobInput } {
  const input: AnalyzeAudioJobInput = {
    action: "analyze_audio",
    audio_key: args.audioKey,
  };
  if (typeof args.clipSeconds === "number" && args.clipSeconds > 0) {
    input.clip_seconds = args.clipSeconds;
  }
  if (args.mode === "duration") input.mode = "duration";
  // default is "beat"; explicit omit equivalent
  if (typeof args.minSceneS === "number") input.min_scene_s = args.minSceneS;
  if (typeof args.maxSceneS === "number") input.max_scene_s = args.maxSceneS;
  if (typeof args.forceShots === "number" && Number.isInteger(args.forceShots) && args.forceShots > 0) {
    input.force_shots = args.forceShots;
  }
  return { input };
}
```

**c) Submit + poll dispatchers** — reuse the existing `submitRunpodJob` and `pollRunpodJob` helpers if they're already generic; if they're rendered-shape-only, factor them out. The render path's `submitRenderJob` is the template — copy its env-var checks, fetch wrapper, and `normalizeRunpodResponse` translation.

### 2. Parsing the pod output

The pod returns snake_case; the Worker exposes camelCase. Pure helper:

```ts
export function parseAudioBeatPlan(raw: unknown): AudioBeatPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const mode = r.mode === "beat" || r.mode === "duration" ? r.mode : null;
  if (!mode) return null;
  return {
    mode,
    audioKey: String(r.audio_key ?? ""),
    durationSeconds: Number(r.duration_seconds ?? 0),
    bpm: typeof r.bpm === "number" ? r.bpm : undefined,
    beatCount: typeof r.beat_count === "number" ? r.beat_count : undefined,
    suggestedShots: Number(r.suggested_shots ?? 0),
    clipSeconds: Number(r.clip_seconds ?? 0),
    filmSeconds: Number(r.film_seconds ?? 0),
    remainderSeconds: Number(r.remainder_seconds ?? 0),
    timedScenes: Array.isArray(r.timed_scenes)
      ? r.timed_scenes
          .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
          .map((s) => ({
            index: Number(s.index ?? 0),
            start: Number(s.start ?? 0),
            end: Number(s.end ?? 0),
            targetSeconds: Number(s.target_seconds ?? 0),
          }))
      : [],
    note: String(r.note ?? ""),
  };
}
```

### 3. `src/index.ts` — two route handlers

Mirror the storyboard render pair (`/api/storyboard/render` POST + `/api/storyboard/render/:jobId` GET). Place them after the cast routes and before the storyboard routes for grouping.

```ts
// POST /api/audio/analyze
if (url.pathname === "/api/audio/analyze" && request.method === "POST") {
  return handleAudioAnalyzeSubmit(request, env);
}
// GET /api/audio/analyze/<jobId>
const aj = url.pathname.match(/^\/api\/audio\/analyze\/([A-Za-z0-9_-]+)$/);
if (aj && request.method === "GET") {
  return handleAudioAnalyzePoll(request, env, aj[1]);
}
```

`handleAudioAnalyzeSubmit`:

1. Parse JSON body → `AudioAnalyzeRequest`.
2. Validate `audioKey`: required string, matches the existing audio key shape (`^audio/.+` or `^out/.+` — re-use whatever pattern the audio-attach flow uses).
3. Validate the R2 key actually exists — `env.R2_RENDERS.head(audioKey)` (or `env.R2.head` depending on which bucket the chat audio writes to; current flow has audio in `out/` on `env.R2` and the pod treats `audio_key` against `R2_BUCKET` which is the vivijure bucket — confirm against `_stage_audio` in `orchestrator.py` and the `needsAudioCrossBucketCopy` helper). If the key lives on the wrong bucket, the existing audio-routing copy step needs to fire **before** submit (the v0.51.0 audio upload work has this helper).
4. Build the RunPod payload via `buildAnalyzeAudioPayload`.
5. Submit via the same `submitRunpodJob` path used by the render handler (different action, same envelope).
6. Return `{ ok: true, jobId, status }`.

`handleAudioAnalyzePoll`:

1. Validate jobId shape (the existing `isValidJobId` regex applies).
2. Poll RunPod status via `pollRunpodJob`.
3. If COMPLETED, run the raw `output` through `parseAudioBeatPlan`; if parse fails, return `{ ok: false, error: "could not parse audio analysis output", raw: output }` so the failure surfaces.
4. Return the normalized response.

## Validation / errors

- `audioKey` empty / non-string → 400 `audio_key required`.
- `clipSeconds <= 0` → 400.
- `mode` not in `{beat, duration}` → 400.
- `audioKey` not found in R2 → 404 before submit, no point burning a RunPod call.
- Pod returns `error` field → 500 with the message; don't try to parse the rest.
- Pod returns parseable plan but `timedScenes.length === 0` in beat mode → still success, surface the empty array and the `note`; the planner UI shows the BPM + duration so the user knows what happened.

## Planner UI hook

`public/planner.html` already has the audio attach affordance from v0.51.0 (the "soundtrack" upload step). Add a button next to it:

```
[ analyze beats ]    BPM: —    suggested shots: —
```

After click:

1. Validate an audio is attached + a clip-seconds value is filled in (the existing scenes count field).
2. POST `/api/audio/analyze` with `{ audioKey: state.audioKey, clipSeconds, mode: "beat" }`.
3. Poll `/api/audio/analyze/<jobId>` every 2s, max 60s.
4. On COMPLETED, render the plan inline (BPM + suggested shots + the note).
5. Two follow-up buttons:
   - `[ apply to storyboard ]` — writes `timedScenes[i]` into `state.storyboard.scenes[i]` (`target_seconds`, `start`, `end`). If the storyboard has more scenes than the plan, extras get dropped or kept as-is depending on a confirm dialog. If fewer, missing scenes get added with empty prompts so the user can fill them.
   - `[ replan scenes ]` — fires the planner LLM with the plan's `suggested_shots` count and the bpm/duration as context (gives the LLM a budget for scene count + timing).

Add a `STORYBOARD_MAX_SCENES` check on `suggestedShots`: if a 5-minute track at 4s/shot suggests 75 shots and the cap is 50 (per the v0.80.0 caps work), surface a warning and cap the apply step.

## Tests

`tests/audio-analyze.test.ts`:

1. `buildAnalyzeAudioPayload` — defaults, custom `clipSeconds`, `mode=duration`, `forceShots`, min/max bounds.
2. `parseAudioBeatPlan` — valid beat-mode response, valid duration-mode response, missing fields → null, mode wrong → null, malformed `timedScenes` (some entries missing `index`) → only valid entries survive.
3. Route validation: missing `audioKey` → 400; bad mode → 400; valid request → forwards correct RunPod payload (mock the `submitRunpodJob` and assert what it was called with).

Reuse the test infra from `tests/runpod-submit.test.ts` and `tests/storyboard-validate.test.ts`.

## Edge cases

- **Audio shorter than 1 clip** (e.g., 2s audio, `clipSeconds=8`): librosa still returns a tempo + a few beats; the boundary fitter produces one scene of full duration with note "1 shot · short track". UI should not show an error.
- **Audio without a clear tempo** (ambient, sparse percussion): librosa's `beat_track` returns a tempo guess + sparse beats. The plan succeeds but the boundaries may be loose. Note string still works.
- **`mode=duration` + `forceShots=10`**: bypasses librosa entirely; result has empty `timedScenes` (the pod path returns `[]` for duration mode without explicit per-scene cuts) and only `suggestedShots`. UI's "apply" button is disabled in that case; the user just uses the suggested_shots to drive a fresh planner LLM call.
- **RunPod cold start**: 30-60s to first response. The poll loop handles this; UI shows "queued" then "analyzing" then "ready".
- **Concurrent calls with the same audio**: idempotent on the pod side (no shared state, each call gets its own tempdir). Safe to fire multiple from one user session if they tweak `clipSeconds`.

## End-to-end flow

1. User uploads `audio/track.mp3` via the existing soundtrack uploader (lands in R2).
2. User clicks "analyze beats", `clipSeconds = 4`.
3. Worker POSTs `/api/audio/analyze` → submits RunPod job → returns `{jobId, status: IN_QUEUE}`.
4. UI polls `/api/audio/analyze/<jobId>` every 2s.
5. RunPod runs the pod action: downloads `audio/track.mp3` from R2, runs librosa, computes 32 boundaries.
6. Pod returns the plan. Worker normalizes snake → camel, sends back.
7. UI displays "124 BPM · 32 shots".
8. User clicks "apply to storyboard". `state.storyboard.scenes[0..31]` get `target_seconds`, `start`, `end` from `timedScenes`. UI re-renders the scene timeline.
9. User submits render normally. Each scene's `target_seconds` ends up in the bundle's `storyboard.yaml`. The pod renders each clip to spec. Final MP4 has clips landing on the downbeats.

## Bonus (nice-to-have, not 1.0-blocking)

- Cache analysis results per `audioKey + clipSeconds + mode` in D1 (small KV-shape table). A user tweaking the planner shouldn't re-run librosa every time.
- Surface tempo + beat count in the storyboard YAML metadata block so the planner LLM can reference them on subsequent refinement turns ("the track is 124 BPM, structure this section more rhythmically").

That's the full Worker spec. The pod action is live in `vivijure-serverless 0.4.59` already — once the image rolls out, the only thing between this and a working beat-sync is the routes above.
