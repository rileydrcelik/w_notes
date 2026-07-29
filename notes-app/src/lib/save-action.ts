/**
 * Bridges the floating navbar's save button to whatever the focused screen can
 * export.
 *
 * "Save to device" is a navbar action, not a per-screen control — a note being
 * read shows a download icon in the bar itself (see `floating-tab-bar.tsx`),
 * which is where the user already looks for it. The navbar can read a note's
 * body straight from the store, so that case needs no registration; anything
 * else — a resume's compiled PDF, which only the resume screen has — registers
 * its own exporter here and the same navbar icon appears.
 *
 * Registration follows `lib/edit-action.ts` exactly: screens register on focus
 * and clear on blur, and clearing checks the caller still owns the slot, since
 * React Navigation doesn't promise the outgoing screen's cleanup runs before the
 * incoming screen's effect.
 *
 * A screen with nothing to export right now (a resume that hasn't compiled)
 * registers `null`, and the navbar simply doesn't offer the icon — the bar
 * shrinks back, rather than showing a dead button.
 */
export type SaveAction = {
  /** Accessibility label for the navbar button, e.g. "Download resume PDF". */
  label: string;
  run: () => void;
};

let current: SaveAction | null = null;
const listeners = new Set<() => void>();

/** Offer a save action in the navbar; `null` withdraws whatever is registered. */
export function setSaveAction(action: SaveAction | null): void {
  if (current === action) return;
  current = action;
  listeners.forEach((l) => l());
}

/**
 * Withdraw `action`, but only while it's still the registered one. A screen
 * losing focus after its replacement has already registered must not clear the
 * newcomer's action.
 */
export function clearSaveAction(action: SaveAction): void {
  if (current !== action) return;
  setSaveAction(null);
}

/** The registered save action, or null. Stable between renders (snapshot use). */
export function getSaveAction(): SaveAction | null {
  return current;
}

/** Subscribe to registration changes; returns an unsubscribe fn. */
export function subscribeSaveAction(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
