import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
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
import { hasEscapedBlockMarkup } from '@/lib/html-text';
import { Sentry } from '@/lib/sentry';

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
  /**
   * Reports where the caret is, so a screen that owns the scrolling can keep it
   * on screen. `atEnd` is the part worth acting on: the editor doesn't scroll
   * itself (`scrollEnabled={false}`), and the library exposes character offsets
   * but no caret coordinates, so "is the caret at the end of the text" is the
   * one position that can be turned into a scroll target without guessing.
   */
  onSelectionChange?: (selection: { start: number; end: number; atEnd: boolean }) => void;
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
  onSelectionChange,
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

  /**
   * The body is seeded through `setValue`, not through `defaultValue`.
   *
   * The native view measures a `defaultValue` down a different path from the one
   * that measures typing, and that path parses the HTML *without* the normalizer
   * the view itself renders with. So exactly the markup the normalizer exists to
   * canonicalize — a list pasted from another app, `<ul data-type="checkbox">`,
   * `<li checked>` — measures as a single line however many items it holds. The
   * editor is then laid out at its `minHeight` while drawing the whole document,
   * and a 35-item checklist becomes six visible rows with the rest scrolling
   * inside that little box: the bug this exists to avoid.
   *
   * Seeding imperatively puts the content through the same path a keystroke
   * takes, which measures what is actually rendered. It costs one frame of empty
   * editor, which is invisible next to the note screen's own transition.
   */
  // The parent's handle when it passes one (the toolbar drives formatting through
  // it), otherwise our own — either way this component needs a handle of its own
  // to seed through. `EnrichedTextInput` takes a ref object, not a callback ref,
  // so the two share one object rather than being merged.
  const fallbackRef = useRef<EnrichedTextInputInstance | null>(null);
  const editor = editorRef ?? fallbackRef;

  // The seed comes back as a change event; that is the editor echoing what the
  // store already holds, not the user typing, and reporting it would mark the
  // note edited (see `onChangeBody` in the note screen) and re-commit a body
  // nobody touched — which is how two open clients start bouncing a note off
  // each other.
  //
  // What tells the two apart is focus, not timing. `setValue` is a view command
  // applied on a later native tick, so the echo can arrive *after* the field has
  // been focused; a rule that swallowed "the first event after seeding" would
  // then report the seed as an edit. Typing, on the other hand, is impossible
  // without focus — so an event arriving before the editor has ever been focused
  // cannot be the user, and one arriving after can be treated as though it is.
  // That needs no timer and can never swallow a real keystroke.
  const touched = useRef(false);
  useEffect(() => {
    if (!initialValue) return;
    editor.current?.setValue(initialValue);
    // `editor` is a ref object and never changes identity; listed to satisfy the
    // exhaustive-deps rule without re-seeding.
  }, [initialValue, editor]);

  // Watch for the native parser giving up on a paste. When it can't read the
  // pasted markup it drops the raw tags into the buffer as text (see the
  // `useHtmlNormalizer` note below), the next serialize escapes them, and the
  // note is permanently left displaying `<li>` on every platform. Nothing here
  // rewrites the body — the signal can't tell that damage apart from a note
  // legitimately written about HTML — but it does mean the corruption stops
  // being silent, and gives us the frequency this needs to be judged on.
  //
  // The Android half of that now degrades to the clipboard's plain-text
  // flavour instead of inserting markup (same patch), so this should only
  // still fire from iOS. Keep it until a build confirms that.
  const reportedCorruption = useRef(false);
  const watchForEscapedMarkup = (next: string) => {
    if (reportedCorruption.current) return;
    if (!hasEscapedBlockMarkup(next) || hasEscapedBlockMarkup(initialValue)) return;
    reportedCorruption.current = true;
    Sentry.captureMessage('Escaped block markup appeared in a note body', {
      level: 'warning',
      tags: { source: 'markdown-editor', op: 'paste' },
    });
  };

  // The keyboard's "hide" button dismisses the keyboard without blurring this
  // native input, which would leave the editor (and toolbar) in edit mode with
  // no keyboard. While focused, treat a keyboard hide as a request to blur.
  useEffect(() => {
    if (!focused) return;
    const sub = Keyboard.addListener('keyboardDidHide', () => editor.current?.blur());
    return () => sub.remove();
  }, [focused, editor]);

  return (
    <EnrichedTextInput
      ref={editor}
      // Seeded imperatively after mount — see `seeding` above.
      defaultValue=""
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
      //
      // Asking for it isn't quite enough on its own: the library skipped the
      // normalizer for anything already wrapped in `<html>…</html>`, reading
      // that shape as proof the markup was its own. A whole HTML document
      // pasted from another app looks identical, and the parser underneath
      // opens blocks by bare tag name — so a foreign `<li class="…">` opened
      // nothing and a pasted list landed as one unbroken run of text. Fixed on
      // both platforms in `patches/react-native-enriched+0.7.0.patch`; because
      // that's native code, it only reaches a device through a new build.
      useHtmlNormalizer
      // Android: apply size updates synchronously so a newline (which grows the
      // input) doesn't flicker the layout and bounce the caret back up.
      androidExperimentalSynchronousEvents
      htmlStyle={html}
      style={base}
      onChangeHtml={(e) => {
        // Nothing typed here yet, so this is the seed echoing back rather than
        // a keystroke.
        if (!touched.current) return;
        watchForEscapedMarkup(e.nativeEvent.value);
        onChangeText(e.nativeEvent.value);
      }}
      onChangeState={(e) => onStateChange?.(e.nativeEvent)}
      onChangeSelection={(e) => {
        const { start, end, text } = e.nativeEvent;
        onSelectionChange?.({ start, end, atEnd: end >= text.length });
      }}
      onFocus={() => {
        // From here on the field can be typed into, so changes are the user's.
        touched.current = true;
        // The native editor isn't registered with RN's TextInputState, so the
        // navbar's "done" can't reach it via Keyboard.dismiss(). Expose a blur.
        setActiveEditorDismiss(() => editor.current?.blur());
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
