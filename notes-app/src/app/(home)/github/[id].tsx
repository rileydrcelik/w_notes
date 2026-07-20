import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { hexToRgba, Spacing } from '@/constants/theme';
import { GRID_COLUMNS, gridEdgePadding, trailingSpacers, useGridColumnWidth, useTileHeight } from '@/lib/grid';
import { useContextMenu } from '@/hooks/use-context-menu';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { apiFetch } from '@/lib/sync/api';
import { githubTarget, type GithubTarget, type CreatedIssue } from '@/lib/github-note';
import { GithubConfig } from '@/components/notes/github-config';
import { useGithubSelection, type CloseReason } from '@/store/github-selection-store';
import { useNotes } from '@/store/notes-store';

const ACCENT = '#8250df';
const OPEN_COLOR = '#3fb950';
const CLOSED_COLOR = '#8250df';
const NOT_PLANNED_COLOR = '#8b949e';

type Label = { name: string; color?: string | null };

type Issue = {
  number: number;
  title: string;
  state?: string | null;
  state_reason?: string | null;
  body?: string | null;
  html_url?: string | null;
  author?: string | null;
  labels: Label[];
  assignees: string[];
  comments?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  milestone?: string | null;
};

type IssueListResponse = { issues: Issue[]; next_cursor?: string | null };

type Comment = { id: number; author?: string | null; body?: string | null; created_at?: string | null };
type CommentListResponse = { comments: Comment[] };

type StateFilter = 'open' | 'closed' | 'all';

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

/** The dot/label color for an issue's state (open green; not-planned grey; else purple). */
function stateColor(issue: Issue): string {
  if (issue.state === 'open') return OPEN_COLOR;
  if (issue.state_reason === 'not_planned') return NOT_PLANNED_COLOR;
  return CLOSED_COLOR;
}

/** One issue as pasteable text: state, #number, title, url, body. */
function issueToClipboardText(issue: Issue): string {
  const lines: string[] = [`#${issue.number} ${issue.title}`.trim()];
  const state = issue.state === 'open' ? 'open' : issue.state_reason === 'not_planned' ? 'closed (not planned)' : 'closed';
  lines.push(`State: ${state}`);
  if (issue.author) lines.push(`Author: ${issue.author}`);
  if (issue.labels.length) lines.push(`Labels: ${issue.labels.map((l) => l.name).join(', ')}`);
  if (issue.body) lines.push('', issue.body.trim());
  if (issue.html_url) lines.push('', issue.html_url);
  return lines.join('\n');
}

/** A rounded key/value chip for a GitHub label, tinted with the label's color. */
function LabelChip({ label }: { label: Label }) {
  const theme = useTheme();
  const color = label.color ? `#${label.color}` : theme.textSecondary;
  return (
    <View style={[styles.labelChip, { borderColor: color, backgroundColor: hexToRgba(color, 0.14) }]}>
      <ThemedText type="small" numberOfLines={1} style={styles.labelChipText}>
        {label.name}
      </ThemedText>
    </View>
  );
}

/** One comment in the expanded issue view. */
function CommentRow({ comment }: { comment: Comment }) {
  return (
    <View style={styles.comment}>
      <View style={styles.commentHead}>
        <Feather name="message-square" size={12} color={ACCENT} />
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.commentAuthor}>
          {comment.author || 'unknown'} · {relativeTime(comment.created_at)}
        </ThemedText>
      </View>
      {!!comment.body && (
        <ThemedText type="small" style={styles.commentBody}>
          {comment.body.trim()}
        </ThemedText>
      )}
    </View>
  );
}

