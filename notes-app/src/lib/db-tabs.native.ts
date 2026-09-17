/**
 * Native stub for the web cross-tab database seam. See `db-tabs.ts` for what it
 * exists to solve.
 *
 * Native has one process and one connection: SQLite is a local file with no
 * OPFS exclusive lock and no tabs to arbitrate between, so there is nothing to
 * route and nobody to route it to. Returning the API untouched means the device
 * pays nothing for the web's problem — no wrapper object, no extra call frame
 * on the hot path — and Metro resolves this file in place of the web one, so
 * none of that machinery is even bundled.
 *
 * The export stays so the pair's shapes match; `__tests__/platform-parity.test.ts`
 * enforces that, after a missing native counterpart once shipped an app that
 * couldn't launch on device.
 */

/** Identity on native: the caller already holds the only connection there is. */
export function shareDbAcrossTabs<T extends object>(
  api: T,
  _options: { invalidates?: readonly string[] } = {},
): T {
  return api;
}

/**
 * Identity on native: this process owns the database, so the operation runs
 * here. The web module routes it to whichever tab holds the connection.
 */
export function runInDbOwner<A extends unknown[], R>(
  _name: string,
  fn: (...args: A) => Promise<R>,
  _options: { timeoutMs?: number } = {},
): (...args: A) => Promise<R> {
  return fn;
}

/**
 * No-op on native: there is one process, so nothing else can change the
 * database underneath this one. Returns an unsubscribe for shape parity.
 */
export function subscribeDbChanged(_listener: () => void): () => void {
  return () => {};
}

/**
 * Never on native: this process holds the database itself, so there is no other
 * tab to fail to reach. The pair below says the same thing three ways because
 * the web module's callers need all three shapes.
 */
export function isDbUnreachable(): boolean {
  return false;
}

/** Never changes on native, so the listener is never called. */
export function subscribeDbReachable(_listener: () => void): () => void {
  return () => {};
}

/** Always reachable on native. What the (web-only) guard overlay reads. */
export function useDbUnreachable(): boolean {
  return false;
}
