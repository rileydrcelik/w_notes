import Feather from '@expo/vector-icons/Feather';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomFade } from '@/components/edge-fade';
import { ScrollToTopButton } from '@/components/scroll-to-top';
import { SearchBar } from '@/components/search-bar';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import type { Note } from '@/data/notes';
import { trailingSpacers, useGridColumns, useGridColumnWidth, useGridEdgePadding, useTileHeight } from '@/lib/grid';
import { pinnedFirst } from '@/lib/pinned';
import { rankMatches } from '@/lib/search';
import { useScrollToTop } from '@/hooks/use-scroll-to-top';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useNotes } from '@/store/notes-store';

type GridItem = { kind: 'note'; note: Note } | { kind: 'spacer' };

export default function SharedScreen() {
  const { notes, getFolder } = useNotes();
  const router = useRouter();
  const theme = useTheme();
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();
  const tileHeight = useTileHeight();
  const columns = useGridColumns();
  const columnWidth = useGridColumnWidth();
  const edgePadding = useGridEdgePadding();
  const { scrollProps, scrolled, scrollToTop } = useScrollToTop<FlatList<GridItem>>();
  const [query, setQuery] = useState('');
  const q = query.trim();
  const searching = q.length > 0;

  const shared = notes.filter((note) => note.shared);
  // Browsing pins starred notes; searching ranks by relevance and lets a star
  // break ties instead — see `rankMatches`.
  const items: GridItem[] = (
    searching
      ? rankMatches(
          shared,
          q,
          (note) => ({ titles: [note.title], body: note.body }),
          (note) => note.favorite,
        )
      : pinnedFirst(shared)
  ).map((note) => ({ kind: 'note' as const, note }));
  for (let i = 0; i < trailingSpacers(items.length, columns); i++) items.push({ kind: 'spacer' });

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <FlatList
          {...scrollProps}
          data={items}
          keyExtractor={(item, index) => (item.kind === 'note' ? item.note.id : `spacer-${index}`)}
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
                Shared
              </ThemedText>
              {/* Only offered when there is something to filter. */}
              {shared.length > 0 && (
                <SearchBar value={query} onChangeText={setQuery} placeholder="Search shared notes" />
              )}
            </View>
          }
          ListEmptyComponent={
            <ThemedText themeColor="textSecondary" style={styles.empty}>
              {searching
                ? `No shared notes match “${q}”.`
                : 'Nothing shared yet. Share a note from its options menu to add it here.'}
            </ThemedText>
          }
          renderItem={({ item }) => {
            // Wrap every cell in a View so the row distributes evenly on web
            // (a Pressable flex child sizes differently from a View one).
            if (item.kind === 'spacer') return <View style={[styles.cardCell, { width: columnWidth }]} />;
            const location = item.note.folderId ? getFolder(item.note.folderId)?.name : 'Home';
            return (
              <View style={[styles.cardCell, { width: columnWidth }]}>
                <Pressable
                  style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
                  onPress={() => router.push({ pathname: '/note/[id]', params: { id: item.note.id } })}>
                  <ThemedView type="backgroundElement" style={styles.card}>
                    <Feather name="share-2" size={18} color={theme.textSecondary} />
                    <View style={styles.cardFooter}>
                      <ThemedText type="smallBold" numberOfLines={2}>
                        {item.note.title || 'Untitled'}
                      </ThemedText>
                      <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                        {location ?? 'Home'}
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
  pressed: {
    opacity: 0.6,
  },
  empty: {
    paddingVertical: Spacing.four,
  },
});
