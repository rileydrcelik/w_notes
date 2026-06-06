import { useRouter } from 'expo-router';
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
  const router = useRouter();
  const count = getNotesInFolder(folder.id).length;

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}
      onPress={() => router.push({ pathname: '/folder/[id]', params: { id: folder.id } })}>
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
  cardFooter: {
    gap: Spacing.half,
    marginTop: 'auto',
  },
});
