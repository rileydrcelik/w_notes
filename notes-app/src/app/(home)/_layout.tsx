import { Stack } from 'expo-router';

import { useTheme } from '@/hooks/use-theme';

/**
 * Put home underneath every screen this stack can open.
 *
 * Without this, landing straight on a nested URL — a web reload on `/note/x`, an
 * opened link, a tab promoted by the DB guard — builds a stack containing only
 * that screen. Back then has nothing to pop, so the action escapes this stack
 * and gets handled by the pager above, which slides to the copa tab: the reported
 * "back sometimes takes me to copa". Anchoring to `index` gives a deep-linked
 * screen the home screen beneath it, so back pops to where it looks like it
 * should. It costs nothing on an ordinary in-app navigation, where index is
 * already there.
 */
export const unstable_settings = { anchor: 'index' };

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
      <Stack.Screen name="github/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="finance/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="resume/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="project/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="project/[id]/new" options={{ headerShown: false }} />
      <Stack.Screen name="project/[id]/type/[typeId]" options={{ headerShown: false }} />
      <Stack.Screen name="menu" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
      <Stack.Screen name="favorites" options={{ headerShown: false }} />
      <Stack.Screen name="shared" options={{ headerShown: false }} />
      <Stack.Screen name="trash" options={{ headerShown: false }} />
    </Stack>
  );
}
