import { LinearGradient } from 'expo-linear-gradient';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

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
      style={[styles.fade, styles.bottom, { height }]}
    />
  );
}

/** How long the top fade takes to appear once the content moves. */
const DURATION = 180;

/**
 * The same gradient at the top edge, dissolving scrolling content into the
 * header rather than letting it run under a hard line.
 *
 * Unlike {@link BottomFade} this one comes and goes: at rest the first line of a
 * document shouldn't sit behind a wash, so it fades in only once the content has
 * actually moved and back out on the way home. It stays mounted and animates
 * opacity, which keeps both directions smooth.
 */
export function TopFade({
  visible,
  height = 56,
}: {
  visible: boolean;
  height?: number | `${number}%`;
}) {
  const theme = useTheme();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(visible ? 1 : 0, { duration: DURATION });
  }, [visible, progress]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.fade, styles.top, { height }, animatedStyle]}>
      <LinearGradient
        pointerEvents="none"
        colors={[theme.background, withAlpha(theme.background, 0)]}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fade: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  bottom: {
    bottom: 0,
  },
  top: {
    top: 0,
  },
});
