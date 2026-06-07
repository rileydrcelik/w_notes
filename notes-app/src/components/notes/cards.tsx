import { useRouter } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import type { Folder, Note } from '@/data/notes';
import { useNotes } from '@/store/notes-store';

export function FolderCard({ folder }: { folder: Folder }) {
  const router = useRouter();
  const { getNotesInFolder } = useNotes();
  const count = getNotesInFolder(folder.id).length;

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}
      onPress={() => router.push({ pathname: '/folder/[id]', params: { id: folder.id } })}>
      <ThemedView style={styles.folder}>
        <ThemedView type="backgroundElement" style={styles.folderTab} />
        <ThemedView type="backgroundElement" style={styles.folderBody}>
          <ThemedView type="backgroundElement" style={styles.cardFooter}>
            <ThemedText type="smallBold" numberOfLines={1}>
              {folder.name}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {count} {count === 1 ? 'note' : 'notes'}
            </ThemedText>
          </ThemedView>
        </ThemedView>
      </ThemedView>
    </Pressable>
  );
}

export function NoteCard({ note }: { note: Note }) {
  const router = useRouter();

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}
      onPress={() => router.push({ pathname: '/note/[id]', params: { id: note.id } })}>
      <ThemedView type="backgroundElement" style={styles.card}>
        <ThemedText type="smallBold" numberOfLines={1}>
          {note.title}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={4}>
          {note.body}
        </ThemedText>
      </ThemedView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cardWrapper: {
    flex: 1,
  },
  pressed: {
    opacity: 0.6,
  },
  card: {
    flex: 1,
    minHeight: 120,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  folder: {
    flex: 1,
    minHeight: 120,
    backgroundColor: 'transparent',
  },
  folderTab: {
    width: '45%',
    height: Spacing.four,
    borderTopLeftRadius: Spacing.two,
    borderTopRightRadius: Spacing.two,
  },
  folderBody: {
    flex: 1,
    borderRadius: Spacing.three,
    borderTopLeftRadius: 0,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  cardFooter: {
    gap: Spacing.half,
    marginTop: 'auto',
  },
});
