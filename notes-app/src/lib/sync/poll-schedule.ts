/**
 * How often the foreground sync poll should run — shared by the native and web
 * polls so the two platforms can't drift apart on latency.
 *
 * A flat interval forces a choice between a chatty idle app and slow cross-device
 * updates. Neither is right: what matters is the case where a note is being
 * edited on one device and watched on another, which is exactly when sync is
 * moving data. So the poll runs tight for a window after the last real change
 * (in either direction) and relaxes once things go quiet.
 */

/** Interval while this device is part of a live editing conversation. */
export const ACTIVE_MS = 2_000;
/** Interval once nothing has moved for ACTIVE_WINDOW_MS. */
export const IDLE_MS = 12_000;
/** How long after the last change we keep polling at ACTIVE_MS. */
export const ACTIVE_WINDOW_MS = 60_000;

/**
 * The delay before the next poll, given how long it's been since sync last
 * carried data (Infinity if it never has — a session with no changes yet polls
 * lazily until something happens).
 */
export function nextPollDelay(msSinceActivity: number): number {
  return msSinceActivity < ACTIVE_WINDOW_MS ? ACTIVE_MS : IDLE_MS;
}
