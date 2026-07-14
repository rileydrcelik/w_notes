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
   * Plugin-note marker. When set, the note renders live plugin content (e.g. a
   * Sentry project's issues, or a GitHub repo's issues) instead of an editable
   * body. Ordinary notes leave it undefined.
   */
  pluginType?: 'sentry' | 'github' | 'issuetype';
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
  /** The issue-type note this issue is filed under. */
  noteId: string;
  title: string;
  description: string;
  done: boolean;
  /** Attribute values keyed by attribute id (see the project's schema). */
  attrs: Record<string, IssueAttrValue>;
  /** Mirrored GitHub issue number when the type is GitHub-connected. */
  ghNumber?: number;
  /** Manual ordering within a type. */
  position: number;
  updatedAt: string;
};
