-- v0.34.0 migration delta ONLY. Adds the renders table for storyboard
-- render history. Idempotent (CREATE TABLE IF NOT EXISTS + CREATE INDEX
-- IF NOT EXISTS), safe to apply to an existing populated DB.
--
-- Apply: wrangler d1 execute skyphusion-llm-public --remote --file=migrate-v0.34.0.sql

CREATE TABLE IF NOT EXISTS renders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email        TEXT NOT NULL,
  job_id            TEXT NOT NULL UNIQUE,    -- RunPod-issued; unique
  project           TEXT NOT NULL,           -- project slug (deriveProjectFromBundleKey)
  bundle_key        TEXT NOT NULL,           -- R2 key the GPU worker pulls
  quality_tier      TEXT NOT NULL,           -- "draft" | "standard" | "final"
  render_overrides  TEXT,                    -- JSON-encoded blob; nullable
  status            TEXT NOT NULL,           -- last observed RunPod status
  output_key        TEXT,                    -- silent MP4 R2 key on COMPLETED
  output_json       TEXT,                    -- last poll's output envelope (JSON)
  error             TEXT,                    -- RunPod-side error on FAILED
  execution_time_ms INTEGER,
  delay_time_ms     INTEGER,
  submitted_at      INTEGER NOT NULL,        -- Unix seconds at submit
  updated_at        INTEGER NOT NULL,        -- Unix seconds at last status change
  completed_at      INTEGER                  -- Unix seconds at terminal status
);

CREATE INDEX IF NOT EXISTS renders_by_user
  ON renders(user_email, submitted_at DESC);

CREATE INDEX IF NOT EXISTS renders_by_user_status
  ON renders(user_email, status);
