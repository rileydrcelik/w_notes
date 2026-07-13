import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { FavoriteStar } from '@/components/favorite-star';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { hexToRgba, Spacing } from '@/constants/theme';
import type { Folder, Note } from '@/data/notes';
import { sentryTarget } from '@/lib/sentry-note';
import { githubTarget } from '@/lib/github-note';
import { useContextMenu } from '@/hooks/use-context-menu';
import { useDoubleTap } from '@/hooks/use-double-tap';
import { useTheme } from '@/hooks/use-theme';
import { htmlToPlainText } from '@/lib/html-text';
import { useItemSelection } from '@/store/item-selection-store';
import { useNotes } from '@/store/notes-store';

const SENTRY_ACCENT = '#7553FF';
const GITHUB_ACCENT = '#8250df';
/** Accent for a long-pressed/right-clicked (selected) card. */
const SELECT_ACCENT = '#7a89b8';
const PREVIEW_TEXT = { fontSize: 14, lineHeight: 20, fontWeight: '500' } as const;

export function FolderCard({ folder }: { folder: Folder }) {
  const router = useRouter();
  const { getNotesInFolder, toggleFolderFavorite } = useNotes();
  const { active, isSelected, toggle } = useItemSelection();
  const theme = useTheme();
  const count = getNotesInFolder(folder.id).length;
  const selected = isSelected('folder', folder.id);

  // Tap opens the folder; double-tap favorites it. In selection mode a click
  // instead toggles this card's selection.
  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/folder/[id]', params: { id: folder.id } }),
    () => toggleFolderFavorite(folder.id),
  );
  const onSelectToggle = () => toggle({ type: 'folder', id: folder.id });

  // Right-click mirrors the mobile long-press (toggles selection).
  const contextMenuRef = useContextMenu(onSelectToggle);

  return (
    <Pressable
      ref={contextMenuRef}
      style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}
      onPress={active ? onSelectToggle : openOrFavorite}
      onLongPress={onSelectToggle}>
      <ThemedView style={styles.folder}>
        {/* Tab: flat top that slopes down to the body at 45° on the right. */}
        <View style={styles.folderTabRow}>
          <View style={[styles.folderTabFlat, { backgroundColor: theme.backgroundElement }]} />
          <View style={[styles.folderTabSlant, { borderBottomColor: theme.backgroundElement }]} />
        </View>
        <ThemedView
          type="backgroundElement"
          style={[styles.folderBody, selected && styles.selected]}>
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
  const { active, isSelected, toggle } = useItemSelection();
  const selected = isSelected('note', note.id);

  // A Sentry plugin note renders as a distinct card that opens the live issues
  // screen rather than the text editor.
  if (note.pluginType === 'sentry') return <SentryNoteCard note={note} />;
  if (note.pluginType === 'github') return <GithubNoteCard note={note} />;

  // Tap opens the note; double-tap favorites it. In selection mode a click
  // instead toggles this card's selection.
  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/note/[id]', params: { id: note.id } }),
    () => toggleNoteFavorite(note.id),
  );
  const onSelectToggle = () => toggle({ type: 'note', id: note.id });

  // Right-click mirrors the mobile long-press (toggles selection).
  const contextMenuRef = useContextMenu(onSelectToggle);

  // No native rich-text renderer on web — flatten the HTML body to plain text
  // for the preview (same helper the copa list uses).
  const preview = note.body.trim().length > 0 ? htmlToPlainText(note.body) : '';

  return (
    <Pressable
      ref={contextMenuRef}
      style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}
      onPress={active ? onSelectToggle : openOrFavorite}
      onLongPress={onSelectToggle}>
      <ThemedView type="backgroundElementAlt" style={[styles.card, selected && styles.selected]}>
        <View style={styles.titleRow}>
          <ThemedText type="smallBold" numberOfLines={1} style={styles.titleText}>
            {note.title}
          </ThemedText>
          {note.favorite && <FavoriteStar size={13} />}
        </View>
        {preview.length > 0 && (
          <ThemedText
            numberOfLines={4}
            ellipsizeMode="tail"
            themeColor="textSecondary"
            style={PREVIEW_TEXT}>
            {preview}
          </ThemedText>
        )}
      </ThemedView>
    </Pressable>
  );
}

/** A Sentry plugin note: a distinct card that opens the live issues screen. */
function SentryNoteCard({ note }: { note: Note }) {
  const router = useRouter();
  const { toggleNoteFavorite } = useNotes();
  const { active, isSelected, toggle } = useItemSelection();
  const selected = isSelected('note', note.id);

  const target = sentryTarget(note);

  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/sentry/[id]', params: { id: note.id } }),
    () => toggleNoteFavorite(note.id),
  );
  const onSelectToggle = () => toggle({ type: 'note', id: note.id });

  const contextMenuRef = useContextMenu(onSelectToggle);

  return (
    <Pressable
      ref={contextMenuRef}
      style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}
      onPress={active ? onSelectToggle : openOrFavorite}
      onLongPress={onSelectToggle}>
      <ThemedView type="backgroundElementAlt" style={[styles.card, selected && styles.selected]}>
        <View style={styles.titleRow}>
          <Feather name="alert-triangle" size={15} color={SENTRY_ACCENT} />
          <ThemedText type="smallBold" numberOfLines={1} style={styles.titleText}>
            {target?.projectName ?? target?.project ?? 'Sentry'}
          </ThemedText>
          {note.favorite && <FavoriteStar size={13} />}
        </View>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
          Live issues{target?.org ? ` · ${target.org}` : ''}
        </ThemedText>
      </ThemedView>
    </Pressable>
  );
}

/** A GitHub plugin note: a distinct card that opens the live issues screen. */
function GithubNoteCard({ note }: { note: Note }) {
  const router = useRouter();
  const { toggleNoteFavorite } = useNotes();
  const { active, isSelected, toggle } = useItemSelection();
  const selected = isSelected('note', note.id);

  const target = githubTarget(note);

  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/github/[id]', params: { id: note.id } }),
    () => toggleNoteFavorite(note.id),
  );
  const onSelectToggle = () => toggle({ type: 'note', id: note.id });

  const contextMenuRef = useContextMenu(onSelectToggle);

  return (
    <Pressable
      ref={contextMenuRef}
      style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}
      onPress={active ? onSelectToggle : openOrFavorite}
      onLongPress={onSelectToggle}>
      <ThemedView type="backgroundElementAlt" style={[styles.card, selected && styles.selected]}>
        <View style={styles.titleRow}>
          <Feather name="github" size={15} color={GITHUB_ACCENT} />
          <ThemedText type="smallBold" numberOfLines={1} style={styles.titleText}>
            {target?.repoName ?? target?.repo ?? 'GitHub'}
          </ThemedText>
          {note.favorite && <FavoriteStar size={13} />}
        </View>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
          Issues{target?.repo ? ` · ${target.repo}` : ''}
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
    minHeight: 200,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
    // Transparent border reserved so the selected state doesn't shift layout.
    borderWidth: 2,
    borderColor: 'transparent',
  },
  // Highlight for a selected (long-pressed/right-clicked) card.
  selected: {
    borderColor: SELECT_ACCENT,
    backgroundColor: hexToRgba(SELECT_ACCENT, 0.12),
  },
  folder: {
    flex: 1,
    minHeight: 200,
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
    // Transparent border reserved so the selected state doesn't shift layout.
    borderWidth: 2,
    borderColor: 'transparent',
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
