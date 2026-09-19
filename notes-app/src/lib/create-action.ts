/**
 * A screen's own "create" for the navbar's trailing (+).
 *
 * The (+) creates *inside* what you're looking at. Most screens get that for
 * free — a folder's (+) makes a note in it — but a screen whose children aren't
 * notes has to say what (+) makes there: the application tracker adds an
 * application. The screen registers it here while focused (see
 * `hooks/use-create-action.ts`), and the button runs it instead of making a note.
 * It keeps the plus: this is create, not the pencil of `lib/edit-action.ts`.
 */
type CreateAction = () => void;

let current: CreateAction | null = null;
const listeners = new Set<() => void>();

export function setCreateAction(action: CreateAction | null): void {
  if (current === action) return;
  current = action;
  listeners.forEach((l) => l());
}

/** Release the slot, but only if `action` still holds it. */
export function clearCreateAction(action: CreateAction): void {
  if (current !== action) return;
  setCreateAction(null);
}

export function getCreateAction(): CreateAction | null {
  return current;
}

/** Run the registered action. Returns whether there was one. */
export function runCreateAction(): boolean {
  if (!current) return false;
  current();
  return true;
}

export function subscribeCreateAction(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
