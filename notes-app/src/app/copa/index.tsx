import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
import { useRef, useState } from 'react';
import {
  FlatList,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  type TextLayoutEventData,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomFade } from '@/components/bottom-fade';
import { useCopaOptions } from '@/components/copa-options-modal';
import { SearchBar, SEARCH_BAR_HEIGHT } from '@/components/search-bar';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { type CopaItem } from '@/data/copa';
import { useDoubleTap } from '@/hooks/use-double-tap';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useCopa } from '@/store/copa-store';

// Geometry of a card used to keep its collapsed height from exceeding its width.
const CARD_PADDING = Spacing.three;
const LABEL_BLOCK = 20 + Spacing.half; // label lineHeight + gap to content
const FOOTER_BLOCK = 18 + Spacing.two; // copy icon height + gap above it
const CONTENT_LINE_HEIGHT = 24; // default ThemedText lineHeight

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
    await Clipboard.setStringAsync(item.content);
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
            {item.favorite && (
              <Feather name="star" size={14} color="#f5a623" style={styles.favoriteStar} />
            )}
          </View>
          <ThemedText numberOfLines={clamp ? maxLines : undefined} onTextLayout={onTextLayout}>
            {item.content}
          </ThemedText>
          <View style={styles.footer}>
            <Feather name={copied ? 'check' : 'copy'} size={18} color={theme.textSecondary} />
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
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const visible = searching
    ? items.filter(
        (item) =>
          item.label.toLowerCase().includes(q) || item.content.toLowerCase().includes(q),
      )
    : items;

  // The search field floats; the list scrolls beneath it. Reserve enough top
  // padding that the first card clears the bar, and fade content out behind it.
  const barTop = insets.top + Spacing.two;
  const contentTop = barTop + SEARCH_BAR_HEIGHT + Spacing.three;

  return (
    <ThemedView style={styles.container}>
      <FlatList
        data={visible}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.content,
          { paddingTop: contentTop, paddingBottom: tabBarInset },
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListEmptyComponent={
          searching ? (
            <ThemedText themeColor="textSecondary" style={styles.empty}>
              No copy blocks match “{query.trim()}”.
            </ThemedText>
          ) : null
        }
        renderItem={({ item }) => <CopaCard item={item} />}
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
});
