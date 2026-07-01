import { useCallback, useRef } from 'react';

/**
 * Web-only: wires a native `contextmenu` (right-click) listener onto a
 * React Native Web host node so right-clicking a card opens the same options
 * menu that a long-press opens on mobile. RNW's `Pressable` doesn't forward
 * `onContextMenu`, so we attach the listener via a callback ref to the
 * underlying DOM element instead.
 *
 * Returns a ref callback to spread onto the `Pressable`. The listener is
 * re-attached whenever the node changes and torn down on unmount.
 */
export function useContextMenu(onOpen: () => void): (node: unknown) => void {
  const detachRef = useRef<(() => void) | null>(null);
  // Keep the latest callback without re-running the ref (which would detach and
  // re-attach the listener on every render).
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  return useCallback((node: unknown) => {
    detachRef.current?.();
    detachRef.current = null;
    const el = node as HTMLElement | null;
    if (!el || typeof el.addEventListener !== 'function') return;
    const handler = (e: Event) => {
      e.preventDefault();
      onOpenRef.current();
    };
    el.addEventListener('contextmenu', handler);
    detachRef.current = () => el.removeEventListener('contextmenu', handler);
  }, []);
}
