/**
 * The statement that merges a pulled copa row into the local table.
 *
 * It lives here, apart from `db.ts`, so it can be exercised for real. The merge
 * rules below are the kind that fail silently — a row keeps its label and loses
 * its file, on every device, with nothing logged — and `db.ts` imports
 * `expo-sqlite`, which has no Node implementation and so cannot be loaded by the
 * unit tests (see `vitest.config.ts`). Holding the SQL in a module that imports
 * nothing lets a test run it against a real SQLite and assert what it does,
 * rather than restate it and drift.
 */

/**
 * Upsert one pulled copa row. Bind order:
 * `id, label, content, favorite, created_at, updated_at, deleted_at,
 *  file_name, mime_type, file_size, remote_key`.
 *
 * Two rules carry the weight:
 *
 * - **`remote_key` is preserved when the payload's is NULL.** This mirrors the
 *   guard the server already applies on push (`_PRESERVE_IF_NULL` in
 *   `routers/sync.py`); the client half was missing. The key is the only pointer
 *   to the bytes in S3 and is set once, asynchronously, by whichever device
 *   finished the upload. A peer that hasn't pulled that stamp yet genuinely
 *   holds NULL, so a later edit from it arrives NULL, and last-writer-wins would
 *   erase the pointer — orphaning the object and losing the attachment
 *   everywhere.
 * - **A row that kept such a key stays dirty.** Preserving a value the payload
 *   lacks means this row carries something the server has never seen. Clearing
 *   the flag would strand the key on this one device, which is the same loss one
 *   step removed.
 *
 * The `WHERE` keeps the table's last-writer-wins contract: an older payload
 * changes nothing.
 */
export const COPA_UPSERT_SQL = `INSERT INTO copa_items
     (id, label, content, favorite, created_at, updated_at, deleted_at,
      file_name, mime_type, file_size, remote_key, dirty)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
   ON CONFLICT(id) DO UPDATE SET
     label = excluded.label, content = excluded.content,
     favorite = excluded.favorite, created_at = excluded.created_at,
     updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
     file_name = excluded.file_name, mime_type = excluded.mime_type,
     file_size = excluded.file_size,
     remote_key = COALESCE(excluded.remote_key, copa_items.remote_key),
     dirty = CASE
               WHEN excluded.remote_key IS NULL AND copa_items.remote_key IS NOT NULL
               THEN 1 ELSE 0
             END
   WHERE excluded.updated_at >= copa_items.updated_at`;
