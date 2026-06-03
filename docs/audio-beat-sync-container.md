# Audio beat-sync — Cloudflare Container backend spec

Supersedes the pod-action backend in `audio-beat-sync.md`. The pod path
was reverted (`vivijure-serverless 0.4.60`) because spinning a GPU
worker to read an MP3 is wasteful. This spec replaces it with a CPU-
only Cloudflare Container, owned by this repo, that the planner Worker
calls synchronously.

The Worker-facing API shape (`POST /api/audio/analyze`, the response
schemas, planner UI hooks) from `audio-beat-sync.md` stays valid; only
the backend swaps. One simplification: the analysis is fast enough
(typically 1-3s, worst case ~10s) that we drop the jobId/poll dance
and return the plan inline.

## What changed vs. the original spec

| Concern | Original (pod) | This (container) |
| --- | --- | --- |
| Backend | RunPod `analyze_audio` action | CF Container DO |
| Latency | 10-60s incl. cold start | 1-3s warm, 8-12s cold |
| Worker contract | submit + poll | single synchronous POST |
| Worker code reuse | `submitRunpodJob` | `getContainer().fetch` |
| Cost per call | GPU per-minute billing | Container CPU-minutes only |

The Worker-side files that change shrink to one route handler. No new
poll path, no D1 row.

## Repo layout

```
skyphusion-llm-public/
  containers/
    audio-beat-sync/
      Dockerfile
      pyproject.toml          # or requirements.txt; see below
      app.py                  # the HTTP service
      .dockerignore
  src/
    containers/
      audio-beat-sync.ts      # Container DO wrapper
  wrangler.example.toml       # binding + migration entry
  docs/
    audio-beat-sync.md        # original; mark backend pivoted
    audio-beat-sync-container.md  # this file
```

## Container image

### `containers/audio-beat-sync/Dockerfile`

```dockerfile
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NUMBA_CACHE_DIR=/tmp/numba-cache \
    MPLCONFIGDIR=/tmp/mpl-cache \
    LIBROSA_CACHE_DIR=/tmp/librosa-cache \
    HF_HUB_OFFLINE=1 \
    PORT=8000

# libsndfile is required by soundfile (librosa's IO backend); ffmpeg
# covers MP3/AAC/OGG decode. libgomp1 is OpenMP runtime that numpy /
# numba link against on some musl images; included for parity.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libsndfile1 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app.py .

# Eager-load librosa during build so the first request does NOT pay the
# numba JIT cost. Caches land in NUMBA_CACHE_DIR; at runtime the dir
# must be writable (it is in /tmp; the CF runtime gives /tmp).
RUN python -c "import librosa, numpy; librosa.beat.beat_track(y=numpy.zeros(22050, dtype='float32'), sr=22050); print('warm OK')"

EXPOSE 8000
CMD ["python", "app.py"]
```

### `containers/audio-beat-sync/requirements.txt`

```
librosa==0.10.2
numpy==1.26.4
soundfile==0.12.1
# Tiny HTTP server; stdlib http.server is fine too but aiohttp keeps the
# handler async-friendly for follow-up work (parallel downloads etc.)
aiohttp==3.10.5
```

Pin numpy to 1.26.x; librosa 0.10 has not validated against numpy 2.x
in all branches and the savings from un-pinning are zero. madmom is
deliberately NOT included; librosa's `beat_track` is good enough for
the planner UI and avoids the C++ build chain.

### `containers/audio-beat-sync/app.py`

Single file, ~120 lines. Public sketch (the writer should fill in the
glue; everything that matters for correctness is here):

