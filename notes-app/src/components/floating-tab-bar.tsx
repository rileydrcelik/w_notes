import Feather from '@expo/vector-icons/Feather';
import { type Href, usePathname, useRouter } from 'expo-router';
import type { ComponentProps, RefObject } from 'react';
import { useEffect, useState } from 'react';
import { Keyboard, Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassSurface } from '@/components/glass-surface';
import { RightSidebar } from '@/components/right-sidebar';
import { dismissActiveEditor } from '@/lib/active-editor';
import { Spacing, TabBar } from '@/constants/theme';
import { useTabBarBottom } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useCopa } from '@/store/copa-store';
import { useNotes } from '@/store/notes-store';
import { useSidebar } from '@/store/sidebar-store';

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

type FeatherName = ComponentProps<typeof Feather>['name'];

/**
 * The fixed tab set. `menu` opens the side drawer and `copy` triggers the
 * copy/paste action (no route); the rest map to their screen. Order mirrors
 * the screens declared in _layout.
 */
const TABS: { key: string; icon: FeatherName; path?: Href }[] = [
  { key: 'copa', icon: 'clipboard', path: '/copa' as Href },
  { key: 'home', icon: 'home', path: '/' as Href },
  { key: 'menu', icon: 'menu' },
];

type FloatingTabBarProps = {
  /** Android blur target (ref to the screens' BlurTargetView); null elsewhere. */
  blurTarget?: RefObject<View | null> | null;
};

export function FloatingTabBar({ blurTarget }: FloatingTabBarProps) {
  const colors = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const bottom = useTabBarBottom();
  // The menu tab opens a side drawer instead of navigating to a screen. Its
  // open state is shared (via context) so the home screen's left-swipe can open
  // the same drawer.
  const { open: menuOpen, setOpen: setMenuOpen } = useSidebar();
  // Copa is the only sibling tab; everything else lives under the home group.
  // Its editor lives at /copa/[id], so match the whole copa stack.
  const onCopa = pathname === '/copa' || pathname.startsWith('/copa/');
  // While the keyboard is up, the bar relocates to the top-right and stacks
  // vertically so it never sits over the keyboard.
  const vertical = useKeyboardVisible();
  // Show back on every page except the home screen (which lives at "/").
  const showBack = pathname !== '/';

  const goBack = () => {
    dismissActiveEditor();
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
      {/* The navbar steps aside while the drawer is open. */}
      {!menuOpen && (
      <Animated.View
        pointerEvents="box-none"
        entering={FadeIn.duration(200)}
        exiting={FadeOut.duration(150)}
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
                    tintOpacity={0.5}
                    blurTarget={blurTarget}
                    style={[styles.backButton, { width: TabBar.height, height: TabBar.height }]}>
                    <Feather name="chevron-left" color={colors.textSecondary} size={26} />
                  </GlassSurface>
                </Pressable>
              </Animated.View>
            )}
          </View>

          <GlassSurface
            intensity={75}
            tintOpacity={0.5}
            blurTarget={blurTarget}
            style={[styles.bar, vertical && styles.barVertical, barSize]}>
            {TABS.map((tab) => {
              // The menu tab reflects the drawer's open state rather than
              // navigation; copa is active on its own route, home on everything else.
              const isMenu = tab.key === 'menu';
              const focused = isMenu ? menuOpen : tab.key === 'copa' ? onCopa : !onCopa;

              const onPress = () => {
                // Any navbar press dismisses the keyboard before acting.
                Keyboard.dismiss();
                if (isMenu) {
                  setMenuOpen((prev) => !prev);
                  return;
                }
                if (tab.path) router.navigate(tab.path);
              };

              return (
                <Pressable
                  key={tab.key}
                  accessibilityRole="button"
                  accessibilityState={focused ? { selected: true } : {}}
                  onPress={onPress}
                  style={styles.item}>
                  <Feather
                    name={tab.icon}
                    color={focused ? '#7a89b8' : colors.textSecondary}
                    size={28}
                  />
                </Pressable>
              );
            })}
          </GlassSurface>

          {/* Trailing slot: the create button, mirroring the back button. */}
          <View pointerEvents="box-none" style={[styles.sideSlot, slotStyle]}>
            <CreateButton
              iconColor={colors.textSecondary}
              keyboardVisible={vertical}
              blurTarget={blurTarget}
            />
          </View>
        </View>
      </Animated.View>
      )}
    </>
  );
}

/**
 * Trailing action button. With the keyboard up it becomes a "done" affordance —
 * a check that dismisses the keyboard; otherwise it's the create (+) button that
 * adds a note in the current location (a folder, or the root) and opens it.
 */
function CreateButton({
  iconColor,
  keyboardVisible,
  blurTarget,
}: {
  iconColor: string;
  keyboardVisible: boolean;
  blurTarget?: RefObject<View | null> | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { createNote, getNote } = useNotes();
  const { createCopa } = useCopa();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  // Resolve the folder the new note should land in from the current route:
  // a folder screen creates inside that folder, a note screen alongside its
  // sibling notes, and everywhere else (e.g. home) at the root.
  const targetFolderId = (): string | null => {
    const folderMatch = pathname.match(/^\/folder\/([^/]+)/);
    if (folderMatch) return decodeURIComponent(folderMatch[1]);
    const noteMatch = pathname.match(/^\/note\/([^/]+)/);
    if (noteMatch) return getNote(decodeURIComponent(noteMatch[1]))?.folderId ?? null;
    return null;
  };

  const onPress = () => {
    // Blur the native rich editor (Keyboard.dismiss can't) before dismissing.
    dismissActiveEditor();
    Keyboard.dismiss();
    // With the keyboard up this button just confirms/dismisses; otherwise create.
    if (keyboardVisible) return;
    // On the copa tab the button creates a copy block; elsewhere, a note.
    if (pathname === '/copa' || pathname.startsWith('/copa/')) {
      const id = createCopa();
      router.push({ pathname: '/copa/[id]', params: { id } });
      return;
    }
    const id = createNote(targetFolderId());
    router.push({ pathname: '/note/[id]', params: { id } });
  };

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={keyboardVisible ? 'Done' : 'Create'}
        onPressIn={() => {
          scale.value = withTiming(0.92, { duration: 80 });
        }}
        onPressOut={() => {
          scale.value = withTiming(1, { duration: 120 });
        }}
        onPress={onPress}>
        <GlassSurface
          intensity={75}
          tintOpacity={0.85}
          blurTarget={blurTarget}
          style={[styles.createButton, { width: TabBar.height, height: TabBar.height }]}>
          <Feather
            name={keyboardVisible ? 'check' : 'plus'}
            color={iconColor}
            size={26}
          />
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
