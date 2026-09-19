import Feather from '@expo/vector-icons/Feather';
import type { ComponentProps, ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ColorPicker } from '@/components/color-picker';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { Accent, hexToRgba, Spacing } from '@/constants/theme';
import { readableTextColor } from '@/lib/color-contrast';
import { FOLDER_SWATCHES, folderColor } from '@/lib/folder-color';
import { useKeyboardPadding } from '@/hooks/use-keyboard-inset';
import { useTheme } from '@/hooks/use-theme';
import {
  openGithubIssueForIssue,
} from '@/lib/issue-github';
import { pushOrQueue, queueGithubPush } from '@/lib/github-outbox';
import { parseTypeConfig, projectConfig, serializeTypeConfig, type AttrDef } from '@/lib/project';
import { isResumeNote } from '@/lib/resume-note';
import { folderConfigWithMaster, folderMasterResumeId } from '@/lib/resume-master';
import { useIssues } from '@/store/issues-store';
import { invalidMoveTargets } from '@/lib/folder-tree';
import { useNotes } from '@/store/notes-store';
import { noScrollbar } from '@/lib/scroll-style';

type FeatherName = ComponentProps<typeof Feather>['name'];

/**
 * One card the open options sheet is acting on. `issuetype` is a task-manager
 * issue type (a note with `pluginType='issuetype'`) — surfaced separately so the
 * sheet can offer type-specific actions and delete can cascade to its issues.
 */
type OptionsTarget = { type: 'note' | 'folder' | 'issuetype'; id: string };

type ItemOptionsContextValue = {
  /** Opens the options sheet for one or more notes/folders (bulk selection). */
  openOptions: (targets: OptionsTarget[]) => void;
};

const ItemOptionsContext = createContext<ItemOptionsContextValue | null>(null);

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const DESTRUCTIVE = '#e5484d';
const FAVORITE = '#f5a623';
const GITHUB_ACCENT = '#8250df';

/**
 * The move sheet's tint, shared by its glass and by the fade over its list.
 *
 * One constant because the two have to agree: the fade ends on the same colour
 * the sheet already is, so it dissolves into the surface. Let them drift and the
 * fade stops reading as "the list continues" and starts reading as a band drawn
 * across the bottom of it.
 */
const SHEET_TINT_OPACITY = 0.85;

/** How much of the list's last row the fade covers. */
const MOVE_FADE_HEIGHT = 40;

/**
 * The custom swatch's spectrum. It stands for "any colour", so it stays a fixed
 * rainbow rather than a themed surface; the glyph on it sits at the centre of
 * the diagonal, which is the middle stop.
 */
const CUSTOM_SWATCH_STOPS = ['#ff4d4d', '#ffd84d', '#4dff88', '#4dc3ff', '#b84dff'] as const;
const CUSTOM_SWATCH_MID = CUSTOM_SWATCH_STOPS[2];

/**
 * The colour dialog's tint, shared by its glass and the fade over its body for
 * the same reason the move sheet shares one: the fade has to end on the colour
 * the dialog already is, or it reads as a band rather than "there's more below".
 */
const COLOR_DIALOG_TINT_OPACITY = 0.9;

/**
 * Hosts the single long-press options sheet shared by every note and folder
 * card. Mounted once near the root so the sheet stacks above the navbar; any
 * card opens it through `useItemOptions().openOptions(...)`. Rename and move
 * surface their own dialogs from the same host.
 */
