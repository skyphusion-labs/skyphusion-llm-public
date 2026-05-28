-- v0.20.2 migration delta ONLY (conversation -> project association).
--
-- Adds project_id to the chats table plus a partial index. The ALTER is
-- NOT idempotent in SQLite (no IF NOT EXISTS for ADD COLUMN): run this file
-- exactly once. If the column already exists, re-running raises
-- "duplicate column name" and, because wrangler d1 execute runs the file as
-- one transaction, aborts and rolls back. Do not re-run; do not use the
-- cumulative schema.sql against an existing database.
--
-- To check whether it has already been applied:
--   wrangler d1 execute skyphusion-llm-public --remote --command "PRAGMA table_info(chats)"
-- and look for a project_id column.
--
-- Apply: wrangler d1 execute skyphusion-llm-public --remote --file=migrate-v0.20.2.sql

ALTER TABLE chats ADD COLUMN project_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_chats_project
  ON chats(project_id, created_at DESC) WHERE project_id IS NOT NULL;
