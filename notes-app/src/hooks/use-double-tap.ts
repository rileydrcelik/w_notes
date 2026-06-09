import { useCallback, useEffect, useRef } from 'react';

/**
 * Returns an `onPress` handler that tells a single tap from a double tap on the
 * same element. A single tap runs `onSingle` after a short delay; a second tap
 * inside that window cancels it and runs `onDouble` instead. This lets a card
 * act on tap (navigate, copy) while a double tap favorites it, without the
 * single-tap action firing first.
 */
export function useDoubleTap(onSingle: () => void, onDouble: () => void, delay = 220) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  return useCallback(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
      onDouble();
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = undefined;
      onSingle();
    }, delay);
  }, [onSingle, onDouble, delay]);
}
