// CF Container Durable Object wrapper for the rembg bg-removal service.
//
// The container itself lives under containers/rembg/ (Dockerfile +
// requirements.txt + main.py); it is a thin FastAPI service that
// accepts image bytes on POST /clean and returns the subject
// composited onto solid black. This wrapper exists so the Worker can
// call into it via env.REMBG_CONTAINER.getByName(...).fetch(...) the
// same way it would call any other fetch target.
//
// Why a Container instead of pod-side rembg at render time: the
// bg-removal step belongs at portrait WRITE time, not at render time.
// Worker calls this once when a portrait is uploaded or generated;
// the cleaned bytes get stored in R2; every subsequent render reads
// the already-cleaned portrait. Pod image stays lean, the regional
// render path is unchanged, and the rembg cost is paid once per
// portrait rather than once per render.
//
// Sleep / wake: sleepAfter is set conservatively at 5 minutes so a
// burst of portrait uploads (e.g., a user provisioning a new cast)
// shares one warm container, while idle gaps shut the instance down
// to avoid burning CPU-seconds. Cold start is ~3-5s (Python + model
// session init); warm hits are sub-second.

import { Container } from "@cloudflare/containers";
import type { Env } from "../env";

export class RembgContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";
}

// Helper that hides the Durable Object stub plumbing from the
// handlers. Pass raw image bytes (any format Pillow can decode),
// get back PNG bytes of the subject on solid black. Throws on
// non-2xx so callers can fail loudly.
export async function cleanPortrait(
  env: Env,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  // Single named instance keeps the warm container shared across all
  // portrait writes; we do not want one container per portrait or one
  // per user since the work is identical and tiny.
  const stub = env.REMBG_CONTAINER.getByName("singleton");
  const resp = await stub.fetch("https://internal/clean", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`rembg container ${resp.status}: ${detail.slice(0, 200)}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}
