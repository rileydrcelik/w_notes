/**
 * Formatting toolbar for the finance grid.
 *
 * Deliberately the same object as the note editor's `FormattingToolbar` — same
 * bar height, radius, glass, shadow, accent, button geometry, flyout pattern
 * and keyboard tracking. Only the controls differ, because a spreadsheet
 * formats whole cells rather than runs of text. Anything visual changed here
 * should be changed there too, or the two editors start to look like different
 * apps.
 *
 * The colour palettes live behind two grouped buttons rather than sitting
 * inline: twelve swatches on the bar forced it to span the screen and scroll,
 * where every other floating control in the app hugs its content. Same trade
 * the note toolbar makes for its list styles.
 *
 * Every control applies to the whole current selection, which is the point of
 * drag-selecting a range: one tap recolours a hundred cells, and because the
 * sheet is a single synced document that costs exactly one row to sync.
 *
 * Formatting lives on the cell, not inside the cell's text. Neither of the
 * app's rich-text editors has colour or highlight marks, and applying an inline
 * span across every cell of a range would mean rewriting each one's HTML — far
 * more fragile than patching a style object.
 */
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { ComponentProps } from 'react';
import { useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeInUp,
  FadeOut,
  FadeOutDown,
  useAnimatedKeyboard,
  useAnimatedStyle,
} from 'react-native-reanimated';

import { GlassSurface } from '@/components/glass-surface';
import { Spacing, hexToRgba } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { selectionHasStyle, type CellStyle, type Selection, type Sheet } from '@/lib/finance/sheet';

/** Matched to the note editor's toolbar so the two read as one component. */
const ACCENT = '#7a89b8';
const BAR_HEIGHT = 48;
const KEYBOARD_GAP = Spacing.two;

/**
 * Highlight swatches. Fixed rather than theme-derived so a sheet looks the same
 * on every device — the grid pairs each with a derived legible ink colour (see
 * `readableTextColor`) instead of relying on the theme's text colour.
 */
const HIGHLIGHTS = ['#FFEF9F', '#C8E6C9', '#BBDEFB', '#F8BBD0', '#E1BEE7'];
/** Text colours, chosen to stay legible on both light and dark backgrounds. */
const TEXT_COLORS = ['#D32F2F', '#F57C00', '#388E3C', '#1976D2', '#7B1FA2'];

type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

const MARKS: { key: 'bold' | 'italic' | 'underline' | 'strike'; icon: IconName }[] = [
  { key: 'bold', icon: 'format-bold' },
  { key: 'italic', icon: 'format-italic' },
  { key: 'underline', icon: 'format-underline' },
  { key: 'strike', icon: 'format-strikethrough-variant' },
];

/** Which colour flyout is open, if any. */
type Palette = 'bg' | 'color';

type Props = {
  sheet: Sheet;
  selection: Selection;
  onApply: (patch: CellStyle) => void;
  /** Strips formatting from the selection. Never touches cell values. */
  onClear: () => void;
};

