import Feather from '@expo/vector-icons/Feather';
import { Stack, useRouter } from 'expo-router';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import type { Note } from '@/data/notes';
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

  const items: GridItem[] = notes
    .filter((note) => note.shared)
    .map((note) => ({ kind: 'note' as const, note }));
  if (items.length % 2 === 1) items.push({ kind: 'spacer' });

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <FlatList
          data={items}
          keyExtractor={(item, index) => (item.kind === 'note' ? item.note.id : `spacer-${index}`)}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[
            styles.content,
            { paddingTop: insets.top + Spacing.two, paddingBottom: tabBarInset },
          ]}
          ListHeaderComponent={<ThemedText type="subtitle" style={styles.title}>Shared</ThemedText>}
          ListEmptyComponent={
            <ThemedText themeColor="textSecondary" style={styles.empty}>
              Nothing shared yet. Share a note from its options menu to add it here.
            </ThemedText>
          }
          renderItem={({ item }) => {
            if (item.kind === 'spacer') return <View style={styles.spacer} />;
            const location = item.note.folderId ? getFolder(item.note.folderId)?.name : 'Home';
            return (
              <Pressable
                style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}
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
  pressed: {
    opacity: 0.6,
  },
  empty: {
    paddingVertical: Spacing.four,
  },
});
