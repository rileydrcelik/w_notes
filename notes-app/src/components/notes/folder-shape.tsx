import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { Accent, Spacing } from '@/constants/theme';
import {
  selectedFill,
  selectionFill,
  selectionOutline,
  useSelectionFade,
} from '@/hooks/use-selection-fade';
import { useTheme } from '@/hooks/use-theme';

const TAB = Spacing.three; // tab height, and the run of the 45° slant that ends it
const TAB_WIDTH = '55%'; // shared by the tab row and the top edge that resumes after it
const BORDER = 2; // selection outline, the same weight a note card uses
const SLANT = TAB * Math.SQRT2; // length of the slant itself
const STROKE = SLANT + BORDER * 2; // overshoots both corners it meets; the row clips the excess
// Centres the stroke inside the slant, the way a border sits inside its box —
// less the half pixel that keeps it over the triangle's antialiased edge.
const INSET = Math.SQRT1_2 * (BORDER / 2 - 0.5);

/**
 * The folder silhouette — a tab whose flat top slopes down to the body at 45° —
 * with the whole outline, tab included, drawn when it is selected.
 *
 * Selection can't be a border on the body alone: the body is a rectangle, so its
 * top border would draw a line straight through the seam where the tab meets it,
 * and the tab would sit outside the highlight entirely. The outline is assembled
 * edge by edge instead. The body draws every edge but its top; the tab draws the
 * top and left of its flat; a bar rotated onto the hypotenuse strokes the slant;
 * and `topEdge` picks the top back up at the point the tab ends, carrying the
 * body's top-right corner with it.
 *
 * Both the tab and the body reserve that outline's width as a border up front,
 * so picking it up doesn't move the shape. On native the reserved width is not
 * free: a view with a border radius draws its background against the *inner*
 * path, so a transparent border shows the page through it rather than the fill.
 * Against the outside of the silhouette that's invisible — the card is a
 * couple of pixels smaller and nothing else. Along the seam where the tab lands
 * on the body two of those insets meet, and the folder splits in half. So the
 * edges that face inwards aren't left transparent; they're painted with the
 * fill, and the seam closes. Web paints under its borders and is unchanged.
 */
export function FolderShape({
  selected,
  accent,
  children,
}: {
  selected: boolean;
  /** The folder's own colour, painted on the tab; null/absent for the theme. */
  accent?: string | null;
  children: ReactNode;
}) {
  const theme = useTheme();
  const progress = useSelectionFade(selected);
  const resting = theme.backgroundElement;
  const wash = selectedFill(theme);
  // Without a colour, tab and body take one fill so they read as a single sheet
  // of paper. With one, the tab carries it — and keeps it through selection: the
  // outline is what says "selected", and a tab that washed out to the selection
  // tint would make every coloured folder look alike while picked.
  const tabResting = accent ?? resting;
  const tabWash = accent ?? wash;

  const fill = useAnimatedStyle(() => ({
    backgroundColor: selectionFill(progress, resting, wash),
  }));
  const tabFill = useAnimatedStyle(() => ({
    backgroundColor: selectionFill(progress, tabResting, tabWash),
  }));
  const slantFill = useAnimatedStyle(() => ({
    borderBottomColor: selectionFill(progress, tabResting, tabWash),
  }));
  // The two edges of the tab's flat that are on the outside of the silhouette.
  // Its other two face the slant and the body, so they take the fill instead.
  const flatEdges = useAnimatedStyle(() => {
    const color = selectionOutline(progress);
    const seam = selectionFill(progress, tabResting, tabWash);
    return {
      borderTopColor: color,
      borderLeftColor: color,
      borderRightColor: seam,
      borderBottomColor: seam,
    };
  });
  // Every edge of the body but its top, which the tab lands on — that one is a
  // seam, so it takes the fill.
  const bodyEdges = useAnimatedStyle(() => {
    const color = selectionOutline(progress);
    return {
      borderLeftColor: color,
      borderRightColor: color,
      borderBottomColor: color,
      borderTopColor: selectionFill(progress, resting, wash),
    };
  });
  // The pieces that are outline and nothing else, so they fade as a whole.
  const stroke = useAnimatedStyle(() => ({ opacity: progress.value }));

  return (
    <View style={styles.shape}>
      <View style={styles.tabRow}>
        <Animated.View style={[styles.flat, tabFill, flatEdges]} />
        <View style={styles.slant}>
          <Animated.View style={[styles.slantFill, slantFill]} />
          <Animated.View pointerEvents="none" style={[styles.slantStroke, stroke]} />
        </View>
      </View>
      <Animated.View style={[styles.body, fill, bodyEdges]}>{children}</Animated.View>
      <Animated.View pointerEvents="none" style={[styles.topEdge, stroke]} />
      <Animated.View pointerEvents="none" style={[styles.leftJoin, stroke]} />
    </View>
  );
}

const styles = StyleSheet.create({
  shape: {
    flex: 1,
  },
  tabRow: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    width: TAB_WIDTH,
    height: TAB,
    // Clips the slant stroke where it overshoots the corners it has to reach.
    overflow: 'hidden',
  },
  flat: {
    flex: 1,
    height: '100%',
    borderTopLeftRadius: TAB,
    // Border reserved so the outline doesn't shift the shape; every side's
    // colour is set by the animated style above.
    borderWidth: BORDER,
    borderColor: 'transparent',
  },
  slant: {
    width: TAB,
    height: '100%',
  },
  // Right triangle: hypotenuse drops top-left → bottom-right at 45° (equal sides).
  slantFill: {
    width: 0,
    height: 0,
    borderBottomWidth: TAB,
    borderRightWidth: TAB,
    borderRightColor: 'transparent',
  },
  slantStroke: {
    position: 'absolute',
    width: STROKE,
    height: BORDER,
    left: TAB / 2 - INSET - STROKE / 2,
    top: TAB / 2 + INSET - BORDER / 2,
    backgroundColor: Accent,
    transform: [{ rotate: '45deg' }],
  },
  body: {
    flex: 1,
    borderRadius: Spacing.three,
    borderTopLeftRadius: 0,
    padding: Spacing.three,
    gap: Spacing.two,
    // Border reserved so the outline doesn't shift the shape; every side's
    // colour is set by the animated style above.
    borderWidth: BORDER,
    borderColor: 'transparent',
  },
  // The top edge from where the slant lands to the body's top-right corner.
  topEdge: {
    position: 'absolute',
    left: TAB_WIDTH,
    // Back under the slant by a border's width, so the two meet with no notch.
    marginLeft: -BORDER,
    right: 0,
    top: TAB,
    height: Spacing.three + BORDER,
    borderTopWidth: BORDER,
    borderRightWidth: BORDER,
    borderColor: Accent,
    borderTopRightRadius: Spacing.three,
  },
  // Tab and body each mitre their left border where they meet, against a
  // neighbouring edge that carries the fill rather than the outline; this fills
  // the two small bites that leaves.
  leftJoin: {
    position: 'absolute',
    left: 0,
    top: TAB - BORDER,
    width: BORDER,
    height: BORDER * 2,
    backgroundColor: Accent,
  },
});
