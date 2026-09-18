import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { countByStatus, INTERNSHIP_STATUSES, parseTracker, STATUS_LABEL } from '@/lib/internship';

import { STATUS_COLOR } from './status-style';

/**
 * A tracker card's preview: how many internships sit in each status, the
 * statuses with none left out, and the total. It reads the body the card
 * already has — the tracker *is* its body — so there's nothing extra to load.
 */
export function TrackerSummary({ body }: { body: string }) {
  const counts = useMemo(() => countByStatus(parseTracker(body)), [body]);
  if (counts.total === 0) {
    return (
      <ThemedText type="small" themeColor="textSecondary">
        No internships yet
      </ThemedText>
    );
  }
  return (
    <View style={styles.list}>
      {INTERNSHIP_STATUSES.filter((s) => counts[s] > 0).map((s) => (
        <View key={s} style={styles.row}>
          <View style={[styles.dot, { backgroundColor: STATUS_COLOR[s] }]} />
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.label}>
            {STATUS_LABEL[s]}
          </ThemedText>
          <ThemedText type="smallBold">{counts[s]}</ThemedText>
        </View>
      ))}
      <View style={[styles.row, styles.total]}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.label}>
          Total
        </ThemedText>
        <ThemedText type="smallBold">{counts.total}</ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: Spacing.one },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  dot: { width: 6, height: 6, borderRadius: Spacing.one },
  label: { flex: 1 },
  total: { paddingTop: Spacing.one },
});
