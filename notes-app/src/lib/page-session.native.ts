/**
 * Native stub for the web page-session identity. See `page-session.ts` for what
 * this exists to solve.
 *
 * Native has no documents and no `blob:` URLs — a file path here is a durable
 * `file://` URI that outlives the process — so nothing on this platform is
 * session-scoped and nothing needs stamping. The exports stay so the pair's
 * shapes match (`__tests__/platform-parity.test.ts` enforces that; a missing
 * native counterpart once shipped an app that couldn't launch on device).
 */

/** Native writes durable paths, so one constant marks them all. */
export function pageSessionId(): string {
  return 'native';
}

/**
 * Always `null`: there are no page sessions to enumerate. The caller reads that
 * as "clear unconditionally", which on native is a no-op anyway — the clear only
 * matches `blob:%`, and native never writes one.
 */
export async function liveSessionIds(): Promise<Set<string> | null> {
  return null;
}

/**
 * Identity on native: the database is right here, so a method already runs in
 * the same process that made the call, and there is no session to bind. The
 * column it would stamp is only ever read for `blob:` rows, which this platform
 * never writes.
 */
export function withPageSession<T>(api: T): T {
  return api;
}
