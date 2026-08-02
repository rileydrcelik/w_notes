/**
 * What the trash is willing to show.
 *
 * The screens discard an object left completely empty when you navigate away
 * from it — an unnamed folder nobody put anything in, a note nobody typed in.
 * Those deletes still have to be tombstones rather than hard deletes, or they
 * would never reach the other devices and the row would come back on the next
 * pull. But a tombstone for something that never held anything is not a thing
 * anyone wants offered back to them, and the trash would otherwise fill with
 * identical blank cards.
 *
 * So the tombstone stays and the listing hides it. The test is emptiness rather
 * than "was this deleted automatically", which needs no column to mark
 * auto-deletes and loses nothing: an unnamed, contentless object deleted by hand
 * is equally not worth listing.
 *
 * Lives outside `lib/db.ts` so it can be tested without a SQLite binding; the
 * `TrashEntry` import is type-only, so there is no import cycle at runtime.
 */
import type { TrashEntry } from '@/lib/db';
import { htmlToPlainText } from '@/lib/html-text';

/**
 * Whether a trashed entry is worth listing.
 *
 * A folder that took anything down with it is always listed, however it was
 * named — the things trashed alongside it are the point, and restoring the
 * folder is how they come back.
 */
export function worthKeepingInTrash(entry: TrashEntry): boolean {
  if (entry.kind === 'folder') {
    if (entry.folders.length > 0 || entry.notes.length > 0) return true;
    return entry.folder.name.trim().length > 0;
  }
  const { title, body } = entry.note;
  return title.trim().length > 0 || htmlToPlainText(body).trim().length > 0;
}
