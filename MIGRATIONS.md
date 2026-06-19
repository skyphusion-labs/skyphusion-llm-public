# Migrating an existing deployment

This is the per-version upgrade runbook for an existing deployment. For a fresh
install use `schema.sql` (see the README). Apply the deltas below in order, then
redeploy.

**Migration philosophy (read this first).** `schema.sql` is the canonical full schema for standing up a *fresh* database. It contains non-idempotent `ALTER TABLE` statements, so re-running it against a database that already has tables will raise `SQLITE_ERROR: duplicate column name` and, because `wrangler d1 execute --file` runs the whole file as one transaction, abort and roll back the entire run. **Never re-run `schema.sql` against an existing database.** To upgrade an existing deployment, apply only the delta for each version you're crossing, using the explicit commands below (or, for releases that ship one, the per-release `migrate-vX.Y.Z.sql` delta file). Apply each version's delta in order, then redeploy.

v0.13.0 onward touched the D1 schema only at v0.20.0, v0.20.2, and v0.20.3; everything else in the v0.13.0 to v0.20.0 range is code-only. The pre-v0.13.0 migrations (v0.7.0 to v0.10.0) are below for anyone upgrading from very old deployments.

For v0.7.0 (video generation):

```
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN status TEXT NOT NULL DEFAULT 'done'"
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN job_id TEXT"
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN job_provider TEXT"
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN job_error TEXT"
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN job_started_at TEXT"
```

For v0.8.0 (RAG Pass 1):

```
npx wrangler vectorize create skyphusion-llm-vec --dimensions=768 --metric=cosine
# Create the documents and chunks tables explicitly. (Historically this step
# was "--file=schema.sql"; that is no longer safe because today's schema.sql
# also carries later non-idempotent ALTERs. Use the explicit DDL below.)
npx wrangler d1 execute skyphusion-llm --remote --command "CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), filename TEXT NOT NULL, mime TEXT NOT NULL, r2_key TEXT NOT NULL, size_bytes INTEGER NOT NULL, total_chars INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0)"
npx wrangler d1 execute skyphusion-llm --remote --command "CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL, user_email TEXT NOT NULL, chunk_index INTEGER NOT NULL, text TEXT NOT NULL, vector_id TEXT NOT NULL, FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE)"
```

For v0.8.1 (RAG Pass 2):

```
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN retrieved_context TEXT"
```

For v0.8.2 (Phase 3A, RAG over PDF + XLSX):

```
npm install
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chunks ADD COLUMN page INTEGER"
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chunks ADD COLUMN sheet TEXT"
```

For v0.10.0 (multi-turn conversations):

```
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN conversation_id TEXT"
npx wrangler d1 execute skyphusion-llm --remote --command "ALTER TABLE chats ADD COLUMN turn_index INTEGER"
npx wrangler d1 execute skyphusion-llm --remote --command "UPDATE chats SET conversation_id = 'legacy-' || id, turn_index = 0 WHERE conversation_id IS NULL"
npx wrangler d1 execute skyphusion-llm --remote --command "CREATE INDEX IF NOT EXISTS idx_chats_conversation ON chats(conversation_id, turn_index)"
```

For v0.12.0 (wrangler.toml restructure): see the CHANGELOG entry for the exact `[[workflows]]` and `[observability]` blocks to paste into your local `wrangler.toml`, plus the `GATEWAY_ID` move from `[vars]` to a worker secret.

For v0.14.0 (BYOK removal of OpenAI and Google): drop the now-unused secrets if you want a clean state:

```
npx wrangler secret delete OPENAI_API_KEY
npx wrangler secret delete GOOGLE_API_KEY
```

Neither is fatal if left in place; they're just inert.

v0.13.0, v0.15.0, v0.16.0, v0.17.0: no D1 migrations. v0.17.0 adds an optional `TAVILY_API_KEY` secret for the web-search feature; skip it and the feature falls back to Wikipedia only.

v0.18.x, v0.19.x: code-only (provider extractions, SSE refactors, chunker rewrite). No D1 migrations.

For v0.20.0 (projects and knowledge stores): ships the delta file `migrate-v0.20.0.sql`, which adds the `projects` and `project_documents` tables and their indexes. Every statement is `CREATE ... IF NOT EXISTS`, so this one is safely re-runnable, but apply it once:

```
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.20.0.sql
```

v0.20.1, v0.20.1.1: frontend-only (projects UI, modal hotfix). No D1 migrations.

