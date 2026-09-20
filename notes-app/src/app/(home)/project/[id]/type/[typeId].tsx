/**
 * A single issue *type* within a task-manager project (e.g. "Bug"). Lists the
 * issues filed under this type-note, with the same double-tap-done / long-press-
 * select / edit-attributes flows the whole project used to have — now scoped to
 * one type, since the project screen is a feed of these type-notes.
 *
 * When the project has a repo, toggling a *mirrored* issue's done flag also
 * closes/reopens its GitHub issue (push-only).
 */
import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomFade } from '@/components/edge-fade';
import { IssueAttributesSheet } from '@/components/notes/issue-attributes-sheet';
import { ScrollToTopButton } from '@/components/scroll-to-top';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useContextMenu } from '@/hooks/use-context-menu';
import { useDoubleTap } from '@/hooks/use-double-tap';
import { useScrollToTop } from '@/hooks/use-scroll-to-top';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { effectiveTypeIds, normalizeTypeIds, type Issue, type IssueAttrValue } from '@/data/notes';
import { columnsOf, useGridColumns, useGridColumnWidth, useGridEdgePadding, useTileHeight } from '@/lib/grid';
import { parseTypeConfig, projectConfig, type AttrDef } from '@/lib/project';
import {
  getGithubIssueDetail,
  githubIssueAssignees,
  githubIssueBody,
  githubIssueLabels,
  mergeManagedLabels,
  setGithubIssueState,
  updateGithubIssue,
  upsertAttrsBlock,
} from '@/lib/issue-github';
import { pushOrQueue } from '@/lib/github-outbox';
import { issueToClipboardText } from '@/lib/issue-clipboard';
import { cancelIssueRetitle } from '@/lib/issue-retitle';
import { usePendingGithubIssues } from '@/hooks/use-github-outbox';
import { useIssues } from '@/store/issues-store';
import { useNotes } from '@/store/notes-store';
import { useTaskSelection } from '@/store/task-selection-store';

const ACCENT = '#16a394';
const DONE_COLOR = '#3fb950';
const GITHUB_ACCENT = '#8250df';

/**
 * Put an issue on the clipboard, answering whether anything was written. An
 * issue with neither body nor title is skipped outright rather than writing a
 * blank string, which on web clears the clipboard instead of filling it.
 */
