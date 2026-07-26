import Feather from '@expo/vector-icons/Feather';
import { useEffect } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { GlassSurface } from '@/components/glass-surface';
import { Spacing, TabBar } from '@/constants/theme';
import { useTabBarBottom } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';

/** A touch smaller than the navbar's buttons — this is a secondary affordance. */
const SIZE = 40;
const DURATION = 180;
/** How far the button rises as it fades in. */
const OFFSET = 8;

type ScrollToTopButtonProps = {
  /** Show it once the content is scrolled down (see `useScrollToTop`). */
  visible: boolean;
  onPress: () => void;
};

/**
 * Floating "back to top" button, pinned to the bottom-right corner just above the
 * navbar so it never overlaps it (or the create button, which grows the bar).
 * Render it as the last child of a screen's root view — after the list and any
 * bottom fade — so it layers on top.
 *
 * It stays mounted and fades/rises in and out, which keeps the transition smooth
 * in both directions and off the mount path of the list it belongs to.
 */
export function ScrollToTopButton({ visible, onPress }: ScrollToTopButtonProps) {
  const colors = useTheme();
  const bottom = useTabBarBottom();
  const progress = useSharedValue(0);
  const press = useSharedValue(1);

  useEffect(() => {
    progress.value = withTiming(visible ? 1 : 0, { duration: DURATION });
  }, [visible, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [
      { translateY: (1 - progress.value) * OFFSET },
      // Ease in from slightly small, and dip further on press.
      { scale: (0.9 + progress.value * 0.1) * press.value },
    ],
  }));

  return (
    <Animated.View
      // Untouchable while hidden, so it can't swallow taps on the cards beneath.
      pointerEvents={visible ? 'auto' : 'none'}
      style={[
        styles.host,
        animatedStyle,
        { bottom: bottom + TabBar.height + Spacing.two, right: TabBar.margin },
      ]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Scroll to top"
        onPressIn={() => {
          press.value = withTiming(0.92, { duration: 80 });
        }}
        onPressOut={() => {
          press.value = withTiming(1, { duration: 120 });
        }}
        onPress={onPress}>
        <GlassSurface intensity={75} tintOpacity={0.85} style={styles.button}>
          <Feather name="arrow-up" color={colors.textSecondary} size={22} />
        </GlassSurface>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
  },
  button: {
    width: SIZE,
    height: SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.three,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
});
