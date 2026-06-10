import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { EnrichedText, type EnrichedTextHtmlStyle } from 'react-native-enriched';

import { FavoriteStar } from '@/components/favorite-star';
import { useItemOptions } from '@/components/item-options-modal';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing, type Palette } from '@/constants/theme';
import type { Folder, Note } from '@/data/notes';
import { useDoubleTap } from '@/hooks/use-double-tap';
import { useTheme } from '@/hooks/use-theme';
import { useNotes } from '@/store/notes-store';

const LINK_COLOR = '#3c87f7';
const PREVIEW_TEXT = { fontSize: 14, lineHeight: 20, fontWeight: '500' } as const;

/** Compact rich-text styling for the card preview — small headings, tight lists. */
function previewHtmlStyle(theme: Palette): EnrichedTextHtmlStyle {
  return {
    h1: { fontSize: 16, bold: true },
    h2: { fontSize: 15, bold: true },
    h3: { fontSize: 14, bold: true },
    blockquote: { borderColor: theme.backgroundSelected, color: theme.textSecondary, gapWidth: 8 },
    code: { color: theme.textSecondary, backgroundColor: theme.backgroundElementAlt },
    codeblock: { color: theme.textSecondary, backgroundColor: theme.backgroundElementAlt, borderRadius: 6 },
    a: { color: LINK_COLOR },
    ul: { bulletColor: theme.textSecondary, bulletSize: 5, marginLeft: 6, gapWidth: 8 },
    ol: { markerColor: theme.textSecondary, marginLeft: 6, gapWidth: 8 },
    ulCheckbox: { boxColor: theme.textSecondary, boxSize: 14, marginLeft: 6, gapWidth: 8 },
  };
}

export function FolderCard({ folder }: { folder: Folder }) {
  const router = useRouter();
  const { getNotesInFolder, toggleFolderFavorite } = useNotes();
  const { openOptions } = useItemOptions();
  const theme = useTheme();
  const count = getNotesInFolder(folder.id).length;

  // Tap opens the folder; double-tap favorites it.
  const onPress = useDoubleTap(
    () => router.push({ pathname: '/folder/[id]', params: { id: folder.id } }),
    () => toggleFolderFavorite(folder.id),
  );

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}
      onPress={onPress}
      onLongPress={() => openOptions({ type: 'folder', id: folder.id })}>
      <ThemedView style={styles.folder}>
        {/* Tab: flat top that slopes down to the body at 45° on the right. */}
        <View style={styles.folderTabRow}>
          <View style={[styles.folderTabFlat, { backgroundColor: theme.backgroundElement }]} />
          <View style={[styles.folderTabSlant, { borderBottomColor: theme.backgroundElement }]} />
        </View>
        <ThemedView type="backgroundElement" style={styles.folderBody}>
          <ThemedView type="backgroundElement" style={styles.cardFooter}>
            <View style={styles.titleRow}>
              <ThemedText type="smallBold" numberOfLines={1} style={styles.titleText}>
                {folder.name}
              </ThemedText>
              {folder.favorite && <FavoriteStar size={13} />}
            </View>
            <ThemedText type="small" themeColor="textSecondary">
              {count} {count === 1 ? 'note' : 'notes'}
            </ThemedText>
          </ThemedView>
        </ThemedView>
      </ThemedView>
    </Pressable>
  );
}

export function NoteCard({ note }: { note: Note }) {
  const router = useRouter();
  const { toggleNoteFavorite } = useNotes();
  const { openOptions } = useItemOptions();
  const theme = useTheme();

  // Tap opens the note; double-tap favorites it.
  const onPress = useDoubleTap(
    () => router.push({ pathname: '/note/[id]', params: { id: note.id } }),
    () => toggleNoteFavorite(note.id),
  );

  // Render the body as rich text so the preview shows the actual formatting
  // (bold, italics, lists, checkboxes, …) rather than stripped plain text.
  const html = useMemo(() => previewHtmlStyle(theme), [theme]);
  const textStyle = useMemo(() => ({ ...PREVIEW_TEXT, color: theme.textSecondary }), [theme]);

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}
      onPress={onPress}
      onLongPress={() => openOptions({ type: 'note', id: note.id })}>
      <ThemedView type="backgroundElementAlt" style={styles.card}>
        <View style={styles.titleRow}>
          <ThemedText type="smallBold" numberOfLines={1} style={styles.titleText}>
            {note.title}
          </ThemedText>
          {note.favorite && <FavoriteStar size={13} />}
        </View>
        {note.body.trim().length > 0 && (
          <EnrichedText
            numberOfLines={4}
            ellipsizeMode="tail"
            style={textStyle}
            htmlStyle={html}>
            {note.body}
          </EnrichedText>
        )}
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
  folder: {
    flex: 1,
    minHeight: 120,
    backgroundColor: 'transparent',
  },
  folderTabRow: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    width: '55%',
    height: Spacing.three,
  },
  folderTabFlat: {
    flex: 1,
    height: Spacing.three,
    borderTopLeftRadius: Spacing.three,
  },
  // Right triangle: hypotenuse drops top-left → bottom-right at 45° (equal sides).
  folderTabSlant: {
    width: 0,
    height: 0,
    borderBottomWidth: Spacing.three,
    borderRightWidth: Spacing.three,
    borderRightColor: 'transparent',
  },
  folderBody: {
    flex: 1,
    borderRadius: Spacing.three,
    borderTopLeftRadius: 0,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  cardFooter: {
    gap: Spacing.half,
    marginTop: 'auto',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  titleText: {
    flexShrink: 1,
  },
});
