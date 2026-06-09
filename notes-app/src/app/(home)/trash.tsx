import Feather from '@expo/vector-icons/Feather';
import { Stack } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useNotes, type TrashEntry } from '@/store/notes-store';

type GridItem = { kind: 'entry'; entry: TrashEntry } | { kind: 'spacer' };

/** Coarse "x ago" label for a deletion timestamp. */
function timeAgo(ms: number) {
  const diff = Date.now() - ms;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  return `${Math.floor(diff / day)}d ago`;
}

export default function TrashScreen() {
  const { trash, restoreFromTrash } = useNotes();
  const theme = useTheme();
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();
  const [restoreTarget, setRestoreTarget] = useState<TrashEntry | null>(null);

  const items: GridItem[] = trash.map((entry) => ({ kind: 'entry' as const, entry }));
  if (items.length % 2 === 1) items.push({ kind: 'spacer' });

  const restoreName =
    restoreTarget?.kind === 'note' ? restoreTarget.note.title : restoreTarget?.folder.name;

  const confirmRestore = () => {
    if (restoreTarget) restoreFromTrash(restoreTarget.id);
    setRestoreTarget(null);
  };

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <FlatList
          data={items}
          keyExtractor={(it, index) => (it.kind === 'entry' ? it.entry.id : `spacer-${index}`)}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[
            styles.content,
            { paddingTop: insets.top + Spacing.two, paddingBottom: tabBarInset },
          ]}
          ListHeaderComponent={<ThemedText type="subtitle" style={styles.title}>Trash</ThemedText>}
          ListEmptyComponent={
            <ThemedText themeColor="textSecondary" style={styles.empty}>
              Trash is empty.
            </ThemedText>
          }
          renderItem={({ item }) => {
            if (item.kind === 'spacer') return <View style={styles.spacer} />;
            const { entry } = item;
            const isFolder = entry.kind === 'folder';
            const name = isFolder ? entry.folder.name || 'Untitled folder' : entry.note.title || 'Untitled';
            return (
              <Pressable
                style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}
                onPress={() => setRestoreTarget(entry)}>
                <ThemedView type="backgroundElement" style={[styles.card, styles.faded]}>
                  <Feather name={isFolder ? 'folder' : 'file-text'} size={18} color={theme.textSecondary} />
                  <View style={styles.cardFooter}>
                    <ThemedText type="smallBold" numberOfLines={2}>
                      {name}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                      Deleted {timeAgo(entry.deletedAt)}
                    </ThemedText>
                  </View>
                </ThemedView>
              </Pressable>
            );
          }}
        />
      </ThemedView>
      <ConfirmDialog
        open={restoreTarget !== null}
        title="Restore item?"
        message={
          restoreName
            ? `“${restoreName}” will be moved back out of the trash.`
            : 'This item will be moved back out of the trash.'
        }
        confirmLabel="Restore"
        destructive={false}
        onConfirm={confirmRestore}
        onCancel={() => setRestoreTarget(null)}
      />
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
  cardWrapper: {
    flex: 1,
  },
  card: {
    flex: 1,
    minHeight: 120,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  cardFooter: {
    gap: Spacing.half,
  },
  faded: {
    opacity: 0.6,
  },
  pressed: {
    opacity: 0.6,
  },
  empty: {
    paddingVertical: Spacing.four,
  },
});
