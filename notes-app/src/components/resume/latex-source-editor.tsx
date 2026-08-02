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
 *
 * The one keyboard shortcut it adds is **Ctrl+/ (Cmd+/) to toggle `%` comments**,
 * which in this plugin is not a debugging convenience: a resume is kept as a
 * superset, and commenting a block out is how experience is moved to the bench
 * that the tailor and the hardener promote from. Web only — see
 * `hooks/use-comment-shortcut.ts`.
 *
 * It also carries a **line-number gutter**, which is web-only for a reason that
 * is really about wrapping: numbers are only correct if one line is one row, and
 * turning wrapping off is worth scrolling sideways on a desktop and not worth
 * it on a phone. `SourceGutter` renders nothing on native and `gutterWidth`
 * returns zero there, so the field lays out exactly as it always has. See
 * `components/resume/source-gutter.tsx`.
 */
import { useEffect, useMemo, type RefObject } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { Fonts, Spacing } from '@/constants/theme';
import {
  FONT_SIZE,
  gutterWidth,
  LINE_HEIGHT,
  SourceGutter,
} from '@/components/resume/source-gutter';
import { useCommentShortcut } from '@/hooks/use-comment-shortcut';
import { useTheme } from '@/hooks/use-theme';
import { setActiveEditorDismiss } from '@/lib/active-editor';
import type { ScrollOffsetEvent } from '@/hooks/use-scrolled';
import { noFocusOutline, noWrap } from '@/lib/web-style';

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

  useCommentShortcut(inputRef, onChangeText);

  // How much room the numbers need — zero on native, where there are none. Read
  // from the same count the gutter renders, so a document crossing from 99 to
  // 100 lines widens the gutter and the text moves with it rather than under it.
  const lineCount = useMemo(() => {
    let count = 1;
    for (let i = 0; i < value.length; i += 1) if (value[i] === '\n') count += 1;
    return count;
  }, [value]);
  const gutter = gutterWidth(lineCount);

  return (
    <View style={styles.host}>
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
          // Source lines run rather than reflow mid-command — and the gutter
          // depends on it, since a wrapped line has one number and two rows. No
          // effect off web, where there is no gutter to keep in step.
          noWrap,
          { color: theme.text },
          // Left inset for the numbers, in place of the shared horizontal one.
          // Zero on native, where `gutterWidth` reports no gutter.
          gutter > 0 && { paddingLeft: gutter },
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
      {/* After the field, so the numbers paint over it rather than under. The
          field is transparent today and they would show through either way, but
          "the gutter is on top" is the arrangement that stays true if it ever
          isn't. It takes no pointer events, so a click in the gutter still lands
          in the text and puts the caret on that line. */}
      <SourceGutter inputRef={inputRef} text={value} topInset={Spacing.three} />
    </View>
  );
}

const styles = StyleSheet.create({
  // The field fills this and the gutter is positioned over its left edge, rather
  // than the two sitting side by side in a row. A row would give the gutter its
  // own scroll container, and then the numbers would have to be scrolled *and*
  // kept in step; over the top there is one scrolling surface and the numbers
  // are simply translated to match it.
  host: {
    flex: 1,
  },
  input: {
    flex: 1,
    fontFamily: Fonts.mono,
    fontSize: FONT_SIZE,
    // Shared with the gutter, which spaces its numbers by exactly this. The two
    // must not drift, so both read it from one place.
    lineHeight: LINE_HEIGHT,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    textAlignVertical: 'top',
  },
});
