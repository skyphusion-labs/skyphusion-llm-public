# Cast + character API

The cast builder (`/cast.html`) over HTTP: create characters, attach portraits and
reference photos, and train a per-character LoRA on the GPU. A trained cast is what
locks a character's identity into every keyframe of a render. For the UI flow see the
[walkthrough](./vivijure-walkthrough.md); for render submission see
[`render-api.md`](./render-api.md).

Authentication is the same as the other APIs (Cloudflare Access; a `cf-access-token`
JWT or a `CF-Access-Client-Id` / `CF-Access-Client-Secret` service token). Examples
use `$TOKEN`. Cast rows are scoped to the authenticated email.

## Where each call runs

| Concern | Runs on |
|---|---|
| Cast CRUD, portrait/refs/sources staging | the Worker (D1 + R2) |
| Portrait background removal | the `image-prep` container ([`containers.md`](./containers.md)) |
| LoRA training | the RunPod GPU (`vivijure-serverless`) |

A **cast row** carries: `id, user_email, name, bible?, portrait_key?, ref_keys:
[{key,mime}], source_keys: [{key,mime}], lora_status, lora_job_id?, lora_key?`.

## Stage a character reference image

`POST /api/storyboard/character-ref` -- upload an image to R2 for use as a planner /
bundle character reference. Raw binary body; `content-type` must be `image/png`,
`image/jpeg`, or `image/webp`; 16 MB max. Returns `{ key:
"character-refs/<uuid>.<ext>", mime, size, user }`. (This is the generic ref-staging
upload; the cast-scoped refs/sources routes below are how a saved cast member
accumulates its training + source images.)

## Cast members

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/cast` | list your cast |
| POST | `/api/cast` | create a member: `{ name (required), bible? }` -> `{ cast }` |
| GET / PATCH / DELETE | `/api/cast/:id` | get / update (name, bible) / delete |

The **bible** is the character description fed to both SDXL keyframe generation and
LoRA training, so make it concrete (face, hair, body, wardrobe, props, mood).

## Portrait, refs, and sources

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/cast/:id/portrait` | set the portrait (binary `image/png\|jpeg\|webp`, 16 MB). Background-removed via `image-prep`, content-addressed in R2 |
| DELETE | `/api/cast/:id/portrait` | clear the portrait |
| POST | `/api/cast/:id/refs` | add a **training reference** (binary, or JSON `{ from_chat_artifact }`). `ref_keys` is the LoRA training set derived from the portrait |
| DELETE | `/api/cast/:id/refs/:key` | remove one training ref |
| POST | `/api/cast/:id/sources` | add a **source photo** (binary, or JSON `{ from_chat_artifact }`). `source_keys` is the raw human reference material (your photo, a headshot) attached as FLUX.2 multi-reference inputs when the portrait generator runs |
| DELETE | `/api/cast/:id/sources/:key` | remove one source |

`refs` vs `sources`: **sources** are the raw material you provide; **refs** are the
LoRA training set (often generated from the saved portrait). Training needs a
portrait plus at least 8 refs.

## LoRA training

`POST /api/cast/:id/train-lora` -- kick off training on the GPU. Requires a
`portrait_key` and at least 8 `ref_keys`; refuses if a job is already in flight. The
control plane synthesizes a LoRA-only bundle from the portrait + refs
(`assembleBundle`) and submits it to RunPod.

| field | type | notes |
|---|---|---|
| `loraTrainOverrides` | object | hyperparams routed to the pod's training subprocess (`enable`, `min_images`, `max_images`, `trigger_pattern`, ...) |
| `qualityGateOverrides` | object | quality-gate eval settings (`enable`, `default_trigger`, `probe_lora_scale`, `base_seed`, ...) |

Response: `{ ok, jobId, status, statusRaw, bundleKey, loraDestKey, cast }`.

`GET /api/cast/:id/lora-status` -- poll. Returns `{ cast, view }` where `view` is the
RunPod job view (`{ jobId, status, output: { lora_key?, lora_size_bytes?, slot,
train? }, error? }`) or `null` if no job is in flight. On COMPLETED it harvests
`lora_key` onto the cast row and marks it ready; on FAILED/TIMED_OUT/CANCELLED it sets
`lora_status: "failed"` with the error.

```bash
# create -> portrait -> refs -> train -> poll
CID=$(curl -s -X POST https://skyphusion.org/api/cast \
  -H "cf-access-token: $TOKEN" -H "content-type: application/json" \
  -d '{ "name": "Vesper", "bible": "teal-haired runner, scarred jaw, ..." }' \
  | jq -r .cast.id)

curl -X POST "https://skyphusion.org/api/cast/$CID/portrait" \
  -H "cf-access-token: $TOKEN" -H "content-type: image/png" \
  --data-binary @vesper.png

curl -X POST "https://skyphusion.org/api/cast/$CID/train-lora" \
  -H "cf-access-token: $TOKEN" -H "content-type: application/json" -d '{}'

curl "https://skyphusion.org/api/cast/$CID/lora-status" -H "cf-access-token: $TOKEN"
```

Reuse a trained cast in a render by passing `castLoras` (e.g. `{ "A": <cast_id> }`) to
`POST /api/storyboard/render` (see [`render-api.md`](./render-api.md)); the control
plane resolves it to the trained-LoRA key so the cast is reused without retraining.
