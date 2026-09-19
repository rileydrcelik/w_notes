import { useCallback, useEffect, useRef } from 'react';
import { useFocusEffect } from 'expo-router';

import { clearCreateAction, setCreateAction } from '@/lib/create-action';

/**
 * Tell the navbar's (+) what to create on this screen, for as long as it's
 * focused. See `lib/create-action.ts`. Registered on focus, not mount, for the
 * reason `useEditAction` is: a screen still in the stack below mustn't own it.
 */
export function useCreateAction(onCreate: (() => void) | null): void {
  const latest = useRef(onCreate);
  useEffect(() => {
    latest.current = onCreate;
  });

  const available = onCreate !== null;
  useFocusEffect(
    useCallback(() => {
      if (!available) return;
      const run = () => latest.current?.();
      setCreateAction(run);
      return () => clearCreateAction(run);
    }, [available]),
  );
}
