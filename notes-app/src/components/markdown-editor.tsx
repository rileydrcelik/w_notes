import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Keyboard } from 'react-native';
import {
  EnrichedTextInput,
  type EnrichedInputStyle,
  type EnrichedTextInputInstance,
  type HtmlStyle,
  type OnChangeStateEvent,
} from 'react-native-enriched';

import { hexToRgba, type Palette } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { setActiveEditorDismiss } from '@/lib/active-editor';

const LINK_COLOR = '#3c87f7';

/**
 * Block-level theming for the rich editor. Base color/size come from the
 * `style` prop below; this only carries what the per-tag renderers need.
 */
function htmlStyle(theme: Palette): HtmlStyle {
  return {
    h1: { fontSize: 28, bold: true },
    h2: { fontSize: 22, bold: true },
    h3: { fontSize: 18, bold: true },
    blockquote: { borderColor: theme.backgroundSelected, color: theme.textSecondary, gapWidth: 12 },
    codeblock: { color: theme.text, backgroundColor: theme.backgroundElementAlt, borderRadius: 8 },
    code: { color: theme.text, backgroundColor: theme.backgroundElementAlt },
    a: { color: LINK_COLOR, textDecorationLine: 'underline' },
    ol: { markerColor: theme.textSecondary },
    ul: { bulletColor: theme.textSecondary },
    // Smaller than the default 24 (which equals the line height and crowds
    // consecutive items) so checklist rows get vertical breathing room.
    ulCheckbox: { boxColor: theme.textSecondary, boxSize: 18 },
  };
}

function editorStyle(theme: Palette): EnrichedInputStyle {
  return { color: theme.text, fontSize: 16, lineHeight: 24, fontWeight: '500', minHeight: 120 };
}

type Props = {
  /** Initial body as HTML (the editor is uncontrolled — pass `key={id}` to reseed). */
  value: string;
  /** Fires with the current HTML on every change. */
  onChangeText: (html: string) => void;
  placeholder?: string;
  /** Imperative handle so a toolbar can drive formatting commands. */
  editorRef?: RefObject<EnrichedTextInputInstance | null>;
  /** Reports focus so the screen can show/hide the formatting toolbar. */
  onFocusChange?: (focused: boolean) => void;
  /** Reports the active inline/block styles so the toolbar can highlight them. */
  onStateChange?: (state: OnChangeStateEvent) => void;
};

/**
 * Note/copa body — a single always-on rich text field backed by the native
 * `react-native-enriched` editor. It stores HTML (headings, lists, checkboxes,
 * quotes, code render as you type — true WYSIWYG, no raw markdown ever shown).
 * There are no markdown shortcuts in the native editor, so block formatting is
 * applied through the imperative commands exposed via `editorRef` (driven by
 * the FormattingToolbar). Pass `key={id}` so the field reseeds between notes.
 */
export function MarkdownEditor({
  value,
  onChangeText,
  placeholder,
  editorRef,
  onFocusChange,
  onStateChange,
}: Props) {
  const theme = useTheme();
  // Stable across keystrokes — onChangeHtml re-renders this on every change, and
  // re-sending fresh style objects to native each time feeds layout churn.
  const html = useMemo(() => htmlStyle(theme), [theme]);
  const base = useMemo(() => editorStyle(theme), [theme]);
  // Seed once. The native view re-applies `defaultValue` whenever it changes,
  // which would reset the editor's content and caret on every keystroke (the
  // parent updates `value` continuously for persistence). Freeze it via a
  // lazy initial state; `key={id}` on the parent remounts this to reseed when
  // switching notes.
  const [initialValue] = useState(value);
  const [focused, setFocused] = useState(false);

  // The keyboard's "hide" button dismisses the keyboard without blurring this
  // native input, which would leave the editor (and toolbar) in edit mode with
  // no keyboard. While focused, treat a keyboard hide as a request to blur.
  useEffect(() => {
    if (!focused) return;
    const sub = Keyboard.addListener('keyboardDidHide', () => editorRef?.current?.blur());
    return () => sub.remove();
  }, [focused, editorRef]);

  return (
    <EnrichedTextInput
      ref={editorRef}
      defaultValue={initialValue}
      placeholder={placeholder}
      placeholderTextColor={theme.textSecondary}
      cursorColor={theme.text}
      selectionColor={hexToRgba(theme.textSecondary, 0.3)}
      scrollEnabled={false}
      // Run incoming HTML through the library's Gumbo normalizer before applying
      // it. Web-edited bodies arrive as standard HTML (e.g. marked emits
      // `<ul>\n<li>…`, `<strong>`, `<pre>`); without normalization the strict
      // parser rejects those — on iOS it throws and falls back to showing the raw
      // tags as text. The normalizer canonicalizes them into the editor's tag
      // subset (`<ul><li>`, `<b>`, `<codeblock>`, …) so lists & co. render.
      useHtmlNormalizer
      // Android: apply size updates synchronously so a newline (which grows the
      // input) doesn't flicker the layout and bounce the caret back up.
      androidExperimentalSynchronousEvents
      htmlStyle={html}
      style={base}
      onChangeHtml={(e) => onChangeText(e.nativeEvent.value)}
      onChangeState={(e) => onStateChange?.(e.nativeEvent)}
      onFocus={() => {
        // The native editor isn't registered with RN's TextInputState, so the
        // navbar's "done" can't reach it via Keyboard.dismiss(). Expose a blur.
        setActiveEditorDismiss(() => editorRef?.current?.blur());
        setFocused(true);
        onFocusChange?.(true);
      }}
      onBlur={() => {
        setActiveEditorDismiss(null);
        setFocused(false);
        onFocusChange?.(false);
      }}
    />
  );
}
