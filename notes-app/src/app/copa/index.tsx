import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useMemo, useRef, useState } from 'react';
import {
  FlatList,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  type TextLayoutEventData,
  View,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomFade } from '@/components/bottom-fade';
import { FavoriteStar } from '@/components/favorite-star';
import { useCopaOptions } from '@/components/copa-options-modal';
import { SearchBar, SEARCH_BAR_HEIGHT } from '@/components/search-bar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { type CopaItem } from '@/data/copa';
import { useDoubleTap } from '@/hooks/use-double-tap';
import { useScreenFadeStyle } from '@/hooks/use-screen-fade';
import { useSyncRefresh } from '@/hooks/use-sync-refresh';
import { htmlToPlainText } from '@/lib/html-text';
import { gridEdgePadding } from '@/lib/grid';
import { downloadCopaFile, fileIconFor, formatBytes, isImage, isVideo } from '@/lib/copa-files';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useCopa } from '@/store/copa-store';

// Geometry of a card used to keep its collapsed height from exceeding its width.
const CARD_PADDING = Spacing.three;
const LABEL_BLOCK = 20 + Spacing.half; // label lineHeight + gap to content
const FOOTER_BLOCK = 18 + Spacing.two; // copy icon height + gap above it
const CONTENT_LINE_HEIGHT = 24; // default ThemedText lineHeight

// One column on phones (full-width cards read fine there); a multi-column grid
// on web, where a single column would stretch each card into a wide ribbon.
const COPA_COLUMNS = Platform.OS === 'web' ? 4 : 1;

