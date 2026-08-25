import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { FavoriteStar } from '@/components/favorite-star';
import { FolderShape } from '@/components/notes/folder-shape';
import { MatchSnippet } from '@/components/notes/match-snippet';
import { SheetGlyph } from '@/components/notes/sheet-glyph';
import { ACCENT as RESUME_ACCENT } from '@/components/resume/accent';
import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import type { Folder, Note } from '@/data/notes';
import { sentryTarget } from '@/lib/sentry-note';
import { githubTarget } from '@/lib/github-note';
import { isResumeNote, resumeSourceExcerpt, resumeTitle } from '@/lib/resume-note';
import { isMasterResume } from '@/lib/resume-master';
import { useCardPreviewLines, useTileHeight } from '@/lib/grid';
import { projectConfig } from '@/lib/project';
import { useContextMenu } from '@/hooks/use-context-menu';
import { useDoubleTap } from '@/hooks/use-double-tap';
import { htmlToPlainText } from '@/lib/html-text';
import { matchSnippet } from '@/lib/search';
import { useSelectionSurface } from '@/hooks/use-selection-fade';
import { useItemSelection } from '@/store/item-selection-store';
import { useNotes } from '@/store/notes-store';

const SENTRY_ACCENT = '#7553FF';
const GITHUB_ACCENT = '#8250df';
const PROJECT_ACCENT = '#16a394';
const FINANCE_ACCENT = '#2f9e6e';
// The resume's is imported rather than repeated: that hex lives in
// `components/resume/accent.ts` because copies of it drifted once already.
/** Accent for a long-pressed/right-clicked (selected) card. */
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

export function FolderCard({ folder }: { folder: Folder }) {
  if (folder.kind === 'project') return <ProjectFolderCard folder={folder} />;
  return <PlainFolderCard folder={folder} />;
}

function PlainFolderCard({ folder }: { folder: Folder }) {
  const router = useRouter();
  const { getNotesInFolder, toggleFolderFavorite } = useNotes();
  const { active, isSelected, toggle } = useItemSelection();
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
  const tileHeight = useTileHeight();

  return (
    <Pressable
      ref={contextMenuRef}
      style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
      onPress={active ? onSelectToggle : openOrFavorite}
      onLongPress={onSelectToggle}>
      <FolderShape selected={selected}>
        <View style={styles.cardFooter}>
          <View style={styles.titleRow}>
            <ThemedText type="smallBold" numberOfLines={1} style={styles.titleText}>
              {folder.name}
            </ThemedText>
            {folder.favorite && <FavoriteStar size={13} />}
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            {count} {count === 1 ? 'note' : 'notes'}
          </ThemedText>
        </View>
      </FolderShape>
    </Pressable>
  );
}

/** A task-manager project: a distinct card that opens the issue tracker. */
function ProjectFolderCard({ folder }: { folder: Folder }) {
  const router = useRouter();
  const { toggleFolderFavorite } = useNotes();
  const { active, isSelected, toggle } = useItemSelection();
  const selected = isSelected('folder', folder.id);
  const config = projectConfig(folder);

  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/project/[id]', params: { id: folder.id } }),
    () => toggleFolderFavorite(folder.id),
  );
  const onSelectToggle = () => toggle({ type: 'folder', id: folder.id });
  const contextMenuRef = useContextMenu(onSelectToggle);
  const tileHeight = useTileHeight();

  return (
    <Pressable
      ref={contextMenuRef}
      style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
      onPress={active ? onSelectToggle : openOrFavorite}
      onLongPress={onSelectToggle}>
      {/* Same folder silhouette as a plain folder, marked as a task manager. */}
      <FolderShape selected={selected}>
        <View style={styles.cardFooter}>
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
        </View>
      </FolderShape>
    </Pressable>
  );
}

/**
 * `query` is the search this card is a result of, when it is one — see the
 * native `cards.tsx` for what it's for. Keep the two signatures identical.
 */
export function NoteCard({ note, query }: { note: Note; query?: string }) {
  // Plugin notes render as distinct cards that open live content instead of the
  // text editor. Branch before any hooks so those cards keep their own hook order.
  if (note.pluginType === 'sentry') return <SentryNoteCard note={note} />;
  if (note.pluginType === 'github') return <GithubNoteCard note={note} />;
  if (note.pluginType === 'finance') return <FinanceNoteCard note={note} />;
  // A resume's body is LaTeX source, so it must never reach TextNoteCard — that
  // would flatten raw LaTeX as if it were HTML.
  if (isResumeNote(note)) return <ResumeNoteCard note={note} />;
  return <TextNoteCard note={note} query={query} />;
}

