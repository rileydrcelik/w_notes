import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { COPA_UPSERT_SQL } from '@/lib/sync/copa-upsert';

/**
 * Runs the real pull-merge statement against a real SQLite, because the rules it
 * encodes lose an attachment silently when they are wrong and `db.ts` itself
 * can't be loaded here (it imports `expo-sqlite`).
 *
 * The schema below mirrors `copa_items` in `db.ts` for the columns this
 * statement touches.
 */

let db: DatabaseSync;

/** One pulled row, in the statement's bind order. */
function pull(row: {
  id: string;
  label?: string;
  updated_at: number;
  remote_key?: string | null;
}) {
  db.prepare(COPA_UPSERT_SQL).run(
    row.id,
    row.label ?? '',
    '',
    0,
    1,
    row.updated_at,
    null,
    null,
    null,
    null,
    row.remote_key ?? null,
  );
}

function read(id: string) {
  return db.prepare('SELECT remote_key, label, dirty FROM copa_items WHERE id = ?').get(id) as
    | { remote_key: string | null; label: string; dirty: number }
    | undefined;
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE copa_items (
      id          TEXT PRIMARY KEY NOT NULL,
      label       TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL DEFAULT '',
      favorite    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL DEFAULT 0,
      deleted_at  INTEGER,
      dirty       INTEGER NOT NULL DEFAULT 1,
      file_uri    TEXT,
      file_name   TEXT,
      mime_type   TEXT,
      file_size   INTEGER,
      thumb_uri   TEXT,
      remote_key  TEXT,
      file_session TEXT
    );
  `);
});

describe('the pulled-copa merge', () => {
  it('keeps a local remote_key when the pulled row has none', () => {
    // This device finished the upload; a peer that hasn't pulled the stamp yet
    // renames the block and pushes. Last-writer-wins on the key would orphan the
    // S3 object and lose the file on every device.
    pull({ id: 'c1', label: 'first', updated_at: 10 });
    db.prepare("UPDATE copa_items SET remote_key = 'K', updated_at = 20, dirty = 1 WHERE id = 'c1'").run();

    pull({ id: 'c1', label: 'renamed by peer', updated_at: 30, remote_key: null });

    const row = read('c1');
    expect(row?.remote_key).toBe('K');
    // The peer's newer edit still wins for ordinary columns.
    expect(row?.label).toBe('renamed by peer');
  });

  it('leaves a row that kept its key dirty, so the key still gets pushed', () => {
    // Preserving locally but clearing dirty would strand the key on this device
    // — the same loss, one step removed.
    pull({ id: 'c1', updated_at: 10 });
    db.prepare("UPDATE copa_items SET remote_key = 'K', updated_at = 20 WHERE id = 'c1'").run();

    pull({ id: 'c1', updated_at: 30, remote_key: null });

    expect(read('c1')?.dirty).toBe(1);
  });

  it('takes the incoming key and settles clean when the payload has one', () => {
    pull({ id: 'c1', updated_at: 10 });
    pull({ id: 'c1', updated_at: 20, remote_key: 'SERVER' });

    const row = read('c1');
    expect(row?.remote_key).toBe('SERVER');
    expect(row?.dirty).toBe(0);
  });

  it('settles clean when neither side has a key', () => {
    pull({ id: 'c1', updated_at: 10 });
    pull({ id: 'c1', updated_at: 20 });

    expect(read('c1')?.dirty).toBe(0);
  });

  it('ignores a payload older than the local row', () => {
    pull({ id: 'c1', label: 'newer', updated_at: 30 });
    pull({ id: 'c1', label: 'stale', updated_at: 10, remote_key: 'K' });

    const row = read('c1');
    expect(row?.label).toBe('newer');
    expect(row?.remote_key).toBeNull();
  });
});
