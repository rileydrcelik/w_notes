/**
 * Bridges the floating navbar's trailing button to a screen's version history.
 *
 * The trailing slot holds the create (+) button, which creates a *child* of what
 * you're looking at. A leaf object has no children, so those screens replace it:
 * a note or a copy block offers an edit pencil (`lib/edit-action.ts`), and a
 * resume offers **this** — its version history.
 *
 * A resume doesn't want the pencil. Tapping the compiled preview already opens
 * the source, and in the split layout the source is permanently on screen beside
 * the page, so "start editing" is a click into a field that's already there. A
 * pencil would be a button that moves the caret somewhere you can already see.
 * The history is the one thing about a resume the screen can't show you
 * otherwise, so it takes the slot.
 *
 * Deliberately its own module rather than a generalisation of `edit-action.ts`.
 * The two are nearly identical files and that has been left alone on purpose:
 * each one's docstring exists to say why *that* action belongs in the navbar, and
 * a single generic slot would push icon-and-label conditionals into `note/[id]`
 * and `copa/[id]`, which have no opinion about versions and shouldn't acquire one.
 *
 * Registration follows `lib/edit-action.ts` and `lib/save-action.ts` exactly, and
 * for the same reason: screens register on focus and clear on blur, and React
 * Navigation gives no guarantee that the outgoing screen's cleanup runs before
 * the incoming screen's effect — so clearing checks the caller still owns the
 * slot instead of blindly wiping it. Skip that and the navbar ends up showing a
 * history button for a screen you have already left.
 */
type VersionAction = () => void;

type VersionOptions = {
  /**
   * Hold the slot while an editor is focused instead of yielding it to the
   * app-wide "done" check.
   *
   * The check means "finish editing and go back to the read view", so it's only
   * worth showing when there *is* one to go back to. Laid out side by side the
   * resume has none — source and compiled page are both permanently on screen,
   * and leaving the source is a click into the other pane — so the check would
   * do nothing but flicker in and out as focus moved, displacing the one button
   * that has a job. Stacked, the resume opens in its read view like any other
   * document, so the check earns its place and this stays false.
   */
  keepWhileEditing?: boolean;
};

let current: VersionAction | null = null;
let keepsWhileEditing = false;
const listeners = new Set<() => void>();

/** Offer a version-history action in the navbar; `null` withdraws it. */
export function setVersionAction(action: VersionAction | null, options: VersionOptions = {}): void {
  const keeps = action !== null && options.keepWhileEditing === true;
  if (current === action && keepsWhileEditing === keeps) return;
  current = action;
  keepsWhileEditing = keeps;
  listeners.forEach((l) => l());
}

/**
 * Withdraw `action`, but only while it's still the registered one. A screen
 * losing focus after its replacement has already registered must not clear the
 * newcomer's action.
 */
export function clearVersionAction(action: VersionAction): void {
  if (current !== action) return;
  setVersionAction(null);
}

/** The registered action, or null. Stable between renders (snapshot use). */
export function getVersionAction(): VersionAction | null {
  return current;
}

/**
 * Whether the registered action holds the slot through editing. A separate
 * boolean snapshot rather than a field on an options object, so `useSyncExternal
 * Store` compares a primitive and can't be handed a fresh identity each render.
 */
export function getVersionKeepsWhileEditing(): boolean {
  return keepsWhileEditing;
}

/** Run the registered action. Returns whether there was one. */
export function runVersionAction(): boolean {
  if (!current) return false;
  current();
  return true;
}

/** Subscribe to registration changes; returns an unsubscribe fn. */
export function subscribeVersionAction(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
