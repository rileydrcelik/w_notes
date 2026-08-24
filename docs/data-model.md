# Data model

The device and the server hold the **same tables**. The device's copy is the
source of truth; the server's is a per-user mirror it reconciles.

- Device: `notes-app/src/lib/db.ts` (SQLite, WAL mode)
- Server: `backend/app/models.py` (Postgres, migrations in `backend/alembic/`)

## Synced tables

| Table | Holds |
|---|---|
| `folders` | Folders. `parent_id` nests them. `kind = 'project'` makes it a task-manager tracker; `config` is that tracker's JSON settings. |
| `notes` | Notes. `body` is rich-text HTML — except on a resume note, where it is LaTeX. `plugin_type` + `plugin_config` make it a plugin note. |
| `copa_items` | Copy/paste blocks. A `file_uri` makes it a file block; `remote_key` points at the bytes in S3. |
| `issues` | Task-manager issues. `type_ids` is a JSON array of issue-type note ids; `attrs` is a JSON object of attribute values; `gh_number` mirrors a GitHub issue. |
| `finance_sheets` | One spreadsheet per row, keyed by its note id. `data` is the whole sheet as JSON. |
| `resume_versions` | A resume's version history: `source` plus a `label` saying what the change was. |
| `resume_targets` | The corpus of past tailorings — company, role, facets, the posting, and the resulting source. |
| `user_settings` | Account-scoped preferences, as key/value rows. |

## Columns every synced table carries

| Column | Meaning |
|---|---|
| `id` | A client-generated UUID. The client mints ids, so it never waits on the server to create something. |
| `created_at` / `updated_at` | Epoch milliseconds. `updated_at` decides the winner in a conflict. |
| `deleted_at` | **Soft delete.** Set, never removed. A hard delete cannot be told apart from a row that never arrived, so a deletion would resurrect from any device that hadn't synced yet. |
| `dirty` | 1 when the row has local changes waiting to push. Cleared when the server acknowledges it. |

`notes` and `folders` add `trashed_with_folder_id`, which remembers that an item
was trashed *as part of* a folder, so restoring the folder restores its contents
and nothing else.

## Not synced

`settings` is a device-local key/value table. It holds the sync cursor, the
device key, and the uid this device last synced as — facts about the *device*,
not about the person. It survives `clearAllData` for the same reason.

> Preferences belong in `user_settings`, which does sync. Putting one in
> `settings` means it silently fails to follow you to another device.

## Server-only tables

| Table | Holds |
|---|---|
| `users` | One row per identity — a Firebase uid, or an anonymous device key. `email` drives the publisher and AI-owner allowlists. |
| `user_credentials` | Per-user provider tokens (GitHub, Sentry, Anthropic), encrypted at rest with `app_secret_key` (`app/crypto.py`). |

Every synced row on the server is scoped to a `user_id` and carries a
`server_seq` — a global, monotonically increasing sequence number that is the
sync cursor.

## Sync rules

1. **Push, then pull.** The client sends dirty rows to `POST /sync/push`, then
   asks `GET /sync/pull?since=<cursor>` for everything newer than its cursor.
2. **Last-writer-wins, per row**, by `updated_at`. The server rejects an incoming
   row that is older than what it holds.
3. **Idempotent and retry-safe.** The same delta applied twice must land the same
   way — a pass can die anywhere and be repeated.
4. **The pull is paged.** A response carries `has_more`; the client loops until
   it is false, saving the cursor each page.
5. **File bytes travel separately.** Only `remote_key` is in the payload; the
   bytes go device ↔ S3 over a presigned URL.

### Things that have bitten before

- **A push is one advisory-locked batch per user.** Without it, two concurrent
  pushes interleaved and left a gap in the sequence, so a device's next pull
  skipped rows it never saw again.
- **Each row upserts inside its own savepoint.** Otherwise one bad row aborted
  the whole transaction and the entire batch was lost.
- **Unknown columns are preserved with `COALESCE`.** An older client that does
  not know a column sends null for it; writing that null truncates data a newer
  client wrote.
- **Writes are serialized on the device.** `expo-sqlite`'s
  `withTransactionAsync` is not exclusive, so an overlapping sync transaction and
  user transaction aborted each other. Every mutating method in `db.ts` funnels
  through one promise chain.
