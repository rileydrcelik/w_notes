import { useEffect } from 'react';
import {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { Accent, hexToRgba, lerpColor, type Palette, type ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** How long a card takes to pick up the selection highlight, or drop it. */
export const SelectionFadeMs = 160;

/** How much accent a selected surface takes on. */
const Tint = 0.12;

/** The accent at zero alpha — what an outline fades *from*, so only alpha moves. */
const Clear = hexToRgba(Accent, 0);

/**
 * The fill a selected card settles at: the accent wash, already composited over
 * the page behind it.
 *
 * Opaque on purpose. A wash *is* translucent, but fading a surface from an
 * opaque resting colour to a translucent one moves alpha and hue at once, and
 * the surface dips through a far stronger blue on the way — a flash, in the
 * middle of an animation whose whole job is to not flash. Composited up front,
 * the fade is a straight line between two colours that both already exist.
 */
export function selectedFill(theme: Palette): string {
  return lerpColor(theme.background, Accent, Tint);
}

/**
 * 0 while a card is unselected, 1 while it is, eased between the two.
 *
 * Selection is a state a card settles into rather than a flash, so nothing about
 * it snaps. Everything the highlight touches reads this one value: fill, outline,
 * and — on a folder — each piece of the silhouette's outline separately, since
 * that outline is assembled from parts that can't share a single border.
 */
export function useSelectionFade(selected: boolean): SharedValue<number> {
  const progress = useSharedValue(selected ? 1 : 0);
  useEffect(() => {
    progress.value = withTiming(selected ? 1 : 0, { duration: SelectionFadeMs });
  }, [selected, progress]);
  return progress;
}

/** The fill and outline of a plain rectangular card, faded by `useSelectionFade`. */
export function useSelectionSurface(selected: boolean, resting: ThemeColor) {
  const theme = useTheme();
  const progress = useSelectionFade(selected);
  const from = theme[resting];
  const to = selectedFill(theme);

  return useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [from, to]),
    borderColor: interpolateColor(progress.value, [0, 1], [Clear, Accent]),
  }));
}

/**
 * The outline colour on its own, for a shape that outlines edge by edge. A
 * worklet, not a hook — call it from inside a `useAnimatedStyle`.
 */
export function selectionOutline(progress: SharedValue<number>): string {
  'worklet';
  return interpolateColor(progress.value, [0, 1], [Clear, Accent]);
}

/** The fill on its own, between the two colours `selectedFill` sits between. */
export function selectionFill(progress: SharedValue<number>, from: string, to: string): string {
  'worklet';
  return interpolateColor(progress.value, [0, 1], [from, to]);
}
