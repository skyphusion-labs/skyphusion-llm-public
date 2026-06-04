-- v0.126.0 migration delta ONLY. Adds render-history organization to the
-- renders table: `folder_path` (free-form "/"-delimited path the user files a
-- render under; NULL / '' = unfiled) and `tags_json` (a JSON array of short
-- lowercase tag strings). Rows pre-dating this migration stay NULL on both,
-- which the read path treats as unfiled / untagged.
--
-- Tag filtering happens client-side over the already-loaded history (matching
-- the existing text / status filters), so there is no JSON index; the
-- folder index serves the common folder-scoped listing.
--
-- Idempotent caveat: SQLite's ALTER TABLE ADD COLUMN is NOT idempotent;
-- re-running this against an already-migrated DB surfaces "duplicate column
-- name" which wrangler d1 execute treats as a non-fatal warning and continues
-- past. The CREATE INDEX is idempotent via IF NOT EXISTS. Same pattern as the
-- v0.55.0 / v0.122.0 ALTERs.
--
-- Apply: wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.126.0.sql

ALTER TABLE renders ADD COLUMN folder_path TEXT;
ALTER TABLE renders ADD COLUMN tags_json TEXT;

CREATE INDEX IF NOT EXISTS renders_by_user_folder
  ON renders(user_email, folder_path, submitted_at DESC)
  WHERE folder_path IS NOT NULL;
