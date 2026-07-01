import Feather from '@expo/vector-icons/Feather';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { apiFetch } from '@/lib/sync/api';
import { sentryTarget } from '@/lib/sentry-note';
import { useNotes } from '@/store/notes-store';

// Sentry level → dot color. Falls back to secondary text for unknown levels.
const LEVEL_COLORS: Record<string, string> = {
  fatal: '#e1567c',
  error: '#f55459',
  warning: '#eca611',
  info: '#3c87f7',
  debug: '#8d8f9c',
};

type Issue = {
  id: string;
  shortId?: string | null;
  title: string;
  culprit?: string | null;
  level?: string | null;
  status?: string | null;
  count?: string | null;
  userCount?: number | null;
  firstSeen?: string | null;
  lastSeen?: string | null;
  permalink?: string | null;
};

type IssueListResponse = { issues: Issue[]; next_cursor?: string | null };

/** Compact "3h ago" / "2d ago" style relative time from an ISO timestamp. */
function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function IssueCard({ issue }: { issue: Issue }) {
  const theme = useTheme();
  const dot = LEVEL_COLORS[issue.level ?? ''] ?? theme.textSecondary;
  const meta = [
    issue.count ? `${issue.count} events` : null,
    issue.userCount ? `${issue.userCount} users` : null,
    relativeTime(issue.lastSeen) || null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${issue.shortId ?? issue.title} in Sentry`}
      onPress={() => issue.permalink && void Linking.openURL(issue.permalink)}
      style={({ pressed }) => pressed && styles.pressed}>
      <ThemedView type="backgroundElementAlt" style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.levelDot, { backgroundColor: dot }]} />
          <ThemedText type="smallBold" numberOfLines={1} style={styles.cardTitle}>
            {issue.title || issue.shortId || 'Issue'}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {(issue.level ?? '').toUpperCase()}
          </ThemedText>
        </View>
        {!!issue.culprit && (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {issue.culprit}
          </ThemedText>
        )}
        {!!meta && (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {meta}
          </ThemedText>
        )}
      </ThemedView>
    </Pressable>
  );
}

export default function SentryIssuesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getNote } = useNotes();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();

  const note = getNote(id);
  const target = note ? sentryTarget(note) : null;

  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!target) {
        setLoading(false);
        setError('This Sentry note has no project configured.');
        return;
      }
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await apiFetch<IssueListResponse>(
          `/sentry/issues?org=${encodeURIComponent(target.org)}&project=${encodeURIComponent(
            target.project,
          )}&limit=25`,
        );
        setIssues(res.issues ?? []);
      } catch {
        setError('Could not load issues. Check the backend is reachable and the project exists.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [target],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  const headerTop = insets.top + Spacing.four;

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <FlatList
          data={issues}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[
            styles.content,
            { paddingTop: headerTop, paddingBottom: tabBarInset },
          ]}
          ListHeaderComponent={
            <View style={styles.header}>
              <View style={styles.headerTitleRow}>
                <Feather name="alert-triangle" size={22} color="#7553FF" />
                <ThemedText type="subtitle" numberOfLines={1} style={styles.headerTitle}>
                  {target?.project ?? 'Sentry'}
                </ThemedText>
              </View>
              {!!target?.org && (
                <ThemedText type="small" themeColor="textSecondary">
                  {target.org} · live issues
                </ThemedText>
              )}
            </View>
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void load('refresh')}
              tintColor={theme.textSecondary}
              colors={[theme.textSecondary]}
            />
          }
          ListEmptyComponent={
            loading ? (
              <ActivityIndicator style={styles.state} color={theme.textSecondary} />
            ) : error ? (
              <ThemedText themeColor="textSecondary" style={styles.state}>
                {error}
              </ThemedText>
            ) : (
              <ThemedText themeColor="textSecondary" style={styles.state}>
                No unresolved issues. 🎉
              </ThemedText>
            )
          }
          renderItem={({ item }) => <IssueCard issue={item} />}
        />
      </ThemedView>
    </SwipeBackView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  header: {
    gap: Spacing.one,
    marginBottom: Spacing.three,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  headerTitle: {
    flexShrink: 1,
  },
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.half,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  levelDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cardTitle: {
    flex: 1,
  },
  pressed: {
    opacity: 0.6,
  },
  state: {
    textAlign: 'center',
    marginTop: Spacing.five,
  },
});
