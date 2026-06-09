import { Stack } from 'expo-router';
import { FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FolderCard, NoteCard } from '@/components/notes/cards';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useNotes } from '@/store/notes-store';

type Item = { type: 'folder' | 'note' | 'spacer'; id: string };

export default function FavoritesScreen() {
  const { folders, notes } = useNotes();
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();

  const favoriteFolders = folders.filter((folder) => folder.favorite);
  const favoriteNotes = notes.filter((note) => note.favorite);
  const items: Item[] = [
    ...favoriteFolders.map((folder) => ({ type: 'folder' as const, id: folder.id })),
    ...favoriteNotes.map((note) => ({ type: 'note' as const, id: note.id })),
  ];
  // Keep a lone/odd last card to a single column instead of spanning both.
  if (items.length % 2 === 1) items.push({ type: 'spacer', id: 'spacer' });

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <FlatList
          data={items}
          keyExtractor={(item) => `${item.type}-${item.id}`}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[styles.content, { paddingBottom: tabBarInset }]}
          ListHeaderComponent={
            <ThemedText type="subtitle" style={[styles.title, { paddingTop: insets.top + Spacing.two }]}>
              Favorites
            </ThemedText>
          }
          ListEmptyComponent={
            <ThemedText themeColor="textSecondary" style={styles.empty}>
              Nothing favorited yet. Double-tap a note, folder, or copy block to favorite it.
            </ThemedText>
          }
          renderItem={({ item }) => {
            if (item.type === 'spacer') return <View style={styles.spacer} />;
            if (item.type === 'folder') {
              return <FolderCard folder={favoriteFolders.find((f) => f.id === item.id)!} />;
            }
            return <NoteCard note={favoriteNotes.find((n) => n.id === item.id)!} />;
          }}
        />
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
  },
  spacer: {
    flex: 1,
  },
  title: {
    paddingBottom: Spacing.three,
  },
  empty: {
    paddingVertical: Spacing.four,
  },
});