function CopaCard({ item }: { item: CopaItem }) {
  const theme = useTheme();
  const { openOptions } = useCopaOptions();
  const { toggleFavorite } = useCopa();
  // Max content lines before the collapsed card would grow taller than it is
  // wide. Until measured (undefined) the text renders in full.
  const [maxLines, setMaxLines] = useState<number | undefined>(undefined);
  // Full line count of the content, captured once before any clamping applies.
  const [totalLines, setTotalLines] = useState<number | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Content is rich HTML now; flatten to plain text for both the preview and
  // what lands on the clipboard (pasting raw <html> tags would be useless).
  const text = useMemo(() => htmlToPlainText(item.content), [item.content]);

  const overflowing = maxLines !== undefined && totalLines !== undefined && totalLines > maxLines;
  const clamp = overflowing && !expanded;

  const onLayout = (e: LayoutChangeEvent) => {
    const { width } = e.nativeEvent.layout;
    const available = width - CARD_PADDING * 2 - LABEL_BLOCK - FOOTER_BLOCK;
    setMaxLines(Math.max(1, Math.floor(available / CONTENT_LINE_HEIGHT)));
  };

  const onTextLayout = (e: { nativeEvent: TextLayoutEventData }) => {
    // Capture the untruncated line count on the first pass (before clamping),
    // so collapsing the text later can't shrink the measured total.
    if (totalLines === undefined) setTotalLines(e.nativeEvent.lines.length);
  };

  const onCopy = async () => {
    await Clipboard.setStringAsync(text);
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  // Tap copies; double-tap favorites.
  const onPress = useDoubleTap(
    () => {
      void onCopy();
    },
    () => toggleFavorite(item.id),
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Copy ${item.label}`}
      accessibilityHint="Copies the contents to the clipboard"
      onPress={onPress}
      onLongPress={() => openOptions(item.id)}>
      {({ pressed }) => (
        <ThemedView
          type="backgroundElement"
          style={[styles.card, pressed && styles.pressed]}
          onLayout={onLayout}>
          <View style={styles.header}>
            {overflowing && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={expanded ? 'Collapse' : 'Expand'}
                onPress={() => setExpanded((v) => !v)}
                hitSlop={Spacing.two}>
                <Feather
                  name={expanded ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color={theme.textSecondary}
                />
              </Pressable>
            )}
            <ThemedText type="smallBold" themeColor="textSecondary">
              {item.label}
            </ThemedText>
            {item.favorite && <FavoriteStar size={14} style={styles.favoriteStar} />}
          </View>
          <ThemedText numberOfLines={clamp ? maxLines : undefined} onTextLayout={onTextLayout}>
            {text}
          </ThemedText>
          <View style={styles.footer}>
            <Feather name={copied ? 'check' : 'copy'} size={18} color={theme.textSecondary} />
          </View>
        </ThemedView>
      )}
    </Pressable>
  );
}

/**
 * A copa block backed by a file. Shows a thumbnail (image/video) or a file-type
 * icon with the file's name and size. Tapping opens the OS share/open sheet
 * instead of copying; double-tap favorites and long-press opens options, to
 * match the text card.
 */
function FileCopaCard({ item }: { item: CopaItem }) {
  const theme = useTheme();
  const { openOptions } = useCopaOptions();
  const { toggleFavorite } = useCopa();

  const onPress = useDoubleTap(
    () => {
      void downloadCopaFile(item);
    },
    () => toggleFavorite(item.id),
  );

  const showImage = isImage(item.mimeType) && !!item.fileUri;
  const showVideo = isVideo(item.mimeType) && !!item.thumbUri;
  const meta = [item.fileName, formatBytes(item.fileSize)].filter(Boolean).join('  ·  ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Download ${item.label || item.fileName}`}
      accessibilityHint="Saves the file to your device"
      onPress={onPress}
      onLongPress={() => openOptions(item.id)}>
      {({ pressed }) => (
        <ThemedView type="backgroundElement" style={[styles.fileCard, pressed && styles.pressed]}>
          {showImage ? (
            <Image source={{ uri: item.fileUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : showVideo ? (
            <Image source={{ uri: item.thumbUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <View style={styles.fileIconFill}>
              <Feather name={fileIconFor(item.mimeType)} size={48} color={theme.textSecondary} />
            </View>
          )}

          {showVideo && (
            <View style={styles.fileBadgeCenter} pointerEvents="none">
              <View style={styles.playBadge}>
                <Feather name="play" size={20} color="#fff" />
              </View>
            </View>
          )}

          {/* Bottom-to-top scrim so the overlaid footer stays legible. */}
          <LinearGradient
            pointerEvents="none"
            colors={['transparent', 'rgba(0,0,0,0.75)']}
            style={styles.fileScrim}
          />
          <View style={styles.fileFooter}>
            <ThemedText numberOfLines={1} style={styles.fileMeta}>
              {meta}
            </ThemedText>
            {item.favorite && <FavoriteStar size={16} />}
            <Feather name="download" size={18} color="#fff" />
          </View>
        </ThemedView>
      )}
    </Pressable>
  );
}

export default function CopaScreen() {
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { items } = useCopa();
  const { refreshing, onRefresh } = useSyncRefresh();
  const [query, setQuery] = useState('');
  const fadeStyle = useScreenFadeStyle();

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const visible = searching
    ? items.filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          item.content.toLowerCase().includes(q) ||
          (item.fileName?.toLowerCase().includes(q) ?? false),
      )
    : items;

  // In the web grid, pad the final row with transparent cells so its cards stay
  // at single-column width instead of stretching to fill the row.
  type Row = CopaItem | { id: string; spacer: true };
  const data: Row[] = [...visible];
  if (COPA_COLUMNS > 1) {
    const pad = (COPA_COLUMNS - (visible.length % COPA_COLUMNS)) % COPA_COLUMNS;
    for (let i = 0; i < pad; i++) data.push({ id: `spacer-${i}`, spacer: true });
  }

  // The search field floats; the list scrolls beneath it. Reserve enough top
  // padding that the first card clears the bar, and fade content out behind it.
  const barTop = insets.top + Spacing.two;
  const contentTop = barTop + SEARCH_BAR_HEIGHT + Spacing.three;

  return (
    <Animated.View style={[styles.container, fadeStyle]}>
    <ThemedView style={styles.container}>
      <FlatList
        data={data}
        keyExtractor={(item) => item.id}
        numColumns={COPA_COLUMNS}
        // numColumns must change with a fresh key, and a row wrapper is only
        // valid for multi-column lists.
        key={COPA_COLUMNS}
        columnWrapperStyle={COPA_COLUMNS > 1 ? styles.row : undefined}
        contentContainerStyle={[
          styles.content,
          gridEdgePadding,
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
              No copy blocks match “{query.trim()}”.
            </ThemedText>
          ) : null
        }
        renderItem={({ item }) => {
          if ('spacer' in item) return <View style={styles.cardCell} />;
          const card = item.fileUri ? <FileCopaCard item={item} /> : <CopaCard item={item} />;
          return COPA_COLUMNS > 1 ? <View style={styles.cardCell}>{card}</View> : card;
        }}
      />
      {/* Fades scrolling cards out behind the floating search field. */}
      <LinearGradient
        pointerEvents="none"
        colors={[theme.background, `${theme.background}00`]}
        style={[styles.topFade, { height: contentTop }]}
      />
      <View style={[styles.searchFloat, { top: barTop }]} pointerEvents="box-none">
        <SearchBar value={query} onChangeText={setQuery} placeholder="Search copy blocks" />
      </View>
      <BottomFade />
    </ThemedView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.three,
  },
  // Web grid: even gaps between columns and a flexible cell so each card fills
  // its column width (and the trailing spacer keeps the last row aligned).
  row: {
    gap: Spacing.three,
    alignItems: 'flex-start',
  },
  cardCell: {
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
  empty: {
    textAlign: 'center',
    marginTop: Spacing.five,
  },
  card: {
    gap: Spacing.half,
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  footer: {
    marginTop: Spacing.two,
    alignItems: 'flex-end',
  },
  favoriteStar: {
    marginLeft: 'auto',
  },
  pressed: {
    opacity: 0.6,
  },
  // File-block card: a full-bleed thumbnail with the footer overlaid on a scrim.
  fileCard: {
    height: 180,
    borderRadius: Spacing.three,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  fileIconFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileBadgeCenter: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBadge: {
    width: 44,
    height: 44,
    borderRadius: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  fileScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 96,
  },
  fileFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.three,
  },
  fileMeta: {
    flex: 1,
    fontSize: 13,
    color: '#fff',
  },
});
