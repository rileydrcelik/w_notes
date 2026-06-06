import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Spacing, TabBar } from '@/constants/theme';

/**
 * Bottom offset for the floating tab bar. Always clears the safe-area inset
 * (e.g. the on-screen home bar) and adds a margin so the two never overlap.
 */
export function useTabBarBottom() {
  const insets = useSafeAreaInsets();
  return insets.bottom + TabBar.margin;
}

/**
 * Bottom padding scrollable content needs so it isn't hidden behind the
 * floating tab bar (bar height + its bottom offset + a little breathing room).
 */
export function useTabBarInset() {
  return useTabBarBottom() + TabBar.height + Spacing.three;
}
