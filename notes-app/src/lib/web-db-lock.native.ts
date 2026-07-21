/**
 * Native stub for the web single-tab DB guard. There are no browser tabs on
 * native and SQLite isn't OPFS-locked, so this tab is always the sole owner.
 * See web-db-lock.ts for the real implementation and why it exists.
 */

export type DbTabRole = 'leader' | 'follower';

/**
 * Native owns the database from the start, so ownership is immediate.
 *
 * `db.ts` awaits this before opening SQLite on every platform. Without it here
 * the call is `undefined` on native, the open throws, and no store can load —
 * which is exactly what happened: the export was added to the web module in
 * 43d961c and this counterpart was missed, breaking app launch on device.
 */
export function whenDbOwner(): Promise<void> {
  return Promise.resolve();
}

/**
 * Native has one "tab" and its role never changes, so a subscriber can never
 * have anything to hear. Matches the web module, which only notifies on an
 * actual role *change* — a native listener would never fire there either.
 */
export function subscribeDbRole(_listener: (role: DbTabRole) => void): () => void {
  return () => {};
}

/** No-op on native: nothing to hand over. */
export function requestDbTakeover(): void {}

/** Native never hits the OPFS single-owner lock. */
export function isDbLockedError(): boolean {
  return false;
}

/** Native is always the sole database owner. */
export function useDbTabRole(): DbTabRole {
  return 'leader';
}