export function ItemOptionsProvider({ children }: { children: ReactNode }) {
  const { getNote, getFolder, deleteNote, deleteFolder } = useNotes();
  const [targets, setTargets] = useState<OptionsTarget[]>([]);
  const [renameTarget, setRenameTarget] = useState<OptionsTarget | null>(null);
  const [moveTargets, setMoveTargets] = useState<OptionsTarget[] | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<OptionsTarget[] | null>(null);
  const [colorTargets, setColorTargets] = useState<OptionsTarget[] | null>(null);

  const openOptions = useCallback((next: OptionsTarget[]) => {
    if (next.length > 0) setTargets(next);
  }, []);
  const closeOptions = useCallback(() => setTargets([]), []);
  const openRename = useCallback((next: OptionsTarget) => {
    setTargets([]);
    setRenameTarget(next);
  }, []);
  const openMove = useCallback((next: OptionsTarget[]) => {
    setTargets([]);
    setMoveTargets(next);
  }, []);
  const openDelete = useCallback((next: OptionsTarget[]) => {
    setTargets([]);
    setDeleteTargets(next);
  }, []);
  const openColor = useCallback((next: OptionsTarget[]) => {
    setTargets([]);
    setColorTargets(next);
  }, []);

  const confirmDelete = useCallback(() => {
    deleteTargets?.forEach((t) => {
      if (t.type === 'folder') {
        deleteFolder(t.id);
        return;
      }
      // A note's rows in the side tables — an issue type's issues, a finance
      // note's sheet, a resume's history — go down inside deleteNote itself, in
      // the same transaction and stamped with the note's own deleted_at. That
      // stamp is what lets a restore bring them back, so they must not be
      // tombstoned separately here first.
      deleteNote(t.id);
    });
    setDeleteTargets(null);
  }, [deleteTargets, deleteNote, deleteFolder]);

  const value = useMemo<ItemOptionsContextValue>(() => ({ openOptions }), [openOptions]);

  // Delete-confirmation copy: name the single item, else count them.
  const deleteCount = deleteTargets?.length ?? 0;
  const single = deleteTargets?.[0];
  const singleIsFolder = single?.type === 'folder';
  const singleIsIssueType = single?.type === 'issuetype';
  // Issue types are notes too, so their name lives on the note's title.
  const singleName = single
    ? singleIsFolder
      ? getFolder(single.id)?.name
      : getNote(single.id)?.title
    : undefined;
  const anyFolders = deleteTargets?.some((t) => t.type === 'folder') ?? false;
  const deleteTitle =
    deleteCount > 1
      ? `Delete ${deleteCount} items?`
      : singleIsIssueType
        ? 'Delete issue type?'
        : singleIsFolder
          ? 'Delete folder?'
          : 'Delete note?';
  const deleteMessage =
    deleteCount > 1
      ? `${deleteCount} items${anyFolders ? ' (and any folder contents)' : ''} will be moved to the Trash.`
      : singleIsIssueType
        ? `${singleName ? `“${singleName}”` : 'This issue type'} and every issue filed under it will be removed.`
        : singleIsFolder
          ? `${singleName ? `“${singleName}”` : 'This folder'} and its notes will be moved to the Trash.`
          : singleName
            ? `“${singleName}” will be moved to the Trash.`
            : 'This note will be moved to the Trash.';

  return (
    <ItemOptionsContext.Provider value={value}>
      {children}
      <OptionsSheet
        targets={targets}
        onClose={closeOptions}
        onRename={openRename}
        onMove={openMove}
        onColor={openColor}
        onDelete={openDelete}
      />
      <RenameDialog target={renameTarget} onClose={() => setRenameTarget(null)} />
      <MoveSheet targets={moveTargets} onClose={() => setMoveTargets(null)} />
      <FolderColorDialog targets={colorTargets} onClose={() => setColorTargets(null)} />
      <ConfirmDialog
        open={deleteCount > 0}
        title={deleteTitle}
        message={deleteMessage}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTargets(null)}
      />
    </ItemOptionsContext.Provider>
  );
}

export function useItemOptions(): ItemOptionsContextValue {
  const ctx = useContext(ItemOptionsContext);
  if (!ctx) throw new Error('useItemOptions must be used within an ItemOptionsProvider');
  return ctx;
}

type Option = {
  key: string;
  label: string;
  icon: FeatherName;
  /** Renders in a destructive (red) treatment. */
  destructive?: boolean;
};

/**
 * Bottom action sheet for the selected note(s)/folder(s). Always mounted; the
 * inner content mounts while `targets` is non-empty so the slide/fade
 * transitions can play out on dismiss. Options adapt to the selection: rename is
 * single-only, move applies when every item is a note or a folder, and
 * favorite/share/delete act on the whole set.
 */
