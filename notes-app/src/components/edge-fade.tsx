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

/**
 * The bottom fade for a scroll area capped inside a glass sheet, rather than one
 * running to the edge of the page.
 *
 * A capped form is where the missing signal actually costs something: the cut at
 * the cap reads as the end of the form rather than the middle of it, and the
 * sheet's button is pinned outside the scroll, so nothing else says more fields
 * exist. `resume-entry-modal.tsx` learned this the expensive way — its
 * Description field read as a field that wasn't there.
 *
 * It ends on the sheet's own tint, not the page background: `GlassSurface` tints
 * with `backgroundElement` at its `tintOpacity`, so matching both makes the
 * gradient vanish into the glass instead of drawing a band across it. Pass the
 * same `tintOpacity` the surface got.
 *
 * Needs a positioned parent — wrap the ScrollView in a `position: 'relative'`
 * view and place this after it, as {@link BottomFade} is placed after a list.
 */
export function SheetFade({
  height = 32,
  tintOpacity = 0.9,
}: {
  height?: number;
  tintOpacity?: number;
}) {
  const theme = useTheme();
  return (
    <LinearGradient
      pointerEvents="none"
      colors={[
        withAlpha(theme.backgroundElement, 0),
        withAlpha(theme.backgroundElement, tintOpacity),
      ]}
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
