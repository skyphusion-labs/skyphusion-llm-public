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
  job_started_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_chats_user_created
  ON chats(user_email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chats_pending
  ON chats(status, user_email) WHERE status = 'pending';
