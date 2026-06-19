-- v0.164.0: per-user AI Gateway credentials for public demo deployments.
CREATE TABLE IF NOT EXISTS user_prefs (
  user_email  TEXT PRIMARY KEY,
  prefs_json  TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
