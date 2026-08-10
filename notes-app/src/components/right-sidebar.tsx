import Feather from '@expo/vector-icons/Feather';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, type Href } from 'expo-router';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  SlideInRight,
  SlideOutRight,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { SearchBar, SEARCH_BAR_HEIGHT } from '@/components/search-bar';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import type { Folder, Note } from '@/data/notes';
import { useTheme } from '@/hooks/use-theme';
import { folderHref, isListableNote, noteHref, noteIcon } from '@/lib/item-route';
import { matchesQuery } from '@/lib/search';
import { useNotes } from '@/store/notes-store';
import { noScrollbar } from '@/lib/scroll-style';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Right-margin step per nesting level, indenting deeper rows from the edge. */
const INDENT = Spacing.four;

type FeatherName = ComponentProps<typeof Feather>['name'];

/**
 * Right-hand drawer (73.75% width on phones, 33% on web) listing quick-access
 * shortcuts and the full note hierarchy. Rendered from inside the floating tab
 * bar so the navbar
 * always stacks above it. Always mounted; the inner content mounts/unmounts on
 * `open` so the slide/fade exit animations get a chance to play.
 */
export function RightSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const colors = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    folders,
    notes,
    trash,
    getNotesInFolder,
    getRootNotes,
    getRootFolders,
    getSubfolders,
    createFolder,
  } = useNotes();

  // The hierarchy lists notes, and an issue type is not one — it's a row of the
  // task manager that happens to be stored as a note. Filtering here rather than
  // at each call site keeps the counts honest too: a project folder used to
  // report the number of issue types as its note count.
  const notesIn = (folderId: string) => getNotesInFolder(folderId).filter(isListableNote);
  const rootNotes = getRootNotes().filter(isListableNote);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');

  // Quick-access counts, all live: favorites and shared from the flags on notes/
  // folders, trash from the trash store. Each row opens its screen.
  const listable = notes.filter(isListableNote);
  const listableCount = listable.length;
  const favoritesCount =
    folders.filter((folder) => folder.favorite).length +
    listable.filter((note) => note.favorite).length;
  const sharedCount = listable.filter((note) => note.shared).length;

  const quickItems: { key: string; label: string; icon: FeatherName; count: number; path: Href }[] =
    [
      { key: 'favorites', label: 'Favorites', icon: 'star', count: favoritesCount, path: '/favorites' },
      { key: 'shared', label: 'Shared', icon: 'share-2', count: sharedCount, path: '/shared' },
      { key: 'trash', label: 'Trash', icon: 'trash-2', count: trash.length, path: '/trash' },
    ];

  const q = query.trim();
  const searching = q.length > 0;
  // The tree is ordered structurally, so this view wants the boolean rather than
  // the score — but it's the same matcher the ranked views use, which is the
  // point: one place decides what "matches" means (see `lib/search.ts`).
  const noteMatches = (title: string, body: string) =>
    matchesQuery({ titles: [title], body }, q);
  const nameMatches = (name: string) => matchesQuery({ titles: [name] }, q);

  // A folder is relevant while searching if its own name matches, it holds a
  // matching note, or anything beneath it in the tree qualifies.
  const folderMatchesSearch = (folder: Folder): boolean =>
    nameMatches(folder.name) ||
    notesIn(folder.id).some((note) => noteMatches(note.title, note.body)) ||
    getSubfolders(folder.id).some(folderMatchesSearch);

  // The hierarchy is rendered from the home-screen folders down; searching
  // prunes it to branches that contain a match. Root notes follow underneath.
  const rootFolders = getRootFolders();
  const visibleRootFolders = searching ? rootFolders.filter(folderMatchesSearch) : rootFolders;
  const visibleRootNotes = searching
    ? rootNotes.filter((note) => noteMatches(note.title, note.body))
    : rootNotes;

  const toggle = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  // A note opens the screen its plugin type calls for, not the text editor. A
  // resume's body is LaTeX and a finance note's document isn't in `body` at all,
  // so `/note/[id]` was the wrong destination for every plugin note here.
  const openNote = (note: Note) => {
    onClose();
    router.push(noteHref(note));
  };

  const goTo = (path: Href) => {
    onClose();
    router.push(path);
  };

  const addFolder = () => {
    const id = createFolder(null);
    onClose();
    // See floating-tab-bar's create menu: `created` is what arms the folder
    // screen's discard-if-untouched sweep.
    router.push({ pathname: '/folder/[id]', params: { id, created: '1' } });
  };

  // Renders a folder row and, when open, its subfolders (recursively) and notes
  // beneath it — each level stepped further in from the right edge.
  const renderFolder = (folder: Folder, depth: number): ReactNode => {
    const folderNotes = notesIn(folder.id);
    const subfolders = getSubfolders(folder.id);
    // A project is a folder in storage only: on screen it's an issue tracker,
    // and what's inside it are issue types rather than notes. Expanding one here
    // listed that machinery as if the user had written it, so it opens its own
    // screen instead — the same thing its card on the home screen does.
    const isProject = folder.kind === 'project';
    const nameMatch = searching && nameMatches(folder.name);
    // While searching (unless this folder's own name matched) narrow to the
    // matching notes and the subfolders whose branch contains a match.
    const childNotes =
      searching && !nameMatch
        ? folderNotes.filter((note) => noteMatches(note.title, note.body))
        : folderNotes;
    const childFolders =
      searching && !nameMatch ? subfolders.filter(folderMatchesSearch) : subfolders;
    // Searching forces every surviving branch open; otherwise honor the toggle.
    // A project never opens in place — there is nothing under it to show.
    const isOpen = isProject ? false : searching ? true : expanded[folder.id];

    return (
      <Animated.View key={folder.id} layout={LinearTransition.duration(220)}>
        <Pressable
          onPress={() => (isProject ? goTo(folderHref(folder)) : toggle(folder.id))}
          style={({ pressed }) => [
            styles.row,
            { marginRight: depth * INDENT },
            pressed && styles.pressed,
          ]}>
          <ThemedText type="small" themeColor="textSecondary">
            {folderNotes.length}
          </ThemedText>
          <View style={styles.spacer} />
          <Feather
            name={isProject ? 'columns' : isOpen ? 'chevron-down' : 'chevron-left'}
            size={18}
            color={colors.textSecondary}
          />
          <ThemedText style={styles.folderName} numberOfLines={1}>
            {folder.name}
          </ThemedText>
        </Pressable>
        {isOpen && (
          <>
            {childFolders.map((sub) => renderFolder(sub, depth + 1))}
            {childNotes.map((note, index) => (
              <Animated.View
                key={note.id}
                entering={FadeIn.duration(160).delay(index * 25)}
                exiting={FadeOut.duration(120)}>
                <Pressable
                  onPress={() => openNote(note)}
                  style={({ pressed }) => [
                    styles.row,
                    { marginRight: (depth + 1) * INDENT },
                    pressed && styles.pressed,
                  ]}>
                  <ThemedText type="small" style={styles.rowLabel} numberOfLines={1}>
                    {note.title}
                  </ThemedText>
                  <Feather
                    name={noteIcon(note)}
                    size={16}
                    color={colors.textSecondary}
                    style={styles.leadIcon}
                  />
                </Pressable>
              </Animated.View>
            ))}
          </>
        )}
      </Animated.View>
    );
  };

  return (
    <View style={styles.overlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(200)}
            style={styles.backdrop}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close menu"
          />

          <Animated.View
            entering={SlideInRight.duration(260)}
            exiting={SlideOutRight.duration(220)}
            style={styles.panel}>
            <SafeAreaView edges={['top', 'right']} style={styles.safeArea}>
              {/* Quick-access sidebar */}
              <View style={[styles.sidebar, { backgroundColor: colors.background }]}>
                <Pressable
                  onPress={onClose}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                  <ThemedText type="small" themeColor="textSecondary">
                    {listableCount}
                  </ThemedText>
                  <ThemedText style={[styles.rowLabel, styles.quickLabel]} numberOfLines={1}>
                    All Notes
                  </ThemedText>
                  <Feather name="layers" size={18} color={colors.text} style={styles.leadIcon} />
                </Pressable>
                {/* Each opens its own screen with the matching objects. */}
                {quickItems.map((item) => (
                  <Pressable
                    key={item.key}
                    onPress={() => goTo(item.path)}
                    accessibilityRole="button"
                    accessibilityLabel={item.label}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                    <ThemedText type="small" themeColor="textSecondary">
                      {item.count}
                    </ThemedText>
                    <ThemedText style={[styles.rowLabel, styles.quickLabel]} numberOfLines={1}>
                      {item.label}
                    </ThemedText>
                    <Feather name={item.icon} size={18} color={colors.text} style={styles.leadIcon} />
                  </Pressable>
                ))}
              </View>

              {/* Notes-hierarchy sidebar */}
              <View style={[styles.sidebar, styles.notesSidebar, { backgroundColor: colors.background }]}>
                {/* Pinned header: search the hierarchy, plus a new-folder button. */}
                <View style={styles.searchRow}>
                  <View style={styles.searchField}>
                    <SearchBar value={query} onChangeText={setQuery} placeholder="Search notes" />
                  </View>
                  <Pressable
                    onPress={addFolder}
                    accessibilityRole="button"
                    accessibilityLabel="New folder"
                    style={({ pressed }) => [
                      styles.newFolderButton,
                      { backgroundColor: colors.backgroundElement },
                      pressed && styles.pressed,
                    ]}>
                    <Feather name="folder-plus" size={24} color={colors.text} />
                  </Pressable>
                </View>
                <ScrollView
                  contentContainerStyle={[
                    styles.notesContent,
                    { paddingBottom: insets.bottom + Spacing.two },
                  ]}
                  {...noScrollbar}>
                  {visibleRootFolders.map((folder) => renderFolder(folder, 0))}

                  {visibleRootNotes.map((note) => (
                    <Animated.View key={note.id} layout={LinearTransition.duration(220)}>
                      <Pressable
                        onPress={() => openNote(note)}
                        style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                        <ThemedText style={styles.rowLabel} numberOfLines={1}>
                          {note.title}
                        </ThemedText>
                        <Feather
                          name={noteIcon(note)}
                          size={18}
                          color={colors.text}
                          style={styles.leadIcon}
                        />
                      </Pressable>
                    </Animated.View>
                  ))}
                </ScrollView>
                {/* Subtle fade so content dissolves into the bottom edge. */}
                <LinearGradient
                  pointerEvents="none"
                  colors={[`${colors.background}00`, colors.background]}
                  style={styles.bottomFade}
                />
              </View>

              {/* Floating settings button, docked to the notes sidebar's bottom-right. */}
              <Pressable
                onPress={() => goTo('/settings')}
                accessibilityRole="button"
                accessibilityLabel="Settings"
                style={({ pressed }) => [
                  styles.settingsButton,
                  { backgroundColor: colors.backgroundElement, bottom: insets.bottom + Spacing.three },
                  pressed && styles.pressed,
                ]}>
                <Feather name="settings" size={24} color={colors.text} />
              </Pressable>
            </SafeAreaView>
          </Animated.View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    // Narrower on web's wider viewport; the phone drawer stays at 73.75%.
    width: Platform.select({ web: '33%', default: '73.75%' }),
  },
  safeArea: {
    flex: 1,
    gap: Spacing.three,
  },
  /** A standalone docked card, flush to the screen's right edge. */
  sidebar: {
    overflow: 'hidden',
    padding: Spacing.two,
    // Extra inset so the right-aligned content isn't jammed against the edge.
    paddingRight: Spacing.three,
    borderTopLeftRadius: Spacing.four,
    borderBottomLeftRadius: Spacing.four,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: -8, height: 0 },
    elevation: 24,
  },
  /** The lower sidebar takes the remaining height and scrolls internally. */
  notesSidebar: {
    flex: 1,
    // Reaches the screen's bottom edge, so its bottom-left corner stays square.
    borderBottomLeftRadius: 0,
  },
  notesContent: {
    gap: Spacing.one,
  },
  bottomFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: Spacing.six,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.two,
  },
  /** Pinned header row: search field on the left, new-folder button on the right. */
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginBottom: Spacing.two,
  },
  searchField: {
    flex: 1,
  },
  /** Pinned create-folder button, sized to match the search field's height. */
  newFolderButton: {
    width: SEARCH_BAR_HEIGHT,
    height: SEARCH_BAR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.three,
  },
  /** Floating settings button, bottom-right of the notes sidebar. */
  settingsButton: {
    position: 'absolute',
    right: Spacing.three,
    width: SEARCH_BAR_HEIGHT,
    height: SEARCH_BAR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.three,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
  pressed: {
    opacity: 0.55,
  },
  leadIcon: {
    width: 20,
    textAlign: 'center',
  },
  rowLabel: {
    flex: 1,
    textAlign: 'right',
  },
  spacer: {
    flex: 1,
  },
  folderName: {
    flexShrink: 1,
    textAlign: 'right',
  },
  quickLabel: {
    fontSize: 18,
    lineHeight: 24,
  },
});
