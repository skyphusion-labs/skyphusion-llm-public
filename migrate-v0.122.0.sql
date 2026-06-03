-- v0.122.0 migration delta ONLY. Adds the `finish_state` column to the
-- renders table: the idempotency lock for off-GPU video finishing. NULL on
-- a normal (on-GPU assembled) render; on a finish_offloaded render whose
-- final MP4 is assembled by the video-finish container at poll-completion it
-- goes NULL -> 'finishing' -> 'done' | 'failed'. claimFinish does an atomic
-- compare-and-swap on this column so concurrent /api/render polls can't
-- double-run the container. Rows pre-dating this migration stay NULL, which
-- the read path treats as "no off-GPU finish involved".
--
-- Idempotent caveat: SQLite's ALTER TABLE ADD COLUMN is NOT idempotent;
-- re-running this against an already-migrated DB surfaces "duplicate
-- column name" which wrangler d1 execute treats as a non-fatal warning
-- and continues past. Same pattern as the v0.40.0 / v0.42.0 ALTERs.
--
-- Apply: wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.122.0.sql

ALTER TABLE renders ADD COLUMN finish_state TEXT;
