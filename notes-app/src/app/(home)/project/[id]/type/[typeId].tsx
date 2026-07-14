/**
 * A single issue *type* within a task-manager project (e.g. "Bug"). Lists the
 * issues filed under this type-note, with the same double-tap-done / long-press-
 * select / edit-attributes flows the whole project used to have — now scoped to
 * one type, since the project screen is a feed of these type-notes.
 *
 * When the type is GitHub-connected and the project has a repo, toggling an
 * issue's done flag also closes/reopens its mirrored GitHub issue (push-only).
 */
import Feather from '@expo/vector-icons/Feather';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IssueAttributesSheet } from '@/components/notes/issue-attributes-sheet';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useContextMenu } from '@/hooks/use-context-menu';
import { useDoubleTap } from '@/hooks/use-double-tap';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import type { Issue, IssueAttrValue } from '@/data/notes';
import { parseTypeConfig, projectConfig, type AttrDef } from '@/lib/project';
import {
  getGithubIssueLabels,
  githubIssueAssignees,
  githubIssueLabels,
  githubSyncErrorMessage,
  mergeManagedLabels,
  setGithubIssueState,
  updateGithubIssue,
} from '@/lib/issue-github';
import { Sentry } from '@/lib/sentry';
import { useIssues } from '@/store/issues-store';
import { useNotes } from '@/store/notes-store';
import { useTaskSelection } from '@/store/task-selection-store';

const ACCENT = '#16a394';
const DONE_COLOR = '#3fb950';
const GITHUB_ACCENT = '#8250df';

/** Compact chips summarizing an issue's set attribute values. */
function AttrSummary({ attributes, attrs }: { attributes: AttrDef[]; attrs: Issue['attrs'] }) {
  const theme = useTheme();
  const parts: { key: string; node: React.ReactNode }[] = [];
  for (const attr of attributes) {
    const v = attrs[attr.id];
    if (v == null || (Array.isArray(v) && v.length === 0)) continue;
    if (attr.type === 'stars' && typeof v === 'number' && v > 0) {
      parts.push({
        key: attr.id,
        node: (
          <View style={styles.summaryStars}>
            {Array.from({ length: v }).map((_, i) => (
              <Feather key={i} name="star" size={11} color={ACCENT} />
            ))}
          </View>
        ),
      });
    } else if (attr.type === 'people' && Array.isArray(v)) {
      parts.push({
        key: attr.id,
        node: (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {v.map((p) => `@${p}`).join(' ')}
          </ThemedText>
        ),
      });
    } else if (typeof v === 'string') {
      parts.push({
        key: attr.id,
        node: (
          <View style={[styles.summaryChip, { borderColor: hexToRgba(theme.text, 0.15) }]}>
            <ThemedText type="small" numberOfLines={1}>
              {v}
            </ThemedText>
          </View>
        ),
      });
    }
  }
  if (parts.length === 0) return null;
  return (
    <View style={styles.summaryRow}>
      {parts.map((p) => (
        <View key={p.key}>{p.node}</View>
      ))}
    </View>
  );
}

