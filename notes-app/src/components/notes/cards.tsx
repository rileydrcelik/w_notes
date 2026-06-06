import { Link } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import type { Folder, Note } from '@/data/notes';
import { getNotesInFolder } from '@/data/notes';
import { useTheme } from '@/hooks/use-theme';

export function FolderCard({ folder }: { folder: Folder }) {
  const theme = useTheme();
  const count = getNotesInFolder(folder.id).length;

  return (
    <Link href={{ pathname: '/folder/[id]', params: { id: folder.id } }} asChild>
      <Pressable style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}>
        <ThemedView type="backgroundElement" style={styles.card}>
          <SymbolView
            tintColor={theme.text}
            name={{ ios: 'folder.fill', android: 'folder', web: 'folder' }}
            size={28}
          />
          <ThemedView type="backgroundElement" style={styles.cardFooter}>
            <ThemedText type="smallBold" numberOfLines={1}>
              {folder.name}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {count} {count === 1 ? 'note' : 'notes'}
            </ThemedText>
          </ThemedView>
        </ThemedView>
      </Pressable>
    </Link>
  );
}

export function NoteCard({ note }: { note: Note }) {
  return (
    <Link href={{ pathname: '/note/[id]', params: { id: note.id } }} asChild>
      <Pressable style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}>
        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold" numberOfLines={1}>
            {note.title}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={4}>
            {note.body}
          </ThemedText>
        </ThemedView>
      </Pressable>
    </Link>
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
  cardFooter: {
    gap: Spacing.half,
    marginTop: 'auto',
  },
});
