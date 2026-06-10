import { Stack } from 'expo-router';

import { useTheme } from '@/hooks/use-theme';

export default function CopaStackLayout() {
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
        gestureEnabled: true,
      }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="[id]" options={{ headerShown: false }} />
    </Stack>
  );
}
