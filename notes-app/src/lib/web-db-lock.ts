/**
 * Which tab holds the web SQLite database.
 *
 * On web, expo-sqlite runs SQLite through wa-sqlite's OPFS `AccessHandlePoolVFS`,
 * which takes an *exclusive* OS-level lock on the database files
 * (`createSyncAccessHandle`). Only one browser tab can hold that lock at a time —
 * a second tab's `openDatabaseAsync` throws `NoModificationAllowedError`, and a
 * failed open leaves wa-sqlite's VFS wedged for the rest of the page's life, so
 * a later open can't recover without a reload. See db.ts.
 *
 * That constraint is on the *file*, not on the app: every tab is a full tab, it
 * just doesn't hold its own connection. This module answers the one question
 * that follows — who holds it — and `db-tabs.ts` routes the other tabs' calls to
 * whoever that is.
 *
 *  - The first tab acquires an exclusive lock and holds it for its lifetime →
 *    it's the `leader`, the only tab that opens the OPFS file. It also runs the
 *    once-per-profile background jobs (see `ownsBackgroundWork`).
 *  - Later tabs can't get the lock → they're `follower`s, which route their
 *    database calls to the leader instead of opening anything. Each also
 *    *queues* for the lock, so the moment the leader closes it's promoted in
 *    place — and because it never touched the file while it waited, that first
 *    open starts from a clean VFS.
 *  - "Use here" (`requestDbTakeover`) broadcasts a takeover for the case where
 *    the leader has stopped answering: it reloads, releasing its lock, and the
 *    queued follower that asked wins it (Web Locks grants queued requests FIFO).
 */

export type DbTabRole = 'leader' | 'follower';

const LOCK_NAME = 'wnotes-db-owner';
const CHANNEL_NAME = 'wnotes-db-lock';
const TAKEOVER = 'takeover';

let started = false;
let role: DbTabRole = 'leader';
let channel: BroadcastChannel | null = null;
const subscribers = new Set<(role: DbTabRole) => void>();

// True once this tab actually holds the DB lock (never just by default). The DB
// layer waits on this before opening: a follower must NOT open the OPFS file,
// because a failed open corrupts wa-sqlite's VFS for the whole page ("Invalid
// VFS state"), so the later open after promotion can't recover without a reload.
// Gating the open means the file is only ever touched once we own it.
let owns = false;
const ownerWaiters: Array<() => void> = [];

/**
 * Resolves once this tab knows which it is — leader or follower.
 *
 * Election is asynchronous: `navigator.locks.request` answers in a later task,
 * so for a moment after start-up every tab looks like a non-owner. Routing a
 * database call on that would have the *leader's* own first calls addressed to
 * a leader that doesn't exist. So callers wait for the question to be decided
 * rather than reading the default.
 */
let markSettled: (() => void) | null = null;
const settled = new Promise<void>((resolve) => {
  markSettled = resolve;
});

function settle(): void {
  markSettled?.();
  markSettled = null;
}

/** Resolves when this tab's role is known. Starts election if it hasn't begun. */
export function whenRoleSettled(): Promise<void> {
  start();
  return settled;
}

/**
 * Whether background work that must happen once per browser profile belongs to
 * this tab — the sync pass, the GitHub outbox flush, the retitle queue.
 *
 * Each of those is guarded by a module-scoped "already running" flag, which
 * dedupes within one JavaScript realm and was the whole story while only one
 * tab could reach the database. Now that any tab can, every tab would run its
 * own. The costs differ by job — a duplicate sync pass collides on the
 * backend's per-user advisory lock, a duplicate outbox flush files the same
 * GitHub issue twice, a duplicate retitle bills the user's key twice — but the
 * rule is the same, so it lives here rather than being restated at each call.
 *
 * Waits for election first: it settles in a later task, and a tab reading the
 * default would skip its own first pass as the owner.
 */
export async function ownsBackgroundWork(): Promise<boolean> {
  await whenRoleSettled();
  return isDbLeader();
}

