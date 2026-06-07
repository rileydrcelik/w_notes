import { Stack, useLocalSearchParams } from 'expo-router';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';

import { NoteCard } from '@/components/notes/cards';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useNotes } from '@/store/notes-store';

export default function FolderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getFolder, getNotesInFolder, updateFolder } = useNotes();
  const theme = useTheme();
  const folder = getFolder(id);
  const notes = folder ? getNotesInFolder(folder.id) : [];
  const tabBarInset = useTabBarInset();

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
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: folder?.name ?? 'Folder' }} />
      <FlatList
        data={notes}
        keyExtractor={(note) => note.id}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={[styles.content, { paddingBottom: tabBarInset }]}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <ThemedText themeColor="textSecondary" style={styles.empty}>
            No notes in this folder yet.
          </ThemedText>
        }
        renderItem={({ item }) => <NoteCard note={item} />}
      />
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
  empty: {
    paddingVertical: Spacing.four,
  },
});
