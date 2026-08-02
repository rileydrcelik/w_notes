import type * as SQLite from 'expo-sqlite';

import { emptySheet, serializeSheet, setCellRaw, type Sheet } from '@/lib/finance/sheet';
import { STARTER_RESUME } from '@/lib/resume-note';

/**
 * What a brand-new library starts with: a guide to the app, and a folder holding
 * one sheet and one resume so the two plugin surfaces can be seen before they
 * are switched on.
 *
 * Unlike `lib/dev-seed.ts`, this is **real content**. It ships, it is the user's
 * to keep or throw away, and it syncs to their account like anything else they
 * write. That is the whole reason the rules below are strict: content that
 * writes itself into a database is one mistake away from writing itself into a
 * database that already had something in it.
 *
 * **It runs once, on an empty library.** Guarded by a device-local flag *and* by
 * the content tables being empty — counting soft-deleted rows, so someone who
 * threw all of this away is not "new" and does not get it back. The emptiness
 * check is what protects existing users on the build that introduces this: their
 * flag is unset too, and the flag alone would hand them a welcome note after two
 * years. The flag is written in the same transaction as the rows, last, so a
 * failed insert leaves the device eligible to try again rather than marked as
 * done with nothing to show for it.
 *
 * It is once per *device*, not per account: the flag lives in the device-local
 * `settings` table, which `clearAllData()` deliberately leaves alone, so signing
 * out and back in doesn't re-place it. A second device does place its own copy —
 * which is what the stable ids are for, since the two converge server-side
 * instead of doubling up.
 *
 * **It is dated when it was written, not when it was installed.** Every conflict
 * in this system is settled by comparing `updated_at`, so a fresh install that
 * seeds and then signs into an account which already threw this content away
 * would otherwise resurrect it — the classic deleted-note-comes-back bug. A
 * fixed past timestamp loses that race by construction, while a real edit or
 * delete on any device always outranks it. It is a real date rather than 0
 * because cards show it (`ymd(updated_at)`), and a note stamped 1970 reads as
 * broken rather than as new.
 *
 * **Its ids are stable**, so two devices that both seed converge on one copy
 * through the server's `(user_id, id)` upsert instead of duplicating.
 */

/**
 * Id prefix for everything this module writes.
 *
 * Load-bearing beyond identification: `db.pluginTypesInUse()` ignores it. That
 * query grandfathers a plugin toggle on for anyone already using the plugin, and
 * a sample the app placed is not evidence of use — without the exclusion,
 * shipping a sample sheet would switch Sheets on for everyone and make the
 * sample's own instructions for enabling it a lie.
 */
export const WELCOME_PREFIX = 'welcome-';

/** Device-local flag marking that the welcome content has been placed. */
export const WELCOME_SEEDED_FLAG = 'welcome_seeded';

/**
 * When this content was written, not when it was installed. See the module note
 * — this is the timestamp every future edit and deletion has to beat, and it is
 * meant to lose.
 */
const AUTHORED_AT = Date.UTC(2026, 7, 2);

export const WELCOME_NOTE_ID = 'welcome-note-guide';
export const WELCOME_FOLDER_ID = 'welcome-folder-samples';
export const WELCOME_SHEET_ID = 'welcome-note-sheet';
export const WELCOME_RESUME_ID = 'welcome-note-resume';

const p = (...paragraphs: string[]) => paragraphs.map((t) => `<p>${t}</p>`).join('');
const h = (text: string) => `<h2>${text}</h2>`;
const ul = (...items: string[]) => `<ul>${items.map((t) => `<li>${t}</li>`).join('')}</ul>`;

/**
 * The guide. Written as the app's own rich-text HTML, so it is an ordinary note
 * the reader can edit, gut or delete like any other.
 */
export const GUIDE_BODY =
  p('Everything here is yours and lives on this device first. Signing in adds an account and keeps it in step across your devices — nothing needs a connection to work.') +
  h('Making things') +
  p('The <strong>+</strong> button in the bar at the bottom is the one control that changes with where you are.') +
  ul(
    'Tap it on the home screen or in a folder to start a note straight away.',
    '<strong>Press and hold it</strong> — or right-click, on a computer — for the full menu: a new note, a new folder, and any plugins you have turned on.',
  ) +
  h('Editing') +
  p('There is no edit button and no preview switch. Tap the words to start writing; the <strong>+</strong> turns into a check while you type, and pressing it puts the note back to how it reads.') +
  p('Inside a note there is nothing to create, so the same button offers a <strong>pencil</strong> instead. Holding it still opens the create menu.') +
  h('Keeping track') +
  ul(
    'Star anything to keep it near the top.',
    'Search sits above each list and filters what you are looking at.',
    'Deleting moves things to Trash, where they can be brought back.',
    'While you are reading a note, a download icon appears in the bar to save it.',
  ) +
  h('Plugins') +
  p('A sheet, a resume, a task manager, and live views of Sentry issues or a GitHub repo. They are all off to begin with, so the create menu stays short until you want more from it.') +
  p('Turn one on in <strong>Settings → Plugins</strong>, and it joins the menu you get by holding the <strong>+</strong> button.') +
  p('The <strong>Samples</strong> folder has a sheet and a resume in it already, so you can see what they are before deciding.') +
  h('Syncing') +
  p('<strong>Settings → Account</strong> signs you in with Google or Apple. Anything you have already written is claimed into the account rather than replaced.');

