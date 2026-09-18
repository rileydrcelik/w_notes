/**
 * The statement that merges a pulled note-image row into the local table.
 *
 * Kept out of `db.ts` for the same reason as `copa-upsert.ts`: these merge rules
 * fail silently — a note keeps its text and loses its pictures, on every device,
 * with nothing logged — and `db.ts` imports `expo-sqlite`, which has no Node
 * implementation and so can't be loaded by the unit tests. Holding the SQL in a
 * module that imports nothing lets a test run it against a real SQLite.
 */

/**
 * Upsert one pulled note-image row. Bind order:
 * `id, created_at, updated_at, deleted_at, mime_type, file_size, width, height,
 *  remote_key`.
 *
 * The rules are copa's, for the same reasons:
 *
 * - **`remote_key` survives a NULL payload.** It is the only pointer to the
 *   bytes in S3, stamped once by whichever device finished the upload. A peer
 *   that hasn't pulled that stamp holds NULL honestly, and last-writer-wins
 *   would let its next ordinary edit erase the pointer — the image is then gone
 *   from every device and the object is orphaned. The server applies the same
 *   guard on push (`_PRESERVE_IF_NULL` in `routers/sync.py`).
 * - **A row that kept such a key stays dirty**, or the key is stranded on this
 *   one device: the same loss, one step removed.
 * - **The dimensions are preserved the same way.** They are what lets a device
 *   lay out a picture whose bytes haven't arrived, and a client that predates
 *   them sends NULL.
 *
 * The `WHERE` keeps last-writer-wins: an older payload changes nothing.
 */
export const NOTE_IMAGE_UPSERT_SQL = `INSERT INTO note_images
     (id, created_at, updated_at, deleted_at,
      mime_type, file_size, width, height, remote_key, dirty)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
   ON CONFLICT(id) DO UPDATE SET
     created_at = excluded.created_at,
     updated_at = excluded.updated_at,
     deleted_at = excluded.deleted_at,
     mime_type = COALESCE(excluded.mime_type, note_images.mime_type),
     file_size = COALESCE(excluded.file_size, note_images.file_size),
     width = COALESCE(excluded.width, note_images.width),
     height = COALESCE(excluded.height, note_images.height),
     remote_key = COALESCE(excluded.remote_key, note_images.remote_key),
     dirty = CASE
               WHEN excluded.remote_key IS NULL AND note_images.remote_key IS NOT NULL
               THEN 1 ELSE 0
             END
   WHERE excluded.updated_at >= note_images.updated_at`;
