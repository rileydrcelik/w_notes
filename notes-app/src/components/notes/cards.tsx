import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { EnrichedText, type EnrichedTextHtmlStyle } from 'react-native-enriched';

import { FavoriteStar } from '@/components/favorite-star';
import { SheetGlyph } from '@/components/notes/sheet-glyph';
import { ACCENT as RESUME_ACCENT } from '@/components/resume/accent';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Fonts, hexToRgba, Spacing, type Palette } from '@/constants/theme';
import type { Folder, Note } from '@/data/notes';
import { sentryTarget } from '@/lib/sentry-note';
import { githubTarget } from '@/lib/github-note';
import { isResumeNote, resumeSourceExcerpt, resumeTitle } from '@/lib/resume-note';
import { useCardPreviewLines, useTileHeight } from '@/lib/grid';
import { projectConfig } from '@/lib/project';
import { useDoubleTap } from '@/hooks/use-double-tap';
import { useTheme } from '@/hooks/use-theme';
import { useItemSelection } from '@/store/item-selection-store';
import { useNotes } from '@/store/notes-store';

const LINK_COLOR = '#3c87f7';
const SENTRY_ACCENT = '#7553FF';
const GITHUB_ACCENT = '#8250df';
const PROJECT_ACCENT = '#16a394';
const FINANCE_ACCENT = '#2f9e6e';
// The resume's is imported rather than repeated: that hex lives in
// `components/resume/accent.ts` because copies of it drifted once already.
/** Accent for a long-pressed/right-clicked (selected) card. */
const SELECT_ACCENT = '#7a89b8';
const PREVIEW_TEXT = { fontSize: 14, lineHeight: 20, fontWeight: '500' } as const;
/**
 * Most lines of preview a card will show once the tile is tall enough for them.
 * The actual count is derived from the tile height (see `useCardPreviewLines`),
 * because the tile shrinks with the window and a fixed count clips inside it.
 */
const PREVIEW_MAX_LINES = 4;
/** Type metrics of the resume card's monospace source excerpt (see `sourcePreview`). */
const SOURCE_PREVIEW = { fontSize: 11, lineHeight: 16 } as const;
const SOURCE_PREVIEW_MAX_LINES = 3;

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
  const tileHeight = useTileHeight();

  // Tap opens the folder; double-tap favorites it. In selection mode a tap
  // instead toggles this card's selection.
  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/folder/[id]', params: { id: folder.id } }),
    () => toggleFolderFavorite(folder.id),
  );
  const onSelectToggle = () => toggle({ type: 'folder', id: folder.id });

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
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
  const tileHeight = useTileHeight();

  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/project/[id]', params: { id: folder.id } }),
    () => toggleFolderFavorite(folder.id),
  );
  const onSelectToggle = () => toggle({ type: 'folder', id: folder.id });

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
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
  if (note.pluginType === 'finance') return <FinanceNoteCard note={note} />;
  // A resume's body is LaTeX source, so it must never reach TextNoteCard — that
  // would hand raw LaTeX to the rich-text renderer.
  if (isResumeNote(note)) return <ResumeNoteCard note={note} />;
  return <TextNoteCard note={note} />;
}

/**
 * A finance plugin note: opens the spreadsheet. No preview of the cells — the
 * sheet lives in its own synced row, not in `note.body`, so a card would have to
 * load it separately just to render a thumbnail.
 */
