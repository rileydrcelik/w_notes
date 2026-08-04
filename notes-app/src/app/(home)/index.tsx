import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Platform, RefreshControl, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomFade } from '@/components/edge-fade';
import { FolderCard, NoteCard } from '@/components/notes/cards';
import { ScrollToTopButton } from '@/components/scroll-to-top';
import { SearchBar, SEARCH_BAR_HEIGHT } from '@/components/search-bar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { trailingSpacers, useGridColumns, useGridColumnWidth, useGridEdgePadding } from '@/lib/grid';
import { pinnedFirst } from '@/lib/pinned';
import { rankMatches } from '@/lib/search';
import { useScreenFadeStyle } from '@/hooks/use-screen-fade';
import { useScrollToTop } from '@/hooks/use-scroll-to-top';
import { useSyncRefresh } from '@/hooks/use-sync-refresh';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useNotes } from '@/store/notes-store';
import { useSidebar } from '@/store/sidebar-store';

type GridItem =
  | { type: 'folder'; id: string; favorite?: boolean }
  | { type: 'note'; id: string; favorite?: boolean }
  | { type: 'spacer'; id: string };

// How far / fast a leftward drag must go before it opens the drawer.
const OPEN_DISTANCE = 60;
const OPEN_VELOCITY = 500;

/**
 * Web: drop the query string a deep link left behind on the home address.
 *
 * A screen opened by URL — a reload on `/note/x`, a shared link — gets home
 * synthesized beneath it by `unstable_settings.anchor` (see `_layout.tsx`).
 * Popping to it lands on `/?id=note-…`: the right screen wearing the previous
 * one's address. Nothing here reads `id`, so that URL still works; it is simply
 * the wrong one to leave for someone to copy or bookmark.
 *
 * Two things about the shape of this, both learned the hard way by an earlier
 * attempt (`1f9ce8b`, reverted in `ae3c244`) that did the same job in a bare
 * render-time effect and fixed nothing:
 *
 * **On focus, not on render.** `HomeScreen` stays mounted underneath every
 * screen this stack pushes, and it re-renders whenever the notes store changes
 * — which is every keystroke of a folder rename, from a screen that is not this
 * one. An unscoped version therefore reached out and stripped the query of
 * whatever route *was* showing, and `/folder/x?created=1` is a real one: that
 * flag is what lets an abandoned empty folder delete itself. Focus is the only
 * moment at which "the current URL" is reliably ours to edit.
 *
 * **A tick later, not now.** The router writes the address after this: its
 * `history.replace` is queued as a microtask from the navigation container's
 * own effect, and React flushes a child's effects before its parent's. Reading
 * `location.search` synchronously here reads the URL from *before* the write,
 * finds it clean, and returns — then the id lands, with no further render to
 * catch it. A macrotask runs after every microtask queued this turn, so this
 * sees the address the user will actually be left looking at.
 *
 * `replaceState` rather than a router call, because home is already the screen
 * we are on and navigating again to tidy an address would remount the grid and
 * lose its scroll position. Guarded by `Platform.OS` rather than split into a
 * `.web` file — a native/web pair drifting out of sync has broken app launch
 * here before.
 */
function useCleanHomeUrl() {
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'web' || typeof window === 'undefined') return;
      const timer = setTimeout(() => {
        if (!window.location.search) return;
        window.history.replaceState(window.history.state, '', window.location.pathname);
      }, 0);
      return () => clearTimeout(timer);
    }, []),
  );
}

