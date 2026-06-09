import { Stack, useLocalSearchParams } from 'expo-router';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NoteCard } from '@/components/notes/cards';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import type { Note } from '@/data/notes';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useNotes } from '@/store/notes-store';

type GridItem = { kind: 'note'; note: Note } | { kind: 'spacer' };

export default function FolderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getFolder, getNotesInFolder, updateFolder } = useNotes();
  const theme = useTheme();
  const folder = getFolder(id);
  const notes = folder ? getNotesInFolder(folder.id) : [];
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();

  const items: GridItem[] = notes.map((note) => ({ kind: 'note' as const, note }));
  // Keep a lone/odd last note to a single column instead of spanning both.
  if (items.length % 2 === 1) items.push({ kind: 'spacer' });

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
          data={items}
          keyExtractor={(item, index) => (item.kind === 'note' ? item.note.id : `spacer-${index}`)}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[
            styles.content,
            { paddingTop: insets.top + Spacing.two, paddingBottom: tabBarInset },
          ]}
          ListHeaderComponent={header}
          ListEmptyComponent={
            <ThemedText themeColor="textSecondary" style={styles.empty}>
              No notes in this folder yet.
            </ThemedText>
          }
          renderItem={({ item }) =>
            item.kind === 'spacer' ? <View style={styles.spacer} /> : <NoteCard note={item.note} />
          }
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
  },
  spacer: {
    flex: 1,
  },
  empty: {
    paddingVertical: Spacing.four,
  },
});
