import * as SQLite from 'expo-sqlite';

import type { Folder, Note } from '@/data/notes';
import type { CopaItem } from '@/data/copa';

/**
 * On-device persistence with SQLite. The whole app's data lives in a single
 * database file (`wnotes.db`) inside the app's sandbox — no server, no network.
 *
 * This module exposes a small `db` object whose methods mirror the shapes the
 * stores expect, so the stores read like simple data calls. Deletes are soft
 * (`deleted_at` is set) and a folder delete trashes its notes alongside it via
 * `trashed_with_folder_id`, so a restore brings the group back together.
 */

const DB_NAME = 'wnotes.db';

// ---- Raw row shapes (snake_case, booleans as 0/1, timestamps as epoch ms) ----

type NoteRow = {
  id: string;
  title: string;
  body: string;
  folder_id: string | null;
  favorite: number;
  shared: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  trashed_with_folder_id: string | null;
};

type FolderRow = {
  id: string;
  name: string;
  favorite: number;
  created_at: number;
  deleted_at: number | null;
};

type CopaRow = {
  id: string;
  label: string;
  content: string;
  favorite: number;
  created_at: number;
};

// ---- Trash entry shape, shared with the store / trash screen ----

export type TrashEntry =
  | { kind: 'note'; id: string; deletedAt: number; note: Note }
  | { kind: 'folder'; id: string; deletedAt: number; folder: Folder; notes: Note[] };

export type BootstrapData = {
  notes: Note[];
  folders: Folder[];
  trash: TrashEntry[];
};

// ---- Connection (opened + migrated once, lazily) ----

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = open();
  return dbPromise;
}

