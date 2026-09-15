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
export function shareDbAcrossTabs<T extends object>(api: T): T {
  return api;
}
