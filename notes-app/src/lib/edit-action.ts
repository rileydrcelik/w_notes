/**
 * Bridges the floating navbar's edit button to the focused screen's editor.
 *
 * The trailing navbar slot holds the create (+) button, which creates a *child*
 * of whatever you're looking at — a note inside a folder, an issue inside a
 * project. A leaf object (a note, a copy block, a resume, a sheet) has no
 * children to create, so on those screens the slot would offer an action that
 * makes no sense there; it used to add a sibling note in the parent folder,
 * which is not what "+ while reading a note" reads as.
 *
 * So a leaf screen registers here, and the navbar's trailing button becomes a
 * pencil that opens that screen's editor. Once the editor is focused the
 * existing "done" check takes over (see `lib/active-editor.ts`), which is the
 * other half of the same gesture: pencil to edit, check to finish.
 *
 * Registration is keyed by the callback's own identity rather than by route.
 * Screens register on focus and clear on blur, and React Navigation gives no
 * guarantee that the outgoing screen's cleanup runs before the incoming
 * screen's effect — so clearing checks that the caller still owns the slot
 * instead of blindly wiping it.
 */
type EditAction = () => void;

let current: EditAction | null = null;
const listeners = new Set<() => void>();

/** Offer an edit action in the navbar; `null` withdraws whatever is registered. */
export function setEditAction(action: EditAction | null): void {
  if (current === action) return;
  current = action;
  listeners.forEach((l) => l());
}

/**
 * Withdraw `action`, but only while it's still the registered one. A screen
 * losing focus after its replacement has already registered must not clear the
 * newcomer's action.
 */
export function clearEditAction(action: EditAction): void {
  if (current !== action) return;
  setEditAction(null);
}

/** The registered edit action, or null. Stable between renders (snapshot use). */
export function getEditAction(): EditAction | null {
  return current;
}

/** Run the registered edit action. Returns whether there was one. */
export function runEditAction(): boolean {
  if (!current) return false;
  current();
  return true;
}

/** Subscribe to registration changes; returns an unsubscribe fn. */
export function subscribeEditAction(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
