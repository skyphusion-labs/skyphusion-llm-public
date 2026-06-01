-- v0.53.0 migration: persisted storyboard projects.
--
-- Applied to prod via:
--   npx wrangler d1 execute skyphusion-llm --remote --file=migrations/v0.53.0-projects.sql
--
-- See schema.sql for the canonical state-after; this file is the delta
-- only. Idempotent (IF NOT EXISTS on table + indexes); a re-apply is a
-- safe no-op.

CREATE TABLE IF NOT EXISTS storyboard_projects (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email           TEXT NOT NULL,
  slug                 TEXT NOT NULL,
  name                 TEXT NOT NULL,
  prefs_json           TEXT NOT NULL DEFAULT '{}',
  last_storyboard_json TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sbprojects_user
  ON storyboard_projects(user_email, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sbprojects_slug_user
  ON storyboard_projects(user_email, slug);