```python
import asyncio, json, logging, os, tempfile
from aiohttp import web, ClientSession, ClientTimeout
import librosa, numpy as np

PORT = int(os.environ.get("PORT", "8000"))
DOWNLOAD_TIMEOUT_S = 30
MAX_AUDIO_BYTES = 64 * 1024 * 1024  # 64 MB upper bound

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audio-beat-sync")

async def health(_req):
    # Cheap. Does NOT touch librosa. Used by the container runtime for
    # readiness; if this returns 200 the DO can route traffic.
    return web.json_response({"ok": True})

async def analyze(req):
    body = await req.json()
    audio_url   = body.get("audioUrl")
    audio_key   = body.get("audioKey", "")  # echoed back; not used for fetch
    clip_s      = float(body.get("clipSeconds", 8.0))
    mode        = body.get("mode", "beat")
    min_scene_s = float(body.get("minSceneS", 2.5))
    max_scene_s = float(body.get("maxSceneS", 12.0))
    force_shots = body.get("forceShots")
    if not audio_url or clip_s <= 0 or mode not in ("beat", "duration"):
        return web.json_response({"ok": False, "error": "bad input"}, status=400)

    # Stream the audio bytes into a tempfile. The container has no R2
    # binding; the Worker presigns a GET URL and passes it in.
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as fh:
        path = fh.name
    try:
        async with ClientSession(timeout=ClientTimeout(total=DOWNLOAD_TIMEOUT_S)) as s:
            async with s.get(audio_url) as r:
                if r.status != 200:
                    return web.json_response({"ok": False, "error": f"audio fetch {r.status}"}, status=502)
                total = 0
                with open(path, "wb") as out:
                    async for chunk in r.content.iter_chunked(64 * 1024):
                        total += len(chunk)
                        if total > MAX_AUDIO_BYTES:
                            return web.json_response({"ok": False, "error": "audio too large"}, status=413)
                        out.write(chunk)

        # librosa.load is sync + CPU; offload to default executor.
        loop = asyncio.get_running_loop()
        plan = await loop.run_in_executor(None, _compute, path, clip_s, mode, min_scene_s, max_scene_s, force_shots, audio_key)
        return web.json_response({"ok": True, **plan})
    finally:
        try: os.unlink(path)
        except FileNotFoundError: pass

def _compute(path, clip_s, mode, min_s, max_s, force_shots, audio_key):
    y, sr = librosa.load(path, sr=22050, mono=True)
    duration_s = float(len(y)) / sr
    if mode == "duration":
        n = int(force_shots) if force_shots else max(1, int(round(duration_s / clip_s)))
        return {
            "mode": "duration",
            "audio_key": audio_key,
            "duration_seconds": duration_s,
            "suggested_shots": n,
            "clip_seconds": clip_s,
            "film_seconds": duration_s,
            "remainder_seconds": 0.0,
            "timed_scenes": [],
            "note": f"Duration sync · {n} shots × {clip_s:.1f}s.",
        }
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
    # Pick boundaries: walk beats; advance a boundary whenever the
    # accumulated span crosses clip_s, clamped to [min_s, max_s].
    scenes, span_start = [], 0.0
    for t in beat_times + [duration_s]:
        if (t - span_start) >= clip_s and (t - span_start) >= min_s:
            scenes.append({"start": span_start, "end": t})
            span_start = t
        elif (t - span_start) >= max_s:
            scenes.append({"start": span_start, "end": t})
            span_start = t
    if span_start < duration_s and not scenes:
        scenes.append({"start": 0.0, "end": duration_s})
    elif span_start < duration_s:
        scenes[-1]["end"] = duration_s  # absorb tail into last shot
    timed = [{"index": i, "start": s["start"], "end": s["end"], "target_seconds": round(s["end"] - s["start"], 3)} for i, s in enumerate(scenes)]
    bpm = float(tempo)
    return {
        "mode": "beat",
        "audio_key": audio_key,
        "duration_seconds": duration_s,
        "bpm": bpm,
        "beat_count": len(beat_times),
        "suggested_shots": len(timed),
        "clip_seconds": clip_s,
        "film_seconds": duration_s,
        "remainder_seconds": 0.0,
        "timed_scenes": timed,
        "note": f"Beat sync · {bpm:.0f} BPM · {len(beat_times)} beats → {len(timed)} shots (boundaries on downbeats).",
    }

app = web.Application()
app.router.add_get("/health", health)
app.router.add_post("/analyze", analyze)

if __name__ == "__main__":
    log.info("audio-beat-sync listening on 0.0.0.0:%d", PORT)
    web.run_app(app, host="0.0.0.0", port=PORT, access_log=None)
```

Hard requirements baked in above:

- Bind `0.0.0.0:8000`, not `127.0.0.1`. The CF Container runtime cannot reach `localhost`; the rembg attempt failed partly on this.
- `NUMBA_CACHE_DIR=/tmp/numba-cache` set in the env block. librosa's tempo path JITs through numba; without a writable cache dir it crashes inside the worker with a non-obvious "/dev/shm missing or read-only" error. `/tmp` is always writable in the CF runtime.
- Eager warmup `RUN python -c "...librosa.beat.beat_track..."` at image build time. Knocks ~3s off the first-request latency.
- A cheap `/health` endpoint that does NOT touch librosa. Readiness probes that pull librosa make the container look slow to start.

