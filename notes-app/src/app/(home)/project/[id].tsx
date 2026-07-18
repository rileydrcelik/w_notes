/**
 * A task-manager "project" folder. Once configured, it renders as a feed of its
 * issue-type notes (Bug, Feature, …) — each a card previewing the issues filed
 * under it — mirroring how notes appear in a folder. Tapping a type card opens
 * that type's issue list (`project/[id]/type/[typeId]`); the per-type screen owns
 * issue creation and the select→act flows. Adding a type lives here on the feed.
 *
 * Before it's configured, it shows the {@link ProjectConfig} setup (name + repo).
 */
import Feather from '@expo/vector-icons/Feather';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FolderCard, NoteCard } from '@/components/notes/cards';
import { ProjectConfig } from '@/components/notes/project-config';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { hexToRgba, Spacing } from '@/constants/theme';
import { GRID_COLUMNS, gridEdgePadding, trailingSpacers, useGridColumnWidth, useTileHeight } from '@/lib/grid';
import { useContextMenu } from '@/hooks/use-context-menu';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import type { Folder, Note } from '@/data/notes';
import { reconcileProjectWithGithub } from '@/lib/github-backsync';
import { githubSyncErrorMessage } from '@/lib/issue-github';
import {
  defaultAttributes,
  parseTypeConfig,
  projectConfig,
  serializeProjectConfig,
} from '@/lib/project';
import { Sentry } from '@/lib/sentry';
import { useIssues } from '@/store/issues-store';
import { useItemSelection } from '@/store/item-selection-store';
import { useNotes } from '@/store/notes-store';
import { useTaskSelection } from '@/store/task-selection-store';

const ACCENT = '#16a394';
const DONE_COLOR = '#3fb950';
const GITHUB_ACCENT = '#8250df';
/** Accent for a long-pressed/right-clicked (selected) card — matches cards.tsx. */
const SELECT_ACCENT = '#7a89b8';

/**
 * A card for one issue type: name, count, GitHub badge, and an issue preview.
 * Long-press / right-click selects it (joining the shared note/folder selection),
 * so the navbar's "⋯" can act on it — e.g. toggle its GitHub tracking. A plain
 * tap opens the type's issue list, or toggles selection while selecting.
 */
