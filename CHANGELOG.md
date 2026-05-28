# Changelog

## v0.20.4

Frontend Discord import button, plus a correction to the migration guidance in the v0.20.2 and v0.20.3 notes below. The DCE import shipped in v0.20.3 as a curl-only endpoint; this release adds a file picker so importing an export is a click, which is what makes validating the parser against a real export practical.

### Correction to v0.20.2 / v0.20.3 migration notes

Those entries claimed re-running the full `schema.sql` against an existing database produces a "non-fatal warning that wrangler continues past." That is wrong. `wrangler d1 execute --file` runs the whole file as a single transaction; a non-idempotent statement (e.g. `ALTER TABLE chats ADD COLUMN project_id` when the column already exists) raises `SQLITE_ERROR: duplicate column name` and aborts the entire transaction, rolling back every statement in the file including the ones you actually needed.

The correct pattern, used from v0.20.3's migration onward: ship a per-release delta file (`migrate-vX.Y.Z.sql`) containing only that release's new statements, and run that. `schema.sql` remains the canonical full schema for standing up a fresh database, but is never re-run against an existing one. v0.20.3's `migrate-v0.20.3.sql` (project_messages + the four chunks columns, no chats.project_id) is the reference example.

v0.20.4 itself adds no schema, so it ships no migration file.

### Import button

Added to the project documents modal (the "docs" action on a project row), below the document checkbox list:

- "choose JSON export" button opens a file picker scoped to .json.
- An "include bot messages" checkbox (default on) maps to the import's includeBots option.
- On selection, the file is read as base64 in-browser and POSTed to the v0.20.3 endpoint `POST /api/projects/:id/import-discord`.
- A status line reports progress (reading / importing) and the result: channel, imported message count, chunk count, and how many system/empty messages were skipped. Errors (bad file, parse failure, embedding failure) surface inline in red rather than as an alert.
- On success the doc list and sidebar project counts refresh in place; the imported export appears as a new attached document.

No worker changes; the endpoint already existed. The button is a client of it.

### Touch points

- `public/index.html`: import section markup in the docs modal (button, bots checkbox, hidden file input, status div).
- `public/app.js`: element refs, `renderDocsPickerList` extracted from `openDocsPicker` for in-place refresh, `handleDiscordImportFile` (FileReader -> base64 -> POST -> refresh), button/file listeners.
- `public/styles.css`: import section, button, status (ok/error variants).
- `package.json`: 0.20.3 -> 0.20.4.

No new dependencies, no schema, no worker change, no migration. Worker tests: 95/95 unchanged.

### Smoke test (browser)

