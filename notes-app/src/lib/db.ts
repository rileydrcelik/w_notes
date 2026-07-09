import * as SQLite from 'expo-sqlite';

import { Sentry } from '@/lib/sentry';
import { removeCopaFiles } from '@/lib/copa-files';
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

/**
 * Records a lightweight Sentry breadcrumb for a database mutation. These don't
 * report anything on their own — they ride along as context on whatever error
 * is captured next (e.g. a failed write surfaced by the store), so a report
 * shows the recent sequence of DB ops that led up to it. No-op when Sentry is
 * disabled.
 */
function dbCrumb(op: string, data?: Record<string, unknown>): void {
  Sentry.addBreadcrumb({ category: 'db', message: op, level: 'info', data });
}

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
  // Plugin-note marker: non-null flags a note whose content renders live (e.g.
  // 'sentry') instead of from `body`. plugin_config is opaque per-plugin JSON.
  plugin_type: string | null;
  plugin_config: string | null;
};

type FolderRow = {
  id: string;
  name: string;
  parent_id: string | null;
  favorite: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  trashed_with_folder_id: string | null;
};

type CopaRow = {
  id: string;
  label: string;
  content: string;
  favorite: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  // File attachment columns. file_name/mime_type/file_size/remote_key sync;
  // file_uri/thumb_uri are device-local paths and never leave the device.
  file_uri: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_size: number | null;
  thumb_uri: string | null;
  remote_key: string | null;
};

// ---- Trash entry shape, shared with the store / trash screen ----

export type TrashEntry =
  | { kind: 'note'; id: string; deletedAt: number; note: Note }
  | {
      kind: 'folder';
      id: string;
      deletedAt: number;
      folder: Folder;
      /** Descendant subfolders trashed alongside this one (flattened). */
      folders: Folder[];
      /** Every note from this folder and its subtree (flattened). */
      notes: Note[];
    };

export type BootstrapData = {
  notes: Note[];
  folders: Folder[];
  trash: TrashEntry[];
};

// ---- Sync wire shapes (snake_case rows exchanged with the backend) ----
// `favorite`/`shared` are number (0/1) when read from SQLite and boolean when
// they arrive as JSON from the server, so both are accepted.

export type FolderSync = {
  id: string;
  name: string;
  parent_id: string | null;
  favorite: number | boolean;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  trashed_with_folder_id: string | null;
};

export type NoteSync = {
  id: string;
  title: string;
  body: string;
  folder_id: string | null;
  favorite: number | boolean;
  shared: number | boolean;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  trashed_with_folder_id: string | null;
  plugin_type: string | null;
  plugin_config: string | null;
};

export type CopaSync = {
  id: string;
  label: string;
  content: string;
  favorite: number | boolean;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  // Synced file-attachment metadata (bytes live in S3 under remote_key).
  file_name: string | null;
  mime_type: string | null;
  file_size: number | null;
  remote_key: string | null;
};

export type SyncPayload = {
  folders: FolderSync[];
  notes: NoteSync[];
  copa_items: CopaSync[];
};

// ---- Connection (opened + migrated once, lazily) ----

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    // Don't cache a rejected open: on web the first attempt can fail because
    // another tab holds the OPFS lock (see lib/web-db-lock.ts), and caching that
    // rejection would brick every later query in this tab. Clearing it lets a
    // retry succeed once this tab takes ownership.
    dbPromise = open().catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

