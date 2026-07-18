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
import { GRID_COLUMNS, gridEdgePadding, trailingSpacers, useGridColumnWidth, useTileHeight } from '@/lib/grid';
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
  const tileHeight = useTileHeight();
  const columnWidth = useGridColumnWidth();
  const [restoreTarget, setRestoreTarget] = useState<TrashEntry | null>(null);

  const items: GridItem[] = trash.map((entry) => ({ kind: 'entry' as const, entry }));
  for (let i = 0; i < trailingSpacers(items.length); i++) items.push({ kind: 'spacer' });

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
          numColumns={GRID_COLUMNS}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[
            styles.content,
            gridEdgePadding,
            { paddingTop: insets.top + Spacing.two, paddingBottom: tabBarInset },
          ]}
          ListHeaderComponent={<ThemedText type="subtitle" style={styles.title}>Trash</ThemedText>}
          ListEmptyComponent={
            <ThemedText themeColor="textSecondary" style={styles.empty}>
              Trash is empty.
            </ThemedText>
          }
          renderItem={({ item }) => {
            // Wrap every cell in a View so the row distributes evenly on web
            // (a Pressable flex child sizes differently from a View one).
            if (item.kind === 'spacer') return <View style={[styles.cardCell, { width: columnWidth }]} />;
            const { entry } = item;
            const isFolder = entry.kind === 'folder';
            const name = isFolder ? entry.folder.name || 'Untitled folder' : entry.note.title || 'Untitled';
            return (
              <View style={[styles.cardCell, { width: columnWidth }]}>
                <Pressable
                  style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
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
              </View>
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
    alignItems: 'flex-start',
  },
  cardCell: {
    // Fixed one-column width (inline) + flexGrow:0 so a card can't stretch past
    // its column into a partial row's empty space (what made them too wide).
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
  },
  title: {
    paddingBottom: Spacing.three,
  },
  cardWrapper: {
    // The View cell sets the column width; the card just stretches to it and
    // takes its explicit height. No `flex: 1` (it would fight the height).
    minWidth: 0,
  },
  card: {
    flex: 1,
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