## Worker side — Durable Object wrapper

### `src/containers/audio-beat-sync.ts`

```ts
import { Container } from "@cloudflare/containers";

export class AudioBeatSyncContainer extends Container {
  defaultPort = 8000;
  sleepAfter = "10m";              // idle eviction
  enableInternet = true;           // needs to reach R2 over the public S3 endpoint
  instanceGetTimeoutMS = 60_000;   // cold-start budget
  portReadyTimeoutMS = 30_000;     // bind + librosa import time

  // No custom fetch override needed; Container's default proxies the
  // request to defaultPort. Routes inside the container (/health,
  // /analyze) are reachable via `await getContainer(stub).fetch(...)`.
}
```

### `wrangler.example.toml` additions

```toml
[[containers]]
class_name = "AudioBeatSyncContainer"
image = "./containers/audio-beat-sync"
max_instances = 3                # planner usage is bursty + sparse
instance_type = "standard"       # 4 GB RAM is overkill but standard is the cheapest tier with the libsndfile baseline

[[migrations]]
tag = "v0.106.0"                 # bump per your migration numbering
new_classes = ["AudioBeatSyncContainer"]

[[durable_objects.bindings]]
name = "AUDIO_BEAT_SYNC"
class_name = "AudioBeatSyncContainer"
```

### `src/index.ts` route

Replace `handleAudioAnalyzeSubmit` + `handleAudioAnalyzePoll` (from the
original pod spec) with a single synchronous handler:

```ts
// POST /api/audio/analyze
if (url.pathname === "/api/audio/analyze" && request.method === "POST") {
  return handleAudioAnalyze(request, env);
}
```

```ts
async function handleAudioAnalyze(request: Request, env: Env): Promise<Response> {
  const userEmail = getUserEmail(request);
  let body: AudioAnalyzeRequest;
  try {
    body = await request.json<AudioAnalyzeRequest>();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.audioKey !== "string" || body.audioKey.length === 0) {
    return json({ ok: false, error: "audio_key required" }, { status: 400 });
  }
  if (!/^(audio|out)\/.+/.test(body.audioKey)) {
    return json({ ok: false, error: "audioKey must be an audio/ or out/ R2 key" }, { status: 400 });
  }
  if (body.clipSeconds !== undefined && (typeof body.clipSeconds !== "number" || body.clipSeconds <= 0)) {
    return json({ ok: false, error: "clipSeconds must be a positive number" }, { status: 400 });
  }
  if (body.mode !== undefined && body.mode !== "beat" && body.mode !== "duration") {
    return json({ ok: false, error: "mode must be 'beat' or 'duration'" }, { status: 400 });
  }

  // Reuse the existing audio-routing helper: an out/ key on env.R2
  // gets cross-bucket-copied to audio/ on env.R2_RENDERS first, so the
  // presign target is always the GPU-bucket key. (Same path the render
  // submit uses.)
  let audioKey: string;
  try {
    audioKey = await placeAudioForGpu(env, body.audioKey, userEmail);
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  const head = await env.R2_RENDERS.head(audioKey);
  if (!head) {
    return json({ ok: false, error: `audio key not found: ${audioKey}` }, { status: 404 });
  }

  // Presign a short-lived GET URL the container will fetch over the
  // public S3 endpoint. The container has no R2 binding and that's
  // intentional; presigning keeps the credential surface on the
  // Worker.
  const audioUrl = await presignR2Get(env, audioKey, 120 /* seconds */);

  const id = env.AUDIO_BEAT_SYNC.idFromName("singleton");
  const stub = env.AUDIO_BEAT_SYNC.get(id);
  const containerResp = await stub.fetch("https://container/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      audioUrl,
      audioKey,
      clipSeconds:   body.clipSeconds ?? 8.0,
      mode:          body.mode ?? "beat",
      minSceneS:     body.minSceneS ?? 2.5,
      maxSceneS:     body.maxSceneS ?? 12.0,
      forceShots:    body.forceShots,
    }),
  });
  if (!containerResp.ok) {
    const text = await containerResp.text().catch(() => "");
    return json({ ok: false, error: `container ${containerResp.status}: ${text.slice(0, 200)}` }, { status: 502 });
  }
  const raw = await containerResp.json<Record<string, unknown>>();
  const plan = parseAudioBeatPlan(raw);
  if (!plan) {
    return json({ ok: false, error: "could not parse container output", raw }, { status: 502 });
  }
  return json({ ok: true, output: plan });
}
```

