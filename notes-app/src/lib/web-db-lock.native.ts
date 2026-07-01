/**
 * Native stub for the web single-tab DB guard. There are no browser tabs on
 * native and SQLite isn't OPFS-locked, so this tab is always the sole owner.
 * See web-db-lock.ts for the real implementation and why it exists.
 */

export type DbTabRole = 'leader' | 'follower';

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
