import { Stack } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View, useColorScheme as useDeviceScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Spacing, type Palette } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
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
            <ThemedText type="subtitle" style={styles.title}>
              Settings
            </ThemedText>

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
          </ScrollView>
        </SafeAreaView>
      </ThemedView>
    </SwipeBackView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  content: {
    padding: Spacing.four,
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
