import Feather from '@expo/vector-icons/Feather';
import { Stack, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Fonts, hexToRgba, Spacing } from '@/constants/theme';
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
  substatus?: string | null;
  platform?: string | null;
  logger?: string | null;
  count?: string | null;
  userCount?: number | null;
  firstSeen?: string | null;
  lastSeen?: string | null;
  permalink?: string | null;
  numComments?: number | null;
  isUnhandled?: boolean | null;
  metadataValue?: string | null;
  metadataType?: string | null;
  assignee?: string | null;
};

type IssueListResponse = { issues: Issue[]; next_cursor?: string | null };

type ContextLine = { lineno: number; code: string };

type StackFrame = {
  filename?: string | null;
  abs_path?: string | null;
  module?: string | null;
  package?: string | null;
  function?: string | null;
  lineno?: number | null;
  colno?: number | null;
  in_app?: boolean | null;
  context: ContextLine[];
};

type Tag = { key: string; value: string };

type Breadcrumb = {
  timestamp?: string | null;
  type?: string | null;
  category?: string | null;
  level?: string | null;
  message?: string | null;
};

type RequestInfo = { url?: string | null; method?: string | null };

type EventUser = {
  id?: string | null;
  email?: string | null;
  username?: string | null;
  ip_address?: string | null;
};

type LatestEvent = {
  id: string;
  title?: string | null;
  message?: string | null;
  culprit?: string | null;
  platform?: string | null;
  date_created?: string | null;
  exception_type?: string | null;
  exception_value?: string | null;
  // Arrays are optional: an older backend build omits tags/breadcrumbs entirely.
  frames?: StackFrame[] | null;
  tags?: Tag[] | null;
  breadcrumbs?: Breadcrumb[] | null;
  request?: RequestInfo | null;
  user?: EventUser | null;
};

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

/**
 * One stack frame: `function` over `file:line`, plus (for in-app frames that
 * carry them) the surrounding source lines with the errored line highlighted.
 */
