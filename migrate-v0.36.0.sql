-- v0.36.0 migration delta ONLY. Adds the `label` column to the renders
-- table so each history row can carry a free-form user-authored name.
--
-- Idempotent caveat: SQLite's ALTER TABLE ADD COLUMN is NOT idempotent;
-- re-running this against an already-migrated DB surfaces "duplicate
-- column name" which wrangler d1 execute treats as a non-fatal warning
-- and continues past. Same pattern as the v0.20.3 chunks ALTERs.
--
-- Apply: wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.36.0.sql

ALTER TABLE renders ADD COLUMN label TEXT;
