// v0.141.0: per-render logs in R2.
//
// When a render reaches a terminal status, the control plane already holds the
// RunPod job view (status, timing, the COMPLETED envelope, and on failure the
// GPU side's diagnostics tail). We persist a human-readable version of that to
// R2 at a CONVENTIONAL key derived from the job id, so the History UI can offer
// a "view logs" link with no new DB column and no read-path changes. The object
// is served through /api/artifact, which is ownership-gated on
// customMetadata.user_email, so the log carries the render owner's email.
import type { Env } from "./env";
import type { RunpodJobView } from "./runpod-submit";

// Conventional R2 key for a job's log. The History UI derives the same key from
// the row's job_id, so there is nothing to store in D1.
export function renderLogKey(jobId: string): string {
  return `renders/logs/${jobId}.txt`;
}

// Pure: format a RunPod job view into a readable per-render log. Kept pure so it
// is unit-testable; the caller supplies the timestamp.
export function buildRenderLogText(view: RunpodJobView, generatedAtIso: string): string {
  const lines: string[] = [];
  lines.push(`Render log - job ${view.jobId}`);
  lines.push(`Generated: ${generatedAtIso}`);
  const raw =
    view.statusRaw && view.statusRaw !== view.status ? ` (${view.statusRaw})` : "";
  lines.push(`Status: ${view.status}${raw}`);
  if (typeof view.executionTimeMs === "number") {
    lines.push(`Execution: ${(view.executionTimeMs / 1000).toFixed(1)}s`);
  }
  if (typeof view.delayTimeMs === "number") {
    lines.push(`Queue delay: ${(view.delayTimeMs / 1000).toFixed(1)}s`);
  }
  if (view.error) {
    lines.push("", "Error:", view.error);
  }
  if (view.output !== undefined && view.output !== null) {
    lines.push("", "Output / diagnostics:");
    if (typeof view.output === "string") {
      lines.push(view.output);
    } else {
      try {
        lines.push(JSON.stringify(view.output, null, 2));
      } catch {
        lines.push(String(view.output));
      }
    }
  }
  return lines.join("\n") + "\n";
}

// Best-effort: write the per-render log to R2. NEVER throws; logging must not
// break the render-resolve path. Returns the key on success, null on failure.
export async function writeRenderLog(
  env: Env,
  view: RunpodJobView,
  userEmail: string,
): Promise<string | null> {
  try {
    const key = renderLogKey(view.jobId);
    const text = buildRenderLogText(view, new Date().toISOString());
    await env.R2_RENDERS.put(key, text, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { user_email: userEmail },
    });
    return key;
  } catch {
    return null;
  }
}
