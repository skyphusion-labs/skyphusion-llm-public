# Render contract API

Advanced users can drive the GPU render pipeline directly over HTTP, instead of
clicking through the planner UI. You POST a render **contract** (a JSON body of
the same fields the planner sends) and the control plane validates it, submits it
to the RunPod endpoint, and **tracks it in your History** like any other render.

This is the same endpoint the UI uses (`POST /api/storyboard/render`), so a
contract you fire by curl shows up in the planner's History, polls to COMPLETED,
and supports the off-GPU audio/narration mux afterward, exactly like a UI render.

## Authentication

Every route is behind Cloudflare Access, and renders are scoped to the
authenticated email (`Cf-Access-Authenticated-User-Email`). Two ways to satisfy
it from a script:

- **JWT (quick, interactive):** grab a short-lived token and pass it as a header.
  ```bash
  TOKEN=$(cloudflared access token --app https://skyphusion.org)
  curl -H "cf-access-token: $TOKEN" https://skyphusion.org/api/storyboard/renders
  ```
- **Service token (headless, long-lived):** create a Cloudflare Access service
  token, allow it on the app, and send both headers. Best for cron / CI.
  ```bash
  curl -H "CF-Access-Client-Id: <id>.access" \
       -H "CF-Access-Client-Secret: <secret>" \
       https://skyphusion.org/api/storyboard/renders
  ```

All examples below use `$TOKEN` (the JWT form) for brevity.

## Submit a render

`POST /api/storyboard/render` with a JSON contract. Only `bundleKey` is required;
everything else falls back to the pod's compiled defaults. The bundle must
already exist in R2 (the planner writes it at bundle time, under
`bundles/<project>.tar.gz`).

### Fields

| field | type | notes |
|---|---|---|
| `bundleKey` | string (required) | R2 key of the project bundle, e.g. `bundles/my_project.tar.gz` |
| `project` | string | display label; derived from `bundleKey` if omitted |
| `qualityTier` | `"draft" \| "standard" \| "final"` | default `final`. draft = 4-step distilled; standard = 8-step keyframe + 20-step EasyCache i2v (the middle); final = 30-step keyframe + 40-step MixCache i2v. (`keyframesOnly: true` for the fast keyframe-only preview.) |
| `keyframesOnly` | boolean | SDXL keyframes only, skip Wan I2V + assembly (fast preview) |
| `renderOverrides` | object | freeform pod render overrides, e.g. `{ "seed": 202 }` |
| `audioKey` | string | R2 key of an audio bed to mux; a MiniMax `out/<uuid>.mp3` is cross-bucket-copied for you |
| `castLoras` | object | `{ "A": <cast_id>, "B": <cast_id> }`; resolved to trained-LoRA keys so a ready cast is reused (no retrain) |
| `multiCharacterOverrides` | object | engine, pose conditioning + geometry, scales (see the planner's multi-character panel) |
| `wanDiffusionOverrides` | object | I2V knobs incl. `wan_negative_prompt`, `num_frames`, guidance |
| `loraTrainOverrides`, `qualityGateOverrides`, `consistencyOverrides`, `continuityOverrides`, `faceLockOverrides`, `adetailerOverrides`, ... | object | the full override surface; each block routes to the matching pod config block |
| `projectId` | number | optional FK to one of your storyboard projects (must be yours) |

The server validates each block (out-of-range values are dropped or 400'd) and
forwards the rest. The response is `{ ok, jobId, statusRaw, ... }`.

### Examples

Keyframes-only preview:
```bash
curl -X POST https://skyphusion.org/api/storyboard/render \
  -H "cf-access-token: $TOKEN" -H "content-type: application/json" \
  -d '{ "project": "my_project", "bundleKey": "bundles/my_project.tar.gz",
        "qualityTier": "draft", "keyframesOnly": true,
        "renderOverrides": { "seed": 202 } }'
```

Full multi-character render with pose conditioning + a muxed track, reusing a
ready cast:
```bash
curl -X POST https://skyphusion.org/api/storyboard/render \
  -H "cf-access-token: $TOKEN" -H "content-type: application/json" \
  -d '{
    "project": "my_project",
    "bundleKey": "bundles/my_project.tar.gz",
    "qualityTier": "final",
    "renderOverrides": { "seed": 202 },
    "audioKey": "out/9d863853-....mp3",
    "castLoras": { "A": 8, "B": 7 },
    "multiCharacterOverrides": {
      "engine": "regional", "mode": "auto", "pose_conditioning": true,
      "lora_scale_per_slot": 0.3, "ip_adapter_scale_per_slot": 0.7,
      "controlnet_conditioning_scale": 0.85,
      "pose_inset_frac": 0.18, "pose_gap_frac": 0.06, "pose_fig_width_frac": 1.0,
      "pose_negative": "third figure, extra person"
    },
    "wanDiffusionOverrides": {
      "wan_negative_prompt": "centaur, extra legs, quadruped, deformed legs, blurry, low quality"
    }
  }'
```

## Poll a render

`GET /api/storyboard/render/<jobId>` returns the live status (it resolves against
RunPod and updates the History row). Or just open the planner's History tab; the
row appears there and auto-refreshes.

## Adopt a job submitted outside the Worker

If you fired a job **straight at the RunPod endpoint** (bypassing this API), the
control plane never recorded it, so it will not appear in History. Adopt it:

```bash
curl -X POST https://skyphusion.org/api/storyboard/renders/adopt \
  -H "cf-access-token: $TOKEN" -H "content-type: application/json" \
  -d '{ "jobId": "<runpod-job-id>", "project": "my_project",
        "bundleKey": "bundles/my_project.tar.gz", "qualityTier": "final",
        "mode": "full" }'
```

This inserts a SUBMITTED row scoped to you; the normal poll/resolve flow fills in
status, output_key, duration, and keyframes from RunPod. The adopted row is
project-less, so it shows in History under your active project (via the loose-row
union) or when no project is selected. `jobId` is the only required field.

Adopt is **idempotent**: re-adopting the same `jobId` updates the existing row
instead of inserting a duplicate.

### Backfilling a finished render (job already aged out of RunPod)

RunPod ages completed jobs out of its status cache after a while, so the
poll-based resolve above only works while the job is recent. If the render
already finished and its MP4 is sitting in R2, pass the **`outputKey`** directly
and the row is marked COMPLETED pointing straight at it (no RunPod round-trip):

```bash
curl -X POST https://skyphusion.org/api/storyboard/renders/adopt \
  -H "cf-access-token: $TOKEN" -H "content-type: application/json" \
  -d '{ "jobId": "<runpod-job-id>", "project": "my_project",
        "outputKey": "renders/my_project/full-<hash>.mp4",
        "seconds": 42.4, "hasAudio": true, "mode": "full" }'
```

`outputKey` + optional `seconds` / `hasAudio` populate the row so it plays in
History immediately. (The MP4 must be stamped with your `user_email` for the
artifact route to serve it; renders submitted through this API are stamped
automatically.)

## History note

Renders submitted by the contract API (or adopted) have no active project, so
they used to hide whenever a project was selected in the planner. As of v0.138.0
the History list unions these loose rows with the active project's, so API
renders are always visible without clearing your project first.