function OptionsSheet({
  targets,
  onClose,
  onRename,
  onMove,
  onColor,
  onDelete,
}: {
  targets: OptionsTarget[];
  onClose: () => void;
  onRename: (target: OptionsTarget) => void;
  onMove: (targets: OptionsTarget[]) => void;
  onColor: (targets: OptionsTarget[]) => void;
  onDelete: (targets: OptionsTarget[]) => void;
}) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const {
    getNote,
    getFolder,
    getNotesInFolder,
    updateNote,
    updateFolder,
    toggleNoteFavorite,
    toggleFolderFavorite,
    markNoteShared,
  } = useNotes();
  const { getIssuesForNote, updateIssue } = useIssues();

  const count = targets.length;
  const open = count > 0;
  const single = count === 1;
  const suffix = single ? '' : ` ${count}`;
  const anyIssueType = targets.some((t) => t.type === 'issuetype');
  // Notes and folders both move; an issue type does not — it belongs to its
  // project's tracker, not to a place in the folder tree — so one in the
  // selection withdraws the option for the whole set rather than moving some of
  // it and silently leaving the rest.
  const allMovable = count > 0 && targets.every((t) => t.type === 'note' || t.type === 'folder');
  // Colour is a folder's alone — a note card has no tab to paint.
  const allFolders = count > 0 && targets.every((t) => t.type === 'folder');
  const isFavorited = (t: OptionsTarget) =>
    (t.type === 'folder' ? getFolder(t.id)?.favorite : getNote(t.id)?.favorite) ?? false;
  const allFavorited = count > 0 && targets.every(isFavorited);

  // A single selected issue type: derive its project's repo + attributes and its
  // current GitHub-tracking state so we can offer (and apply) the toggle.
  const issueType = single && targets[0].type === 'issuetype' ? getNote(targets[0].id) : undefined;
  const project = issueType?.folderId ? getFolder(issueType.folderId) : undefined;
  const projectCfg = project ? projectConfig(project) : null;
  const typeRepo = projectCfg?.repo;
  const typeConnected = issueType ? parseTypeConfig(issueType.pluginConfig).githubConnected : false;

  // A single selected resume that lives in a folder: it can be that folder's
  // master — the superset the folder's other resumes are tailored from.
  //
  // Offered only inside a folder, because the pointer lives on the folder row
  // and the home screen has no row to hold one. A resume at the top level still
  // tailors, it just tailors from itself, which is what every resume did before
  // masters existed.
  const resumeNote =
    single && targets[0].type === 'note' ? getNote(targets[0].id) : undefined;
  const resumeFolder =
    resumeNote && isResumeNote(resumeNote) && resumeNote.folderId
      ? getFolder(resumeNote.folderId)
      : undefined;
  const isMaster =
    !!resumeFolder && !!resumeNote && folderMasterResumeId(resumeFolder) === resumeNote.id;

  // Open GitHub issues for every issue under a newly-connected type that was
  // never pushed (ghNumber == null). Best-effort; one alert if any fail.
  const backfillType = async (
    typeId: string,
    typeName: string,
    repo: string,
    attributes: AttrDef[],
  ) => {
    const pending = getIssuesForNote(typeId).filter((i) => i.ghNumber == null);
    if (pending.length === 0) return;
    // Sequential on purpose. This fired one request per issue in parallel,
    // which with no connection meant a few hundred doomed requests at once and
    // as many racing enqueues. Now the first held-back push ends the run and the
    // remainder is queued without being attempted at all.
    let failure: string | null = null;
    for (let i = 0; i < pending.length; i += 1) {
      const issue = pending[i];
      const r = await pushOrQueue({
        issueId: issue.id,
        repo,
        facets: { details: true },
        push: async () => {
          const number = await openGithubIssueForIssue(repo, typeName, attributes, issue);
          updateIssue(issue.id, { ghNumber: number });
        },
      });
      if (r.status === 'queued') {
        for (const rest of pending.slice(i + 1)) {
          await queueGithubPush(rest.id, repo, { details: true });
        }
        return;
      }
      if (r.status === 'failed' && !failure) failure = r.message;
    }
    if (failure) Alert.alert('Some issues weren’t opened on GitHub', failure);
  };

  const options: Option[] = [
    // Favorite/share are note/folder concepts; issue types opt out of both.
    ...(!anyIssueType
      ? [{ key: 'favorite', label: `${allFavorited ? 'Unfavorite' : 'Favorite'}${suffix}`, icon: 'star' as FeatherName }]
      : []),
    ...(single ? [{ key: 'rename', label: 'Rename', icon: 'edit-3' as FeatherName }] : []),
    ...(allFolders ? [{ key: 'color', label: `Color${suffix}`, icon: 'droplet' as FeatherName }] : []),
    ...(issueType && typeRepo
      ? [{ key: 'github', label: typeConnected ? 'Stop tracking on GitHub' : 'Track with GitHub', icon: 'github' as FeatherName }]
      : []),
    ...(resumeFolder
      ? [
          {
            key: 'master',
            label: isMaster ? 'Stop using as master resume' : 'Use as master resume',
            icon: 'award' as FeatherName,
          },
        ]
      : []),
    ...(allMovable ? [{ key: 'move', label: `Move${suffix} to folder`, icon: 'move' as FeatherName }] : []),
    ...(!anyIssueType ? [{ key: 'share', label: `Share${suffix}`, icon: 'share' as FeatherName }] : []),
    { key: 'delete', label: `Delete${suffix}`, icon: 'trash-2', destructive: true },
  ];

  const onSelect = async (option: Option) => {
    if (count === 0) return;
    switch (option.key) {
      case 'github': {
        if (!issueType) break;
        const prev = parseTypeConfig(issueType.pluginConfig);
        const next = !prev.githubConnected;
        updateNote(issueType.id, {
          pluginConfig: serializeTypeConfig({ ...prev, githubConnected: next }),
        });
        onClose();
        // Turning tracking on backfills the type's not-yet-pushed issues.
        if (next && typeRepo && projectCfg) {
          void backfillType(issueType.id, issueType.title, typeRepo, projectCfg.attributes);
        }
        break;
      }
      case 'master': {
        if (!resumeFolder || !resumeNote) break;
        // Written through `folderConfigWithMaster` rather than as a fresh object:
        // this folder's config may hold a whole project schema, and rebuilding it
        // around one key is how the rest of it disappears.
        updateFolder(resumeFolder.id, {
          config: folderConfigWithMaster(resumeFolder, isMaster ? null : resumeNote.id),
        });
        onClose();
        break;
      }
      case 'favorite': {
        // Set every item to the same state (favorite unless all already are),
        // toggling only those that differ so mixed selections end up uniform.
        const next = !allFavorited;
        targets.forEach((t) => {
          if (isFavorited(t) === next) return;
          if (t.type === 'note') toggleNoteFavorite(t.id);
          else toggleFolderFavorite(t.id);
        });
        onClose();
        break;
      }
      case 'rename':
        onRename(targets[0]);
        break;
      case 'move':
        onMove(targets);
        break;
      case 'color':
        onColor(targets);
        break;
      case 'share': {
        onClose();
        const parts = targets.map((t) => {
          if (t.type === 'note') {
            const note = getNote(t.id);
            if (!note) return '';
            markNoteShared(note.id);
            return `${note.title}\n\n${note.body}`.trim();
          }
          const folder = getFolder(t.id);
          if (!folder) return '';
          const titles = getNotesInFolder(folder.id)
            .map((n) => `• ${n.title || 'Untitled'}`)
            .join('\n');
          return `${folder.name}\n${titles}`.trim();
        });
        const message = parts.filter(Boolean).join('\n\n———\n\n');
        if (message) {
          const first = targets[0];
          const title = !single
            ? `${count} items`
            : first.type === 'note'
              ? getNote(first.id)?.title || 'Note'
              : getFolder(first.id)?.name || 'Folder';
          await Share.share({ title, message });
        }
        break;
      }
      case 'delete':
        onDelete(targets);
        break;
    }
  };

  return (
    <View style={styles.overlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.backdrop}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Dismiss options"
          />

          <Animated.View
            entering={SlideInDown.duration(260)}
            exiting={SlideOutDown.duration(220)}
            style={[styles.sheetHost, { paddingBottom: insets.bottom + Spacing.three }]}>
            <GlassSurface intensity={75} tintOpacity={0.85} style={styles.sheet}>
              {options.map((option) => {
                const tint = option.destructive
                  ? DESTRUCTIVE
                  : option.key === 'github'
                    ? GITHUB_ACCENT
                    : colors.text;
                const filled = option.key === 'favorite' && allFavorited;
                return (
                  <Pressable
                    key={option.key}
                    onPress={() => onSelect(option)}
                    accessibilityRole="button"
                    accessibilityLabel={option.label}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                    <Feather
                      name={option.icon}
                      size={20}
                      color={filled ? FAVORITE : tint}
                      style={styles.rowIcon}
                    />
                    <ThemedText style={[styles.rowLabel, { color: tint }]}>{option.label}</ThemedText>
                  </Pressable>
                );
              })}
            </GlassSurface>
          </Animated.View>
        </>
      )}
    </View>
  );
}

