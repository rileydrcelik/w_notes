import Feather from '@expo/vector-icons/Feather';
import { Stack, useRouter } from 'expo-router';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import type { Note } from '@/data/notes';
import { GRID_COLUMNS, gridEdgePadding, trailingSpacers, useGridColumnWidth, useTileHeight } from '@/lib/grid';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useNotes } from '@/store/notes-store';

type GridItem = { kind: 'note'; note: Note } | { kind: 'spacer' };

export default function SharedScreen() {
  const { notes, getFolder } = useNotes();
  const router = useRouter();
  const theme = useTheme();
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();
  const tileHeight = useTileHeight();
  const columnWidth = useGridColumnWidth();

  const items: GridItem[] = notes
    .filter((note) => note.shared)
    .map((note) => ({ kind: 'note' as const, note }));
  for (let i = 0; i < trailingSpacers(items.length); i++) items.push({ kind: 'spacer' });

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <FlatList
          data={items}
          keyExtractor={(item, index) => (item.kind === 'note' ? item.note.id : `spacer-${index}`)}
          numColumns={GRID_COLUMNS}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[
            styles.content,
            gridEdgePadding,
            { paddingTop: insets.top + Spacing.two, paddingBottom: tabBarInset },
          ]}
          ListHeaderComponent={<ThemedText type="subtitle" style={styles.title}>Shared</ThemedText>}
          ListEmptyComponent={
            <ThemedText themeColor="textSecondary" style={styles.empty}>
              Nothing shared yet. Share a note from its options menu to add it here.
            </ThemedText>
          }
          renderItem={({ item }) => {
            // Wrap every cell in a View so the row distributes evenly on web
            // (a Pressable flex child sizes differently from a View one).
            if (item.kind === 'spacer') return <View style={[styles.cardCell, { width: columnWidth }]} />;
            const location = item.note.folderId ? getFolder(item.note.folderId)?.name : 'Home';
            return (
              <View style={[styles.cardCell, { width: columnWidth }]}>
                <Pressable
                  style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
                  onPress={() => router.push({ pathname: '/note/[id]', params: { id: item.note.id } })}>
                  <ThemedView type="backgroundElement" style={styles.card}>
                    <Feather name="share-2" size={18} color={theme.textSecondary} />
                    <View style={styles.cardFooter}>
                      <ThemedText type="smallBold" numberOfLines={2}>
                        {item.note.title || 'Untitled'}
                      </ThemedText>
                      <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                        {location ?? 'Home'}
                      </ThemedText>
                    </View>
                  </ThemedView>
                </Pressable>
              </View>
            );
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
  pressed: {
    opacity: 0.6,
  },
  empty: {
    paddingVertical: Spacing.four,
  },
});
