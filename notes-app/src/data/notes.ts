/**
 * Core data types for the notes app. Notes either live inside a folder
 * (`folderId` set) or directly on the home screen (`folderId: null`).
 *
 * The live data lives in the notes store (`@/store/notes-store`), which
 * hydrates from and persists changes to on-device SQLite (`@/lib/db`).
 */

export type Note = {
  id: string;
  title: string;
  body: string;
  folderId: string | null;
  updatedAt: string;
  favorite?: boolean;
  shared?: boolean;
  /**
   * Mirrors the note onto the public portfolio website as a post in its "notes"
   * feed; clearing it takes the post down again. Distinct from `shared`, which
   * governs in-app sharing — a note can be shared with someone without being
   * world-readable. Every edit to a published note republishes it, which also
   * floats it back to the top of the site's feed.
   */
  published?: boolean;
  /**
   * Plugin-note marker. When set, the note renders live plugin content (e.g. a
   * Sentry project's issues, or a GitHub repo's issues) instead of an editable
   * body. Ordinary notes leave it undefined.
   *
   * `finance` is a spreadsheet; unlike the others its content isn't in
   * `pluginConfig` but in its own synced `finance_sheets` row keyed by the note
   * id (see `@/lib/finance/sheet`), because a sheet is far too large and too
   * frequently rewritten to sit in a config column.
   *
   * `'resume'` is the one plugin type that still owns `body`: it holds LaTeX
   * source rather than the app's canonical rich-text HTML, so anything that
   * parses a body as HTML must skip it (see `@/lib/resume-note`). Its version
   * history is a separate synced table, like the sheet above.
   */
  pluginType?: 'sentry' | 'github' | 'issuetype' | 'finance' | 'resume';
  /**
   * Opaque per-plugin JSON config. For Sentry: `{org, project, projectName?,
   * repo?}` (see `@/lib/sentry-note`). For GitHub: `{repo, repoName?}` (see
   * `@/lib/github-note`). For an issue type inside a project: `{githubConnected,
   * order, color?}` (see `@/lib/project`). Absent on an unconfigured plugin note,
   * which renders a setup UI instead of live content.
   */
  pluginConfig?: string;
};

export type Folder = {
  id: string;
  name: string;
  /** Parent folder, or null when the folder lives on the home screen. */
  parentId: string | null;
  favorite?: boolean;
  /**
   * Folder "kind" marker, mirroring a note's `pluginType`. `'project'` marks a
   * task-manager folder that renders an issue tracker instead of a plain grid.
   * Undefined for ordinary folders.
   */
  kind?: 'project';
  /**
   * Opaque per-kind JSON config. For a project: `{repo?, attributes}` (see
   * `@/lib/project`). Absent on an unconfigured project, which renders a setup UI.
   */
  config?: string;
};

/** An attribute value on an issue: a picked option, a star count, or a list. */
export type IssueAttrValue = string | number | string[];

/**
 * A single issue in a task-manager project — a child of an issue-type note
 * (`noteId`), stored in its own synced table. Attribute *values* live in
 * `attrs`, keyed by the attribute ids defined in the project's schema
 * (`Folder.config`). `done` is a flag independent of any "status" attribute.
 */
export type Issue = {
  id: string;
  /**
   * The issue's *primary* issue-type note (its home type). Kept for GitHub
   * connection, ordering, and back-compat; it is always the first entry of
   * `typeIds`.
   */
  noteId: string;
  /**
   * Every issue-type note this issue is filed under (an issue can have several
   * types). Includes `noteId` as its first entry. Older issues predating
   * multi-type have an empty array and read as `[noteId]` (see
   * `effectiveTypeIds`).
   */
  typeIds: string[];
  title: string;
  description: string;
  done: boolean;
  /** Attribute values keyed by attribute id (see the project's schema). */
  attrs: Record<string, IssueAttrValue>;
  /** Mirrored GitHub issue number when the type is GitHub-connected. */
  ghNumber?: number;
  /** Manual ordering within a type. */
  position: number;
  /** Raw creation timestamp (ms) — used to sort issues within a type. */
  createdAt: number;
  updatedAt: string;
};

/**
 * One entry in a resume's version history: the LaTeX source as it stood after a
 * change, and a label saying what that change was.
 *
 * Settled once you move off it, not immutable. The version you are *on* is the
 * document you're working in, so the screen keeps its `source` in step with the
 * editor as you type (`db.updateResumeVersion`) — that's what makes switching
 * away and back find your typing where you left it. Every other version is
 * finished and nothing rewrites it. `label` is never rewritten either: it says
 * what the version *is*, which stays true however much you refine it.
 *
 * So the current version's row conflicts under last-writer-wins exactly like a
 * note body does, and carries the same caveat — two devices editing the same
 * current version offline will keep only the later save. Versions you are not
 * on cannot conflict at all.
 *
 * The oldest snapshot for a resume is "the original" and carries the resume's
 * title as its label; every later one describes what the add/edit/restore did.
 */