export default function HomeScreen() {
  useCleanHomeUrl();
  const { folders, notes, getRootNotes, getRootFolders } = useNotes();
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { openSidebar } = useSidebar();
  const { refreshing, onRefresh } = useSyncRefresh();
  const columns = useGridColumns();
  const columnWidth = useGridColumnWidth();
  const edgePadding = useGridEdgePadding();
  const { scrollProps, scrolled, scrollToTop } = useScrollToTop<FlatList<GridItem>>();
  const [query, setQuery] = useState('');
  // Web has no native stack transition; fade/slide the screen in when it gains
  // focus (incl. when revealed by backing out of a note).
  const fadeStyle = useScreenFadeStyle();

  // The search field floats; the grid scrolls beneath it. Reserve enough top
  // padding that the first row clears the bar, and fade content out behind it.
  const barTop = insets.top + Spacing.two;
  const contentTop = barTop + SEARCH_BAR_HEIGHT + Spacing.three;

  const q = query.trim();
  const searching = q.length > 0;

  // Everything a search can reach: every folder by name, every note by title and
  // body, across the whole tree rather than just the home screen. Folders and
  // notes are ranked as one list — split into two ranked lists, the weakest
  // folder match would still outrank the note the query names exactly.
  const searchable = [
    ...folders.map((folder) => ({
      item: { type: 'folder' as const, id: folder.id, favorite: folder.favorite },
      fields: { titles: [folder.name] },
    })),
    ...notes.map((note) => ({
      item: { type: 'note' as const, id: note.id, favorite: note.favorite },
      fields: { titles: [note.title], body: note.body },
    })),
  ];

  // Default view: home-screen folders, then notes that live on the home screen.
  // Starred items pin to the very top as one band, folders and notes together —
  // a pin outranks the folders-above-notes grouping rather than reordering
  // inside it. Below the band that grouping is untouched, and because the sort
  // is stable both halves keep the feed's recency order.
  //
  // Results are ordered by relevance instead, and deliberately *not* through
  // `pinnedFirst`: floating every starred item above every match regardless of
  // how well it matches is the opposite of what a query asks for. Stars still
  // break ties inside `rankMatches`, so a starred item wins among equally good
  // answers — it just can't jump ahead of a better one.
  const items: GridItem[] = searching
    ? rankMatches(
        searchable,
        q,
        (entry) => entry.fields,
        (entry) => entry.item.favorite,
      ).map((entry) => entry.item)
    : pinnedFirst([
        ...getRootFolders().map((folder) => ({
          type: 'folder' as const,
          id: folder.id,
          favorite: folder.favorite,
        })),
        ...getRootNotes().map((note) => ({
          type: 'note' as const,
          id: note.id,
          favorite: note.favorite,
        })),
      ]);
  // A partial last row would stretch its cards to fill the width; transparent
  // spacers keep them at single-column width instead.
  for (let i = 0; i < trailingSpacers(items.length, columns); i++) {
    items.push({ type: 'spacer', id: `spacer-${i}` });
  }

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

  const content = (
    <Animated.View style={[styles.container, fadeStyle]}>
      <ThemedView style={styles.container}>
        <FlatList
          {...scrollProps}
          data={items}
          keyExtractor={(item) => `${item.type}-${item.id}`}
          numColumns={columns}
          // The column count changes with the window on web, and React Native
          // refuses to change numColumns in place — the list must remount.
          key={columns}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[
            styles.content,
            edgePadding,
            { paddingTop: contentTop, paddingBottom: tabBarInset },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.textSecondary}
              colors={[theme.textSecondary]}
            />
          }
          ListEmptyComponent={
            searching ? (
              <ThemedText themeColor="textSecondary" style={styles.empty}>
                No notes or folders match “{query.trim()}”.
              </ThemedText>
            ) : null
          }
          renderItem={({ item }) => {
            // Every cell is a plain View so the row's flex distribution is
            // uniform: react-native-web sizes a Pressable flex child differently
            // from a View one, so a partial row mixing card Pressables with View
            // spacers came out uneven (cards too wide). Wrapping the card in a
            // View makes every cell the same element and every column equal.
            if (item.type === 'spacer') return <View style={[styles.cardCell, { width: columnWidth }]} />;
            if (item.type === 'folder') {
              const folder = folders.find((f) => f.id === item.id)!;
              return (
                <View style={[styles.cardCell, { width: columnWidth }]}>
                  <FolderCard folder={folder} />
                </View>
              );
            }
            const note = notes.find((n) => n.id === item.id)!;
            return (
              <View style={[styles.cardCell, { width: columnWidth }]}>
                {/* While searching, the card shows the line it matched on
                    instead of its opening paragraph. */}
                <NoteCard note={note} query={searching ? q : undefined} />
              </View>
            );
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
        <ScrollToTopButton visible={scrolled} onPress={scrollToTop} />
      </ThemedView>
    </Animated.View>
  );

  // Web has no swipe gestures: a mouse drag is text selection, and a live Pan
  // lets gesture-handler track and steal it. Pointer users open the drawer via
  // the menu button / backdrop.
  if (Platform.OS === 'web') return content;

  return <GestureDetector gesture={swipeOpen}>{content}</GestureDetector>;
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
    // Don't stretch cards to the row's height; their fixed aspect ratio drives
    // height from the column width, so stretching would distort widths in a
    // partial last row and break alignment with the columns above.
    alignItems: 'flex-start',
  },
  cardCell: {
    // Fixed one-column width (applied inline) with flexGrow:0 so a card can
    // never stretch past its column into a partial row's empty spacer space —
    // the cause of partial-row cards rendering too wide. flexShrink keeps a
    // rounding/scrollbar overshoot from overflowing; overflow clips content.
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
  },
  empty: {
    textAlign: 'center',
    marginTop: Spacing.five,
  },
});
