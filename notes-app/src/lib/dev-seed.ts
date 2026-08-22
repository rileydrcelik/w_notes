import type * as SQLite from 'expo-sqlite';

import { emptySheet, serializeSheet, setCellRaw, type Sheet } from '@/lib/finance/sheet';
import { STARTER_RESUME } from '@/lib/resume-note';

/**
 * Development-only sample content: a couple of dozen notes, a nested folder
 * tree, a finance sheet and a resume, written straight into SQLite so a local
 * run always has something on screen.
 *
 * Three properties make this safe to run unconditionally at every dev launch:
 *
 *  - **Structurally unpushable.** Two queries in `db.ts` decide what leaves this
 *    device, and both exclude this id prefix: `getDirty()`, which builds the
 *    delta payload, and `getCopaUploads()`, which lists file bytes bound for S3
 *    outside that payload entirely. Those are the right places for the guard
 *    rather than `markAllDirty`, because `dirty` is not something the seed
 *    controls once the rows exist. It defaults to *1* at the schema level, every
 *    per-row mutator sets it, first sign-in sets it in bulk to claim anonymous
 *    data, and sync runs on app foreground without waiting for a sign-in at all.
 *    Guarding the two queries that decide what goes out covers all of that,
 *    including mutators nobody has written yet.
 *
 *    One of those exclusions matches on a *parent* id rather than the row's own:
 *    a `resume_versions` row is written by the app, never seeded, so it never
 *    carries the prefix. Filtering it by `note_id` is what actually holds — and
 *    it has to, because opening the seeded resume compiles it and the first
 *    compile snapshots a version unprompted.
 *  - **Clean on arrival.** Rows are still inserted `dirty = 0` explicitly, so
 *    they don't sit permanently pending behind the filter. Explicitly, because
 *    the column defaults to 1 — a device that predates sync has to upload what
 *    it already had — so an insert that simply omits it seeds 24 pending rows.
 *  - **Idempotent.** Ids are stable and every insert is `ON CONFLICT DO
 *    NOTHING`, so a second run changes nothing — including a seeded note the
 *    user has since edited, renamed or thrown away.
 *
 * A seeded note is fully editable, and an edit dirties it like any other note;
 * it simply never leaves the device. Sample content that quietly turned real
 * the moment someone typed in it would be the surprise, not the other way round.
 *
 * `db.clearAllData()` (sign-out, account switch) wipes these rows along with
 * everything else. The next launch re-seeds them, and Settings → Developer
 * seeds on demand if you'd rather not relaunch.
 */

/**
 * Id prefix for everything this module writes. Real ids are
 * `note-<timestamp>-<random>` (see `rid` in the stores), so nothing the app
 * creates can collide with it.
 */
export const DEV_SEED_PREFIX = 'dev-seed-';

/**
 * Device-local flag set by "Clear" in Settings → Developer. Without it the next
 * launch would seed straight back over the clear, making the button a no-op
 * that looks like it worked until you relaunch.
 */
export const DEV_SEED_CLEARED_FLAG = 'dev_seed_cleared';

const DAY = 24 * 60 * 60 * 1000;

type SeedFolder = {
  id: string;
  name: string;
  parentId: string | null;
  favorite?: boolean;
  /** How long ago the folder was "last touched", in days — drives ordering. */
  age: number;
};

type SeedNote = {
  id: string;
  title: string;
  /** Canonical rich-text HTML, as the editors on both platforms produce. */
  body: string;
  folderId: string | null;
  favorite?: boolean;
  shared?: boolean;
  age: number;
  /** Seeds a trash entry rather than a live note. */
  trashed?: boolean;
  pluginType?: 'finance' | 'resume';
};

/**
 * Exported alongside `SEED_NOTES` so a test can hold them to the contract the
 * sync guard depends on: every id here carries `DEV_SEED_PREFIX`. Miss it on one
 * row and that row is an ordinary note, which is to say it uploads.
 */
export const SEED_FOLDERS: SeedFolder[] = [
  { id: 'dev-seed-folder-work', name: 'Work', parentId: null, favorite: true, age: 1 },
  {
    id: 'dev-seed-folder-specs',
    name: 'Specs',
    parentId: 'dev-seed-folder-work',
    age: 2,
  },
  { id: 'dev-seed-folder-personal', name: 'Personal', parentId: null, age: 3 },
  { id: 'dev-seed-folder-recipes', name: 'Recipes', parentId: null, age: 9 },
];

