import { useCallback } from 'react';
import { Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

const OFFSET = 24;
// Web screen-transition duration (ms).
const DURATION = 500;

/**
 * A focus-driven enter transition for web, where the navigation stack keeps
 * screens mounted and toggles them — so neither push nor pop animates, and the
 * reanimated enter/exit layout animations never fire. Instead we animate the
 * screen each time it *gains focus*, which fires on both forward navigation and
 * back (when the revealed screen refocuses), giving every transition — including
 * the navbar's back arrow — a smooth fade-and-slide.
 *
 * No-op on native: those platforms have real stack transitions, so the shared
 * value stays settled and the returned style is a steady identity.
 */
export function useScreenFadeStyle() {
  // Web starts hidden so the first focus fades it in; native starts settled.
  const progress = useSharedValue(Platform.OS === 'web' ? 0 : 1);

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'web') return;
      progress.value = 0;
      progress.value = withTiming(1, { duration: DURATION });
    }, [progress]),
  );

  return useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateX: (1 - progress.value) * OFFSET }],
  }));
}
