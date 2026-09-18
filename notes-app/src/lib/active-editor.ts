/**
 * Bridges the floating navbar's "done" check to the focused note/copa editor.
 *
 * The native rich editor (`EnrichedTextInput`) isn't registered with
 * React Native's `TextInputState`, so `Keyboard.dismiss()` can't blur it. The
 * active editor registers a dismiss callback here while it's editing, and the
 * navbar calls `dismissActiveEditor()` to blur it and return to the read view.
 *
 * On web there's no on-screen keyboard for the navbar to track, so the navbar
 * subscribes here instead: an active editor surfaces the same "done" check.
 */
let activeDismiss: (() => void) | null = null;
let lastDismissAt = 0;
const listeners = new Set<() => void>();

export function setActiveEditorDismiss(fn: (() => void) | null): void {
  if (activeDismiss === fn) return;
  // An editor leaving edit mode (e.g. blurred by tapping the navbar) deactivates
  // here; remember when, so a press landing right after still reads as "done".
  if (fn === null && activeDismiss !== null) lastDismissAt = Date.now();
  activeDismiss = fn;
  listeners.forEach((l) => l());
}

/**
 * Release the slot, but only if `fn` still holds it.
 *
 * An editor torn down while focused has to clear its own registration — a
 * hardware back or an edge-swipe unmounts it without ever firing `onBlur` — but
 * clearing the slot blindly would also clear a *different* editor that has since
 * taken focus, leaving the navbar with no "done" for the editor actually on
 * screen. Same ownership rule as `clearEditAction`.
 */
export function clearActiveEditorDismiss(fn: () => void): void {
  if (activeDismiss !== fn) return;
  setActiveEditorDismiss(null);
}

/** Dismiss the currently focused editor, if any. Returns whether one handled it. */
export function dismissActiveEditor(): boolean {
  if (!activeDismiss) return false;
  activeDismiss();
  return true;
}

/**
 * Whether an editor was active at the very start of an in-flight press.
 *
 * Clicking the navbar "done" check blurs the editor first, which exits edit mode
 * (and clears the active registration) before the click's `onPress` even fires —
 * so by then `dismissActiveEditor()` is a no-op and the button would fall through
 * to its create action. This bridges that gap: a press within `withinMs` of the
 * last deactivation is the tail of that same gesture, i.e. a "done" press.
 */
export function editorJustDismissed(withinMs = 300): boolean {
  return Date.now() - lastDismissAt < withinMs;
}

/** Whether an editor is currently registered as active (in edit mode). */
export function isEditorActive(): boolean {
  return activeDismiss !== null;
}

/** Subscribe to active-editor changes; returns an unsubscribe fn. */
export function subscribeActiveEditor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---- Insert image ----
//
// The formatting bar is rendered by the screen, while the editor that would
// receive an image is a child of it — and on both platforms the insert has to
// run *inside* the editor (it holds the caret, the image index and the
// imperative handle). Rather than thread a callback down through every screen
// that hosts an editor, the focused editor registers the action here, exactly as
// it registers its dismiss above, and the bar calls it.

let activeInsertImage: (() => void) | null = null;

export function setActiveEditorInsertImage(fn: (() => void) | null): void {
  activeInsertImage = fn;
  listeners.forEach((l) => l());
}

/** Release the slot, but only if `fn` still holds it — same ownership rule as
 *  `clearActiveEditorDismiss`: an editor going away must not clear a different
 *  editor's registration. */
export function clearActiveEditorInsertImage(fn: () => void): void {
  if (activeInsertImage !== fn) return;
  setActiveEditorInsertImage(null);
}

/** Whether the focused editor can take an image right now. */
export function canInsertImage(): boolean {
  return activeInsertImage !== null;
}

/** Ask the focused editor to insert an image. Returns whether one handled it. */
export function insertImageIntoActiveEditor(): boolean {
  if (!activeInsertImage) return false;
  activeInsertImage();
  return true;
}
