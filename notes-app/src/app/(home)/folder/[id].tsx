import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef } from 'react';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomFade } from '@/components/edge-fade';
import { FolderCard, NoteCard } from '@/components/notes/cards';
import { ScrollToTopButton } from '@/components/scroll-to-top';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import type { Folder, Note } from '@/data/notes';
import { trailingSpacers, useGridColumns, useGridColumnWidth, useGridEdgePadding } from '@/lib/grid';
import { pinnedFirst } from '@/lib/pinned';
import { useScrollToTop } from '@/hooks/use-scroll-to-top';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useNotes } from '@/store/notes-store';

type GridItem =
  | { kind: 'folder'; folder: Folder; favorite?: boolean }
  | { kind: 'note'; note: Note; favorite?: boolean }
  | { kind: 'spacer' };

export default function FolderScreen() {
  // `created` is set only by the two places that make a folder and route you
  // straight into it; see the unmount sweep below for why that distinction is
  // load-bearing rather than cosmetic.
  const { id, created } = useLocalSearchParams<{ id: string; created?: string }>();
  const justCreated = created === '1';
  const { getFolder, getNotesInFolder, getSubfolders, updateFolder, deleteFolderIfEmpty } =
    useNotes();
  const theme = useTheme();
  const folder = getFolder(id);
  const subfolders = folder ? getSubfolders(folder.id) : [];
  const notes = folder ? getNotesInFolder(folder.id) : [];
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();
  const columns = useGridColumns();
  const columnWidth = useGridColumnWidth();
  const edgePadding = useGridEdgePadding();
  const { scrollProps, scrolled, scrollToTop } = useScrollToTop<FlatList<GridItem>>();

  // Subfolders sit above the notes, mirroring the home screen's ordering — and
  // as there, a star outranks that grouping and pins the item to the very top.
  const items: GridItem[] = pinnedFirst([
    ...subfolders.map((sub) => ({ kind: 'folder' as const, folder: sub, favorite: sub.favorite })),
    ...notes.map((note) => ({ kind: 'note' as const, note, favorite: note.favorite })),
  ]);
  // Keep a partial last row at single-card width instead of stretching it.
  for (let i = 0; i < trailingSpacers(items.length, columns); i++) items.push({ kind: 'spacer' });

  // Read by the unmount effect so it can keep empty deps — otherwise its cleanup
  // would fire on every folder change rather than on a real unmount.
  const sweep = useRef({ id, deleteFolderIfEmpty, justCreated });
  useEffect(() => {
    sweep.current = { id, deleteFolderIfEmpty, justCreated };
  });

  // On leaving the screen: discard a folder that is still unnamed and still
  // empty. Creating a folder drops you straight into it (see the create menu in
  // components/floating-tab-bar.tsx), so backing out without typing a name or
  // adding anything is how an untitled empty folder gets left behind.
  //
  // Only for a folder *this* screen was opened to create, which is what the
  // `created` param marks. The test used to be emptiness alone, and emptiness is
  // a state an old folder can wander back into: empty one out, open it, clear the
  // name meaning to retype it, then leave — and it was gone. Tombstoned, synced
  // to your other devices, and invisible in the trash, because
  // `worthKeepingInTrash` won't list a folder with no name and no children. A
  // folder you have had for months should not be deletable by a keystroke you
  // were in the middle of.
  //
  // The name isn't buffered here — the header writes each keystroke straight
  // through `updateFolder` — so there's nothing to flush, and no local copy that
  // could be staler than the row. `deleteFolderIfEmpty` re-tests both conditions
  // under the write lock, so this is a request, not an instruction: a folder
  // that was named or filled in the meantime stays.
  useEffect(() => {
    return () => {
      if (!sweep.current.justCreated) return;
      sweep.current.deleteFolderIfEmpty(sweep.current.id);
    };
  }, []);

  const header = (
    <View style={styles.header}>
      <TextInput
        value={folder?.name ?? ''}
        onChangeText={(name) => updateFolder(id, { name })}
        placeholder="Folder name"
        placeholderTextColor={theme.textSecondary}
        style={[styles.titleInput, { color: theme.text }]}
        editable={!!folder}
      />
    </View>
  );

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <FlatList
          {...scrollProps}
          data={items}
          keyExtractor={(item, index) =>
            item.kind === 'note'
              ? item.note.id
              : item.kind === 'folder'
                ? item.folder.id
                : `spacer-${index}`
          }
          numColumns={columns}
          // The column count changes with the window on web, and React Native
          // refuses to change numColumns in place — the list must remount.
          key={columns}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[
            styles.content,
            edgePadding,
            { paddingTop: insets.top + Spacing.two, paddingBottom: tabBarInset },
          ]}
          ListHeaderComponent={header}
          ListEmptyComponent={
            <ThemedText themeColor="textSecondary" style={styles.empty}>
              Nothing here yet. Tap + to add a note, or long-press it for a folder.
            </ThemedText>
          }
          renderItem={({ item }) => {
            // Wrap every cell in a View so the row distributes evenly on web
            // (a Pressable flex child sizes differently from a View one).
            if (item.kind === 'spacer') return <View style={[styles.cardCell, { width: columnWidth }]} />;
            if (item.kind === 'folder') {
              return (
                <View style={[styles.cardCell, { width: columnWidth }]}>
                  <FolderCard folder={item.folder} />
                </View>
              );
            }
            return (
              <View style={[styles.cardCell, { width: columnWidth }]}>
                <NoteCard note={item.note} />
              </View>
            );
          }}
        />
        <BottomFade />
        <ScrollToTopButton visible={scrolled} onPress={scrollToTop} />
      </ThemedView>
    </SwipeBackView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: Spacing.three,
    gap: Spacing.three,
  },
  header: {
    marginBottom: Spacing.one,
  },
  titleInput: {
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '700',
  },
  row: {
    gap: Spacing.three,
    alignItems: 'flex-start',
  },
  cardCell: {
    // Fixed one-column width (inline) + flexGrow:0 so a card can't stretch past
    // its column into a partial row's empty space (what made them too wide).
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
  },
  empty: {
    paddingVertical: Spacing.four,
  },
});