/**
 * A finance plugin note: opens the spreadsheet. Mirrors the native card, with
 * right-click standing in for long-press. Keep this branch in step with
 * `cards.tsx` — the platform-parity test compares exported *names*, so a case
 * added to only one of these two files passes every check and silently renders
 * the wrong card on one platform.
 */
function FinanceNoteCard({ note }: { note: Note }) {
  const router = useRouter();
  const { toggleNoteFavorite } = useNotes();
  const { active, isSelected, toggle } = useItemSelection();
  const selected = isSelected('note', note.id);
  const surface = useSelectionSurface(selected, 'backgroundElementAlt');

  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/finance/[id]', params: { id: note.id } }),
    () => toggleNoteFavorite(note.id),
  );
  const onSelectToggle = () => toggle({ type: 'note', id: note.id });
  const contextMenuRef = useContextMenu(onSelectToggle);
  const tileHeight = useTileHeight();

  return (
    <Pressable
      ref={contextMenuRef}
      style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
      onPress={active ? onSelectToggle : openOrFavorite}
      onLongPress={onSelectToggle}>
      <Animated.View style={[styles.card, surface]}>
        <View style={styles.titleRow}>
          <Feather name="grid" size={15} color={FINANCE_ACCENT} />
          <ThemedText type="smallBold" numberOfLines={1} style={styles.titleText}>
            {note.title.trim() || 'Untitled sheet'}
          </ThemedText>
          {note.favorite && <FavoriteStar size={13} />}
        </View>
        <SheetGlyph />
      </Animated.View>
    </Pressable>
  );
}

function TextNoteCard({ note, query }: { note: Note; query?: string }) {
  const router = useRouter();
  const { toggleNoteFavorite } = useNotes();
  const { active, isSelected, toggle } = useItemSelection();
  const selected = isSelected('note', note.id);
  const surface = useSelectionSurface(selected, 'backgroundElementAlt');

  // Tap opens the note; double-tap favorites it. In selection mode a click
  // instead toggles this card's selection.
  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/note/[id]', params: { id: note.id } }),
    () => toggleNoteFavorite(note.id),
  );
  const onSelectToggle = () => toggle({ type: 'note', id: note.id });

  // Right-click mirrors the mobile long-press (toggles selection).
  const contextMenuRef = useContextMenu(onSelectToggle);
  const tileHeight = useTileHeight();
  const previewLines = useCardPreviewLines(
    PREVIEW_TEXT.fontSize,
    PREVIEW_TEXT.lineHeight,
    PREVIEW_MAX_LINES,
  );

  // No native rich-text renderer on web — flatten the HTML body to plain text
  // for the preview (same helper the copa list uses).
  const preview = note.body.trim().length > 0 ? htmlToPlainText(note.body) : '';

  // While this card is a search result, the preview gives way to the excerpt
  // that says why — see the native card. Null when the query isn't literally in
  // the body, and the preview above stands.
  const snippet = query ? matchSnippet(note.body, query) : null;

  return (
    <Pressable
      ref={contextMenuRef}
      style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
      onPress={active ? onSelectToggle : openOrFavorite}
      onLongPress={onSelectToggle}>
      <Animated.View style={[styles.card, surface]}>
        <View style={styles.titleRow}>
          <ThemedText type="smallBold" numberOfLines={1} style={styles.titleText}>
            {note.title}
          </ThemedText>
          {note.favorite && <FavoriteStar size={13} />}
        </View>
        {previewLines > 0 &&
          (snippet ? (
            <MatchSnippet parts={snippet} numberOfLines={previewLines} style={PREVIEW_TEXT} />
          ) : preview.length > 0 ? (
            <ThemedText
              numberOfLines={previewLines}
              ellipsizeMode="tail"
              themeColor="textSecondary"
              style={PREVIEW_TEXT}>
              {preview}
            </ThemedText>
          ) : null)}
      </Animated.View>
    </Pressable>
  );
}

/** A Sentry plugin note: a distinct card that opens the live issues screen. */
function SentryNoteCard({ note }: { note: Note }) {
  const router = useRouter();
  const { toggleNoteFavorite } = useNotes();
  const { active, isSelected, toggle } = useItemSelection();
  const selected = isSelected('note', note.id);
  const surface = useSelectionSurface(selected, 'backgroundElementAlt');

  const target = sentryTarget(note);

  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/sentry/[id]', params: { id: note.id } }),
    () => toggleNoteFavorite(note.id),
  );
  const onSelectToggle = () => toggle({ type: 'note', id: note.id });

  const contextMenuRef = useContextMenu(onSelectToggle);
  const tileHeight = useTileHeight();

  return (
    <Pressable
      ref={contextMenuRef}
      style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
      onPress={active ? onSelectToggle : openOrFavorite}
      onLongPress={onSelectToggle}>
      <Animated.View style={[styles.card, surface]}>
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
      </Animated.View>
    </Pressable>
  );
}

