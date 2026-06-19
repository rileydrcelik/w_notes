import Feather from '@expo/vector-icons/Feather';
import { Platform, Pressable, StyleSheet, TextInput } from 'react-native';

import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** Fixed height of the search field, so callers can offset content beneath it. */
export const SEARCH_BAR_HEIGHT = 44;

/**
 * Rounded search field for filtering the home grid. Shows a clear button once
 * there's a query. Squircle, not a pill, to match the card language.
 */
export function SearchBar({
  value,
  onChangeText,
  placeholder = 'Search notes and folders',
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
}) {
  const theme = useTheme();

  return (
    <ThemedView
      type="backgroundElement"
      style={[styles.bar, Platform.OS === 'web' && styles.barWeb]}>
      <Feather name="search" size={18} color={theme.textSecondary} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.textSecondary}
        style={[styles.input, { color: theme.text }]}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel="Search notes and folders"
      />
      {value.length > 0 && (
        <Pressable
          onPress={() => onChangeText('')}
          hitSlop={Spacing.two}
          accessibilityRole="button"
          accessibilityLabel="Clear search">
          <Feather name="x" size={18} color={theme.textSecondary} />
        </Pressable>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    height: SEARCH_BAR_HEIGHT,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.three,
  },
  // On web the bar would otherwise stretch the full window width; cap it and
  // center it. The cap is wider than the sidebar's search field, so the in-
  // drawer search bar still fills its (narrower) column unaffected.
  barWeb: {
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  input: {
    flex: 1,
    fontSize: 16,
    padding: 0,
  },
});