/**
 * What a model read out of one job posting: the handful of things that decide
 * whether a resume written for *that* job is a sensible starting point for a
 * different one.
 *
 * Filled in server-side, by the same call that writes the tailored resume — the
 * model has already read the posting closely enough to rank experience against
 * it, so naming what it found costs nothing extra. The query side needs no model
 * call at all: a new posting is scored by looking for a stored row's
 * `requirements` in the new posting's own text (see `lib/latex/corpus.ts`).
 *
 * Deliberately small. A field nothing scores against is dead weight in every
 * synced row for ever, so each of these has to earn its place in the scoring.
 */
export type ResumeFacets = {
  /**
   * The canonical job-title bucket, e.g. "full stack software engineer" —
   * seniority stripped out, since that is its own field. Empty when the model
   * could not place the title.
   */
  roleFamily: string;
  /** Where in a career ladder this sits. Empty when the posting doesn't say. */
  seniority: '' | 'intern' | 'junior' | 'mid' | 'senior' | 'staff' | 'principal' | 'lead';
  /** The broad sector, e.g. "finance", "healthcare". Empty when unclear. */
  sector: string;
  /** The narrower industry, e.g. "payments", "medical imaging". */
  industry: string;
  /**
   * The concrete things the posting requires, as short canonical keywords —
   * "kubernetes", not "k8s"; "distributed systems", not "experience working on
   * large-scale distributed systems". Canonicalising at write time is what makes
   * plain text matching on the query side work at all: the stored side has been
   * normalised by a model, so only the new posting's phrasing is raw.
   */
  requirements: string[];
};

export type ResumeTarget = {
  id: string;
  /**
   * The resume note this tailoring was applied to.
   *
   * Provenance, not a relationship. A corpus row carries its own `source` and
   * `facets`, so it stays useful when the note is deleted, and it can arrive on
   * a fresh device before that note does — there is no foreign key either way.
   * Every read path treats "no such note" as ordinary rather than as corruption.
   */
  noteId: string;
  /**
   * The folder that note was in when this was written — the resume "family"
   * this tailoring belongs to. Null is the home screen, not "unknown".
   *
   * Snapshotted rather than followed, so moving a resume between folders leaves
   * past tailorings where they were rather than silently re-pointing them at a
   * family they were never written for.
   */
  folderId: string | null;
  /** Who the application was to, as the person typed it. May be empty. */
  company: string;
  /** The job title applied for, as the person typed it. */
  role: string;
  /** The model's structured reading of the posting — see `lib/latex/corpus.ts`. */
  facets: ResumeFacets;
  /**
   * The posting itself, kept whole. Adapting a stored tailoring is a comparison
   * — the old job is shown beside the new one and the model is asked what
   * changed — so the text has to survive, not only the facets drawn from it.
   */
  jobDescription: string;
  /** The tailored LaTeX this job produced. */
  source: string;
  /**
   * Fingerprint of the document that was tailored.
   *
   * The guard on the cache. A stored tailoring was written against the resume as
   * it stood that day; handing it back verbatim after the person has added a job
   * would quietly return a resume with their newest experience missing. So a row
   * whose hash no longer matches the document in hand is barred from being
   * reused as-is — it can still be *adapted*, which is a model call that reads
   * the current source.
   */
  baseHash: string;
  /** Creation timestamp (ms) — the corpus's sort key, and the recency tiebreak. */
  createdAt: number;
  updatedAt: number;
};

export type ResumeVersion = {
  id: string;
  /** The resume note this belongs to. */
  noteId: string;
  /** What this change was, e.g. "Added Backend Engineer, Globex". */
  label: string;
  /** The full LaTeX source at this point in the resume's life. */
  source: string;
  /** Raw creation timestamp (ms) — the history's sort key. */
  createdAt: number;
  /**
   * When this version's text last changed (ms) — what its row *shows*.
   *
   * Deliberately not the sort key. A version you are working in is kept in step
   * with the editor, so this moves as you type; ordering by it would make the
   * list reshuffle under you, which is why `createdAt` still decides position.
   * But the age on the row answers "how stale is this version", and for the one
   * you have been refining all afternoon its creation time is the wrong answer.
   * Equal to `createdAt` until something rewrites the source.
   */
  updatedAt: number;
};

/**
 * The issue-type note ids an issue effectively belongs to. Uses `typeIds` when
 * present, else falls back to `[noteId]` so pre-multi-type issues (empty
 * `typeIds`) still show under their single home type.
 */
export function effectiveTypeIds(issue: Pick<Issue, 'noteId' | 'typeIds'>): string[] {
  return issue.typeIds.length > 0 ? issue.typeIds : issue.noteId ? [issue.noteId] : [];
}

/**
 * Normalizes a chosen set of type ids into the `{ noteId, typeIds }` pair stored
 * on an issue: dedupes, drops falsy ids, and pins `noteId` (the primary/home
 * type) to the first entry. Returns null when the set is empty (an issue must
 * keep at least one type).
 */
export function normalizeTypeIds(ids: string[]): { noteId: string; typeIds: string[] } | null {
  const unique = ids.filter((id, i) => id && ids.indexOf(id) === i);
  if (unique.length === 0) return null;
  return { noteId: unique[0], typeIds: unique };
}
