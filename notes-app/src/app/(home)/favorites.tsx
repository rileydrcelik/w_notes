import { Stack } from 'expo-router';
import { useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomFade } from '@/components/edge-fade';
import { FolderCard, NoteCard } from '@/components/notes/cards';
import { ScrollToTopButton } from '@/components/scroll-to-top';
import { SearchBar } from '@/components/search-bar';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { trailingSpacers, useGridColumns, useGridColumnWidth, useGridEdgePadding } from '@/lib/grid';
import { rankMatches } from '@/lib/search';
import { useScrollToTop } from '@/hooks/use-scroll-to-top';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useNotes } from '@/store/notes-store';

type Item = { type: 'folder' | 'note' | 'spacer'; id: string };

export default function FavoritesScreen() {
  const { folders, notes } = useNotes();
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();
  const columns = useGridColumns();
  const columnWidth = useGridColumnWidth();
  const edgePadding = useGridEdgePadding();
  const { scrollProps, scrolled, scrollToTop } = useScrollToTop<FlatList<Item>>();
  const [query, setQuery] = useState('');
  const q = query.trim();
  const searching = q.length > 0;

  const favoriteFolders = folders.filter((folder) => folder.favorite);
  const favoriteNotes = notes.filter((note) => note.favorite);
  // Everything starred is equally starred, so there is no tiebreak to pass —
  // relevance is the only ordering a query here can want.
  const searchable = [
    ...favoriteFolders.map((folder) => ({
      item: { type: 'folder' as const, id: folder.id },
      fields: { titles: [folder.name] },
    })),
    ...favoriteNotes.map((note) => ({
      item: { type: 'note' as const, id: note.id },
      fields: { titles: [note.title], body: note.body },
    })),
  ];
  const items: Item[] = searching
    ? rankMatches(searchable, q, (entry) => entry.fields).map((entry) => entry.item)
    : searchable.map((entry) => entry.item);
  // Keep a partial last row at single-card width instead of stretching it.
  for (let i = 0; i < trailingSpacers(items.length, columns); i++) {
    items.push({ type: 'spacer', id: `spacer-${i}` });
  }

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <FlatList
          {...scrollProps}
          data={items}
          keyExtractor={(item) => `${item.type}-${item.id}`}
          numColumns={columns}
          // The column count changes with the window on web, and React Native
          // refuses to change numColumns in place — the list must remount.
          key={columns}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[styles.content, edgePadding, { paddingBottom: tabBarInset }]}
          ListHeaderComponent={
            <View style={{ paddingTop: insets.top + Spacing.two }}>
              <ThemedText type="subtitle" style={styles.title}>
                Favorites
              </ThemedText>
              {/* Only offered when there is something to filter, so an empty
                  screen stays a sentence rather than a sentence under a search
                  field that can only ever return nothing. */}
              {searchable.length > 0 && (
                <SearchBar
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search favorites"
                />
              )}
            </View>
          }
          ListEmptyComponent={
            <ThemedText themeColor="textSecondary" style={styles.empty}>
              {searching
                ? `No favorites match “${q}”.`
                : 'Nothing favorited yet. Double-tap a note, folder, or copy block to favorite it.'}
            </ThemedText>
          }
          renderItem={({ item }) => {
            // Wrap every cell in a View so the row distributes evenly on web
            // (a Pressable flex child sizes differently from a View one).
            if (item.type === 'spacer') return <View style={[styles.cardCell, { width: columnWidth }]} />;
            if (item.type === 'folder') {
              return (
                <View style={[styles.cardCell, { width: columnWidth }]}>
                  <FolderCard folder={favoriteFolders.find((f) => f.id === item.id)!} />
                </View>
              );
            }
            return (
              <View style={[styles.cardCell, { width: columnWidth }]}>
                {/* While searching, the card shows the line it matched on
                    instead of its opening paragraph. */}
                <NoteCard
                  note={favoriteNotes.find((n) => n.id === item.id)!}
                  query={searching ? q : undefined}
                />
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
  empty: {
    paddingVertical: Spacing.four,
  },
});