`parseAudioBeatPlan` from the original spec is unchanged; the
container intentionally emits the snake_case shape the pod was going
to emit, so the parser is identical.

`presignR2Get` is one helper to write. The pattern is the same as
S3's `GetObject` presign; Cloudflare's R2 supports the S3-compatible
SigV4 signing. If we don't already have it, this is the moment to add
it; reuse opportunity in future container work.

## Idle behavior

`sleepAfter = "10m"` is conservative. A user opening the planner,
analyzing once, and walking away should not keep an instance alive.
Cold start budget after sleep: 8-12s for image pull + librosa eager
import. Acceptable for a planner-time action.

`max_instances = 3` caps concurrency. The planner UI is single-tab per
user; three covers two concurrent users without queuing and limits
runaway spend if the route gets hammered.

## Tests

`tests/audio-analyze.test.ts`:

1. `parseAudioBeatPlan` — exhaustive cases (beat-mode, duration-mode,
   malformed, missing fields). Unchanged from original spec.
2. Route validation: missing audioKey, bad mode, bad clipSeconds → 400;
   non-existent R2 key → 404; container 5xx → 502 with body slice.
3. End-to-end with the container mocked: stub `env.AUDIO_BEAT_SYNC.get`
   to return a fake stub whose `fetch` returns a canned response.

The container's `app.py` does NOT need vitest tests; verify it with a
Python smoke at build time and a manual `curl` against a deployed
preview. (The build-time warmup `RUN` already exercises the library.)

## Failure modes specifically learned from the rembg attempt

These are the bites we left teeth marks in:

1. **`/dev/shm` missing or read-only**: rembg's numba paths blew up on
   this. librosa hits numba too. Mitigation: `NUMBA_CACHE_DIR=/tmp/...`
   in the Dockerfile env block (done above). Do NOT rely on /dev/shm.

2. **Instances "healthy" but never "active"**: was a port + log issue.
   Mitigations: (a) bind 0.0.0.0, (b) make `/health` cheap (does NOT
   import librosa), (c) `portReadyTimeoutMS: 30_000` so the runtime
   actually waits for the bind, (d) write a startup log line BEFORE
   `web.run_app` so we can see it landed.

3. **Pillow / numpy version conflicts**: pin numpy 1.26.x; don't lazy
   `pip install` at runtime. Build-time only.

4. **Container can't reach R2**: `enableInternet = true` is required,
   AND R2 access goes via the public S3 endpoint with a presigned URL.
   Do NOT try to wire an R2 binding to the container; the binding lives
   on the Worker.

5. **Cold start hidden behind a 30s gateway timeout**: the route is
   sync. If the container is asleep, the Worker fetch waits the full
   cold start + analysis. With `instanceGetTimeoutMS: 60_000` we have
   slack. If we ever see real cold-start pain in production, switch to
   a fire-and-poll shape — but only then.

## End-to-end flow (revised)

1. User uploads `audio/track.mp3` via the soundtrack uploader.
2. User clicks "analyze beats", `clipSeconds = 4`.
3. Worker validates input, places audio on `env.R2_RENDERS`, presigns
   a 120s GET URL.
4. Worker calls `AUDIO_BEAT_SYNC` container with `{audioUrl, ...}`.
5. Container downloads the MP3 over HTTP, runs `librosa.beat.beat_track`,
   computes boundaries, returns the plan.
6. Worker normalizes + returns `{ok: true, output: AudioBeatPlan}`
   synchronously.
7. UI shows "124 BPM · 32 shots", offers "apply to storyboard".

## Open questions for the implementer

- Do we want to cache analysis results in D1 keyed by
  `audioKey + clipSeconds + mode`? Cheap insurance against repeat
  clicks; defer to a follow-up unless it's trivial alongside the
  presign helper.
- The original spec called for `STORYBOARD_MAX_SCENES` clamping on
  `suggested_shots`; keep that check in the UI layer, NOT the
  container. Container stays config-free per the no-config-on-image
  rule (applies to GPU and CPU images alike).

That's the spec. One container image, one DO wrapper, one Worker
route, one parser reused from the original spec. The other session
can implement straight from here.
