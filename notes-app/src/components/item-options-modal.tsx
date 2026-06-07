import Feather from '@expo/vector-icons/Feather';
import type { ComponentProps, ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Pressable, StyleSheet, useColorScheme, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { Colors, Spacing } from '@/constants/theme';

type FeatherName = ComponentProps<typeof Feather>['name'];

/** What the open options sheet is acting on. */
type OptionsTarget = { type: 'note' | 'folder'; id: string };

type ItemOptionsContextValue = {
  /** Opens the options sheet for a note or folder. */
  openOptions: (target: OptionsTarget) => void;
};

const ItemOptionsContext = createContext<ItemOptionsContextValue | null>(null);

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Hosts the single long-press options sheet shared by every note and folder
 * card. Mounted once near the root so the sheet stacks above the navbar; any
 * card opens it through `useItemOptions().openOptions(...)`.
 */
export function ItemOptionsProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<OptionsTarget | null>(null);

  const openOptions = useCallback((next: OptionsTarget) => setTarget(next), []);
  const close = useCallback(() => setTarget(null), []);

  const value = useMemo<ItemOptionsContextValue>(() => ({ openOptions }), [openOptions]);

  return (
    <ItemOptionsContext.Provider value={value}>
      {children}
      <OptionsSheet target={target} onClose={close} />
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

// The available actions. Behaviour is wired up later; for now each only closes.
const OPTIONS: Option[] = [
  { key: 'favorite', label: 'Favorite', icon: 'star' },
  { key: 'rename', label: 'Rename', icon: 'edit-3' },
  { key: 'move', label: 'Move to folder', icon: 'move' },
  { key: 'share', label: 'Share', icon: 'share' },
  { key: 'delete', label: 'Delete', icon: 'trash-2', destructive: true },
];

const DESTRUCTIVE = '#e5484d';

/**
 * Bottom action sheet for a long-pressed note/folder. Always mounted; the inner
 * content mounts on an active `target` so the slide/fade transitions can play
 * out on dismiss. Mirrors the right sidebar's always-mounted overlay pattern.
 */
function OptionsSheet({ target, onClose }: { target: OptionsTarget | null; onClose: () => void }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const colors = Colors[scheme];
  const insets = useSafeAreaInsets();

  const open = target !== null;

  const onSelect = (_option: Option) => {
    // Functionality lands later; for now selecting an option just dismisses.
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
            accessibilityLabel="Dismiss options"
          />

          <Animated.View
            entering={SlideInDown.duration(260)}
            exiting={SlideOutDown.duration(220)}
            style={[styles.sheetHost, { paddingBottom: insets.bottom + Spacing.three }]}>
            <GlassSurface intensity={75} tintOpacity={0.85} style={styles.sheet}>
              {OPTIONS.map((option) => {
                const tint = option.destructive ? DESTRUCTIVE : colors.text;
                return (
                  <Pressable
                    key={option.key}
                    onPress={() => onSelect(option)}
                    accessibilityRole="button"
                    accessibilityLabel={option.label}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                    <Feather name={option.icon} size={20} color={tint} style={styles.rowIcon} />
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
});
