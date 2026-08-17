/**
 * Whether the resume screen edits, and which pane it opens on.
 *
 * Kept out of the screen for the same reason `lib/split-layout.ts` keeps its
 * breakpoint out of the hook: the decision is pure, so it can be unit-tested
 * without a renderer, and the screen is left saying what it draws rather than
 * when.
 */
import { Platform } from 'react-native';

/**
 * Mobile reads a resume; it doesn't write one. Editing LaTeX on a phone means a
 * touch keyboard over a monospace document with no room for the page beside it,
 * and every authoring tool on that screen — add entry, tailor, harden, the
 * engine picker — assumes the source is visible. So native gets the document
 * and the download, and the writing stays where there is a keyboard.
 *
 * Deliberately platform and not width. A narrow browser window still has a
 * keyboard and stays fully editable; this is the mirror of `useSplitLayout`,
 * which is web-only because its threshold is reachable on a landscape tablet
 * where the keyboard would eat the pane.
 *
 * A constant rather than a hook because `Platform.OS` cannot change under a
 * running app, so nothing needs to re-render when it is read.
 */
export const RESUME_READ_ONLY = Platform.OS !== 'web';

export type ResumeMode = 'edit' | 'view';

/**
 * Which pane a resume opens on.
 *
 * Read-only there is only one answer, including for an empty resume — the case
 * worth pinning, because it is the one that used to open straight into a LaTeX
 * field and the one nobody screenshots. Editable, a written resume opens in its
 * read view and a blank one in the editor, matching a note with body text
 * versus a new empty one.
 */
export function openingResumeMode(
  body: string | undefined,
  readOnly: boolean = RESUME_READ_ONLY,
): ResumeMode {
  if (readOnly) return 'view';
  return (body ?? '').trim() ? 'view' : 'edit';
}
