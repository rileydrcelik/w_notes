import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { ComponentProps, RefObject } from 'react';
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
import type { EnrichedTextInputInstance, OnChangeStateEvent } from 'react-native-enriched';

import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { editLinkInActiveEditor, insertImageIntoActiveEditor } from '@/lib/active-editor';

/** Active/highlight tint, matching the focused tab in the floating navbar. */
const ACCENT = '#7a89b8';
/** Fixed bar height so the long-press flyout can anchor above it. */
const BAR_HEIGHT = 48;
/** Gap between the bar and the top of the keyboard. */
const KEYBOARD_GAP = Spacing.two;

type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];
type StateKey = keyof OnChangeStateEvent;
type Editor = EnrichedTextInputInstance;

type InlineTool = { icon: IconName; key: StateKey; run: (e: Editor) => void };

// Inline text formatting — the everyday styles, each a direct toggle.
const INLINE_TOOLS: InlineTool[] = [
  { icon: 'format-bold', key: 'bold', run: (e) => e.toggleBold() },
  { icon: 'format-italic', key: 'italic', run: (e) => e.toggleItalic() },
  { icon: 'format-underline', key: 'underline', run: (e) => e.toggleUnderline() },
  { icon: 'format-strikethrough-variant', key: 'strikeThrough', run: (e) => e.toggleStrikeThrough() },
];

type ListType = 'unorderedList' | 'orderedList' | 'checkboxList';
type ListOption = { key: ListType; icon: IconName; label: string; run: (e: Editor) => void };

// The engine supports exactly these list kinds (no alphabetical lists).
const LIST_OPTIONS: ListOption[] = [
  { key: 'unorderedList', icon: 'format-list-bulleted', label: 'Bullets', run: (e) => e.toggleUnorderedList() },
  { key: 'orderedList', icon: 'format-list-numbered', label: 'Numbered', run: (e) => e.toggleOrderedList() },
  { key: 'checkboxList', icon: 'format-list-checks', label: 'Checklist', run: (e) => e.toggleCheckboxList(false) },
];

type Props = {
  editorRef: RefObject<Editor | null>;
  /** Latest style state from the editor; null until the first event. */
  state: OnChangeStateEvent | null;
  /** Shown only while the editor is focused. */
  visible: boolean;
};

/**
 * Glassmorphic formatting bar that floats above the keyboard while the body
 * editor is focused. Scoped to what round-trips to markdown: inline text styles
 * plus a single grouped list control — tap applies the last-used list kind,
 * long-press opens a flyout to switch between bullets, numbered and checklist.
 * Rides just above the keyboard (via the IME inset) so it appears as the
 * keyboard opens — Android runs edge-to-edge, so the keyboard doesn't resize
 * the window and the bar must track the inset itself.
 */
