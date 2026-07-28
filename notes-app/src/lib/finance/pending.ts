/**
 * Bridges "export this sheet" to the finance screen's unwritten edits.
 *
 * The screen debounces its writes, so for a moment after a keystroke the newest
 * document exists only in memory. Export reads from SQLite (it's invoked from
 * the navbar, which has no access to the screen's state), and would otherwise
 * hand back a CSV missing whatever was typed in that window — silently, with
 * nothing to indicate a change was dropped.
 *
 * Same shape as `active-editor`: the open screen registers a flush callback and
 * clears it on unmount; anything about to read the stored sheet awaits it first.
 */
let pendingFlush: (() => Promise<void> | void) | null = null;

/** Registers the open finance screen's flush. Pass null to unregister. */
export function registerSheetFlush(fn: (() => Promise<void> | void) | null): void {
  pendingFlush = fn;
}

/**
 * Writes any in-memory sheet edit before the caller reads storage. Safe to call
 * when no finance screen is open, and never rejects — a failed flush must not
 * block an export that can still produce useful (if slightly stale) output.
 */
export async function flushPendingSheet(): Promise<void> {
  if (!pendingFlush) return;
  try {
    await pendingFlush();
  } catch {
    // The screen's own flush reports failures; don't fail the export over it.
  }
}
