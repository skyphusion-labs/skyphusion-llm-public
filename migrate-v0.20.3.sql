-- v0.20.3 migration delta ONLY. Run this instead of the full schema.sql,
-- because schema.sql is cumulative and contains non-idempotent ALTER
-- statements from earlier releases (notably v0.20.2's chats.project_id) that
-- abort the whole transaction on re-run.
--
-- This file contains only the statements new in v0.20.3:
--   - project_messages table + indexes (idempotent via IF NOT EXISTS)
--   - four new columns on chunks (NOT idempotent; run once)
--
-- Apply: wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.20.3.sql

CREATE TABLE IF NOT EXISTS project_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL,
  document_id   INTEGER NOT NULL,
  user_email    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  channel       TEXT NOT NULL,
  author        TEXT NOT NULL,
  author_id     TEXT,
  is_bot        INTEGER NOT NULL DEFAULT 0,
  sent_at       TEXT NOT NULL,
  content       TEXT NOT NULL,
  FOREIGN KEY (project_id)  REFERENCES projects(id)  ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_messages_proj
  ON project_messages(project_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_project_messages_doc
  ON project_messages(document_id);

ALTER TABLE chunks ADD COLUMN channel       TEXT;
ALTER TABLE chunks ADD COLUMN authors       TEXT;
ALTER TABLE chunks ADD COLUMN sent_at_start TEXT;
ALTER TABLE chunks ADD COLUMN sent_at_end   TEXT;
