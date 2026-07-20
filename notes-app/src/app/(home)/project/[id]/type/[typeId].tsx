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
import * as Clipboard from 'expo-clipboard';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';
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
import { effectiveTypeIds, normalizeTypeIds, type Issue, type IssueAttrValue } from '@/data/notes';
import { GRID_COLUMNS, gridEdgePadding, trailingSpacers, useGridColumnWidth, useTileHeight } from '@/lib/grid';
import { parseTypeConfig, projectConfig, type AttrDef } from '@/lib/project';
import {
  getGithubIssueDetail,
  githubIssueAssignees,
  githubIssueBody,
  githubIssueLabels,
  githubSyncErrorMessage,
  mergeManagedLabels,
  setGithubIssueState,
  updateGithubIssue,
  upsertAttrsBlock,
} from '@/lib/issue-github';
import { Sentry } from '@/lib/sentry';
import { useIssues } from '@/store/issues-store';
import { useNotes } from '@/store/notes-store';
import { useTaskSelection } from '@/store/task-selection-store';

const ACCENT = '#16a394';
const DONE_COLOR = '#3fb950';
const GITHUB_ACCENT = '#8250df';

/** Serialize an issue's title and description as text. */
function issueToClipboardText(issue: Issue): string {
  const lines: string[] = [issue.title.trim() || 'Untitled issue'];
  if (issue.description.trim()) lines.push('', issue.description.trim());
  return lines.join('\n');
}

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

function IssueCard({
  issue,
  attributes,
  otherTypes,
  selectionActive,
  selected,
  onToggleSelect,
  onToggleDone,
  onCopy,
}: {
  issue: Issue;
  attributes: AttrDef[];
  /** Titles of the issue's other types (besides this screen's) — shown as chips. */
  otherTypes: string[];
  selectionActive: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onToggleDone: () => void;
  onCopy: () => void;
}) {
  const theme = useTheme();
  // Same shared tile height the note/folder feed uses, so issue cards line up
  // uniformly. Expanding a card lets it grow past the fixed height to reveal the
  // full description (the copa pattern) rather than clipping it forever.
  const tileHeight = useTileHeight();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  // Single tap expands the description; double tap toggles done.
  const doubleTap = useDoubleTap(() => setExpanded((v) => !v), onToggleDone);
  const contextMenuRef = useContextMenu(onToggleSelect);
  // The corner status icon is a one-tap shortcut: mark done / undo (or, in
  // selection mode, toggle this issue's selection like the rest of the card).
  const onStatusPress = selectionActive ? onToggleSelect : onToggleDone;

  // Copy this issue to the clipboard, flashing a checkmark for confirmation.
  const handleCopy = useCallback(() => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [onCopy]);

  return (
    // The status/copy buttons are siblings of the card Pressable (not children)
    // so they aren't nested <button>s inside the card's <button> on web.
    <View style={styles.tile}>
      <Pressable
        ref={contextMenuRef}
        accessibilityRole="button"
        accessibilityState={{ selected, checked: issue.done }}
        accessibilityLabel={`${issue.title || 'Issue'}${issue.done ? ', done' : ''}`}
        onPress={selectionActive ? onToggleSelect : doubleTap}
        onLongPress={onToggleSelect}
        style={({ pressed }) => [styles.cardPressable, pressed && styles.pressed]}>
        <ThemedView
          type="backgroundElementAlt"
          style={[styles.card, { height: expanded ? undefined : tileHeight }, selected && styles.cardSelected]}>
          <View style={styles.cardHeader}>
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

          {otherTypes.length > 0 && (
            <View style={styles.typeTagRow}>
              {otherTypes.map((t) => (
                <View key={t} style={[styles.typeTag, { borderColor: hexToRgba(ACCENT, 0.4) }]}>
                  <Feather name="columns" size={9} color={ACCENT} />
                  <ThemedText type="small" numberOfLines={1} style={styles.typeTagText}>
                    {t}
                  </ThemedText>
                </View>
              ))}
            </View>
          )}

          <AttrSummary attributes={attributes} attrs={issue.attrs} />

          {!!issue.description && (
            <ThemedText
              type="small"
              themeColor="textSecondary"
              numberOfLines={expanded ? undefined : 4}
              style={styles.description}>
              {issue.description}
            </ThemedText>
          )}
        </ThemedView>
      </Pressable>
      <Pressable
        onPress={onStatusPress}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityState={{ checked: selectionActive ? selected : issue.done }}
        accessibilityLabel={
          selectionActive
            ? selected
              ? 'Deselect issue'
              : 'Select issue'
            : issue.done
              ? 'Mark issue not done'
              : 'Mark issue done'
        }
        style={({ pressed }) => [styles.statusButton, pressed && styles.pressed]}>
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
      </Pressable>
      <Pressable
        onPress={handleCopy}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Copy issue"
        style={({ pressed }) => [styles.copyButton, pressed && styles.pressed]}>
        <Feather
          name={copied ? 'check' : 'copy'}
          size={18}
          color={copied ? DONE_COLOR : theme.textSecondary}
        />
      </Pressable>
    </View>
  );
}

