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

// One uploaded SDXL keyframe (v0.39.0). The GPU side writes these to R2
// at COMPLETED and returns the list in its job-output envelope; we mirror
// them on the renders row so the UI can render thumbnails without re-
// pulling the output blob.
export interface KeyframeRef {
  shot_id: string;
  key: string;
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
  label: string | null;
  keyframes: KeyframeRef[] | null;
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
  let keyframesJson: string | null = null;
  if (
    view.output &&
    typeof view.output === "object" &&
    !Array.isArray(view.output)
  ) {
    const o = view.output as Record<string, unknown>;
    if (typeof o.output_key === "string" && o.output_key.length > 0) {
      outputKey = o.output_key;
    }
    // v0.39.0: extract the keyframes list (GPU 0.4.0+) so we can render
    // thumbnails in the history row without re-parsing output_json.
    const refs = normalizeKeyframes(o.keyframes);
    if (refs.length > 0) keyframesJson = JSON.stringify(refs);
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
      completed_at = COALESCE(?, completed_at),
      keyframes_json = COALESCE(?, keyframes_json)
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
      keyframesJson,
      view.jobId,
    )
    .run();
}

// Best-effort coerce `output.keyframes` from a job envelope into a
// well-formed KeyframeRef[]. Anything that does not look like an
// object with string `shot_id` + `key` is dropped silently; that
// way a GPU side that adds future fields to each entry does not
// crash the UPDATE.
export function normalizeKeyframes(raw: unknown): KeyframeRef[] {
  if (!Array.isArray(raw)) return [];
  const out: KeyframeRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.shot_id !== "string" || e.shot_id.length === 0) continue;
    if (typeof e.key !== "string" || e.key.length === 0) continue;
    out.push({ shot_id: e.shot_id, key: e.key });
  }
  return out;
}

// Fetch one row by D1 PK, scoped to the caller's user_email. Returns null
// when the row does not exist OR when it belongs to another user (we do
// not distinguish so a guessed id cannot enumerate other users' rows).
export async function getRenderByIdForUser(
  env: Env,
  id: number,
  userEmail: string,
): Promise<RenderRow | null> {
  const r = await env.DB.prepare(
    `SELECT
      id, user_email, job_id, project, bundle_key, quality_tier,
      render_overrides, status, output_key, output_json AS output,
      error, execution_time_ms, delay_time_ms,
      submitted_at, updated_at, completed_at, label, keyframes_json
    FROM renders
    WHERE id = ? AND user_email = ?`,
  )
    .bind(id, userEmail)
    .first<Record<string, unknown>>();
  if (!r) return null;
  return normalizeRow(r);
}

// Update one row's label. Empty / null clears it. Returns true when the
// row existed and was owned by the caller; false otherwise (so a caller
// can distinguish "not yours" from "saved" if it wants to).
export async function setRenderLabel(
  env: Env,
  id: number,
  userEmail: string,
  label: string | null,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `UPDATE renders SET label = ?, updated_at = ? WHERE id = ? AND user_email = ?`,
  )
    .bind(label, now, id, userEmail)
    .run();
  const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  return changes > 0;
}

// True when at least one OTHER row references the same output_key. Used
// to gate R2 artifact deletion: re-renders of the same project can share
// an output filename (rp_handler.py writes `renders/<project>/<name>.mp4`,
// so a re-render at the same name would overwrite), and we never want to
// strand a still-referenced artifact.
export async function countOtherRowsWithOutputKey(
  env: Env,
  id: number,
  outputKey: string,
): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM renders WHERE output_key = ? AND id != ?`,
  )
    .bind(outputKey, id)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

// Delete one row by D1 PK + user_email. Returns true when a row was
// actually removed (i.e., the row existed and the caller owned it).
export async function deleteRenderRow(
  env: Env,
  id: number,
  userEmail: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `DELETE FROM renders WHERE id = ? AND user_email = ?`,
  )
    .bind(id, userEmail)
    .run();
  const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  return changes > 0;
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
      submitted_at, updated_at, completed_at, label, keyframes_json
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

  let keyframes: KeyframeRef[] | null = null;
  const kfRaw = r.keyframes_json;
  if (typeof kfRaw === "string" && kfRaw.length > 0) {
    try {
      const parsed = JSON.parse(kfRaw);
      const refs = normalizeKeyframes(parsed);
      if (refs.length > 0) keyframes = refs;
    } catch {
      keyframes = null;
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
    label:
      typeof r.label === "string" && r.label.length > 0 ? r.label : null,
    keyframes,
  };
}
