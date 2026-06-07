import Feather from '@expo/vector-icons/Feather';
import { DarkTheme, DefaultTheme, Tabs, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { FloatingTabBar } from '@/components/floating-tab-bar';
import { NotesProvider } from '@/store/notes-store';

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <NotesProvider>
        <AnimatedSplashOverlay />
        <Tabs
        tabBar={(props) => <FloatingTabBar {...props} />}
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
            tabBarIcon: ({ color, size }) => (
              <Feather name="settings" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="(home)"
          options={{
            title: 'Home',
            tabBarIcon: ({ color, size }) => (
              <Feather name="home" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="menu"
          options={{
            title: 'Menu',
            tabBarIcon: ({ color, size }) => (
              <Feather name="menu" color={color} size={size} />
            ),
          }}
        />
        </Tabs>
      </NotesProvider>
    </ThemeProvider>
  );
}
