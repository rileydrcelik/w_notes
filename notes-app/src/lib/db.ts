import * as SQLite from 'expo-sqlite';

import { Sentry } from '@/lib/sentry';
import { removeCopaFiles } from '@/lib/copa-files';
import {
  clearDevSeed,
  runDevSeed,
  DEV_SEED_CLEARED_FLAG,
  DEV_SEED_PREFIX,
} from '@/lib/dev-seed';
import { runWelcomeSeed, WELCOME_PREFIX } from '@/lib/welcome-content';
import { worthKeepingInTrash } from '@/lib/trash-visibility';
import { migrateThemeKey, THEME_RENAME_FLAG, THEME_SETTING_KEY } from '@/lib/theme-migrate';
import { whenDbOwner } from '@/lib/web-db-lock';
import type { Folder, Issue, Note, ResumeVersion } from '@/data/notes';
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
  published: number;
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
  // Folder "kind" marker (e.g. 'project') + opaque JSON config; null for
  // ordinary folders.
  kind: string | null;
  config: string | null;
};

type IssueRow = {
  id: string;
  note_id: string;
  // JSON array of issue-type note ids; parsed into `typeIds` by `toIssue`.
  type_ids: string;
  title: string;
  description: string;
  done: number;
  // Attribute values as a JSON string; parsed into an object by `toIssue`.
  attrs: string;
  gh_number: number | null;
  position: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

/**
 * One snapshot of a resume's LaTeX source, as it stood after a change.
 *
 * Append-only and immutable: a row is a historical fact, so nothing ever
 * rewrites `source` or `label` once written. That is what makes this table
 * safer than the rest of the schema — every other synced row resolves a
 * conflict by overwriting, and two devices editing offline means one edit is
 * gone. Here each snapshot carries its own id, so two devices appending offline
 * both land, and neither loses the other's history.
 *
 * `label` is frozen at write time, including for the first row (which carries
 * the resume's title as it was then). Deriving it live from the note's title
 * would mean renaming a resume silently rewrote its own history.
 */
type ResumeVersionRow = {
  id: string;
  note_id: string;
  label: string;
  source: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
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
  kind: string | null;
  config: string | null;
};

export type IssueSync = {
  id: string;
  note_id: string;
  // NOT NULL locally ('[]' default); may be null when pulled from a backend that
  // predates multi-type — the upsert coalesces it to keep the stored value.
  type_ids: string | null;
  title: string;
  description: string;
  done: number | boolean;
  attrs: string;
  gh_number: number | null;
  position: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

export type NoteSync = {
  id: string;
  title: string;
  body: string;
  folder_id: string | null;
  favorite: number | boolean;
  shared: number | boolean;
  // Nullable on the wire: the backend COALESCE-preserves this column, so a row
  // that has never been published comes back as null rather than false.
  published: number | boolean | null;
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

/**
 * A finance note's spreadsheet. `id` *is* the owning note's id — one sheet per
 * note, so there's no way to end up with two sheets for one note or an orphan
 * with no note. `data` is the whole document as JSON (see `lib/finance/sheet`),
 * synced as a single row: a bulk edit across hundreds of cells is one upsert
 * rather than hundreds, which matters because the backend upserts rows
 * sequentially under a per-user lock.
 */
export type FinanceSheetSync = {
  id: string;
  data: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

export type ResumeVersionSync = {
  id: string;
  note_id: string;
  label: string;
  source: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

/**
 * One account-scoped preference. `id` *is* the preference name (`themeKey`), so
 * the table is a key-value store that happens to sync, and a second preference
 * costs a row rather than a migration.
 *
 * Distinct from the `settings` table below it, which stays resolutely
 * device-local: `sync_cursor`, the device key and `synced_uid` describe *this
 * device's* relationship to the server, and syncing them would be incoherent.
 * The split is the whole point — "what this device is doing" vs "what this
 * person likes".
 */
export type UserSettingSync = {
  id: string;
  value: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

export type SyncPayload = {
  folders: FolderSync[];
  notes: NoteSync[];
  copa_items: CopaSync[];
  issues: IssueSync[];
  finance_sheets: FinanceSheetSync[];
  resume_versions: ResumeVersionSync[];
  user_settings: UserSettingSync[];
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

/**
 * Clears `file_uri`/`thumb_uri` for blocks whose path is a browser object URL
 * (`blob:`). Those URLs only live for one page session, so a persisted one is
 * dead on arrival after a reload. Nulling it both tells the UI it has no local
 * bytes — so it shows a file-type icon rather than a broken image — and lets the
 * sync engine re-download the bytes from S3 for rows that carry a `remote_key`.
 *
 * Takes the handle rather than calling `getDb()`, because it runs during `open`
 * itself: going through the public method would await the connection it is part
 * of creating. It is deliberately not one of the `WRITE_METHODS` either — the
 * serialization chain those go through would deadlock for the same reason, and
 * nothing else can be writing yet at this point in startup.
 *
 * Device-local paths, so this doesn't mark anything dirty. No-op on native,
 * where paths are durable `file://` URIs and no row matches.
 */
async function clearEphemeralFilePaths(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.runAsync(
    "UPDATE copa_items SET file_uri = NULL, thumb_uri = NULL WHERE file_uri LIKE 'blob:%'",
  );
}

async function open(): Promise<SQLite.SQLiteDatabase> {
  // On web, wait until this tab owns the DB before touching the OPFS file. A
  // follower that opened it would fail (another tab holds the exclusive handle)
  // and, worse, leave wa-sqlite's VFS wedged for the whole page — so the open
  // after promotion couldn't recover. Native / no-Web-Locks resolves instantly.
  await whenDbOwner();
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
      kind                   TEXT,
      config                 TEXT,
      dirty                  INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS notes (
      id                     TEXT PRIMARY KEY NOT NULL,
      title                  TEXT NOT NULL DEFAULT '',
      body                   TEXT NOT NULL DEFAULT '',
      folder_id              TEXT,
      favorite               INTEGER NOT NULL DEFAULT 0,
      shared                 INTEGER NOT NULL DEFAULT 0,
      published              INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS issues (
      id           TEXT PRIMARY KEY NOT NULL,
      note_id      TEXT NOT NULL DEFAULT '',
      type_ids     TEXT NOT NULL DEFAULT '[]',
      title        TEXT NOT NULL DEFAULT '',
      description  TEXT NOT NULL DEFAULT '',
      done         INTEGER NOT NULL DEFAULT 0,
      attrs        TEXT NOT NULL DEFAULT '{}',
      gh_number    INTEGER,
      position     INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL DEFAULT 0,
      deleted_at   INTEGER,
      dirty        INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS finance_sheets (
      id          TEXT PRIMARY KEY NOT NULL,
      data        TEXT NOT NULL DEFAULT '{}',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL DEFAULT 0,
      deleted_at  INTEGER,
      dirty       INTEGER NOT NULL DEFAULT 1
    );

    -- Version history for resume notes. New enough that every column can be
    -- NOT NULL from creation — there is no older table to backfill, so this
    -- needs no ensureSyncColumns-style migration.
    CREATE TABLE IF NOT EXISTS resume_versions (
      id          TEXT PRIMARY KEY NOT NULL,
      note_id     TEXT NOT NULL DEFAULT '',
      label       TEXT NOT NULL DEFAULT '',
      source      TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL DEFAULT 0,
      deleted_at  INTEGER,
      dirty       INTEGER NOT NULL DEFAULT 1
    );

    -- Account-scoped preferences (see UserSettingSync). New enough that every
    -- column can be NOT NULL from creation, so like resume_versions it needs no
    -- ensureSyncColumns-style backfill.
    CREATE TABLE IF NOT EXISTS user_settings (
      id          TEXT PRIMARY KEY NOT NULL,
      value       TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL DEFAULT 0,
      deleted_at  INTEGER,
      dirty       INTEGER NOT NULL DEFAULT 1
    );

    -- Device-local key-value store. Deliberately NOT synced and deliberately
    -- NOT cleared by clearAllData: it holds this device's sync cursor, its
    -- device key and the uid it last synced as, which are facts about the
    -- device rather than about the person. Preferences belong in user_settings.
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
  // Move an existing theme choice into the synced table. Runs here, at open,
  // because it must land before the theme store hydrates and before the first
  // sync pull.
  await migrateThemeSetting(database);
  // Then point a stored choice at a theme that still exists, for the two that
  // were retired. Separate from the move above and unguarded by its flag: that
  // one is a one-shot per device, this has to catch a row that has been sitting
  // in `user_settings` since long before either theme was cut.
  await retireRemovedThemes(database);
  await database.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders (parent_id);
    CREATE INDEX IF NOT EXISTS idx_notes_dirty ON notes (dirty);
    CREATE INDEX IF NOT EXISTS idx_folders_dirty ON folders (dirty);
    CREATE INDEX IF NOT EXISTS idx_copa_dirty ON copa_items (dirty);
    CREATE INDEX IF NOT EXISTS idx_issues_note_id ON issues (note_id);
    CREATE INDEX IF NOT EXISTS idx_issues_dirty ON issues (dirty);
    CREATE INDEX IF NOT EXISTS idx_finance_dirty ON finance_sheets (dirty);
    CREATE INDEX IF NOT EXISTS idx_resume_versions_note_id ON resume_versions (note_id);
    CREATE INDEX IF NOT EXISTS idx_resume_versions_dirty ON resume_versions (dirty);
    CREATE INDEX IF NOT EXISTS idx_user_settings_dirty ON user_settings (dirty);
  `);
  // Drop file paths that died with the last page session, before anything can
  // read them. On web a block's `file_uri` is a `blob:` object URL, which is
  // valid only for the page that made it — but it outlives that page in SQLite,
  // so a fresh load starts out holding URLs that look real and resolve to
  // nothing. This used to run inside the first sync pass, which is later than
  // the stores hydrate: the copa feed's first render put those dead URLs
  // straight into an <Image>, showing a broken preview until the bytes had been
  // re-fetched from S3 and the sync event pushed a reload. Clearing them here
  // makes the first paint honest — a file-type icon, then the real thumbnail
  // when it lands. No-op on native, where paths are durable `file://` URIs.
  await clearEphemeralFilePaths(database);
  // Two kinds of content get placed here, in this order, and both are off when
  // `EXPO_PUBLIC_SEED_CONTENT` is '0'.
  //
  // That switch exists for the Playwright suite, which is the one caller that
  // runs a dev bundle and wants nothing on screen: it drives Metro, so `__DEV__`
  // is true there. It covers the welcome content too, even though that is
  // ordinary production behaviour rather than a dev convenience — a smoke suite
  // for a local-first app should start empty, and that promise is written down
  // in `playwright.config.ts`. Leaving first-run content out of the switch would
  // quietly make it false, and silently constrain every test written afterwards
  // to account for a fixture nobody wrote. Nothing but that config sets it.
  const seedContent = process.env.EXPO_PUBLIC_SEED_CONTENT !== '0';

  // What a new library opens with. Runs ahead of the dev seed below, which would
  // otherwise fill the tables and make this decline every time — and ahead of
  // the stores, so a first launch paints the guide rather than an empty grid.
  // Swallowed on failure for the same reason as the dev seed: an empty home
  // screen is a far better outcome than an app that won't open.
  if (seedContent) {
    try {
      await runWelcomeSeed(database);
    } catch (e) {
      console.warn('[db] welcome content skipped:', e);
    }
  }
  // Dev-only sample content, after every migration above so the columns it names
  // exist, and before `getDb()` hands the connection out so it is already there
  // for the stores' first read. `__DEV__` is false in release builds.
  if (__DEV__ && seedContent) {
    await seedDevContentIfWanted(database);
  }
  return database;
}

/**
 * Seeds the `__DEV__` sample content unless it has been explicitly cleared.
 *
 * The flag lives in the device-local `settings` table, which `clearAllData`
 * leaves alone — so "Clear" in Settings → Developer survives a sign-out, and
 * survives the relaunch that would otherwise seed straight back over it and make
 * the button look broken.
 *
 * Failures are swallowed. This is a convenience for local runs; letting it throw
 * would take the database open down with it and leave the app dead on launch
 * over sample data nobody needs.
 */
async function seedDevContentIfWanted(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const cleared = await database.getFirstAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      [DEV_SEED_CLEARED_FLAG],
    );
    if (cleared) return;
    await runDevSeed(database);
  } catch (e) {
    console.warn('[db] dev seed skipped:', e);
  }
}

/**
 * One-time move of the theme preference from the device-local `settings` table
 * into the synced `user_settings` one, rewriting a retired key on the way
 * through.
 *
 * It has to run before the theme store reads the value, or the first render
 * shows a theme the account has since replaced. Database open is the one point
 * ahead of both that and the first sync pull.
 *
 * Guarded by a flag row rather than by "is the target empty", because the value
 * it writes is a plausible thing for the user to have chosen: re-running it
 * would keep overwriting whatever the account has settled on with whatever this
 * device happened to have before it ever signed in.
 *
 * The row is left `dirty = 1` so the preference reaches the account on the next
 * push — a device that already had a theme keeps it and shares it, rather than
 * appearing to the account as though it never had one.
 *
 * It is written with `updated_at = 0`, and that is the important part. Every
 * conflict in this system is settled by comparing `updated_at`, which is only
 * meaningful because it says when a value was actually chosen. The old
 * device-local `settings` table stored no timestamp, so this migration has none
 * to carry across — and stamping `Date.now()` would assert that a theme picked
 * months ago was picked during this launch. That lie wins races it should lose:
 * a device migrating today would overwrite a deliberate choice another device
 * made last week, and the user would watch it revert with nothing on either
 * screen to explain why. Zero says the honest thing instead — "this preference
 * has no known choice time" — so any real choice on the account outranks it,
 * while it still seeds an account that has no preference at all, and any
 * genuine pick on this device from here on carries a real timestamp and wins
 * normally.
 */
async function migrateThemeSetting(database: SQLite.SQLiteDatabase): Promise<void> {
  const done = await database.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    [THEME_RENAME_FLAG],
  );
  if (done) return;

  const saved = await database.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    [THEME_SETTING_KEY],
  );
  if (saved) {
    // Only seeds a row that isn't there. If one already exists in user_settings
    // it came from the account, which is the more considered value of the two.
    // `updated_at` is 0 rather than now — see above; `created_at` is real, since
    // nothing resolves a conflict with it.
    await database.runAsync(
      `INSERT INTO user_settings (id, value, created_at, updated_at, deleted_at, dirty)
       VALUES (?, ?, ?, 0, NULL, 1)
       ON CONFLICT(id) DO NOTHING`,
      [THEME_SETTING_KEY, migrateThemeKey(saved.value), Date.now()],
    );
    // The old device-local copy is dropped rather than left behind, so there is
    // exactly one answer to "what theme is this?" from here on.
    await database.runAsync('DELETE FROM settings WHERE key = ?', [THEME_SETTING_KEY]);
  }

  await database.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [THEME_RENAME_FLAG, '1'],
  );
}

/**
 * Point a stored theme at one that still exists, for the keys that were retired
 * (see `migrateThemeKey`). Mocha and Solarized Dark were removed; a device
 * sitting on either has a `user_settings` row naming a theme nothing answers to.
 *
 * Needs no flag row. `migrateThemeKey` is idempotent — no value it produces is
 * itself retired — so this is a no-op from the second launch on, and there is
 * nothing a repeat run could undo. That is exactly what the `mocha` ->
 * `midnight` rename could not say for itself while Mocha was still choosable,
 * which is why that one is flag-guarded and this one isn't.
 *
 * `updated_at` is deliberately left where it was. The rewrite doesn't change
 * what the user chose, only what the app has left to call it, so it must not
 * take the timestamp of a fresh decision — that would let a device that happens
 * to launch today outrank a genuine theme change made on another device
 * yesterday. `dirty = 1` still sends the corrected value up, so the account
 * stops carrying a dead name; it just goes up wearing its real age.
 */
async function retireRemovedThemes(database: SQLite.SQLiteDatabase): Promise<void> {
  const row = await database.getFirstAsync<{ value: string }>(
    'SELECT value FROM user_settings WHERE id = ? AND deleted_at IS NULL',
    [THEME_SETTING_KEY],
  );
  if (!row) return;
  const migrated = migrateThemeKey(row.value);
  if (migrated === row.value) return;
  await database.runAsync('UPDATE user_settings SET value = ?, dirty = 1 WHERE id = ?', [
    migrated,
    THEME_SETTING_KEY,
  ]);
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
  // The task-manager subsystem added a folder "kind" marker + opaque config
  // (mirroring notes' plugin columns); backfill on tables created before it.
  if (!has('kind')) {
    await database.execAsync('ALTER TABLE folders ADD COLUMN kind TEXT');
    await database.execAsync('ALTER TABLE folders ADD COLUMN config TEXT');
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
  // Publish-to-website came later. Defaults to 0 so no existing note is
  // retroactively pushed to the public site by the upgrade itself.
  if (!noteCols.includes('published')) {
    await database.execAsync('ALTER TABLE notes ADD COLUMN published INTEGER NOT NULL DEFAULT 0');
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

  // Multi-type issues were added later: an issue can be filed under several
  // issue-type notes. `type_ids` is a JSON array of note ids; an empty array
  // reads as `[note_id]` (see effectiveTypeIds), so old rows need no backfill.
  const issueCols = await colsOf('issues');
  if (!issueCols.includes('type_ids')) {
    await database.execAsync("ALTER TABLE issues ADD COLUMN type_ids TEXT NOT NULL DEFAULT '[]'");
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
    published: !!r.published,
    pluginType: (r.plugin_type ?? undefined) as Note['pluginType'],
    pluginConfig: r.plugin_config ?? undefined,
  };
}

function toFolder(r: FolderRow): Folder {
  return {
    id: r.id,
    name: r.name,
    parentId: r.parent_id,
    favorite: !!r.favorite,
    kind: (r.kind ?? undefined) as Folder['kind'],
    config: r.config ?? undefined,
  };
}

function toIssue(r: IssueRow): Issue {
  let attrs: Issue['attrs'] = {};
  try {
    const parsed = JSON.parse(r.attrs) as unknown;
    if (parsed && typeof parsed === 'object') attrs = parsed as Issue['attrs'];
  } catch {
    // Corrupt/missing JSON → empty attributes rather than a crash.
  }
  let typeIds: string[] = [];
  try {
    const parsed = JSON.parse(r.type_ids) as unknown;
    if (Array.isArray(parsed)) typeIds = parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // Corrupt/missing JSON → empty (reads as [note_id] via effectiveTypeIds).
  }
  return {
    id: r.id,
    noteId: r.note_id,
    typeIds,
    title: r.title,
    description: r.description,
    done: !!r.done,
    attrs,
    ghNumber: r.gh_number ?? undefined,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: ymd(r.updated_at),
  };
}

function toResumeVersion(r: ResumeVersionRow): ResumeVersion {
  return {
    id: r.id,
    noteId: r.note_id,
    label: r.label,
    source: r.source,
    createdAt: r.created_at,
  };
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

  return [...folderEntries, ...noteEntries]
    .filter(worthKeepingInTrash)
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

// ---- Public API (mirrors the data the stores need) ----

export const db = {
  /**
   * Open (and migrate) the database if it isn't already, resolving once it's
   * ready. Throws the "another tab owns the OPFS lock" error on web when this
   * tab can't take the connection — callers that just took DB ownership use it
   * to wait out the previous owner releasing the file (see reopenDbAndRefresh).
   */
  async ensureOpen(): Promise<void> {
    await getDb();
  },

  /** Load everything for the notes/folders/trash store in one shot. */
  async bootstrap(): Promise<BootstrapData> {
    const database = await getDb();
    const [noteRows, folderRows, trash] = await Promise.all([
      database.getAllAsync<NoteRow>(
        // Most-recently-modified first; created_at breaks ties deterministically.
        'SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC',
      ),
      database.getAllAsync<FolderRow>(
        'SELECT * FROM folders WHERE deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC',
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
    patch: Partial<Pick<Note, 'title' | 'body' | 'folderId' | 'favorite' | 'shared' | 'published' | 'pluginConfig'>>,
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
    if (patch.published !== undefined)
      (sets.push('published = ?'), args.push(patch.published ? 1 : 0));
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
    kind,
    config,
  }: {
    id: string;
    parentId: string | null;
    /** Folder kind marker (e.g. 'project') that renders a special view. */
    kind?: string;
    /** Opaque per-kind JSON config (e.g. a project's repo + attribute schema). */
    config?: string;
  }): Promise<void> {
    dbCrumb('createFolder', { id, parentId, kind });
    const database = await getDb();
    const now = Date.now();
    await database.runAsync(
      'INSERT INTO folders (id, name, parent_id, created_at, updated_at, kind, config) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, '', parentId, now, now, kind ?? null, config ?? null],
    );
  },

  async updateFolder(
    id: string,
    patch: Partial<Pick<Folder, 'name' | 'favorite' | 'config'>>,
  ): Promise<void> {
    dbCrumb('updateFolder', { id, fields: Object.keys(patch) });
    const database = await getDb();
    const sets: string[] = [];
    const args: SQLite.SQLiteBindValue[] = [];
    if (patch.name !== undefined) (sets.push('name = ?'), args.push(patch.name));
    if (patch.favorite !== undefined)
      (sets.push('favorite = ?'), args.push(patch.favorite ? 1 : 0));
    // A project's config (repo + attribute schema) is set after creation when the
    // user configures it; it syncs like any other column.
    if (patch.config !== undefined) (sets.push('config = ?'), args.push(patch.config));
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

  /**
   * Soft-delete a folder only if it is still both unnamed and childless, and
   * report whether it went. For the auto-cleanup of folders created and then
   * abandoned without being named — see the screen that calls it.
   *
   * The test and the delete are one method rather than a read in the screen
   * followed by `deleteFolder`, because everything in `WRITE_METHODS` is
   * serialized against every other write but reads are not: between a separate
   * read and delete, a sync pull could land the folder's first note and the
   * delete would take it down with a folder that is no longer empty. Inside one
   * serialized call no other write can interleave.
   *
   * "Childless" counts live rows only — descendants already in the trash don't
   * keep a folder alive, or emptying a folder into the trash would leave the
   * husk behind forever. No cascade is needed for the same reason: a folder with
   * nothing live under it has nothing to take with it.
   */
  async deleteFolderIfEmpty(id: string): Promise<boolean> {
    dbCrumb('deleteFolderIfEmpty', { id });
    const database = await getDb();
    const folder = await database.getFirstAsync<FolderRow>(
      'SELECT * FROM folders WHERE id = ? AND deleted_at IS NULL',
      [id],
    );
    if (!folder || folder.name.trim().length > 0) return false;

    const child = await database.getFirstAsync<{ id: string }>(
      `SELECT id FROM notes WHERE folder_id = ? AND deleted_at IS NULL
       UNION ALL
       SELECT id FROM folders WHERE parent_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [id, id],
    );
    if (child) return false;

    const now = Date.now();
    await database.runAsync(
      'UPDATE folders SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ?',
      [now, now, id],
    );
    return true;
  },

  /**
   * Which plugin surfaces this device already holds data for — note plugin types
   * plus `'project'` for task-manager folders, which are a folder kind rather
   * than a note type.
   *
   * Read-only, and exists for one job: the create-menu plugin toggles default to
   * off, and a device that was already using a plugin before that default
   * existed has no stored preference to fall back on. Asking the data whether a
   * plugin is in use is the only honest way to tell "never chosen" apart from
   * "chosen off". Trashed rows count — a plugin whose only sheet you deleted
   * yesterday is still one you use.
   *
   * Sample content the app placed itself is excluded, by both id prefixes. Use
   * means the user reached for it, and neither the welcome samples nor the dev
   * seed is evidence of that — they are there before anyone has decided
   * anything. Counting them would switch Sheets and Resumes on for every new
   * install, which is not just a wrong default: the welcome sheet's own cells
   * explain how to enable Sheets, and they would be describing a toggle that was
   * already on because the sheet describing it exists.
   */
  async pluginTypesInUse(): Promise<string[]> {
    const database = await getDb();
    const rows = await database.getAllAsync<{ kind: string | null }>(
      // `folders.kind` is qualified because the second branch also *outputs* a
      // column called `kind`; SQLite resolves the WHERE against the table either
      // way, but the unqualified version reads like it filters on the alias.
      `SELECT DISTINCT plugin_type AS kind FROM notes
         WHERE plugin_type IS NOT NULL AND id NOT LIKE ? AND id NOT LIKE ?
       UNION
       SELECT DISTINCT 'project' AS kind FROM folders
         WHERE folders.kind = 'project' AND id NOT LIKE ? AND id NOT LIKE ?`,
      [`${WELCOME_PREFIX}%`, `${DEV_SEED_PREFIX}%`, `${WELCOME_PREFIX}%`, `${DEV_SEED_PREFIX}%`],
    );
    return rows.map((r) => r.kind).filter((k): k is string => !!k);
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
    content = '',
    file,
  }: {
    id: string;
    label?: string;
    /** Rich-text HTML body; seeded when the block is created from a paste. */
    content?: string;
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
        content,
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

  /**
   * Live file blocks whose bytes haven't been uploaded yet (no remote_key).
   *
   * The dev-seed exclusion is here too, and this is the second of exactly two
   * ways anything leaves the device — bytes go straight to S3 (see
   * `lib/sync/files.ts`) rather than through the delta payload, so `getDirty`'s
   * guard doesn't reach them and `dirty` isn't even consulted. The seed writes
   * no copa blocks today, so this excludes nothing yet; it is here so that
   * "seeded rows never leave the device" is true of the codebase rather than
   * true of one table, and so adding a demo attachment later stays a content
   * change instead of quietly becoming an upload to the real bucket.
   */
  async getCopaUploads(): Promise<{ id: string; fileUri: string; mimeType: string | null }[]> {
    const database = await getDb();
    const rows = await database.getAllAsync<{ id: string; file_uri: string; mime_type: string | null }>(
      `SELECT id, file_uri, mime_type FROM copa_items
       WHERE file_uri IS NOT NULL AND remote_key IS NULL AND deleted_at IS NULL
         AND id NOT LIKE ?`,
      [`${DEV_SEED_PREFIX}%`],
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

  // ---- Issues (task-manager project rows) ----

  /** Every live issue across all projects, ordered for stable rendering. */
  async getIssues(): Promise<Issue[]> {
    const database = await getDb();
    const rows = await database.getAllAsync<IssueRow>(
      'SELECT * FROM issues WHERE deleted_at IS NULL ORDER BY position ASC, created_at ASC',
    );
    return rows.map(toIssue);
  },

  async createIssue({
    id,
    noteId,
    typeIds,
    title,
    description,
    attrs,
    ghNumber,
    position,
  }: {
    id: string;
    noteId: string;
    typeIds?: string[];
    title?: string;
    description?: string;
    attrs?: Issue['attrs'];
    ghNumber?: number;
    position?: number;
  }): Promise<void> {
    dbCrumb('createIssue', { id, noteId });
    const database = await getDb();
    const now = Date.now();
    await database.runAsync(
      `INSERT INTO issues
         (id, note_id, type_ids, title, description, done, attrs, gh_number, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [
        id,
        noteId,
        JSON.stringify(typeIds ?? (noteId ? [noteId] : [])),
        title ?? '',
        description ?? '',
        JSON.stringify(attrs ?? {}),
        ghNumber ?? null,
        position ?? 0,
        now,
        now,
      ],
    );
  },

  async updateIssue(
    id: string,
    patch: {
      title?: string;
      description?: string;
      noteId?: string;
      typeIds?: string[];
      done?: boolean;
      attrs?: Issue['attrs'];
      ghNumber?: number | null;
      position?: number;
    },
  ): Promise<void> {
    dbCrumb('updateIssue', { id, fields: Object.keys(patch) });
    const database = await getDb();
    const sets: string[] = [];
    const args: SQLite.SQLiteBindValue[] = [];
    if (patch.title !== undefined) (sets.push('title = ?'), args.push(patch.title));
    if (patch.description !== undefined) (sets.push('description = ?'), args.push(patch.description));
    if (patch.noteId !== undefined) (sets.push('note_id = ?'), args.push(patch.noteId));
    if (patch.typeIds !== undefined)
      (sets.push('type_ids = ?'), args.push(JSON.stringify(patch.typeIds)));
    if (patch.done !== undefined) (sets.push('done = ?'), args.push(patch.done ? 1 : 0));
    if (patch.attrs !== undefined) (sets.push('attrs = ?'), args.push(JSON.stringify(patch.attrs)));
    if (patch.ghNumber !== undefined) (sets.push('gh_number = ?'), args.push(patch.ghNumber));
    if (patch.position !== undefined) (sets.push('position = ?'), args.push(patch.position));
    if (sets.length === 0) return;
    sets.push('updated_at = ?', 'dirty = 1');
    args.push(Date.now());
    args.push(id);
    await database.runAsync(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`, args);
  },

  async deleteIssue(id: string): Promise<void> {
    dbCrumb('deleteIssue', { id });
    const database = await getDb();
    const now = Date.now();
    await database.runAsync(
      'UPDATE issues SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ?',
      [now, now, id],
    );
  },

  // ---- Finance sheets ----

  /**
   * A finance note's stored sheet JSON, or null when it has none yet (the note
   * was created but never opened, or its row hasn't pulled down on this device).
   * Callers hand the result straight to `parseSheet`, which treats null and
   * malformed JSON alike as an empty sheet.
   */
  async getFinanceSheet(noteId: string): Promise<string | null> {
    const database = await getDb();
    const row = await database.getFirstAsync<{ data: string }>(
      'SELECT data FROM finance_sheets WHERE id = ? AND deleted_at IS NULL',
      [noteId],
    );
    return row?.data ?? null;
  },

  /**
   * Writes the whole sheet document. One row, one upsert — the reason a bulk
   * format across a drag-selected range costs the same to sync as a single
   * keystroke. `updated_at` drives last-writer-wins on both push and pull, so it
   * always advances.
   */
  async saveFinanceSheet(noteId: string, data: string): Promise<void> {
    const database = await getDb();
    const now = Date.now();
    await database.runAsync(
      `INSERT INTO finance_sheets (id, data, created_at, updated_at, dirty)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data, updated_at = excluded.updated_at,
         -- Re-saving a sheet whose note was restored from trash revives it.
         deleted_at = NULL, dirty = 1`,
      [noteId, data, now, now],
    );
  },

  /**
   * Tombstones a note's sheet. Soft-deleted rather than removed so the delete
   * propagates to other devices; a hard delete would let a device that hadn't
   * pulled yet push the sheet straight back.
   */
  async deleteFinanceSheet(noteId: string): Promise<void> {
    const database = await getDb();
    const now = Date.now();
    await database.runAsync(
      'UPDATE finance_sheets SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ?',
      [now, now, noteId],
    );
  },

  // ---- Resume version history ----

  /**
   * Every snapshot for one resume, newest first.
   *
   * `created_at DESC, id DESC` rather than `updated_at`: the version you are on
   * has its `updated_at` bumped on every keystroke, so ordering by it would make
   * the list reshuffle under you as you type. `id` breaks ties deterministically
   * so two snapshots written in the same millisecond don't swap between reads.
   */
  async listResumeVersions(noteId: string): Promise<ResumeVersion[]> {
    const database = await getDb();
    const rows = await database.getAllAsync<ResumeVersionRow>(
      `SELECT * FROM resume_versions
       WHERE note_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC`,
      [noteId],
    );
    return rows.map(toResumeVersion);
  },

  /**
   * Append one snapshot. The only way a *new* version row is written — nothing
   * reorders the history, and `label` and `created_at` are settled here for good.
   * `source` is not: see `updateResumeVersion` for the one row that keeps moving.
   */
  async createResumeVersion({
    id,
    noteId,
    label,
    source,
    createdAt,
  }: {
    id: string;
    noteId: string;
    label: string;
    source: string;
    /** Overridable so a caller can order two snapshots written in one action. */
    createdAt?: number;
  }): Promise<void> {
    dbCrumb('createResumeVersion', { id, noteId });
    const database = await getDb();
    const now = createdAt ?? Date.now();
    await database.runAsync(
      `INSERT INTO resume_versions (id, note_id, label, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, noteId, label, source, now, now],
    );
  },

  /**
   * Replace a version's text with what the document says now.
   *
   * A version is the document you are currently working *in*, not a photograph of
   * one — the resume screen keeps whichever version is current in step with the
   * editor as you type. So switching to an older version and back finds your
   * typing where you left it, and leaving a version never silently discards what
   * you had done to it.
   *
   * The cost is that this one row is last-writer-wins like a note body: two
   * devices offline on the same version keep only the later save. Versions
   * nobody is on are never written again and cannot conflict at all.
   *
   * The label is not touched. It says what this version *is* — "Tailored for
   * Acme" — and that stays true however much you refine it afterwards.
   */
  async updateResumeVersion(id: string, source: string): Promise<void> {
    dbCrumb('updateResumeVersion', { id });
    const database = await getDb();
    await database.runAsync(
      'UPDATE resume_versions SET source = ?, updated_at = ?, dirty = 1 WHERE id = ?',
      [source, Date.now(), id],
    );
  },

  /** Soft-delete a version, so the removal reaches other devices. */
  async deleteResumeVersion(id: string): Promise<void> {
    dbCrumb('deleteResumeVersion', { id });
    const database = await getDb();
    const now = Date.now();
    // Soft, and `updated_at` bumped with it: a hard DELETE would be invisible to
    // the server and the row would come back on the next pull.
    await database.runAsync(
      'UPDATE resume_versions SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ?',
      [now, now, id],
    );
  },

  // ---- Sync support ----

  /**
   * All rows with un-pushed local changes, in the backend's wire shape.
   *
   * Every query also excludes the dev-seed id prefix, and this is the one place
   * that keeps `__DEV__` sample content off the network. It is deliberately here
   * rather than at the places that *set* `dirty`, because there are many of
   * those and they are all reachable: the column defaults to 1, every per-row
   * mutator sets it, `markAllDirty` sets it in bulk on first sign-in, and sync
   * fires on app foreground whether or not anyone has signed in. This query is
   * the only thing that turns a dirty row into a request body, so a row filtered
   * out here cannot leave the device by any route — including one added later by
   * someone who has never heard of the seed.
   *
   * The predicate is not compiled out of release builds. It costs an index-free
   * `NOT LIKE` on an already-tiny result set, and a prefix that can never occur
   * in real data (ids are `<kind>-<timestamp>-<random>`) is a cheaper thing to
   * carry than a branch that makes the two builds push different rows.
   */
  async getDirty(): Promise<SyncPayload> {
    const database = await getDb();
    const skipSeed = `${DEV_SEED_PREFIX}%`;
    const [folders, notes, copa_items, issues, finance_sheets, resume_versions, user_settings] =
      await Promise.all([
      database.getAllAsync<FolderSync>(
        `SELECT id, name, parent_id, favorite, created_at, updated_at, deleted_at,
                trashed_with_folder_id, kind, config
         FROM folders WHERE dirty = 1 AND id NOT LIKE ?`,
        [skipSeed],
      ),
      database.getAllAsync<NoteSync>(
        `SELECT id, title, body, folder_id, favorite, shared, published, created_at, updated_at,
                deleted_at, trashed_with_folder_id, plugin_type, plugin_config
         FROM notes WHERE dirty = 1 AND id NOT LIKE ?`,
        [skipSeed],
      ),
      database.getAllAsync<CopaSync>(
        `SELECT id, label, content, favorite, created_at, updated_at, deleted_at,
                file_name, mime_type, file_size, remote_key
         FROM copa_items WHERE dirty = 1 AND id NOT LIKE ?`,
        [skipSeed],
      ),
      database.getAllAsync<IssueSync>(
        `SELECT id, note_id, type_ids, title, description, done, attrs, gh_number, position,
                created_at, updated_at, deleted_at
         FROM issues WHERE dirty = 1 AND id NOT LIKE ?`,
        [skipSeed],
      ),
      database.getAllAsync<FinanceSheetSync>(
        // A sheet's row id *is* its note's id, so the note's prefix covers it.
        `SELECT id, data, created_at, updated_at, deleted_at
         FROM finance_sheets WHERE dirty = 1 AND id NOT LIKE ?`,
        [skipSeed],
      ),
      database.getAllAsync<ResumeVersionSync>(
        // Filtered on `note_id`, not on the version's own id — the one query
        // here that can't use the row's own key. A version is never seeded: it
        // is written by the app, by `vid()`, as `ver-<timestamp>-<random>`, so
        // it never carries the prefix no matter which resume it belongs to.
        // Matching on `id` therefore excluded nothing at all, while looking
        // exactly like a guard. And this is not hypothetical: opening the
        // seeded resume compiles it, and the first successful compile snapshots
        // the source as its original version (`recordFirstCompile` in
        // `app/(home)/resume/[id].tsx`). That row is dirty by schema default, so
        // it would have pushed the sample LaTeX to the account — an orphan, its
        // parent note correctly held back, and unreachable by "Clear" afterwards
        // since a hard delete sends no tombstone.
        `SELECT id, note_id, label, source, created_at, updated_at, deleted_at
         FROM resume_versions WHERE dirty = 1 AND note_id NOT LIKE ?`,
        [skipSeed],
      ),
      database.getAllAsync<UserSettingSync>(
        `SELECT id, value, created_at, updated_at, deleted_at
         FROM user_settings WHERE dirty = 1 AND id NOT LIKE ?`,
        [skipSeed],
      ),
    ]);
    return { folders, notes, copa_items, issues, finance_sheets, resume_versions, user_settings };
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
      for (const i of payload.issues) {
        await database.runAsync('UPDATE issues SET dirty = 0 WHERE id = ? AND updated_at = ?', [
          i.id,
          i.updated_at,
        ]);
      }
      for (const s of payload.finance_sheets ?? []) {
        await database.runAsync(
          'UPDATE finance_sheets SET dirty = 0 WHERE id = ? AND updated_at = ?',
          [s.id, s.updated_at],
        );
      }
      for (const v of payload.resume_versions ?? []) {
        await database.runAsync(
          'UPDATE resume_versions SET dirty = 0 WHERE id = ? AND updated_at = ?',
          [v.id, v.updated_at],
        );
      }
      for (const s of payload.user_settings ?? []) {
        await database.runAsync(
          'UPDATE user_settings SET dirty = 0 WHERE id = ? AND updated_at = ?',
          [s.id, s.updated_at],
        );
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
              trashed_with_folder_id, kind, config, dirty)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, parent_id = excluded.parent_id,
             favorite = excluded.favorite, created_at = excluded.created_at,
             updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
             trashed_with_folder_id = excluded.trashed_with_folder_id,
             kind = excluded.kind, config = excluded.config, dirty = 0
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
            f.kind ?? null,
            f.config ?? null,
          ],
        );
        changed += r.changes;
      }
      for (const n of payload.notes) {
        const r = await database.runAsync(
          `INSERT INTO notes
             (id, title, body, folder_id, favorite, shared, published, created_at, updated_at,
              deleted_at, trashed_with_folder_id, plugin_type, plugin_config, dirty)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, body = excluded.body, folder_id = excluded.folder_id,
             favorite = excluded.favorite, shared = excluded.shared,
             published = excluded.published,
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
            // A backend row that never carried the flag arrives as null, which
            // means exactly "not published" — the local column is NOT NULL, so
            // it lands as 0. (Preserving an unknown value matters on *push*,
            // where the server COALESCEs; on pull the server is authoritative.)
            bit(n.published ?? 0),
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
      for (const i of payload.issues) {
        const r = await database.runAsync(
          `INSERT INTO issues
             (id, note_id, type_ids, title, description, done, attrs, gh_number, position,
              created_at, updated_at, deleted_at, dirty)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET
             note_id = excluded.note_id,
             -- An older client that predates multi-type can't send type_ids
             -- (arrives NULL); keep the stored value rather than wiping it.
             type_ids = COALESCE(excluded.type_ids, issues.type_ids),
             title = excluded.title,
             description = excluded.description, done = excluded.done,
             attrs = excluded.attrs, gh_number = excluded.gh_number,
             position = excluded.position, created_at = excluded.created_at,
             updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, dirty = 0
           WHERE excluded.updated_at >= issues.updated_at`,
          [
            i.id,
            i.note_id,
            i.type_ids ?? '[]',
            i.title,
            i.description,
            bit(i.done),
            i.attrs,
            i.gh_number,
            i.position,
            i.created_at,
            i.updated_at,
            i.deleted_at,
          ],
        );
        changed += r.changes;
      }
      // A backend that predates this table omits the field entirely. Defaulting
      // to [] keeps an old server from throwing here and taking down the whole
      // sync pass — folders and notes must still apply.
      for (const s of payload.finance_sheets ?? []) {
        const r = await database.runAsync(
          `INSERT INTO finance_sheets
             (id, data, created_at, updated_at, deleted_at, dirty)
           VALUES (?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET
             data = excluded.data, created_at = excluded.created_at,
             updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, dirty = 0
           WHERE excluded.updated_at >= finance_sheets.updated_at`,
          [s.id, s.data, s.created_at, s.updated_at, s.deleted_at],
        );
        changed += r.changes;
      }
      // `?? []` for the same reason as the sheets above, and it matters most on
      // exactly this table: it is the newest, so it is the one a client can have
      // while the server it is talking to does not.
      for (const v of payload.resume_versions ?? []) {
        // Same last-writer-wins guard as every other table. It is close to
        // decorative for a finished version — nothing rewrites one, so the only
        // row that conflicts with an incoming one is a byte-identical copy of
        // itself, from a re-push after a dropped response, and `>=` rather than
        // `>` is what makes that resend harmless. It does real work for the
        // version a device is currently on, whose source moves as the user types.
        const r = await database.runAsync(
          `INSERT INTO resume_versions
             (id, note_id, label, source, created_at, updated_at, deleted_at, dirty)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET
             note_id = excluded.note_id, label = excluded.label,
             source = excluded.source, created_at = excluded.created_at,
             updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, dirty = 0
           WHERE excluded.updated_at >= resume_versions.updated_at`,
          [
            v.id,
            v.note_id,
            v.label,
            v.source,
            v.created_at,
            v.updated_at,
            v.deleted_at,
          ],
        );
        changed += r.changes;
      }
      // `?? []` as above — this is now the newest table, so it is the one a
      // client is most likely to have while the server it is talking to doesn't.
      for (const s of payload.user_settings ?? []) {
        const r = await database.runAsync(
          `INSERT INTO user_settings
             (id, value, created_at, updated_at, deleted_at, dirty)
           VALUES (?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET
             value = excluded.value, created_at = excluded.created_at,
             updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, dirty = 0
           WHERE excluded.updated_at >= user_settings.updated_at`,
          [s.id, s.value, s.created_at, s.updated_at, s.deleted_at],
        );
        changed += r.changes;
      }
    });
    return changed;
  },

  /**
   * Marks every row dirty so the next sync re-pushes the whole local dataset.
   * Used on first sign-in to claim anonymous notes into the account.
   *
   * `user_settings` is in the list on purpose, even though a preference is a
   * singleton where a note is not. It means an anonymous device's theme is
   * claimed the same way its notes are, and the server's `updated_at` guard then
   * settles it: the more recently chosen value wins, whichever side it came
   * from. Holding preferences back instead would make first sign-in the one
   * moment in the app where a local change is silently discarded, and a theme
   * picked five minutes ago is a better guess at what someone wants than one
   * picked on another device last year.
   */
  async markAllDirty(): Promise<void> {
    const database = await getDb();
    // Every synced table has to be listed. A table missing here keeps its rows
    // clean, so signing in never claims them into the account and they stay
    // local to this one device for ever, with nothing on screen to say so.
    await database.execAsync(
      'UPDATE folders SET dirty = 1; UPDATE notes SET dirty = 1; UPDATE copa_items SET dirty = 1; UPDATE issues SET dirty = 1; UPDATE finance_sheets SET dirty = 1; UPDATE resume_versions SET dirty = 1; UPDATE user_settings SET dirty = 1;',
    );
  },

  /**
   * Removes every synced row — including account-scoped preferences, and still
   * excluding the device-local `settings` table. Used on sign-out and when
   * switching accounts, so one account's data never bleeds into another on the
   * same device. The cursor is reset separately by the caller.
   *
   * Preferences have to go with the notes now that they are account-scoped: left
   * behind, the next person to sign in on this device would be looking at the
   * previous account's theme with no way to tell where it came from. What stays
   * is `settings`, which holds the device key, the sync cursor and `synced_uid`
   * — facts about the device, which signing out does not change.
   */
  async clearAllData(): Promise<void> {
    const database = await getDb();
    // As with `markAllDirty`, a table missing here is a silent leak: the
    // previous account's rows survive sign-out and show up under whoever signs
    // in next on this device.
    await database.execAsync(
      'DELETE FROM folders; DELETE FROM notes; DELETE FROM copa_items; DELETE FROM issues; DELETE FROM finance_sheets; DELETE FROM resume_versions; DELETE FROM user_settings;',
    );
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

  /**
   * Read an account-scoped preference (null if unset or soft-deleted).
   *
   * The `deleted_at IS NULL` filter is what makes "unset" survive a round trip:
   * a preference cleared on another device arrives as a tombstone rather than a
   * missing row, and without the filter the caller would read the dead value.
   */
  async getUserSetting(key: string): Promise<string | null> {
    const database = await getDb();
    const row = await database.getFirstAsync<{ value: string }>(
      'SELECT value FROM user_settings WHERE id = ? AND deleted_at IS NULL',
      [key],
    );
    return row?.value ?? null;
  },

  /**
   * Upsert an account-scoped preference and queue it for the next push.
   *
   * `updated_at` is stamped here because it is what every conflict between two
   * devices is decided on, server-side and locally — a write that left it alone
   * would be quietly unable to win one. `deleted_at` is cleared so re-setting a
   * preference someone deleted elsewhere brings it back rather than writing a
   * value that `getUserSetting` then refuses to read.
   */
  async setUserSetting(key: string, value: string): Promise<void> {
    dbCrumb('setUserSetting', { key });
    const database = await getDb();
    const now = Date.now();
    await database.runAsync(
      `INSERT INTO user_settings (id, value, created_at, updated_at, deleted_at, dirty)
       VALUES (?, ?, ?, ?, NULL, 1)
       ON CONFLICT(id) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at,
         deleted_at = NULL, dirty = 1`,
      [key, value, now, now],
    );
  },

  // ---- Dev sample content ----
  //
  // Exposed on `db` (rather than called straight from the screen) so the writes
  // go through the same serialization chain as everything else — unlike the
  // launch seed, these run with the app up and a sync possibly mid-flight.

  /**
   * Inserts the sample content now, and re-arms the launch seed if it had been
   * cleared. Existing rows are left as they are, so this restores what's missing
   * rather than resetting what you've been editing.
   */
  async seedDevContent(): Promise<void> {
    const database = await getDb();
    await database.runAsync('DELETE FROM settings WHERE key = ?', [DEV_SEED_CLEARED_FLAG]);
    await runDevSeed(database);
  },

  /** Removes the sample content and stops the next launch from seeding it back. */
  async clearDevContent(): Promise<void> {
    const database = await getDb();
    await clearDevSeed(database);
    await database.runAsync(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [DEV_SEED_CLEARED_FLAG, '1'],
    );
  },
};

// ---- Write serialization ----
//
// expo-sqlite's `withTransactionAsync` is NOT exclusive: the v56 docs state it
// "is not exclusive and can be interrupted by other async queries." We hold one
// shared connection, so when two mutations overlap — e.g. a background sync's
// `applyServerRows` transaction running while the user's `deleteFolder`
// transaction is mid-flight — their BEGIN/COMMIT/ROLLBACK statements interleave.
// The classic symptom is `cannot rollback - no transaction is active`, and the
// losing transaction is silently abandoned (the delete that "won't stick").
//
// Fix: funnel every mutating method through a single promise chain so at most
// one write (transactional or single-statement) is ever in flight. Reads are
// left untouched — WAL allows readers alongside the one writer, so query
// concurrency and startup latency are unaffected.
let writeTail: Promise<unknown> = Promise.resolve();

function serializeWrite<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args: A): Promise<R> => {
    // Chain onto the tail regardless of whether the previous write resolved or
    // rejected, so one failed write can't wedge the whole queue.
    const run = writeTail.then(
      () => fn(...args),
      () => fn(...args),
    );
    writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

// Every method that mutates the database. Reads (bootstrap, list*, get*) are
// deliberately excluded so they keep running concurrently. None of these call
// another db method internally, so wrapping them can't self-deadlock the chain.
const WRITE_METHODS = [
  'createNote',
  'updateNote',
  'deleteNote',
  'createFolder',
  'updateFolder',
  'deleteFolder',
  'deleteFolderIfEmpty',
  'restoreFromTrash',
  'createCopa',
  'updateCopa',
  'deleteCopa',
  'setCopaRemoteKey',
  'setCopaLocalFile',
  'createIssue',
  'updateIssue',
  'deleteIssue',
  'saveFinanceSheet',
  'deleteFinanceSheet',
  'createResumeVersion',
  'updateResumeVersion',
  'deleteResumeVersion',
  'markSynced',
  'applyServerRows',
  'markAllDirty',
  'clearAllData',
  'setCursor',
  'setSetting',
  'setUserSetting',
  'seedDevContent',
  'clearDevContent',
] as const;

for (const name of WRITE_METHODS) {
  const methods = db as Record<string, (...args: unknown[]) => Promise<unknown>>;
  methods[name] = serializeWrite(methods[name].bind(db));
}
