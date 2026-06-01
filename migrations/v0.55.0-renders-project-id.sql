-- v0.55.0 migration: add renders.project_id (FK to storyboard_projects).
--
-- Applied to prod via:
--   npx wrangler d1 execute skyphusion-llm --remote --file=migrations/v0.55.0-renders-project-id.sql
--
-- SQLite ALTER TABLE ADD COLUMN is not idempotent in the IF NOT EXISTS
-- sense; re-applying surfaces "duplicate column name" per-statement,
-- which wrangler d1 execute treats as a non-fatal warning and continues
-- past. The CREATE INDEX below is idempotent via IF NOT EXISTS.

ALTER TABLE renders ADD COLUMN project_id INTEGER;

CREATE INDEX IF NOT EXISTS renders_by_user_project
  ON renders(user_email, project_id, submitted_at DESC)
  WHERE project_id IS NOT NULL;