const p = (...paragraphs: string[]) => paragraphs.map((t) => `<p>${t}</p>`).join('');
const ul = (...items: string[]) => `<ul>${items.map((t) => `<li>${t}</li>`).join('')}</ul>`;

export const SEED_NOTES: SeedNote[] = [
  // ---- Home screen ----
  {
    id: 'dev-seed-note-welcome',
    // Not "Welcome to w_notes" — that title belongs to the real guide in
    // `lib/welcome-content.ts`, which a dev run seeds as well. Two notes with
    // one name is a confusing five minutes for whoever hits it.
    title: 'Dev sample content',
    body:
      p('Everything here is <strong>sample content</strong> for local development.') +
      p('Tap any note to edit it. The navbar pencil becomes a check while you type.') +
      ul('Notes live in folders, or here on the home screen', 'Star one to pin it', 'Search filters the feed you are looking at'),
    folderId: null,
    favorite: true,
    age: 0,
  },
  {
    id: 'dev-seed-note-quarterly',
    title: 'Q3 planning',
    // Deliberately splits "Q3" across an inline tag: the body-flattening search
    // fix is the only reason a search for "q3" finds this note at all.
    body:
      p('Targets for Q<strong>3</strong> and what has to be true to hit them.') +
      ul('Ship the sync backend', 'Cut cold-start under two seconds', 'One design review per surface'),
    folderId: null,
    age: 1,
  },
  {
    id: 'dev-seed-note-syntax',
    title: 'Syntax tax',
    // The title carries a second scoreable word after the first match, which is
    // what the ranking fix in `lib/search.ts` exists to notice.
    body: p('Notes on the cost of clever syntax — every abbreviation is a tax someone pays at read time.'),
    folderId: null,
    age: 4,
  },
  {
    id: 'dev-seed-note-reading',
    title: 'Reading list',
    body: ul(
      'A Pattern Language — Alexander',
      'The Design of Everyday Things — Norman',
      'Thinking in Systems — Meadows',
    ),
    folderId: null,
    shared: true,
    age: 6,
  },
  {
    id: 'dev-seed-note-groceries',
    title: 'Groceries',
    body: ul('Coffee beans', 'Olive oil', 'Parmesan', 'Guanciale', 'Eggs'),
    folderId: null,
    age: 7,
  },
  {
    id: 'dev-seed-note-shortcuts',
    title: 'Keyboard shortcuts',
    body:
      p('Web only, for now.') +
      ul(
        '<strong>Cmd/Ctrl + B</strong> — bold',
        '<strong>Cmd/Ctrl + Z</strong> — undo',
        '<strong>#</strong> then space — heading',
        '<strong>-</strong> then space — bullet list',
      ),
    folderId: null,
    age: 11,
  },
  {
    id: 'dev-seed-note-resume',
    title: 'Resume — Software Engineer',
    // A resume note's body is LaTeX, not HTML. Anything that parses bodies as
    // rich text skips it on `pluginType`; see `lib/resume-note.ts`.
    body: STARTER_RESUME,
    folderId: null,
    pluginType: 'resume',
    age: 5,
  },

  // ---- Work ----
  {
    id: 'dev-seed-note-onboarding',
    title: 'Onboarding checklist',
    body: ul(
      'Repo access + VPN',
      'Run the app on a device, not just the simulator',
      'Read the sync notes before touching the database',
      'Pair on one review',
    ),
    folderId: 'dev-seed-folder-work',
    favorite: true,
    age: 1,
  },
  {
    id: 'dev-seed-note-standup',
    title: 'Standup notes',
    body:
      p('<strong>Yesterday</strong> — finished the search ranking pass.') +
      p('<strong>Today</strong> — sample content for local runs.') +
      p('<strong>Blocked</strong> — nothing.'),
    folderId: 'dev-seed-folder-work',
    age: 0,
  },
  {
    id: 'dev-seed-note-oneonone',
    title: '1:1 with Dana',
    body: ul(
      'Scope for next quarter',
      'How much of the roadmap is really committed',
      'Ask about the on-call rotation',
    ),
    folderId: 'dev-seed-folder-work',
    age: 2,
  },
  {
    id: 'dev-seed-note-retro',
    title: 'Sprint retro',
    body:
      p('<strong>Kept working</strong>: shipping behind a flag.') +
      p('<strong>Hurt</strong>: three separate places that decide what a card looks like.') +
      p('<strong>Try</strong>: one component, one owner.'),
    folderId: 'dev-seed-folder-work',
    age: 8,
  },
  {
    id: 'dev-seed-note-oncall',
    title: 'On-call runbook',
    body:
      p('First: check whether the backend actually deployed. It usually did not.') +
      ul(
        'Dashboards before logs',
        'Logs before code',
        'Roll back rather than fix forward at 3am',
      ),
    folderId: 'dev-seed-folder-work',
    shared: true,
    age: 13,
  },

  // ---- Work / Specs ----
  {
    id: 'dev-seed-note-spec-sync',
    title: 'Spec: delta sync',
    body:
      p('Rows carry <strong>updated_at</strong>; the later write wins, per row, per column set.') +
      ul(
        'Client pushes rows where dirty = 1',
        'Server assigns a sequence number',
        'Client pulls everything above its cursor',
      ),
    folderId: 'dev-seed-folder-specs',
    age: 3,
  },
  {
    id: 'dev-seed-note-spec-search',
    title: 'Spec: search ranking',
    body:
      p('Bands, in order: exact title, title prefix, title word, body hit, fuzzy title.') +
      p('A literal body hit outranks a fuzzy title guess — a word that is really there beats one we inferred.'),
    folderId: 'dev-seed-folder-specs',
    age: 4,
  },
  {
    id: 'dev-seed-note-spec-export',
    title: 'Spec: export pipeline',
    body: p(
      'Export is a navbar action, never a button on the screen. The bar derives a plain note’s export from the store; anything else registers its own.',
    ),
    folderId: 'dev-seed-folder-specs',
    age: 15,
  },

  // ---- Personal ----
  {
    id: 'dev-seed-note-trip',
    title: 'Kyoto trip',
    body:
      p('Late October, before the crowds and after the heat.') +
      ul('Fushimi Inari at dawn', 'Nishiki market', 'Day trip to Nara', 'Book the ryokan early'),
    folderId: 'dev-seed-folder-personal',
    favorite: true,
    age: 2,
  },
  {
    id: 'dev-seed-note-budget',
    title: 'Monthly budget',
    // Content lives in its own `finance_sheets` row, not in `body`.
    body: '',
    folderId: 'dev-seed-folder-personal',
    pluginType: 'finance',
    age: 1,
  },
  {
    id: 'dev-seed-note-gifts',
    title: 'Gift ideas',
    body: ul('Dad — the good chef’s knife', 'Sam — climbing shoes', 'Mum — anything but a mug'),
    folderId: 'dev-seed-folder-personal',
    age: 10,
  },
  {
    id: 'dev-seed-note-workout',
    title: 'Workout log',
    body: p('Squat 5×5, bench 5×5, row 5×5. Add 2.5kg when all five sets land clean.'),
    folderId: 'dev-seed-folder-personal',
    age: 16,
  },

  // ---- Recipes ----
  {
    id: 'dev-seed-note-carbonara',
    title: 'Carbonara',
    body:
      p('Guanciale, pecorino, egg yolks, pepper. No cream, ever.') +
      ul('Render the guanciale slowly', 'Kill the heat before the eggs go in', 'Loosen with pasta water'),
    folderId: 'dev-seed-folder-recipes',
    age: 9,
  },
  {
    id: 'dev-seed-note-focaccia',
    title: 'Focaccia',
    body:
      p('Overnight in the fridge is what makes it worth doing.') +
      ul('500g flour, 400g water, 10g salt, 3g yeast', 'Fold every 30 min, four times', '220°C, 20 minutes'),
    folderId: 'dev-seed-folder-recipes',
    shared: true,
    age: 12,
  },

  // ---- Trash ----
  {
    id: 'dev-seed-note-scratch',
    title: 'Scratch pad',
    body: p('Deleted on purpose so the trash screen has something to show.'),
    folderId: null,
    trashed: true,
    age: 14,
  },
];