export function FinanceToolbar({ sheet, selection, onApply, onClear }: Props) {
  const theme = useTheme();
  const { height } = useWindowDimensions();
  const tabBarInset = useTabBarInset();
  const [menu, setMenu] = useState<Palette | null>(null);

  // Rides just above the keyboard, as the note toolbar does: Android is
  // edge-to-edge, so the keyboard doesn't resize the window and the bar has to
  // track the inset itself. The tab-bar inset is the resting offset, so the bar
  // clears the floating navbar instead of sitting under it.
  const keyboard = useAnimatedKeyboard();
  const followKeyboard = useAnimatedStyle(() => ({
    transform: [{ translateY: -(keyboard.height.value + KEYBOARD_GAP) }],
  }));

  const swatches = menu === 'bg' ? HIGHLIGHTS : TEXT_COLORS;

  const choose = (value: string | undefined) => {
    if (!menu) return;
    setMenu(null);
    onApply(menu === 'bg' ? { bg: value } : { color: value });
  };

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.host, { bottom: tabBarInset }, followKeyboard]}>
      {/* Tap-away catcher while a flyout is open. */}
      {menu && (
        <Pressable style={[styles.backdrop, { height }]} onPress={() => setMenu(null)} />
      )}

      <View style={styles.cluster}>
        {menu && (
          <Animated.View
            entering={FadeInUp.springify().damping(18).stiffness(220).mass(0.6)}
            exiting={FadeOutDown.duration(140)}
            style={styles.menuAnchor}>
            <GlassSurface intensity={75} tintOpacity={0.7} style={styles.menu}>
              {swatches.map((value) => (
                <Pressable
                  key={value}
                  accessibilityRole="button"
                  accessibilityLabel={value}
                  onPress={() => choose(value)}
                  style={styles.swatchButton}>
                  {menu === 'bg' ? (
                    <View style={[styles.swatch, { backgroundColor: value }]} />
                  ) : (
                    <MaterialCommunityIcons name="format-color-text" size={22} color={value} />
                  )}
                </Pressable>
              ))}
              {/* Clearing lives in the flyout with the colours it undoes. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="None"
                onPress={() => choose(undefined)}
                style={styles.swatchButton}>
                <MaterialCommunityIcons
                  name="format-color-marker-cancel"
                  size={20}
                  color={theme.textSecondary}
                />
              </Pressable>
            </GlassSurface>
          </Animated.View>
        )}

        <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(120)}>
          <GlassSurface intensity={75} tintOpacity={0.6} style={styles.bar}>
            {MARKS.map(({ key, icon }) => {
              // Active only when *every* selected cell carries it, so the button
              // reads as a true toggle over a mixed range.
              const active = selectionHasStyle(sheet, selection, key);
              return (
                <Pressable
                  key={key}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={key}
                  onPress={() => onApply({ [key]: !active })}
                  style={[styles.button, active && styles.buttonActive]}>
                  <MaterialCommunityIcons name={icon} size={22} color={active ? ACCENT : theme.text} />
                </Pressable>
              );
            })}

            <View style={[styles.divider, { backgroundColor: hexToRgba(theme.textSecondary, 0.3) }]} />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Highlight"
              onPress={() => setMenu((m) => (m === 'bg' ? null : 'bg'))}
              style={[styles.button, menu === 'bg' && styles.buttonActive]}>
              <MaterialCommunityIcons
                name="marker"
                size={22}
                color={menu === 'bg' ? ACCENT : theme.text}
              />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Text colour"
              onPress={() => setMenu((m) => (m === 'color' ? null : 'color'))}
              style={[styles.button, menu === 'color' && styles.buttonActive]}>
              <MaterialCommunityIcons
                name="format-color-text"
                size={22}
                color={menu === 'color' ? ACCENT : theme.text}
              />
            </Pressable>

            <View style={[styles.divider, { backgroundColor: hexToRgba(theme.textSecondary, 0.3) }]} />

            {/* Removes formatting, not content — `format-clear` is the icon
                users already read that way, where an eraser suggests deletion. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear formatting"
              onPress={onClear}
              style={styles.button}>
              <MaterialCommunityIcons name="format-clear" size={22} color={theme.text} />
            </Pressable>
          </GlassSurface>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    alignItems: 'center',
  },
  // Covers the screen above the bar so a tap-away closes the flyout. The
  // negative insets cancel the host's side padding to reach the screen edges.
  backdrop: {
    position: 'absolute',
    bottom: 0,
    left: -Spacing.three,
    right: -Spacing.three,
  },
  // Hugs the bar's width so the flyout can anchor to it.
  cluster: { position: 'relative' },
  bar: {
    height: BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.one,
    borderRadius: Spacing.three,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
  button: {
    width: 44,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.two,
  },
  buttonActive: {
    backgroundColor: hexToRgba(ACCENT, 0.18),
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 24,
    marginHorizontal: Spacing.one,
  },
  menuAnchor: {
    position: 'absolute',
    right: 0,
    bottom: BAR_HEIGHT + Spacing.one,
  },
  menu: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.one,
    paddingVertical: Spacing.one,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
  swatchButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.two,
  },
  swatch: { width: 22, height: 22, borderRadius: 7 },
});
