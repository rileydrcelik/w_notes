/**
 * What kind of thing a copy block is, and whether it holds anything.
 *
 * Both questions turn on the same distinction, and getting it wrong has already
 * destroyed data once: **`fileName` is the metadata that travels with the row;
 * `fileUri` is this device's path to the downloaded bytes.** A device that has
 * pulled a file block but not yet fetched its bytes has the first and not the
 * second — and on web that is *every* file block after a reload, because object
 * URLs die with the session and `prepareLocalFiles` clears them (see
 * `lib/sync/files.web.ts`).
 *
 * So anything asking "is this a file?" must ask `fileName`. Asking `fileUri`
 * says no for a real attachment whose bytes are simply elsewhere, which renders
 * it as an empty text block and — where emptiness decides deletion — deletes it.
 * Copa has no trash, so there is nothing to restore.
 *
 * Pure and separate from the screens for the reason `folder-tree.ts` is: the
 * rule is worth testing directly, and the modules around it reach expo-sqlite
 * and React Native, which this vitest config can't load.
 */
import { htmlToPlainText } from '@/lib/html-text';
import { collectNoteImageIds } from '@/lib/note-images';

/**
 * The `[id]` a copy block screen carries before it holds anything.
 *
 * Tapping (+) opens a *draft*: a screen with no row behind it. The block is
 * written on the first keystroke, so backing out of one you never typed in
 * leaves nothing — here or on any other device. It used to be written empty up
 * front, which synced 150ms later (copa is a clipboard; it syncs fast) and
 * stranded a blank tile everywhere, because the only cleanup in the app ran
 * when the block's own screen unmounted and nothing guaranteed it ever would.
 */
export const DRAFT_COPA_ID = 'new';

/** The parts of a copy block these rules read. */
export type BlockShape = {
  fileName?: string | null;
  fileUri?: string | null;
  label?: string;
  content?: string;
};

/**
 * Whether this block holds a file rather than text.
 *
 * `fileName` alone. A block whose bytes haven't arrived is still a file block —
 * it just has nothing to preview yet, which is a question for whatever draws it.
 */
export function isFileBlock(block: BlockShape): boolean {
  return !!block.fileName;
}

/**
 * Whether a block holds nothing at all — no file, no title, no text.
 *
 * `fileUri` counts here as well as `fileName`: a block being written right now
 * may have bytes on this device before the row naming them has settled, and the
 * cost of the two answers is not symmetric. Saying "not empty" about an empty
 * block leaves a stray tile the user can delete; saying "empty" about a real one
 * destroys it.
 *
 * `label` and `content` are passed separately from the stored row so a caller
 * mid-edit can ask about what is on screen rather than what was last committed.
 */
export function isEmptyCopaBlock(block: BlockShape, label: string, content: string): boolean {
  if (block.fileName || block.fileUri) return false;
  // A picture is content, and `htmlToPlainText` strips tags — so a block holding
  // only a pasted screenshot flattens to '' and reads as empty. Left to that,
  // the first thing anyone does with this feature (paste a picture, type
  // nothing, leave) deletes what they just made. The stored-HTML serializer
  // already draws this line the same way: `rich-html.web.ts` refuses to call a
  // body empty when it holds an `<img>`.
  if (collectNoteImageIds(content).length > 0) return false;
  return label.trim().length === 0 && htmlToPlainText(content).length === 0;
}