async function open(): Promise<SQLite.SQLiteDatabase> {
  const database = await SQLite.openDatabaseAsync(DB_NAME);
  await database.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS folders (
      id                     TEXT PRIMARY KEY NOT NULL,
      name                   TEXT NOT NULL DEFAULT '',
      parent_id              TEXT,
      favorite               INTEGER NOT NULL DEFAULT 0,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL DEFAULT 0,
      deleted_at             INTEGER,
      trashed_with_folder_id TEXT,
      dirty                  INTEGER NOT NULL DEFAULT 1
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
      trashed_with_folder_id TEXT,
      plugin_type            TEXT,
      plugin_config          TEXT,
      dirty                  INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS copa_items (
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
      remote_key  TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key    TEXT PRIMARY KEY NOT NULL,
      value  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notes_folder_id ON notes (folder_id);
    CREATE INDEX IF NOT EXISTS idx_notes_deleted_at ON notes (deleted_at);
    CREATE INDEX IF NOT EXISTS idx_folders_deleted_at ON folders (deleted_at);
  `);
  // Nesting was added after the first schema shipped: bring older `folders`
  // tables up to date before creating the parent_id index.
  await ensureFolderColumns(database);
  // Sync was added later still: backfill the columns it needs on older tables.
  await ensureSyncColumns(database);
  await database.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders (parent_id);
    CREATE INDEX IF NOT EXISTS idx_notes_dirty ON notes (dirty);
    CREATE INDEX IF NOT EXISTS idx_folders_dirty ON folders (dirty);
    CREATE INDEX IF NOT EXISTS idx_copa_dirty ON copa_items (dirty);
  `);
  return database;
}

/** Adds the nesting columns to a `folders` table created before they existed. */
async function ensureFolderColumns(database: SQLite.SQLiteDatabase): Promise<void> {
  const cols = await database.getAllAsync<{ name: string }>('PRAGMA table_info(folders)');
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has('parent_id')) {
    await database.execAsync('ALTER TABLE folders ADD COLUMN parent_id TEXT');
  }
  if (!has('trashed_with_folder_id')) {
    await database.execAsync('ALTER TABLE folders ADD COLUMN trashed_with_folder_id TEXT');
  }
}

/**
 * Adds the columns sync relies on to tables created before sync existed:
 *  - `updated_at` (folders/copa) — the last-writer-wins clock; backfilled from
 *    `created_at` so pre-existing rows have a sane timestamp.
 *  - `deleted_at` (copa) — copa deletes become soft so they can propagate.
 *  - `dirty` — marks a row as having un-pushed local changes. Existing rows
 *    default to 1 so a first sync uploads everything already on the device.
 */