export function FormattingToolbar({ editorRef, state, visible }: Props) {
  const theme = useTheme();
  const { height } = useWindowDimensions();
  const keyboard = useAnimatedKeyboard();
  const followKeyboard = useAnimatedStyle(() => ({
    transform: [{ translateY: -(keyboard.height.value + KEYBOARD_GAP) }],
  }));
  const [lastList, setLastList] = useState<ListType>('unorderedList');
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the flyout when the toolbar transitions to hidden (editor blurs), so
  // it isn't still open the next time the editor is focused. Adjusting state
  // during render on a changed prop is React's recommended alternative to an
  // effect here.
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (!visible) setMenuOpen(false);
  }

  if (!visible) return null;

  const run = (fn: (e: Editor) => void) => {
    const editor = editorRef.current;
    if (editor) fn(editor);
  };

  // The list active in the current paragraph (if any) wins over the last choice,
  // so the grouped button always mirrors what's under the caret.
  const activeList = LIST_OPTIONS.find((o) => state?.[o.key]?.isActive) ?? null;
  const shownList = activeList ?? LIST_OPTIONS.find((o) => o.key === lastList) ?? LIST_OPTIONS[0];

  const linkActive = !!state?.link?.isActive;
  const linkBlocked = !!state?.link?.isBlocking;

  const onListPress = () => {
    setMenuOpen(false);
    run(shownList.run);
    if (!activeList) setLastList(shownList.key);
  };

  const chooseList = (option: ListOption) => {
    setMenuOpen(false);
    setLastList(option.key);
    run(option.run);
  };

  return (
    <Animated.View
      entering={FadeIn.duration(150)}
      exiting={FadeOut.duration(120)}
      pointerEvents="box-none"
      style={[styles.host, followKeyboard]}>
      {/* Tap-away catcher while the flyout is open. */}
      {menuOpen && <Pressable style={[styles.backdrop, { height }]} onPress={() => setMenuOpen(false)} />}

      <View style={styles.cluster}>
        {menuOpen && (
          <Animated.View
            entering={FadeInUp.springify().damping(18).stiffness(220).mass(0.6)}
            exiting={FadeOutDown.duration(140)}
            style={styles.menuAnchor}>
            <GlassSurface intensity={75} tintOpacity={0.7} style={styles.menu}>
              {LIST_OPTIONS.map((option) => {
                const active = option.key === shownList.key && !!activeList;
                return (
                  <Pressable
                    key={option.key}
                    accessibilityRole="button"
                    onPress={() => chooseList(option)}
                    style={styles.menuItem}>
                    <MaterialCommunityIcons
                      name={option.icon}
                      size={20}
                      color={active ? ACCENT : theme.text}
                    />
                    <ThemedText type="small" style={{ color: active ? ACCENT : theme.text }}>
                      {option.label}
                    </ThemedText>
                  </Pressable>
                );
              })}
            </GlassSurface>
          </Animated.View>
        )}

        <GlassSurface intensity={75} tintOpacity={0.6} style={styles.bar}>
          {INLINE_TOOLS.map((tool) => {
            const s = state?.[tool.key];
            const active = !!s?.isActive;
            const blocked = !!s?.isBlocking;
            return (
              <Pressable
                key={tool.key}
                accessibilityRole="button"
                disabled={blocked}
                onPress={() => run(tool.run)}
                style={[styles.button, active && styles.buttonActive]}>
                <MaterialCommunityIcons
                  name={tool.icon}
                  size={22}
                  color={active ? ACCENT : theme.text}
                  style={blocked ? styles.blocked : undefined}
                />
              </Pressable>
            );
          })}

          {/* Add, edit or remove a link. Lit while the caret is in one, like
              the toggles beside it, but a press opens the link dialog rather
              than toggling — a link needs an address. The focused editor owns
              the selection, so it runs the action (`lib/active-editor.ts`). */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={linkActive ? 'Edit link' : 'Add link'}
            disabled={linkBlocked}
            onPress={() => editLinkInActiveEditor()}
            style={[styles.button, linkActive && styles.buttonActive]}>
            <MaterialCommunityIcons
              name="link-variant"
              size={22}
              color={linkActive ? ACCENT : theme.text}
              style={linkBlocked ? styles.blocked : undefined}
            />
          </Pressable>

          <View style={[styles.divider, { backgroundColor: hexToRgba(theme.textSecondary, 0.3) }]} />

          {/* Insert a picture. Not one of INLINE_TOOLS: those are toggles the
              editor reports a state for, while this opens a picker and has no
              on/off of its own. The editor that has focus performs it — see
              `lib/active-editor.ts`. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Insert image"
            onPress={() => insertImageIntoActiveEditor()}
            style={styles.button}>
            <MaterialCommunityIcons name="image-plus-outline" size={22} color={theme.text} />
          </Pressable>

          <View style={[styles.divider, { backgroundColor: hexToRgba(theme.textSecondary, 0.3) }]} />

          {/* Grouped list control: tap = last used, long-press = choose a kind. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="List style (hold for options)"
            onPress={onListPress}
            onLongPress={() => setMenuOpen(true)}
            delayLongPress={220}
            style={[styles.button, styles.listButton, !!activeList && styles.buttonActive]}>
            <MaterialCommunityIcons
              name={shownList.icon}
              size={22}
              color={activeList ? ACCENT : theme.text}
            />
            <MaterialCommunityIcons name="chevron-up" size={11} color={theme.textSecondary} />
          </Pressable>
        </GlassSurface>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    bottom: 0,
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
  // Hugs the bar's width so the flyout can anchor to the list button's side.
  cluster: {
    position: 'relative',
  },
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
  // 40, the app's icon-button size: at 44 the bar outgrew a 360dp phone once
  // the link button joined it.
  button: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.two,
  },
  listButton: {
    width: 48,
    flexDirection: 'row',
    gap: 1,
  },
  buttonActive: {
    backgroundColor: hexToRgba(ACCENT, 0.18),
  },
  blocked: {
    opacity: 0.35,
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
    borderRadius: Spacing.three,
    paddingVertical: Spacing.one,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
});