/**
 * Centred dialog for renaming a note's title or a folder's name. Seeds its
 * field from the stored value each time a new target opens it.
 */
function RenameDialog({ target, onClose }: { target: OptionsTarget | null; onClose: () => void }) {
  const colors = useTheme();
  const { getNote, getFolder, updateNote, updateFolder } = useNotes();
  const [value, setValue] = useState('');
  const [seededId, setSeededId] = useState<string | null>(null);

  const open = target !== null;
  // Folders rename their `name`; notes and issue types rename the note `title`.
  const isFolder = target?.type === 'folder';
  const dialogTitle =
    target?.type === 'issuetype' ? 'Rename issue type' : isFolder ? 'Rename folder' : 'Rename note';
  const placeholder =
    target?.type === 'issuetype' ? 'Type name' : isFolder ? 'Folder name' : 'Title';

  // Seed the field from the stored value whenever a new target opens the dialog.
  if (open && seededId !== target.id) {
    const current = isFolder ? getFolder(target.id)?.name : getNote(target.id)?.title;
    setValue(current ?? '');
    setSeededId(target.id);
  } else if (!open && seededId !== null) {
    setSeededId(null);
  }

  const onSave = () => {
    if (target) {
      if (isFolder) updateFolder(target.id, { name: value.trim() });
      else updateNote(target.id, { title: value.trim() });
    }
    Keyboard.dismiss();
    onClose();
  };

  const onCancel = () => {
    Keyboard.dismiss();
    onClose();
  };

  return (
    <View style={styles.overlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.backdrop}
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel rename"
          />

          <View style={styles.dialogHost} pointerEvents="box-none">
            <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(140)}>
              <GlassSurface intensity={75} tintOpacity={0.9} style={styles.dialog}>
                <ThemedText style={styles.dialogTitle}>{dialogTitle}</ThemedText>
                <TextInput
                  value={value}
                  onChangeText={setValue}
                  placeholder={placeholder}
                  placeholderTextColor={colors.textSecondary}
                  autoFocus
                  selectTextOnFocus
                  returnKeyType="done"
                  onSubmitEditing={onSave}
                  style={[
                    styles.input,
                    { color: colors.text, backgroundColor: colors.backgroundElement },
                  ]}
                />
                <View style={styles.dialogActions}>
                  <Pressable
                    onPress={onCancel}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel"
                    style={({ pressed }) => [styles.dialogButton, pressed && styles.pressed]}>
                    <ThemedText style={[styles.dialogButtonText, { color: colors.textSecondary }]}>
                      Cancel
                    </ThemedText>
                  </Pressable>
                  <Pressable
                    onPress={onSave}
                    accessibilityRole="button"
                    accessibilityLabel="Save"
                    style={({ pressed }) => [
                      styles.dialogButton,
                      styles.dialogButtonPrimary,
                      { backgroundColor: colors.backgroundSelected },
                      pressed && styles.pressed,
                    ]}>
                    <ThemedText style={[styles.dialogButtonText, { color: colors.text }]}>
                      Save
                    </ThemedText>
                  </Pressable>
                </View>
              </GlassSurface>
            </Animated.View>
          </View>
        </>
      )}
    </View>
  );
}

