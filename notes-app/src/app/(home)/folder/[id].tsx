import { Stack, useLocalSearchParams } from 'expo-router';
import { FlatList, StyleSheet } from 'react-native';

import { NoteCard } from '@/components/notes/cards';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { getFolder, getNotesInFolder } from '@/data/notes';

export default function FolderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const folder = getFolder(id);
  const notes = folder ? getNotesInFolder(folder.id) : [];

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: folder?.name ?? 'Folder' }} />
      {notes.length === 0 ? (
        <ThemedView style={styles.empty}>
          <ThemedText themeColor="textSecondary">No notes in this folder yet.</ThemedText>
        </ThemedView>
      ) : (
        <FlatList
          data={notes}
          keyExtractor={(note) => note.id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.content}
          renderItem={({ item }) => <NoteCard note={item} />}
        />
      )}
    </ThemedView>
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
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
});
