import { useEffect, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { Pressable, StyleSheet, TextInput } from 'react-native';
import type { EnrichedTextInputInstance, OnChangeStateEvent } from 'react-native-enriched';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { setActiveEditorDismiss } from '@/lib/active-editor';
import {
  htmlToMarkdown,
  markdownToHtml,
  markdownToViewHtml,
  toggleTaskAt,
} from '@/lib/markdown';
import { noFocusOutline } from '@/lib/web-style';

/** Tall starting height so there's room to write before the field grows. */
const MIN_HEIGHT = 360;

type Props = {
  /** Initial body as HTML (uncontrolled — pass `key={id}` to reseed). */
  value: string;
  /** Fires with the current body as HTML on every change. */
  onChangeText: (html: string) => void;
  placeholder?: string;
  /** Accepted for API parity with the native editor; unused on web. */
  editorRef?: RefObject<EnrichedTextInputInstance | null>;
  /** Reports edit/view so the screen can adjust padding while editing. */
  onFocusChange?: (focused: boolean) => void;
  /** Accepted for API parity with the native editor; unused on web. */
  onStateChange?: (state: OnChangeStateEvent) => void;
};

/**
 * Web counterpart of the native rich `MarkdownEditor`. The body is stored as the
 * rich editor's HTML everywhere; on web it's edited as plain markdown.
 *
 * Two modes, mirroring the native always-on WYSIWYG split:
 *  - View (default): the body rendered as formatted HTML, read-only. Tapping it
 *    enters edit mode.
 *  - Edit: a markdown textarea seeded from the stored HTML; every change is
 *    converted back to HTML so a web-edited note still renders in the native
 *    rich editor. Blurring (tap away) returns to the rendered view.
 *
 * Pass `key={id}` on the parent so the field reseeds between notes.
 */
export function MarkdownEditor({ value, onChangeText, placeholder, onFocusChange }: Props) {
  const theme = useTheme();
  // Seed once from the stored HTML; the parent updates `value` continuously for
  // persistence, so reseeding on every render would clobber the caret.
  const [text, setText] = useState(() => htmlToMarkdown(value));
  const [editing, setEditing] = useState(false);
  // Grow the field to fit its content (instead of scrolling inside a fixed box),
  // so the whole note is visible and the page scroll handles overflow.
  const [height, setHeight] = useState(MIN_HEIGHT);

  // Register with the active-editor bridge while editing so the navbar's "done"
  // check (web has no keyboard to track) can return us to the rendered view —
  // mirroring how the native editor exposes a blur.
  useEffect(() => {
    if (!editing) return;
    setActiveEditorDismiss(() => {
      setEditing(false);
      onFocusChange?.(false);
    });
    return () => setActiveEditorDismiss(null);
  }, [editing, onFocusChange]);

  // ---- View mode: rendered, read-only; tap to edit. ----
  if (!editing) {
    const html = markdownToViewHtml(text);
    // Toggle a checkbox in place instead of entering edit mode. Map the clicked
    // box to its source-order index among all checkboxes, flip that task item,
    // and persist — the re-render reflects the new checked state.
    const onViewClick = (e: ReactMouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
      e.preventDefault();
      e.stopPropagation();
      const boxes = Array.from(
        e.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      );
      const index = boxes.indexOf(target);
      if (index < 0) return;
      const next = toggleTaskAt(text, index);
      setText(next);
      onChangeText(markdownToHtml(next));
    };
    return (
      <Pressable
        onPress={() => {
          setEditing(true);
          onFocusChange?.(true);
        }}
        accessibilityRole="button"
        accessibilityLabel="Edit"
        style={styles.view}>
        {html ? (
          <div
            className="md-view"
            onClick={onViewClick}
            style={{ color: theme.text, fontSize: 16, lineHeight: 1.5 }}
            // Body HTML is the user's own local content; rendering it is the point.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <ThemedText themeColor="textSecondary" style={styles.placeholder}>
            {placeholder}
          </ThemedText>
        )}
      </Pressable>
    );
  }

  // ---- Edit mode: raw markdown textarea, auto-focused; blur/Esc returns to view. ----
  const exitEdit = () => {
    setEditing(false);
    onFocusChange?.(false);
  };

  return (
    <TextInput
      value={text}
      onChangeText={(next) => {
        setText(next);
        onChangeText(markdownToHtml(next));
      }}
      placeholder={placeholder}
      placeholderTextColor={theme.textSecondary}
      multiline
      autoFocus
      autoCapitalize="sentences"
      onContentSizeChange={(e) =>
        setHeight(Math.max(MIN_HEIGHT, e.nativeEvent.contentSize.height))
      }
      // Esc leaves edit mode (the field unmounts back to the rendered view).
      onKeyPress={(e) => {
        if (e.nativeEvent.key === 'Escape') exitEdit();
      }}
      style={[styles.input, noFocusOutline, { color: theme.text, height }]}
      onBlur={exitEdit}
    />
  );
}

const styles = StyleSheet.create({
  view: {
    minHeight: MIN_HEIGHT,
  },
  placeholder: {
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'left',
  },
  // Matches the native editor's base text style (constants/theme editorStyle).
  input: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '500',
    textAlign: 'left',
  },
});
