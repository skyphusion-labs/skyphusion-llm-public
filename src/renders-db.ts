// Storyboard render history persistence (v0.34.0).
//
// One row per RunPod job submitted via POST /api/storyboard/render. The
// row is inserted at submit time and updated by the poll + cancel handlers
// with the latest status, output, error, and timing fields. GET /api/
// storyboard/renders lists the authenticated user's rows newest first.
//
// Ownership: user_email comes from cf-access-authenticated-user-email at
// submit time and is the filter key for the list endpoint. Poll / cancel
// proxy to RunPod regardless of DB state (so jobs submitted before
// v0.34.0 are still pollable directly via their jobId); the row UPDATE is
// a no-op when no row exists for that jobId. This keeps the existing
// stateless /api/storyboard/render flow working unchanged.

import type { Env } from "./env";
import type { RunpodJobView } from "./runpod-submit";

// Fresh row at submit time.
export interface NewRenderRow {
  userEmail: string;
  jobId: string;
  project: string;
  bundleKey: string;
  qualityTier: string;
  renderOverrides?: Record<string, unknown>;
  status: string;
}

// Shape returned to clients by /api/storyboard/renders. snake_case mirrors
// the DB column names so the UI does not double-normalize. output_json is
// parsed back to a JS object (or null when the row has none).
export interface RenderRow {
  id: number;
  user_email: string;
  job_id: string;
  project: string;
  bundle_key: string;
  quality_tier: string;
  render_overrides: Record<string, unknown> | null;
  status: string;
  output_key: string | null;
  output: unknown;
  error: string | null;
  execution_time_ms: number | null;
  delay_time_ms: number | null;
  submitted_at: number;
  updated_at: number;
  completed_at: number | null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

export async function insertRender(env: Env, row: NewRenderRow): Promise<void> {
  const now = nowSeconds();
  const overrides = row.renderOverrides ? JSON.stringify(row.renderOverrides) : null;
  await env.DB.prepare(
    `INSERT INTO renders (
      user_email, job_id, project, bundle_key, quality_tier,
      render_overrides, status, submitted_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO NOTHING`,
  )
    .bind(
      row.userEmail,
      row.jobId,
      row.project,
      row.bundleKey,
      row.qualityTier,
      overrides,
      row.status,
      now,
      now,
    )
    .run();
}

// Best-effort UPDATE from a poll / cancel response. No-op when no row
// exists for the jobId (matches the "back-compat for pre-v0.34.0 jobs"
// policy). Ownership is NOT checked here; the route handler enforces
// authn via Cloudflare Access at the edge and authz via user_email at
// the list endpoint.
export async function updateRenderFromView(env: Env, view: RunpodJobView): Promise<void> {
  const now = nowSeconds();
  const completed = TERMINAL_STATUSES.has(view.status) ? now : null;

  // Pull output_key out of the GPU side's COMPLETED envelope when present.
  let outputKey: string | null = null;
  if (
    view.output &&
    typeof view.output === "object" &&
    "output_key" in view.output
  ) {
    const v = (view.output as Record<string, unknown>).output_key;
    if (typeof v === "string" && v.length > 0) outputKey = v;
  }

  const outputJson = view.output !== undefined ? JSON.stringify(view.output) : null;

  await env.DB.prepare(
    `UPDATE renders SET
      status = ?,
      output_key = COALESCE(?, output_key),
      output_json = ?,
      error = ?,
      execution_time_ms = ?,
      delay_time_ms = ?,
      updated_at = ?,
      completed_at = COALESCE(?, completed_at)
    WHERE job_id = ?`,
  )
    .bind(
      view.status,
      outputKey,
      outputJson,
      view.error ?? null,
      view.executionTimeMs ?? null,
      view.delayTimeMs ?? null,
      now,
      completed,
      view.jobId,
    )
    .run();
}

export async function listRendersForUser(
  env: Env,
  userEmail: string,
  limit = 50,
): Promise<RenderRow[]> {
  // Clamp limit so a runaway client cannot drain the DB binding.
  const cap = Math.min(Math.max(1, Math.floor(limit)), 200);
  const result = await env.DB.prepare(
    `SELECT
      id, user_email, job_id, project, bundle_key, quality_tier,
      render_overrides, status, output_key, output_json AS output,
      error, execution_time_ms, delay_time_ms,
      submitted_at, updated_at, completed_at
    FROM renders
    WHERE user_email = ?
    ORDER BY submitted_at DESC
    LIMIT ?`,
  )
    .bind(userEmail, cap)
    .all();
  const rows = (result.results ?? []) as unknown as Array<Record<string, unknown>>;
  return rows.map(normalizeRow);
}

// D1 returns JSON columns as opaque strings; parse them back. A malformed
// stored JSON falls back to null (overrides) or the raw string (output) so
// a corrupted row never crashes a list response.
function normalizeRow(r: Record<string, unknown>): RenderRow {
  let overrides: Record<string, unknown> | null = null;
  const oRaw = r.render_overrides;
  if (typeof oRaw === "string" && oRaw.length > 0) {
    try {
      const parsed = JSON.parse(oRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        overrides = parsed as Record<string, unknown>;
      }
    } catch {
      overrides = null;
    }
  }

  let output: unknown = null;
  const opRaw = r.output;
  if (typeof opRaw === "string" && opRaw.length > 0) {
    try {
      output = JSON.parse(opRaw);
    } catch {
      output = opRaw;
    }
  }

  return {
    id: Number(r.id),
    user_email: String(r.user_email),
    job_id: String(r.job_id),
    project: String(r.project),
    bundle_key: String(r.bundle_key),
    quality_tier: String(r.quality_tier),
    render_overrides: overrides,
    status: String(r.status),
    output_key: r.output_key ? String(r.output_key) : null,
    output,
    error: r.error ? String(r.error) : null,
    execution_time_ms:
      r.execution_time_ms === null || r.execution_time_ms === undefined
        ? null
        : Number(r.execution_time_ms),
    delay_time_ms:
      r.delay_time_ms === null || r.delay_time_ms === undefined
        ? null
        : Number(r.delay_time_ms),
    submitted_at: Number(r.submitted_at),
    updated_at: Number(r.updated_at),
    completed_at:
      r.completed_at === null || r.completed_at === undefined
        ? null
        : Number(r.completed_at),
  };
}
