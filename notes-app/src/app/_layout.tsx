import Feather from '@expo/vector-icons/Feather';
import { BlurTargetView } from 'expo-blur';
import { DarkTheme, DefaultTheme, Tabs, ThemeProvider } from 'expo-router';
import { useMemo, useState, type RefObject } from 'react';
import { Platform, StyleSheet, useColorScheme, type View } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { FloatingTabBar } from '@/components/floating-tab-bar';
import { ItemOptionsProvider } from '@/components/item-options-modal';
import { NotesProvider } from '@/store/notes-store';

export default function RootLayout() {
  const colorScheme = useColorScheme();

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
    <Tabs
      // The floating bar is rendered as a sibling overlay (see below) so it can
      // sit outside the Android blur target; hide the built-in bar.
      tabBar={() => null}
      // Keep the few tab screens mounted; freezing/detaching them mid-shift
      // animation can leave a screen stuck blank on rapid switching.
      detachInactiveScreens={false}
      screenOptions={{
        headerShown: false,
        animation: 'shift',
        freezeOnBlur: false,
      }}>
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => <Feather name="settings" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="(home)"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Feather name="home" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="menu"
        options={{
          title: 'Menu',
          tabBarIcon: ({ color, size }) => <Feather name="menu" color={color} size={size} />,
        }}
      />
    </Tabs>
  );

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <NotesProvider>
        <ItemOptionsProvider>
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
        </ItemOptionsProvider>
      </NotesProvider>
    </ThemeProvider>
  );
}