/**
 * Centred dialog for colouring the selected folder(s): the theme default, one of
 * the basic swatches, or a custom colour from the picker. Seeds from the colour
 * the folders share, and opens straight onto the picker when that colour isn't
 * one of the swatches — otherwise the current choice would have nothing marked.
 * Nothing is written until Save, so dragging around the picker doesn't churn a
 * sync write per frame.
 */
function FolderColorDialog({
  targets,
  onClose,
}: {
  targets: OptionsTarget[] | null;
  onClose: () => void;
}) {
  const colors = useTheme();
  const { getFolder, updateFolder } = useNotes();
  const items = targets ?? [];
  const open = items.length > 0;
  const key = items.map((t) => t.id).join(',');
  const [seededKey, setSeededKey] = useState<string | null>(null);
  /** The picked colour; null is the theme default. */
  const [draft, setDraft] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  /** The selected folders don't already agree on a colour. */
  const [mixed, setMixed] = useState(false);
  /** The person has chosen something since the dialog opened. */
  const [picked, setPicked] = useState(false);

  if (open && seededKey !== key) {
    const current = new Set(
      items.map((t) => {
        const folder = getFolder(t.id);
        return folder ? folderColor(folder) : null;
      }),
    );
    const agreed = current.size === 1;
    const shared = agreed ? [...current][0] : null;
    setDraft(shared);
    setMixed(!agreed);
    setPicked(false);
    setCustom(!!shared && !FOLDER_SWATCHES.some((s) => s.hex === shared));
    setSeededKey(key);
  } else if (!open && seededKey !== null) {
    setSeededKey(null);
  }

  // A mixed selection has no colour to show as current, and `null` can't stand
  // in for one: it already means "the theme", so seeding it would check the
  // theme swatch — an assertion that is false — and a trusting Save would then
  // clear colours the person never touched, on every device, with no undo. So
  // nothing is marked and Save does nothing until they actually pick. The move
  // sheet answers a mixed selection the same way, with no marked destination.
  const asserted = !mixed || picked;
  const pick = (color: string | null) => {
    setDraft(color);
    setPicked(true);
  };

  const isSwatch = FOLDER_SWATCHES.some((s) => s.hex === draft);
  const onSave = () => {
    if (!asserted) return;
    items.forEach((t) => {
      const folder = getFolder(t.id);
      // Writing a colour a folder already has still bumps `updated_at`, which
      // floats it to the front of the grid and syncs a row for nothing.
      if (folder && folderColor(folder) === draft) return;
      updateFolder(t.id, { color: draft });
    });
    Keyboard.dismiss();
    onClose();
  };
  const onCancel = () => {
    Keyboard.dismiss();
    onClose();
  };

  const keyboardPad = useKeyboardPadding();
  // Whether anything is left below the fold, measured rather than counted: the
  // picker is only mounted while `custom` is open, and row heights move with the
  // font scale.
  const [more, setMore] = useState(false);
  const viewportH = useRef(0);
  const contentH = useRef(0);
  const scrollY = useRef(0);
  const recomputeMore = () =>
    setMore(contentH.current - viewportH.current - scrollY.current > 1);

  return (
    <View style={styles.overlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.backdrop}
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel color"
          />

          {/* The host carries the keyboard inset rather than the dialog: padding
              shrinks the box the dialog is centred in, so with the hex field
              focused the dialog re-centres in what's left instead of sitting
              under the keyboard. `KeyboardAvoidingView` is no use here — under
              edge-to-edge Android the IME is drawn over a window that never
              resizes (see `use-keyboard-inset`). */}
          <Animated.View style={[styles.dialogHost, keyboardPad]} pointerEvents="box-none">
            <Animated.View
              entering={FadeIn.duration(180)}
              exiting={FadeOut.duration(140)}
              style={styles.dialogShrink}>
              <GlassSurface
                intensity={75}
                tintOpacity={COLOR_DIALOG_TINT_OPACITY}
                style={[styles.dialog, styles.colorDialog]}>
                <ThemedText style={styles.dialogTitle}>
                  {items.length > 1 ? `Color ${items.length} folders` : 'Folder color'}
                </ThemedText>

                <View style={styles.colorBodyWrap}>
                  <ScrollView
                    {...noScrollbar}
                    style={styles.colorBody}
                    contentContainerStyle={styles.colorBodyContent}
                    bounces={false}
                    scrollEventThrottle={16}
                    onLayout={(e) => {
                      viewportH.current = e.nativeEvent.layout.height;
                      recomputeMore();
                    }}
                    onContentSizeChange={(_w, h) => {
                      contentH.current = h;
                      recomputeMore();
                    }}
                    onScroll={(e) => {
                      scrollY.current = e.nativeEvent.contentOffset.y;
                      recomputeMore();
                    }}>
                    <View style={styles.swatches}>
                      <Pressable
                        onPress={() => {
                          pick(null);
                          setCustom(false);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Theme color"
                        accessibilityState={{
                          selected: asserted && draft === null,
                        }}
                        style={({ pressed }) => [
                          styles.swatch,
                          styles.themeSwatch,
                          {
                            backgroundColor: colors.backgroundElement,
                            borderColor: colors.backgroundSelected,
                          },
                          pressed && styles.pressed,
                        ]}>
                        <Feather
                          name={asserted && draft === null ? 'check' : 'slash'}
                          size={18}
                          color={asserted && draft === null ? colors.text : colors.textSecondary}
                        />
                      </Pressable>
                      {FOLDER_SWATCHES.map((swatch) => {
                        const selected = asserted && draft === swatch.hex;
                        return (
                          <Pressable
                            key={swatch.hex}
                            onPress={() => {
                              pick(swatch.hex);
                              setCustom(false);
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={swatch.name}
                            accessibilityState={{ selected }}
                            style={({ pressed }) => [
                              styles.swatch,
                              { backgroundColor: swatch.hex },
                              pressed && styles.pressed,
                            ]}>
                            {/* Derived, not white: white on the yellow swatch
                                is ~1.8:1 and effectively invisible. */}
                            {selected && (
                              <Feather
                                name="check"
                                size={18}
                                color={readableTextColor(swatch.hex)}
                              />
                            )}
                          </Pressable>
                        );
                      })}
                      <Pressable
                        onPress={() => setCustom((c) => !c)}
                        accessibilityRole="button"
                        accessibilityLabel="Custom color"
                        accessibilityState={{
                          expanded: custom,
                          selected: asserted && draft !== null && !isSwatch,
                        }}
                        style={({ pressed }) => [styles.swatch, pressed && styles.pressed]}>
                        <LinearGradient
                          pointerEvents="none"
                          colors={CUSTOM_SWATCH_STOPS}
                          start={{ x: 0, y: 0 }}
                          end={{ x: 1, y: 1 }}
                          style={styles.customSwatchFill}
                        />
                        <Feather
                          name={asserted && draft !== null && !isSwatch ? 'check' : 'plus'}
                          size={18}
                          color={readableTextColor(CUSTOM_SWATCH_MID)}
                        />
                      </Pressable>
                    </View>

                    {custom && (
                      <Animated.View
                        entering={FadeIn.duration(180)}
                        exiting={FadeOut.duration(120)}>
                        <ColorPicker value={draft ?? Accent} onChange={pick} />
                      </Animated.View>
                    )}
                  </ScrollView>
                  {/* Same promise the move sheet makes: with no scrollbar on
                      either platform, a capped body would otherwise end in a
                      hard cut that reads as the end of the dialog. Only while
                      something is actually below. */}
                  {more && (
                    <LinearGradient
                      pointerEvents="none"
                      colors={[
                        hexToRgba(colors.backgroundElement, 0),
                        hexToRgba(colors.backgroundElement, COLOR_DIALOG_TINT_OPACITY),
                      ]}
                      style={styles.colorBodyFade}
                    />
                  )}
                </View>

                <View style={styles.dialogActions}>
                  <Pressable
                    onPress={onCancel}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel"
                    style={({ pressed }) => [styles.dialogButton, pressed && styles.pressed]}>
                    <ThemedText style={[styles.dialogButtonText, { color: colors.textSecondary }]}>
                      Cancel
                    </ThemedText>
                  </Pressable>
                  <Pressable
                    onPress={onSave}
                    accessibilityRole="button"
                    accessibilityLabel="Save"
                    accessibilityState={{ disabled: !asserted }}
                    style={({ pressed }) => [
                      styles.dialogButton,
                      styles.dialogButtonPrimary,
                      { backgroundColor: colors.backgroundSelected },
                      !asserted && styles.dialogButtonIdle,
                      pressed && styles.pressed,
                    ]}>
                    <ThemedText style={[styles.dialogButtonText, { color: colors.text }]}>
                      Save
                    </ThemedText>
                  </Pressable>
                </View>
              </GlassSurface>
            </Animated.View>
          </Animated.View>
        </>
      )}
    </View>
  );
}

/**
 * Bottom sheet listing every folder (plus the home screen) as a destination for
 * the selected notes and folders. A destination is marked only when every moved
 * item already shares it; tapping a row moves them all there.
 *
 * A folder being moved, and everything inside it, is left off the list — a
 * folder can't be filed inside itself, and offering the row would be offering to
 * lose the subtree (see `lib/folder-tree.ts`). They're omitted rather than shown
 * disabled: the sheet answers "where does this go", and a place it can never go
 * is not an answer worth the row.
 */
function MoveSheet({ targets, onClose }: { targets: OptionsTarget[] | null; onClose: () => void }) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const { folders, getNote, getFolder, moveNote, moveFolder } = useNotes();

  const items = targets ?? [];
  const open = items.length > 0;
  const movingFolderIds = items.filter((t) => t.type === 'folder').map((t) => t.id);
  // Where each item lives now: a note's folder, a folder's parent. One common
  // answer earns the checkmark; a mixed selection gets none. `null` is a real
  // value here (Home), which is why this compares against `undefined`.
  const currentIds = new Set(
    items.map((t) =>
      t.type === 'folder' ? (getFolder(t.id)?.parentId ?? null) : (getNote(t.id)?.folderId ?? null),
    ),
  );
  const commonFolderId = currentIds.size === 1 ? [...currentIds][0] : undefined;

  const blocked = invalidMoveTargets(folders, movingFolderIds);
  const destinations: { id: string | null; name: string; icon: FeatherName }[] = [
    { id: null, name: 'Home', icon: 'home' },
    ...folders
      .filter((f) => !blocked.has(f.id))
      .map((f) => ({ id: f.id, name: f.name || 'Untitled folder', icon: 'folder' as FeatherName })),
  ];

  const onPick = (folderId: string | null) => {
    items.forEach((t) => {
      if (t.type === 'folder') moveFolder(t.id, folderId);
      else moveNote(t.id, folderId);
    });
    onClose();
  };

  // Whether anything is still below the fold, which is what decides if the fade
  // is telling the truth. Measured rather than counted: a row's height depends
  // on the font scale, so "more than N folders" would be wrong on somebody's
  // phone. Scroll position counts too — at the end of the list there is nothing
  // left to promise, and a fade that stayed would just dim the last folder.
  const [more, setMore] = useState(false);
  const viewportH = useRef(0);
  const contentH = useRef(0);
  const scrollY = useRef(0);
  const recomputeMore = () =>
    setMore(contentH.current - viewportH.current - scrollY.current > 1);

  return (
    <View style={styles.overlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.backdrop}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel move"
          />

          <Animated.View
            entering={SlideInDown.duration(260)}
            exiting={SlideOutDown.duration(220)}
            style={[styles.sheetHost, { paddingBottom: insets.bottom + Spacing.three }]}>
            <GlassSurface intensity={75} tintOpacity={SHEET_TINT_OPACITY} style={styles.sheet}>
              <ThemedText style={styles.sheetTitle}>
                {items.length > 1 ? `Move ${items.length} items to…` : 'Move to…'}
              </ThemedText>
              <View style={styles.moveListWrap}>
                <ScrollView
                  {...noScrollbar}
                  style={styles.moveList}
                  bounces={false}
                  scrollEventThrottle={16}
                  onLayout={(e) => {
                    viewportH.current = e.nativeEvent.layout.height;
                    recomputeMore();
                  }}
                  onContentSizeChange={(_w, h) => {
                    contentH.current = h;
                    recomputeMore();
                  }}
                  onScroll={(e) => {
                    scrollY.current = e.nativeEvent.contentOffset.y;
                    recomputeMore();
                  }}>
                  {destinations.map((dest) => {
                    const selected = dest.id === commonFolderId;
                    return (
                      <Pressable
                        key={dest.id ?? 'home'}
                        onPress={() => onPick(dest.id)}
                        accessibilityRole="button"
                        accessibilityLabel={dest.name}
                        style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                        <Feather name={dest.icon} size={20} color={colors.text} style={styles.rowIcon} />
                        <ThemedText style={[styles.rowLabel, { color: colors.text }]} numberOfLines={1}>
                          {dest.name}
                        </ThemedText>
                        {selected && (
                          <Feather name="check" size={20} color={colors.textSecondary} style={styles.rowCheck} />
                        )}
                      </Pressable>
                    );
                  })}
                </ScrollView>
                {/* The list is capped at `maxHeight`, and with the scrollbar gone
                    on both platforms a long folder list would end in a hard cut
                    that reads as the last folder. The fade says it continues.
                    Only while it actually does — over a list that fits, or one
                    scrolled to its end, it would dim the last folder for
                    nothing. */}
                {more && (
                  <LinearGradient
                    pointerEvents="none"
                    colors={[
                      hexToRgba(colors.backgroundElement, 0),
                      hexToRgba(colors.backgroundElement, SHEET_TINT_OPACITY),
                    ]}
                    style={styles.moveListFade}
                  />
                )}
              </View>
            </GlassSurface>
          </Animated.View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheetHost: {
    width: '100%',
    paddingHorizontal: Spacing.three,
    // Full-width bottom sheet on mobile; capped and centred on wide web windows.
    ...(Platform.OS === 'web' ? { maxWidth: 360, alignSelf: 'center' as const } : null),
  },
  sheet: {
    overflow: 'hidden',
    borderRadius: Spacing.four,
    padding: Spacing.two,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 24,
  },
  sheetTitle: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    opacity: 0.6,
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.one,
  },
  // Holds the list and the fade sitting over its bottom edge, so the cap now
  // lands here — the ScrollView fills it and the fade overlays it.
  moveListWrap: {
    maxHeight: 280,
  },
  moveList: {
    flexGrow: 0,
    flexShrink: 1,
  },
  moveListFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: MOVE_FADE_HEIGHT,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.three,
  },
  rowIcon: {
    width: 24,
    textAlign: 'center',
  },
  rowLabel: {
    flex: 1,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
  },
  rowCheck: {
    marginLeft: 'auto',
  },
  pressed: {
    opacity: 0.55,
  },
  dialogHost: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  dialog: {
    width: '100%',
    maxWidth: 360,
    overflow: 'hidden',
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.three,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 24,
  },
  dialogTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  // The colour dialog is the one that can outgrow a short screen — the custom
  // picker roughly doubles its height, and the keyboard takes what's left. It
  // shrinks instead of centring past the edges, which is what would put Save
  // out of reach.
  dialogShrink: {
    width: '100%',
    maxWidth: 360,
    flexShrink: 1,
  },
  colorDialog: {
    flexShrink: 1,
  },
  colorBodyWrap: {
    flexShrink: 1,
  },
  colorBody: {
    flexGrow: 0,
    flexShrink: 1,
  },
  colorBodyContent: {
    gap: Spacing.three,
  },
  colorBodyFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: MOVE_FADE_HEIGHT,
  },
  dialogButtonIdle: {
    opacity: 0.4,
  },
  // Positioned, so the glass tint (absolute, and so painted above static
  // in-flow content) doesn't wash out the field and everything typed into it.
  // See `components/glass-surface.tsx`.
  input: {
    position: 'relative',
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    fontSize: 16,
  },
  swatches: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  swatch: {
    width: 40,
    height: 40,
    borderRadius: Spacing.three,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  themeSwatch: {
    borderWidth: 1,
  },
  customSwatchFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  dialogActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.two,
  },
  dialogButton: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
  },
  dialogButtonPrimary: {
    minWidth: 80,
    alignItems: 'center',
  },
  dialogButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});
