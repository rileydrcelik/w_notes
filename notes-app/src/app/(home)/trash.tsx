import Feather from '@expo/vector-icons/Feather';
import { Stack } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { BottomFade } from '@/components/edge-fade';
import { ScrollToTopButton } from '@/components/scroll-to-top';
import { SearchBar } from '@/components/search-bar';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { trailingSpacers, useGridColumns, useGridColumnWidth, useGridEdgePadding, useTileHeight } from '@/lib/grid';
import { rankMatches } from '@/lib/search';
import { useScrollToTop } from '@/hooks/use-scroll-to-top';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useNotes, type TrashEntry } from '@/store/notes-store';

type GridItem = { kind: 'entry'; entry: TrashEntry } | { kind: 'spacer' };

/** Coarse "x ago" label for a deletion timestamp. */
function timeAgo(ms: number) {
  const diff = Date.now() - ms;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  return `${Math.floor(diff / day)}d ago`;
}

export default function TrashScreen() {
  const { trash, restoreFromTrash } = useNotes();
  const theme = useTheme();
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();
  const tileHeight = useTileHeight();
  const columns = useGridColumns();
  const columnWidth = useGridColumnWidth();
  const edgePadding = useGridEdgePadding();
  const { scrollProps, scrolled, scrollToTop } = useScrollToTop<FlatList<GridItem>>();
  const [restoreTarget, setRestoreTarget] = useState<TrashEntry | null>(null);
  const [query, setQuery] = useState('');
  const q = query.trim();
  const searching = q.length > 0;

  // A trashed folder carries its whole subtree, and what you remember is
  // usually the note rather than the folder it happened to sit in — so a folder
  // entry matches on its descendants' names too. Names only: trash is "where did
  // the thing I deleted go", which is a question about titles.
  const entryFields = (entry: TrashEntry) =>
    entry.kind === 'note'
      ? { titles: [entry.note.title], body: entry.note.body }
      : {
          titles: [
            entry.folder.name,
            ...entry.folders.map((folder) => folder.name),
            ...entry.notes.map((note) => note.title),
          ],
        };

  const matched = searching ? rankMatches(trash, q, entryFields) : trash;
  const items: GridItem[] = matched.map((entry) => ({ kind: 'entry' as const, entry }));
  for (let i = 0; i < trailingSpacers(items.length, columns); i++) items.push({ kind: 'spacer' });

  const restoreName =
    restoreTarget?.kind === 'note' ? restoreTarget.note.title : restoreTarget?.folder.name;

  const confirmRestore = () => {
    if (restoreTarget) restoreFromTrash(restoreTarget.id);
    setRestoreTarget(null);
  };

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <FlatList
          {...scrollProps}
          data={items}
          keyExtractor={(it, index) => (it.kind === 'entry' ? it.entry.id : `spacer-${index}`)}
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
          ListHeaderComponent={
            <View>
              <ThemedText type="subtitle" style={styles.title}>
                Trash
              </ThemedText>
              {/* Only offered when there is something to filter. */}
              {trash.length > 0 && (
                <SearchBar value={query} onChangeText={setQuery} placeholder="Search trash" />
              )}
            </View>
          }
          ListEmptyComponent={
            <ThemedText themeColor="textSecondary" style={styles.empty}>
              {searching ? `Nothing in the trash matches “${q}”.` : 'Trash is empty.'}
            </ThemedText>
          }
          renderItem={({ item }) => {
            // Wrap every cell in a View so the row distributes evenly on web
            // (a Pressable flex child sizes differently from a View one).
            if (item.kind === 'spacer') return <View style={[styles.cardCell, { width: columnWidth }]} />;
            const { entry } = item;
            const isFolder = entry.kind === 'folder';
            const name = isFolder ? entry.folder.name || 'Untitled folder' : entry.note.title || 'Untitled';
            return (
              <View style={[styles.cardCell, { width: columnWidth }]}>
                <Pressable
                  style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
                  onPress={() => setRestoreTarget(entry)}>
                  <ThemedView type="backgroundElement" style={[styles.card, styles.faded]}>
                    <Feather name={isFolder ? 'folder' : 'file-text'} size={18} color={theme.textSecondary} />
                    <View style={styles.cardFooter}>
                      <ThemedText type="smallBold" numberOfLines={2}>
                        {name}
                      </ThemedText>
                      <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                        Deleted {timeAgo(entry.deletedAt)}
                      </ThemedText>
                    </View>
                  </ThemedView>
                </Pressable>
              </View>
            );
          }}
        />
        <BottomFade />
        <ScrollToTopButton visible={scrolled} onPress={scrollToTop} />
      </ThemedView>
      <ConfirmDialog
        open={restoreTarget !== null}
        title="Restore item?"
        message={
          restoreName
            ? `“${restoreName}” will be moved back out of the trash.`
            : 'This item will be moved back out of the trash.'
        }
        confirmLabel="Restore"
        destructive={false}
        onConfirm={confirmRestore}
        onCancel={() => setRestoreTarget(null)}
      />
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
  title: {
    paddingBottom: Spacing.three,
  },
  cardWrapper: {
    // The View cell sets the column width; the card just stretches to it and
    // takes its explicit height. No `flex: 1` (it would fight the height).
    minWidth: 0,
  },
  card: {
    flex: 1,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  cardFooter: {
    gap: Spacing.half,
  },
  faded: {
    opacity: 0.6,
  },
  pressed: {
    opacity: 0.6,
  },
  empty: {
    paddingVertical: Spacing.four,
  },
});
