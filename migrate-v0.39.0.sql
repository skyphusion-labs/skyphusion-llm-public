-- v0.39.0 migration delta ONLY. Adds the `keyframes_json` column to the
-- renders table so each row can carry the list of SDXL keyframes the GPU
-- side uploaded to R2 at COMPLETED. The Worker stores them as a JSON array
-- of {shot_id, key}; the planner UI fetches each one via /api/artifact and
-- shows a thumbnail strip in the expanded history row.
--
-- Idempotent caveat: SQLite's ALTER TABLE ADD COLUMN is NOT idempotent;
-- re-running this against an already-migrated DB surfaces "duplicate
-- column name" which wrangler d1 execute treats as a non-fatal warning
-- and continues past. Same pattern as the v0.36.0 label ALTER.
--
-- Apply: wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.39.0.sql

ALTER TABLE renders ADD COLUMN keyframes_json TEXT;
