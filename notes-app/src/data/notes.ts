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
  pluginType?: 'sentry' | 'github';
  /**
   * Opaque per-plugin JSON config. For Sentry: `{org, project, projectName?,
   * repo?}` (see `@/lib/sentry-note`). For GitHub: `{repo, repoName?}` (see
   * `@/lib/github-note`). Absent on an unconfigured plugin note, which renders a
   * setup UI instead of live content.
   */
  pluginConfig?: string;
};

export type Folder = {
  id: string;
  name: string;
  /** Parent folder, or null when the folder lives on the home screen. */
  parentId: string | null;
  favorite?: boolean;
};