async function ensureSyncColumns(database: SQLite.SQLiteDatabase): Promise<void> {
  const colsOf = async (table: string) =>
    (await database.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`)).map(
      (c) => c.name,
    );

  const folderCols = await colsOf('folders');
  if (!folderCols.includes('updated_at')) {
    await database.execAsync('ALTER TABLE folders ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
    await database.execAsync('UPDATE folders SET updated_at = created_at WHERE updated_at = 0');
  }
  if (!folderCols.includes('dirty')) {
    await database.execAsync('ALTER TABLE folders ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1');
  }

  const noteCols = await colsOf('notes');
  if (!noteCols.includes('dirty')) {
    await database.execAsync('ALTER TABLE notes ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1');
  }
  // Plugin notes (e.g. Sentry) were added later: backfill the marker columns on
  // notes tables created before they existed.
  if (!noteCols.includes('plugin_type')) {
    await database.execAsync('ALTER TABLE notes ADD COLUMN plugin_type TEXT');
    await database.execAsync('ALTER TABLE notes ADD COLUMN plugin_config TEXT');
  }

  const copaCols = await colsOf('copa_items');
  if (!copaCols.includes('updated_at')) {
    await database.execAsync('ALTER TABLE copa_items ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
    await database.execAsync('UPDATE copa_items SET updated_at = created_at WHERE updated_at = 0');
  }
  if (!copaCols.includes('deleted_at')) {
    await database.execAsync('ALTER TABLE copa_items ADD COLUMN deleted_at INTEGER');
  }
  if (!copaCols.includes('dirty')) {
    await database.execAsync('ALTER TABLE copa_items ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1');
  }
  // File attachments were added later: backfill the file columns on copa tables
  // created before they existed.
  if (!copaCols.includes('file_uri')) {
    await database.execAsync('ALTER TABLE copa_items ADD COLUMN file_uri TEXT');
    await database.execAsync('ALTER TABLE copa_items ADD COLUMN file_name TEXT');
    await database.execAsync('ALTER TABLE copa_items ADD COLUMN mime_type TEXT');
    await database.execAsync('ALTER TABLE copa_items ADD COLUMN file_size INTEGER');
    await database.execAsync('ALTER TABLE copa_items ADD COLUMN thumb_uri TEXT');
  }
  // Cross-device file sync added `remote_key` (the S3 object key) after that.
  if (!copaCols.includes('remote_key')) {
    await database.execAsync('ALTER TABLE copa_items ADD COLUMN remote_key TEXT');
  }
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
    pluginType: (r.plugin_type ?? undefined) as Note['pluginType'],
    pluginConfig: r.plugin_config ?? undefined,
  };
}

function toFolder(r: FolderRow): Folder {
  return { id: r.id, name: r.name, parentId: r.parent_id, favorite: !!r.favorite };
}

function toCopa(r: CopaRow): CopaItem {
  return {
    id: r.id,
    label: r.label,
    content: r.content,
    favorite: !!r.favorite,
    fileUri: r.file_uri ?? undefined,
    fileName: r.file_name ?? undefined,
    mimeType: r.mime_type ?? undefined,
    fileSize: r.file_size ?? undefined,
    thumbUri: r.thumb_uri ?? undefined,
  };
}

async function buildTrash(database: SQLite.SQLiteDatabase): Promise<TrashEntry[]> {
  const trashedFolders = await database.getAllAsync<FolderRow>(
    'SELECT * FROM folders WHERE deleted_at IS NOT NULL',
  );
  const trashedNotes = await database.getAllAsync<NoteRow>(
    'SELECT * FROM notes WHERE deleted_at IS NOT NULL',
  );

  // Only folders trashed in their own right are top-level entries; subfolders
  // dragged down by a parent delete carry that parent's id and fold into it.
  const topLevelFolders = trashedFolders.filter((f) => !f.trashed_with_folder_id);

  const folderEntries: TrashEntry[] = topLevelFolders.map((f) => ({
    kind: 'folder',
    id: f.id,
    deletedAt: f.deleted_at!,
    folder: toFolder(f),
    folders: trashedFolders.filter((sub) => sub.trashed_with_folder_id === f.id).map(toFolder),
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

  async createNote({
    id,
    folderId,
    pluginType,
    pluginConfig,
  }: {
    id: string;
    folderId: string | null;
    /** Marks a plugin note (e.g. 'sentry') that renders live content, not a body. */
    pluginType?: string;
    /** Opaque per-plugin JSON config (e.g. Sentry org/project). */
    pluginConfig?: string;
  }): Promise<void> {
    dbCrumb('createNote', { id, folderId, pluginType });
    const database = await getDb();
    const now = Date.now();
    await database.runAsync(
      'INSERT INTO notes (id, title, body, folder_id, created_at, updated_at, plugin_type, plugin_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, '', '', folderId, now, now, pluginType ?? null, pluginConfig ?? null],
    );
  },

  async updateNote(
    id: string,
    patch: Partial<Pick<Note, 'title' | 'body' | 'folderId' | 'favorite' | 'shared' | 'pluginConfig'>>,
  ): Promise<void> {
    dbCrumb('updateNote', { id, fields: Object.keys(patch) });
    const database = await getDb();
    const sets: string[] = [];
    const args: SQLite.SQLiteBindValue[] = [];
    if (patch.title !== undefined) (sets.push('title = ?'), args.push(patch.title));
    if (patch.body !== undefined) (sets.push('body = ?'), args.push(patch.body));
    if (patch.folderId !== undefined) (sets.push('folder_id = ?'), args.push(patch.folderId));
    if (patch.favorite !== undefined) (sets.push('favorite = ?'), args.push(patch.favorite ? 1 : 0));
    if (patch.shared !== undefined) (sets.push('shared = ?'), args.push(patch.shared ? 1 : 0));
    // A plugin note's config (e.g. Sentry org/project) can be set after creation
    // when the user configures the note; it syncs like any other column.
    if (patch.pluginConfig !== undefined)
      (sets.push('plugin_config = ?'), args.push(patch.pluginConfig));
    sets.push('updated_at = ?', 'dirty = 1');
    args.push(Date.now());
    args.push(id);
    await database.runAsync(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`, args);
  },

  async deleteNote(id: string): Promise<void> {
    dbCrumb('deleteNote', { id });
    const database = await getDb();
    const now = Date.now();
    await database.runAsync(
      'UPDATE notes SET deleted_at = ?, updated_at = ?, dirty = 1, trashed_with_folder_id = NULL WHERE id = ?',
      [now, now, id],
    );
  },

  async createFolder({
    id,
    parentId,
  }: {
    id: string;
    parentId: string | null;
  }): Promise<void> {
    dbCrumb('createFolder', { id, parentId });
    const database = await getDb();
    const now = Date.now();
    await database.runAsync(
      'INSERT INTO folders (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [id, '', parentId, now, now],
    );
  },

  async updateFolder(
    id: string,
    patch: Partial<Pick<Folder, 'name' | 'favorite'>>,
  ): Promise<void> {
    dbCrumb('updateFolder', { id, fields: Object.keys(patch) });
    const database = await getDb();
    const sets: string[] = [];
    const args: SQLite.SQLiteBindValue[] = [];
    if (patch.name !== undefined) (sets.push('name = ?'), args.push(patch.name));
    if (patch.favorite !== undefined)
      (sets.push('favorite = ?'), args.push(patch.favorite ? 1 : 0));
    if (sets.length === 0) return;
    sets.push('updated_at = ?', 'dirty = 1');
    args.push(Date.now());
    args.push(id);
    await database.runAsync(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`, args);
  },

  /**
   * Soft-delete the folder together with its whole subtree — every descendant
   * subfolder and note. The descendants are tagged with this folder's id so a
   * single restore brings the entire group back as it was.
   */
  async deleteFolder(id: string): Promise<void> {
    dbCrumb('deleteFolder', { id });
    const database = await getDb();
    const now = Date.now();
    // Walk the tree to gather the folder and all live descendant folders.
    const subtree = await database.getAllAsync<{ id: string }>(
      `WITH RECURSIVE descendants(fid) AS (
         SELECT id FROM folders WHERE id = ?
         UNION ALL
         SELECT f.id FROM folders f JOIN descendants d ON f.parent_id = d.fid
         WHERE f.deleted_at IS NULL
       )
       SELECT fid AS id FROM descendants`,
      [id],
    );
    const subtreeIds = subtree.map((r) => r.id);
    const descendantIds = subtreeIds.filter((fid) => fid !== id);
    const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

    await database.withTransactionAsync(async () => {
      // Trash every note living anywhere in the subtree, tagged with the root.
      await database.runAsync(
        `UPDATE notes SET deleted_at = ?, updated_at = ?, dirty = 1, trashed_with_folder_id = ?
         WHERE deleted_at IS NULL AND folder_id IN (${placeholders(subtreeIds.length)})`,
        [now, now, id, ...subtreeIds],
      );
      // Trash descendant folders, tagged with the root so they restore together.
      if (descendantIds.length > 0) {
        await database.runAsync(
          `UPDATE folders SET deleted_at = ?, updated_at = ?, dirty = 1, trashed_with_folder_id = ?
           WHERE id IN (${placeholders(descendantIds.length)})`,
          [now, now, id, ...descendantIds],
        );
      }
      // The root folder is the top-level trash entry (no trashed_with tag).
      await database.runAsync('UPDATE folders SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ?', [
        now,
        now,
        id,
      ]);
    });
  },

  async restoreFromTrash(id: string): Promise<void> {
    dbCrumb('restoreFromTrash', { id });
    const database = await getDb();
    const folder = await database.getFirstAsync<FolderRow>(
      'SELECT * FROM folders WHERE id = ? AND deleted_at IS NOT NULL',
      [id],
    );
    if (folder) {
      // If the folder's parent is gone or still trashed, restore it to the home
      // screen so it doesn't reattach to a missing parent.
      let parentId = folder.parent_id;
      if (parentId) {
        const parent = await database.getFirstAsync<FolderRow>(
          'SELECT * FROM folders WHERE id = ? AND deleted_at IS NULL',
          [parentId],
        );
        if (!parent) parentId = null;
      }
      const now = Date.now();
      await database.withTransactionAsync(async () => {
        await database.runAsync(
          'UPDATE folders SET deleted_at = NULL, updated_at = ?, dirty = 1, parent_id = ? WHERE id = ?',
          [now, parentId, id],
        );
        // Bring back the whole subtree that was trashed alongside this folder.
        await database.runAsync(
          'UPDATE folders SET deleted_at = NULL, updated_at = ?, dirty = 1, trashed_with_folder_id = NULL WHERE trashed_with_folder_id = ?',
          [now, id],
        );
        await database.runAsync(
          'UPDATE notes SET deleted_at = NULL, updated_at = ?, dirty = 1, trashed_with_folder_id = NULL WHERE trashed_with_folder_id = ?',
          [now, id],
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
        'UPDATE notes SET deleted_at = NULL, updated_at = ?, dirty = 1, trashed_with_folder_id = NULL, folder_id = ? WHERE id = ?',
        [Date.now(), folderId, id],
      );
    }
  },

  async listCopa(): Promise<CopaItem[]> {
    const database = await getDb();
    const rows = await database.getAllAsync<CopaRow>(
      'SELECT * FROM copa_items WHERE deleted_at IS NULL ORDER BY created_at DESC',
    );
    return rows.map(toCopa);
  },

  async createCopa({
    id,
    label = '',
    file,
  }: {
    id: string;
    label?: string;
    /** Local-only file attachment metadata; omitted for plain text blocks. */
    file?: Pick<CopaItem, 'fileUri' | 'fileName' | 'mimeType' | 'fileSize' | 'thumbUri'>;
  }): Promise<void> {
    dbCrumb('createCopa', { id, file: !!file });
    const database = await getDb();
    const now = Date.now();
    await database.runAsync(
      `INSERT INTO copa_items
         (id, label, content, created_at, updated_at,
          file_uri, file_name, mime_type, file_size, thumb_uri)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        label,
        '',
        now,
        now,
        file?.fileUri ?? null,
        file?.fileName ?? null,
        file?.mimeType ?? null,
        file?.fileSize ?? null,
        file?.thumbUri ?? null,
      ],
    );
  },

  async updateCopa(
    id: string,
    patch: Partial<Pick<CopaItem, 'label' | 'content' | 'favorite'>>,
  ): Promise<void> {
    dbCrumb('updateCopa', { id, fields: Object.keys(patch) });
    const database = await getDb();
    const sets: string[] = [];
    const args: SQLite.SQLiteBindValue[] = [];
    if (patch.label !== undefined) (sets.push('label = ?'), args.push(patch.label));
    if (patch.content !== undefined) (sets.push('content = ?'), args.push(patch.content));
    if (patch.favorite !== undefined)
      (sets.push('favorite = ?'), args.push(patch.favorite ? 1 : 0));
    if (sets.length === 0) return;
    sets.push('updated_at = ?', 'dirty = 1');
    args.push(Date.now());
    args.push(id);
    await database.runAsync(`UPDATE copa_items SET ${sets.join(', ')} WHERE id = ?`, args);
  },

  async deleteCopa(id: string): Promise<void> {
    dbCrumb('deleteCopa', { id });
    const database = await getDb();
    // Drop any attached file bytes from disk first — they're local-only, so the
    // soft-deleted row would otherwise leave them orphaned forever.
    const row = await database.getFirstAsync<{ file_uri: string | null; thumb_uri: string | null }>(
      'SELECT file_uri, thumb_uri FROM copa_items WHERE id = ?',
      [id],
    );
    if (row?.file_uri) removeCopaFiles({ fileUri: row.file_uri, thumbUri: row.thumb_uri ?? undefined });
    const now = Date.now();
    // Soft delete so the removal can sync to other devices (a hard DELETE would
    // be invisible to the server and the row would resurrect on the next pull).
    await database.runAsync(
      'UPDATE copa_items SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ?',
      [now, now, id],
    );
  },

  // ---- File attachment sync (bytes live in S3; see lib/sync/files.ts) ----

  /** Live file blocks whose bytes haven't been uploaded yet (no remote_key). */
  async getCopaUploads(): Promise<{ id: string; fileUri: string; mimeType: string | null }[]> {
    const database = await getDb();
    const rows = await database.getAllAsync<{ id: string; file_uri: string; mime_type: string | null }>(
      `SELECT id, file_uri, mime_type FROM copa_items
       WHERE file_uri IS NOT NULL AND remote_key IS NULL AND deleted_at IS NULL`,
    );
    return rows.map((r) => ({ id: r.id, fileUri: r.file_uri, mimeType: r.mime_type }));
  },

  /** Record the S3 key after a successful upload, and queue it to push. */
  async setCopaRemoteKey(id: string, remoteKey: string): Promise<void> {
    dbCrumb('setCopaRemoteKey', { id });
    const database = await getDb();
    const now = Date.now();
    await database.runAsync(
      'UPDATE copa_items SET remote_key = ?, updated_at = ?, dirty = 1 WHERE id = ?',
      [remoteKey, now, id],
    );
  },

  /** Live file blocks with bytes in S3 but no local copy yet (need download). */
  async getCopaDownloads(): Promise<
    { id: string; remoteKey: string; mimeType: string | null; fileName: string | null }[]
  > {
    const database = await getDb();
    const rows = await database.getAllAsync<{
      id: string;
      remote_key: string;
      mime_type: string | null;
      file_name: string | null;
    }>(
      `SELECT id, remote_key, mime_type, file_name FROM copa_items
       WHERE remote_key IS NOT NULL AND file_uri IS NULL AND deleted_at IS NULL`,
    );
    return rows.map((r) => ({
      id: r.id,
      remoteKey: r.remote_key,
      mimeType: r.mime_type,
      fileName: r.file_name,
    }));
  },

  /**
   * Point a block at its freshly-downloaded local bytes. These paths are
   * device-specific, so this deliberately does NOT mark the row dirty.
   */
  async setCopaLocalFile(id: string, fileUri: string, thumbUri: string | null): Promise<void> {
    dbCrumb('setCopaLocalFile', { id });
    const database = await getDb();
    await database.runAsync('UPDATE copa_items SET file_uri = ?, thumb_uri = ? WHERE id = ?', [
      fileUri,
      thumbUri,
      id,
    ]);
  },

  /**
   * Clears `file_uri`/`thumb_uri` for blocks whose path is a browser object URL
   * (`blob:`). Those URLs only live for one page session, so a persisted one is
   * dead after a reload. Nulling it lets the sync engine re-download the bytes
   * from S3 (rows that still carry a `remote_key`) into a fresh URL. No-op on
   * native, where paths are durable `file://` URIs. Device-local, so not dirty.
   */
  async resetEphemeralFiles(): Promise<void> {
    const database = await getDb();
    await database.runAsync(
      "UPDATE copa_items SET file_uri = NULL, thumb_uri = NULL WHERE file_uri LIKE 'blob:%'",
    );
  },

  // ---- Sync support ----

  /** All rows with un-pushed local changes, in the backend's wire shape. */
  async getDirty(): Promise<SyncPayload> {
    const database = await getDb();
    const [folders, notes, copa_items] = await Promise.all([
      database.getAllAsync<FolderSync>(
        `SELECT id, name, parent_id, favorite, created_at, updated_at, deleted_at,
                trashed_with_folder_id
         FROM folders WHERE dirty = 1`,
      ),
      database.getAllAsync<NoteSync>(
        `SELECT id, title, body, folder_id, favorite, shared, created_at, updated_at,
                deleted_at, trashed_with_folder_id, plugin_type, plugin_config
         FROM notes WHERE dirty = 1`,
      ),
      database.getAllAsync<CopaSync>(
        `SELECT id, label, content, favorite, created_at, updated_at, deleted_at,
                file_name, mime_type, file_size, remote_key
         FROM copa_items WHERE dirty = 1`,
      ),
    ]);
    return { folders, notes, copa_items };
  },

  /**
   * Clears the dirty flag on rows we successfully pushed — but only if the row
   * hasn't been edited again since (matched on `updated_at`), so a change made
   * mid-sync stays pending and goes out on the next pass.
   */
  async markSynced(payload: SyncPayload): Promise<void> {
    const database = await getDb();
    await database.withTransactionAsync(async () => {
      for (const f of payload.folders) {
        await database.runAsync('UPDATE folders SET dirty = 0 WHERE id = ? AND updated_at = ?', [
          f.id,
          f.updated_at,
        ]);
      }
      for (const n of payload.notes) {
        await database.runAsync('UPDATE notes SET dirty = 0 WHERE id = ? AND updated_at = ?', [
          n.id,
          n.updated_at,
        ]);
      }
      for (const c of payload.copa_items) {
        await database.runAsync('UPDATE copa_items SET dirty = 0 WHERE id = ? AND updated_at = ?', [
          c.id,
          c.updated_at,
        ]);
      }
    });
  },

  /**
   * Upserts rows pulled from the server, last-writer-wins on `updated_at`: a
   * server row is applied only when it's newer-or-equal to the local copy, so a
   * locally-dirty row that's still newer is left to push. Applied rows are
   * marked clean (dirty = 0). Returns how many rows actually changed locally,
   * so callers know whether the UI needs refreshing.
   */
  async applyServerRows(payload: SyncPayload): Promise<number> {
    const database = await getDb();
    const bit = (v: number | boolean) => (v ? 1 : 0);
    let changed = 0;
    await database.withTransactionAsync(async () => {
      for (const f of payload.folders) {
        const r = await database.runAsync(
          `INSERT INTO folders
             (id, name, parent_id, favorite, created_at, updated_at, deleted_at,
              trashed_with_folder_id, dirty)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, parent_id = excluded.parent_id,
             favorite = excluded.favorite, created_at = excluded.created_at,
             updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
             trashed_with_folder_id = excluded.trashed_with_folder_id, dirty = 0
           WHERE excluded.updated_at >= folders.updated_at`,
          [
            f.id,
            f.name,
            f.parent_id,
            bit(f.favorite),
            f.created_at,
            f.updated_at,
            f.deleted_at,
            f.trashed_with_folder_id,
          ],
        );
        changed += r.changes;
      }
      for (const n of payload.notes) {
        const r = await database.runAsync(
          `INSERT INTO notes
             (id, title, body, folder_id, favorite, shared, created_at, updated_at,
              deleted_at, trashed_with_folder_id, plugin_type, plugin_config, dirty)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, body = excluded.body, folder_id = excluded.folder_id,
             favorite = excluded.favorite, shared = excluded.shared,
             created_at = excluded.created_at, updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             trashed_with_folder_id = excluded.trashed_with_folder_id,
             plugin_type = excluded.plugin_type, plugin_config = excluded.plugin_config,
             dirty = 0
           WHERE excluded.updated_at >= notes.updated_at`,
          [
            n.id,
            n.title,
            n.body,
            n.folder_id,
            bit(n.favorite),
            bit(n.shared),
            n.created_at,
            n.updated_at,
            n.deleted_at,
            n.trashed_with_folder_id,
            n.plugin_type ?? null,
            n.plugin_config ?? null,
          ],
        );
        changed += r.changes;
      }
      for (const c of payload.copa_items) {
        const r = await database.runAsync(
          `INSERT INTO copa_items
             (id, label, content, favorite, created_at, updated_at, deleted_at,
              file_name, mime_type, file_size, remote_key, dirty)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET
             label = excluded.label, content = excluded.content,
             favorite = excluded.favorite, created_at = excluded.created_at,
             updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
             file_name = excluded.file_name, mime_type = excluded.mime_type,
             file_size = excluded.file_size, remote_key = excluded.remote_key, dirty = 0
           WHERE excluded.updated_at >= copa_items.updated_at`,
          [
            c.id,
            c.label,
            c.content,
            bit(c.favorite),
            c.created_at,
            c.updated_at,
            c.deleted_at,
            c.file_name,
            c.mime_type,
            c.file_size,
            c.remote_key,
          ],
        );
        changed += r.changes;
      }
    });
    return changed;
  },

  /**
   * Marks every row dirty so the next sync re-pushes the whole local dataset.
   * Used on first sign-in to claim anonymous notes into the account.
   */
  async markAllDirty(): Promise<void> {
    const database = await getDb();
    await database.execAsync(
      'UPDATE folders SET dirty = 1; UPDATE notes SET dirty = 1; UPDATE copa_items SET dirty = 1;',
    );
  },

  /**
   * Removes all notes/folders/copa rows (not settings). Used on sign-out and
   * when switching accounts, so one account's data never bleeds into another on
   * the same device. The cursor is reset separately by the caller.
   */
  async clearAllData(): Promise<void> {
    const database = await getDb();
    await database.execAsync('DELETE FROM folders; DELETE FROM notes; DELETE FROM copa_items;');
  },

  /** The last server_seq this device has pulled (0 if it has never synced). */
  async getCursor(): Promise<number> {
    const database = await getDb();
    const row = await database.getFirstAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      ['sync_cursor'],
    );
    return row ? Number(row.value) : 0;
  },

  /** Advances the stored pull cursor. */
  async setCursor(seq: number): Promise<void> {
    const database = await getDb();
    await database.runAsync(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ['sync_cursor', String(seq)],
    );
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