function grantOwnership(): void {
  owns = true;
  setRole('leader');
  settle();
  for (const w of ownerWaiters.splice(0)) w();
}

/**
 * Resolves when this tab may open the database — immediately on native and on
 * browsers without the Web Locks API, otherwise once this tab owns the lock
 * (elected leader now, or promoted from follower). A follower's promise stays
 * pending until it takes over, which is exactly what keeps it off the DB file.
 */
export function whenDbOwner(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.locks) return Promise.resolve();
  if (owns) return Promise.resolve();
  return new Promise<void>((resolve) => ownerWaiters.push(resolve));
}

/**
 * Whether this tab holds the database connection, right now, synchronously.
 *
 * `whenDbOwner()` answers the same question but only ever resolves *towards*
 * ownership, which suits the open path and nothing else. Routing a call has to
 * decide in the moment and be able to hear "no", so it reads this instead.
 * Deliberately not React state: it is consulted on every database call.
 */
export function isDbLeader(): boolean {
  start();
  return owns;
}

/**
 * Whether the role has ever been *announced*, as opposed to merely defaulting.
 *
 * `role` starts as `leader` because that is what a lone tab is, but the first
 * election result is news even when it agrees with that default: subscribers
 * registered before it landed are waiting to hear the question was settled at
 * all. Without this, the first leader announced nothing, and a tab with no
 * `BroadcastChannel` — which reads as unreachable until told otherwise — sat
 * behind the guard forever while holding the database it was looking for.
 */
let announced = false;

function setRole(next: DbTabRole): void {
  if (role === next && announced) return;
  role = next;
  announced = true;
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
    grantOwnership();
    return;
  }

  // Guarded separately from `navigator.locks`: election works without a channel,
  // it just can't be handed over. `db-tabs.ts` guards its own channels the same
  // way, and a tab that assumed one existed would throw here and never elect at
  // all — leaving every tab a follower with nothing to follow.
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (e) => {
      // A follower wants the DB. Release our lock by reloading; on the way back
      // up we'll find the file taken by that follower and settle in as one too.
      if (e.data === TAKEOVER && role === 'leader') window.location.reload();
    };
  }

  // Try to grab ownership without waiting. If it's free we're the leader and hold
  // the lock for the tab's whole lifetime (the callback promise never resolves).
  void navigator.locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (lock) {
      grantOwnership();
      await new Promise<void>(() => {});
      return;
    }

    // Someone else owns the DB — we're a follower. Queue for the lock so that the
    // moment the leader releases it (close or takeover) we're promoted.
    setRole('follower');
    // Decided: this tab is not the owner. Calls can be routed from here.
    settle();
    await navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, async () => {
      // Promoted: hold the lock for this tab's lifetime and become the leader in
      // place. We must NOT reload here — reloading would release the lock we just
      // won and let the former leader re-grab it in a race, so the takeover would
      // appear to do nothing (the classic "press Use here, it reloads but nothing
      // changes"). Because we gated the DB open on ownership (whenDbOwner), the
      // OPFS file was never touched while we were a follower, so this first open
      // starts from a clean VFS and succeeds in place — a role subscriber then
      // refreshes the stores (see subscribeDbRole).
      grantOwnership();
      await new Promise<void>(() => {});
    });
  });
}

/** Ask the current owner tab to hand the database over to this one. */
export function requestDbTakeover(): void {
  channel?.postMessage(TAKEOVER);
}

/**
 * Subscribe to this tab's ownership-role changes; returns an unsubscribe fn.
 * Callers use it to re-hydrate the data stores when a follower is promoted to
 * leader and can finally open the database (the promotion happens in place, with
 * no page reload). Idempotently starts election so it works regardless of mount
 * order. No-op churn on native, where the role is always `leader`.
 */
export function subscribeDbRole(listener: (role: DbTabRole) => void): () => void {
  start();
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
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