function IssueCard({
  issue,
  repo,
  selectionActive,
  selected,
  onToggleSelect,
}: {
  issue: Issue;
  repo: string;
  selectionActive: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const theme = useTheme();
  const dot = stateColor(issue);
  // Same shared tile height as the note/folder feed so issue cards line up
  // uniformly; expanding grows the card past it (copa pattern) to show details.
  const tileHeight = useTileHeight();
  const [expanded, setExpanded] = useState(false);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [loadingComments, setLoadingComments] = useState(false);
  // Guards against re-fetching on every render once a load has started.
  const startedRef = useRef(false);

  const meta = [
    issue.author ? `by ${issue.author}` : null,
    issue.comments ? `${issue.comments} comments` : null,
    relativeTime(issue.updated_at) || null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  // Lazily pull comments the first time the card opens (only if it has any).
  useEffect(() => {
    if (!expanded || startedRef.current || !issue.comments) return;
    startedRef.current = true;
    let cancelled = false;
    setLoadingComments(true);
    apiFetch<CommentListResponse>(
      `/github/issues/${issue.number}/comments?repo=${encodeURIComponent(repo)}`,
    )
      .then((res) => {
        if (!cancelled) setComments(res.comments ?? []);
      })
      .catch(() => {
        if (!cancelled) startedRef.current = false; // allow a retry on next expand
      })
      .finally(() => {
        if (!cancelled) setLoadingComments(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, issue.number, issue.comments, repo]);

  const onPress = () => {
    if (selectionActive) onToggleSelect();
    else setExpanded((v) => !v);
  };
  const contextMenuRef = useContextMenu(onToggleSelect);

  const isOpen = issue.state === 'open';

  return (
    <Pressable
      ref={contextMenuRef}
      accessibilityRole="button"
      accessibilityState={{ expanded, selected }}
      accessibilityLabel={
        selectionActive
          ? `${selected ? 'Deselect' : 'Select'} issue ${issue.number}`
          : `${expanded ? 'Collapse' : 'Expand'} issue ${issue.number}`
      }
      onPress={onPress}
      onLongPress={onToggleSelect}
      style={({ pressed }) => pressed && styles.pressed}>
      <ThemedView
        type="backgroundElementAlt"
        style={[styles.card, { height: expanded ? undefined : tileHeight }, selected && styles.cardSelected]}>
        <View style={styles.cardHeader}>
          <View style={[styles.stateDot, { backgroundColor: dot }]} />
          <ThemedText type="smallBold" numberOfLines={expanded ? undefined : 2} style={styles.cardTitle}>
            {issue.title || `Issue #${issue.number}`}
          </ThemedText>
          {selectionActive ? (
            <Feather
              name={selected ? 'check-circle' : 'circle'}
              size={18}
              color={selected ? ACCENT : theme.textSecondary}
            />
          ) : (
            <Feather
              name="chevron-down"
              size={16}
              color={theme.textSecondary}
              style={expanded && styles.chevronOpen}
            />
          )}
        </View>

        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
          {`#${issue.number}`}
          {!isOpen && `  ·  ${issue.state_reason === 'not_planned' ? 'closed (not planned)' : 'closed'}`}
          {issue.milestone ? `  ·  ${issue.milestone}` : ''}
        </ThemedText>

        {issue.labels.length > 0 && (
          <View style={styles.labelRow}>
            {issue.labels.map((l) => (
              <LabelChip key={l.name} label={l} />
            ))}
          </View>
        )}

        {!!meta && (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {meta}
          </ThemedText>
        )}

        {expanded && (
          <Animated.View entering={FadeIn.duration(180)} style={styles.details}>
            {!!issue.body && (
              <ThemedText type="small" style={styles.body}>
                {issue.body.trim()}
              </ThemedText>
            )}

            {issue.assignees.length > 0 && (
              <ThemedText type="small" themeColor="textSecondary">
                Assigned to {issue.assignees.join(', ')}
              </ThemedText>
            )}

            {!!issue.comments && (
              <View style={styles.commentsSection}>
                <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
                  Comments
                </ThemedText>
                {loadingComments ? (
                  <ActivityIndicator color={theme.textSecondary} style={styles.frameState} />
                ) : comments && comments.length > 0 ? (
                  comments.map((c) => <CommentRow key={c.id} comment={c} />)
                ) : (
                  <ThemedText type="small" themeColor="textSecondary">
                    Couldn’t load comments.
                  </ThemedText>
                )}
              </View>
            )}

            {!!issue.html_url && (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel="Open this issue on GitHub"
                onPress={() => issue.html_url && void Linking.openURL(issue.html_url)}
                style={({ pressed }) => [styles.openLink, pressed && styles.pressed]}>
                <ThemedText type="small" style={{ color: ACCENT }}>
                  Open on GitHub
                </ThemedText>
                <Feather name="external-link" size={14} color={ACCENT} />
              </Pressable>
            )}
          </Animated.View>
        )}
      </ThemedView>
    </Pressable>
  );
}

/** Segmented open / closed / all filter shown in the list header. */
function StateFilterBar({ value, onChange }: { value: StateFilter; onChange: (v: StateFilter) => void }) {
  const theme = useTheme();
  const options: StateFilter[] = ['open', 'closed', 'all'];
  return (
    <View style={styles.filterBar}>
      {options.map((opt) => {
        const active = value === opt;
        return (
          <Pressable
            key={opt}
            onPress={() => onChange(opt)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`Show ${opt} issues`}
            style={({ pressed }) => [
              styles.filterSegment,
              {
                backgroundColor: active ? hexToRgba(ACCENT, 0.16) : 'transparent',
                borderColor: active ? ACCENT : hexToRgba(theme.text, 0.12),
              },
              pressed && styles.pressed,
            ]}>
            <ThemedText
              type="small"
              style={[styles.filterText, { color: active ? ACCENT : theme.textSecondary }]}>
              {opt[0].toUpperCase() + opt.slice(1)}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function GithubIssuesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getNote, updateNote } = useNotes();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const columnWidth = useGridColumnWidth();
  const {
    active: selectionActive,
    selectedIds,
    isSelected,
    toggle,
    clear,
    registerCloseHandler,
    registerReopenHandler,
    registerCommentHandler,
    registerCopyHandler,
    registerComposeRepo,
    registerCreatedHandler,
  } = useGithubSelection();

  const note = getNote(id);
  // Memoize on the raw config so `target` keeps a stable identity across renders.
  const target = useMemo(
    () => (note ? githubTarget(note) : null),
    [note?.pluginType, note?.pluginConfig],
  );

  const [issues, setIssues] = useState<Issue[]>([]);
  // Grid rows: issues plus transparent spacers padding the last row so its cards
  // stay one column wide (same layout as the note/folder feed).
  type GridRow = Issue | { spacer: true; key: string };
  const gridData = useMemo<GridRow[]>(() => {
    const rows: GridRow[] = [...issues];
    for (let i = 0; i < trailingSpacers(issues.length); i++) rows.push({ spacer: true, key: `spacer-${i}` });
    return rows;
  }, [issues]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StateFilter>('open');

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!target) {
        setLoading(false);
        setError('This GitHub note has no repo configured.');
        return;
      }
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await apiFetch<IssueListResponse>(
          `/github/issues?repo=${encodeURIComponent(target.repo)}&state=${filter}&limit=25`,
        );
        setIssues(res.issues ?? []);
      } catch {
        setError('Could not load issues. Check the backend is reachable and the repo exists.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [target, filter],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async load
    void load('initial');
  }, [load]);

  // Write the picked repo into the note's config. Once it lands, `target`
  // resolves and the screen swaps from picker to issues list.
  const handleConfigure = useCallback(
    (config: GithubTarget) => {
      updateNote(id, { pluginConfig: JSON.stringify(config) });
    },
    [id, updateNote],
  );

  // Prepend a freshly-created issue (only when the current filter would show it).
  const handleCreated = useCallback(
    (created: CreatedIssue) => {
      if (filter === 'closed') return; // a new issue is open; hidden by the closed filter
      setIssues((prev) => [created as Issue, ...prev]);
    },
    [filter],
  );

  // Close the selected issues (the navbar's Close action) with a reason. Remove
  // them from the list when the open filter is active; otherwise flip their state
  // in place. On failure, resync from the server.
  const handleClose = useCallback(
    (ids: string[], reason: CloseReason) => {
      if (!target) return;
      const nums = new Set(ids.map(Number));
      clear();
      setIssues((prev) =>
        filter === 'open'
          ? prev.filter((i) => !nums.has(i.number))
          : prev.map((i) => (nums.has(i.number) ? { ...i, state: 'closed', state_reason: reason } : i)),
      );
      Promise.all(
        ids.map((num) =>
          apiFetch(`/github/issues/${num}?repo=${encodeURIComponent(target.repo)}`, {
            method: 'PATCH',
            body: { state: 'closed', state_reason: reason },
          }),
        ),
      ).catch(() => {
        setError('Could not close one or more issues on GitHub.');
        void load('refresh');
      });
    },
    [target, filter, clear, load],
  );

  // Reopen the selected issues. Mirror of handleClose for the closed filter.
  const handleReopen = useCallback(
    (ids: string[]) => {
      if (!target) return;
      const nums = new Set(ids.map(Number));
      clear();
      setIssues((prev) =>
        filter === 'closed'
          ? prev.filter((i) => !nums.has(i.number))
          : prev.map((i) => (nums.has(i.number) ? { ...i, state: 'open', state_reason: null } : i)),
      );
      Promise.all(
        ids.map((num) =>
          apiFetch(`/github/issues/${num}?repo=${encodeURIComponent(target.repo)}`, {
            method: 'PATCH',
            body: { state: 'open', state_reason: 'reopened' },
          }),
        ),
      ).catch(() => {
        setError('Could not reopen one or more issues on GitHub.');
        void load('refresh');
      });
    },
    [target, filter, clear, load],
  );

  // Post a comment to each selected issue (the navbar's Comment action). Bumps
  // each issue's comment count optimistically.
  const handleComment = useCallback(
    (ids: string[], body: string) => {
      if (!target) return;
      const nums = new Set(ids.map(Number));
      clear();
      setIssues((prev) =>
        prev.map((i) => (nums.has(i.number) ? { ...i, comments: (i.comments ?? 0) + 1 } : i)),
      );
      Promise.all(
        ids.map((num) =>
          apiFetch(`/github/issues/${num}/comments?repo=${encodeURIComponent(target.repo)}`, {
            method: 'POST',
            body: { body },
          }),
        ),
      ).catch(() => setError('Could not add a comment to one or more issues.'));
    },
    [target, clear],
  );

  // Copy the selected issues' details to the clipboard.
  const handleCopy = useCallback(
    (ids: string[]) => {
      const nums = new Set(ids.map(Number));
      const selected = issues.filter((i) => nums.has(i.number));
      if (selected.length === 0) return;
      clear();
      const text = selected.map(issueToClipboardText).join(`\n\n${'─'.repeat(48)}\n\n`);
      void Clipboard.setStringAsync(text);
    },
    [issues, clear],
  );

  // Register the handlers so the navbar's selection menu can invoke them, and
  // make sure selection doesn't linger once we leave.
  useEffect(() => {
    registerCloseHandler(handleClose);
    return () => registerCloseHandler(null);
  }, [registerCloseHandler, handleClose]);
  useEffect(() => {
    registerReopenHandler(handleReopen);
    return () => registerReopenHandler(null);
  }, [registerReopenHandler, handleReopen]);
  useEffect(() => {
    registerCommentHandler(handleComment);
    return () => registerCommentHandler(null);
  }, [registerCommentHandler, handleComment]);
  useEffect(() => {
    registerCopyHandler(handleCopy);
    return () => registerCopyHandler(null);
  }, [registerCopyHandler, handleCopy]);
  // Tell the navbar which repo its (+) button composes issues for — only once the
  // note is configured — and how to apply a created issue. The navbar owns the
  // composer sheet (so it renders above the navbar, not under it).
  useEffect(() => {
    registerComposeRepo(target?.repo ?? null);
    return () => registerComposeRepo(null);
  }, [target?.repo, registerComposeRepo]);
  useEffect(() => {
    registerCreatedHandler(handleCreated);
    return () => registerCreatedHandler(null);
  }, [registerCreatedHandler, handleCreated]);
  useEffect(() => () => clear(), [clear]);

  const headerTop = insets.top + Spacing.four;

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        {!target ? (
          <GithubConfig paddingTop={headerTop} paddingBottom={tabBarInset} onSubmit={handleConfigure} />
        ) : (
          <FlatList
              data={gridData}
              keyExtractor={(item) => ('spacer' in item ? item.key : String(item.number))}
              numColumns={GRID_COLUMNS}
              columnWrapperStyle={styles.row}
              extraData={{ selectionActive, selectedIds, filter }}
              contentContainerStyle={[
                styles.content,
                gridEdgePadding,
                { paddingTop: headerTop, paddingBottom: tabBarInset },
              ]}
              ListHeaderComponent={
                <View style={styles.header}>
                  <View style={styles.headerTitleRow}>
                    <Feather name="github" size={22} color={ACCENT} />
                    <ThemedText type="subtitle" numberOfLines={1} style={styles.headerTitle}>
                      {target.repoName ?? target.repo}
                    </ThemedText>
                  </View>
                  <ThemedText type="small" themeColor="textSecondary">
                    {target.repo} · issues
                  </ThemedText>
                  <StateFilterBar value={filter} onChange={setFilter} />
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
                    No {filter === 'all' ? '' : filter} issues. 🎉
                  </ThemedText>
                )
              }
              renderItem={({ item }) => {
                if ('spacer' in item) return <View style={[styles.cardCell, { width: columnWidth }]} />;
                return (
                  <View style={[styles.cardCell, { width: columnWidth }]}>
                    <IssueCard
                      issue={item}
                      repo={target.repo}
                      selectionActive={selectionActive}
                      selected={isSelected(String(item.number))}
                      onToggleSelect={() => toggle(String(item.number))}
                    />
                  </View>
                );
              }}
            />
        )}
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
    gap: Spacing.three,
  },
  // Grid row/cell — mirrors the note/folder feed: fixed one-column width (inline)
  // with flexGrow:0 so a card can't stretch into a partial row's empty space.
  row: { gap: Spacing.three, alignItems: 'flex-start' },
  cardCell: { flexGrow: 0, flexShrink: 1, minWidth: 0, overflow: 'hidden' },
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
    flex: 1,
  },
  filterBar: {
    flexDirection: 'row',
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
  filterSegment: {
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.two,
    borderWidth: 1.5,
  },
  filterText: {
    fontWeight: '600',
  },
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.half,
    borderWidth: 1.5,
    borderColor: 'transparent',
    // Clip to the tile when collapsed (fixed height); grows to fit when expanded.
    overflow: 'hidden',
  },
  cardSelected: {
    borderColor: ACCENT,
    backgroundColor: hexToRgba(ACCENT, 0.1),
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  stateDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cardTitle: {
    flex: 1,
    minWidth: 0,
  },
  chevronOpen: {
    transform: [{ rotate: '180deg' }],
  },
  labelRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
    marginTop: Spacing.half,
  },
  labelChip: {
    paddingVertical: 1,
    paddingHorizontal: Spacing.one,
    borderRadius: Spacing.one,
    borderWidth: 1,
    maxWidth: '100%',
  },
  labelChipText: {
    fontSize: 11,
  },
  details: {
    marginTop: Spacing.two,
    gap: Spacing.three,
  },
  body: {
    fontSize: 13,
    lineHeight: 19,
  },
  sectionLabel: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  commentsSection: {
    gap: Spacing.two,
  },
  comment: {
    gap: Spacing.half,
    borderLeftWidth: 2,
    borderLeftColor: hexToRgba(ACCENT, 0.5),
    paddingLeft: Spacing.two,
  },
  commentHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  commentAuthor: {
    flexShrink: 1,
  },
  commentBody: {
    fontSize: 13,
    lineHeight: 19,
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