export default function IssueTypeScreen() {
  const { id, typeId } = useLocalSearchParams<{ id: string; typeId: string }>();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const columnWidth = useGridColumnWidth();
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
  // Grid rows: the issues plus transparent spacers padding the last row so its
  // cards stay one column wide (same layout as the note/folder feed).
  type GridRow = Issue | { spacer: true; id: string };
  const gridData = useMemo<GridRow[]>(() => {
    const rows: GridRow[] = [...data];
    for (let i = 0; i < trailingSpacers(data.length); i++) rows.push({ spacer: true, id: `spacer-${i}` });
    return rows;
  }, [data]);
  // The project's issue-type notes (id + title), ordered — powers both the Types
  // picker in the edit sheet and the "other types" chips on each card.
  const typeNotesList = useMemo(
    () =>
      getNotesInFolder(id)
        .filter((n) => n.pluginType === 'issuetype')
        .sort((a, b) => parseTypeConfig(a.pluginConfig).order - parseTypeConfig(b.pluginConfig).order)
        .map((n) => ({ id: n.id, title: n.title })),
    [getNotesInFolder, id],
  );
  const typeTitleById = useMemo(() => {
    const m = new Map<string, string>();
    typeNotesList.forEach((t) => m.set(t.id, t.title));
    return m;
  }, [typeNotesList]);
  // All the project's issue-type names — used to tell this app's managed labels
  // apart from labels a user added on GitHub, so an edit preserves the latter.
  const typeNames = useMemo(() => typeNotesList.map((t) => t.title), [typeNotesList]);

  // Which issues the edit-attributes sheet is acting on (null = closed).
  const [editingIds, setEditingIds] = useState<string[] | null>(null);
  const editInitial = useMemo<Record<string, IssueAttrValue>>(() => {
    if (!editingIds || editingIds.length === 0) return {};
    return issues.find((i) => i.id === editingIds[0])?.attrs ?? {};
  }, [editingIds, issues]);
  // Seed the Types picker + Details fields (shown only for a single-issue edit).
  const editSingle = useMemo(() => {
    if (!editingIds || editingIds.length !== 1) return undefined;
    return issues.find((i) => i.id === editingIds[0]);
  }, [editingIds, issues]);
  const editInitialTypeIds = useMemo<string[] | undefined>(
    () => (editSingle ? effectiveTypeIds(editSingle) : undefined),
    [editSingle],
  );

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

  // Push an issue's edited fields to its mirrored GitHub issue: every type →
  // labels (merged over the issue's current labels so foreign ones survive),
  // attributes → the managed block in the issue body (preserving the user's
  // description), People → assignees, and title/body when the Details fields were
  // edited. Best-effort; a failure leaves the local edit. `typeTitles` is the
  // issue's full (post-edit) type set.
  const pushAttrsToGithub = useCallback(
    async (
      ghNumber: number,
      attrs: Record<string, IssueAttrValue>,
      typeTitles: string[],
      details?: { title: string; description: string },
    ) => {
      if (!connected || !repo) return;
      const typeLabels = githubIssueLabels(typeTitles);
      const assignees = githubIssueAssignees(attributes, attrs);
      try {
        const { labels: current, body: currentBody } = await getGithubIssueDetail(repo, ghNumber);
        const labels = mergeManagedLabels(current, typeLabels, attributes, typeNames);
        // When Details were edited, rebuild the body from the new description +
        // attributes; otherwise refresh only the attributes block, keeping the
        // description GitHub already has.
        const body = details
          ? (githubIssueBody(details.description, attributes, attrs) ?? '')
          : upsertAttrsBlock(currentBody, attributes, attrs);
        await updateGithubIssue(repo, ghNumber, {
          labels,
          assignees,
          body,
          ...(details ? { title: details.title || 'Untitled issue' } : {}),
        });
      } catch (e) {
        Sentry.captureException(e, { tags: { source: 'issue-github', op: 'attrs' } });
        Alert.alert('Changes not synced to GitHub', githubSyncErrorMessage(e));
      }
    },
    [connected, repo, attributes, typeNames],
  );

  const applyEdit = useCallback(
    (
      attrs: Record<string, IssueAttrValue>,
      single?: { title: string; description: string; typeIds?: string[] },
    ) => {
      // Title/description/type edits only come from a single-issue edit (the
      // sheet only shows those fields then). Normalize types so noteId stays the
      // first/primary type.
      const typePatch = single?.typeIds ? normalizeTypeIds(single.typeIds) : null;
      editingIds?.forEach((issueId) => {
        updateIssue(issueId, {
          attrs,
          ...(single ? { title: single.title, description: single.description } : {}),
          ...(typePatch ? { noteId: typePatch.noteId, typeIds: typePatch.typeIds } : {}),
        });
        const issue = issues.find((i) => i.id === issueId);
        if (issue?.ghNumber != null) {
          // Push the issue's full (post-edit) type set as labels, not just this
          // screen's type — so GitHub reflects every type the issue carries.
          const effTypeIds = typePatch ? typePatch.typeIds : effectiveTypeIds(issue);
          const typeTitles = effTypeIds
            .map((tid) => typeTitleById.get(tid))
            .filter((t): t is string => !!t);
          // Only push title/body to GitHub when they actually changed, so a
          // pure attribute/type edit can't clobber a GitHub-side body edit
          // (the body is never back-synced into the local description).
          const details =
            single && (single.title !== issue.title || single.description !== issue.description)
              ? single
              : undefined;
          void pushAttrsToGithub(issue.ghNumber, attrs, typeTitles, details);
        }
      });
      setEditingIds(null);
      clear();
    },
    [editingIds, updateIssue, clear, issues, pushAttrsToGithub, typeTitleById],
  );

  const headerTop = insets.top + Spacing.four;

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <FlatList
          data={gridData}
          keyExtractor={(item) => item.id}
          numColumns={GRID_COLUMNS}
          columnWrapperStyle={styles.row}
          extraData={{ selectionActive, selectedIds }}
          contentContainerStyle={[
            styles.content,
            gridEdgePadding,
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
          renderItem={({ item }) => {
            if ('spacer' in item) return <View style={[styles.cardCell, { width: columnWidth }]} />;
            return (
              <View style={[styles.cardCell, { width: columnWidth }]}>
                <IssueCard
                  issue={item}
                  attributes={attributes}
                  otherTypes={effectiveTypeIds(item)
                    .filter((tid) => tid !== typeId)
                    .map((tid) => typeTitleById.get(tid))
                    .filter((t): t is string => !!t)}
                  selectionActive={selectionActive}
                  selected={isSelected(item.id)}
                  onToggleSelect={() => toggle(item.id)}
                  onToggleDone={() => syncDone(item, !item.done)}
                  onCopy={() => void Clipboard.setStringAsync(issueToClipboardText(item))}
                />
              </View>
            );
          }}
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
          types={editingIds?.length === 1 ? typeNotesList : undefined}
          initialTypeIds={editInitialTypeIds}
          initialTitle={editSingle?.title}
          initialDescription={editSingle?.description}
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
  content: { paddingHorizontal: Spacing.three, gap: Spacing.three },
  header: { gap: Spacing.one, marginBottom: Spacing.two },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  headerTitle: { flexShrink: 1 },
  // Grid row/cell — mirrors the note/folder feed: fixed one-column width (inline)
  // with flexGrow:0 so a card can't stretch into a partial row's empty space.
  row: { gap: Spacing.three, alignItems: 'flex-start' },
  cardCell: { flexGrow: 0, flexShrink: 1, minWidth: 0, overflow: 'hidden' },
  // Positioning context for the status/copy overlay buttons; wraps the card
  // Pressable so those buttons stay siblings (not nested <button>s on web).
  tile: { position: 'relative' },
  cardPressable: {},
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
    borderWidth: 1.5,
    borderColor: 'transparent',
    // Clip content to the tile when collapsed (fixed height); the card grows to
    // fit when expanded so nothing is lost.
    overflow: 'hidden',
  },
  cardSelected: { borderColor: ACCENT, backgroundColor: hexToRgba(ACCENT, 0.1) },
  // Reserve room on the left so the title/badges never slide under the top-left
  // status toggle.
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    paddingLeft: Spacing.three,
  },
  cardTitle: { flex: 1, minWidth: 0 },
  doneTitle: { textDecorationLine: 'line-through', opacity: 0.6 },
  ghBadge: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  ghBadgeText: { color: GITHUB_ACCENT, fontSize: 11 },
  // One-tap done/undo toggle, overlaid on the card's top-left corner. A sibling
  // (not a child) of the card Pressable so it isn't a nested button on web and
  // its tap doesn't bubble to the card.
  statusButton: {
    position: 'absolute',
    top: Spacing.two,
    left: Spacing.two,
    padding: Spacing.half,
  },
  // Overlaid on the card's bottom-right corner.
  copyButton: {
    position: 'absolute',
    bottom: Spacing.two,
    right: Spacing.two,
    padding: Spacing.half,
  },
  summaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.two,
    marginLeft: Spacing.three,
  },
  summaryChip: {
    paddingVertical: 1,
    paddingHorizontal: Spacing.one,
    borderRadius: Spacing.one,
    borderWidth: 1,
  },
  summaryStars: { flexDirection: 'row', gap: 1 },
  typeTagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.one,
    marginLeft: Spacing.three,
  },
  typeTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingVertical: 1,
    paddingHorizontal: Spacing.one,
    borderRadius: Spacing.one,
    borderWidth: 1,
  },
  typeTagText: { color: ACCENT, fontSize: 11 },
  description: { marginLeft: Spacing.three, lineHeight: 19 },
  state: { textAlign: 'center', marginTop: Spacing.five },
  pressed: { opacity: 0.6 },
});
