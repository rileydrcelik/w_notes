import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Stack } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useColorScheme as useDeviceScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, hexToRgba, Spacing, type Palette } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth/auth-context';
import { useEditorPrefs } from '@/store/editor-prefs-store';
import { useThemePref, type ThemeKey } from '@/store/theme-store';

const ACCENT = '#7a89b8';

const THEME_OPTIONS: { key: ThemeKey; label: string; description: string }[] = [
  { key: 'system', label: 'System', description: 'Match your device' },
  { key: 'dark', label: 'Dark', description: 'Dark background, light text' },
  { key: 'solarized', label: 'Solarized Light', description: 'Warm, low-contrast paper' },
  { key: 'solarizedDark', label: 'Solarized Dark', description: 'Deep teal, low-contrast' },
];

export default function SettingsScreen() {
  const { themeKey, setThemeKey } = useThemePref();
  const device = useDeviceScheme();
  const tabBarInset = useTabBarInset();

  // Each swatch previews the palette it applies; System resolves to the device.
  const previewPalette = (key: ThemeKey): Palette => {
    if (key === 'dark') return Colors.dark;
    if (key === 'solarized') return Colors.solarizedLight;
    if (key === 'solarizedDark') return Colors.solarizedDark;
    return Colors[device === 'dark' ? 'dark' : 'light'];
  };

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <SafeAreaView style={styles.safeArea} edges={['top']}>
          <ScrollView contentContainerStyle={[styles.content, { paddingBottom: tabBarInset }]}>
            {/* Centered, width-capped column so rows don't stretch edge-to-edge
                on web's wide viewport (a no-op on narrower phone screens). */}
            <View style={styles.inner}>
            <ThemedText type="subtitle" style={styles.title}>
              Settings
            </ThemedText>

            <AccountSection />

            <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
              APPEARANCE
            </ThemedText>

            <View style={styles.options}>
              {THEME_OPTIONS.map((option) => {
                const selected = themeKey === option.key;
                const preview = previewPalette(option.key);
                return (
                  <Pressable
                    key={option.key}
                    onPress={() => setThemeKey(option.key)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={option.label}
                    style={({ pressed }) => [pressed && styles.pressed]}>
                    <ThemedView
                      type="backgroundElement"
                      style={[styles.row, selected && { borderColor: ACCENT }]}>
                      {/* Mini preview of the theme's surface + text colors. */}
                      <View style={[styles.swatch, { backgroundColor: preview.background }]}>
                        <View style={[styles.swatchBar, { backgroundColor: preview.text }]} />
                        <View
                          style={[
                            styles.swatchBar,
                            styles.swatchBarShort,
                            { backgroundColor: preview.textSecondary },
                          ]}
                        />
                      </View>

                      <View style={styles.rowText}>
                        <ThemedText style={styles.optionLabel}>{option.label}</ThemedText>
                        <ThemedText type="small" themeColor="textSecondary">
                          {option.description}
                        </ThemedText>
                      </View>
                    </ThemedView>
                  </Pressable>
                );
              })}
            </View>

            {/* Web edits the body with a rich editor that accepts markdown-style
                keystrokes; the hints button reminds you of them. It's web-only,
                so the toggle is too. */}
            {Platform.OS === 'web' && <EditorSection />}
            </View>
          </ScrollView>
        </SafeAreaView>
      </ThemedView>
    </SwipeBackView>
  );
}

/**
 * Account sign-in / sign-out. Signing in syncs notes across devices; signing out
 * clears the local copy on this device. Hidden behaviour (merge of anonymous
 * notes, account swap) lives in the sync layer.
 */