function IssueRow({
  issue,
  attributes,
  selectionActive,
  selected,
  onToggleSelect,
  onToggleDone,
}: {
  issue: Issue;
  attributes: AttrDef[];
  selectionActive: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onToggleDone: () => void;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  // Single tap expands the description; double tap toggles done.
  const doubleTap = useDoubleTap(() => setExpanded((v) => !v), onToggleDone);
  const contextMenuRef = useContextMenu(onToggleSelect);

  return (
    <Pressable
      ref={contextMenuRef}
      accessibilityRole="button"
      accessibilityState={{ selected, checked: issue.done }}
      accessibilityLabel={`${issue.title || 'Issue'}${issue.done ? ', done' : ''}`}
      onPress={selectionActive ? onToggleSelect : doubleTap}
      onLongPress={onToggleSelect}
      style={({ pressed }) => pressed && styles.pressed}>
      <ThemedView type="backgroundElementAlt" style={[styles.card, selected && styles.cardSelected]}>
        <View style={styles.cardHeader}>
          {selectionActive ? (
            <Feather
              name={selected ? 'check-circle' : 'circle'}
              size={18}
              color={selected ? ACCENT : theme.textSecondary}
            />
          ) : (
            <Feather
              name={issue.done ? 'check-circle' : 'circle'}
              size={18}
              color={issue.done ? DONE_COLOR : theme.textSecondary}
            />
          )}
          <ThemedText
            type="smallBold"
            numberOfLines={expanded ? undefined : 2}
            style={[styles.cardTitle, issue.done && styles.doneTitle]}>
            {issue.title || 'Untitled issue'}
          </ThemedText>
          {issue.ghNumber != null && (
            <View style={styles.ghBadge}>
              <Feather name="github" size={11} color={GITHUB_ACCENT} />
              <ThemedText type="small" style={styles.ghBadgeText}>
                #{issue.ghNumber}
              </ThemedText>
            </View>
          )}
        </View>

        <AttrSummary attributes={attributes} attrs={issue.attrs} />

        {expanded && !!issue.description && (
          <Animated.View entering={FadeIn.duration(160)}>
            <ThemedText type="small" themeColor="textSecondary" style={styles.description}>
              {issue.description}
            </ThemedText>
          </Animated.View>
        )}
      </ThemedView>
    </Pressable>
  );
}

export default function IssueTypeScreen() {
  const { id, typeId } = useLocalSearchParams<{ id: string; typeId: string }>();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const { getFolder, getNote, getNotesInFolder } = useNotes();
  const { issues, getIssuesForNote, setDone, updateIssue, deleteIssue } = useIssues();
  const {
    active: selectionActive,
    selectedIds,
    isSelected,
    toggle,
    clear,
    registerMarkDoneHandler,
    registerEditAttrsHandler,
    registerDeleteHandler,
    registerCompose,
    registerGithubUrl,
  } = useTaskSelection();

  const folder = getFolder(id);
  const typeNote = getNote(typeId);
  const config = useMemo(
    () => (folder ? projectConfig(folder) : null),
    [folder?.kind, folder?.config],
  );
  const repo = config?.repo;
  const attributes = useMemo(() => config?.attributes ?? [], [config]);
  const connected = parseTypeConfig(typeNote?.pluginConfig).githubConnected;
  const data = useMemo(() => getIssuesForNote(typeId), [getIssuesForNote, typeId]);
  // All the project's issue-type names — used to tell this app's managed labels
  // apart from labels a user added on GitHub, so an edit preserves the latter.
  const typeNames = useMemo(
    () => getNotesInFolder(id).filter((n) => n.pluginType === 'issuetype').map((n) => n.title),
    [getNotesInFolder, id],
  );

  // Which issues the edit-attributes sheet is acting on (null = closed).
  const [editingIds, setEditingIds] = useState<string[] | null>(null);
  const editInitial = useMemo<Record<string, IssueAttrValue>>(() => {
    if (!editingIds || editingIds.length === 0) return {};
    return issues.find((i) => i.id === editingIds[0])?.attrs ?? {};
  }, [editingIds, issues]);

  // Toggle done locally and, for a GitHub-connected mirrored issue, push the
  // close/reopen to GitHub (best-effort — a failure leaves the local flag set).
  const syncDone = useCallback(
    (issue: Issue, done: boolean) => {
      setDone(issue.id, done);
      if (connected && repo && issue.ghNumber != null) {
        setGithubIssueState(repo, issue.ghNumber, done).catch((e) => {
          Sentry.captureException(e, { tags: { source: 'issue-github', op: 'state' } });
          Alert.alert(
            done ? 'Not closed on GitHub' : 'Not reopened on GitHub',
            githubSyncErrorMessage(e),
          );
        });
      }
    },
    [setDone, connected, repo],
  );

  // Register the selection-action handlers so the navbar menu can drive them.
  useEffect(() => {
    registerMarkDoneHandler((ids, done) => {
      ids.forEach((issueId) => {
        const issue = getIssuesForNote(typeId).find((i) => i.id === issueId);
        if (issue) syncDone(issue, done);
      });
      clear();
    });
    return () => registerMarkDoneHandler(null);
  }, [registerMarkDoneHandler, getIssuesForNote, typeId, syncDone, clear]);
  useEffect(() => {
    registerEditAttrsHandler((ids) => setEditingIds(ids));
    return () => registerEditAttrsHandler(null);
  }, [registerEditAttrsHandler]);
  useEffect(() => {
    registerDeleteHandler((ids) => {
      ids.forEach((issueId) => deleteIssue(issueId));
      clear();
    });
    return () => registerDeleteHandler(null);
  }, [registerDeleteHandler, deleteIssue, clear]);
  // Tell the navbar which project + type its (+) composes issues for while this
  // screen is focused; the project feed re-registers (no type) when it returns.
  useFocusEffect(
    useCallback(() => {
      registerCompose(id, typeId);
      return () => registerCompose(null);
    }, [id, typeId, registerCompose]),
  );
  useEffect(() => () => clear(), [clear]);
  // Offer "Open on GitHub" only when a single mirrored issue is selected.
  useEffect(() => {
    const only = selectedIds.length === 1 ? data.find((i) => i.id === selectedIds[0]) : undefined;
    registerGithubUrl(
      only?.ghNumber != null && repo ? `https://github.com/${repo}/issues/${only.ghNumber}` : null,
    );
    return () => registerGithubUrl(null);
  }, [selectedIds, data, repo, registerGithubUrl]);

  // Push an issue's new attribute values to its mirrored GitHub issue: select/
  // stars → labels (merged over the issue's current labels so foreign ones
  // survive), People → assignees. Best-effort; a failure leaves the local edit.
  const pushAttrsToGithub = useCallback(
    async (ghNumber: number, attrs: Record<string, IssueAttrValue>) => {
      if (!connected || !repo) return;
      const managed = githubIssueLabels(typeNote?.title, attributes, attrs);
      const assignees = githubIssueAssignees(attributes, attrs);
      try {
        const current = await getGithubIssueLabels(repo, ghNumber);
        const labels = mergeManagedLabels(current, managed, attributes, typeNames);
        await updateGithubIssue(repo, ghNumber, { labels, assignees });
      } catch (e) {
        Sentry.captureException(e, { tags: { source: 'issue-github', op: 'attrs' } });
        Alert.alert('Attributes not synced to GitHub', githubSyncErrorMessage(e));
      }
    },
    [connected, repo, typeNote?.title, attributes, typeNames],
  );

  const applyEdit = useCallback(
    (attrs: Record<string, IssueAttrValue>) => {
      editingIds?.forEach((issueId) => {
        updateIssue(issueId, { attrs });
        const issue = issues.find((i) => i.id === issueId);
        if (issue?.ghNumber != null) void pushAttrsToGithub(issue.ghNumber, attrs);
      });
      setEditingIds(null);
      clear();
    },
    [editingIds, updateIssue, clear, issues, pushAttrsToGithub],
  );

  const headerTop = insets.top + Spacing.four;

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          extraData={{ selectionActive, selectedIds }}
          contentContainerStyle={[
            styles.content,
            { paddingTop: headerTop, paddingBottom: tabBarInset },
          ]}
          ListHeaderComponent={
            <View style={styles.header}>
              <View style={styles.headerTitleRow}>
                <Feather name="columns" size={22} color={ACCENT} />
                <ThemedText type="subtitle" numberOfLines={1} style={styles.headerTitle}>
                  {typeNote?.title || 'Type'}
                </ThemedText>
                {connected && <Feather name="github" size={16} color={GITHUB_ACCENT} />}
              </View>
              <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                {folder?.name || 'Project'}
                {repo ? ` · ${repo}` : ''}
              </ThemedText>
            </View>
          }
          renderItem={({ item }) => (
            <IssueRow
              issue={item}
              attributes={attributes}
              selectionActive={selectionActive}
              selected={isSelected(item.id)}
              onToggleSelect={() => toggle(item.id)}
              onToggleDone={() => syncDone(item, !item.done)}
            />
          )}
          ListEmptyComponent={
            <ThemedText themeColor="textSecondary" style={styles.state}>
              No issues yet. Tap + to add one.
            </ThemedText>
          }
        />
        <IssueAttributesSheet
          open={editingIds !== null}
          count={editingIds?.length ?? 0}
          attributes={attributes}
          repo={repo}
          initial={editInitial}
          onClose={() => {
            setEditingIds(null);
            clear();
          }}
          onSubmit={applyEdit}
        />
      </ThemedView>
    </SwipeBackView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: Spacing.three, gap: Spacing.two },
  header: { gap: Spacing.one, marginBottom: Spacing.two },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  headerTitle: { flexShrink: 1 },
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  cardSelected: { borderColor: ACCENT, backgroundColor: hexToRgba(ACCENT, 0.1) },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.two },
  cardTitle: { flex: 1 },
  doneTitle: { textDecorationLine: 'line-through', opacity: 0.6 },
  ghBadge: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  ghBadgeText: { color: GITHUB_ACCENT, fontSize: 11 },
  summaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.two,
    marginLeft: Spacing.four,
  },
  summaryChip: {
    paddingVertical: 1,
    paddingHorizontal: Spacing.one,
    borderRadius: Spacing.one,
    borderWidth: 1,
  },
  summaryStars: { flexDirection: 'row', gap: 1 },
  description: { marginLeft: Spacing.four, lineHeight: 19 },
  state: { textAlign: 'center', marginTop: Spacing.five },
  pressed: { opacity: 0.6 },
});
