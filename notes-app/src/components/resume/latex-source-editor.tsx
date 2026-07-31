/**
 * The LaTeX source editor: a plain monospace text field.
 *
 * Deliberately not the app's rich-text editor. A resume body is source code —
 * every backslash, brace and blank line matters — so nothing here autocorrects,
 * autocapitalizes, or reformats what was typed or pasted in.
 *
 * Like every other editor in the app it registers a dismiss callback while it's
 * focused, so the floating navbar's create button becomes the "done" check and
 * returns the screen to its read view — here, the compiled preview. See
 * `lib/active-editor.ts` and `markdown-editor.web.tsx`, which does the same.
 */
import { useEffect, type RefObject } from 'react';
import { StyleSheet, TextInput } from 'react-native';

import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { setActiveEditorDismiss } from '@/lib/active-editor';
import type { ScrollOffsetEvent } from '@/hooks/use-scrolled';
import { hideScrollbar, noFocusOutline } from '@/lib/web-style';

export function LatexSourceEditor({
  value,
  onChangeText,
  inputRef,
  onFocusChange,
  onScroll,
  bottomInset = 0,
}: {
  value: string;
  onChangeText: (text: string) => void;
  /** Lets the screen focus the editor when the user taps the preview to edit. */
  inputRef: RefObject<TextInput | null>;
  /**
   * Focus changes. Losing focus is what ends an edit — the navbar's check, a tap
   * on the title, a tap elsewhere all arrive here as a blur, exactly as they do
   * for a note's body. Registering the dismiss callback below is what makes the
   * navbar offer that check in the first place; the callback only has to blur,
   * because the blur is what the screen actually listens to.
   */
  onFocusChange: (focused: boolean) => void;
  /**
   * Source scroll position, so the screen can fade the text into the header the
   * way the preview does. Multiline fields emit this on native, and
   * react-native-web forwards it to the textarea.
   */
  onScroll?: (event: ScrollOffsetEvent) => void;
  /**
   * Room below the last line for the floating navbar and toolbar.
   *
   * Padding *inside* the field, not around it. The field itself runs to the
   * bottom of the window and the glass bars float over it — the arrangement
   * every other scrolling surface in the app uses to meet the navbar. Insetting
   * the container instead ends the editor in mid-air above the bars, which is
   * what this replaced.
   *
   * A textarea's scroll height includes its padding, so the last line still
   * scrolls up clear of the bars rather than being stranded underneath them.
   */
  bottomInset?: number;
}) {
  const theme = useTheme();

  // A screen change while focused would otherwise leave the navbar stuck
  // showing a check for an editor that no longer exists.
  useEffect(() => () => setActiveEditorDismiss(null), []);

  return (
    <TextInput
      ref={inputRef}
      value={value}
      onChangeText={onChangeText}
      onFocus={() => {
        setActiveEditorDismiss(() => inputRef.current?.blur());
        onFocusChange(true);
      }}
      onBlur={() => {
        setActiveEditorDismiss(null);
        onFocusChange(false);
      }}
      placeholder={'Paste your LaTeX resume here…'}
      placeholderTextColor={theme.textSecondary}
      style={[
        styles.input,
        noFocusOutline,
        // The source scrolls, but a bar down its edge would cut into the glass
        // toolbar floating over it and there is nothing here worth a scroll
        // position indicator — it's one field, not a feed.
        hideScrollbar,
        { color: theme.text },
        bottomInset > 0 && { paddingBottom: Spacing.three + bottomInset },
      ]}
      // No `scrollEventThrottle`: it isn't a TextInput prop. A source file is
      // short enough that the default rate costs nothing.
      onScroll={onScroll}
      multiline
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="off"
      spellCheck={false}
      // iOS would otherwise turn a straight quote into a curly one, which TeX
      // reads as a different character entirely.
      keyboardType="ascii-capable"
    />
  );
}

const styles = StyleSheet.create({
  input: {
    flex: 1,
    fontFamily: Fonts.mono,
    fontSize: 13,
    lineHeight: 20,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    // Source lines are long; let them run rather than reflow mid-command.
    textAlignVertical: 'top',
  },
});