function AccountSection() {
  const { user, enabled, initializing, appleAvailable, signInWithGoogle, signInWithApple, signOut } =
    useAuth();
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch {
      Alert.alert('Something went wrong', 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
        ACCOUNT
      </ThemedText>
      <View style={styles.options}>
        {!enabled ? (
          <ThemedView type="backgroundElement" style={styles.accountRow}>
            <ThemedText type="small" themeColor="textSecondary">
              Sign-in isn’t configured yet.
            </ThemedText>
          </ThemedView>
        ) : initializing ? (
          <ThemedView type="backgroundElement" style={[styles.accountRow, styles.center]}>
            <ActivityIndicator color={ACCENT} />
          </ThemedView>
        ) : user ? (
          <>
            <ThemedView type="backgroundElement" style={styles.accountRow}>
              <View style={styles.rowText}>
                <ThemedText style={styles.optionLabel}>
                  {user.displayName ?? 'Signed in'}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {user.email ?? user.uid}
                </ThemedText>
              </View>
            </ThemedView>
            <Pressable
              disabled={busy}
              onPress={() => run(signOut)}
              accessibilityRole="button"
              accessibilityLabel="Sign out"
              style={({ pressed }) => [pressed && styles.pressed]}>
              <ThemedView type="backgroundElement" style={[styles.accountRow, styles.center]}>
                <ThemedText style={styles.optionLabel}>Sign out</ThemedText>
              </ThemedView>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              disabled={busy}
              onPress={() => run(signInWithGoogle)}
              accessibilityRole="button"
              accessibilityLabel="Continue with Google"
              style={({ pressed }) => [pressed && styles.pressed]}>
              <ThemedView
                type="backgroundElement"
                style={[styles.accountRow, styles.center, { borderColor: ACCENT }]}>
                <ThemedText style={styles.optionLabel}>Continue with Google</ThemedText>
              </ThemedView>
            </Pressable>
            {appleAvailable && (
              <Pressable
                disabled={busy}
                onPress={() => run(signInWithApple)}
                accessibilityRole="button"
                accessibilityLabel="Continue with Apple"
                style={({ pressed }) => [pressed && styles.pressed]}>
                <ThemedView type="backgroundElement" style={[styles.accountRow, styles.center]}>
                  <ThemedText style={styles.optionLabel}>Continue with Apple</ThemedText>
                </ThemedView>
              </Pressable>
            )}
            <ThemedText type="small" themeColor="textSecondary" style={styles.accountHint}>
              Sign in to sync your notes across devices.
            </ThemedText>
          </>
        )}
      </View>
    </>
  );
}

/**
 * Editor preferences. Currently just the web formatting-hints toggle — the
 * bottom-left cheatsheet button on the note/copa editor screens. Rendered only
 * on web (the caller gates it), since native has no such hint.
 */
function EditorSection() {
  const theme = useTheme();
  const { formattingHints, setFormattingHints } = useEditorPrefs();

  return (
    <>
      <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
        EDITOR
      </ThemedText>
      <View style={styles.options}>
        <Pressable
          onPress={() => setFormattingHints(!formattingHints)}
          accessibilityRole="switch"
          accessibilityState={{ checked: formattingHints }}
          accessibilityLabel="Show formatting hints"
          style={({ pressed }) => [pressed && styles.pressed]}>
          <ThemedView type="backgroundElement" style={styles.row}>
            <View style={styles.rowText}>
              <ThemedText style={styles.optionLabel}>Formatting hints</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                Show the markdown cheatsheet button while editing
              </ThemedText>
            </View>
            {/* Squircle check indicator (not a pill switch) — accent-filled when
                on, hollow when off. */}
            <View
              style={[
                styles.check,
                formattingHints
                  ? { backgroundColor: ACCENT, borderColor: ACCENT }
                  : { borderColor: hexToRgba(theme.textSecondary, 0.4) },
              ]}>
              {formattingHints && (
                <MaterialCommunityIcons name="check" size={18} color={theme.background} />
              )}
            </View>
          </ThemedView>
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  check: {
    width: 28,
    height: 28,
    borderRadius: Spacing.two,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    borderRadius: Spacing.three,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  center: {
    justifyContent: 'center',
  },
  accountHint: {
    marginLeft: Spacing.one,
    marginTop: Spacing.half,
  },
  safeArea: {
    flex: 1,
  },
  content: {
    padding: Spacing.four,
    alignItems: 'center',
  },
  // The actual settings column: full width on phones, capped and centered on
  // wider screens so rows keep a sensible width.
  inner: {
    width: '100%',
    maxWidth: 600,
    gap: Spacing.two,
  },
  title: {
    marginBottom: Spacing.two,
  },
  sectionLabel: {
    letterSpacing: 1,
    marginLeft: Spacing.one,
    marginBottom: Spacing.one,
  },
  options: {
    gap: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    padding: Spacing.three,
    borderRadius: Spacing.three,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  rowText: {
    flex: 1,
    gap: Spacing.half,
  },
  optionLabel: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '600',
  },
  swatch: {
    width: 44,
    height: 44,
    borderRadius: Spacing.two,
    padding: Spacing.two,
    justifyContent: 'center',
    gap: Spacing.half + 1,
    overflow: 'hidden',
  },
  swatchBar: {
    height: 4,
    borderRadius: 2,
    width: '100%',
  },
  swatchBarShort: {
    width: '60%',
  },
  pressed: {
    opacity: 0.6,
  },
});