/**
 * The seeded spreadsheet: a small monthly budget with a live `SUM` so the
 * formula engine has something to evaluate on open.
 *
 * Built by folding `setCellRaw` over an empty sheet rather than by writing a
 * document literal. Every transform in `lib/finance/sheet.ts` spreads its input
 * so keys a newer app version added survive a round trip, and a hand-written
 * literal here would be the one place in the codebase quietly asserting it
 * knows the whole shape.
 */
export function buildBudgetSheet(): string {
  const rows: string[][] = [
    ['Category', 'Budget', 'Actual', 'Delta'],
    ['Rent', '1450', '1450', '=C2-B2'],
    ['Groceries', '400', '463', '=C3-B3'],
    ['Transport', '120', '96', '=C4-B4'],
    ['Coffee', '60', '88', '=C5-B5'],
    ['Utilities', '180', '174', '=C6-B6'],
    ['Fun', '200', '212', '=C7-B7'],
    ['Total', '=SUM(B2:B7)', '=SUM(C2:C7)', '=C8-B8'],
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
 * Inserts the sample content, skipping anything already present.
 *
 * Takes the database handle rather than calling `getDb()` because its first
 * caller is `open()` itself, mid-open — and for the same reason it doesn't need
 * the write-serialization wrapper the `db` methods use: nothing else can hold a
 * write on a connection that hasn't been handed out yet.
 */
export async function runDevSeed(database: SQLite.SQLiteDatabase): Promise<void> {
  const now = Date.now();
  const at = (age: number) => now - age * DAY;

  await database.withTransactionAsync(async () => {
    // Parents before children: a folder's `parent_id` points at a row seeded
    // earlier in the same list.
    for (const f of SEED_FOLDERS) {
      await database.runAsync(
        `INSERT INTO folders (id, name, parent_id, favorite, created_at, updated_at, dirty)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO NOTHING`,
        [f.id, f.name, f.parentId, f.favorite ? 1 : 0, at(f.age + 30), at(f.age)],
      );
    }

    for (const n of SEED_NOTES) {
      await database.runAsync(
        `INSERT INTO notes
           (id, title, body, folder_id, favorite, shared, published,
            created_at, updated_at, deleted_at, plugin_type, dirty)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO NOTHING`,
        [
          n.id,
          n.title,
          n.body,
          n.folderId,
          n.favorite ? 1 : 0,
          n.shared ? 1 : 0,
          at(n.age + 30),
          at(n.age),
          n.trashed ? at(n.age) : null,
          n.pluginType ?? null,
        ],
      );
    }

    await database.runAsync(
      `INSERT INTO finance_sheets (id, data, created_at, updated_at, dirty)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(id) DO NOTHING`,
      ['dev-seed-note-budget', buildBudgetSheet(), at(31), at(1)],
    );
  });
}

/**
 * Removes every seeded row — a hard delete, not the app's usual tombstone.
 *
 * A soft delete would be wrong twice over: it would leave two dozen entries in
 * the trash screen, and the tombstone is itself a synced fact, so clearing dev
 * content would be the one thing about it that *could* reach an account. These
 * rows have never been anywhere, so nothing needs telling that they are gone.
 */
export async function clearDevSeed(database: SQLite.SQLiteDatabase): Promise<void> {
  const like = `${DEV_SEED_PREFIX}%`;
  await database.withTransactionAsync(async () => {
    await database.runAsync('DELETE FROM notes WHERE id LIKE ?', [like]);
    await database.runAsync('DELETE FROM folders WHERE id LIKE ?', [like]);
    await database.runAsync('DELETE FROM finance_sheets WHERE id LIKE ?', [like]);
    await database.runAsync('DELETE FROM resume_versions WHERE note_id LIKE ?', [like]);
    // Matched on `note_id` for the same reason the versions above are: the row's
    // own id is app-generated and never carries the prefix. Left behind, a
    // tailoring of the sample resume would outlive "Clear" — and because the
    // seeded resume has no folder, it lands in the same corpus bucket a real
    // home-screen resume reads from, where a high enough score would hand
    // someone sample LaTeX as their own tailored resume.
    await database.runAsync('DELETE FROM resume_targets WHERE note_id LIKE ?', [like]);
  });
}
