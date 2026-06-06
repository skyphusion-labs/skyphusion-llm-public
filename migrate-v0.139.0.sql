-- v0.139.0 migration delta ONLY. Two changes, both additive.
--
-- 1. `user_prefs`: the first User Preferences store. One row per user (keyed by
--    the Cloudflare-Access email), a JSON blob of settings so new prefs can be
--    added without a schema change. The first pref is `emailNotifications`
--    (default false): when true, the user is emailed when one of their renders
--    reaches a terminal status. Read with defaults; written by PATCH /api/prefs.
--
-- 2. `renders.notified_at`: epoch seconds the terminal-status email was claimed
--    for this render (NULL = not yet). It is the once-only guard: the notify
--    path claims a row by flipping NULL -> now in a single conditional UPDATE,
--    so concurrent polls / the cron sweep can never double-send. Marked even
--    when the owner has notifications off, so the decision is made exactly once.
--
-- Apply to prod with:
--   wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.139.0.sql
-- SQLite's ALTER TABLE ADD COLUMN is NOT idempotent; run this delta once, do
-- not re-run schema.sql against prod.

CREATE TABLE IF NOT EXISTS user_prefs (
  user_email  TEXT PRIMARY KEY,
  prefs_json  TEXT NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL
);

ALTER TABLE renders ADD COLUMN notified_at INTEGER;