1. Open a project's "docs" modal. The "import a Discord export" section appears below the document list.
2. Click "choose JSON export", pick a DCE export. Status shows "reading...", then "importing...", then a green summary line.
3. The export appears as a checked document in the list above; the sidebar project doc count increments.
4. Start a chat with that project active and use_docs on; ask about the channel's content. Retrieved chunks should include the imported conversation.
5. Error path: pick a non-DCE JSON (or any .json that isn't an export). Status shows a red parse error; nothing is added.

### What's next

- v0.20.5: retrieval filters (author / channel / date), reading the chunk metadata columns v0.20.3 added. Deferred deliberately so the filter UI is designed against the shape of real imported data.
- v0.20.6: presigned R2 upload for exports over the 10MB worker request limit.

## v0.20.3

Discord ingestion: import a DiscordChatExporter (DCE) JSON export into a project, parse it into messages, chunk it conversation-aware, and embed it into the project's retrieval scope. Backend only; the import is curl-driven for now, with a frontend file-picker button planned for v0.20.4 alongside the retrieval filters.

This is the first half of the original v0.20.3 scope. Retrieval filters (author/channel/date) and presigned R2 upload for large exports move to v0.20.4.

### What it does

A DCE JSON export (one channel, exported WITHOUT `--markdown false` so mentions/emoji render readably) is uploaded to a project. The worker parses it into normalized messages, groups consecutive messages into conversation units, formats each unit as a readable transcript, embeds those, and attaches the result to the project so project-scoped chat retrieval picks it up immediately.

The DCE JSON schema was verified against the JsonMessageWriter source and documented CSV column set (as of the Feb 2026 DCE index) rather than from memory, since the parser is load-bearing. The parser is defensive: it validates the top-level shape and throws a diagnostic error naming the problem instead of producing garbage chunks.

### New module: src/discord.ts

Standalone, fully unit-tested (17 tests). Two public functions:

`parseDiscordExport(json)` -> normalized messages. Resolves channel name (category / name when both present), uses author nickname when set else name, marks bot messages, keeps Default + Reply message types, drops system notifications (joins, pins, thread-created, calls, etc.) and empty-content (attachment-only) messages. Handles migrated usernames (discriminator "0"). Throws on non-DCE input.

`chunkDiscordMessages(messages, options)` -> conversation chunks. Groups consecutive same-channel messages into a unit; a gap over `gapMinutes` (default 15) or a channel change starts a new unit. Each chunk is formatted with a channel header and `Author (timestamp): content` lines. Units over `targetChars` (default 1000) split on message boundaries with the header repeated; a single oversized message is hard-split on word boundaries. Each chunk carries channel, distinct authors (first-seen order), and time range metadata. `includeBots` (default true) keeps bot messages.

Defaults that are tuning knobs, not laws: 15-minute conversation gap (DCE's own HTML export groups same-author messages within 7 minutes, but this chunker groups across authors so a wider gap fits), 1000-char target (2x the 500-char document default, since conversation units benefit from more context), include bots (MUDD likely uses bots for game mechanics). All overridable per-import via the options body.

### Schema

`project_messages` table: raw parsed messages, first-class, so the corpus can be re-chunked later (e.g. with an improved chunker) without re-uploading. Retrieval does NOT read this table; it reads chunks. The table is purely for re-processing and audit. Tied to both project and document, cascading on delete of either.

Four nullable columns added to `chunks`: `channel`, `authors`, `sent_at_start`, `sent_at_end`. Document chunks leave these NULL; Discord chunks populate them. The v0.20.4 retrieval filters read these. As with v0.20.2's `chats.project_id`, the ALTER statements aren't idempotent in SQLite. **[Corrected in v0.20.4]** This entry originally said re-applying schema.sql surfaces warnings wrangler treats as non-fatal; that is wrong (a duplicate-column ALTER aborts the whole transaction). Apply schema changes via the per-release delta file `migrate-v0.20.3.sql`, never by re-running `schema.sql` against an existing database.

### New endpoint

```
POST /api/projects/:id/import-discord
Body: { filename?, data: base64, options?: { gapMinutes, includeBots } }
Response: { document_id, project_id, guild, channel,
            raw_message_count, imported_message_count, chunk_count }
```

Pipeline mirrors handleDocumentUpload: validate project ownership, decode + size-check, parse, chunk, store the export in R2, insert a documents row, attach it to the project, persist raw messages to project_messages, embed chunks and upsert to Vectorize, insert chunk rows with the metadata columns. Full rollback on embedding failure (vectors, project_messages, project_documents, documents row, R2 object).

The chunk embed/store loop is a deliberate near-duplicate of handleDocumentUpload's rather than a shared helper: the document path is higher-traffic and has no integration tests, so refactoring it to share code risks regression disproportionate to ~30 saved lines. Consolidation is noted as a future cleanup once integration tests exist.

### Cascade updates

`handleDocumentDelete` now also deletes `project_messages` for the document. `handleProjectDelete` now also deletes `project_messages` for the project. Both keep behavior consistent with the existing membership cascades.

### Touch points

- `src/discord.ts`: new, 320 lines. Parser + chunker.
- `tests/discord.test.ts`: new, 17 tests covering parse filtering, nickname resolution, bot marking, reply handling, malformed input, channel grouping, gap splitting, oversized-message splitting, author ordering, time ranges, includeBots.
- `src/index.ts`: 3474 -> ~3700 lines. Import, handleDiscordImport, route registration, two cascade additions.
- `schema.sql`: 191 -> 237 lines. project_messages table + two indexes, four chunks columns.
- `package.json`: 0.20.2 -> 0.20.3.

No new dependencies. No new bindings. Worker tests: 95/95 pass (78 prior + 17 new).

### Apply order

```
patch -p1 < v0.20.3-schema.patch
wrangler d1 execute skyphusion-llm --remote --file=schema.sql
patch -p1 < v0.20.3-discord-ts.patch
patch -p1 < v0.20.3-discord-test.patch
patch -p1 < v0.20.3-worker.patch
patch -p1 < v0.20.3-changelog.patch
npm test && npm run typecheck
patch -p1 < v0.20.3-package-json.patch
```

### Smoke test (curl, with a real export)

```
TOKEN=$(cloudflared access token --app=https://skyphusion.org)
B64=$(base64 -w0 mudd-export.json)
printf '{"filename":"mudd-export.json","data":"%s"}' "$B64" > /tmp/import-body.json
curl -X POST https://skyphusion.org/api/projects/<PID>/import-discord \
  -H "cf-access-token: $TOKEN" \
  -H "content-type: application/json" \
  --data @/tmp/import-body.json
```

Expect a summary with raw_message_count, imported_message_count, and chunk_count. Then query the project with use_docs to confirm Discord chunks are retrieved:

```
curl -X POST https://skyphusion.org/api/chat \
  -H "cf-access-token: $TOKEN" -H "content-type: application/json" \
  -d '{"model":"@cf/meta/llama-3.2-3b-instruct","user_input":"<question about the channel>","project_id":<PID>,"use_docs":true}' \
  | jq '.retrieved_chunks | map({document_id, filename, chunk_index})'
```

### What's next: v0.20.4

- Frontend "import Discord export" button in the project view (file picker -> base64 -> this endpoint).
- Retrieval filters on the chat request: author / channel / date range, reading the chunk metadata columns this release added.
- Presigned R2 upload for exports over the 10MB worker request limit.

## v0.20.2

Conversation -> project association. Chats started while a project is active now persist that project_id; the sidebar shows a project chip on each conversation; conversations can be moved between projects (or out of any project) via a per-row dropdown. Half of the original v0.20.2 scope; Discord JSON ingestion moves to v0.20.3.

### Why the split

Original v0.20.2 was scoped at 5-7 days (Discord ingestion + conversation association + retrieval filters + presigned uploads). That breaks the 1-3 day release cadence. Splitting at the natural seam:

- v0.20.2 (this release): conversation association. Small, well-defined, makes the sidebar feel project-aware. No new tables; one column added.
- v0.20.3 (next sprint): Discord ingestion stack. New table, JSON parser, conversation-aware chunker, retrieval filters, presigned upload for >10MB exports.

The two are independent and don't share code paths.

### Schema

One column added to `chats`, one partial index:

```sql
ALTER TABLE chats ADD COLUMN project_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_chats_project
  ON chats(project_id, created_at DESC) WHERE project_id IS NOT NULL;
```

`ALTER TABLE ADD COLUMN` is NOT idempotent in SQLite (no `IF NOT EXISTS` syntax for it). **[Corrected in v0.20.4]** This entry originally claimed re-applying `schema.sql` against an already-migrated DB produces a non-fatal warning that wrangler continues past. That is wrong: `wrangler d1 execute --file` runs the whole file as one transaction, so a duplicate-column `ALTER` raises `SQLITE_ERROR` and aborts the entire transaction, rolling back every statement. Do not re-run `schema.sql` against an existing database. The correct path is a per-release delta file containing only the new statements; see the v0.20.4 entry and the "Migrating an existing deployment" section of the README.

Pre-v0.20.2 chats carry `project_id = NULL` and continue to work unchanged. The column is nullable; there's no migration to backfill historical chats.

### Worker

`PersistArgs` interface gains `project_id?: number | null`. The `INSERT INTO chats` statement gains the `project_id` column and bind value. Both `runChat` and `runChatStream` pass `project_id: scopedProjectId ?? null` from their existing `resolveProjectForChat()` result. Non-chat dispatchers (image, TTS, video, music, STT) don't pass project_id, so non-chat rows continue to carry NULL.

`handleConversationList` gains a subquery selecting the conversation's first turn's `project_id` and returns it on each row. The convention: a conversation's "project membership" is the project_id of its first turn. The move endpoint updates ALL turns atomically, so within a single conversation this value is uniform; reads need only the first turn.

New endpoint:

```
PATCH /api/conversations/:id/project
Body: { project_id: number | null }
Response: { conversation_id, project_id, rows_updated }
```

Validation:
- `project_id = null` clears the assignment.
- `project_id = positive integer`: project must exist and be owned by the same user. Cross-user / unknown project_id returns 404.
- The conversation itself must exist and be owned by the user. Stale conversation_id returns 404 rather than silently no-oping.

The actual mutation is one statement: `UPDATE chats SET project_id = ? WHERE conversation_id = ? AND user_email = ?`. All turns in the conversation are updated in one DB call.

### Frontend

Conversation rows in the sidebar:

- Show a small project chip (`.conv-proj-chip`) when the conversation's first turn has `project_id`. The chip resolves the id to a name from the cached `state.projects` list, avoiding an extra API call per row.
- Stale chip (project deleted) renders muted (`.conv-proj-chip-stale`) with the placeholder text "project" rather than blowing up.
- A new "move" button (^ arrow) appears on hover. Clicking opens a dropdown menu (`.move-menu`) listing "(no project)" plus every project the user has, with the current selection highlighted (.current with a checkmark).

The dropdown:

- Position-attached to the move button via `position: fixed` with `getBoundingClientRect()` coordinates. Appended to `<body>` so the sidebar's overflow doesn't clip it.
- Flips above the button when there's not enough room below.
- Closes on outside click, Escape key, or selecting an item.
- Outside-click listener is registered on `setTimeout(..., 0)` so the click that opened the menu doesn't immediately close it.

`moveConversationToProject(convId, projectId)` PATCHes the new endpoint, then re-runs `loadConversations()` to refresh the list.

Chats started while a project is active already include `project_id` in the chat request body (v0.20.1 wiring). What changed in v0.20.2 is that the worker now PERSISTS this field on the chat row.

### Touch points

- `schema.sql`: 161 -> 191 lines (+30). Column add + partial index.
- `src/index.ts`: 3391 -> 3474 lines (+83). PersistArgs field, INSERT extension, two persistChat call sites, conversation list subquery + result type, handleConversationMoveToProject (new), route registration.
- `public/app.js`: 1781 -> 1911 lines (+130). Chip rendering in loadConversations, move button + handler in history-list listener, move-menu open/close/render/PATCH functions appended at end.
- `public/styles.css`: 1387 -> 1489 lines (+102). Chip and stale-chip variants, move button, move-menu dropdown.
- `package.json`: 0.20.1.1 -> 0.20.2.

No new dependencies. No new bindings. No new secrets. 78/78 tests still pass.

### Smoke test (manual)

After deploying v0.20.2 (apply schema first):

1. Start a NEW chat with MUDD project active. Submit a turn. Refresh the page.
2. The conversation appears in the sidebar with the "MUDD" chip visible next to the preview.
3. Open a different chat that has NO project_id (any pre-v0.20.2 conversation). Hover the row -> the ^ button appears at the right.
4. Click ^ -> dropdown opens below the button with "(no project)" highlighted and "MUDD" as an option.
5. Click "MUDD" -> dropdown closes. The chip appears on that row.
6. Click ^ again -> dropdown opens; "MUDD" is now highlighted (checkmark).
7. Click "(no project)" -> chip disappears.
8. Delete the MUDD project. Refresh. Any conversation previously tagged with MUDD now shows a muted "project" chip (stale).

### curl verification

```bash
WORKER=https://your-worker

# Move conversation to project 1
curl -X PATCH $WORKER/api/conversations/<conv-id>/project \
  -H "content-type: application/json" \
  -d '{"project_id":1}'
# Expect { conversation_id, project_id: 1, rows_updated: N }

# Clear assignment
curl -X PATCH $WORKER/api/conversations/<conv-id>/project \
  -H "content-type: application/json" \
  -d '{"project_id":null}'
# Expect { conversation_id, project_id: null, rows_updated: N }

# Bad project_id
curl -X PATCH $WORKER/api/conversations/<conv-id>/project \
  -H "content-type: application/json" \
  -d '{"project_id":99999}'
# Expect 404 {"error":"Project not found"}

# Verify list returns project_id
curl $WORKER/api/conversations | jq '.conversations[] | {conversation_id, first_input, project_id}'
```

### What's next: v0.20.3

- New `project_messages` table for raw Discord rows (author, channel, timestamp, content).
- Apify and DiscordChatExporter JSON shape parsers.
- Conversation-aware chunker that groups messages by author+time+topic boundaries, rather than the current naive token-window split.
- Optional retrieval filters: `?author=`, `?channel=`, `?after=`, `?before=` on the chat request body so Megan can ask "what did Player1 say about the underground city last week?".
- Presigned R2 upload for Discord exports larger than the worker request limit (~10MB).

Bake v0.20.2 first. Megan should be able to tag her chats by project before adding Discord ingestion on top.

## v0.20.1.1

Hotfix: modals were always-visible after v0.20.1 deploy, including immediately on page load with no way to dismiss them. Bug found by Conrad right after deploying v0.20.1.

### The bug

In v0.20.1's CSS, the `.modal { display: flex }` rule overrode the user-agent stylesheet's `[hidden] { display: none }`, which meant modals rendered always regardless of whether the JS set `el.hidden = true`. The JS hide/show logic was correct (every `openX()` and `closeX()` function set `.hidden` appropriately), but the CSS specificity made the JS state irrelevant to the rendered DOM.

Same bug on `.active-project-chip` (`display: inline-flex`).

### The fix

Two CSS rules added, three lines total:

```css
.modal[hidden] { display: none; }
.active-project-chip[hidden] { display: none; }
```

The `[hidden]` attribute selector beats the unqualified class selector, so the hidden contract is restored. Every existing JS call to `el.hidden = true` immediately works again.

### Touch points

- `public/styles.css`: 1387 -> 1398 lines (+11; two attribute-selector rules with explanatory comments).
- `package.json`: version bump 0.20.1 -> 0.20.1.1.

No JS changes, no HTML changes, no worker changes. No new tests. The fix is pure CSS.

### Lesson

When using the `hidden` HTML attribute as the toggle for an element, any CSS rule that sets `display: <anything other than initial/inherit>` on that element MUST be paired with `el[hidden] { display: none }`. Better default for future modals/chips: lead with the attribute-respect rule, then the layout rule, in that order.

## v0.20.1

Second half of projects + knowledge stores: frontend UI. The backend from v0.20.0 was verified end-to-end via curl before this work started (5/5 chunks correctly scoped to a single attached document on prod). v0.20.1 makes the feature usable through the browser.

Also fixes one bug found during v0.20.0 testing: `handleDocumentDelete` did not cascade to `project_documents`, so deleting a document that was attached to a project would leave an orphan membership row pointing at a non-existent document.

### UI surface

**Sidebar projects section** (between history and documents):
- List of all projects with name + document count.
- Active project is visually highlighted (left-edge accent bar).
- Hovering a row reveals `docs` and `edit` action buttons.
- `+ new` button at the section header opens the project modal in create mode.
- Empty state ("no projects yet...") when the user has no projects.

**Active project chip** (next to the model picker in the composer):
- Visible only when a project is active.
- Shows `project: <name>` with an `x` to clear.
- Chat requests automatically include `project_id` while active (chat-type models only; the field is silently dropped server-side for non-chat).

**Project modal** (create + edit, single component):
- Fields: name (required, max 200), description, system prompt.
- Cmd/Ctrl+Enter from any field submits.
- Edit mode adds a Delete button (deletes the project; documents stay).
- Modal closes on Escape, backdrop click, Cancel, or successful save.

**Document picker modal** (manage which docs belong to a project):
- Opens via the `docs` action button on a project row.
- Shows ALL the user's documents as checkboxes; ticking attaches, unticking detaches.
- Each toggle is sent immediately (no batched save). Project doc counts in the sidebar update live as the picker is used.
- Empty state ("no documents uploaded yet...") when the user has no documents.

### Persistence

The active project id is stored in `localStorage` under `skyphusion.activeProjectId`. On page load:
- If the saved id matches an existing project, that project becomes active automatically.
- If the saved id is stale (project deleted in another tab, etc.), the key is silently cleared.
- If `localStorage` is unavailable (private mode, denied permissions), the feature degrades to in-memory-only without errors.

### Chat integration

The `run()` function in `app.js` was extended to include `project_id` in the chat request body when a project is active and the current model is `type: "chat"`. Other model types (image gen, TTS, video, music, STT) drop the field server-side regardless; the frontend doesn't need to gate on type.

### Backend bug fix

`handleDocumentDelete` now includes a `DELETE FROM project_documents WHERE document_id = ?` in its cascade batch. Prior to this, deleting a doc that was attached to one or more projects left orphan rows in the join table. Those rows were harmless to retrieval (the chunks JOIN to documents would drop them when the doc was gone) but cluttered the DB and could show up in raw queries. The cascade is now consistent with project deletion's handling of memberships.

### Touch points

- `public/app.js`: 1391 -> 1781 lines (+390). New section for projects state, API helpers, renderers, modal handlers, document picker, localStorage persistence, and event wiring. One-line addition in `run()` for project_id.
- `public/index.html`: 81 -> 116 lines (+35). Projects section in sidebar, active-project chip in composer, two modal blocks before `</body>`.
- `public/styles.css`: 1046 -> 1387 lines (+341). Project list styling, active-project chip, modal scaffolding, document picker.
- `src/index.ts`: 3391 -> 3392 lines (+1 net; +3 lines for the cascade, +1 comment line, -2 lines collapsed). `handleDocumentDelete` cascade fix.
- `package.json`: version bump 0.20.0 -> 0.20.1.

No new dependencies. No new D1 migrations. No new R2 prefixes. No new secrets. Worker tests: 78/78 still pass.

### Smoke test (manual, browser)

After deploying v0.20.1:

1. Open the app in a browser. Empty Projects section appears in the sidebar with "no projects yet..." message.
2. Click `+ new`. Modal opens. Fill name "MUDD", system prompt "You are a creative writing collaborator. Write scenes in second person." Save.
3. Project appears in the list, becomes active, the chip appears next to the model picker.
4. Upload a document via the existing Documents section.
5. Click `docs` on the MUDD project row. Picker opens. Tick the doc. Watch the doc count in the sidebar go from "0 docs" to "1 doc".
6. Click `done` to close picker.
7. Pick a chat model, type a prompt that matches the doc content, submit. Verify:
   - The response reflects the project system prompt (second-person scene description).
   - The retrieved chunks (visible in the transcript if present) come only from the attached doc.
8. Click the `x` on the project chip to clear. Chip disappears.
9. Click MUDD again in the sidebar to reactivate. Chip reappears.
10. Reload the page. MUDD should still be active (localStorage worked).
11. Click `edit` on MUDD. Rename to "MUDD: Worldbuilding". Save. Sidebar updates.
12. Click `edit` again. Click `delete`. Confirm. Project disappears; doc stays in Documents section.
13. (Cascade fix verification) Upload another doc. Attach to a new project. Then delete the doc. Verify the project's `docs` count drops to 0 (the orphan row would have kept it at 1 before this fix).

### What's next: v0.20.2

- Discord JSON ingestion (Apify shape) with conversation-aware chunking.
- Conversation `project_id` association (chats inherit the active project when started); "move chat to project" affordance in the conversation list.
- Save-output-to-knowledge: image gen / FLUX output can be saved into a project's doc set (metadata only for v0.20.2; thumbnail rendering deferred).

## v0.20.0

First half of the projects + knowledge stores feature: schema, worker API, and RAG project-scoping. **Backend only; no UI yet.** v0.20.1 adds the frontend. v0.20.0 is testable end-to-end with curl; running the migration against a production DB is safe (additive schema only).

This release was scoped as "stage 1 of v0.20.0" rather than the full feature because shipping the backend alone bakes independently. A schema or scoping bug caught at this stage doesn't cascade into UI work that depended on it.

### What a project is

A project groups documents (and in v0.20.1+, conversations) under a shared system prompt and retrieval scope. Documents can belong to multiple projects (many-to-many via `project_documents`). Each user has private projects scoped by `user_email`; cross-user access is rejected at the route layer.

The intended use case: split organizational contexts. A legal-research project bundles case PDFs and a system prompt that frames the assistant as a paralegal; a worldbuilding project bundles fiction notes and frames it as a creative collaborator. The same documents can live in both projects if you want them to.

### Schema (`schema.sql`)

Two new tables appended. The file is still a single `schema.sql` (no migration sequence), applied via `wrangler d1 execute --file=schema.sql`. New tables use `CREATE TABLE IF NOT EXISTS` so applying against an existing database is idempotent.

```sql
CREATE TABLE projects (
  id, user_email, name, slug, description, system_prompt,
  created_at, updated_at
);
CREATE UNIQUE INDEX idx_projects_slug_user ON projects(user_email, slug);

CREATE TABLE project_documents (
  project_id, document_id, added_at,
  PRIMARY KEY (project_id, document_id)
);
```

Slug is per-user-unique (two different users can both have `mudd`). Slug is derived from name at create time and stable across renames so URLs/storage keys don't shift if the user later renames "MUDD" to "MUDD: Worldbuilding".

### Worker API

Eight new endpoints, two modified endpoints. All scope by `user_email`; cross-user reads return 404, cross-user writes 400. Project handlers live next to the document handlers in `src/index.ts`.

```
GET    /api/projects                          list projects + document counts
POST   /api/projects                          create (body: {name, description?, system_prompt?})
GET    /api/projects/:id                      get project + its documents
PATCH  /api/projects/:id                      update name/description/system_prompt
DELETE /api/projects/:id                      cascade-delete memberships, keep documents
POST   /api/projects/:pid/documents/:did      attach document to project
DELETE /api/projects/:pid/documents/:did      detach document from project
GET    /api/documents?project_id=N            scope document list to project
POST   /api/chat        (accepts project_id)  project-aware chat (see below)
POST   /api/chat/stream (accepts project_id)  same, streaming
```

### Chat dispatch changes

`ChatRequest` gains an optional `project_id: number` field. Both `runChat` and `runChatStream` now call `resolveProjectForChat()` near the top of the function, which:

1. Looks up the project row (scoped to `user_email`). Unknown / cross-user `project_id` is logged and treated as no-project; the chat completes normally instead of erroring.
2. Computes the effective system prompt:
   - Per-turn `system_prompt` (after trim, non-empty): wins outright.
   - Otherwise, if a project resolved and its `system_prompt` is non-null: use that.
   - Otherwise: undefined (no system prompt).
3. Returns `scopedProjectId` for `retrieveContext`.

The effective prompt is mutated back onto `body.system_prompt` so all downstream code (provider call, persistence, conversation history) sees the same string. Project prompt changes do not retroactively edit older turns: each chat row persists what was actually sent.

### Retrieval scoping (`retrieveContext`)

When `projectId` is set:
- Vectorize is queried with `topK * 3` (overfetch) since project filtering happens in D1 after.
- The D1 join adds `JOIN project_documents pd ON pd.document_id = d.id` and filters by `pd.project_id = ?`.
- The output is then capped back to the caller's `topK` so chat-prompt size doesn't grow.

Without `projectId`, behavior is unchanged from v0.19.5: full-corpus retrieval scoped only by `user_email`. Existing chat requests that don't send `project_id` keep working identically.

The error-path message now distinguishes the two reasons for a Vectorize-matches-but-D1-empty result: (a) `user_email` mismatch, (b) project has no matching member documents. Both surface in `console.warn`.

### Slug allocation

`slugify("MUDD: Worldbuilding")` returns `"mudd-worldbuilding"`. Collision handling: if the slug is already taken for this user, suffix with `-2`, `-3`, etc. Bounded at 200 attempts; beyond that, the create handler throws (would indicate a degenerate input or pathological state).

### Touch points

- `schema.sql`: 99 -> 161 lines (+62). `projects` + `project_documents` tables and three indexes appended.
- `src/index.ts`: 2939 -> 3391 lines (+452). Project handlers, `resolveProjectForChat` helper, slugify + findFreeSlug helpers, retrieveContext scoping, project_id in chat dispatch, route registration, ProjectRow type.
- `package.json`: version bump 0.19.5 -> 0.20.0.

No new dependencies. No new secrets. No new bindings. Existing 78 tests still pass; the new code paths are exercised via the curl smoke test below since route handler tests aren't part of the suite.

### Smoke test (apply order matters)

1. Apply schema first: `wrangler d1 execute YOUR_DB --remote --file=schema.sql` (or `--local` for wrangler dev).
2. Deploy the worker.
3. Create a project:
   ```bash
   curl -X POST https://your-worker/api/projects \
     -H "content-type: application/json" \
     -d '{"name":"MUDD","description":"MUDD worldbuilding","system_prompt":"You are a creative writing collaborator helping flesh out a Discord-based interactive fiction world. Write in second person when describing scenes."}'
   ```
   Expect 201 with the project object including `id`, `slug` ("mudd"), and timestamps.

4. List projects: `curl https://your-worker/api/projects` - should show the new project with `document_count: 0`.

5. Pick an existing document id, attach it: `curl -X POST https://your-worker/api/projects/1/documents/5` (project id 1, doc id 5). Confirm via GET.

6. Send a chat with `project_id`:
   ```bash
   curl -X POST https://your-worker/api/chat \
     -H "content-type: application/json" \
     -d '{"model":"@cf/meta/llama-3.2-3b-instruct","user_input":"Describe the entrance to the underground city.","project_id":1,"use_docs":true}'
   ```
   The assistant response should reflect the project's system prompt (second-person scene description). Retrieved context (if any) should come only from the attached doc, not all your other docs.

7. Try a cross-user attack: create a project as user A, then with user B's auth, GET `/api/projects/<A's id>`. Should return 404.

8. Delete the project: `curl -X DELETE https://your-worker/api/projects/1`. Confirm the document still exists in `/api/documents`.

### What's next: v0.20.1 (frontend)

- Sidebar `Projects` section above `Documents`, listing existing projects.
- "+ new project" button -> modal with name/description/system_prompt.
- Click a project to expand: shows its docs, the system prompt (editable inline), and a "+ attach doc" picker.
- Composer shows a subtle indicator when a project is active ("project: MUDD"); send button includes `project_id` in the chat request.
- "New chat in this project" button in the project view; new conversations started while a project is selected auto-include the project_id.

After v0.20.1, v0.20.2 takes on Discord JSON ingestion + conversation-aware chunking.

## v0.19.5

Frontend-only release: adds drag-and-drop and clipboard-paste attachment paths, and fixes a latent guard in `handleFiles` that silently dropped attachments for STT and FLUX-2 image gen despite the UI showing the attach affordance.

### Drag-and-drop + paste

Two new ways to attach files:

- **Drag-and-drop**: drag any file onto the input area. While dragging, the input area gets a blue inset border and a "drop to attach" label in the upper-right corner. Drop anywhere in the input area to attach. Works for images (downscaled to 1280px for vision, 512px for FLUX-2 references), audio (becomes auto-transcribed input or STT source), and video (frame-extracted for vision-capable chat, or full file for Pegasus).
- **Paste**: paste images directly into the textarea (Cmd/Ctrl-V). Most common case is pasting a screenshot from Cmd/Ctrl-Shift-4 on macOS or the equivalent on Linux/Windows. Pure-text pastes pass through to the textarea normally; only paste events that contain a file are intercepted.

Both paths funnel into the existing `handleFiles()` function. All validation, size limits, downscaling, frame extraction, Pegasus full-video routing, and FLUX-2 reference-image caps apply identically to drag-drop and paste as they do to the existing attach button.

The drop zone is gated on `attachRow.style.display !== "none"` so models that don't accept attachments (TTS, video gen, music gen, non-FLUX-2 image gen) don't get a misleading drop-zone affordance.

### Bug fix: STT and FLUX-2 attachments

Discovered during the v0.19.5 work: `handleFiles()` had a top-level guard `if (m.type !== "chat") return;` that bailed out before the function reached its STT (audio attachment for transcription) and FLUX-2 (reference image for image gen) branches. The UI was showing the attach button for both model types (per `updateAffordance`), but clicking it and choosing a file resulted in a silent no-op because the click path went through `handleFiles`, which returned early.

The fix extends the guard to allow chat + STT + FLUX-2:

```js
const isFlux2 = m.id.startsWith("@cf/black-forest-labs/flux-2-");
if (m.type !== "chat" && m.type !== "stt" && !isFlux2) return;
```

This restores the behavior the UI was already advertising. The inner FLUX-2 image-handling branch (already present in the function but unreachable) now actually runs.

### Touch points

- `public/app.js`: 1310 -> 1391 lines (+81). One DOM reference added, one guard fixed, drag-drop block + paste handler added.
- `public/styles.css`: 1022 -> 1046 lines (+24). `.input-area` gets `position: relative` and a transition; `.input-area.drop-active` rules added for the inset border + "drop to attach" overlay label.
- `package.json`: version bump 0.19.4 -> 0.19.5.

No worker changes. No D1 migration. No R2 migration. No new dependencies. No new worker secrets. Existing 78 tests still pass (no test coverage of frontend; manual smoke test is the verification path).

### Smoke test

Manual checks after deploy:

1. Pick a vision-capable chat model. Drag an image from your file manager onto the input area. Verify the blue border appears during drag and the image shows in the attachment chip strip below the textarea.
2. With the same model, take a screenshot (Cmd/Ctrl-Shift-4) and paste into the textarea. Verify the image is captured as an attachment, not pasted as a filename string.
3. Switch to a TTS model. Try to drag a file onto the input area. Verify no blue border appears and the drop is rejected silently.
4. Switch to FLUX-2 (image gen). Drag a reference image. Verify the attachment chip appears (this would have silently failed in v0.19.4 and earlier).
5. Switch to an STT model. Drag an audio file. Verify the attachment chip appears (also previously silently failing).

### What's next

- v0.20.x: projects + knowledge stores. First v0.20.x sprint will be the schema + project CRUD UI; second sprint adds Discord JSON ingestion and per-project knowledge.

## v0.19.4

Chunking quality pass: replaces the fixed-window chunker with a recursive separator splitter (the LangChain `RecursiveCharacterTextSplitter` shape). Improves retrieval quality on prose-heavy corpora and lays the groundwork for v0.20.x project knowledge stores, where the chunker has to handle worldbuilding fiction and structured reference docs alongside legal documents.

### Why this changed

The previous fixed-window chunker had one design flaw: it searched for natural break points only in the last 1/3 of the 500-char window. If a paragraph break landed earlier (e.g. char 50 of a 500-char window), the chunker ignored it and dumped both paragraphs into one chunk. For inputs with many short paragraphs (Discord exports, dialog, lore notes), that produced chunks that mashed unrelated content together.

The new chunker respects ALL paragraph breaks, then falls back through a separator hierarchy when needed: paragraph -> line -> sentence -> clause -> word -> hard character split. Chunks can be smaller than target when a clean boundary makes them so; the merge step greedily combines adjacent fragments back up to target size with optional tail-overlap.

### Worker

- New `src/chunking.ts` exports `chunkText(text)`. Module-private helpers: `recursiveCharSplit` (separator hierarchy walker) and `mergeFragments` (greedy fragment combiner with tail-overlap). Constants `CHUNK_TARGET_CHARS` (500) and `CHUNK_OVERLAP_CHARS` (50) preserved from the previous implementation; behavior at default settings is similar on well-paragraph'd input but substantially better on Discord-style short-paragraph content.
- `src/index.ts` removes the local `chunkText` function (~30 lines) plus the two chunking constants. Adds one import line for the new module. Net diff: -32 lines.

### Test infrastructure

- `tests/chunking.test.ts`: 13 new tests organized into 6 describe blocks: edge cases (empty/short/exact-target), paragraph boundaries (respected ALL breaks, not just late-window), fallback separator hierarchy (line -> sentence -> word -> hard), overlap behavior, realistic content (worldbuilding paragraph + markdown), and size constraints (no chunk wildly exceeds target).
- Total test count: 65 -> 78. Suite still completes in ~60ms.

### Touch points

- `src/index.ts`: 2971 -> 2939 lines (-32).
- `src/chunking.ts`: new file, 161 lines.
- `tests/chunking.test.ts`: new file, 217 lines.
- `package.json`: version bump 0.19.3 -> 0.19.4.

No D1 migration. No R2 migration. No new dependencies. No new worker secrets. `npm run typecheck` still clean (zero errors).

### One behavior change to be aware of

Existing documents in your D1/Vectorize store were chunked by the old algorithm. They keep working - retrieval against them is unchanged - but their chunk boundaries reflect the old chunker. Re-uploading a document re-chunks it with the new algorithm; the old vectors stay until you delete the old document or re-ingest. If you want consistent chunking quality across an entire corpus, plan to re-ingest important documents at some point. The two coexist fine in the meantime.

### What's next

- v0.19.5: drag-drop + paste attachments (frontend-only, half-day-ish job)
- v0.20.x: projects + knowledge stores (the big feature, ~10-12 days)

## v0.19.3

Final stage of the chat provider dispatcher split. Extracts Workers AI streaming chat dispatch (`callWorkersAIStream`) into `src/providers/workers-ai.ts`, and extracts the env.AI binding wrappers (`aiRun`, `aiLogId`) into `src/ai-binding.ts` since they're used by every Workers AI code path (chat, STT, image gen, TTS, embeddings, the LongRun workflow), not just the chat provider. Also cleans up four stale parser imports that accumulated in `src/index.ts` through v0.19.0-2 extractions.

After v0.19.3, all per-provider chat dispatch logic lives in `src/providers/`, and `src/index.ts` no longer contains any provider-specific code paths for chat models. Non-chat dispatchers (image, TTS, STT, video, music) remain in `src/index.ts`; they entangle with the LongRun workflow and R2/D1 job state and are out of scope for the v0.19.x series.

Note on the Workers AI asymmetry: unlike the other three providers, this module only exports the streaming caller, not a non-streaming caller. Workers AI's non-streaming chat path calls `aiRun(env, model.id, { messages })` directly inline in the dispatch flow with no surrounding helper, so there's no `callWorkersAI` function to extract. Forcing symmetry by introducing a one-line wrapper would add code without adding clarity; the asymmetry honestly reflects the difference in how Workers AI's binding works versus the BYOK providers' direct fetch flow.

### Extraction summary

- `src/ai-binding.ts`: new file, ~30 lines. Exports `aiRun(env, model, params, returnRaw?)` and `aiLogId(env)`. The `RunOpts` and `RunFn` type aliases stay module-private. Used from `src/index.ts` (six call sites across chat, STT, image gen, TTS, embeddings, and the LongRunWorkflow) and from `src/providers/workers-ai.ts`.
- `src/providers/workers-ai.ts`: new file, ~83 lines. Exports `callWorkersAIStream`. Imports `aiRun` from `../ai-binding`, plus the standard parser modules.
- Inline type for the one remaining `env.AI.run` bypass-gateway call site in the image gen path (used for stream-incompatible models that need to skip gateway routing). Three lines of inline `type BypassRunFn` declaration rather than re-exporting `RunFn` from `ai-binding.ts` for a single use.

### Cleanup of stale parser imports

Through v0.19.0-2, `src/index.ts` accumulated four parser-related imports (`parseBedrockEventStreamFrames`, `interpretXaiSSEFrame`, `interpretWorkersAISSEFrame`, `interpretAnthropicSSEFrame`) that became unused as each provider was extracted. They're all removed in v0.19.3. `extractSSEDataPayloads` also removed since `callWorkersAIStream` was its last consumer in the worker entry.

### Touch points

- `src/index.ts`: 3055 -> 2971 lines (-84). One block of 5 stale parser imports collapsed to 0; new imports added for `ai-binding` and `workers-ai`; local `aiRun`/`aiLogId`/`RunOpts`/`RunFn` removed (12 lines); `callWorkersAIStream` section removed (~70 lines); inline `BypassRunFn` type added at one call site (3 lines).
- `src/ai-binding.ts`: new file, 30 lines.
- `src/providers/workers-ai.ts`: new file, 83 lines.
- `package.json`: version bump 0.19.2 -> 0.19.3.

No D1 migration. No R2 migration. No new dependencies. No new worker secrets. All 65 tests still pass. `npm run typecheck` still clean (zero errors).

### v0.19.x series summary

The chat provider dispatcher split is complete. `src/index.ts` has shrunk from 4100 lines (v0.17.2 baseline) to 2971 lines (v0.19.3), a 27% reduction. New layout:

```
src/
  index.ts           (worker entry, dispatch, persistence, RAG, workflow class)
  env.ts             (Env interface)
  types.ts           (InputAttachment family)
  models.ts          (catalog of 59 models)
  utils.ts           (parseDataUrl, base64ToBytes, extFromMime)
  ai-binding.ts      (aiRun, aiLogId)
  parsers/
    types.ts                  (ProviderStreamEvent)
    bedrock-eventstream.ts    (binary frame parser)
    sse-framer.ts             (shared SSE framer)
    xai-sse.ts                (OpenAI-compatible delta interpreter)
    workers-ai-sse.ts         (Workers AI delta interpreter)
    anthropic-sse.ts          (named-event interpreter)
  providers/
    anthropic.ts     (Claude chat: BYOK via AI Gateway)
    xai.ts           (Grok chat: BYOK via AI Gateway)
    bedrock.ts       (Nova chat + Pegasus video-Q&A: AWS SigV4)
    workers-ai.ts    (Workers AI chat: env.AI.run binding)
tests/
  ... (65 tests covering parsers; provider modules untested by design)
```

The architecture supports adding new chat providers by dropping a new file in `src/providers/`; the only worker-entry change needed is an import line and dispatch case.

## v0.19.2

Third stage of the chat provider dispatcher split. Extracts Bedrock chat dispatch (Nova Converse / ConverseStream + Pegasus 1.2 InvokeModel) into `src/providers/bedrock.ts`. Both API paths share AWS SigV4 credential setup, so they live in one module. Also extracts the `InputAttachment` discriminated union into a new `src/types.ts` so providers that consume attachments directly (Pegasus needs the raw video bytes) can typecheck without round-tripping through the worker entry.

This is the most complex extraction of the v0.19.x series:
- Two coexisting API paths (Converse for Nova chat, InvokeModel for Pegasus video-Q&A)
- AWS SigV4 via the `aws4fetch` dynamic import, so the bundle isn't loaded for users who only use other providers
- Pegasus path inspects `InputAttachment[]` directly (finds the `video_full` variant via type predicate), which is why the attachment types had to land in `src/types.ts` first
- Nova streaming pulls from the v0.18.0 binary eventstream parser (`parseBedrockEventStreamFrames`)

### Touch points

- `src/index.ts`: 3370 -> 3055 lines (-315). Removes attachment type definitions (29 lines), the Bedrock Nova section (192 lines), and the Pegasus section (91 lines). Adds import block for `./types` and `./providers/bedrock` (8 lines).
- `src/types.ts`: new file, 42 lines. Five exported types: `InputImageAttachment`, `InputAudioAttachment`, `InputVideoFramesAttachment`, `InputVideoFullAttachment`, `InputAttachment` (discriminated union). PersistedAttachment family stays in `src/index.ts` since only the persistence layer there uses it.
- `src/providers/bedrock.ts`: new file, 259 lines. Exports `callBedrockNova`, `callBedrockNovaStream`, `callBedrockPegasus`. The shared `prepareBedrockNovaRequest` (v0.17.2 dedup) stays module-private.
- `package.json`: version bump 0.19.1 -> 0.19.2.

No D1 migration. No R2 migration. No new dependencies. No new worker secrets. All 65 tests still pass. `npm run typecheck` still clean (zero errors). No behavior change (AWS request signing, Converse API message transform, eventstream parsing, and Pegasus video size validation are byte-equivalent to the v0.19.1 inline implementation).

### What's next

- v0.19.3: `src/providers/workers-ai.ts` (extracts `aiRun` wrapper, `callWorkersAI`, `callWorkersAIStream`). This is the final stage of the chat provider split; after it lands, `src/index.ts` no longer holds any per-provider dispatch logic for chat models. Non-chat dispatchers (image, TTS, STT, video, music) stay in `src/index.ts` for now.

## v0.19.1

Second stage of the chat provider dispatcher split. Extracts xAI chat dispatch (`prepareXaiRequest`, `callXai`, `callXaiStream`) into `src/providers/xai.ts` following the v0.19.0 pattern set by `src/providers/anthropic.ts`. Mechanical extraction; no behavior change.

xAI's API is OpenAI-compatible (same wire format as the underlying GPT spec) so no message transform is needed; the module is meaningfully simpler than the Anthropic one. Imports `Env` from `../env`, `ModelEntry` from `../models`, `ProviderStreamEvent` from `../parsers/types`, and the v0.18.1 SSE pipeline (`extractSSEDataPayloads` + `interpretXaiSSEFrame`) from `../parsers/`.

### Touch points

- `src/index.ts`: 3515 -> 3370 lines (-145). One import line added, full xAI section (comment header + `prepareXaiRequest` + `callXai` + `callXaiStream` plus their helpers) removed.
- `src/providers/xai.ts`: new file, ~154 lines (functions moved verbatim modulo `export` keywords and import block).
- `package.json`: version bump 0.19.0 -> 0.19.1 (patch bump; the scaffolding shipped in v0.19.0, this is a mechanical follow-on).

No D1 migration. No R2 migration. No new dependencies. No new worker secrets. All 65 tests still pass. `npm run typecheck` still clean (zero errors). No behavior change (request building, auth header construction, fetch flow, and SSE pipeline are byte-equivalent to the v0.19.0 inline implementation).

### What's next

- v0.19.2: `src/providers/bedrock.ts` (Nova Converse API + Pegasus 1.2 InvokeModel, both via aws4fetch SigV4)
- v0.19.3: `src/providers/workers-ai.ts` (env.AI.run wrapper, Llama / Qwen / DeepSeek / Mistral / etc.)

Each follows the same shape: import `Env`/`ModelEntry`/`ProviderStreamEvent` + relevant parser modules, export the non-streaming and streaming callers, remove the inline implementation from `src/index.ts`.

## v0.19.0

First stage of the chat provider dispatcher split. Extracts shared scaffolding (`src/env.ts`, `src/utils.ts`) and the first provider (`src/providers/anthropic.ts`) out of `src/index.ts`. v0.19.1-3 land the remaining three chat providers (xAI, Bedrock, Workers AI) following this same pattern; non-chat dispatchers (image, TTS, STT, video, music) stay in `src/index.ts` for now.

Staged this way intentionally: chat providers have well-bounded surface area (request build + transform + fetch + parser), so they can move one at a time with a reversibility point between each release. Non-chat dispatchers entangle with Workflows, R2, and D1 job state, so they need a different approach and are deferred.

### Scaffolding (one-time work, used by all v0.19.x releases)

- New `src/env.ts` exports the `Env` interface. Single authoritative source for the worker's binding shape; all provider modules will import it. Optional secret fields stay optional so deployers can leave BYOK keys unset without TypeScript complaining.
- New `src/utils.ts` exports `parseDataUrl`, `base64ToBytes`, `extFromMime`. Pure helpers with no I/O or env dependencies, callable from any module.
- New `src/providers/` directory holds per-provider chat dispatch modules. Convention: each exports the non-streaming caller (`callX`) and streaming caller (`callXStream`); request builders, transforms, and helper interfaces stay private to the module.

### Anthropic extraction (v0.19.0)

- New `src/providers/anthropic.ts` (~180 lines) owns `prepareAnthropicRequest`, `transformToAnthropic`, `AnthropicMessage` interface (now module-private), `callAnthropic`, and `callAnthropicStream`. Imports `Env` from `../env`, `ModelEntry` from `../models`, `ProviderStreamEvent` from `../parsers/types`, `parseDataUrl` from `../utils`, and the SSE framer + Anthropic interpreter from `../parsers/`.
- `src/index.ts` removes the local `Env` interface (~25 lines), three local utility functions (`parseDataUrl`, `base64ToBytes`, `extFromMime`, ~30 lines), and the entire Anthropic block (`prepareAnthropicRequest`, `callAnthropic`, `AnthropicMessage`, `transformToAnthropic`, `callAnthropicStream` plus their comment headers, ~210 lines). Adds three import statement groups at the top (~3 lines). Net diff: -262 lines.

### Touch points

- `src/index.ts`: 3777 -> 3515 lines (-262).
- `src/env.ts`: new file, ~40 lines.
- `src/utils.ts`: new file, ~60 lines.
- `src/providers/anthropic.ts`: new file, ~180 lines.
- `package.json`: version bump 0.18.4 -> 0.19.0 (minor bump because the new `src/providers/` directory establishes a pattern that v0.19.1-3 extend; contributors will want to know which provider lives where after the split).

No D1 migration. No R2 migration. No new dependencies. No new worker secrets. All 65 tests still pass. `npm run typecheck` still clean (zero errors). No behavior change (code moved verbatim modulo formatting; the Anthropic provider module is byte-equivalent to the v0.18.4 inline implementation plus exports).

### What's deferred to v0.19.1-3

- v0.19.1: `src/providers/xai.ts` (extract `prepareXaiRequest`, `callXai`, `callXaiStream`)
- v0.19.2: `src/providers/bedrock.ts` (extract `prepareBedrockNovaRequest`, `callBedrockNova`, `callBedrockNovaStream`, plus the Pegasus 1.2 video-Q&A dispatcher since it shares the same AWS SigV4 setup)
- v0.19.3: `src/providers/workers-ai.ts` (extract `aiRun` wrapper, `callWorkersAI`, `callWorkersAIStream`)

Each follow-on release is largely mechanical now that the scaffolding lives in `src/env.ts` and `src/utils.ts`; the provider files just absorb their respective code blocks and add appropriate imports.

## v0.18.4

Organizational refactor: move the MODELS catalog (and the `ModelType`, `Provider`, `ModelEntry` types it depends on) from `src/index.ts` into a new `src/models.ts` module. Pure relocation, no behavior change.

The catalog was the single largest contiguous block in `src/index.ts` at ~125 lines, growing every release as new models land. Pulling it into its own file makes catalog edits a localized diff instead of a wide change against the worker entry, makes the file easy to find for contributors, and gives a natural home for catalog-related comments (conventions for adding models, BYOK vs Unified Billing tagging, etc.).

- New `src/models.ts` exports `ModelType`, `Provider`, `ModelEntry`, and `MODELS`. File header documents the catalog conventions explicitly (label prefixes, BYOK markers, streaming flag, byok_alias for Bedrock chat and BYOK video).
- `src/index.ts` imports all four from `./models` at the top of file alongside the parser imports. Net diff: 2 lines added (the two import statements), 126 lines removed (the catalog block).

### Touch points

- `src/index.ts`: 3904 -> 3777 lines (-127, the catalog block plus one orphaned section header).
- `src/models.ts`: new file, 153 lines (28 lines of header documentation + 125 lines of catalog content moved verbatim from index.ts).
- `package.json`: version bump 0.18.3 -> 0.18.4.

No D1 migration. No R2 migration. No new dependencies. No new worker secrets. All 65 tests still pass. `npm run typecheck` still clean (zero errors).

## v0.18.3

Internal refactor: close the v0.17.2-era request-builder-dedup thread by factoring `callAnthropic` and `callAnthropicStream` to share a `prepareAnthropicRequest(env, model, systemPrompt, messages, { stream })` builder. Mirrors the existing v0.17.2 `prepareXaiRequest` and `prepareBedrockNovaRequest` pattern. No behavior change.

The Anthropic transform is the most involved of the four BYOK providers (system prompt extracted to a top-level field, OpenAI-style `image_url` content blocks rewritten as Anthropic-style `image` blocks with base64 source). All of that lives in `transformToAnthropic`, called from the new builder so both callers share it. Body fields (`stream: true`) and headers (`accept: text/event-stream`) conditional on `opts.stream`. Auth headers (`x-api-key`, `cf-aig-authorization`) constructed the same way for both callers.

- New `prepareAnthropicRequest(env, model, systemPrompt, messages, { stream })` returns `{ url, headers, body }`. Body is JSON-stringified; the callers just pass it to `fetch` without further processing.
- `callAnthropic` now calls the builder with `{ stream: false }`, then runs the standard non-streaming fetch -> JSON.parse -> return `{ raw, logId }` flow.
- `callAnthropicStream` now calls the builder with `{ stream: true }`, then runs the standard streaming fetch -> reader loop -> `extractSSEDataPayloads` -> `interpretAnthropicSSEFrame` flow (the v0.18.1 SSE pipeline).
- `cf-aig-log-id` extraction stays in `callAnthropic`'s non-streaming caller. AI Gateway doesn't surface that header on proxied SSE responses, so `callAnthropicStream` correctly continues to not look for it (returns no logId from the streaming path; D1 stores `ai_gateway_log_id: null` on streamed turns, matching existing behavior).
- `cf-aig-authorization` (set when `CF_AIG_TOKEN` is present) and `x-api-key` (set when `ANTHROPIC_API_KEY` is present, stored-keys-first auth) work identically across both callers via the shared builder.

### Touch points

- `src/index.ts`: 2 hunks (+34 / -30, net +4 lines). The builder is ~50 lines including the v0.18.3 explanatory comment; combined caller reductions outweigh it minus the comment.

No D1 migration. No R2 migration. No new dependencies. No new worker secrets. All 65 tests still pass. `npm run typecheck` still clean (zero errors).

## v0.18.2

Type hygiene fix: tighten `base64ToBytes` return type from `Uint8Array` (TS5.7+ default `Uint8Array<ArrayBufferLike>`) to `Uint8Array<ArrayBuffer>`. The implementation already returns an owned `ArrayBuffer` (`new Uint8Array(bin.length)` always allocates a fresh owned backing buffer), but the loose annotation erased that information at every call site. Concrete consequence: the `new Blob([base64ToBytes(...)], ...)` call in the FLUX.2 reference-image path failed strict typecheck because `Blob` constructors expect `ArrayBuffer`-backed views, not `ArrayBufferLike` (which includes `SharedArrayBuffer`).

Net effect: `npm run typecheck` is now clean (zero errors) for the first time since the TS5.7 `Uint8Array` generic change shipped. This makes typecheck a useful signal again; previously any new type error would have been masked by the persistent line-884 error in CI output.

### Touch points

- `src/index.ts`: 1 hunk, 1 line changed (function signature only).
- `package.json`: version bump 0.18.1 -> 0.18.2.

No behavior change. No D1 migration. No R2 migration. No new dependencies. All 65 tests still pass.

## v0.18.1

Completes the parser test story started in v0.18.0. Extracts SSE parsing for xAI, Workers AI, and Anthropic streaming into pure functions, refactors the three streaming generators to delegate to them, and adds 43 tests across four new test files. All three generators now share one SSE framer; per-provider event-type semantics live in dedicated interpreters.

### Worker

- New `src/parsers/sse-framer.ts` exports `extractSSEDataPayloads(buffer)` returning `{ payloads, remainder }`. Pure string-in/string-out function with no I/O. Handles the `\n\n` event-boundary split, `data:` line extraction (both spaced and compact prefix), `[DONE]` sentinel filtering, whitespace-only event filtering, and partial-event-as-remainder behavior. Multi-line `data:` "last wins" semantics preserved (none of our three providers emit multi-line data, but the inline implementations behaved that way and the framer matches exactly).
- New `src/parsers/xai-sse.ts` exports `interpretXaiSSEFrame(data)`. OpenAI-compatible chat completions delta format: extracts text from `choices[0].delta.content` and usage from `usage.prompt_tokens` / `usage.completion_tokens`. Empty-string deltas (typical for the final pre-usage frame) are dropped.
- New `src/parsers/workers-ai-sse.ts` exports `interpretWorkersAISSEFrame(data)`. Workers AI's flat `response` field rather than OpenAI's nested choices. Usage naming varies by underlying adapter; the interpreter accepts both `prompt_tokens`/`completion_tokens` and `input_tokens`/`output_tokens`, preferring OpenAI naming when both are present. Reasoning-model `<think>` blocks pass through unchanged for the UI to fold.
- New `src/parsers/anthropic-sse.ts` exports `interpretAnthropicSSEFrame(data)`. Named-event semantics distinguished by `data.type`: `message_start` (initial usage), `content_block_delta` with `delta.type=text_delta` (text), `message_delta` (final usage). `content_block_start`, `content_block_stop`, `message_stop`, `ping`, and unknown types ignored.
- `callXaiStream`, `callWorkersAIStream`, and `callAnthropicStream` in `src/index.ts` collapse to thin shells around `extractSSEDataPayloads` + JSON.parse + per-provider interpreter. Each generator's parsing loop is now ~10 lines instead of ~30-40.

### Test infrastructure

- `tests/sse-framer.test.ts`: 13 tests covering buffer states (empty, no-boundary, partial trailing), payload extraction (single, multiple, compact prefix, mixed prefixes, ignored `event:`/`id:`/`retry:` lines), dropped events (`[DONE]`, whitespace-only, empty `data:`), multi-data-line "last wins" semantics, and split-across-reads behavior.
- `tests/xai-sse.test.ts`: 7 tests covering text delta extraction, usage extraction, both-in-one-frame (rare but supported), empty content filtering, missing choices, missing delta content, and null token fallback.
- `tests/workers-ai-sse.test.ts`: 8 tests covering text via `response`, empty response filtering, OpenAI-naming usage, Anthropic-naming usage fallback, OpenAI-wins-when-both, reasoning-model `<think>` passthrough, and combined text+usage frames.
- `tests/anthropic-sse.test.ts`: 15 tests covering `message_start` usage (with and without), `content_block_delta` text vs tool-use vs missing text, `message_delta` usage (with and without, with null fallbacks), all five ignored event types, and a realistic eight-frame conversation sequence.

Total test count across the suite is now 65 (22 Bedrock from v0.18.0 + 43 new in v0.18.1), running in ~60ms.

### Touch points

- `src/index.ts`: 5 hunks (+47 / -134, net -87 lines). Imports gain four new lines for the new parser modules; three generator parsing loops each shrink by ~30 lines.
- `src/parsers/sse-framer.ts`: new file, ~35 lines.
- `src/parsers/xai-sse.ts`: new file, ~35 lines.
- `src/parsers/workers-ai-sse.ts`: new file, ~45 lines.
- `src/parsers/anthropic-sse.ts`: new file, ~50 lines.
- `tests/sse-framer.test.ts`: new file, ~115 lines.
- `tests/xai-sse.test.ts`: new file, ~55 lines.
- `tests/workers-ai-sse.test.ts`: new file, ~70 lines.
- `tests/anthropic-sse.test.ts`: new file, ~135 lines.
- `package.json`: version bump 0.18.0 -> 0.18.1. No new devDeps (Vitest already installed by v0.18.0).

No D1 migration. No R2 migration. No new worker secrets. No behavior change (parser logic is byte-identical to the v0.18.0 inline implementations; pure mechanical extraction validated by 43 new tests).

## v0.18.0

Adds test infrastructure (Vitest) and unit tests for the Bedrock Nova binary eventstream parser. The parser was extracted from `callBedrockNovaStream` into its own module to make it testable in isolation without loading the entire 4000-line worker module graph (which imports `cloudflare:workers`, unavailable in Node Vitest). 22 tests cover frame extraction, ignored frame types, error handling, and the realistic conversation event sequence.

### Worker

- New `src/parsers/types.ts` exports `ProviderStreamEvent`, the normalized envelope every streaming parser yields. Moved from `src/index.ts` so parsers can import it without circular reference. This is the contract for `/api/chat/stream` envelope events; adding a field is a breaking change for the wire format.
- New `src/parsers/bedrock-eventstream.ts` exports `parseBedrockEventStreamFrames(buf)` returning `{ events, remainder }`. Pure function with no I/O. Handles: partial frames split across reads, unknown header types (length-tabulated and skipped per AWS spec), `:message-type=exception` frames (throws), bogus frame lengths (throws), malformed JSON payloads (silently ignored), empty text deltas (ignored), and all event types Nova currently emits (`messageStart`, `contentBlockStart`, `contentBlockDelta`, `contentBlockStop`, `messageStop`, `metadata`, plus the `tool_use`-style delta variant that has no text field).
- `callBedrockNovaStream` in `src/index.ts` is now a thin shell that handles fetch I/O and AbortSignal, then delegates parsing to the pure function via one call to `parseBedrockEventStreamFrames(buf)`. The inline `append`/`readU32BE`/`parseHeaders` closure helpers are gone; the generator body is ~20 lines now instead of ~140.
- One incidental type fix: `let buf` in `callBedrockNovaStream` got an explicit `Uint8Array` annotation. Without it, TypeScript 5.7+ infers `Uint8Array<ArrayBuffer>` from `new Uint8Array(0)` but the parser's `remainder` return is `Uint8Array<ArrayBufferLike>` (the default generic), so reassignment fails strict typecheck. Pre-existing line-880 error on `new Blob([Uint8Array])` is untouched and not part of this change (it's a TS5.7 ergonomics issue tracked separately).

### Test infrastructure

- New `vitest.config.ts` at repo root. Node environment, `tests/**/*.test.ts` pattern. No `@cloudflare/vitest-pool-workers` adapter; pure-function parser tests don't need a Workers runtime. The adapter would slot in later if we wanted to test the worker fetch handler end-to-end.
- New `tests/bedrock-eventstream.test.ts` with 22 tests organized into 5 `describe` blocks: buffer states (3), event extraction (5), ignored frames (6), error frames with synchronous throws (5), and a realistic conversation stream walking the messageStart -> contentBlockDelta x N -> messageStop -> metadata sequence. Fixtures are hand-crafted per the AWS EventStream binary format spec via a `buildFrame(headers, payload)` helper.
- New `package.json` scripts: `test` (one-shot, for CI) and `test:watch` (continuous, for development).
- New devDeps: `vitest@^2.1.0` and `@types/node@^22.0.0`. `npm install` after applying the patch will pull both.

### Why split parsers into their own module

Originally I planned to keep parsers in `src/index.ts` and just `export` them, on the principle of preserving the single-Worker-file property. That broke in practice when Vitest tried to load the test file: Vite resolves the entire module graph during transform, and `src/index.ts` imports `cloudflare:workers` (Workers-runtime-only, unavailable in Node). Three ways out:

1. Stub `cloudflare:workers` via Vitest `resolve.alias` config.
2. Add `@cloudflare/vitest-pool-workers`, requiring miniflare just to run pure-function tests.
3. Split parsers out so tests only load what they need.

Option 3 is cleanest: faster test runs (no transform of xlsx/unpdf/aws4fetch), no test-only adapters or stubs, and v0.18.1 SSE parsers slot in alongside this one in the same directory.

The "one Worker file" property was about deployment simplicity (still preserved; esbuild bundles `src/index.ts` and its imports into one Worker .js bundle), not about literally one source file. The `src/parsers/` directory is the natural seam.

### What's deferred to v0.18.1

SSE parser extraction and tests for xAI, Workers AI, and Anthropic streaming. All three currently share the same `\n\n`-delimited SSE framer with provider-specific JSON interpretation; the pattern will follow the same shape as Bedrock (pure functions in `src/parsers/`, tests in `tests/`).

### Touch points

- `src/index.ts`: 4 hunks (+5 / -126, net -121 lines). Imports at top of file (+2 lines), `ProviderStreamEvent` local type removed (-3 lines), `callBedrockNovaStream` body collapsed (+0 / -125 effective).
- `src/parsers/types.ts`: new file, ~20 lines.
- `src/parsers/bedrock-eventstream.ts`: new file, ~150 lines (parser body identical to the old inline implementation, factored as exported function with imported type).
- `tests/bedrock-eventstream.test.ts`: new file, ~280 lines (22 tests + frame-construction helper).
- `vitest.config.ts`: new file, ~22 lines.
- `package.json`: version bump 0.17.2 -> 0.18.0, +2 devDeps, +2 scripts.

No D1 migration. No R2 migration. No new worker secrets. No behavior change (parser logic is byte-identical to the v0.17.2 inline implementation; pure mechanical extraction validated by 22 tests).

## v0.17.2

Internal refactor: extract shared request builders for the xAI and Bedrock Nova providers. Streaming and non-streaming callers for each pair now share their URL/headers/body construction instead of duplicating ~30 lines per pair. No behavior change.

- New `prepareXaiRequest(env, model, messages, { stream })` returns `{ url, headers, body }`. Body fields (`stream: true`, `stream_options.include_usage: true`) conditional on `opts.stream`. Both `callXai` and `callXaiStream` now call this and differ only in how they consume the response body (one `await resp.json()`, the other a `ReadableStream` reader loop).
- New `prepareBedrockNovaRequest(env, model, systemPrompt, messages, { stream })` returns `{ awsClient, url, bodyJson }`. Endpoint suffix (`converse` vs `converse-stream`) conditional on `opts.stream`. Both `callBedrockNova` and `callBedrockNovaStream` now call this. The Converse message transform (system message stripping, multi-part content flattening) lives in the builder, no longer duplicated.
- `cf-aig-log-id` extraction stays in `callXai`'s non-streaming caller. AI Gateway doesn't surface that header on proxied SSE responses, so `callXaiStream` correctly continues to not look for it. Same for `logId: null` in `callBedrockNova`'s return shape; the streaming variant continues to not return a logId at all (different return shape from the non-streaming caller).
- Anthropic helpers NOT yet deduped. `callAnthropic` and `callAnthropicStream` share the same pattern (both call `env.AI.gateway(...).getUrl("anthropic")` independently) but the transform is more involved (system prompt extraction, content-block flattening for vision attachments). Deferred to a follow-up commit so the diff stays surgical.
- Workers AI helpers NOT deduped. `runAi` already abstracts the binding call; `callWorkersAIStream` is the only place that uses `env.AI.run({stream:true})`, so there's no duplication to factor out.
- No new types exported. `awsClient` type inferred from the dynamic import, same as before.
- Net diff: 8 hunks (+57 / -65, net -8 lines) in `src/index.ts`.
- No behavior change. No D1 migration. No new dependencies.

## v0.17.1

Internal refactor: `InputAttachment` becomes a discriminated union, matching the existing `PersistedAttachment` style already used in the project. No behavior change.

- The old shape was a flat interface with all variant-specific fields optional (`data?`, `frames?`), which forced inline narrowing (`if (att.type !== "image" || !att.data) continue`) and prevented filter-callback type predicates from working cleanly. A v0.16.0 attempt to cast against a fictional `InputImageAttachment` failed to compile and had to fall back to inline `att.type !== "image" || !att.data` narrowing.
- New shape: four variant interfaces (`InputImageAttachment`, `InputAudioAttachment`, `InputVideoFramesAttachment`, `InputVideoFullAttachment`) discriminated on `type`, combined via a `type InputAttachment = | ... | ...` union alias. Mirrors the `PersistedAttachment` family exactly. TypeScript now narrows automatically inside `if (att.type === "image") { ... }` blocks, and type predicates on `find` / `filter` callbacks (e.g., `(a): a is InputVideoFullAttachment => a.type === "video_full"`) narrow the result.
- Cleanups enabled by the new shape:
  - `runChat` (around line 610): `imageDataUrls.push(att.data!)` becomes `imageDataUrls.push(att.data)`; the non-null assertion is no longer needed because the union narrows `att.data` to `string` after `att.type === "image"`.
  - `runChatStream` (around line 1471): same.
  - `runVideo` Pegasus `find` (around line 2428): added type predicate `(a): a is InputVideoFullAttachment => a.type === "video_full"`. The `?? ""` fallback on `videoAtt.data` is now superfluous (type is `string`, not `string | undefined`) and removed.
- Defensive runtime checks (`att.data ? parseDataUrl(att.data) : null`, `att.frames ?? []`) kept in place. They guard against malformed JSON arriving at the API boundary, which the type system can't prevent. Removing them would shift behavior, not just types.
- Net diff: 4 hunks (+40 / -9) in `src/index.ts`.
- No behavior change. No D1 migration. No new dependencies.

## v0.17.0

Adds web-search as an opt-in retrieval source alongside RAG. Tavily (general web) + Wikipedia (reference and lore) queried in parallel; results folded into the system prompt the same way RAG chunks already are. Designed for creative work and worldbuilding, where you want the model to do synthesis rather than a search engine's pre-summary.

### Worker

- New `searchWeb()` helper hitting Tavily (POST `/search` with `include_answer:false`, `include_raw_content:false`, max 5 snippets) and Wikipedia (MediaWiki search API, max 3 snippets, HTML-stripped). Both run via `Promise.all` with per-source 8-second timeouts and per-source try/catch, so one failing or timing out never kills the other.
- `ChatRequest` gains `use_web_search?: boolean`. `Env` gains optional `TAVILY_API_KEY`. When the key is unset, Tavily is silently skipped and only Wikipedia runs.
- `RetrievedChunk` extended with an optional `source_type?: "rag"` discriminator (existing rows without the field are treated as RAG for back-compat). New `RetrievedWebResult` type with `source_type: "web"`, `source: "tavily" | "wikipedia"`, `url`, `title`, `snippet`, optional `score`. Union type `RetrievedItem` covers both.
- Effective system prompt assembly in both `runChat` and `runChatStream` becomes a three-part filter+join: user prompt, then RAG block (if present), then web block (if present). Either or both retrieval blocks may be empty.
- Persistence: the existing `retrieved_context` D1 column now stores a unified `RetrievedItem[]` array combining RAG chunks and web results from the same turn, discriminated by `source_type`. No schema migration; the column was already JSON.
- New chat response field `web_results` (parallel to existing `retrieved_chunks`). Diagnostics: `effective_system_prompt` now surfaces when either `use_docs` or `use_web_search` was on; new `web_search_error` field mirrors the existing `retrieval_error` field.

### Frontend

- `index.html`: new `<label id="use-web-search-row">` next to the existing `<label id="use-docs-row">` in the bottom row.
- `app.js`: new element refs (`useWebSearchRow`, `useWebSearchCheckbox`). `updateAffordance` enables the toggle for chat models only (no doc-count gate). `sendChat` request body plumbs `use_web_search: true` when toggle is checked and model is chat. `renderRetrievedChunksHTML` branches on `source_type`: web results show title + clickable URL + snippet with a `retrieved-web` class modifier; RAG chunks render unchanged. Mixed-source label ("retrieved context (N docs + M web)") handles turns that use both.

### Wikipedia compliance

The worker sends a descriptive `User-Agent` identifying the project and repo URL per Wikimedia's User-Agent policy. If you fork to a different repo name, update the UA string in `searchWikipedia`.

### Token budget

A turn with `use_web_search:true` adds roughly 1500-3000 tokens to the system prompt (Tavily 5 + Wikipedia 3 by default). The per-turn toggle is intentional; auto-search every turn would waste tokens and Tavily credits.

### What this is not

This is query-time web search for creative work and current-events questions. It is NOT designed for legal research, citation-accurate work, or anywhere paraphrase drift or hallucinated URLs could cause harm. For that pattern, curated periodic ingest into Vectorize (with `source_type`, `source_url`, `content_hash` columns on `documents`) is the right shape.

### Touch points

- `src/index.ts`: 16 hunks (+207 / -18)
- `public/index.html`: 1 hunk (+4 / -0)
- `public/app.js`: 5 hunks (+42 / -2)
- `wrangler.example.toml`: 1 hunk (+2 / -1, comment block only)

No D1 migration. No new dependencies. New optional worker secret: `TAVILY_API_KEY` (skip it and Wikipedia-only is the fallback).

## v0.16.0

Three additions filling in gaps from v0.13.0 (streaming foundation) and v0.14.0 (BYOK simplification). Each lands as its own commit; the v0.16.0 tag goes on the third.

### SSE Pass 3: xAI Grok streaming

All four xAI catalog entries (grok-4.3, grok-4.20-multi-agent-0309, grok-4.20-0309-reasoning, grok-build-0.1) gain `streaming: true` and route to a new `callXaiStream` async generator.

xAI exposes standard OpenAI-compatible SSE: `data: {choices:[{delta:{content}}]}` frames terminated by `data: [DONE]`. With `stream_options.include_usage: true` (which we set), the final frame before [DONE] carries token counts. The generator parses both and yields normalized text + usage events into the existing flat ProviderStreamEvent envelope.

Transport is direct fetch through AI Gateway's xAI proxy (`/v1/chat/completions`), not the env.AI binding; same shape as the non-streaming `callXai` it sits beside. AbortSignal is forwarded to fetch() so client disconnect cancels the upstream call mid-generation (saving tokens).

handleChatStream's provider gate now allows "xai" alongside "anthropic" and Workers AI. runChatStream dispatch refactored from a ternary to if/else-if/else chain so adding providers is a one-line append.

### SSE Pass 4: Bedrock Nova streaming

The four Nova catalog entries (nova-2-lite, nova-2-pro, nova-lite, nova-pro) gain `streaming: true` and route to a new `callBedrockNovaStream` async generator. Pegasus stays as-is; it's single-shot video Q&A using InvokeModel, not ConverseStream-eligible.

The hard part is the wire format. Bedrock uses `application/vnd.amazon.eventstream`, a binary framing protocol. Each frame:

  [4 bytes BE]  total_length
  [4 bytes BE]  headers_length
  [4 bytes BE]  prelude_crc       (CRC32 of first 8 bytes, skipped)
  [N bytes]     headers           (name/type/value triplets)
  [M bytes]     payload           (JSON for the events we care about)
  [4 bytes BE]  message_crc       (skipped)

  payload_bytes M = total_length - 16 - headers_length

The header parser handles type 7 (UTF-8 string with 2-byte BE length prefix) directly; that's what `:message-type`, `:event-type`, and `:content-type` use. Other header types (booleans, integers, byte arrays, UUIDs) are length-tabulated and skipped defensively, so an unknown header type can't desync the stream.

Event types we react to:
- `contentBlockDelta` produces a text delta (`{delta:{text:"..."}}`)
- `metadata` produces a usage event (`{usage:{inputTokens, outputTokens}}`)
- `exception` (via `:message-type=exception`) throws with the payload's `message` field

Other event types (messageStart, contentBlockStart, contentBlockStop, messageStop) carry no info for the flat envelope and are ignored.

Endpoint suffix is `converse-stream` (not `converse`). aws4fetch signs the request with SigV4 and forwards the `signal` option to fetch(), so AbortSignal-based cancellation works the same as xAI and Workers AI.

The handleChatStream gate now also permits "bedrock". The catalog `streaming` flag is the real filter; Pegasus would fail the `model.streaming` check above the provider gate anyway.

### FLUX.2 reference images

Cloudflare's FLUX.2 models (Klein 9B, Klein 4B, Dev) accept up to 4 reference images as multipart form fields `input_image_0` through `input_image_3`, each at most 512x512 px.

**Worker (src/index.ts):** runImage's FLUX.2 multipart branch now iterates `body.attachments` after the prompt/width/height/negative_prompt fields. For each image attachment (`type === "image"` with `data` set, up to 4), parse the data URL via `parseDataUrl`, decode base64 to bytes, wrap in a Blob, and append as `input_image_{0..3}`. Beyond 4 silently skipped; the frontend caps client-side too.

**Frontend (public/app.js):** Two new constants at the top: `FLUX2_REF_IMAGE_MAX_DIM = 512` and `MAX_FLUX2_REF_IMAGES = 4`. Then two function patches.

First, `updateAffordance` for image-mode models now detects FLUX.2 (id prefix `@cf/black-forest-labs/flux-2-`) and shows the attach row with the hint `"optional: up to 4 reference images (downscaled to 512px)"`. Other image-gen models still hide the attach row.

Second, `handleFiles` for image uploads has a FLUX.2 branch that bypasses the `modelSupports("vision")` check; the vision capability flag is for input analysis, not for using images as generation references. The branch counts existing image attachments, throws on the 5th, and downscales to 512 px (via `FLUX2_REF_IMAGE_MAX_DIM`) instead of the chat-side 1280.

### Touch points

- `src/index.ts`: 9 hunks total (+361 / -17)
- `public/app.js`: 3 hunks (+40 / -8)

No D1 migration. No R2 migration. No new dependencies. No new worker secrets.

## v0.15.0

UI: replace the flat `<select>` model dropdown with a collapsible picker.

The catalog reached ~50 models across 6 modalities; finding Opus 4.7 by scrolling past every video and music model became friction. The new picker groups by catalog `group` field with `<details>` accordion sections, expands the first group by default, and surfaces capability badges (vision, stream) next to each item.

**Architecture:**

- `<select id="model">` becomes `<div id="model" class="model-picker">`. The element ID stays so existing `document.getElementById("model")` lookups still resolve.
- `modelSelect` is now a JS shim exposing the same surface the rest of `app.js` already uses: `.value` getter and setter, plus `addEventListener("change", fn)`. Programmatic `modelSelect.value = "..."` does NOT fire `change`, matching native `<select>` behavior; user-driven clicks do.
- `loadModels()` switched from `modelSelect.innerHTML = ...` (assembling `<option>` / `<optgroup>` strings) to `modelSelect.populate(grouped)`. Every other call site (`loadConversation`, `loadTurnIntoComposer`, `currentModel`, the change listener wired to `updateAffordance`) needs no changes.

**UI behavior:**

- Trigger button shows the current model label and a chevron; click to open the panel.
- Panel holds one `<details>` per catalog `group` field. First group open on load; rest collapsed. Click a group header to expand or collapse.
- Each item shows the model label plus capability badges where relevant: `vision` (accent color) for image-accepting models, `stream` (warn color) for the 23 currently-streamable chat models (4 Anthropic + 19 Workers AI).
- Selected item is highlighted in the accent color with a checkmark on the right.
- Panel closes on outside click, item click (auto-close on select), or Escape (also returns focus to the trigger).

**Styling:**

- All colors via existing CSS custom properties (`--bg-elev`, `--bg-elev2`, `--fg`, `--fg-dim`, `--accent`, `--warn`, `--border`). No new design tokens.
- Removed orphaned select-only rules (`select, textarea`, `select optgroup`, `select option`, `select:focus, textarea:focus`). The shared `select, textarea` rule was split: the `textarea` portion folded into the existing dedicated textarea block.
- Panel uses `position: absolute` anchored to the picker root (the root is `position: relative`). Trigger spans the controls-grid cell width; panel matches.
- Mobile: panel `max-height: 70vh` (up from 60vh desktop) since the controls grid collapses to single column at <=768px.

**Touch points:**

- `public/index.html`: 1 line changed (the `<select>` tag).
- `public/app.js`: 2 hunks. Picker IIFE replaces the `modelSelect` declaration (~140 lines including comments); `loadModels` innerHTML block replaced with a one-liner.
- `public/styles.css`: 1 hunk. Collapses 4 select-related rules into the textarea rule, then appends ~170 lines of picker styles.

**Browser support:** uses `<details>` / `<summary>`, `CSS.escape()`, and `color-mix()`. Supported in Firefox 113+ and Chromium 111+ (May 2023 baseline). No fallback needed for a 2026 deployment.

No D1 migration, no R2 migration, no new dependencies, no new worker secrets. Pure frontend change. Net diff: +274 / -26 across 5 hunks in 3 files.

## v0.14.0

**Breaking:** removes OpenAI BYOK and the Gemini chat / Veo 3.1 video BYOK paths to consolidate around Anthropic + xAI + Bedrock BYOK and Unified Billing for everything else. Deployers who used OpenAI or Google BYOK will need to migrate to one of the remaining providers.

- Catalog entries removed (13 total):
  - OpenAI BYOK: `openai/gpt-5.5`, `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/gpt-image-2-2026-04-21`, `openai/gpt-4o-mini-tts-2025-12-15`, `openai/gpt-4o-transcribe`, `openai/gpt-4o-mini-transcribe-2025-12-15`.
  - Google BYOK: `google/gemini-3.5-flash`, `google/gemini-3.1-pro-preview`, `google/gemini-3.1-flash`, `google/gemini-2.5-pro`, `google/veo-3.1`, `google/veo-3.1-fast`.
- Preserved: `google/veo-3` and `google/veo-3-fast` (no `byok_alias`, route through Unified Billing via the `LongRunWorkflow` step pattern; still need CF credits to actually fire).
- Worker code deletions: `callOpenAI`, `imageGenOpenAI`, `ttsOpenAI`, `sttOpenAI`, `callGoogle`, `transformToGoogle`, `GooglePart` / `GoogleContent` interfaces, `submitVideoGoogle`, `pollVideoGoogle`. All BYOK dispatch branches in `runChat`, `runImage`, `runTts`, `runStt`, `runVideo`, and `handleJobPoll` collapsed accordingly. Google fallback removed from both `extractOutput` (candidates[0].content.parts[].text) and `extractUsage` (usageMetadata).
- `Env` interface: `OPENAI_API_KEY` and `GOOGLE_API_KEY` removed.
- `Provider` type union: `"openai"` removed. `"google"` kept for the two veo-3 Unified Billing entries.
- `runChat` `wantsSystemInMessages` simplified from `!(model.provider === "anthropic" || model.provider === "google")` to `model.provider !== "anthropic"`. Anthropic still takes system as a top-level field; everything else gets `role: "system"` in the messages array.
- `runVideo` `isBYOK` simplified to `!!(model.byok_alias && model.provider === "xai")`. Only xAI Grok Imagine Video uses the per-provider BYOK video path now; everything else goes through the Workflow.
- `handleJobPoll` BYOK branch reduced to `row.job_provider === "xai"` (was xai-or-google).
- README, CONTRIBUTING, and `wrangler.example.toml` updated to drop OpenAI / Google BYOK references. The orphaned "Google Gemini models (BYOK)" content that was sitting headerless under the xAI section (likely from an earlier edit losing the `##` header) is also removed.
- Net diff against `src/index.ts`: +26 / -388 lines across 24 hunks.

**Deployer migration (existing v0.13.x deployments):**

After deploying v0.14.0, drop the obsolete secrets so they don't sit unused:

```
npx wrangler secret delete OPENAI_API_KEY
npx wrangler secret delete GOOGLE_API_KEY
```

Neither is fatal if forgotten; they're just inert.

No D1 migration. No R2 migration. Existing rows that reference removed models will still render in history (the row stores the model ID as a string, not a foreign key into the catalog); attempting to continue or retry one of those conversations will fail at submit time with a clear error.

## v0.13.0

Rolls up four patches landed between v0.12.0 and v0.14.0: hot-path latency, SSE streaming Pass 1 (Anthropic), SSE streaming Pass 2 (Workers AI), and the image-gen workarounds for FLUX.2 plus the gateway-incompatible streaming-output models.

**Hot-path latency:**

- `runChat` prelude now overlaps the D1 prior-turns SELECT, the Vectorize RAG retrieve, and the attachment normalization walk. Previously these ran sequentially even though they're independent. Hoisted `priorTurnsPromise` and `retrievePromise` to fire at the top of the function and awaited only at the message-array assembly point.
- Video-frame attachments now upload to R2 in parallel via `Promise.all` instead of an in-order `for await` loop. For an 8-frame video, this collapses ~600ms of sequential PUTs into a single round trip.
- `handleJobPoll` streams the upstream artifact directly into R2 via a new `r2PutStream` helper that pipes `aresp.body` through the bucket without buffering the whole video into memory. Cuts peak memory on a 30MB video gen from ~30MB to a few hundred KB and shaves one full body-read pass off the latency.
- Two try-blocks in `handleJobPoll` collapsed into one (the separation was historical and prevented sharing the streaming pipe).

**SSE streaming (chat models only):**

- New `POST /api/chat/stream` endpoint returns `text/event-stream`. Same request body shape as `POST /api/chat`. Response is a sequence of envelope events emitted via a `TransformStream`:
  - `{ "type": "delta", "text": "..." }` for each token chunk as the model emits it.
  - `{ "type": "done", "row_id": ..., "latency_ms": ..., "tokens_in": ..., "tokens_out": ..., "conversation_id": ..., "turn_index": ... }` once the model finishes. Token counts mirror the non-stream path.
  - `{ "type": "error", "message": "..." }` on upstream failure.
- New optional `streaming: boolean` flag on `ModelEntry`. Frontend can filter the catalog to streamable models for routing; the worker rejects stream requests for non-streaming models with HTTP 501.
- Streaming wired for two providers in this release:
  - **Pass 1 (Anthropic):** all four Claude entries (Opus 4.7 / 4.6, Sonnet 4.6, Haiku 4.5). Uses `callAnthropicStream` async generator that strips Anthropic's native SSE envelope (`message_start`, `content_block_delta`, etc.) and re-emits our flat envelope.
  - **Pass 2 (Workers AI):** 19 `@cf/*` and `@hf/*` chat models flagged streaming. Uses `callWorkersAIStream` which calls `env.AI.run({stream: true})` and reads the returned `ReadableStream` of OpenAI-compatible SSE. The `AnthropicStreamEvent` internal type was renamed to `ProviderStreamEvent` since it now serves both backends.
  - **Pass 3 (xAI Grok) and Pass 4 (Bedrock Nova):** still on the backlog. The `handleChatStream` validator returns 501 with a clear message for those.
- Client disconnect handling: the worker holds an `AbortController` and aborts the upstream fetch when the SSE pipe closes. Partial tokens already buffered are dropped; no D1 row is persisted for an aborted stream. This matches the non-stream path's behavior (no partial rows).
- Reasoning models (`@cf/openai/gpt-oss-120b`, `@cf/openai/gpt-oss-20b`, `@hf/.../qwq-32b`, `@cf/deepseek/deepseek-r1-distill-qwen-32b`) stream `<think>...</think>` blocks as part of the delta text. The frontend can fold these in the UI; the worker passes them through unchanged.
- AI Gateway log ID is null on streaming rows. The gateway does not yet surface `cf-aig-log-id` on SSE responses. Once Cloudflare exposes it, plumbing it through is a one-line change.

**Streaming client module (new file):**

- `public/streaming-client.js`, a vanilla JS module with no dependencies. Exposes `streamChat(body, { onDelta, onDone, onError })` returning a `cancel()` function. Drop-in for any frontend that wants to wire the new endpoint without rewriting its existing chat code path. About 7.6KB. Includes integration notes in the file header.

**Image generation workarounds:**

- FLUX.2 (`@cf/black-forest-labs/flux-2-klein-9b`, `-klein-4b`, `-dev`) requires multipart input to `env.AI.run`. Two errors had been masking this: `AiError 5006: "required properties at '/' are 'multipart'"` from the AI binding, and `"AI Gateway does not support ReadableStreams yet"` when the gateway tried to proxy a stream-shaped input. Fix: build `FormData`, wrap it in `new Response(form)` to extract the boundary-bearing `Content-Type`, then pass `{ multipart: { body, contentType } }` to `env.AI.run`. Detected per-call via `model.id.startsWith("@cf/black-forest-labs/flux-2-")`.
- Streaming-output models (`@cf/leonardo/phoenix-1.0`, `@cf/lykon/dreamshaper-8-lcm`) return a `ReadableStream` of PNG bytes rather than the usual `{ image: base64 }` JSON. The AI Gateway cannot proxy stream-output bodies either. Same fix as FLUX.2 input: bypass the gateway by calling `env.AI.run` directly without the `gateway: { id }` option, then detect the response shape at runtime (`result instanceof ReadableStream` -> drain to `Uint8Array`; else extract `result.image` as base64).
- Five models now bypass the AI Gateway: the three FLUX.2 entries plus phoenix-1.0 and dreamshaper-8-lcm. Cost: `ai_gateway_log_id` is null on rows generated by these. Cloudflare's error text says "yet," so the bypass is expected to be temporary. The other two image models (`@cf/black-forest-labs/flux-1-schnell` and `@cf/leonardo/lucid-origin`) still route through the gateway normally.

**Internal:**

- No D1 migration. No R2 migration. No new worker secrets.
- New worker file: `public/streaming-client.js` (must be served by the Assets binding, which already covers `public/*`).
- Net diff against v0.12.0 across the four patches: roughly +700 / -100 lines. Most of it is the SSE machinery and the FLUX.2 multipart construction.

## v0.12.0

- Unblock Unified Billing video and music generation by migrating from `ctx.waitUntil` to Cloudflare Workflows. Resolves the long-standing `waitUntil` cancellation issue: previously, jobs whose `env.AI.run` call exceeded the ~30-second post-response budget were cancelled mid-flight, leaving D1 rows stuck in `pending`. The new `LongRunWorkflow` class holds the blocking call alive across step boundaries (unlimited wall-clock per step for I/O-bound work) and retries each phase independently.
- Affected providers (now durable): Google Veo 3 / Veo 3 Fast, ByteDance Seedance 2.0 / 2.0 Fast, MiniMax Hailuo 2.3 / 2.3 Fast, RunwayML Gen-4.5, Alibaba HappyHorse 1.0, PixVerse v6 / v5.6, Vidu Q3 Pro / Q3 Turbo, MiniMax Music 2.6. xAI Grok Imagine Video and Google Veo BYOK paths are unchanged (still use the submit-and-poll pattern from v0.10.2, which already works).
- Workflow steps: (1) `invoke-model` calls `env.AI.run` with 1 retry on 30s linear backoff; (2) `download-and-store` fetches the upstream artifact and uploads to R2 in one combined step (Workflows cap step return values at 1 MiB so we can't pass bytes between steps - video files are 5-15MB, music 3-5MB); (3) `finalize-d1` writes status, `output_artifact`, and latency to the chats row.
- D1 `chats.job_id` now stores the Workflow instance ID for Unified Billing jobs (BYOK rows still store the upstream provider's job ID). Useful for cross-referencing with `npx wrangler workflows instances describe skyphusion-longrun <id>`.
**Frontend:**

- Per-turn action buttons: each completed (or failed) assistant message now shows three small icon buttons. **Copy** writes the response text to the clipboard (hidden on pure-artifact turns like image/audio/video without text output). **Edit** restores the model picker, system prompt, and user input to match the historical turn, then focuses the input so the user can tweak before re-running; does NOT auto-submit. **Retry** does the same restore but fires `run()` immediately for one-click resubmit. Attachments from the original turn are not carried forward (multi-turn continuation is text-only across all paths), so retry on an image-bearing chat turn submits text only. Click handler is delegated on `#transcript` since the transcript is re-rendered via `innerHTML` on each turn change. Clipboard write uses `navigator.clipboard.writeText` with an `execCommand` fallback for non-secure contexts.

**Frontend unchanged:**

- The existing `GET /api/job/:id` polling endpoint still works. The workflow updates D1 directly when complete, so the poll endpoint just reads the current state.
- Removed: `generateVideoUnified`, `generateMusicBackground`, `MusicGenResult`, `VideoGenResult` (replaced by inline workflow logic).
- No D1 migration required.

**Config restructuring (deploy-impacting):**

- `wrangler.toml` is now gitignored. The repo ships `wrangler.example.toml` as the committed template; deployer-specific values (D1 `database_id`, worker `name`) live in your local `wrangler.toml` and are no longer overwritten when you pull a new version. Bootstrap a new clone with `npm run bootstrap` (copies the example to a real `wrangler.toml`).
- `GATEWAY_ID` moved out of `[vars]` in the wrangler config and into a worker secret. Set it with `echo "your-gateway-slug" | npx wrangler secret put GATEWAY_ID`. For local development, also add `GATEWAY_ID=your-gateway-slug` to `.dev.vars`.
- New `npm run bootstrap` script idempotently creates `wrangler.toml` from the template.

**wrangler.toml migration for existing deployers (v0.11.x -> v0.12.0):**

Apply these changes to your live `wrangler.toml`. Paste the two new blocks anywhere after the `[assets]` block. Then delete the `[vars]` block (since `GATEWAY_ID` is now a secret), and run the `secret put` command at the end.

```toml
# Add these two blocks to your wrangler.toml:

[[workflows]]
name = "skyphusion-longrun"
binding = "LONGRUN"
class_name = "LongRunWorkflow"

[observability]
enabled = true
```

Then:

```
# Delete the [vars] block from wrangler.toml (it only had GATEWAY_ID).
# Move GATEWAY_ID to a secret:
echo "your-gateway-slug" | npx wrangler secret put GATEWAY_ID

# Add it to .dev.vars too if you do local dev:
echo "GATEWAY_ID=your-gateway-slug" >> .dev.vars

# Regenerate types and deploy:
npx wrangler types
npm run deploy
```

Workflows are not supported on `wrangler dev --remote`, so the Unified Billing video and music paths can only be exercised in deployed mode.

**Known limitations carried into v0.12.0:**

- Per-provider param mapping is still Veo-baseline (`prompt / duration / aspect_ratio / resolution / generate_audio`) for all video models. ByteDance/RunwayML/Alibaba/PixVerse/Vidu may reject or ignore some of those parameters; expect param-shape iteration as each provider is exercised in production. Errors will surface in `chats.job_error` rather than getting silently swallowed.
- Bedrock Nova vision attachments are still text-only (`callBedrockNova` strips image content parts). Frontend gates uploads on the `vision` capability flag so the UI lets users attach images, but the worker drops them silently. Backlog item.

## v0.11.1

- Expand OpenAI BYOK across model types per Conrad's confirmed model list:
  - Image gen: `gpt-image-2-2026-04-21` via `/v1/images/generations` (returns base64 PNG; stored in R2 via the same artifact pipeline as Workers AI image gen).
  - TTS: `gpt-4o-mini-tts-2025-12-15` via `/v1/audio/speech` (returns MP3 bytes; default voice "alloy", configurable later).
  - STT: `gpt-4o-transcribe` and `gpt-4o-mini-transcribe-2025-12-15` via `/v1/audio/transcriptions` (multipart upload using native FormData/Blob).
- Removed `openai/gpt-4.1` from the catalog since Conrad's confirmed list doesn't include it. Chat models remain GPT-5.5, GPT-5.4, GPT-5.4 mini.
- New OpenAI-specific dispatch helpers: `imageGenOpenAI`, `ttsOpenAI`, `sttOpenAI`. Each routes through Cloudflare AI Gateway's OpenAI proxy using the existing `OPENAI_API_KEY` secret.

**Not implemented this turn (deferred for architectural reasons):**

OpenAI Realtime API models (`gpt-realtime-2`, `gpt-realtime-1.5`, `gpt-realtime-mini-2025-12-15`, `gpt-realtime-translate`, `gpt-realtime-whisper`) use WebSocket-based bidirectional audio streaming, not HTTP request/response. A Cloudflare Worker handler cannot hold a persistent duplex stream (same `waitUntil` cancellation problem we hit with video gen). The right architecture is:

1. Worker endpoint mints an ephemeral session token via OpenAI's `/v1/realtime/sessions` server-side.
2. Browser opens WebSocket directly to `wss://api.openai.com/v1/realtime?model=...` using that token.
3. Browser handles full-duplex audio capture (MediaRecorder / WebRTC), playback, and transcript display.

This is a substantial separate feature (~400-500 LOC across worker + frontend + UI). Deferred to a focused future session.

## v0.11.0

- Add OpenAI BYOK chat. Catalog ships GPT-5.5, GPT-5.4, GPT-5.4 mini, GPT-4.1. Routes through Cloudflare AI Gateway's OpenAI proxy. New `OPENAI_API_KEY` worker secret. Standard OpenAI messages-array format, no transform needed.
- Add Amazon Bedrock BYOK chat (Nova family). Catalog ships Nova 2 Lite, Nova 2 Pro, Nova Lite, Nova Pro. All routed through Bedrock's Converse API which normalizes request/response shapes across model families. SigV4 signing handled by `aws4fetch` (compact, designed for Workers runtime; eliminates ~150 LOC of manual crypto signing).
- Add TwelveLabs Pegasus 1.2 on Bedrock (video-Q&A). Different architecture from chat: uses `InvokeModel` (not Converse) with a `{inputPrompt, mediaSource}` body shape. Frontend uploads the full video as a new `video_full` attachment type (not the default frame-extraction used for vision-capable chat models). Limitations: Bedrock InvokeModel has a 25MB request limit (~18MB binary after base64); Pegasus is only available in us-west-2 and eu-west-1; Pegasus is single-shot per call so multi-turn requires re-attaching the video on each follow-up.
- New worker secrets: `OPENAI_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. New optional env vars: `AWS_REGION` (default us-east-1, used for Nova), `AWS_REGION_PEGASUS` (default us-west-2, used for Pegasus calls specifically).
- New dependency: `aws4fetch ^1.0.18`. Run `npm install` after pulling.
- New attachment type `video_full` (raw video upload) for Pegasus. Existing `video_frames` (canvas-extracted JPG frames) unchanged for other vision-capable chat models.
- `extractOutput` and `extractUsage` extended to handle Bedrock's response shape (`output.message.content[].text`) and camelCase token fields (`inputTokens`/`outputTokens`).
- No D1 migration required.

## v0.10.4

- Add project favicon and PWA manifest. The mark is a stylized Greek phi (the first letter of "phusion" in skyphusion) in cyan and magenta on a deep navy rounded square. Ships as `favicon.svg` (vector, used by all modern browsers) with PNG fallbacks at 16/32/180/192/512 for older browsers, iOS, and Android home-screen installs. `manifest.webmanifest` lets the app be installed as a standalone PWA on mobile.
- No worker code changes. Cloudflare Workers Assets binding serves the new `public/*.png`, `public/favicon.svg`, and `public/manifest.webmanifest` files automatically; no wrangler config change needed.

## v0.10.3

- Fix videos downloading as `.bin` instead of `.mp4`. Three compounding causes:
  1. `extFromMime` had no entry for `mp4` (or `mov` / `mkv`), so any video mime fell through to the `"bin"` fallback. R2 keys got `out/<uuid>.bin`, and the browser's `<a download>` used the URL's filename, so saves went to disk as `.bin`.
  2. In the BYOK video poll path, we were trusting the upstream CDN's `Content-Type` header. xAI's CDN can serve MP4 as `application/octet-stream`, which would have failed `extFromMime` even after fix #1. We know contextually it's a video gen result, so the mime is now hardcoded to `video/mp4` in this path.
  3. `handleArtifact` wasn't setting a `Content-Disposition` header, so browsers had no filename hint other than the URL path. Now it sets `Content-Disposition: inline; filename="<r2 key tail>"`.
- Limitation: existing video artifacts already stored in R2 with `.bin` keys won't be retroactively renamed. They'll still download as `.bin`. New videos generated after deploy will save as `.mp4` correctly.

## v0.10.2

- Fix Grok Imagine Video failing for the actual underlying reason. The "not found" error was the *symptom*; the *cause* was Cloudflare Workers' `waitUntil()` having a ~30-second post-response budget, while video generation takes 1-3 minutes. The background poll loop was getting cancelled mid-run, leaving rows stuck in "pending" until the client gave up.
- Refactored BYOK video architecture: submit happens synchronously in `POST /api/chat` (one fast HTTP call), upstream `job_id` persists to D1, then each client poll of `GET /api/job/:id` triggers ONE upstream poll in its own fresh worker invocation. Each invocation has its own ~30s budget, well within reach. When the upstream reports "done", the same invocation downloads the video, uploads to R2, and finalizes D1.
- Also fix Bug 1 from the diagnostic: the v0.10.0 multi-turn refactor neglected to add `conversation_id` to non-chat response shapes (image, TTS, video, music, STT). The frontend was seeing `result.conversation_id === undefined`, stringifying it to "undefined", and fetching `/api/conversations/undefined`. Now all non-chat handlers return `conversation_id` from the persisted row.
- Removed obsolete `generateVideoBYOK` background task function and `BYOK_POLL_INTERVAL_MS` / `BYOK_POLL_MAX_MS` constants. No longer needed.
- Known limitation: Unified Billing video models (bytedance, runwayml, alibaba, pixverse, vidu, etc.) and music gen (`minimax/music-2.6`) still use the old waitUntil-based pattern and are subject to the same cancellation issue. A future Cloudflare Workflows refactor will fix these. BYOK works reliably now; Unified Billing models won't until they're funded AND the architecture is reworked.

## v0.10.1

- Fix Grok Imagine Video failing with "not found": Cloudflare AI Gateway's xAI proxy only supports the OpenAI-compatible chat schema (`/v1/chat/completions`). It doesn't proxy `/v1/videos/generations` or `/v1/videos/:id`, so every video submit returned 404. Now we call `https://api.x.ai` directly for these endpoints, bypassing the gateway. The XAI_API_KEY secret is still used; the workaround means no gateway caching/analytics for video gen specifically, but those features were marginal for 1-3 minute generations.
- The fix requires `XAI_API_KEY` to be set as a worker secret (previously the AI Gateway "Stored Keys" feature could fill it in transparently for chat; with direct calls we need the actual secret).

## v0.10.0

- Multi-turn conversations. Each conversation is a sequence of turns sharing a `conversation_id` and ordered by `turn_index`. Continuing a conversation pulls prior turns from D1 and assembles a `[system, user1, assistant1, user2, assistant2, ..., userN]` message array for the model.
- New schema columns on `chats`: `conversation_id TEXT` and `turn_index INTEGER`. Backfill migration assigns `'legacy-<id>'` and `turn_index = 0` to existing rows so they remain accessible.
- New API endpoints: `GET /api/conversations` (list, summarized), `GET /api/conversations/:id` (all turns of a conversation), `DELETE /api/conversations/:id` (cascade delete of all turns + R2 artifacts).
- Frontend rework: the output area is now a scrolling transcript that renders alternating user / assistant turns instead of a single most-recent response. The sidebar lists conversations (one entry per conversation with first prompt + turn count + last activity) instead of individual chat rows. "+ new" starts a fresh conversation.
- ChatRequest gained optional `conversation_id`. If omitted, the worker generates a UUID and starts a new conversation. If present, the worker continues the existing one (and writes the next turn under it).
- Chat response gained `conversation_id` and `turn_index` so the frontend can track and continue.
- Decisions made for v1: per-turn retrieval (each turn can independently use_docs); text-only history (image/audio/video attachments from prior turns are not re-sent on continuation, only the user's text and the assistant's text reply); mixed-model conversations allowed (switch models between turns freely); no automatic summarization of older turns.
- Required migrations: `ALTER TABLE chats ADD COLUMN conversation_id TEXT`, `ALTER TABLE chats ADD COLUMN turn_index INTEGER`, then `UPDATE chats SET conversation_id = 'legacy-' || id, turn_index = 0 WHERE conversation_id IS NULL`, and `CREATE INDEX IF NOT EXISTS idx_chats_conversation ON chats(conversation_id, turn_index)`.

## v0.9.5

- Added Claude Opus 4.7 (`claude-opus-4-7`) as the top Anthropic entry. Opus 4.7 is Anthropic's flagship as of April 16, 2026, with a 1M-token context window, 128K max output, and adaptive thinking. Existing Opus 4.6, Sonnet 4.6, and Haiku 4.5 entries are preserved. BYOK via the same Anthropic dispatch path; no code or config changes needed beyond the catalog entry.

## v0.9.4

- Fix the actual RAG retrieval bug. Vectorize V2 API expects `returnMetadata` to be a string enum (`'none'` | `'indexed'` | `'all'`), not a boolean. Passing `returnMetadata: false` caused Vectorize to reject every query with `VECTOR_QUERY_ERROR (40026): Failed to parse the request body as JSON: returnMetadata: expected value at line 1 column 28`. The error was silent until v0.9.3 surfaced it. Dropped the option entirely - `'none'` is the default and what we wanted.

## v0.9.3

- Critical fix: `retrieveContext` was silently swallowing errors at every step (embed failure, Vectorize query failure). When anything in the retrieval pipeline threw, the function returned an empty array with no logging and no error surfaced to the user ,  making it look like retrieval just "wasn't finding anything" when in fact it was hard-failing.
- New return shape: `retrieveContext` now returns `{ chunks, error }`. Errors are logged to `console.error`/`console.warn` (visible via `wrangler tail`) and surfaced in the chat response as `retrieval_error` when `use_docs` is on.
- New explicit diagnostic case: when Vectorize returns matches but the D1 join returns nothing, the error message includes the user_email and sample vector_ids so a user_email mismatch (vectors written under one identity, query made under another) is immediately visible.

## v0.9.2

- Fix duplicate-system-prompt bug introduced in Pass 2: when use_docs was on for Anthropic or Google models, the effective system prompt (user prompt + retrieval block) was being sent BOTH as the API's top-level system parameter AND as a system message in the messages array. The transforms concatenate these, so the model saw the same content twice. While not fatal, it may have confused some models into deprioritizing the retrieved context. Now the system role is only added to the messages array for providers that don't accept a separate system parameter (xAI, Workers AI).
- Add `effective_system_prompt` diagnostic field to the chat response when `use_docs` is true. Lets you verify via browser DevTools (Network tab → /api/chat → Response) that the retrieval block reached the worker correctly.

## v0.9.1

- Fix dependency versions in package.json that I made up in v0.9.0
  - `unpdf`: bumped from invalid `^0.13.0` (doesn't exist) to `^1.6.0` (current major); also dropped `{ useSystemFonts: true }` arg to `getDocumentProxy` which is not part of the unpdf wrapper API
  - `xlsx`: switched from `^0.20.3` (npm version is stuck at 0.18.5, SheetJS stopped publishing) to the SheetJS CDN tarball URL `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. This is SheetJS's own recommended install pattern. The package still imports as `xlsx`.

## v0.9.0

- Phase 3A: PDF and XLSX/XLS support for document ingestion
- Added `unpdf` (~500KB) for PDF text extraction; per-page extraction with page numbers stored as chunk metadata. Modern text-extractable PDFs only; scanned/image-only PDFs need OCR (Phase 3B, deferred)
- Added `xlsx` (SheetJS, ~500KB) for XLSX (Office Open XML) and XLS (legacy BIFF binary) support; per-sheet CSV extraction with sheet name stored as chunk metadata
- New `ExtractedChunk` shape carries optional `page` and `sheet` metadata through the ingestion pipeline; `chunkText` now runs per-page or per-sheet so chunks never cross those boundaries
- Source location surfaced everywhere: chunks displayed in the UI show "chunk N · page 7" or "chunk N · sheet \"Q3\""; the system prompt block injected into chat shows "from filename.pdf, page 7"; the new `chunks.page` and `chunks.sheet` columns persist this
- Vectorize metadata also stores page/sheet (alongside the existing user_email/document_id/chunk_index) for any future server-side filtering
- Upload byte cap raised from 5MB to 10MB to accommodate larger PDFs
- **Bundle size note**: with unpdf + xlsx bundled, the worker exceeds the free-tier 1MB compressed limit. Workers paid plan is now required.
- Required migration: `ALTER TABLE chunks ADD COLUMN page INTEGER` and `ALTER TABLE chunks ADD COLUMN sheet TEXT`; also `npm install` to pick up the new dependencies

## v0.8.2

- Fix typecheck failure in `handleDocumentUpload`: Workers' `TextDecoder` types don't accept `{ fatal: false }` as a constructor option. Dropped the explicit option (non-fatal is the default), keeping the existing try/catch for defensive handling.

## v0.8.1

- RAG Pass 2: chat retrieval injection now wired end-to-end
- New `use_docs` flag on `POST /api/chat`; when true, worker embeds the user prompt, queries Vectorize for top-5 chunks, looks up text in D1, and folds them into the effective system prompt
- Effective system prompt threading: combined user-provided prompt + retrieval block, passed through cleanly to all four provider dispatch paths (Anthropic top-level system, Google systemInstruction, xAI / Workers AI system message in messages array)
- Per-user retrieval scoping enforced at the D1 layer (chunks JOIN with `WHERE user_email = ?`), so no Vectorize metadata index is required
- New `retrieved_context` column on `chats` table stores the retrieved chunks as JSON for each turn that used RAG; restored on history reload
- New chat response field `retrieved_chunks`: array of `{ document_id, filename, chunk_index, text, score }` returned alongside the model output
- Frontend: new "use my docs" checkbox in the input bottom row, visible only for chat models when the user has at least one document; checkbox auto-clears when the doc list becomes empty
- Retrieved chunks render above the model output as a collapsible block with filename, chunk index, and similarity score per chunk; persists across history reloads
- Required migration: `ALTER TABLE chats ADD COLUMN retrieved_context TEXT` if upgrading from v0.8.0

## v0.8.0

- RAG Pass 1: document ingestion pipeline (no chat integration yet, that's Pass 2)
- New `Vectorize` binding (`VEC`) with 768-dim index `skyphusion-llm-vec` for embedding storage
- New D1 tables: `documents` (per-doc metadata) and `chunks` (per-chunk text + Vectorize vector_id link)
- New endpoints: `GET /api/documents` (list), `POST /api/documents` (upload + chunk + embed + store), `GET /api/documents/:id` (metadata + chunk preview), `DELETE /api/documents/:id` (cascade-cleanup of Vectorize + D1 + R2)
- Chunking: ~500 chars per chunk with 50-char overlap, breaks preferred at paragraph/newline/sentence boundaries
- Embedding: `@cf/baai/bge-base-en-v1.5` (768-dim, free Workers AI), batched 16 chunks per call
- File support: `.txt`, `.md`, `.markdown` only; 5MB max upload (PDF and other formats deferred to a follow-on)
- Knowledge base scope: per-user (single corpus per user), scoped by Cf-Access-Authenticated-User-Email
- Frontend: new Documents section in sidebar below History with upload button, doc list with chunk count + size + date, per-doc delete with confirmation
- Vectorize cleanup: deleting a document removes all its vector IDs from Vectorize via `deleteByIds`, chunk rows from D1, and the original file from R2
- Setup commands documented in README; requires one-time `npx wrangler vectorize create` and `wrangler d1 execute --file=schema.sql`

## v0.7.5

- Flip workspace layout: output now sits in the middle (1fr, fills available space) and the input pins to the bottom. Controls (model picker, system prompt) stay at the top. Chat-style layout.

## v0.7.4

- Clear the user-input box and refocus it after a successful submit so the next prompt can be typed immediately. Output, attachments, and system prompt all remain visible.

## v0.7.3

- Rename `Image gen` / `Music gen` / `Video gen` group labels to title case (`Image Gen` / `Music Gen` / `Video Gen`) for visual consistency in the model dropdown
- Fix typecheck failure in `runStt`: `PersistedAudioAttachment.filename` is `string | undefined`, so dropped the unnecessary `?? null` fallback

## v0.7.2

- Added speech-to-text (Whisper) as a standalone model type, with 3 variants: `@cf/openai/whisper-large-v3-turbo`, `@cf/openai/whisper`, `@cf/openai/whisper-tiny-en`. Synchronous (no polling); user attaches audio, worker calls Whisper directly, returns transcript as output text.
- Added music generation (`minimax/music-2.6`) using the same fire-and-forget architecture as video gen. User provides a style/mood description and optional lyrics; worker schedules generation via `ctx.waitUntil`, downloads the resulting MP3, stores in R2. Requires Unified Billing (third-party proxied model).
- New `ModelType` variants: `"stt"` and `"music"`.
- Frontend: type-specific affordances for STT (audio attachment required) and music (lyrics field in system_prompt slot). Pending music jobs resume polling on history reload. New emoji icons in history list: musical note for music output, memo for transcripts.

## v0.7.1

- Expanded Workers AI catalog by 10 entries
- Chat additions: `glm-4.7-flash` (Z.AI multilingual), `nemotron-3-120b-a12b` (NVIDIA agentic), `gemma-3-12b-it` (Google vision, 128K context), `granite-4.0-h-micro` (IBM, function calling), `hermes-2-pro-mistral-7b` (function calling specialist), `llama-3.2-1b-instruct` (tiny test model)
- Image additions: `flux-2-klein-9b` (Flux 2 frontier, 9B distilled), `flux-2-klein-4b` (smaller, faster), `flux-2-dev` (multi-reference), `dreamshaper-8-lcm` (fast SD fine-tune)
- Total catalog now 55 models across chat / image / TTS / video (30 / 7 / 3 / 15)

## v0.7.0

- Add text-to-video generation across 15 models from 9 providers, with a dual-route architecture: Cloudflare Unified Billing (via `env.AI.run`) for all 15 models, and BYOK (per-provider AI Gateway endpoints) for the 3 models with documented direct provider APIs
- Providers: Google (Veo 3.1, Veo 3.1 Fast, Veo 3, Veo 3 Fast), ByteDance (Seedance 2.0, Seedance 2.0 Fast), MiniMax (Hailuo 2.3, Hailuo 2.3 Fast), xAI (Grok Imagine Video), RunwayML (Gen-4.5), Alibaba (HappyHorse 1.0), PixVerse (v6, v5.6), Vidu (Q3 Pro, Q3 Turbo)
- BYOK route (works today with existing keys): xAI Grok Imagine Video, Google Veo 3.1, Google Veo 3.1 Fast
- Unified Billing route (requires CF credits): all 15 models, including the 12 CF-partner-only models without public APIs
- Per-model `byok_alias` field in the catalog controls routing; if present, worker uses per-provider endpoints with stored gateway keys or env-var keys; if absent, worker uses `env.AI.run` which requires Unified Billing
- New `model_type: "video"` dispatches to one of two background functions via `ctx.waitUntil`: `generateVideoUnified` (single blocking `env.AI.run` call) or `generateVideoBYOK` (submit + poll loop up to 5 minutes + download)
- Both routes share the same fire-and-forget pattern: write `status='pending'` row, schedule background work, return immediately, frontend polls D1 for state changes
- D1 schema gains `status`, `job_id`, `job_provider`, `job_error`, `job_started_at` columns; old rows default to `status='done'`
- New `GET /api/job/:id` endpoint just reads D1 (cheap polling, no provider calls)
- Frontend polls every 5 seconds while pending, with elapsed-time counter
- Loading a still-pending chat from history resumes polling automatically
- History list shows hourglass for pending jobs, warning icon for failed, film clapboard for completed video output
- `<video controls>` rendering in the output artifact area, with download link

## v0.6.0

- Mobile-responsive layout with breakpoints at 768px and 420px
- Sidebar collapses into a slide-in drawer below 768px; hamburger toggle button fixed at top-left
- Tap backdrop to close drawer; selecting a history item auto-closes it
- Touch-friendly button sizes (44px minimum height where it matters)
- Always-visible delete button on history items in mobile (no hover available on touch)
- 16px input font to prevent iOS focus auto-zoom
- `viewport-fit=cover` and `env(safe-area-inset-*)` padding for notched iPhones
- Workspace padding pulls in on narrow phones (<420px)
- Generated image output capped at 50vh on mobile (was 60vh) so other UI stays visible

## v0.5.0

- Add Google Gemini models (Gemini 3.5 Flash, Gemini 3.1 Pro, Gemini 3.1 Flash, Gemini 2.5 Pro) via BYOK
- New `provider: "google"` dispatch routes to AI Gateway's `google-ai-studio` provider endpoint
- New `transformToGoogle` converts OpenAI-style messages to Google's `contents`/`parts` format, system prompt to top-level `systemInstruction`, image blocks to `inline_data`, assistant role to `model`
- `extractOutput` extended to handle Gemini's `candidates[0].content.parts[].text` shape
- `extractUsage` extended to handle Gemini's `usageMetadata.promptTokenCount` / `candidatesTokenCount`
- Same stored-keys-first auth pattern as Anthropic and xAI: optional `GOOGLE_API_KEY` Worker secret overrides stored keys; absence falls back to whatever's configured at the gateway

## v0.4.1

- Correct Grok model IDs to match the actual xAI catalog: `grok-4.3`, `grok-4.20-multi-agent-0309`, `grok-4.20-0309-reasoning`, `grok-build-0.1`
- Remove the v0.3.0 stub IDs (`grok-4.20`, `grok-4.1-fast`) that didn't resolve at xAI

## v0.4.0

- Provider keys now preferred via AI Gateway dashboard (BYOK Store Keys) rather than Worker secrets
- Worker auth headers are conditional: if `ANTHROPIC_API_KEY` / `XAI_API_KEY` is set, the inline key is sent; if not, the request goes through with no provider auth header and the gateway injects the stored key from Provider Keys configuration
- Added optional `CF_AIG_TOKEN` Worker secret for Authenticated Gateway support (sends `cf-aig-authorization` header when set)
- Removed the hard error when keys are missing; selecting an Anthropic or xAI model with no provider auth configured anywhere now surfaces the upstream provider's 401, which is more informative

## v0.3.0

- Add xAI / Grok models (Grok 4.20, Grok 4.3, Grok 4.1 Fast) via BYOK
- `provider` field on model entries gains `"xai"` value
- xAI dispatch is simpler than Anthropic: OpenAI-compatible wire format, no message transform, standard Bearer token auth
- `max_completion_tokens` used instead of `max_tokens` to support reasoning models (Grok 4.x)
- `XAI_API_KEY` worker secret required to enable xAI models; absence returns a clear error
- README documents the BYOK setup parallel to Anthropic's section

## v0.2.0

- Add Anthropic Claude models (Opus 4.6, Sonnet 4.6, Haiku 4.5) via BYOK
- New `provider` field on model entries dispatches between Workers AI binding and Anthropic direct fetch
- BYOK calls go through the AI Gateway Anthropic provider endpoint, preserving caching/logging/rate-limiting
- Image content blocks transform from OpenAI-style `image_url` to Anthropic-style `image` with base64 source
- `ANTHROPIC_API_KEY` worker secret required to enable Anthropic models; absence returns a clear error

## v0.1.0 (initial public release)

- Single Cloudflare Worker fronting AI Gateway
- 13 chat models, 3 image-generation models, 3 TTS models from the Workers AI catalog
- Multimodal chat input: text, images (vision), audio (Whisper transcription), video (8 client-extracted keyframes)
- D1 for chat history, R2 for input and output binary artifacts
- Cloudflare Access for authentication, per-user history scoping, per-object ownership checks via R2 customMetadata
- Vanilla TypeScript Worker, vanilla JS frontend, no build step beyond tsc
- Enter to send, Shift+Enter for newline
- Optgrouped model dropdown with capability-aware UI re-skin per model type
