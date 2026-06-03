// Video-finish orchestration (v0.120.0).
//
// Presigns the per-shot clips + optional soundtrack (R2 GET) and the final MP4
// (R2 PUT), then calls the VIDEO_FINISH Cloudflare Container's /finish endpoint
// with a cold-start guard. The container does the ffmpeg work (concat / xfade /
// audio mux); bytes never touch the Worker. Mirrors the bundle-assembler
// callImagePrep pattern. Pure-ish: only touches env (presign + container stub).

import type { Env } from "./env";
import { presignR2Get, presignR2Put } from "./r2-presign";

export interface VideoFinishClip {
  key: string;
  targetSeconds?: number;
}

export interface VideoFinishInput {
  clips: VideoFinishClip[];
  audioKey?: string;
  outputKey: string;
  width?: number;
  height?: number;
  fps?: number;
  crf?: number;
  preset?: string;
  crossfade?: number;
  trimJoinFrames?: number;
}

const MAX_CLIPS = 80;

// Validate a /api/video/finish request body. Keeps the route handler thin and
// gives the unit tests a pure target.
export function parseVideoFinishInput(
  raw: unknown,
): { ok: true; value: VideoFinishInput } | { ok: false; errors: string[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["body must be an object"] };
  }
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.clips) || o.clips.length === 0) {
    return { ok: false, errors: ["clips must be a non-empty array"] };
  }
  if (o.clips.length > MAX_CLIPS) {
    return { ok: false, errors: [`too many clips (>${MAX_CLIPS})`] };
  }
  const clips: VideoFinishClip[] = [];
  for (let i = 0; i < o.clips.length; i++) {
    const c = o.clips[i];
    // Accept either a bare R2 key string or { key, targetSeconds }.
    if (typeof c === "string") {
      if (!c) return { ok: false, errors: [`clips[${i}] is empty`] };
      clips.push({ key: c });
      continue;
    }
    if (c === null || typeof c !== "object") {
      return { ok: false, errors: [`clips[${i}] must be a key string or {key, targetSeconds}`] };
    }
    const key = (c as { key?: unknown }).key;
    if (typeof key !== "string" || !key) {
      return { ok: false, errors: [`clips[${i}].key must be a non-empty string`] };
    }
    const ts = (c as { targetSeconds?: unknown }).targetSeconds;
    const clip: VideoFinishClip = { key };
    if (ts !== undefined) {
      if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
        return { ok: false, errors: [`clips[${i}].targetSeconds must be a positive number`] };
      }
      clip.targetSeconds = ts;
    }
    clips.push(clip);
  }
  if (typeof o.outputKey !== "string" || !o.outputKey) {
    return { ok: false, errors: ["outputKey must be a non-empty string"] };
  }
  const out: VideoFinishInput = { clips, outputKey: o.outputKey };
  if (o.audioKey !== undefined) {
    if (typeof o.audioKey !== "string" || !o.audioKey) {
      return { ok: false, errors: ["audioKey must be a non-empty string when provided"] };
    }
    out.audioKey = o.audioKey;
  }
  for (const k of ["width", "height", "fps", "crf", "crossfade", "trimJoinFrames"] as const) {
    const v = o[k];
    if (v !== undefined) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return { ok: false, errors: [`${k} must be a non-negative number`] };
      }
      out[k] = v;
    }
  }
  if (o.preset !== undefined) {
    if (typeof o.preset !== "string") {
      return { ok: false, errors: ["preset must be a string"] };
    }
    out.preset = o.preset;
  }
  return { ok: true, value: out };
}

