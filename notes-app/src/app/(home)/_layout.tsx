import { Stack } from 'expo-router';

import { useTheme } from '@/hooks/use-theme';

export default function HomeStackLayout() {
  const colors = useTheme();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.background },
        animation: 'slide_from_right',
        animationDuration: 300,
        // Back navigation lives in the floating tab bar; hide the native one.
        headerBackVisible: false,
        // Swipe right anywhere on a folder/note screen to go back, not just
        // from the left edge.
        gestureEnabled: true,
        fullScreenGestureEnabled: true,
      }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="folder/[id]" options={{ title: '' }} />
      <Stack.Screen name="note/[id]" options={{ title: '' }} />
      <Stack.Screen name="sentry/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="menu" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
      <Stack.Screen name="favorites" options={{ headerShown: false }} />
      <Stack.Screen name="shared" options={{ headerShown: false }} />
      <Stack.Screen name="trash" options={{ headerShown: false }} />
    </Stack>
  );
}
