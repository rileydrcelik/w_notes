import { useCallback, useEffect, useRef } from 'react';
import { useFocusEffect } from 'expo-router';

import { clearSaveAction, setSaveAction, type SaveAction } from '@/lib/save-action';

/**
 * Offer this screen's "save to device" action to the floating navbar, which
 * shows a download icon in the bar for as long as the screen is focused and the
 * action is available. Pass `null` while there is nothing to export yet (a
 * resume that hasn't compiled) and no icon appears.
 *
 * See `lib/save-action.ts` for why exporting lives in the navbar rather than in
 * a screen's own header. Registering on **focus** (not mount) is what keeps a
 * screen still sitting in the stack below from owning the button.
 */
export function useSaveAction(action: SaveAction | null): void {
  // Read the callback through a ref so a screen can pass a fresh closure every
  // render — over a freshly compiled PDF, say — without re-registering, and so
  // the registered identity stays stable for `clearSaveAction` to match on.
  const latest = useRef(action);
  useEffect(() => {
    latest.current = action;
  });

  // The label is baked into the registered object, so it (unlike `run`) has to
  // re-register when it changes. Screens keep it constant in practice.
  const label = action?.label ?? null;
  useFocusEffect(
    useCallback(() => {
      if (label === null) return;
      const registered: SaveAction = { label, run: () => latest.current?.run() };
      setSaveAction(registered);
      return () => clearSaveAction(registered);
    }, [label]),
  );
}
