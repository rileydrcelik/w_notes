import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomFade } from '@/components/bottom-fade';
import { FolderCard, NoteCard } from '@/components/notes/cards';
import { SearchBar, SEARCH_BAR_HEIGHT } from '@/components/search-bar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useNotes } from '@/store/notes-store';
import { useSidebar } from '@/store/sidebar-store';

type GridItem =
  | { type: 'folder'; id: string }
  | { type: 'note'; id: string }
  | { type: 'spacer'; id: string };

// How far / fast a leftward drag must go before it opens the drawer.
const OPEN_DISTANCE = 60;
const OPEN_VELOCITY = 500;

export default function HomeScreen() {
  const { folders, notes, getRootNotes } = useNotes();
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { openSidebar } = useSidebar();
  const [query, setQuery] = useState('');

  // The search field floats; the grid scrolls beneath it. Reserve enough top
  // padding that the first row clears the bar, and fade content out behind it.
  const barTop = insets.top + Spacing.two;
  const contentTop = barTop + SEARCH_BAR_HEIGHT + Spacing.three;

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  // Default view: folders, then notes that live on the home screen. While
  // searching, match folders by name and notes by title/body across every
  // folder, so results aren't limited to the home screen.
  const matchedFolders = searching
    ? folders.filter((folder) => folder.name.toLowerCase().includes(q))
    : folders;
  const matchedNotes = searching
    ? notes.filter(
        (note) => note.title.toLowerCase().includes(q) || note.body.toLowerCase().includes(q),
      )
    : getRootNotes();

  const items: GridItem[] = [
    ...matchedFolders.map((folder) => ({ type: 'folder' as const, id: folder.id })),
    ...matchedNotes.map((note) => ({ type: 'note' as const, id: note.id })),
  ];
  // An odd count would leave the last card stretching across both columns;
  // a transparent spacer keeps it to a single column instead.
  if (items.length % 2 === 1) items.push({ type: 'spacer', id: 'spacer' });

  // A leftward swipe (right-to-left) reveals the right-hand drawer. Claim only
  // leftward drags so a rightward swipe still pages over to copa, and bail on
  // vertical movement so the grid keeps scrolling.
  const swipeOpen = Gesture.Pan()
    .activeOffsetX(-20)
    .failOffsetY([-15, 15])
    .onEnd((event) => {
      if (event.translationX < -OPEN_DISTANCE || event.velocityX < -OPEN_VELOCITY) {
        runOnJS(openSidebar)();
      }
    });

  return (
    <GestureDetector gesture={swipeOpen}>
      <ThemedView style={styles.container}>
        <FlatList
          data={items}
          keyExtractor={(item) => `${item.type}-${item.id}`}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[
            styles.content,
            { paddingTop: contentTop, paddingBottom: tabBarInset },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ListEmptyComponent={
            searching ? (
              <ThemedText themeColor="textSecondary" style={styles.empty}>
                No notes or folders match “{query.trim()}”.
              </ThemedText>
            ) : null
          }
          renderItem={({ item }) => {
            if (item.type === 'spacer') return <View style={styles.spacer} />;
            if (item.type === 'folder') {
              const folder = folders.find((f) => f.id === item.id)!;
              return <FolderCard folder={folder} />;
            }
            const note = notes.find((n) => n.id === item.id)!;
            return <NoteCard note={note} />;
          }}
        />
        {/* Fades scrolling cards out behind the floating search field. */}
        <LinearGradient
          pointerEvents="none"
          colors={[theme.background, `${theme.background}00`]}
          style={[styles.topFade, { height: contentTop }]}
        />
        <View style={[styles.searchFloat, { top: barTop }]} pointerEvents="box-none">
          <SearchBar value={query} onChangeText={setQuery} />
        </View>
        <BottomFade />
      </ThemedView>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchFloat: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.three,
  },
  topFade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  content: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.three,
  },
  row: {
    gap: Spacing.three,
  },
  spacer: {
    flex: 1,
  },
  empty: {
    textAlign: 'center',
    marginTop: Spacing.five,
  },
});
