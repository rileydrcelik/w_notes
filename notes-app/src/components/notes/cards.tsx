import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { useItemOptions } from '@/components/item-options-modal';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import type { Folder, Note } from '@/data/notes';
import { useTheme } from '@/hooks/use-theme';
import { useNotes } from '@/store/notes-store';

export function FolderCard({ folder }: { folder: Folder }) {
  const router = useRouter();
  const { getNotesInFolder } = useNotes();
  const { openOptions } = useItemOptions();
  const theme = useTheme();
  const count = getNotesInFolder(folder.id).length;

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}
      onPress={() => router.push({ pathname: '/folder/[id]', params: { id: folder.id } })}
      onLongPress={() => openOptions({ type: 'folder', id: folder.id })}>
      <ThemedView style={styles.folder}>
        {/* Tab: flat top that slopes down to the body at 45° on the right. */}
        <View style={styles.folderTabRow}>
          <View style={[styles.folderTabFlat, { backgroundColor: theme.backgroundElement }]} />
          <View style={[styles.folderTabSlant, { borderBottomColor: theme.backgroundElement }]} />
        </View>
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
  const { openOptions } = useItemOptions();

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}
      onPress={() => router.push({ pathname: '/note/[id]', params: { id: note.id } })}
      onLongPress={() => openOptions({ type: 'note', id: note.id })}>
      <ThemedView type="backgroundElementAlt" style={styles.card}>
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
  folderTabRow: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    width: '55%',
    height: Spacing.three,
  },
  folderTabFlat: {
    flex: 1,
    height: Spacing.three,
    borderTopLeftRadius: Spacing.two,
  },
  // Right triangle: hypotenuse drops top-left → bottom-right at 45° (equal sides).
  folderTabSlant: {
    width: 0,
    height: 0,
    borderBottomWidth: Spacing.three,
    borderRightWidth: Spacing.three,
    borderRightColor: 'transparent',
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