function FrameRow({ frame }: { frame: StackFrame }) {
  const theme = useTheme();
  const location = [frame.filename ?? frame.module, frame.lineno].filter(Boolean).join(':');
  // Show code only for app frames — library frames stay compact, as in Sentry.
  const showContext = frame.in_app && frame.context.length > 0;
  return (
    <View style={[styles.frame, frame.in_app && { borderLeftColor: '#7553FF' }]}>
      <ThemedText type="code" numberOfLines={1} themeColor={frame.in_app ? 'text' : 'textSecondary'}>
        {frame.function || '<anonymous>'}
      </ThemedText>
      {!!location && (
        <ThemedText type="code" numberOfLines={1} themeColor="textSecondary" style={styles.frameLoc}>
          {location}
        </ThemedText>
      )}
      {showContext && (
        <View style={styles.context}>
          {frame.context.map((line) => {
            const errored = line.lineno === frame.lineno;
            return (
              <View
                key={line.lineno}
                style={[styles.contextLine, errored && { backgroundColor: hexToRgba('#7553FF', 0.16) }]}>
                <ThemedText type="code" themeColor="textSecondary" style={styles.contextGutter}>
                  {line.lineno}
                </ThemedText>
                <ThemedText
                  type="code"
                  numberOfLines={1}
                  themeColor={errored ? 'text' : 'textSecondary'}
                  style={styles.contextCode}>
                  {line.code || ' '}
                </ThemedText>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

/** A labelled value pair for the expanded detail grid. */
function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailItem}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.detailLabel}>
        {label}
      </ThemedText>
      <ThemedText type="smallBold" numberOfLines={1}>
        {value}
      </ThemedText>
    </View>
  );
}

/** A rounded key/value chip for a Sentry event tag (browser, os, release…). */
function TagChip({ tag }: { tag: Tag }) {
  return (
    <ThemedView type="backgroundElement" style={styles.chip}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.chipKey}>
        {tag.key}
      </ThemedText>
      <ThemedText type="small" numberOfLines={1} style={styles.chipValue}>
        {tag.value}
      </ThemedText>
    </ThemedView>
  );
}

/** One breadcrumb in the trail leading up to the error. */
function BreadcrumbRow({ crumb }: { crumb: Breadcrumb }) {
  const dot = LEVEL_COLORS[crumb.level ?? ''] ?? '#8d8f9c';
  const label = crumb.category || crumb.type || 'event';
  return (
    <View style={styles.crumb}>
      <View style={[styles.crumbDot, { backgroundColor: dot }]} />
      <ThemedText type="small" themeColor="textSecondary" style={styles.crumbCat} numberOfLines={1}>
        {label}
      </ThemedText>
      <ThemedText type="small" numberOfLines={1} style={styles.crumbMsg}>
        {crumb.message || ''}
      </ThemedText>
    </View>
  );
}

/** A titled block inside the expanded card. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
        {title}
      </ThemedText>
      {children}
    </View>
  );
}

function IssueCard({ issue }: { issue: Issue }) {
  const theme = useTheme();
  const dot = LEVEL_COLORS[issue.level ?? ''] ?? theme.textSecondary;
  const [expanded, setExpanded] = useState(false);
  const [event, setEvent] = useState<LatestEvent | null>(null);
  const [loadingEvent, setLoadingEvent] = useState(false);
  const [eventError, setEventError] = useState(false);
  // Guards against re-fetching on every render once a load has started. A ref
  // (not the loading flag) so it can't retrigger the effect and cancel itself.
  const startedRef = useRef(false);

  const meta = [
    issue.count ? `${issue.count} events` : null,
    issue.userCount ? `${issue.userCount} users` : null,
    relativeTime(issue.lastSeen) || null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  // Lazily pull the latest event (stack trace) the first time the card opens.
  useEffect(() => {
    if (!expanded || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    setLoadingEvent(true);
    setEventError(false);
    apiFetch<LatestEvent>(`/sentry/issues/${encodeURIComponent(issue.id)}/latest-event`)
      .then((res) => {
        if (!cancelled) setEvent(res);
      })
      .catch(() => {
        if (!cancelled) {
          setEventError(true);
          startedRef.current = false; // allow a retry on next expand
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingEvent(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, issue.id]);

  // Sentry lists frames oldest-first; show the crashing frame at the top.
  const frames = event?.frames ? [...event.frames].reverse() : [];
  // "ExceptionType: value" headline for the latest event, when present.
  const headline = event
    ? [event.exception_type, event.exception_value ?? event.message].filter(Boolean).join(': ')
    : '';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${issue.shortId ?? issue.title}`}
      onPress={() => setExpanded((v) => !v)}
      style={({ pressed }) => pressed && styles.pressed}>
      <ThemedView type="backgroundElementAlt" style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.levelDot, { backgroundColor: dot }]} />
          <ThemedText
            type="smallBold"
            numberOfLines={expanded ? undefined : 1}
            style={styles.cardTitle}>
            {issue.title || issue.shortId || 'Issue'}
          </ThemedText>
          <Feather
            name="chevron-down"
            size={16}
            color={theme.textSecondary}
            style={expanded && styles.chevronOpen}
          />
        </View>
        {!!issue.culprit && (
          <ThemedText
            type="small"
            themeColor="textSecondary"
            numberOfLines={expanded ? undefined : 1}>
            {issue.culprit}
          </ThemedText>
        )}
        {!!meta && (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {meta}
          </ThemedText>
        )}

        {expanded && (
          <Animated.View entering={FadeIn.duration(180)} style={styles.details}>
            {/* Headline error message (type: value), when we have it. */}
            {!!(headline || issue.metadataValue) && (
              <ThemedText type="code" style={styles.headline}>
                {headline || issue.metadataValue}
              </ThemedText>
            )}

            <View style={styles.detailGrid}>
              {!!issue.level && <DetailItem label="Level" value={issue.level.toUpperCase()} />}
              <DetailItem
                label="Handling"
                value={issue.isUnhandled ? 'Unhandled' : 'Handled'}
              />
              {!!issue.status && (
                <DetailItem
                  label="Status"
                  value={issue.substatus ? `${issue.status} · ${issue.substatus}` : issue.status}
                />
              )}
              {!!issue.shortId && <DetailItem label="Issue" value={issue.shortId} />}
              {!!issue.platform && <DetailItem label="Platform" value={issue.platform} />}
              {!!issue.logger && <DetailItem label="Logger" value={issue.logger} />}
              {!!issue.count && <DetailItem label="Events" value={issue.count} />}
              {issue.userCount != null && (
                <DetailItem label="Users" value={String(issue.userCount)} />
              )}
              {!!issue.firstSeen && (
                <DetailItem label="First seen" value={relativeTime(issue.firstSeen)} />
              )}
              {!!issue.lastSeen && (
                <DetailItem label="Last seen" value={relativeTime(issue.lastSeen)} />
              )}
              {!!issue.assignee && <DetailItem label="Assignee" value={issue.assignee} />}
              {!!issue.numComments && (
                <DetailItem label="Comments" value={String(issue.numComments)} />
              )}
            </View>

            {loadingEvent ? (
              <ActivityIndicator color={theme.textSecondary} style={styles.frameState} />
            ) : eventError ? (
              <ThemedText type="small" themeColor="textSecondary" style={styles.frameState}>
                Couldn’t load event details.
              </ThemedText>
            ) : event ? (
              <>
                {!!event.request?.url && (
                  <Section title="Request">
                    <ThemedText type="code" numberOfLines={2}>
                      {[event.request.method, event.request.url].filter(Boolean).join(' ')}
                    </ThemedText>
                  </Section>
                )}

                {!!event.user && (
                  <Section title="User">
                    <ThemedText type="small" numberOfLines={1}>
                      {[
                        event.user.username,
                        event.user.email,
                        event.user.id && `id ${event.user.id}`,
                        event.user.ip_address,
                      ]
                        .filter(Boolean)
                        .join('  ·  ') || '—'}
                    </ThemedText>
                  </Section>
                )}

                {frames.length > 0 && (
                  <Section title="Stack trace">
                    <View style={styles.frames}>
                      {frames.map((frame, i) => (
                        <FrameRow key={`${frame.filename}:${frame.lineno}:${i}`} frame={frame} />
                      ))}
                    </View>
                  </Section>
                )}

                {!!event.tags?.length && (
                  <Section title="Tags">
                    <View style={styles.chips}>
                      {event.tags.map((tag) => (
                        <TagChip key={`${tag.key}:${tag.value}`} tag={tag} />
                      ))}
                    </View>
                  </Section>
                )}

                {!!event.breadcrumbs?.length && (
                  <Section title="Breadcrumbs">
                    <View style={styles.crumbs}>
                      {event.breadcrumbs.map((crumb, i) => (
                        <BreadcrumbRow key={`${crumb.timestamp}:${i}`} crumb={crumb} />
                      ))}
                    </View>
                  </Section>
                )}

                {!!event.date_created && (
                  <ThemedText type="small" themeColor="textSecondary">
                    Event {event.id.slice(0, 8)} · {relativeTime(event.date_created)}
                  </ThemedText>
                )}
              </>
            ) : (
              <ThemedText type="small" themeColor="textSecondary" style={styles.frameState}>
                No event details available.
              </ThemedText>
            )}

            {!!issue.permalink && (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel="Open this issue in Sentry"
                onPress={() => issue.permalink && void Linking.openURL(issue.permalink)}
                style={({ pressed }) => [styles.openLink, pressed && styles.pressed]}>
                <ThemedText type="small" style={{ color: '#7553FF' }}>
                  Open in Sentry
                </ThemedText>
                <Feather name="external-link" size={14} color="#7553FF" />
              </Pressable>
            )}
          </Animated.View>
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
  // Memoize on the raw config so `target` keeps a stable identity across
  // renders — otherwise `load`/effect below refire every render and hammer the
  // issues endpoint (Sentry answers with 429s).
  const target = useMemo(
    () => (note ? sentryTarget(note) : null),
    [note?.pluginType, note?.pluginConfig],
  );

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
  chevronOpen: {
    transform: [{ rotate: '180deg' }],
  },
  details: {
    marginTop: Spacing.two,
    gap: Spacing.three,
  },
  headline: {
    fontSize: 13,
    lineHeight: 18,
  },
  detailGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: Spacing.two,
    columnGap: Spacing.three,
  },
  detailItem: {
    gap: Spacing.half,
    minWidth: 64,
  },
  detailLabel: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  section: {
    gap: Spacing.one,
  },
  sectionLabel: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  frames: {
    gap: Spacing.two,
  },
  frame: {
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
    paddingLeft: Spacing.two,
    gap: Spacing.half,
  },
  frameLoc: {
    fontFamily: Fonts.mono,
    fontSize: 11,
    opacity: 0.8,
  },
  context: {
    marginTop: Spacing.half,
    borderRadius: Spacing.one,
    overflow: 'hidden',
  },
  contextLine: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingVertical: 1,
    paddingHorizontal: Spacing.one,
  },
  contextGutter: {
    fontSize: 11,
    minWidth: 34,
    textAlign: 'right',
    opacity: 0.6,
  },
  contextCode: {
    flex: 1,
    fontSize: 11,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.half,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.two,
    maxWidth: '100%',
  },
  chipKey: {
    fontSize: 12,
  },
  chipValue: {
    fontSize: 12,
    flexShrink: 1,
  },
  crumbs: {
    gap: Spacing.half,
  },
  crumb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  crumbDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  crumbCat: {
    fontSize: 12,
    minWidth: 72,
  },
  crumbMsg: {
    fontSize: 12,
    flex: 1,
  },
  frameState: {
    paddingVertical: Spacing.one,
  },
  openLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    alignSelf: 'flex-start',
    marginTop: Spacing.one,
  },
  pressed: {
    opacity: 0.6,
  },
  state: {
    textAlign: 'center',
    marginTop: Spacing.five,
  },
});