function IssueTypeCard({ projectId, note }: { projectId: string; note: Note }) {
  const router = useRouter();
  const theme = useTheme();
  const { getIssuesForNote } = useIssues();
  const { active, isSelected, toggle } = useItemSelection();
  const issues = getIssuesForNote(note.id);
  const connected = parseTypeConfig(note.pluginConfig).githubConnected;
  const preview = issues.slice(0, 4);
  const selected = isSelected('issuetype', note.id);
  const onSelectToggle = () => toggle({ type: 'issuetype', id: note.id });
  // Web right-click parity with long-press (no-op on native).
  const contextMenuRef = useContextMenu(onSelectToggle);
  const tileHeight = useTileHeight();

  return (
    <Pressable
      ref={contextMenuRef}
      style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
      onPress={
        active
          ? onSelectToggle
          : () =>
              router.push({
                pathname: '/project/[id]/type/[typeId]',
                params: { id: projectId, typeId: note.id },
              })
      }
      onLongPress={onSelectToggle}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${note.title || 'Untitled'} issues`}>
      <ThemedView type="backgroundElementAlt" style={[styles.card, selected && styles.cardSelected]}>
        <View style={styles.cardTop}>
          <Feather name="tag" size={14} color={ACCENT} />
          <ThemedText type="smallBold" numberOfLines={1} style={styles.cardName}>
            {note.title || 'Untitled'}
          </ThemedText>
          {connected && <Feather name="github" size={12} color={GITHUB_ACCENT} />}
          <ThemedText type="small" themeColor="textSecondary">
            {issues.length}
          </ThemedText>
        </View>
        {preview.length > 0 ? (
          <View style={styles.previewList}>
            {preview.map((i) => (
              <View key={i.id} style={styles.previewRow}>
                <Feather
                  name={i.done ? 'check-circle' : 'circle'}
                  size={11}
                  color={i.done ? DONE_COLOR : theme.textSecondary}
                />
                <ThemedText
                  type="small"
                  themeColor="textSecondary"
                  numberOfLines={1}
                  style={[styles.previewText, i.done && styles.previewDone]}>
                  {i.title || 'Untitled issue'}
                </ThemedText>
              </View>
            ))}
            {issues.length > preview.length && (
              <ThemedText type="small" themeColor="textSecondary">
                +{issues.length - preview.length} more
              </ThemedText>
            )}
          </View>
        ) : (
          <ThemedText type="small" themeColor="textSecondary">
            No issues yet.
          </ThemedText>
        )}
      </ThemedView>
    </Pressable>
  );
}

type GridItem =
  | { kind: 'type'; note: Note }
  | { kind: 'folder'; folder: Folder }
  | { kind: 'note'; note: Note }
  | { kind: 'spacer' };

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const columnWidth = useGridColumnWidth();
  const { getFolder, getNotesInFolder, getSubfolders, updateFolder, createIssueTypeNote } =
    useNotes();
  const { issues, hydrated, createIssue, updateIssue } = useIssues();
  const { registerCompose } = useTaskSelection();

  const folder = getFolder(id);
  const config = useMemo(
    () => (folder ? projectConfig(folder) : null),
    [folder?.kind, folder?.config],
  );

  const typeNotes = useMemo(
    () =>
      getNotesInFolder(id)
        .filter((n) => n.pluginType === 'issuetype')
        .sort((a, b) => parseTypeConfig(a.pluginConfig).order - parseTypeConfig(b.pluginConfig).order),
    [getNotesInFolder, id],
  );

  // Anything else filed under the project — plain notes, Sentry/GitHub views, and
  // subfolders (created here via the (+) menu, or moved in) — rendered as normal
  // cards below the issue types so they aren't hidden.
  const otherNotes = useMemo(
    () => getNotesInFolder(id).filter((n) => n.pluginType !== 'issuetype'),
    [getNotesInFolder, id],
  );
  const subfolders = useMemo(() => getSubfolders(id), [getSubfolders, id]);

  // GitHub back-sync. A ref carries the latest project data so `runBacksync`
  // stays referentially stable — the focus trigger fires once per focus, not on
  // every unrelated issues-store change.
  const [syncing, setSyncing] = useState(false);
  const syncRef = useRef({ repo: config?.repo, attributes: config?.attributes ?? [], typeNotes, issues });
  // Keep the ref current (updated in an effect, not during render). Declared
  // before the focus effects so it runs first and runBacksync reads fresh data.
  useEffect(() => {
    syncRef.current = { repo: config?.repo, attributes: config?.attributes ?? [], typeNotes, issues };
  });

  const runBacksync = useCallback(
    async (manual = false) => {
      const { repo, attributes, typeNotes: types, issues: allIssues } = syncRef.current;
      if (!repo) return;
      const typeIds = new Set(types.map((t) => t.id));
      const projectIssues = allIssues.filter((i) => typeIds.has(i.noteId));
      // Create the "Unorganized" import bucket at most once per run.
      let unorgId = types.find((t) => t.title.trim().toLowerCase() === 'unorganized')?.id ?? null;
      const ensureUnorganizedType = () => {
        if (unorgId) return unorgId;
        const order =
          types.reduce((m, t) => Math.max(m, parseTypeConfig(t.pluginConfig).order), -1) + 1;
        unorgId = createIssueTypeNote(id, 'Unorganized', true, order);
        return unorgId;
      };
      setSyncing(true);
      try {
        await reconcileProjectWithGithub({
          repo,
          attributes,
          issues: projectIssues,
          actions: { createIssue, updateIssue, ensureUnorganizedType },
        });
      } catch (e) {
        Sentry.captureException(e, { tags: { source: 'github-backsync' } });
        if (manual) Alert.alert('Couldn’t sync from GitHub', githubSyncErrorMessage(e));
      } finally {
        setSyncing(false);
      }
    },
    [id, createIssue, updateIssue, createIssueTypeNote],
  );

  // While this feed is focused the navbar's (+) composes an issue for this
  // project (no fixed type — the composer shows the type picker). A per-type
  // screen re-registers with its own type when it takes focus.
  useFocusEffect(
    useCallback(() => {
      registerCompose(id);
      return () => registerCompose(null);
    }, [id, registerCompose]),
  );

  // Pull GitHub changes back in whenever the feed comes into focus — but only
  // once the local issues have loaded, so matching by gh_number can't be fooled
  // into re-importing everything. If focus happens before hydration, this re-runs
  // when `hydrated` flips (the callback identity changes).
  useFocusEffect(
    useCallback(() => {
      if (hydrated) void runBacksync();
    }, [runBacksync, hydrated]),
  );

  // Write the picked name + repo into the folder and seed the default types.
  // Bug and Feature start GitHub-connected so their issues push to the repo.
  const handleConfigure = useCallback(
    (input: { name: string; repo: string }) => {
      updateFolder(id, {
        name: input.name,
        config: serializeProjectConfig({ repo: input.repo, attributes: defaultAttributes() }),
      });
      createIssueTypeNote(id, 'Bug', true, 0);
      createIssueTypeNote(id, 'Feature', true, 1);
    },
    [id, updateFolder, createIssueTypeNote],
  );

  const items: GridItem[] = [
    ...typeNotes.map((note) => ({ kind: 'type' as const, note })),
    ...subfolders.map((sub) => ({ kind: 'folder' as const, folder: sub })),
    ...otherNotes.map((note) => ({ kind: 'note' as const, note })),
  ];
  for (let i = 0; i < trailingSpacers(items.length); i++) items.push({ kind: 'spacer' });

  const headerTop = insets.top + Spacing.four;

  if (folder?.kind === 'project' && !config) {
    return (
      <SwipeBackView>
        <ThemedView style={styles.container}>
          <Stack.Screen options={{ headerShown: false }} />
          <ProjectConfig paddingTop={headerTop} paddingBottom={tabBarInset} onSubmit={handleConfigure} />
        </ThemedView>
      </SwipeBackView>
    );
  }

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <FlatList
          data={items}
          keyExtractor={(item, index) =>
            item.kind === 'type' || item.kind === 'note'
              ? item.note.id
              : item.kind === 'folder'
                ? item.folder.id
                : `spacer-${index}`
          }
          numColumns={GRID_COLUMNS}
          columnWrapperStyle={styles.row}
          refreshControl={
            config?.repo ? (
              <RefreshControl
                refreshing={syncing}
                onRefresh={() => void runBacksync(true)}
                tintColor={ACCENT}
                colors={[ACCENT]}
              />
            ) : undefined
          }
          contentContainerStyle={[
            styles.content,
            gridEdgePadding,
            { paddingTop: headerTop, paddingBottom: tabBarInset },
          ]}
          ListHeaderComponent={
            <View style={styles.header}>
              <View style={styles.headerTitleRow}>
                <Feather name="columns" size={22} color={ACCENT} />
                <TextInput
                  value={folder?.name ?? ''}
                  onChangeText={(name) => updateFolder(id, { name })}
                  placeholder="Project name"
                  placeholderTextColor={theme.textSecondary}
                  style={[styles.titleInput, { color: theme.text }]}
                  editable={!!folder}
                />
              </View>
              {!!config?.repo && (
                <ThemedText type="small" themeColor="textSecondary">
                  {config.repo}
                </ThemedText>
              )}
            </View>
          }
          renderItem={({ item }) => {
            // Wrap every cell in a View so the row distributes evenly on web
            // (a Pressable flex child sizes differently from a View one).
            if (item.kind === 'spacer') return <View style={[styles.cardCell, { width: columnWidth }]} />;
            const card =
              item.kind === 'folder' ? (
                <FolderCard folder={item.folder} />
              ) : item.kind === 'note' ? (
                <NoteCard note={item.note} />
              ) : (
                <IssueTypeCard projectId={id} note={item.note} />
              );
            return <View style={[styles.cardCell, { width: columnWidth }]}>{card}</View>;
          }}
          ListEmptyComponent={
            <ThemedText themeColor="textSecondary" style={styles.state}>
              No issue types yet. Tap + to add an issue and pick its type.
            </ThemedText>
          }
        />
      </ThemedView>
    </SwipeBackView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.three, gap: Spacing.three },
  header: { gap: Spacing.one, marginBottom: Spacing.one },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  titleInput: { flex: 1, fontSize: 24, lineHeight: 30, fontWeight: '700' },
  row: { gap: Spacing.three, alignItems: 'flex-start' },
  // Fixed one-column width (applied inline) + flexGrow:0 so a card can't stretch
  // past its column into a partial row's empty space (what made them too wide).
  cardCell: { flexGrow: 0, flexShrink: 1, minWidth: 0, overflow: 'hidden' },
  // No `flex: 1` — the cardCell sets width; the card stretches to it and takes
  // its explicit height (flex here would fight the height, skewing row heights).
  cardWrapper: { minWidth: 0 },
  card: {
    flex: 1,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  // Highlight for a selected (long-pressed/right-clicked) type card.
  cardSelected: { borderColor: SELECT_ACCENT, backgroundColor: hexToRgba(SELECT_ACCENT, 0.12) },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  // minWidth:0 lets the nowrap title/rows ellipsize within the cell on web
  // instead of forcing the card wider than its column.
  cardName: { flex: 1, minWidth: 0 },
  previewList: { gap: Spacing.half },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  previewText: { flex: 1, minWidth: 0 },
  previewDone: { textDecorationLine: 'line-through', opacity: 0.6 },
  state: { textAlign: 'center', marginTop: Spacing.five },
  pressed: { opacity: 0.6 },
});
