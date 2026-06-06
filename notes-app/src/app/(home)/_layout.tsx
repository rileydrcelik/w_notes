import { Stack } from 'expo-router';
import { useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';

export default function HomeStackLayout() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme === 'dark' ? 'dark' : 'light'];

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
      <Stack.Screen name="index" options={{ title: 'Notes' }} />
      <Stack.Screen name="folder/[id]" options={{ title: '' }} />
      <Stack.Screen name="note/[id]" options={{ title: '' }} />
    </Stack>
  );
}
