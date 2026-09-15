/**
 * The seam every database call passes through (web).
 *
 * On web, SQLite runs through wa-sqlite's OPFS `AccessHandlePoolVFS`, which
 * takes an exclusive OS-level lock on the database directory — so exactly one
 * tab can hold the connection, and `db.ts` gates its open on owning it
 * (`whenDbOwner`). Letting other tabs work means routing their calls to the tab
 * that owns the file, and this is where that routing will live.
 *
 * It wraps whole `db` methods rather than the SQL underneath them, which is the
 * distinction the design rests on. Every mutating method is already funnelled
 * through one promise chain (`serializeWrite` in `db.ts`) so that two writes
 * can't interleave their transactions — a bug this project has already paid for
 * once. That chain is per-JavaScript-realm. Proxying statements would leave each
 * tab with its own chain and let two tabs' BEGIN/COMMIT interleave on the single
 * connection, and `withExclusiveTransactionAsync` throws on web, so there would
 * be no fallback. Proxying methods keeps every tab's writes on the owner's one
 * chain, where the guarantee still means what it says.
 *
 * Right now it forwards everything locally: the wiring exists, the behaviour
 * doesn't change, and the follower branch lands separately.
 */

/** The shape of the object being shared: async methods, as `db` exposes. */
type AsyncMethod = (...args: unknown[]) => Promise<unknown>;

/**
 * Wrap a database API so its calls can be routed per call rather than per
 * object.
 *
 * Built eagerly, one dispatching function per key, instead of with a `Proxy`:
 * the identity of the returned object and its methods is then stable for the
 * program's life, which matters because ownership can change while the app is
 * running and callers hold onto `db` indefinitely. Deciding where a call goes
 * *inside* the dispatcher — rather than when the wrapper was built — is what
 * lets a tab be promoted without anything re-importing.
 *
 * Non-function properties are carried across untouched, so the wrapper is a
 * faithful stand-in for whatever it is given.
 */
export function shareDbAcrossTabs<T extends object>(api: T): T {
  const source = api as Record<string, unknown>;
  const shared: Record<string, unknown> = {};
  for (const name of Object.keys(source)) {
    const value = source[name];
    if (typeof value !== 'function') {
      shared[name] = value;
      continue;
    }
    // Looked up per call, not captured, so replacing a method on the source
    // object after wrapping (as `serializeWrite` does) is still honoured.
    shared[name] = (...args: unknown[]) => (source[name] as AsyncMethod)(...args);
  }
  return shared as T;
}
