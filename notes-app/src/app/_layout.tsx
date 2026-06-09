import { BlurTargetView } from 'expo-blur';
import { DarkTheme, DefaultTheme, ThemeProvider, usePathname } from 'expo-router';
import { TopTabs } from 'expo-router/js-top-tabs';
import { useMemo, useState, type RefObject } from 'react';
import { Platform, StyleSheet, useColorScheme, type View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { FloatingTabBar } from '@/components/floating-tab-bar';
import { CopaOptionsProvider } from '@/components/copa-options-modal';
import { ItemOptionsProvider } from '@/components/item-options-modal';
import { CopaProvider } from '@/store/copa-store';
import { NotesProvider } from '@/store/notes-store';
import { SidebarProvider } from '@/store/sidebar-store';

// Top-level routes that the pager slides between. Everything else (a folder or
// note) lives inside the home group's stack, which keeps its own back-swipe.
const SWIPEABLE_PATHS = ['/', '/copa'];

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const pathname = usePathname();

  // The pager owns horizontal swipes only while on a top-level screen. On a
  // nested stack screen (folder/note) we hand the gesture back so the stack's
  // edge swipe takes the user back instead of flicking to the other tab.
  const swipeEnabled = SWIPEABLE_PATHS.includes(pathname);

  // Android backdrop blur is capture-based: the navbar's BlurView blurs the
  // content of a BlurTargetView, which must wrap the screens but NOT the navbar
  // (a BlurView inside its own target recurses and crashes the renderer). So we
  // host the target around the screens here and hand its ref to the navbar,
  // which renders as a sibling overlay. iOS blurs natively and skips all this.
  const [target, setTarget] = useState<View | null>(null);
  const blurTarget = useMemo<RefObject<View | null> | null>(
    () => (target ? { current: target } : null),
    [target],
  );

  const screens = (
    <TopTabs
      // The floating bar is the only visible navigation, so hide the pager's
      // built-in tab bar; the screens fill the whole pager.
      tabBar={() => null}
      // Open on home; copa sits to its left so a swipe-right reveals it.
      initialRouteName="(home)"
      screenOptions={{ swipeEnabled }}>
      <TopTabs.Screen name="copa" />
      <TopTabs.Screen name="(home)" />
    </TopTabs>
  );

  return (
    <GestureHandlerRootView style={styles.root}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <NotesProvider>
          <CopaProvider>
          <SidebarProvider>
          <ItemOptionsProvider>
          <CopaOptionsProvider>
            <AnimatedSplashOverlay />
            {Platform.OS === 'android' ? (
              <BlurTargetView
                // Cast: expo-blur types `ref` as RefObject, but we need a callback
                // ref to push the node into state once it mounts.
                ref={setTarget as unknown as RefObject<View | null>}
                style={StyleSheet.absoluteFill}>
                {screens}
              </BlurTargetView>
            ) : (
              screens
            )}
            <FloatingTabBar blurTarget={blurTarget} />
          </CopaOptionsProvider>
          </ItemOptionsProvider>
          </SidebarProvider>
          </CopaProvider>
        </NotesProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