async function copyIssue(issue: Issue): Promise<boolean> {
  const text = issueToClipboardText(issue);
  if (!text) return false;
  try {
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    // A denied or unavailable clipboard: no checkmark, so the press reads as
    // the nothing it was.
    return false;
  }
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
  pendingPush,
  duplicateOf,
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
  /** This issue's GitHub push is held back until the device is back online. */
  pendingPush: boolean;
  /** The earlier issue this one probably duplicates, when that should show. */
  duplicateOf?: { title: string; done: boolean };
  selectionActive: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onToggleDone: () => void;
  /** Writes the clipboard; resolves false when there was nothing to copy. */
  onCopy: () => Promise<boolean>;
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
  // The flash waits on the write, because it is the only confirmation there is:
  // it used to fire regardless, so an issue with nothing to copy — or a refused
  // clipboard — looked exactly like a successful copy.
  const handleCopy = useCallback(async () => {
    if (!(await onCopy())) return;
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
        accessibilityLabel={
          `${issue.title || 'Issue'}${issue.done ? ', done' : ''}${
            duplicateOf
              ? `, possible duplicate of ${duplicateOf.title || 'an untitled issue'}${
                  duplicateOf.done ? ', which is done' : ''
                }`
              : ''
          }${pendingPush ? ', waiting to reach GitHub' : ''}`
        }
        onPress={selectionActive ? onToggleSelect : doubleTap}
        onLongPress={onToggleSelect}
        style={({ pressed }) => [styles.cardPressable, pressed && styles.pressed]}>
        <ThemedView
          type="backgroundElementAlt"
          style={[
            styles.card,
            // Expanding only ever grows the card: minHeight keeps a short issue
            // at the tile height instead of shrinking it under the tap.
            expanded ? { minHeight: tileHeight } : { height: tileHeight },
            selected && styles.cardSelected,
          ]}>
          <View style={styles.cardHeader}>
            <ThemedText
              type="smallBold"
              numberOfLines={expanded ? undefined : 2}
              style={[styles.cardTitle, issue.done && styles.doneTitle]}>
              {issue.title || 'Untitled issue'}
            </ThemedText>
            {(issue.ghNumber != null || pendingPush) && (
              <View style={styles.ghBadge}>
                {/* Full strength even when the mirror is only intended: this
                    accent barely clears the 3:1 icon-contrast bar on the card
                    background as it is, and fading it pushed it under. The
                    absent number and the clock already say 'not opened yet'. */}
                <Feather name="github" size={11} color={GITHUB_ACCENT} />
                {issue.ghNumber != null && (
                  <ThemedText type="small" style={styles.ghBadgeText}>
                    #{issue.ghNumber}
                  </ThemedText>
                )}
                {pendingPush && <Feather name="clock" size={10} color={GITHUB_ACCENT} />}
              </View>
            )}
          </View>

          {(!!duplicateOf || otherTypes.length > 0) && (
            <View style={styles.typeTagRow}>
              {/* Passive: anything tappable inside the card's Pressable would be
                  a nested <button> on web. The edit sheet is where you act on it. */}
              {duplicateOf && (
                <View style={[styles.typeTag, { borderColor: hexToRgba(theme.text, 0.15) }]}>
                  <Feather name="layers" size={9} color={theme.textSecondary} />
                  <ThemedText
                    type="small"
                    themeColor="textSecondary"
                    numberOfLines={1}
                    style={styles.duplicateTagText}>
                    Possible duplicate
                  </ThemedText>
                </View>
              )}
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

          {/* Spelled out only once the card is open. Tiles are a fixed height
              and already dense, so the collapsed card says this with the clock
              on the badge and its accessibility label. */}
          {pendingPush && expanded && (
            <ThemedText type="small" themeColor="textSecondary" style={styles.description}>
              {issue.ghNumber == null
                ? 'Will open on GitHub when you are back online.'
                : 'Changes will reach GitHub when you are back online.'}
            </ThemedText>
          )}
          {duplicateOf && expanded && (
            <ThemedText type="small" themeColor="textSecondary" style={styles.description}>
              {`Possible duplicate of “${duplicateOf.title || 'Untitled issue'}”${
                duplicateOf.done ? ' (done)' : ''
              }.`}
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
        onPress={() => void handleCopy()}
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
  // `open`: an issue to open in the edit sheet on arrival — set by another type's
  // "possible duplicate of" row, when the issue it points at lives here.
  const { id, typeId, open } = useLocalSearchParams<{ id: string; typeId: string; open?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const columns = useGridColumns();
  const columnWidth = useGridColumnWidth();
  const edgePadding = useGridEdgePadding();
  const { getFolder, getNote, getNotesInFolder } = useNotes();
  const { issues, getIssuesForNote, setDone, updateIssue, deleteIssue, dismissDuplicate } =
    useIssues();
  // Subscribed once for the whole list, not per card: a long list of cards each
  // holding their own subscription would re-render all of them on every change.
  const pendingGh = usePendingGithubIssues();
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
  // The grid is dealt into columns rather than laid out in rows. A card here
  // grows under a tap to show its whole description, and in a row layout a row
  // is as tall as its tallest cell — so opening one issue pushed the issue
  // beside it down too, for a tap that had nothing to do with it. Each column
  // now stacks on its own (see `columnsOf`), so a card only moves what is under
  // it. No spacers: a short column simply ends.
  type GridColumn = { id: string; items: Issue[] };
  const gridData = useMemo<GridColumn[]>(() => {
    // An empty list stays empty rather than becoming N empty columns, so
    // `ListEmptyComponent` still has its chance to render.
    if (data.length === 0) return [];
    return columnsOf(data, columns).map((items, i) => ({ id: `col-${i}`, items }));
  }, [data, columns]);
  const { scrollProps, scrolled, scrollToTop } = useScrollToTop<FlatList<GridColumn>>();
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

  const issueById = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues]);
  const projectTypeIds = useMemo(() => new Set(typeNotesList.map((t) => t.id)), [typeNotesList]);
  // The issue a duplicate flag points at, when the flag should show: not
  // dismissed, and the target still live and in this project. Worked out here
  // rather than written down, so trashing the target hides the flag and
  // restoring it brings the flag back, with nothing to undo either way.
  const duplicateTargetOf = useCallback(
    (issue: Issue): Issue | undefined => {
      if (!issue.duplicateOf || issue.duplicateDismissedAt !== undefined) return undefined;
      const target = issueById.get(issue.duplicateOf);
      return target && effectiveTypeIds(target).some((t) => projectTypeIds.has(t)) ? target : undefined;
    },
    [issueById, projectTypeIds],
  );

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
  // Opening an issue to edit makes its title the editor's. The sheet reseeds its
  // fields whenever the issue changes, so an AI title still on its way would
  // otherwise land under whatever they were typing.
  const editSingleId = editSingle?.id;
  useEffect(() => {
    if (editSingleId) void cancelIssueRetitle(editSingleId);
  }, [editSingleId]);
  const editDuplicate = editSingle ? duplicateTargetOf(editSingle) : undefined;

  // Arriving from another type's "possible duplicate of" row: open that issue.
  useEffect(() => {
    if (!open || !issueById.has(open)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- consume a one-shot route param
    setEditingIds([open]);
    router.setParams({ open: undefined });
  }, [open, issueById, router]);

  // Tap-through from the sheet's duplicate row. Unapplied edits are discarded,
  // the same as tapping the backdrop.
  const openDuplicate = useCallback(() => {
    if (!editDuplicate) return;
    const targetTypes = effectiveTypeIds(editDuplicate);
    if (targetTypes.includes(typeId)) {
      // In this list already: the sheet reseeds from the new selection in place.
      setEditingIds([editDuplicate.id]);
      return;
    }
    const home = targetTypes.find((t) => projectTypeIds.has(t));
    if (!home) return;
    setEditingIds(null);
    clear();
    router.push({
      pathname: '/project/[id]/type/[typeId]',
      params: { id, typeId: home, open: editDuplicate.id },
    });
  }, [editDuplicate, typeId, projectTypeIds, clear, router, id]);
  const editInitialTypeIds = useMemo<string[] | undefined>(
    () => (editSingle ? effectiveTypeIds(editSingle) : undefined),
    [editSingle],
  );

  // Toggle done locally and, for a mirrored issue, push the close/reopen to
  // GitHub (best-effort — a failure leaves the local flag set).
  //
  // Keyed on the issue's own ghNumber, never on the viewed type's
  // `githubConnected`. That flag decides whether NEW issues get mirrored; it
  // says nothing about whether THIS issue already is. An issue can sit under a
  // disconnected type while mirrored — as a secondary type on a multi-type
  // issue, or under a type detracked after its issues were already pushed.
  // Back-sync pulls every ghNumber'd issue regardless of any type flag, so
  // gating the push here meant GitHub's stale "open" won on the next
  // reconcile: checking off silently reverted, in that one category only.
  const syncDone = useCallback(
    (issue: Issue, done: boolean) => {
      setDone(issue.id, done);
      if (repo && issue.ghNumber != null) {
        const ghNumber = issue.ghNumber;
        // Offline, the close/reopen is held and replayed later against the
        // issue's state *at that point* — so ticking and un-ticking while
        // disconnected settles on whatever the user actually left it at.
        void pushOrQueue({
          issueId: issue.id,
          repo,
          facets: { state: true },
          push: () => setGithubIssueState(repo, ghNumber, done),
        }).then((r) => {
          if (r.status === 'failed') {
            Alert.alert(done ? 'Not closed on GitHub' : 'Not reopened on GitHub', r.message);
          }
        });
      }
    },
    [setDone, repo],
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
      issueId: string,
      ghNumber: number,
      attrs: Record<string, IssueAttrValue>,
      typeTitles: string[],
      details?: { title: string; description: string },
    ) => {
      // Mirrored-issue-only, like syncDone — every caller already guards on
      // `ghNumber != null`, and back-sync pulls title/attrs for any mirrored
      // issue, so gating on the viewed type's flag would let GitHub's copy
      // overwrite an edit that was never pushed.
      if (!repo) return;
      const typeLabels = githubIssueLabels(typeTitles);
      const assignees = githubIssueAssignees(attributes, attrs);
      // `details` is the intent the replay needs: without it a later flush must
      // keep GitHub's own body, since the description is never back-synced and
      // pushing the local copy unasked would wipe an edit made over there.
      const r = await pushOrQueue({
        issueId,
        repo,
        facets: details ? { details: true } : {},
        push: async () => {
          const { labels: current, body: currentBody } = await getGithubIssueDetail(repo, ghNumber);
          const labels = mergeManagedLabels(current, typeLabels, attributes, typeNames);
          // When Details were edited, rebuild the body from the new description +
          // attributes; otherwise refresh only the attributes block, keeping the
          // description GitHub already has.
          const body = details
            ? (githubIssueBody(details.description, attributes, attrs, issueId) ?? '')
            : upsertAttrsBlock(currentBody, attributes, attrs, issueId);
          await updateGithubIssue(repo, ghNumber, {
            labels,
            assignees,
            body,
            ...(details ? { title: details.title || 'Untitled issue' } : {}),
          });
        },
      });
      if (r.status === 'failed') Alert.alert('Changes not synced to GitHub', r.message);
    },
    [repo, attributes, typeNames],
  );

  const applyEdit = useCallback(
    (
      attrs: Record<string, IssueAttrValue>,
      single?: {
        title: string;
        description: string;
        typeIds?: string[];
        dismissDuplicate?: boolean;
      },
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
        // App-only: the flag never reaches GitHub, so there is nothing to push.
        if (single?.dismissDuplicate) dismissDuplicate(issueId);
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
          void pushAttrsToGithub(issue.id, issue.ghNumber, attrs, typeTitles, details);
        }
      });
      setEditingIds(null);
      clear();
    },
    [editingIds, updateIssue, clear, issues, pushAttrsToGithub, typeTitleById, dismissDuplicate],
  );

  const headerTop = insets.top + Spacing.four;

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <FlatList
          {...scrollProps}
          data={gridData}
          keyExtractor={(item) => item.id}
          numColumns={columns}
          // The column count changes with the window on web, and React Native
          // refuses to change numColumns in place — the list must remount.
          key={columns}
          columnWrapperStyle={styles.row}
          extraData={{ selectionActive, selectedIds }}
          contentContainerStyle={[
            styles.content,
            edgePadding,
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
          renderItem={({ item: column }) => (
            <View style={[styles.cardCell, { width: columnWidth }]}>
              {column.items.map((item) => {
                const duplicate = duplicateTargetOf(item);
                return (
                  <IssueCard
                    key={item.id}
                    issue={item}
                    attributes={attributes}
                    otherTypes={effectiveTypeIds(item)
                      .filter((tid) => tid !== typeId)
                      .map((tid) => typeTitleById.get(tid))
                      .filter((t): t is string => !!t)}
                    pendingPush={pendingGh.has(item.id)}
                    duplicateOf={
                      duplicate ? { title: duplicate.title, done: duplicate.done } : undefined
                    }
                    selectionActive={selectionActive}
                    selected={isSelected(item.id)}
                    onToggleSelect={() => toggle(item.id)}
                    onToggleDone={() => syncDone(item, !item.done)}
                    onCopy={() => copyIssue(item)}
                  />
                );
              })}
            </View>
          )}
          ListEmptyComponent={
            <ThemedText themeColor="textSecondary" style={styles.state}>
              No issues yet. Tap + to add one.
            </ThemedText>
          }
        />
        <BottomFade />
        <ScrollToTopButton visible={scrolled} onPress={scrollToTop} />
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
          duplicateTitle={editDuplicate?.title}
          duplicateDone={editDuplicate?.done}
          onOpenDuplicate={openDuplicate}
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
  // One column's stack. The gap is what used to be the row gap in
  // `contentContainerStyle` — it now runs down a column instead of between rows.
  cardCell: { flexGrow: 0, flexShrink: 1, minWidth: 0, gap: Spacing.three },
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
  duplicateTagText: { fontSize: 11 },
  description: { marginLeft: Spacing.three, lineHeight: 19 },
  state: { textAlign: 'center', marginTop: Spacing.five },
  pressed: { opacity: 0.6 },
});