async function open(): Promise<SQLite.SQLiteDatabase> {
  const database = await SQLite.openDatabaseAsync(DB_NAME);
  await database.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS folders (
      id          TEXT PRIMARY KEY NOT NULL,
      name        TEXT NOT NULL DEFAULT '',
      favorite    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      deleted_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS notes (
      id                     TEXT PRIMARY KEY NOT NULL,
      title                  TEXT NOT NULL DEFAULT '',
      body                   TEXT NOT NULL DEFAULT '',
      folder_id              TEXT,
      favorite               INTEGER NOT NULL DEFAULT 0,
      shared                 INTEGER NOT NULL DEFAULT 0,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL,
      deleted_at             INTEGER,
      trashed_with_folder_id TEXT
    );

    CREATE TABLE IF NOT EXISTS copa_items (
      id          TEXT PRIMARY KEY NOT NULL,
      label       TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL DEFAULT '',
      favorite    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key    TEXT PRIMARY KEY NOT NULL,
      value  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notes_folder_id ON notes (folder_id);
    CREATE INDEX IF NOT EXISTS idx_notes_deleted_at ON notes (deleted_at);
    CREATE INDEX IF NOT EXISTS idx_folders_deleted_at ON folders (deleted_at);
  `);
  return database;
}

// ---- Row -> app-shape converters ----

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function toNote(r: NoteRow): Note {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    folderId: r.folder_id,
    updatedAt: ymd(r.updated_at),
    favorite: !!r.favorite,
    shared: !!r.shared,
  };
}

function toFolder(r: FolderRow): Folder {
  return { id: r.id, name: r.name, favorite: !!r.favorite };
}

function toCopa(r: CopaRow): CopaItem {
  return { id: r.id, label: r.label, content: r.content, favorite: !!r.favorite };
}

async function buildTrash(database: SQLite.SQLiteDatabase): Promise<TrashEntry[]> {
  const trashedFolders = await database.getAllAsync<FolderRow>(
    'SELECT * FROM folders WHERE deleted_at IS NOT NULL',
  );
  const trashedNotes = await database.getAllAsync<NoteRow>(
    'SELECT * FROM notes WHERE deleted_at IS NOT NULL',
  );

  const folderEntries: TrashEntry[] = trashedFolders.map((f) => ({
    kind: 'folder',
    id: f.id,
    deletedAt: f.deleted_at!,
    folder: toFolder(f),
    notes: trashedNotes.filter((n) => n.trashed_with_folder_id === f.id).map(toNote),
  }));

  const noteEntries: TrashEntry[] = trashedNotes
    .filter((n) => !n.trashed_with_folder_id)
    .map((n) => ({ kind: 'note', id: n.id, deletedAt: n.deleted_at!, note: toNote(n) }));

  return [...folderEntries, ...noteEntries].sort((a, b) => b.deletedAt - a.deletedAt);
}

// ---- Public API (mirrors the data the stores need) ----

export const db = {
  /** Load everything for the notes/folders/trash store in one shot. */
  async bootstrap(): Promise<BootstrapData> {
    const database = await getDb();
    const [noteRows, folderRows, trash] = await Promise.all([
      database.getAllAsync<NoteRow>(
        'SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY created_at DESC',
      ),
      database.getAllAsync<FolderRow>(
        'SELECT * FROM folders WHERE deleted_at IS NULL ORDER BY created_at DESC',
      ),
      buildTrash(database),
    ]);
    return { notes: noteRows.map(toNote), folders: folderRows.map(toFolder), trash };
  },

  async createNote({ id, folderId }: { id: string; folderId: string | null }): Promise<void> {
    const database = await getDb();
    const now = Date.now();
    await database.runAsync(
      'INSERT INTO notes (id, title, body, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, '', '', folderId, now, now],
    );
  },

  async updateNote(
    id: string,
    patch: Partial<Pick<Note, 'title' | 'body' | 'folderId' | 'favorite' | 'shared'>>,
  ): Promise<void> {
    const database = await getDb();
    const sets: string[] = [];
    const args: SQLite.SQLiteBindValue[] = [];
    if (patch.title !== undefined) (sets.push('title = ?'), args.push(patch.title));
    if (patch.body !== undefined) (sets.push('body = ?'), args.push(patch.body));
    if (patch.folderId !== undefined) (sets.push('folder_id = ?'), args.push(patch.folderId));
    if (patch.favorite !== undefined) (sets.push('favorite = ?'), args.push(patch.favorite ? 1 : 0));
    if (patch.shared !== undefined) (sets.push('shared = ?'), args.push(patch.shared ? 1 : 0));
    sets.push('updated_at = ?');
    args.push(Date.now());
    args.push(id);
    await database.runAsync(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`, args);
  },

  async deleteNote(id: string): Promise<void> {
    const database = await getDb();
    await database.runAsync(
      'UPDATE notes SET deleted_at = ?, trashed_with_folder_id = NULL WHERE id = ?',
      [Date.now(), id],
    );
  },

  async createFolder({ id }: { id: string }): Promise<void> {
    const database = await getDb();
    await database.runAsync('INSERT INTO folders (id, name, created_at) VALUES (?, ?, ?)', [
      id,
      '',
      Date.now(),
    ]);
  },

  async updateFolder(
    id: string,
    patch: Partial<Pick<Folder, 'name' | 'favorite'>>,
  ): Promise<void> {
    const database = await getDb();
    const sets: string[] = [];
    const args: SQLite.SQLiteBindValue[] = [];
    if (patch.name !== undefined) (sets.push('name = ?'), args.push(patch.name));
    if (patch.favorite !== undefined)
      (sets.push('favorite = ?'), args.push(patch.favorite ? 1 : 0));
    if (sets.length === 0) return;
    args.push(id);
    await database.runAsync(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`, args);
  },

  /** Soft-delete the folder and trash its live notes alongside it. */
  async deleteFolder(id: string): Promise<void> {
    const database = await getDb();
    const now = Date.now();
    await database.withTransactionAsync(async () => {
      await database.runAsync(
        'UPDATE notes SET deleted_at = ?, trashed_with_folder_id = ? WHERE folder_id = ? AND deleted_at IS NULL',
        [now, id, id],
      );
      await database.runAsync('UPDATE folders SET deleted_at = ? WHERE id = ?', [now, id]);
    });
  },

  async restoreFromTrash(id: string): Promise<void> {
    const database = await getDb();
    const folder = await database.getFirstAsync<FolderRow>(
      'SELECT * FROM folders WHERE id = ? AND deleted_at IS NOT NULL',
      [id],
    );
    if (folder) {
      await database.withTransactionAsync(async () => {
        await database.runAsync('UPDATE folders SET deleted_at = NULL WHERE id = ?', [id]);
        await database.runAsync(
          'UPDATE notes SET deleted_at = NULL, trashed_with_folder_id = NULL WHERE trashed_with_folder_id = ?',
          [id],
        );
      });
      return;
    }

    const note = await database.getFirstAsync<NoteRow>(
      'SELECT * FROM notes WHERE id = ? AND deleted_at IS NOT NULL',
      [id],
    );
    if (note) {
      // If the parent folder is gone or still trashed, restore to the home screen.
      let folderId = note.folder_id;
      if (folderId) {
        const parent = await database.getFirstAsync<FolderRow>(
          'SELECT * FROM folders WHERE id = ? AND deleted_at IS NULL',
          [folderId],
        );
        if (!parent) folderId = null;
      }
      await database.runAsync(
        'UPDATE notes SET deleted_at = NULL, trashed_with_folder_id = NULL, folder_id = ? WHERE id = ?',
        [folderId, id],
      );
    }
  },

  async listCopa(): Promise<CopaItem[]> {
    const database = await getDb();
    const rows = await database.getAllAsync<CopaRow>(
      'SELECT * FROM copa_items ORDER BY created_at DESC',
    );
    return rows.map(toCopa);
  },

  async createCopa({ id }: { id: string }): Promise<void> {
    const database = await getDb();
    await database.runAsync('INSERT INTO copa_items (id, label, content, created_at) VALUES (?, ?, ?, ?)', [
      id,
      '',
      '',
      Date.now(),
    ]);
  },

  async updateCopa(
    id: string,
    patch: Partial<Pick<CopaItem, 'label' | 'content' | 'favorite'>>,
  ): Promise<void> {
    const database = await getDb();
    const sets: string[] = [];
    const args: SQLite.SQLiteBindValue[] = [];
    if (patch.label !== undefined) (sets.push('label = ?'), args.push(patch.label));
    if (patch.content !== undefined) (sets.push('content = ?'), args.push(patch.content));
    if (patch.favorite !== undefined)
      (sets.push('favorite = ?'), args.push(patch.favorite ? 1 : 0));
    if (sets.length === 0) return;
    args.push(id);
    await database.runAsync(`UPDATE copa_items SET ${sets.join(', ')} WHERE id = ?`, args);
  },

  async deleteCopa(id: string): Promise<void> {
    const database = await getDb();
    await database.runAsync('DELETE FROM copa_items WHERE id = ?', [id]);
  },

  /** Read a single key from the key-value settings table (null if unset). */
  async getSetting(key: string): Promise<string | null> {
    const database = await getDb();
    const row = await database.getFirstAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      [key],
    );
    return row?.value ?? null;
  },

  /** Upsert a single key into the settings table. */
  async setSetting(key: string, value: string): Promise<void> {
    const database = await getDb();
    await database.runAsync(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  },
};