/**
 * The sample sheet: a small working total, plus the two lines that say how to
 * make another one. The instructions live in cells because a sheet has no body
 * to put them in — the note's `body` column is empty for a finance note, its
 * document being a row in `finance_sheets`.
 */
export function welcomeSheet(): string {
  const rows: string[][] = [
    ['This is a sheet.'],
    ['Tap a cell and type. Start with = to make it a formula.'],
    [],
    ['Item', 'Qty', 'Price', 'Total'],
    ['Coffee', '2', '4.50', '=B5*C5'],
    ['Beans', '1', '12', '=B6*C6'],
    ['', '', 'Total', '=SUM(D5:D6)'],
    [],
    ['To make your own:'],
    ['1. Settings → Plugins → Sheets'],
    ['2. Press and hold the + button (right-click on a computer)'],
    ['3. Pick “New sheet”'],
  ];

  let sheet: Sheet = emptySheet();
  rows.forEach((cols, row) => {
    cols.forEach((raw, col) => {
      if (raw) sheet = setCellRaw(sheet, row, col, raw);
    });
  });
  return serializeSheet(sheet);
}

/**
 * The sample resume: the ordinary starter document, with the how-to as LaTeX
 * comments at the top.
 *
 * Comments rather than rendered text on purpose. The resume screen opens into
 * its source rather than a read view, so this is the first thing on screen —
 * and it stays out of the compiled PDF, leaving the sample looking like the
 * resume it is meant to demonstrate.
 */
export const WELCOME_RESUME_SOURCE = `% This is a resume. The whole document is LaTeX source, and it compiles to a
% PDF you can save from the download icon in the bar.
%
% Edit it, or clear it out and paste your own template over the top.
%
% To make another one:
%   1. Settings -> Plugins -> Resumes
%   2. Press and hold the + button (right-click on a computer)
%   3. Pick "New resume"

${STARTER_RESUME}`;

/**
 * Places the welcome content, if this library has never held anything.
 *
 * Returns whether it wrote anything, so the caller can tell "seeded" from
 * "declined" without a second read.
 *
 * Takes the database handle rather than calling `getDb()` because it runs from
 * `open()` itself, mid-open — which is also why it needs no write-serialization:
 * the connection has not been handed out yet.
 */
export async function runWelcomeSeed(database: SQLite.SQLiteDatabase): Promise<boolean> {
  const done = await database.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    [WELCOME_SEEDED_FLAG],
  );
  if (done) return false;

  // Deliberately counts soft-deleted rows. A tombstone is the record of
  // something the user threw away, which makes this library used rather than
  // new — and re-seeding on top of one is exactly how deleted content comes
  // back. The same check is what keeps an existing user, upgrading onto the
  // build that adds this, from being handed a welcome note years late.
  //
  // `copa_items` counts too, and it is the only other table that has to: a copa
  // block needs no note or folder to exist, so someone who has only ever used
  // that tab reads as a brand-new library through `notes` and `folders` alone.
  // Issues, sheets and resume versions all hang off a note, so a non-empty one
  // of those implies a non-empty `notes`.
  const existing = await database.getFirstAsync<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM notes)
          + (SELECT COUNT(*) FROM folders)
          + (SELECT COUNT(*) FROM copa_items) AS n`,
  );

  if ((existing?.n ?? 0) > 0) {
    // Used, so this library never gets the content — and that decision is
    // recorded, rather than re-taken on every launch.
    await markSeeded(database);
    return false;
  }

  await database.withTransactionAsync(async () => {
    await database.runAsync(
      `INSERT INTO folders (id, name, parent_id, created_at, updated_at, dirty)
       VALUES (?, ?, NULL, ?, ?, 1)
       ON CONFLICT(id) DO NOTHING`,
      [WELCOME_FOLDER_ID, 'Samples', AUTHORED_AT, AUTHORED_AT],
    );

    const notes: [string, string, string, string | null, string | null][] = [
      [WELCOME_NOTE_ID, 'Welcome to w_notes', GUIDE_BODY, null, null],
      [WELCOME_SHEET_ID, 'Sample sheet', '', WELCOME_FOLDER_ID, 'finance'],
      [WELCOME_RESUME_ID, 'Sample resume', WELCOME_RESUME_SOURCE, WELCOME_FOLDER_ID, 'resume'],
    ];
    for (const [id, title, body, folderId, pluginType] of notes) {
      await database.runAsync(
        `INSERT INTO notes
           (id, title, body, folder_id, created_at, updated_at, plugin_type, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(id) DO NOTHING`,
        [id, title, body, folderId, AUTHORED_AT, AUTHORED_AT, pluginType],
      );
    }

    await database.runAsync(
      `INSERT INTO finance_sheets (id, data, created_at, updated_at, dirty)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(id) DO NOTHING`,
      [WELCOME_SHEET_ID, welcomeSheet(), AUTHORED_AT, AUTHORED_AT],
    );

    // Last, and inside the transaction with the rows it describes. Written
    // ahead of them — or outside — a failed insert would leave the device
    // permanently marked as seeded with nothing in it, and the emptiness check
    // that would otherwise make it eligible to try again next launch is exactly
    // what the flag defeats. Either both land or neither does.
    await markSeeded(database);
  });

  return true;
}

/** Records that this device has had its answer about the welcome content. */
async function markSeeded(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [WELCOME_SEEDED_FLAG, '1'],
  );
}
