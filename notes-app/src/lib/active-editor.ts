/**
 * Bridges the floating navbar's "done" check to the focused note/copa editor.
 *
 * The native rich editor (`EnrichedTextInput`) isn't registered with
 * React Native's `TextInputState`, so `Keyboard.dismiss()` can't blur it. The
 * active editor registers a dismiss callback here while it's editing, and the
 * navbar calls `dismissActiveEditor()` to blur it and return to the read view.
 */
let activeDismiss: (() => void) | null = null;

export function setActiveEditorDismiss(fn: (() => void) | null): void {
  activeDismiss = fn;
}

/** Dismiss the currently focused editor, if any. Returns whether one handled it. */
export function dismissActiveEditor(): boolean {
  if (!activeDismiss) return false;
  activeDismiss();
  return true;
}