/** A resume plugin note: opens the LaTeX editor/preview instead of the text editor. */
function ResumeNoteCard({ note }: { note: Note }) {
  const router = useRouter();
  const { toggleNoteFavorite, folders } = useNotes();
  const { active, isSelected, toggle } = useItemSelection();
  const selected = isSelected('note', note.id);
  const surface = useSelectionSurface(selected, 'backgroundElementAlt');

  // The body is LaTeX, so the preview is a plain source excerpt in monospace —
  // never htmlToPlainText, which would eat backslashes and braces as markup.
  const excerpt = resumeSourceExcerpt(note.body);
  // Whether this is the superset its folder's other resumes are tailored from.
  const master = isMasterResume(note, folders);

  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/resume/[id]', params: { id: note.id } }),
    () => toggleNoteFavorite(note.id),
  );
  const onSelectToggle = () => toggle({ type: 'note', id: note.id });

  const contextMenuRef = useContextMenu(onSelectToggle);
  const tileHeight = useTileHeight();
  const previewLines = useCardPreviewLines(
    SOURCE_PREVIEW.fontSize,
    SOURCE_PREVIEW.lineHeight,
    SOURCE_PREVIEW_MAX_LINES,
  );

  return (
    <Pressable
      ref={contextMenuRef}
      style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
      onPress={active ? onSelectToggle : openOrFavorite}
      onLongPress={onSelectToggle}>
      <Animated.View style={[styles.card, surface]}>
        <View style={styles.titleRow}>
          {/* The master wears a different glyph rather than a badge beside the
              same one — it is the same kind of thing as every other resume, so
              what changes is which thing it is, not how much furniture it has.
              `award` is the icon the options sheet sets it with, so the two
              read as one gesture. */}
          <Feather
            name={master ? 'award' : 'file-text'}
            size={15}
            color={RESUME_ACCENT}
          />
          <ThemedText type="smallBold" numberOfLines={1} style={styles.titleText}>
            {resumeTitle(note)}
          </ThemedText>
          {note.favorite && <FavoriteStar size={13} />}
        </View>
        {previewLines > 0 &&
          (excerpt.length > 0 ? (
            <ThemedText
              themeColor="textSecondary"
              numberOfLines={previewLines}
              ellipsizeMode="tail"
              style={styles.sourcePreview}>
              {excerpt}
            </ThemedText>
          ) : (
            <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
              LaTeX resume
            </ThemedText>
          ))}
      </Animated.View>
    </Pressable>
  );
}

/** A GitHub plugin note: a distinct card that opens the live issues screen. */
function GithubNoteCard({ note }: { note: Note }) {
  const router = useRouter();
  const { toggleNoteFavorite } = useNotes();
  const { active, isSelected, toggle } = useItemSelection();
  const selected = isSelected('note', note.id);
  const surface = useSelectionSurface(selected, 'backgroundElementAlt');

  const target = githubTarget(note);

  const openOrFavorite = useDoubleTap(
    () => router.push({ pathname: '/github/[id]', params: { id: note.id } }),
    () => toggleNoteFavorite(note.id),
  );
  const onSelectToggle = () => toggle({ type: 'note', id: note.id });

  const contextMenuRef = useContextMenu(onSelectToggle);
  const tileHeight = useTileHeight();

  return (
    <Pressable
      ref={contextMenuRef}
      style={({ pressed }) => [styles.cardWrapper, { height: tileHeight }, pressed && styles.pressed]}
      onPress={active ? onSelectToggle : openOrFavorite}
      onLongPress={onSelectToggle}>
      <Animated.View style={[styles.card, surface]}>
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
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cardWrapper: {
    // The surrounding View cell (in each grid screen) is the flex item that
    // sets the column width; this card stretches to that width and takes its
    // explicit per-tile height (applied inline). No `flex: 1` here — inside the
    // height-less cell it would fight the explicit height and make row heights
    // inconsistent. minWidth:0 lets a nowrap title ellipsize instead of pushing
    // the card wider than its column on web.
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
  cardFooter: {
    gap: Spacing.half,
    marginTop: 'auto',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  // LaTeX source excerpt on a resume card — monospace, so it reads as code.
  sourcePreview: {
    fontFamily: Fonts.mono,
    ...SOURCE_PREVIEW,
    minWidth: 0,
  },
  titleText: {
    flexShrink: 1,
    // Allow the nowrap title to ellipsize within the narrowed cell instead of
    // forcing the card wider than its column (web min-content floor).
    minWidth: 0,
  },
});
