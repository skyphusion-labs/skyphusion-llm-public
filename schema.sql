-- Chat history. One row per call to /api/chat.
--
-- user_email is set from the Cf-Access-Authenticated-User-Email header
-- injected by Cloudflare Access; local dev defaults to 'anonymous'.
--
-- model_type is 'chat' | 'image' | 'tts' | 'video'. Drives output rendering
-- on the client and dispatch logic on the server.
--
-- For model_type='video', the row is created with status='pending' and a
-- job_id pointing at the upstream provider's operation. The frontend polls
-- /api/job/:id, which advances the row to 'done' (downloading the bytes
-- into R2 + recording the output_artifact) or 'failed' (recording the error
-- in job_error).
--
-- output holds text for chat models, '' for image/tts/video.
-- output_artifact is JSON { key, mime, type } pointing to an R2 object for
-- non-text outputs (generated images, generated audio, generated video).
--
-- attachments is a JSON array as documented in the worker; audio attachments
-- store only the transcript, the raw audio is dropped.

CREATE TABLE IF NOT EXISTS chats (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  model             TEXT NOT NULL,
  model_type        TEXT NOT NULL DEFAULT 'chat',
  system_prompt     TEXT,
  user_input        TEXT NOT NULL,
  output            TEXT NOT NULL DEFAULT '',
  output_artifact   TEXT,
  attachments       TEXT,
  tokens_in         INTEGER,
  tokens_out        INTEGER,
  latency_ms        INTEGER,
  ai_gateway_log_id TEXT,
  status            TEXT NOT NULL DEFAULT 'done',
  job_id            TEXT,
  job_provider      TEXT,
  job_error         TEXT,
  job_started_at    TEXT,
  retrieved_context TEXT,
  -- Multi-turn (v0.10.0): chats with the same conversation_id form one thread.
  -- turn_index is monotonically increasing within a conversation.
  -- For backward compat, legacy rows are backfilled as conversation_id='legacy-<id>', turn_index=0.
  conversation_id   TEXT,
  turn_index        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chats_conversation
  ON chats(conversation_id, turn_index);

CREATE INDEX IF NOT EXISTS idx_chats_user_created
  ON chats(user_email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chats_pending
  ON chats(status, user_email) WHERE status = 'pending';

-- ---------- RAG: documents and chunks ----------
--
-- A document is one user-uploaded file (.txt or .md). Its raw bytes live
-- in R2 under the in/ prefix; this row tracks metadata. A document is
-- chunked at upload time and each chunk gets embedded and stored in
-- Vectorize. chunk rows link D1 text to Vectorize vector IDs so we can
-- do vector -> text lookups at retrieval time.
--
-- D1 doesn't honor PRAGMA foreign_keys, so the FK relationship below is
-- documentation only; the application code handles cascade-on-delete.

CREATE TABLE IF NOT EXISTS documents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  filename        TEXT NOT NULL,
  mime            TEXT NOT NULL,
  r2_key          TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  total_chars     INTEGER NOT NULL DEFAULT 0,
  chunk_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_documents_user_created
  ON documents(user_email, created_at DESC);

CREATE TABLE IF NOT EXISTS chunks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id     INTEGER NOT NULL,
  user_email      TEXT NOT NULL,
  chunk_index     INTEGER NOT NULL,
  text            TEXT NOT NULL,
  vector_id       TEXT NOT NULL,
  page            INTEGER,             -- for PDFs: the source page (1-indexed)
  sheet           TEXT,                -- for XLSX/XLS: the source sheet name
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc    ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_vector ON chunks(vector_id);
CREATE INDEX IF NOT EXISTS idx_chunks_user   ON chunks(user_email);

-- ---------- Projects (v0.20.0) ----------
--
-- A project groups documents (and eventually conversations, in v0.20.1)
-- under a shared system prompt and retrieval scope. Documents can belong
-- to multiple projects via the project_documents join table.
--
-- system_prompt: when set, becomes the default system prompt for chats
-- created within this project. A per-turn system_prompt on the chat
-- request overrides this entirely (no append). Empty string and NULL
-- are equivalent semantically.
--
-- slug: derived from name at create time, used as a stable identifier
-- in URLs/storage. Auto-suffixed on collision per user_email
-- (mudd, mudd-2, mudd-3, ...). Renaming the project does not change the
-- slug, so frontends can safely use slug as a URL fragment.
--
-- Per-user scoping: all projects rows have a user_email; cross-user
-- access is enforced in application code (D1 doesn't honor FKs).

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

-- ---------- Project membership (v0.20.0) ----------
--
-- Many-to-many: a document can live in multiple projects, a project
-- contains multiple documents. (project_id, document_id) is the natural
-- primary key. Both FK relationships cascade on delete via application
-- code (D1 ignores PRAGMA foreign_keys); deleting a project or document
-- cleans up its membership rows.
--
-- user_email lives on the projects and documents rows; this table doesn't
-- duplicate it. Cross-user membership is rejected by the route handlers
-- before insert.

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

-- ---------- Conversation -> project association (v0.20.2) ----------
--
-- Adds project_id to existing chats rows so a chat turn can record which
-- project (if any) it was sent within. Nullable: pre-v0.20.2 rows and any
-- chat started without an active project carry NULL.
--
-- "Move chat to project" updates all rows in a conversation_id atomically,
-- so within one conversation the project_id is uniform. The conversation
-- list endpoint reads project_id from the conversation's earliest turn and
-- exposes it on the row so the sidebar can render a project chip.
--
-- This is an ALTER, so it's NOT idempotent like the CREATE TABLE IF NOT
-- EXISTS additions above. wrangler d1 execute is idempotent at the
-- migration-run level but ALTER would error on re-run. To make this safe
-- to re-apply, the ALTER is wrapped in a check against PRAGMA table_info.
-- Cleanest path: a fresh schema.sql apply on a database that already has
-- this column is a no-op.

-- Idempotent column add. SQLite doesn't support IF NOT EXISTS on ALTER TABLE
-- ADD COLUMN, so we use a defensive pattern: try the ALTER, catch the
-- "duplicate column" error at the app layer. For schema.sql re-runs on
-- already-migrated DBs, the ALTER will fail with "duplicate column name"
-- and `wrangler d1 execute` will treat it as a non-fatal warning per
-- statement, continuing to the next. The CREATE INDEX below is naturally
-- idempotent via IF NOT EXISTS.
ALTER TABLE chats ADD COLUMN project_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_chats_project
  ON chats(project_id, created_at DESC) WHERE project_id IS NOT NULL;

-- ---------- Discord ingestion (v0.20.3) ----------
--
-- project_messages stores raw Discord messages parsed from a DCE JSON export,
-- first-class, so the corpus can be re-chunked later (e.g. with an improved
-- chunker) without re-uploading the export. Retrieval does NOT read this
-- table; it reads chunks. This table exists purely for re-processing and
-- audit.
--
-- Tied to both the project (the import target) and the document (the uploaded
-- export file). Both cascade on delete via application code, consistent with
-- the rest of the schema (D1 ignores PRAGMA foreign_keys).

CREATE TABLE IF NOT EXISTS project_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL,
  document_id   INTEGER NOT NULL,
  user_email    TEXT NOT NULL,
  message_id    TEXT NOT NULL,        -- Discord snowflake
  channel       TEXT NOT NULL,
  author        TEXT NOT NULL,        -- display name (nickname or name)
  author_id     TEXT,
  is_bot        INTEGER NOT NULL DEFAULT 0,
  sent_at       TEXT NOT NULL,        -- ISO8601
  content       TEXT NOT NULL,
  FOREIGN KEY (project_id)  REFERENCES projects(id)  ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_messages_proj
  ON project_messages(project_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_project_messages_doc
  ON project_messages(document_id);

-- Chunk metadata for conversation/Discord chunks (v0.20.3). Reuses the
-- existing chunks table, adding nullable columns analogous to page/sheet.
-- Document chunks leave these NULL; Discord chunks populate them. v0.20.4
-- retrieval filters (author/channel/date) will read these columns.
--
-- ALTER TABLE ADD COLUMN is not idempotent in SQLite; re-applying schema.sql
-- on an already-migrated DB surfaces "duplicate column name" per statement,
-- which wrangler d1 execute treats as a non-fatal warning and continues past.
ALTER TABLE chunks ADD COLUMN channel       TEXT;
ALTER TABLE chunks ADD COLUMN authors       TEXT;   -- comma-joined distinct authors
ALTER TABLE chunks ADD COLUMN sent_at_start TEXT;   -- ISO8601 earliest message
ALTER TABLE chunks ADD COLUMN sent_at_end   TEXT;   -- ISO8601 latest message

-- ---------- Per-user preferences (v0.164.0) ----------
--
-- JSON blob keyed by Cloudflare Access email. Public demo deployments store
-- each visitor's AI Gateway slug and CF API token here so the worker itself
-- needs no GATEWAY_ID / CF_AIG_TOKEN secrets.

CREATE TABLE IF NOT EXISTS user_prefs (
  user_email  TEXT PRIMARY KEY,
  prefs_json  TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
