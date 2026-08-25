/**
 * How long the trash holds on to something before it goes for good.
 *
 * The trash is an undo buffer, not an archive: everything in it was deleted on
 * purpose, and a buffer nobody empties eventually costs more than it saves —
 * every device carries the bytes, every sync pass carries the rows. So an entry
 * gets a fixed window to be reclaimed in, and after that it stops being offered
 * and its rows are dropped from the device.
 *
 * The window is measured from `deleted_at`, which is the same number on every
 * device (it's a synced column, not a local clock reading at import time), so
 * every device agrees about when a given entry ran out without having to agree
 * about *when* it looked.
 *
 * Lives outside `lib/db.ts` so the arithmetic can be tested without a SQLite
 * binding — the db module and the trash screen both read it from here.
 */

/** Days an entry survives in the trash after being deleted. */
export const TRASH_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The retention window in milliseconds. */
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * DAY_MS;

/** When an entry deleted at `deletedAt` runs out of its window (epoch ms). */
export function trashExpiresAt(deletedAt: number): number {
  return deletedAt + TRASH_RETENTION_MS;
}

/**
 * Whether an entry has outlived the window and should no longer be listed or
 * kept. The boundary is inclusive of the window: an entry is expired only once
 * `now` is strictly past its expiry, so "exactly 30 days old" is still offered.
 */
export function isTrashExpired(deletedAt: number, now: number = Date.now()): boolean {
  return now > trashExpiresAt(deletedAt);
}

/**
 * Whole days left before an entry is deleted for good, rounded up so an entry
 * with any time left reads as at least "1 day" rather than "0 days". Never
 * negative: an already-expired entry has none left.
 */
export function daysLeftInTrash(deletedAt: number, now: number = Date.now()): number {
  const remaining = trashExpiresAt(deletedAt) - now;
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / DAY_MS);
}
