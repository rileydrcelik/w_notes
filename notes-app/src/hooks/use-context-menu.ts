/**
 * Native no-op counterpart of the web hook. Mobile already opens the item menu
 * via long-press and has no right-click, so this returns `undefined` and the
 * shared `ref` prop is simply left unset. See `use-context-menu.web.ts` for the
 * web implementation that wires up a `contextmenu` listener.
 */
export function useContextMenu(_onOpen: () => void): ((node: unknown) => void) | undefined {
  return undefined;
}