For v0.20.2 (conversation to project association): ships the delta file `migrate-v0.20.2.sql`, which adds `chats.project_id` and a partial index. The `ALTER` is non-idempotent; run the file exactly once. If you have already added this column, skip it (re-running raises "duplicate column name" and rolls back the run).

v0.21.x, v0.22.0: code/frontend only, no D1 migrations.

For v0.22.1 (transparent image gen): no D1 migration. Re-introduces an OPTIONAL `OPENAI_API_KEY` secret, used only for `openai/gpt-image-1.5` transparent output via a direct OpenAI call (chat is unaffected and still rides Unified Billing). If you ran the v0.14.0 cleanup that deleted this secret, re-add it to enable transparency; skip it and gpt-image-1.5 stays opaque through the proxy:

```
npx wrangler secret put OPENAI_API_KEY
```

For v0.20.3 (Discord ingestion): this release ships a delta file, `migrate-v0.20.3.sql`, containing the `project_messages` table and the four new `chunks` columns. Apply it once:

```
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.20.3.sql
```

The `ALTER TABLE chunks ADD COLUMN` statements in it are non-idempotent; run the file exactly once. If you need to verify what applied, `PRAGMA table_info(chunks)` should list `channel`, `authors`, `sent_at_start`, `sent_at_end`.

v0.20.4: frontend-only (Discord import button). No D1 migration.

## Releases from v0.21.0 on

The entries above predate the `migrate-vX.Y.Z.sql` convention. From v0.21.0 onward,
these are the releases that shipped a D1 delta file; apply each once, in order:

For v0.34.0 (render history): `migrate-v0.34.0.sql` adds the `renders` table and its
indexes. All `CREATE ... IF NOT EXISTS`, so it is safely re-runnable.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.34.0.sql
```

For v0.36.0 (render labels): `migrate-v0.36.0.sql` adds `renders.label`.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.36.0.sql
```

For v0.39.0 (keyframe history): `migrate-v0.39.0.sql` adds `renders.keyframes_json`.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.39.0.sql
```

For v0.40.0 (render mode): `migrate-v0.40.0.sql` adds `renders.mode`.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.40.0.sql
```

For v0.42.0 (per-shot locks): `migrate-v0.42.0.sql` adds `renders.locked_shots_json`.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.42.0.sql
```

For v0.122.0 (off-GPU video finish): `migrate-v0.122.0.sql` adds `renders.finish_state`,
the finish idempotency lock.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.122.0.sql
```

For v0.126.0 (render-history folders + tags): `migrate-v0.126.0.sql` adds
`renders.folder_path` + `renders.tags_json` and the `renders_by_user_folder` index.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.126.0.sql
```

For v0.164.0 (public demo AI Gateway prefs): `migrate-v0.164.0.sql` adds the
`user_prefs` table for per-user gateway slug + CF API token storage.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrate-v0.164.0.sql
```

**Cast manager + storyboard projects (`migrations/` subdirectory).** Starting at
v0.46.0 the delta files moved from the repo root (`migrate-vX.Y.Z.sql`) into a
`migrations/` subdirectory (`migrations/vX.Y.Z-name.sql`); the delta-only convention is
unchanged (never re-run `schema.sql` against prod). Apply each once, in order, if you
are upgrading across these versions:

For v0.46.0 (persisted cast manager): `migrations/v0.46.0-cast.sql` adds the
`cast_members` table and its indexes (idempotent, `IF NOT EXISTS`).

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrations/v0.46.0-cast.sql
```

For v0.53.0 (persisted storyboard projects): `migrations/v0.53.0-projects.sql` adds the
`storyboard_projects` table and its indexes (idempotent, `IF NOT EXISTS`).

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrations/v0.53.0-projects.sql
```

For v0.55.0 (project-scoped render history): `migrations/v0.55.0-renders-project-id.sql`
adds `renders.project_id` and the `renders_by_user_project` index.

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrations/v0.55.0-renders-project-id.sql
```

For v0.57.0 (standalone cast LoRA training): `migrations/v0.57.0-cast-lora.sql` adds the
five LoRA columns to `cast_members` (`lora_key`, `lora_status`, `lora_job_id`,
`lora_error`, `lora_trained_at`).

```bash
npx wrangler d1 execute skyphusion-llm --remote --file=migrations/v0.57.0-cast-lora.sql
```

The v0.55.0 and v0.57.0 files use `ALTER TABLE ADD COLUMN`, which SQLite does not make
idempotent; re-applying surfaces a non-fatal "duplicate column name" warning per
statement and continues. Fresh installs get all of the above from `schema.sql` and need
none of these deltas.

All other releases are code/frontend-only with no D1 migration.
