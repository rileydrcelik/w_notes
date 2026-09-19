import Feather from '@expo/vector-icons/Feather';
import { Pressable, StyleSheet } from 'react-native';

import { useStatusColors } from '@/components/internship/status-style';
import { ThemedText } from '@/components/themed-text';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { STATUS_LABEL, type InternshipStatus } from '@/lib/internship';

/** A status as a bordered chip — the StateFilterBar control, per status colour. */
export function StatusChip({
  status,
  selected,
  opens = false,
  onPress,
  accessibilityLabel,
}: {
  status: InternshipStatus;
  selected: boolean;
  /** The row's own chip, which opens the picker — marked with a chevron. */
  opens?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const theme = useTheme();
  const color = useStatusColors()[status];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? hexToRgba(color, 0.16) : 'transparent',
          borderColor: selected ? color : hexToRgba(theme.text, 0.12),
        },
        pressed && styles.pressed,
      ]}
    >
      <ThemedText
        type="small"
        style={[styles.chipText, { color: selected ? color : theme.textSecondary }]}
      >
        {STATUS_LABEL[status]}
      </ThemedText>
      {opens && <Feather name="chevron-down" size={12} color={color} style={styles.chevron} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.two,
    borderWidth: 1,
  },
  chipText: { fontWeight: '600' },
  chevron: { marginLeft: Spacing.half },
  pressed: { opacity: 0.6 },
});
