import Feather from '@expo/vector-icons/Feather';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { type Href, usePathname, useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  useColorScheme,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Colors, Spacing, TabBar } from '@/constants/theme';
import { useTabBarBottom } from '@/hooks/use-tab-bar-inset';

// Real blur is available with iOS Liquid Glass; elsewhere GlassView renders a
// plain view, so we supply a solid fallback background to match the old look.
const LIQUID_GLASS = isLiquidGlassAvailable();

type TabIconProps = { focused: boolean; color: string; size: number };

type FloatingTabBarProps = {
  state: { index: number; routes: { key: string; name: string }[] };
  descriptors: Record<
    string,
    { options: { tabBarIcon?: (props: TabIconProps) => ReactNode } }
  >;
  navigation: {
    emit: (event: { type: 'tabPress'; target: string; canPreventDefault: true }) => {
      defaultPrevented: boolean;
    };
    navigate: (name: string) => void;
  };
};

export function FloatingTabBar({ state, descriptors, navigation }: FloatingTabBarProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const colors = Colors[scheme];
  const router = useRouter();
  const pathname = usePathname();
  const bottom = useTabBarBottom();
  // Show back on every page except the home screen (which lives at "/").
  const showBack = pathname !== '/';

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/' as Href);
  };

  return (
    <View pointerEvents="box-none" style={[styles.host, { bottom }]}>
      <View style={styles.cluster}>
        {/* Left slot: reserves space so the bar stays centered whether or not back shows. */}
        <View pointerEvents="box-none" style={[styles.sideSlot, { width: TabBar.height }]}>
          {showBack && (
            <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)}>
              <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={goBack}>
                <GlassSurface
                  style={[styles.backButton, { width: TabBar.height, height: TabBar.height }]}>
                  <Feather name="chevron-left" color={colors.textSecondary} size={26} />
                </GlassSurface>
              </Pressable>
            </Animated.View>
          )}
        </View>

        <GlassSurface style={[styles.bar, { width: TabBar.width, height: TabBar.height }]}>
          {state.routes.map((route, index) => {
            const { options } = descriptors[route.key];
            const focused = state.index === index;

            const onPress = () => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented) {
                navigation.navigate(route.name);
              }
            };

            return (
              <Pressable
                key={route.key}
                accessibilityRole="button"
                accessibilityState={focused ? { selected: true } : {}}
                onPress={onPress}
                style={styles.item}>
                {options.tabBarIcon?.({
                  focused,
                  color: focused ? '#7a89b8' : colors.textSecondary,
                  size: 28,
                })}
              </Pressable>
            );
          })}
        </GlassSurface>

        {/* Right slot: the create button, mirroring the back button on the left. */}
        <View pointerEvents="box-none" style={[styles.sideSlot, { width: TabBar.height }]}>
          <CreateButton iconColor={colors.textSecondary} />
        </View>
      </View>
    </View>
  );
}

/**
 * Frosted-glass surface: native Liquid Glass where available (iOS 26+),
 * otherwise a blurred translucent BlurView (incl. real blur on Android).
 */
function GlassSurface({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';

  if (LIQUID_GLASS) {
    const tint = scheme === 'dark' ? 'rgba(33,34,37,0.2)' : 'rgba(240,240,243,0.2)';
    return (
      <GlassView glassEffectStyle="clear" tintColor={tint} style={style}>
        {children}
      </GlassView>
    );
  }

  return (
    <BlurView
      intensity={50}
      tint={scheme}
      blurMethod="dimezisBlurView"
      style={[style, styles.blurClip]}>
      {children}
    </BlurView>
  );
}

/** Create action; mirrors the back button. No-op for now beyond a press animation. */
function CreateButton({ iconColor }: { iconColor: string }) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const onPress = () => {
    scale.value = withSequence(
      withTiming(0.82, { duration: 100 }),
      withSpring(1, { damping: 6, stiffness: 220 }),
    );
  };

  return (
    <Animated.View style={animatedStyle}>
      <Pressable accessibilityRole="button" accessibilityLabel="Create" onPress={onPress}>
        <GlassSurface
          style={[styles.createButton, { width: TabBar.height, height: TabBar.height }]}>
          <Feather name="plus" color={iconColor} size={26} />
        </GlassSurface>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  /** A centered row: [left slot][bar][right slot]; equal-width slots keep the bar centered. */
  cluster: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sideSlot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderTopLeftRadius: Spacing.three * 2,
    borderTopRightRadius: Spacing.three,
    borderBottomLeftRadius: Spacing.three,
    borderBottomRightRadius: Spacing.three,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
  createButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderTopLeftRadius: Spacing.three,
    borderTopRightRadius: Spacing.three,
    borderBottomLeftRadius: Spacing.three,
    borderBottomRightRadius: Spacing.three * 2,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    marginHorizontal: Spacing.two,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.two,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  // Clip the BlurView to the rounded corners (Android needs this).
  blurClip: {
    overflow: 'hidden',
  },
});
