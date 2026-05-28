-- v0.20.0 migration delta ONLY (projects + knowledge stores).
--
-- Adds the projects and project_documents tables plus their indexes. Every
-- statement uses CREATE TABLE / CREATE INDEX IF NOT EXISTS, so this delta is
-- safely re-runnable on its own. It is still a delta, not the full schema:
-- run this against an existing database, never the cumulative schema.sql
-- (which carries later non-idempotent ALTERs that abort the transaction).
--
-- Apply: wrangler d1 execute skyphusion-llm-public --remote --file=migrate-v0.20.0.sql

CREATE TABLE IF NOT EXISTS projects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email      TEXT NOT NULL,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  description     TEXT,
  system_prompt   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_projects_user
  ON projects(user_email, created_at DESC);

-- Slug uniqueness is per-user, not global. Two different users can both
-- have a project slugged 'mudd'.
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug_user
  ON projects(user_email, slug);

CREATE TABLE IF NOT EXISTS project_documents (
  project_id      INTEGER NOT NULL,
  document_id     INTEGER NOT NULL,
  added_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, document_id),
  FOREIGN KEY (project_id)  REFERENCES projects(id)  ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_documents_doc
  ON project_documents(document_id);
