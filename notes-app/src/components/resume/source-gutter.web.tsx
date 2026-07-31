/**
 * The line-number gutter beside the LaTeX source.
 *
 * A textarea has no gutter of its own, so this is a column of numbers rendered
 * next to one and kept in step with it by hand. Three things have to agree for
 * that to hold, and all three are why the numbers stay glued to their lines:
 *
 * - **The same line box.** `LINE_HEIGHT` and the vertical padding here are the
 *   editor's own, imported rather than copied, so a change to the editor's
 *   metrics can't quietly slide the numbers out of alignment.
 * - **No wrapping.** The editor sets `noWrap`, so one logical line is one row.
 *   With wrapping on there is no number to give a line that occupies two rows,
 *   and every line below it is wrong.
 * - **One scroll position.** The gutter is translated by the textarea's own
 *   `scrollTop`, read from the DOM `scroll` event rather than from React state:
 *   scrolling fires continuously, and a re-render per frame on a long document
 *   is how a smooth scroll turns into a stuttering one.
 *
 * Numbers only — no fold arrows, no error dots, no current-line highlight. The
 * gutter exists so someone can find the line a TeX log is complaining about
 * (`compile-log` gives line numbers and nothing else could resolve them), and
 * anything more would be chrome on a surface the app otherwise keeps bare.
 *
 * See `source-gutter.tsx` for the native counterpart, which renders nothing.
 */
import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { StyleSheet, Text, View, type TextInput } from 'react-native';

import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** Line box shared with the editor. Exported so the editor imports rather than repeats it. */
export const LINE_HEIGHT = 20;
export const FONT_SIZE = 13;

/** Room the gutter takes on the left, by how many digits it has to hold. */
export function gutterWidth(lineCount: number): number {
  const digits = Math.max(2, String(Math.max(lineCount, 1)).length);
  // Monospace at 13px is ~7.8px per character; the padding is the breathing room
  // between the numbers and the code, and matches the editor's own inset.
  return Math.ceil(digits * 7.8) + Spacing.three * 2;
}

export function SourceGutter({
  inputRef,
  text,
  topInset,
}: {
  /** The editor's field. React Native Web hands host refs back as the DOM node. */
  inputRef: RefObject<TextInput | null>;
  /** The source, for its line count. */
  text: string;
  /** The editor's own top padding, so line 1 starts level with the first line. */
  topInset: number;
}) {
  const theme = useTheme();
  const columnRef = useRef<View | null>(null);

  // Splitting a whole document on every keystroke is wasteful; the count only
  // changes when a newline is added or removed.
  const lineCount = useMemo(() => {
    let count = 1;
    for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') count += 1;
    return count;
  }, [text]);

  useEffect(() => {
    const field = inputRef.current as unknown as HTMLTextAreaElement | null;
    if (!field || typeof field.addEventListener !== 'function') return;

    const sync = () => {
      const column = columnRef.current as unknown as HTMLElement | null;
      if (column) column.style.transform = `translateY(${-field.scrollTop}px)`;
    };

    field.addEventListener('scroll', sync);
    // The field can already be scrolled when this mounts — reopening a resume
    // restores its position — so take a reading rather than assuming zero.
    sync();
    return () => field.removeEventListener('scroll', sync);
  }, [inputRef]);

  const numbers = useMemo(
    () => Array.from({ length: lineCount }, (_unused, i) => i + 1),
    [lineCount],
  );

  return (
    <View
      pointerEvents="none"
      style={[styles.host, { width: gutterWidth(lineCount), paddingTop: topInset }]}>
      <View ref={columnRef}>
        {numbers.map((n) => (
          <Text key={n} style={[styles.number, { color: theme.textSecondary }]} selectable={false}>
            {n}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    // Clips the numbers at the top and bottom edges as they scroll past, so they
    // disappear under the header rather than over it.
    overflow: 'hidden',
    // `pointerEvents="none"` above is what matters for clicks; this keeps a
    // drag-select that starts in the gutter from selecting the numbers instead
    // of the code.
    userSelect: 'none',
  },
  number: {
    fontFamily: Fonts.mono,
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    textAlign: 'right',
    paddingRight: Spacing.three,
  },
});
