import { DarkTheme, DefaultTheme, Tabs, ThemeProvider } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { Colors } from '@/constants/theme';

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';
  const colors = Colors[scheme];

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.text,
          tabBarInactiveTintColor: colors.textSecondary,
          tabBarStyle: { backgroundColor: colors.background },
        }}>
        <Tabs.Screen
          name="settings"
          options={{
            title: 'Settings',
            tabBarIcon: ({ color }) => (
              <SymbolView
                tintColor={color}
                name={{ ios: 'gearshape.fill', android: 'settings', web: 'settings' }}
                size={24}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="(home)"
          options={{
            title: 'Home',
            tabBarIcon: ({ color }) => (
              <SymbolView
                tintColor={color}
                name={{ ios: 'house.fill', android: 'home', web: 'home' }}
                size={24}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="menu"
          options={{
            title: 'Menu',
            tabBarIcon: ({ color }) => (
              <SymbolView
                tintColor={color}
                name={{ ios: 'line.3.horizontal', android: 'menu', web: 'menu' }}
                size={24}
              />
            ),
          }}
        />
      </Tabs>
    </ThemeProvider>
  );
}
