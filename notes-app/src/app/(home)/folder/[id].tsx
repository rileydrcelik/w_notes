import { Stack, useLocalSearchParams } from 'expo-router';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FolderCard, NoteCard } from '@/components/notes/cards';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import type { Folder, Note } from '@/data/notes';
import { GRID_COLUMNS, gridEdgePadding, trailingSpacers } from '@/lib/grid';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useNotes } from '@/store/notes-store';

type GridItem =
  | { kind: 'folder'; folder: Folder }
  | { kind: 'note'; note: Note }
  | { kind: 'spacer' };

export default function FolderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getFolder, getNotesInFolder, getSubfolders, updateFolder } = useNotes();
  const theme = useTheme();
  const folder = getFolder(id);
  const subfolders = folder ? getSubfolders(folder.id) : [];
  const notes = folder ? getNotesInFolder(folder.id) : [];
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();

  // Subfolders sit above the notes, mirroring the home screen's ordering.
  const items: GridItem[] = [
    ...subfolders.map((sub) => ({ kind: 'folder' as const, folder: sub })),
    ...notes.map((note) => ({ kind: 'note' as const, note })),
  ];
  // Keep a partial last row at single-card width instead of stretching it.
  for (let i = 0; i < trailingSpacers(items.length); i++) items.push({ kind: 'spacer' });

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
          keyExtractor={(item, index) =>
            item.kind === 'note'
              ? item.note.id
              : item.kind === 'folder'
                ? item.folder.id
                : `spacer-${index}`
          }
          numColumns={GRID_COLUMNS}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[
            styles.content,
            gridEdgePadding,
            { paddingTop: insets.top + Spacing.two, paddingBottom: tabBarInset },
          ]}
          ListHeaderComponent={header}
          ListEmptyComponent={
            <ThemedText themeColor="textSecondary" style={styles.empty}>
              Nothing here yet. Tap + to add a note, or long-press it for a folder.
            </ThemedText>
          }
          renderItem={({ item }) => {
            if (item.kind === 'spacer') return <View style={styles.spacer} />;
            if (item.kind === 'folder') return <FolderCard folder={item.folder} />;
            return <NoteCard note={item.note} />;
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
