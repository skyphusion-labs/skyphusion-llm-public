// RunPod serverless submit / poll helpers (v0.32.0).
//
// Pure URL + payload builders + response normalizer plus a thin dispatcher
// that calls fetch. The dispatcher is not unit-tested (it would require
// mocking the fetch global); the pure helpers are tested in their own file
// and the dispatcher mirrors them. Reuses the project's "no zod / ajv at
// runtime, hand-authored types" convention from src/env.ts.
//
// The vivijure-serverless GPU worker is a RunPod queue-based endpoint. The
// job input shape is fixed in rp_handler.py:
//
//   { "project": "<name>", "bundle_key": "bundles/<name>.tar.gz",
//     "quality_tier": "draft|standard|final", "render_overrides": {...} }
//
// RunPod wraps this in `{ "input": {...} }` on submit. Polling returns an
// envelope { id, status, output?, error?, executionTime?, delayTime? }.

import type { Env } from "./env";

// What the planner / UI sends to /api/storyboard/render.
export interface RenderSubmitArgs {
  // Project slug; if omitted, derived from bundleKey by stripping prefix.
  project?: string;
  bundleKey: string;
  qualityTier?: "draft" | "standard" | "final";
  renderOverrides?: Record<string, unknown>;
}

// What the vivijure-serverless rp_handler.py reads off the job input. Field
// names mirror the Python side (snake_case) so any change there propagates
// here without a layer of remapping.
export interface RenderJobInput {
  project: string;
  bundle_key: string;
  quality_tier: "draft" | "standard" | "final";
  render_overrides?: Record<string, unknown>;
}

// RunPod queue-based job status. The platform uses these literal strings
// across submit / poll / cancel responses. Anything else surfaces as the
// raw string in `statusRaw` so the UI can show it without us silently
// dropping a new RunPod-side state.
export type RunpodStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

// Normalized response shape returned by both submit and poll. `output` /
// `error` populate per RunPod's envelope; `executionTime` and `delayTime`
// are pass-throughs (milliseconds, integers) when RunPod returns them.
export interface RunpodJobView {
  jobId: string;
  status: RunpodStatus;
  statusRaw: string;
  output?: unknown;
  error?: string;
  executionTimeMs?: number;
  delayTimeMs?: number;
}

const RUNPOD_BASE = "https://api.runpod.ai";

// Bundle key shape (mirrors bundle-assembler.assembleBundle's output):
//   bundles/<projectName>.tar.gz
// Extracts <projectName> for the rp_handler `project` field when the caller
// did not provide one explicitly. Falls back to the full bundleKey when the
// shape does not match, which lets a caller stage a custom-keyed bundle
// outside the assembler and still submit it.
export function deriveProjectFromBundleKey(bundleKey: string): string {
  const m = bundleKey.match(/^bundles\/(.+)\.tar\.gz$/);
  if (m) return m[1];
  return bundleKey;
}

export function buildSubmitPayload(args: RenderSubmitArgs): { input: RenderJobInput } {
  const project =
    args.project && args.project.trim().length > 0
      ? args.project.trim()
      : deriveProjectFromBundleKey(args.bundleKey);
  const input: RenderJobInput = {
    project,
    bundle_key: args.bundleKey,
    quality_tier: args.qualityTier ?? "final",
  };
  if (args.renderOverrides && Object.keys(args.renderOverrides).length > 0) {
    input.render_overrides = args.renderOverrides;
  }
  return { input };
}

export function buildSubmitUrl(endpointId: string): string {
  return `${RUNPOD_BASE}/v2/${endpointId}/run`;
}

export function buildStatusUrl(endpointId: string, jobId: string): string {
  return `${RUNPOD_BASE}/v2/${endpointId}/status/${jobId}`;
}

export function buildCancelUrl(endpointId: string, jobId: string): string {
  return `${RUNPOD_BASE}/v2/${endpointId}/cancel/${jobId}`;
}

// Validate a job id at the route boundary so a malformed id does not
// produce a RunPod 404 we have to translate back. RunPod ids are
// alphanumeric with hyphens / underscores; the cap is generous since the
// platform has not published an exact format.
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidJobId(jobId: string): boolean {
  return JOB_ID_RE.test(jobId);
}

