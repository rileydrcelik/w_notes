import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

/** Expands a #rrggbb color to an `rgba()` string at the given alpha. */
function withAlpha(hex: string, alpha: number) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * A transparent-to-background gradient pinned to the bottom of a screen, fading
 * scrolling content into the page so the floating navbar stays legible. Place it
 * after the list in JSX so it layers above it; the navbar is a sibling overlay
 * in _layout, so the order ends up list -> fade -> navbar.
 */
export function BottomFade({ height = '15%' }: { height?: number | `${number}%` }) {
  const theme = useTheme();
  return (
    <LinearGradient
      pointerEvents="none"
      colors={[withAlpha(theme.background, 0), theme.background]}
      style={[styles.fade, { height }]}
    />
  );
}

const styles = StyleSheet.create({
  fade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
});
