import { FlatList, StyleSheet } from 'react-native';

import { FolderCard, NoteCard } from '@/components/notes/cards';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useNotes } from '@/store/notes-store';

type GridItem =
  | { type: 'folder'; id: string }
  | { type: 'note'; id: string };

export default function HomeScreen() {
  const { folders, getRootNotes } = useNotes();
  const rootNotes = getRootNotes();
  const tabBarInset = useTabBarInset();

  const items: GridItem[] = [
    ...folders.map((folder) => ({ type: 'folder' as const, id: folder.id })),
    ...rootNotes.map((note) => ({ type: 'note' as const, id: note.id })),
  ];

  return (
    <ThemedView style={styles.container}>
      <FlatList
        data={items}
        keyExtractor={(item) => `${item.type}-${item.id}`}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={[styles.content, { paddingBottom: tabBarInset }]}
        renderItem={({ item }) => {
          if (item.type === 'folder') {
            const folder = folders.find((f) => f.id === item.id)!;
            return <FolderCard folder={folder} />;
          }
          const note = rootNotes.find((n) => n.id === item.id)!;
          return <NoteCard note={note} />;
        }}
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
  row: {
    gap: Spacing.three,
  },
});