// Map RunPod's envelope to RunpodJobView. Tolerates missing fields and
// surfaces unknown status strings via `statusRaw`. Does not throw; the
// dispatcher decides how to translate transport errors to HTTP semantics.
export function normalizeRunpodResponse(raw: unknown): RunpodJobView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const jobId = typeof r.id === "string" ? r.id : "";
  const statusRaw = typeof r.status === "string" ? r.status : "";
  if (!jobId || !statusRaw) return null;
  const knownStatuses: RunpodStatus[] = [
    "IN_QUEUE",
    "IN_PROGRESS",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
  ];
  const status: RunpodStatus = knownStatuses.includes(statusRaw as RunpodStatus)
    ? (statusRaw as RunpodStatus)
    : "IN_PROGRESS"; // best-effort: keep the UI polling on unknown states
  const view: RunpodJobView = { jobId, status, statusRaw };
  if (r.output !== undefined) view.output = r.output;
  if (typeof r.error === "string" && r.error.length > 0) view.error = r.error;
  if (typeof r.executionTime === "number") view.executionTimeMs = r.executionTime;
  if (typeof r.delayTime === "number") view.delayTimeMs = r.delayTime;
  return view;
}

// Submit a job to the vivijure-serverless RunPod endpoint. Returns the
// normalized view or a transport error string. Does not throw on HTTP
// 4xx / 5xx; the caller decides how to translate to a Worker response.
export async function submitRenderJob(
  env: Env,
  args: RenderSubmitArgs,
): Promise<{ ok: true; view: RunpodJobView } | { ok: false; error: string; status?: number }> {
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) {
    return {
      ok: false,
      error:
        "RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID must be set on the Worker (npx wrangler secret put ...)",
    };
  }
  const url = buildSubmitUrl(env.RUNPOD_ENDPOINT_ID);
  const body = JSON.stringify(buildSubmitPayload(args));
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RUNPOD_API_KEY}`,
      },
      body,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `RunPod submit network error: ${m}` };
  }
  let raw: unknown;
  try {
    raw = await resp.json();
  } catch {
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      error: `RunPod submit returned non-JSON (status ${resp.status}): ${text.slice(0, 300)}`,
      status: resp.status,
    };
  }
  if (!resp.ok) {
    const errStr =
      raw && typeof raw === "object" && "error" in raw
        ? String((raw as Record<string, unknown>).error)
        : `HTTP ${resp.status}`;
    return { ok: false, error: `RunPod submit failed: ${errStr}`, status: resp.status };
  }
  const view = normalizeRunpodResponse(raw);
  if (!view) {
    return { ok: false, error: "RunPod submit returned an unrecognized envelope" };
  }
  return { ok: true, view };
}

// Poll one job's status. Same transport contract as submitRenderJob: never
// throws on HTTP errors; returns a normalized result for the caller to
// shape into a Worker response.
export async function pollRenderJob(
  env: Env,
  jobId: string,
): Promise<{ ok: true; view: RunpodJobView } | { ok: false; error: string; status?: number }> {
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_ENDPOINT_ID) {
    return {
      ok: false,
      error:
        "RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID must be set on the Worker (npx wrangler secret put ...)",
    };
  }
  const url = buildStatusUrl(env.RUNPOD_ENDPOINT_ID, jobId);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${env.RUNPOD_API_KEY}` },
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `RunPod poll network error: ${m}` };
  }
  let raw: unknown;
  try {
    raw = await resp.json();
  } catch {
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      error: `RunPod poll returned non-JSON (status ${resp.status}): ${text.slice(0, 300)}`,
      status: resp.status,
    };
  }
  if (!resp.ok) {
    const errStr =
      raw && typeof raw === "object" && "error" in raw
        ? String((raw as Record<string, unknown>).error)
        : `HTTP ${resp.status}`;
    return { ok: false, error: `RunPod poll failed: ${errStr}`, status: resp.status };
  }
  const view = normalizeRunpodResponse(raw);
  if (!view) {
    return { ok: false, error: "RunPod poll returned an unrecognized envelope" };
  }
  return { ok: true, view };
}
