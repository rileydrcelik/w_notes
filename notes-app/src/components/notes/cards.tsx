import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { EnrichedText, type EnrichedTextHtmlStyle } from 'react-native-enriched';

import { FavoriteStar } from '@/components/favorite-star';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { hexToRgba, Spacing, type Palette } from '@/constants/theme';
import type { Folder, Note } from '@/data/notes';
import { sentryTarget } from '@/lib/sentry-note';
import { githubTarget } from '@/lib/github-note';
import { projectConfig } from '@/lib/project';
import { useDoubleTap } from '@/hooks/use-double-tap';
import { useTheme } from '@/hooks/use-theme';
import { useItemSelection } from '@/store/item-selection-store';
import { useNotes } from '@/store/notes-store';

const LINK_COLOR = '#3c87f7';
const SENTRY_ACCENT = '#7553FF';
const GITHUB_ACCENT = '#8250df';
const PROJECT_ACCENT = '#16a394';
/** Accent for a long-pressed/right-clicked (selected) card. */
const SELECT_ACCENT = '#7a89b8';
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
  // A task-manager project folder renders as a distinct card that opens the
  // issue tracker rather than the plain folder grid.
  if (folder.kind === 'project') return <ProjectFolderCard folder={folder} />;
  return <PlainFolderCard folder={folder} />;
}

function PlainFolderCard({ folder }: { folder: Folder }) {
  const router = useRouter();
  const { getNotesInFolder, toggleFolderFavorite } = useNotes();
  const { active, isSelected, toggle } = useItemSelection();
  const theme = useTheme();
  const count = getNotesInFolder(folder.id).length;
  const selected = isSelected('folder', folder.id);

  // Tap opens the folder; double-tap favorites it. In selection mode a tap
  // instead toggles this card's selection.
  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/folder/[id]', params: { id: folder.id } }),
    () => toggleFolderFavorite(folder.id),
  );
  const onSelectToggle = () => toggle({ type: 'folder', id: folder.id });

  return (
    <Pressable
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

/** A task-manager project: a distinct card that opens the issue tracker. */
function ProjectFolderCard({ folder }: { folder: Folder }) {
  const router = useRouter();
  const { toggleFolderFavorite } = useNotes();
  const { active, isSelected, toggle } = useItemSelection();
  const theme = useTheme();
  const selected = isSelected('folder', folder.id);
  const config = projectConfig(folder);

  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/project/[id]', params: { id: folder.id } }),
    () => toggleFolderFavorite(folder.id),
  );
  const onSelectToggle = () => toggle({ type: 'folder', id: folder.id });

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrapper, pressed && styles.pressed]}
      onPress={active ? onSelectToggle : openOrFavorite}
      onLongPress={onSelectToggle}>
      <ThemedView style={styles.folder}>
        {/* Same folder silhouette as a plain folder, marked as a task manager. */}
        <View style={styles.folderTabRow}>
          <View style={[styles.folderTabFlat, { backgroundColor: theme.backgroundElement }]} />
          <View style={[styles.folderTabSlant, { borderBottomColor: theme.backgroundElement }]} />
        </View>
        <ThemedView type="backgroundElement" style={[styles.folderBody, selected && styles.selected]}>
          <ThemedView type="backgroundElement" style={styles.cardFooter}>
            <View style={styles.titleRow}>
              <Feather name="columns" size={13} color={PROJECT_ACCENT} />
              <ThemedText type="smallBold" numberOfLines={1} style={styles.titleText}>
                {folder.name || 'Project'}
              </ThemedText>
              {folder.favorite && <FavoriteStar size={13} />}
            </View>
            <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
              Task manager{config?.repo ? ` · ${config.repo}` : ''}
            </ThemedText>
          </ThemedView>
        </ThemedView>
      </ThemedView>
    </Pressable>
  );
}

export function NoteCard({ note }: { note: Note }) {
  // Plugin notes render as distinct cards that open live content instead of the
  // text editor. Branch before any hooks so those cards keep their own hook order.
  if (note.pluginType === 'sentry') return <SentryNoteCard note={note} />;
  if (note.pluginType === 'github') return <GithubNoteCard note={note} />;
  return <TextNoteCard note={note} />;
}

function TextNoteCard({ note }: { note: Note }) {
  const router = useRouter();
  const { toggleNoteFavorite } = useNotes();
  const { active, isSelected, toggle } = useItemSelection();
  const theme = useTheme();
  const selected = isSelected('note', note.id);

  // Tap opens the note; double-tap favorites it. In selection mode a tap instead
  // toggles this card's selection.
  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/note/[id]', params: { id: note.id } }),
    () => toggleNoteFavorite(note.id),
  );
  const onSelectToggle = () => toggle({ type: 'note', id: note.id });

  // Render the body as rich text so the preview shows the actual formatting
  // (bold, italics, lists, checkboxes, …) rather than stripped plain text.
  const html = useMemo(() => previewHtmlStyle(theme), [theme]);
  const textStyle = useMemo(() => ({ ...PREVIEW_TEXT, color: theme.textSecondary }), [theme]);

  return (
    <Pressable
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

  return (
    <Pressable
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

  return (
    <Pressable
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
    minHeight: 120,
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
