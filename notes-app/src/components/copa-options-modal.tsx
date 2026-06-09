import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import type { ComponentProps, ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  Keyboard,
  Pressable,
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
import { useCopa } from '@/store/copa-store';

type FeatherName = ComponentProps<typeof Feather>['name'];

type CopaOptionsContextValue = {
  /** Opens the long-press options sheet for a copy block. */
  openOptions: (id: string) => void;
};

const CopaOptionsContext = createContext<CopaOptionsContextValue | null>(null);

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const DESTRUCTIVE = '#e5484d';

/**
 * Hosts the single long-press options sheet shared by every copy block, mounted
 * once near the root so it stacks above the navbar. A card opens it through
 * `useCopaOptions().openOptions(id)`. Renaming surfaces an inline dialog from
 * the same host so it can sit centred above the dismissed sheet.
 */
export function CopaOptionsProvider({ children }: { children: ReactNode }) {
  const { getCopa, deleteCopa } = useCopa();
  const [targetId, setTargetId] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const openOptions = useCallback((id: string) => setTargetId(id), []);
  const closeOptions = useCallback(() => setTargetId(null), []);
  const openRename = useCallback((id: string) => {
    setTargetId(null);
    setRenameId(id);
  }, []);
  const closeRename = useCallback(() => setRenameId(null), []);
  const openDelete = useCallback((id: string) => {
    setTargetId(null);
    setDeleteId(id);
  }, []);
  const closeDelete = useCallback(() => setDeleteId(null), []);
  const confirmDelete = useCallback(() => {
    if (deleteId) deleteCopa(deleteId);
    setDeleteId(null);
  }, [deleteId, deleteCopa]);

  const value = useMemo<CopaOptionsContextValue>(() => ({ openOptions }), [openOptions]);

  const deleteLabel = deleteId ? getCopa(deleteId)?.label : undefined;

  return (
    <CopaOptionsContext.Provider value={value}>
      {children}
      <OptionsSheet
        targetId={targetId}
        onClose={closeOptions}
        onRename={openRename}
        onDelete={openDelete}
      />
      <RenameDialog targetId={renameId} onClose={closeRename} />
      <ConfirmDialog
        open={deleteId !== null}
        title="Delete copy block?"
        message={
          deleteLabel
            ? `“${deleteLabel}” will be permanently deleted.`
            : 'This copy block will be permanently deleted.'
        }
        onConfirm={confirmDelete}
        onCancel={closeDelete}
      />
    </CopaOptionsContext.Provider>
  );
}

export function useCopaOptions(): CopaOptionsContextValue {
  const ctx = useContext(CopaOptionsContext);
  if (!ctx) throw new Error('useCopaOptions must be used within a CopaOptionsProvider');
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
 * Bottom action sheet for a long-pressed copy block. Always mounted; the inner
 * content mounts on an active target so the slide/fade transitions can play out
 * on dismiss. Mirrors the note/folder options sheet pattern.
 */
function OptionsSheet({
  targetId,
  onClose,
  onRename,
  onDelete,
}: {
  targetId: string | null;
  onClose: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const colors = Colors[scheme];
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { getCopa, toggleFavorite } = useCopa();

  const open = targetId !== null;
  const item = targetId ? getCopa(targetId) : undefined;
  const favorited = item?.favorite ?? false;

  const options: Option[] = [
    { key: 'favorite', label: favorited ? 'Unfavorite' : 'Favorite', icon: 'star' },
    { key: 'rename', label: 'Rename', icon: 'edit-3' },
    { key: 'edit', label: 'Edit', icon: 'edit-2' },
    { key: 'share', label: 'Share', icon: 'share' },
    { key: 'delete', label: 'Delete', icon: 'trash-2', destructive: true },
  ];

  const onSelect = async (option: Option) => {
    if (!targetId) return;
    switch (option.key) {
      case 'favorite':
        toggleFavorite(targetId);
        onClose();
        break;
      case 'rename':
        onRename(targetId);
        break;
      case 'edit':
        onClose();
        router.push({ pathname: '/copa/[id]', params: { id: targetId } });
        break;
      case 'share':
        onClose();
        if (item?.content) await Share.share({ message: item.content });
        break;
      case 'delete':
        onDelete(targetId);
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
                      color={filled ? '#f5a623' : tint}
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
 * Centred dialog for renaming a copy block's label. Seeds its field from the
 * stored label each time it opens and commits on save.
 */
function RenameDialog({ targetId, onClose }: { targetId: string | null; onClose: () => void }) {
  const colors = Colors[useColorScheme() === 'dark' ? 'dark' : 'light'];
  const { getCopa, updateCopa } = useCopa();
  const [value, setValue] = useState('');

  const open = targetId !== null;

  // Seed the field from the stored label whenever a new target opens the dialog.
  const seedFor = useState<string | null>(null);
  const [seededId, setSeededId] = seedFor;
  if (open && seededId !== targetId) {
    setValue(getCopa(targetId)?.label ?? '');
    setSeededId(targetId);
  } else if (!open && seededId !== null) {
    setSeededId(null);
  }

  const onSave = () => {
    if (targetId) updateCopa(targetId, { label: value.trim() });
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
                <ThemedText style={styles.dialogTitle}>Rename</ThemedText>
                <TextInput
                  value={value}
                  onChangeText={setValue}
                  placeholder="Label"
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
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
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
