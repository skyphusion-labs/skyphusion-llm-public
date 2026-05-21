-- Chat history. One row per call to /api/chat.
--
-- user_email is set from the Cf-Access-Authenticated-User-Email header
-- injected by Cloudflare Access; local dev defaults to 'anonymous'.
--
-- model_type is 'chat' | 'image' | 'tts'. Drives output rendering on the
-- client and dispatch logic on the server.
--
-- output holds the text response for chat models, '' for image/tts models.
-- output_artifact is JSON { key, mime, type } pointing to an R2 object for
-- non-text outputs (generated images, generated audio).
--
-- attachments is a JSON array. Each entry is one of:
--   image:        { type, key, mime, filename }                       (R2 key)
--   audio:        { type, mime, filename, transcript }                (no R2 ref)
--   video_frames: { type, keys, frame_count, duration, filename }     (R2 keys)
-- Audio attachments store ONLY the transcript text; the raw audio is
-- dropped (kept neither in D1 nor R2) since the transcript is what's
-- useful on replay.

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
  ai_gateway_log_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_chats_user_created
  ON chats(user_email, created_at DESC);
