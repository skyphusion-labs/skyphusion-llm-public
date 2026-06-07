-- v0.145.2 migration delta ONLY. One additive change.
--
-- `renders.parent_id`: the D1 id of the keyframes-only preview render that a
-- derived animation row was produced from. Set on the rows that finalize (GPU
-- Wan I2V) or animate-cloud (cloud image-to-video) spawn; NULL on a normal
-- top-level render. It is the FK that lets the History UI union a derived
-- animation back onto the keyframes it animated, and group the (possibly
-- several) versions of one keyframes set: a GPU finalize and one-or-more cloud
-- animations across different models can all share one parent. The version is
-- self-describing from existing columns (mode = finalized vs cloud-finalized;
-- output_json.model = which cloud model), so no discriminator column is needed.
--
-- 1:many by design (one preview -> N animations); the partial index serves the
-- "find this preview's children" lookup without bloating the common NULL case.
--
-- Apply to prod with:
--   wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.145.2.sql
-- SQLite's ALTER TABLE ADD COLUMN is NOT idempotent; run this delta once, do
-- not re-run schema.sql against prod.

ALTER TABLE renders ADD COLUMN parent_id INTEGER;

CREATE INDEX IF NOT EXISTS renders_by_parent
  ON renders(parent_id) WHERE parent_id IS NOT NULL;
