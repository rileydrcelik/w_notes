# Features

Everything the app does, grouped. Paths are relative to `notes-app/`.

- [Getting around](#getting-around)
- [Notes and folders](#notes-and-folders)
- [Copa — the copy/paste feed](#copa--the-copypaste-feed)
- [Plugin notes](#plugin-notes)
- [Task manager](#task-manager)
- [Accounts and sync](#accounts-and-sync)
- [Publishing](#publishing)
- [Settings](#settings)

## Getting around

**Two top-level tabs**, swiped between as a pager: **copa** and **home**
(`src/app/_layout.tsx`). Home is a stack — folders, notes, and plugin screens
push onto it.

**One floating navbar** sits over everything (`src/components/floating-tab-bar.tsx`).
Its trailing button changes with context, in this order of precedence:

| Showing | Button | Does |
|---|---|---|
| Something is selected | **⋯** with a count | Opens actions for what's selected |
| An editor has focus | **✓** | Finishes editing |
| A leaf object (note, sheet, resume) | **✎** | Starts editing |
| Anything else | **+** | Creates something inside what you're looking at |

Long-pressing it always opens the create menu, so no screen is a dead end.

**Editing is one gesture, app-wide.** A screen shows its read view; you tap the
content to edit; the navbar's **+** turns into a **✓**; pressing it returns to
the read view. No screen has its own edit/preview toggle.

**Selecting is one gesture too.** Long-press a card (or right-click, on web) to
enter selection mode, then tap to add more. The **⋯** menu adapts to what you
picked — favorite, rename, move, share, delete for notes and folders; other
verbs for issues. Selection is in memory only and never touches the database.

**Web adds a sidebar** (`src/components/right-sidebar.tsx`) with the folder tree
and search, since a desktop window has the room.

**Exporting is a navbar action**, never a button on the screen. While you're
reading a document, a download icon appears in the navbar pill; it is absent
while an editor is focused, and absent when there is nothing to export yet.

## Notes and folders

- **Rich text.** Note bodies are one canonical HTML format on both platforms.
  Mobile uses the native `react-native-enriched` editor; web uses a custom
  `@tiptap/core` editor with markdown-style keyboard input and undo, and no
  toolbar. There is no markdown translation layer — the HTML *is* the document.
- **Folders** nest arbitrarily (`src/lib/folder-tree.ts`). A note either lives in
  a folder or on the home screen.
- **Search** (`src/lib/search.ts`) scores matches rather than just filtering, so
  a title that *is* your query outranks a body that mentions it once. Bodies are
  flattened out of HTML before matching, so searching `div` finds nothing.
- **Favorites** pin items to the top of any grid and get their own screen.
- **Shared** notes get their own screen. This is in-app sharing, separate from
  [publishing](#publishing).
- **Trash** holds deleted items until you empty it (`src/lib/trash-visibility.ts`).
- **Export** a note as a file from the navbar (`src/lib/note-export.ts`,
  `src/lib/save-note.ts`). On Android, saving picks a folder through the system
  file picker — Android's share sheet cannot save a file on its own.

## Copa — the copy/paste feed

A flat feed of blocks you reach for often (`src/app/copa/`, `src/data/copa.ts`).

- A **text block** has a label and contents; one tap copies it to the clipboard.
- A **file block** holds any file; one tap opens or shares it. Images and videos
  get thumbnails.
- **Paste or drag-and-drop** anywhere in the tab to create a block
  (`src/hooks/use-copa-paste-drop.ts`).
- File **bytes sync across devices** through S3, not through the API: the row
  carries a `remote_key` and each device transfers directly with a presigned URL
  (`src/lib/sync/files.ts`).

> The copa tab is always mounted, because it is one page of a pager. Anything it
> listens for on `window` — paste, drop — fires on every screen unless it checks
> that it is actually visible.

## Plugin notes

A note with `pluginType` set renders live content instead of an editable body.
Its settings live in `pluginConfig`, an opaque JSON string. An unconfigured
plugin note shows a setup screen rather than failing.

### Finance (spreadsheet)

`pluginType: 'finance'` — `src/app/(home)/finance/[id].tsx`, `src/lib/finance/`.

A spreadsheet with formulas (`formula.ts`) and CSV import/export (`csv.ts`).
The sheet is **one JSON document in its own `finance_sheets` table** — not in
`notes.body`, and not one row per cell. A sheet is too large and rewritten too
often to sit in a config column.

> Anything reading a sheet must preserve keys it does not recognise. An older
> client that drops unknown fields on save silently deletes whatever a newer
> version added.

### Resume (LaTeX)

`pluginType: 'resume'` — `src/app/(home)/resume/[id].tsx`, `src/lib/latex/`.

The note's body is **LaTeX source**, not HTML. It compiles to PDF server-side at
`POST /latex/compile`; the app renders the returned PDF and caches it by content
hash. The engine (pdfLaTeX or XeLaTeX) is detected from the source
(`engine-choice.ts`) — templates branch on `\ifPDFTeX`, and the wrong engine
renders the wrong font without erroring.

- **Version history** (`resume_versions` table) records the source after each
  change, with a label saying what that change was. The navbar offers history
  here instead of a pencil.
- **Add entry** (`POST /resume/entry`) has Claude draft one entry in the
  document's own LaTeX style. Insert-only, never a whole-document rewrite.
- **Tailor** (`POST /resume/tailor`) aims the resume at one job posting, pasted
  whole — the posting itself, not a link to it.
- **Harden** (`POST /resume/harden`) aims it at a *job title* instead, which is
  the unit hiring actually screens on. The server keeps a reference table of what
  common titles are screened for (`backend/app/resume_roles.py`).
- Tailoring is mostly **choosing**: benched experience lives on as LaTeX
  comments, and the prompt forbids deleting anything, so the bench survives every
  round. Past tailorings are reused through an on-device scored corpus
  (`corpus.ts`) — no embeddings, on purpose.

**Layout differs by platform, deliberately.** On a wide browser window, source
and compiled page sit side by side (`src/lib/split-layout.ts`). On a phone the
resume is **read-only** (`src/lib/resume-mode.ts`): editing LaTeX on a touch
keyboard with no room for the page beside it is not a real workflow.

### GitHub issues

`pluginType: 'github'`, config `{repo, repoName?}` — `src/app/(home)/github/[id].tsx`.

Browses one repo's issues with state filters, opens new ones, comments, closes
and reopens. Every call goes through the backend proxy
(`backend/app/routers/github_issues.py`) using **your own** stored token.

### Sentry issues

`pluginType: 'sentry'`, config `{org, project, projectName?, repo?}` —
`src/app/(home)/sentry/[id].tsx`.

Lists a Sentry project's live issues. Per issue:

- **Ignore** resolves it in Sentry.
- **Fix** dispatches a GitHub Actions workflow that has Claude investigate and
  open a PR (`.github/workflows/sentry-autofix.yml`). If the PR passes a
  six-condition gate it merges and deploys to production unattended
  (`autofix-ship.yml`); `AUTOFIX_SHIP_DRY_RUN` disarms that.

## Task manager

A **folder** with `kind: 'project'` renders an issue tracker instead of a grid
(`src/app/(home)/project/[id].tsx`, `src/lib/project.ts`).

- Inside it, each note with `pluginType: 'issuetype'` is an **issue type** — a
  lane of the tracker, with its own color and order.
- **Issues** live in their own `issues` table. An issue can belong to **several
  types** at once (`typeIds`); `noteId` stays its primary type.
- The project's `config` defines a **shared attribute schema** — the fields every
  issue in that project carries. Values live in the issue's `attrs`, keyed by
  attribute id.
- **Two-way GitHub sync** for a connected type: creating or editing an issue
  pushes it to GitHub, done/undone closes and reopens it, and back-sync pulls
  GitHub's changes home (`src/lib/github-backsync.ts`, `src/lib/issue-github.ts`).

> Attributes sync into the GitHub issue **body**, as a managed
> `<!-- w-notes:attributes -->` markdown table — not as labels. Labels carry only
> the issue types; people become assignees.

## Accounts and sync

- The app works signed out. A device is anonymous, identified by a UUID device
  key it generates itself.
- Sign in with **Google** or **Apple** (Firebase). On first sign-in the device's
  existing data is claimed into the account, exactly once.
- Sync runs in the background: on foreground, on a timer, and before the app is
  hidden. Conflicts resolve last-writer-wins, per row.
- See [architecture.md](architecture.md#sync) for the pass itself.

## Publishing

Setting `published` on a note mirrors it onto a portfolio website as a post
(`backend/app/publisher.py`). Distinct from `shared`, which is in-app only.

- Every edit republishes and floats the post back to the top of the site's feed.
- Trashing the note removes it from the site.
- Publishing **never creates** a post. Placement belongs to the website's admin,
  which picks notes through a read-only `/embed` API; this side only keeps what
  was placed up to date.
- Restricted to accounts whose email is in the `publisher_emails` allowlist.

## Settings

`src/app/(home)/settings.tsx`:

- **Account** — sign in with Google or Apple, or sign out.
- **Appearance** — theme selection (`src/store/theme-store.tsx`).
- **Editor** — formatting hints on or off.
- **Plugins** — which note kinds appear in the create menu, plus your own GitHub
  token, Sentry API token, default repo, and Anthropic API key. Tokens go to the
  backend and are stored encrypted; they are never held in the app bundle.
- **Version** — the app version, the last line on the screen
  (`src/lib/app-version.ts`). It is the number to quote in a bug report and the
  one Sentry groups releases by.
