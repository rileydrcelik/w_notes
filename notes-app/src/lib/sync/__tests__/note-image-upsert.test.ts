import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { NOTE_IMAGE_UPSERT_SQL } from '@/lib/sync/note-image-upsert';

/**
 * The pull-merge statement for note images, run against a real SQLite.
 *
 * Same arrangement, and same reason, as `copa-upsert.test.ts`: when these rules
 * are wrong a note keeps its text and loses its pictures, on every device, with
 * nothing logged — and `db.ts` can't be loaded here because it imports
 * `expo-sqlite`.
 *
 * The schema mirrors `note_images` in `db.ts` for the columns this touches.
 */

let db: DatabaseSync;

/** One pulled row, in the statement's bind order. */
function pull(row: {
  id: string;
  updated_at: number;
  deleted_at?: number | null;
  mime_type?: string | null;
  file_size?: number | null;
  width?: number | null;
  height?: number | null;
  remote_key?: string | null;
}) {
  db.prepare(NOTE_IMAGE_UPSERT_SQL).run(
    row.id,
    1,
    row.updated_at,
    row.deleted_at ?? null,
    row.mime_type ?? null,
    row.file_size ?? null,
    row.width ?? null,
    row.height ?? null,
    row.remote_key ?? null,
  );
}

function read(id: string) {
  return db
    .prepare('SELECT remote_key, width, height, deleted_at, dirty FROM note_images WHERE id = ?')
    .get(id) as
    | {
        remote_key: string | null;
        width: number | null;
        height: number | null;
        deleted_at: number | null;
        dirty: number;
      }
    | undefined;
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE note_images (
      id           TEXT PRIMARY KEY NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL DEFAULT 0,
      deleted_at   INTEGER,
      dirty        INTEGER NOT NULL DEFAULT 1,
      mime_type    TEXT,
      file_size    INTEGER,
      width        INTEGER,
      height       INTEGER,
      remote_key   TEXT,
      local_uri    TEXT,
      file_session TEXT
    );
  `);
});

describe('NOTE_IMAGE_UPSERT_SQL', () => {
  it('inserts a pulled row clean', () => {
    pull({ id: 'i1', updated_at: 5, remote_key: 'note-images/abc', width: 800, height: 600 });

    expect(read('i1')).toMatchObject({ remote_key: 'note-images/abc', width: 800, dirty: 0 });
  });

  it('keeps the stored key when a newer row arrives without one', () => {
    // The device that uploaded stamped the key; a peer that hasn't pulled that
    // stamp yet pushes the row it holds, honestly carrying NULL. Overwriting
    // would leave nothing pointing at the bytes, on every device.
    pull({ id: 'i1', updated_at: 5, remote_key: 'note-images/abc' });
    pull({ id: 'i1', updated_at: 9, remote_key: null, width: 800 });

    expect(read('i1')).toMatchObject({ remote_key: 'note-images/abc', width: 800 });
  });

  it('leaves a row that kept a key dirty, so the key gets pushed back', () => {
    // Preserving a value the payload lacked means this row now holds something
    // the server has never seen. Clearing the flag strands it on this device.
    pull({ id: 'i1', updated_at: 5, remote_key: 'note-images/abc' });
    pull({ id: 'i1', updated_at: 9, remote_key: null });

    expect(read('i1')?.dirty).toBe(1);
  });

  it('keeps the stored dimensions when a row arrives without them', () => {
    pull({ id: 'i1', updated_at: 5, width: 800, height: 600 });
    pull({ id: 'i1', updated_at: 9, width: null, height: null });

    expect(read('i1')).toMatchObject({ width: 800, height: 600 });
  });

  it('ignores a row older than the one stored', () => {
    pull({ id: 'i1', updated_at: 9, width: 800 });
    pull({ id: 'i1', updated_at: 5, width: 100 });

    expect(read('i1')?.width).toBe(800);
  });

  it('applies a tombstone, key intact', () => {
    // The key has to survive: the backend's purge needs it to find the object,
    // and a device mid-download still has to be able to presign a GET.
    pull({ id: 'i1', updated_at: 5, remote_key: 'note-images/abc' });
    pull({ id: 'i1', updated_at: 9, deleted_at: 9, remote_key: 'note-images/abc' });

    expect(read('i1')).toMatchObject({ deleted_at: 9, remote_key: 'note-images/abc' });
  });

  it('un-tombstones when a row comes back alive', () => {
    // The body is the authority: if a surviving body still references the image,
    // a device clears the tombstone and that has to propagate.
    pull({ id: 'i1', updated_at: 5, deleted_at: 5, remote_key: 'note-images/abc' });
    pull({ id: 'i1', updated_at: 9, deleted_at: null, remote_key: 'note-images/abc' });

    expect(read('i1')?.deleted_at).toBeNull();
  });
});
