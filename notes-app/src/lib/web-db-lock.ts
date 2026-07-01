import { useEffect, useState } from 'react';

/**
 * Single-tab guard for the web SQLite database.
 *
 * On web, expo-sqlite runs SQLite through wa-sqlite's OPFS `AccessHandlePoolVFS`,
 * which takes an *exclusive* OS-level lock on the database files
 * (`createSyncAccessHandle`). Only one browser tab can hold that lock at a time —
 * a second tab's `openDatabaseAsync` throws `NoModificationAllowedError`, its
 * bootstrap fails, and it silently shows no content (while Firebase auth, which
 * lives in cross-tab IndexedDB, still shows the right account). See db.ts.
 *
 * So exactly one tab can own the database. This module elects that owner with the
 * Web Locks API and lets the app show a "already open in another tab" screen in
 * the others, with a one-click takeover:
 *
 *  - The first tab acquires an exclusive lock and holds it for its lifetime →
 *    it's the `leader` (the only tab that can touch the DB).
 *  - Later tabs can't get the lock → they're `follower`s and render the guard
 *    overlay. Each also *queues* for the lock, so the instant the leader closes
 *    (or hands off) it's promoted; since the DB never opened while it waited, it
 *    reloads to get a clean connection now that the file is free.
 *  - "Use here" broadcasts a takeover: the current leader reloads (releasing its
 *    lock on unload), which lets the queued follower that asked take over first
 *    (Web Locks grants queued requests FIFO, so the asking tab wins the race).
 */

export type DbTabRole = 'leader' | 'follower';

const LOCK_NAME = 'wnotes-db-owner';
const CHANNEL_NAME = 'wnotes-db-lock';
const TAKEOVER = 'takeover';

let started = false;
let role: DbTabRole = 'leader';
let channel: BroadcastChannel | null = null;
const subscribers = new Set<(role: DbTabRole) => void>();

function setRole(next: DbTabRole): void {
  if (role === next) return;
  role = next;
  for (const fn of subscribers) fn(next);
}

/** Idempotently begin leader election for this tab. */
function start(): void {
  if (started) return;
  started = true;

  // Older browsers without the Web Locks API can't coordinate; assume ownership
  // and let the DB layer surface any real conflict. (All OPFS-capable browsers
  // that run this app also ship navigator.locks, so this is a rare fallback.)
  if (typeof navigator === 'undefined' || !navigator.locks) {
    setRole('leader');
    return;
  }

  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (e) => {
    // A follower wants the DB. Release our lock by reloading; on the way back up
    // we'll find the file taken by that follower and settle in as a follower too.
    if (e.data === TAKEOVER && role === 'leader') window.location.reload();
  };

  // Try to grab ownership without waiting. If it's free we're the leader and hold
  // the lock for the tab's whole lifetime (the callback promise never resolves).
  void navigator.locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (lock) {
      setRole('leader');
      await new Promise<void>(() => {});
      return;
    }

    // Someone else owns the DB — we're a follower. Queue for the lock so that the
    // moment the leader releases it (close or takeover) we're promoted. The DB
    // couldn't open while we waited, so reload for a clean connection.
    setRole('follower');
    await navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, async () => {
      window.location.reload();
      await new Promise<void>(() => {});
    });
  });
}

/** Ask the current owner tab to hand the database over to this one. */
export function requestDbTakeover(): void {
  channel?.postMessage(TAKEOVER);
}

/**
 * Whether an error is the expected "another tab owns the OPFS database" failure.
 * A follower tab's DB open/query fails with this until it takes over; callers use
 * it to keep that expected, guard-handled case out of Sentry.
 */
export function isDbLockedError(e: unknown): boolean {
  // wa-sqlite's createSyncAccessHandle throws a DOMException on a locked file;
  // the message carries through to the SQLite open error we ultimately see.
  const name = (e as { name?: string })?.name;
  const message = String((e as { message?: string })?.message ?? e ?? '');
  return name === 'NoModificationAllowedError' || /NoModificationAllowed|access handle/i.test(message);
}

/**
 * The database ownership role for this tab. `follower` means another tab holds
 * the DB and this one should show the guard instead of (empty) content. Always
 * `leader` on native, where there are no tabs and this whole module is stubbed.
 */
export function useDbTabRole(): DbTabRole {
  const [current, setCurrent] = useState<DbTabRole>(role);
  useEffect(() => {
    start();
    // Sync in case the role changed between this component's first render and
    // now (start() elects asynchronously); later changes arrive via subscribe.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reconcile role
    setCurrent(role);
    subscribers.add(setCurrent);
    return () => {
      subscribers.delete(setCurrent);
    };
  }, []);
  return current;
}
