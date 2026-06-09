import Feather from '@expo/vector-icons/Feather';
import type { ComponentProps, ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  Keyboard,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { Colors, Spacing } from '@/constants/theme';
import { useNotes } from '@/store/notes-store';

type FeatherName = ComponentProps<typeof Feather>['name'];

/** What the open options sheet is acting on. */
type OptionsTarget = { type: 'note' | 'folder'; id: string };

type ItemOptionsContextValue = {
  /** Opens the options sheet for a note or folder. */
  openOptions: (target: OptionsTarget) => void;
};

const ItemOptionsContext = createContext<ItemOptionsContextValue | null>(null);

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const DESTRUCTIVE = '#e5484d';
const FAVORITE = '#f5a623';

/**
 * Hosts the single long-press options sheet shared by every note and folder
 * card. Mounted once near the root so the sheet stacks above the navbar; any
 * card opens it through `useItemOptions().openOptions(...)`. Rename and move
 * surface their own dialogs from the same host.
 */
export function ItemOptionsProvider({ children }: { children: ReactNode }) {
  const { getNote, getFolder, deleteNote, deleteFolder } = useNotes();
  const [target, setTarget] = useState<OptionsTarget | null>(null);
  const [renameTarget, setRenameTarget] = useState<OptionsTarget | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OptionsTarget | null>(null);

  const openOptions = useCallback((next: OptionsTarget) => setTarget(next), []);
  const closeOptions = useCallback(() => setTarget(null), []);
  const openRename = useCallback((next: OptionsTarget) => {
    setTarget(null);
    setRenameTarget(next);
  }, []);
  const openMove = useCallback((id: string) => {
    setTarget(null);
    setMoveTarget(id);
  }, []);
  const openDelete = useCallback((next: OptionsTarget) => {
    setTarget(null);
    setDeleteTarget(next);
  }, []);
  const confirmDelete = useCallback(() => {
    if (deleteTarget) {
      if (deleteTarget.type === 'note') deleteNote(deleteTarget.id);
      else deleteFolder(deleteTarget.id);
    }
    setDeleteTarget(null);
  }, [deleteTarget, deleteNote, deleteFolder]);

  const value = useMemo<ItemOptionsContextValue>(() => ({ openOptions }), [openOptions]);

  const isNote = deleteTarget?.type === 'note';
  const deleteName = deleteTarget
    ? isNote
      ? getNote(deleteTarget.id)?.title
      : getFolder(deleteTarget.id)?.name
    : undefined;

  return (
    <ItemOptionsContext.Provider value={value}>
      {children}
      <OptionsSheet
        target={target}
        onClose={closeOptions}
        onRename={openRename}
        onMove={openMove}
        onDelete={openDelete}
      />
      <RenameDialog target={renameTarget} onClose={() => setRenameTarget(null)} />
      <MoveSheet noteId={moveTarget} onClose={() => setMoveTarget(null)} />
      <ConfirmDialog
        open={deleteTarget !== null}
        title={isNote ? 'Delete note?' : 'Delete folder?'}
        message={
          isNote
            ? deleteName
              ? `“${deleteName}” will be moved to the Trash.`
              : 'This note will be moved to the Trash.'
            : `${
                deleteName ? `“${deleteName}”` : 'This folder'
              } and its notes will be moved to the Trash.`
        }
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
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
 * Bottom action sheet for a long-pressed note/folder. Always mounted; the inner
 * content mounts on an active `target` so the slide/fade transitions can play
 * out on dismiss. Mirrors the right sidebar's always-mounted overlay pattern.
 */
function OptionsSheet({
  target,
  onClose,
  onRename,
  onMove,
  onDelete,
}: {
  target: OptionsTarget | null;
  onClose: () => void;
  onRename: (target: OptionsTarget) => void;
  onMove: (id: string) => void;
  onDelete: (target: OptionsTarget) => void;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const colors = Colors[scheme];
  const insets = useSafeAreaInsets();
  const {
    getNote,
    getFolder,
    getNotesInFolder,
    toggleNoteFavorite,
    toggleFolderFavorite,
    markNoteShared,
  } = useNotes();

  const open = target !== null;
  const isNote = target?.type === 'note';
  const note = target && isNote ? getNote(target.id) : undefined;
  const folder = target && !isNote ? getFolder(target.id) : undefined;
  const favorited = (isNote ? note?.favorite : folder?.favorite) ?? false;

  // Folders are flat (only notes carry a folderId), so "move" applies to notes.
  const options: Option[] = [
    { key: 'favorite', label: favorited ? 'Unfavorite' : 'Favorite', icon: 'star' },
    { key: 'rename', label: 'Rename', icon: 'edit-3' },
    ...(isNote ? [{ key: 'move', label: 'Move to folder', icon: 'move' as FeatherName }] : []),
    { key: 'share', label: 'Share', icon: 'share' },
    { key: 'delete', label: 'Delete', icon: 'trash-2', destructive: true },
  ];

  const onSelect = async (option: Option) => {
    if (!target) return;
    switch (option.key) {
      case 'favorite':
        if (isNote) toggleNoteFavorite(target.id);
        else toggleFolderFavorite(target.id);
        onClose();
        break;
      case 'rename':
        onRename(target);
        break;
      case 'move':
        onMove(target.id);
        break;
      case 'share':
        onClose();
        if (isNote && note) {
          // Record it on the Shared screen, then offer the OS share sheet.
          markNoteShared(note.id);
          await Share.share({ title: note.title || 'Note', message: `${note.title}\n\n${note.body}`.trim() });
        } else if (folder) {
          const titles = getNotesInFolder(folder.id)
            .map((n) => `• ${n.title || 'Untitled'}`)
            .join('\n');
          await Share.share({
            title: folder.name || 'Folder',
            message: `${folder.name}\n${titles}`.trim(),
          });
        }
        break;
      case 'delete':
        onDelete(target);
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
                const tint = option.destructive ? DESTRUCTIVE : colors.text;
                const filled = option.key === 'favorite' && favorited;
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
  const colors = Colors[useColorScheme() === 'dark' ? 'dark' : 'light'];
  const { getNote, getFolder, updateNote, updateFolder } = useNotes();
  const [value, setValue] = useState('');
  const [seededId, setSeededId] = useState<string | null>(null);

  const open = target !== null;
  const isNote = target?.type === 'note';

  // Seed the field from the stored value whenever a new target opens the dialog.
  if (open && seededId !== target.id) {
    const current = isNote ? getNote(target.id)?.title : getFolder(target.id)?.name;
    setValue(current ?? '');
    setSeededId(target.id);
  } else if (!open && seededId !== null) {
    setSeededId(null);
  }

  const onSave = () => {
    if (target) {
      if (isNote) updateNote(target.id, { title: value.trim() });
      else updateFolder(target.id, { name: value.trim() });
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
                <ThemedText style={styles.dialogTitle}>
                  {isNote ? 'Rename note' : 'Rename folder'}
                </ThemedText>
                <TextInput
                  value={value}
                  onChangeText={setValue}
                  placeholder={isNote ? 'Title' : 'Folder name'}
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
 * Bottom sheet listing every folder (plus the home screen) as a destination for
 * a note. The note's current location is marked and tapping a row moves it.
 */
function MoveSheet({ noteId, onClose }: { noteId: string | null; onClose: () => void }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const colors = Colors[scheme];
  const insets = useSafeAreaInsets();
  const { folders, getNote, moveNote } = useNotes();

  const open = noteId !== null;
  const note = noteId ? getNote(noteId) : undefined;
  const currentFolderId = note?.folderId ?? null;

  const destinations: { id: string | null; name: string; icon: FeatherName }[] = [
    { id: null, name: 'Home', icon: 'home' },
    ...folders.map((f) => ({ id: f.id, name: f.name || 'Untitled folder', icon: 'folder' as FeatherName })),
  ];

  const onPick = (folderId: string | null) => {
    if (noteId) moveNote(noteId, folderId);
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
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel move"
          />

          <Animated.View
            entering={SlideInDown.duration(260)}
            exiting={SlideOutDown.duration(220)}
            style={[styles.sheetHost, { paddingBottom: insets.bottom + Spacing.three }]}>
            <GlassSurface intensity={75} tintOpacity={0.85} style={styles.sheet}>
              <ThemedText style={styles.sheetTitle}>Move to…</ThemedText>
              <ScrollView style={styles.moveList} bounces={false}>
                {destinations.map((dest) => {
                  const selected = dest.id === currentFolderId;
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
    paddingHorizontal: Spacing.three,
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
  moveList: {
    maxHeight: 280,
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
  input: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    fontSize: 16,
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
