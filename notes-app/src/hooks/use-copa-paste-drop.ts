/**
 * Native no-op counterpart of the web hook. There's no clipboard-paste key combo
 * or drag-and-drop surface on a phone — files come in through the picker via the
 * create menu — so this reports "never dragging" and the drop overlay never
 * shows. See `use-copa-paste-drop.web.ts` for the web implementation.
 */
export function useCopaPasteDrop(): { dragging: boolean } {
  return { dragging: false };
}
