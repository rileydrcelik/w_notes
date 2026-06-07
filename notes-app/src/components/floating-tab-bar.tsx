import Feather from '@expo/vector-icons/Feather';
import { type Href, usePathname, useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Keyboard, Platform, Pressable, StyleSheet, useColorScheme, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassSurface } from '@/components/glass-surface';
import { RightSidebar } from '@/components/right-sidebar';
import { Colors, Spacing, TabBar } from '@/constants/theme';
import { useTabBarBottom } from '@/hooks/use-tab-bar-inset';

/** Tracks on-screen keyboard visibility so the bar can move out of its way. */
function useKeyboardVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => setVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

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
  const insets = useSafeAreaInsets();
  const bottom = useTabBarBottom();
  // The menu tab opens a side drawer instead of navigating to a screen.
  const [menuOpen, setMenuOpen] = useState(false);
  // While the keyboard is up, the bar relocates to the top-right and stacks
  // vertically so it never sits over the keyboard.
  const vertical = useKeyboardVisible();
  // Show back on every page except the home screen (which lives at "/").
  const showBack = pathname !== '/';

  const goBack = () => {
    Keyboard.dismiss();
    if (router.canGoBack()) router.back();
    else router.replace('/' as Href);
  };

  // When docked at the top-right the slots reserve height; otherwise width.
  const slotStyle = vertical ? { height: TabBar.height } : { width: TabBar.height };
  const barSize = vertical
    ? { width: TabBar.height, height: TabBar.width }
    : { width: TabBar.width, height: TabBar.height };
  const hostPlacement = vertical
    ? { top: insets.top + TabBar.margin, right: TabBar.margin, alignItems: 'flex-end' as const }
    : { bottom, left: 0, right: 0, alignItems: 'center' as const };

  return (
    <>
      {/* Rendered before the cluster so the navbar always stacks above the drawer. */}
      <RightSidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      <Animated.View
        pointerEvents="box-none"
        layout={LinearTransition.duration(220)}
        style={[styles.host, hostPlacement]}>
        <View style={[styles.cluster, vertical && styles.clusterVertical]}>
          {/* Leading slot: reserves space so the bar stays centered whether or not back shows. */}
          <View pointerEvents="box-none" style={[styles.sideSlot, slotStyle]}>
            {showBack && (
              <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)}>
                <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={goBack}>
                  <GlassSurface
                    intensity={75}
                    tintOpacity={0.85}
                    style={[styles.backButton, { width: TabBar.height, height: TabBar.height }]}>
                    <Feather name="chevron-left" color={colors.textSecondary} size={26} />
                  </GlassSurface>
                </Pressable>
              </Animated.View>
            )}
          </View>

          <GlassSurface
            intensity={75}
            tintOpacity={0.85}
            style={[styles.bar, vertical && styles.barVertical, barSize]}>
            {state.routes.map((route, index) => {
              const { options } = descriptors[route.key];
              // The menu tab reflects the drawer's open state rather than navigation.
              const isMenu = route.name === 'menu';
              const focused = isMenu ? menuOpen : state.index === index;

              const onPress = () => {
                // Any navbar press dismisses the keyboard before acting.
                Keyboard.dismiss();
                if (isMenu) {
                  setMenuOpen((prev) => !prev);
                  return;
                }
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

          {/* Trailing slot: the create button, mirroring the back button. */}
          <View pointerEvents="box-none" style={[styles.sideSlot, slotStyle]}>
            <CreateButton iconColor={colors.textSecondary} />
          </View>
        </View>
      </Animated.View>
    </>
  );
}

/** Create action; mirrors the back button. No-op for now beyond a press animation. */
function CreateButton({ iconColor }: { iconColor: string }) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const onPress = () => {
    Keyboard.dismiss();
    scale.value = withSequence(
      withTiming(0.82, { duration: 100 }),
      withSpring(1, { damping: 6, stiffness: 220 }),
    );
  };

  return (
    <Animated.View style={animatedStyle}>
      <Pressable accessibilityRole="button" accessibilityLabel="Create" onPress={onPress}>
        <GlassSurface
          intensity={75}
          tintOpacity={0.85}
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
  },
  /** A centered row: [leading slot][bar][trailing slot]; equal slots keep the bar centered. */
  cluster: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  /** Top-right docked layout: the same cluster stacked vertically. */
  clusterVertical: {
    flexDirection: 'column',
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
  barVertical: {
    flexDirection: 'column',
    marginHorizontal: 0,
    marginVertical: Spacing.two,
    paddingHorizontal: 0,
    paddingVertical: Spacing.two,
  },
  item: {
    flex: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