// Map the pod's off-GPU finish manifest (rp_handler's job output, snake_case)
// into a VideoFinishInput. Returns null if the manifest is unusable (no clips /
// no output_key). The pod sets output_key to the DESIRED final key. finish_params
// is snake_case (trim_join_frames); we translate to the container's camelCase.
export function finishInputFromPodOutput(out: Record<string, unknown>): VideoFinishInput | null {
  const clipsRaw = out.clips;
  const outputKey = out.output_key;
  if (!Array.isArray(clipsRaw) || clipsRaw.length === 0) return null;
  if (typeof outputKey !== "string" || !outputKey) return null;
  const clips: VideoFinishClip[] = [];
  for (const c of clipsRaw) {
    if (!c || typeof c !== "object") return null;
    const key = (c as { key?: unknown }).key;
    if (typeof key !== "string" || !key) return null;
    const clip: VideoFinishClip = { key };
    const ts = (c as { target_seconds?: unknown }).target_seconds;
    if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) clip.targetSeconds = ts;
    clips.push(clip);
  }
  const input: VideoFinishInput = { clips, outputKey };
  if (typeof out.audio_key === "string" && out.audio_key) input.audioKey = out.audio_key;
  const fp = (out.finish_params && typeof out.finish_params === "object" && !Array.isArray(out.finish_params)
    ? (out.finish_params as Record<string, unknown>)
    : {});
  const n = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  if (n(fp.width) !== undefined) input.width = fp.width as number;
  if (n(fp.height) !== undefined) input.height = fp.height as number;
  if (n(fp.fps) !== undefined) input.fps = fp.fps as number;
  if (n(fp.crf) !== undefined) input.crf = fp.crf as number;
  if (n(fp.crossfade) !== undefined) input.crossfade = fp.crossfade as number;
  if (n(fp.trim_join_frames) !== undefined) input.trimJoinFrames = fp.trim_join_frames as number;
  if (typeof fp.preset === "string") input.preset = fp.preset;
  return input;
}

// Call the container's /finish with the same cold-start guard as callImagePrep:
// a cheap /health warms the bind window, then retry the heavy /finish on a 503.
// Returns the container Response, or null on a network error.
export async function callVideoFinish(
  env: Env,
  payload: unknown,
  opts: { retries?: number; backoffMs?: number } = {},
): Promise<Response | null> {
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1500;
  const stub = env.VIDEO_FINISH.get(env.VIDEO_FINISH.idFromName("singleton"));
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
  try {
    await stub.fetch("https://container/health");
  } catch {
    /* best effort; the retry loop below still covers a cold start */
  }
  let resp: Response | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      resp = await stub.fetch("https://container/finish", init);
    } catch {
      resp = null;
    }
    if (resp && resp.status !== 503) return resp;
    if (attempt < retries - 1) {
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  return resp;
}

// Presign every input/output and drive the container. Presign TTL is generous
// (the ffmpeg encode of a long film can take a while) but still short-lived.
export async function runVideoFinish(
  env: Env,
  input: VideoFinishInput,
  opts: { ttlSeconds?: number; retries?: number; backoffMs?: number } = {},
): Promise<{ ok: true; result: unknown } | { ok: false; status: number; error: string }> {
  const ttl = opts.ttlSeconds ?? 900;
  const clipUrls = await Promise.all(
    input.clips.map(async (c) => ({
      url: await presignR2Get(env, c.key, ttl),
      ...(c.targetSeconds !== undefined ? { targetSeconds: c.targetSeconds } : {}),
    })),
  );
  const audioUrl = input.audioKey ? await presignR2Get(env, input.audioKey, ttl) : undefined;
  const outputUrl = await presignR2Put(env, input.outputKey, ttl);

  const payload = {
    clips: clipUrls,
    ...(audioUrl ? { audioUrl } : {}),
    outputUrl,
    outputKey: input.outputKey,
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
    ...(input.fps !== undefined ? { fps: input.fps } : {}),
    ...(input.crf !== undefined ? { crf: input.crf } : {}),
    ...(input.preset !== undefined ? { preset: input.preset } : {}),
    ...(input.crossfade !== undefined ? { crossfade: input.crossfade } : {}),
    ...(input.trimJoinFrames !== undefined ? { trimJoinFrames: input.trimJoinFrames } : {}),
  };

  const resp = await callVideoFinish(env, payload, opts);
  if (!resp) {
    return { ok: false, status: 502, error: "video-finish container unreachable" };
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    const text = await resp.text().catch(() => "");
    return { ok: false, status: 502, error: `non-JSON from container (status ${resp.status}): ${text.slice(0, 300)}` };
  }
  if (!resp.ok || (body as { ok?: boolean })?.ok === false) {
    const err = (body as { error?: string })?.error || `container status ${resp.status}`;
    return { ok: false, status: resp.status === 200 ? 500 : resp.status, error: err };
  }
  return { ok: true, result: body };
}