function FinanceNoteCard({ note }: { note: Note }) {
  const router = useRouter();
  const { toggleNoteFavorite } = useNotes();
  const { active, isSelected, toggle } = useItemSelection();
  const selected = isSelected('note', note.id);
  const tileHeight = useTileHeight();

  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/finance/[id]', params: { id: note.id } }),
    () => toggleNoteFavorite(note.id),
  );
  const onSelectToggle = () => toggle({ type: 'note', id: note.id });

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
      onPress={active ? onSelectToggle : openOrFavorite}
      onLongPress={onSelectToggle}>
      <ThemedView type="backgroundElementAlt" style={[styles.card, selected && styles.selected]}>
        <View style={styles.titleRow}>
          <Feather name="grid" size={15} color={FINANCE_ACCENT} />
          <ThemedText type="smallBold" numberOfLines={1} style={styles.titleText}>
            {note.title.trim() || 'Untitled sheet'}
          </ThemedText>
          {note.favorite && <FavoriteStar size={13} />}
        </View>
        <SheetGlyph />
      </ThemedView>
    </Pressable>
  );
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
  const tileHeight = useTileHeight();
  const previewLines = useCardPreviewLines(
    PREVIEW_TEXT.fontSize,
    PREVIEW_TEXT.lineHeight,
    PREVIEW_MAX_LINES,
  );

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
      onPress={active ? onSelectToggle : openOrFavorite}
      onLongPress={onSelectToggle}>
      <ThemedView type="backgroundElementAlt" style={[styles.card, selected && styles.selected]}>
        <View style={styles.titleRow}>
          <ThemedText type="smallBold" numberOfLines={1} style={styles.titleText}>
            {note.title}
          </ThemedText>
          {note.favorite && <FavoriteStar size={13} />}
        </View>
        {note.body.trim().length > 0 && previewLines > 0 && (
          <EnrichedText
            numberOfLines={previewLines}
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
  const tileHeight = useTileHeight();

  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/sentry/[id]', params: { id: note.id } }),
    () => toggleNoteFavorite(note.id),
  );
  const onSelectToggle = () => toggle({ type: 'note', id: note.id });

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
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
  const tileHeight = useTileHeight();

  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/github/[id]', params: { id: note.id } }),
    () => toggleNoteFavorite(note.id),
  );
  const onSelectToggle = () => toggle({ type: 'note', id: note.id });

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
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

/** A resume plugin note: opens the LaTeX editor/preview instead of the text editor. */
function ResumeNoteCard({ note }: { note: Note }) {
  const router = useRouter();
  const { toggleNoteFavorite } = useNotes();
  const { active, isSelected, toggle } = useItemSelection();
  const theme = useTheme();
  const selected = isSelected('note', note.id);
  const tileHeight = useTileHeight();
  const previewLines = useCardPreviewLines(
    SOURCE_PREVIEW.fontSize,
    SOURCE_PREVIEW.lineHeight,
    SOURCE_PREVIEW_MAX_LINES,
  );

  // The body is LaTeX, so the preview is a plain source excerpt in monospace —
  // never the rich-text renderer.
  const excerpt = useMemo(() => resumeSourceExcerpt(note.body), [note.body]);

  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/resume/[id]', params: { id: note.id } }),
    () => toggleNoteFavorite(note.id),
  );
  const onSelectToggle = () => toggle({ type: 'note', id: note.id });

  return (
    <Pressable
      style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
      onPress={active ? onSelectToggle : openOrFavorite}
      onLongPress={onSelectToggle}>
      <ThemedView type="backgroundElementAlt" style={[styles.card, selected && styles.selected]}>
        <View style={styles.titleRow}>
          <Feather name="file-text" size={15} color={RESUME_ACCENT} />
          <ThemedText type="smallBold" numberOfLines={1} style={styles.titleText}>
            {resumeTitle(note)}
          </ThemedText>
          {note.favorite && <FavoriteStar size={13} />}
        </View>
        {previewLines > 0 &&
          (excerpt.length > 0 ? (
            <ThemedText
              type="small"
              themeColor="textSecondary"
              numberOfLines={previewLines}
              style={[styles.sourcePreview, { color: theme.textSecondary }]}>
              {excerpt}
            </ThemedText>
          ) : (
            <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
              LaTeX resume
            </ThemedText>
          ))}
      </ThemedView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cardWrapper: {
    // The surrounding View cell (in each grid screen) is the flex item that
    // sets the column width; this card stretches to it and takes its explicit
    // per-tile height (applied inline). No `flex: 1` — inside the height-less
    // cell it would fight the explicit height and make row heights inconsistent.
    minWidth: 0,
  },
  pressed: {
    opacity: 0.6,
  },
  card: {
    flex: 1,
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
  // LaTeX source excerpt on a resume card — monospace, so it reads as code.
  sourcePreview: {
    fontFamily: Fonts.mono,
    ...SOURCE_PREVIEW,
  },
});
