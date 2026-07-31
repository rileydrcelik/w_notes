import { useCallback, useEffect, useRef } from 'react';
import { useFocusEffect } from 'expo-router';

import { clearEditAction, setEditAction } from '@/lib/edit-action';

/**
 * Offer this screen's "start editing" action to the floating navbar, which turns
 * its trailing (+) into a pencil for as long as the screen is focused. Pass
 * `null` when there is nothing to edit (a copa block holding a file, say) and
 * the button stays the plain create button.
 *
 * Use this on any screen showing a *leaf* object — one with no children to
 * create. See `lib/edit-action.ts` for why, and `lib/active-editor.ts` for the
 * other half of the gesture: once the editor is focused the pencil becomes the
 * "done" check.
 *
 * Registering on **focus** (not mount) is what keeps a screen still sitting in
 * the stack below from owning the button.
 */
export function useEditAction(onEdit: (() => void) | null): void {
  // Read the callback through a ref so a screen can pass a fresh closure every
  // render without re-registering — and so the registered identity stays stable,
  // which is what `clearEditAction` matches on.
  const latest = useRef(onEdit);
  useEffect(() => {
    latest.current = onEdit;
  });

  const available = onEdit !== null;
  useFocusEffect(
    useCallback(() => {
      if (!available) return;
      const run = () => latest.current?.();
      setEditAction(run);
      return () => clearEditAction(run);
    }, [available]),
  );
}
