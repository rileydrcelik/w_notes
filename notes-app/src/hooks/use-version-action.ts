import { useCallback, useEffect, useRef } from 'react';
import { useFocusEffect } from 'expo-router';

import { clearVersionAction, setVersionAction } from '@/lib/version-action';

/**
 * Offer this screen's version history to the floating navbar, which turns its
 * trailing button into a history icon for as long as the screen is focused. Pass
 * `null` when there is no history to show and the button stays what it was.
 *
 * See `lib/version-action.ts` for why a resume offers this instead of the edit
 * pencil, and `lib/active-editor.ts` for the part that still wins over it: once
 * an editor takes focus the button becomes the "done" check, whatever it was
 * showing before.
 *
 * Registering on **focus** (not mount) is what keeps a screen still sitting in
 * the stack below from owning the button.
 */
export function useVersionAction(
  onOpen: (() => void) | null,
  options: { keepWhileEditing?: boolean } = {},
): void {
  // Read the callback through a ref so a screen can pass a fresh closure every
  // render without re-registering — and so the registered identity stays stable,
  // which is what `clearVersionAction` matches on.
  const latest = useRef(onOpen);
  useEffect(() => {
    latest.current = onOpen;
  });

  const available = onOpen !== null;
  // Unlike the callback, this one *is* a dependency: it changes when the window
  // crosses the split threshold mid-screen, and the navbar has to hear about it.
  const keepWhileEditing = options.keepWhileEditing === true;
  useFocusEffect(
    useCallback(() => {
      if (!available) return;
      const run = () => latest.current?.();
      setVersionAction(run, { keepWhileEditing });
      return () => clearVersionAction(run);
    }, [available, keepWhileEditing]),
  );
}
