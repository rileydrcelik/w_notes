/**
 * Web-only: Ctrl+/ (Cmd+/ on a Mac) toggles `%` comments in the LaTeX source.
 *
 * Wired onto the underlying `<textarea>` rather than through React Native's
 * `onKeyPress`, which reports the key but not the modifier — there is no way to
 * tell a bare `/` from Ctrl+/ through it, and typing a slash into someone's
 * resume when they asked to comment a block would be worse than no shortcut.
 * React Native Web hands host refs back as the DOM node, so `inputRef.current`
 * *is* the textarea and no second ref is needed.
 *
 * **How the edit is applied is the load-bearing part.** It goes in through
 * `execCommand('insertText')`, not by setting the field's value: the browser
 * then records it on the textarea's own undo stack, so Ctrl+Z takes the comment
 * back off and Ctrl+Z again undoes whatever was typed before it. Replacing the
 * value directly wipes that stack — the shortcut would work once and then quietly
 * cost someone every undo they had. `execCommand` is deprecated and still the
 * only way to write into a textarea as though a person had; the direct write is
 * kept below as a fallback for the day it stops working, because losing undo is
 * much better than losing the shortcut.
 *
 * See `use-comment-shortcut.ts` for the native no-op, and `lib/latex/comment.ts`
 * for the edit itself, which is pure and tested.
 */
import { useEffect, useRef, type RefObject } from 'react';
import type { TextInput } from 'react-native';

import { toggleLatexComment } from '@/lib/latex/comment';

export function useCommentShortcut(
  inputRef: RefObject<TextInput | null>,
  onChangeText: (text: string) => void,
): void {
  // Kept in a ref so the listener is attached once rather than re-attached on
  // every keystroke — `onChangeText` is a new function on each render. Written in
  // an effect rather than during render, which React forbids and the lint rule
  // catches; the only reader is the keydown handler below, which cannot run
  // before the effect that attached it.
  const onChangeRef = useRef(onChangeText);
  useEffect(() => {
    onChangeRef.current = onChangeText;
  });

  useEffect(() => {
    const field = inputRef.current as unknown as HTMLTextAreaElement | null;
    if (!field || typeof field.addEventListener !== 'function') return;

    const onKeyDown = (event: KeyboardEvent) => {
      // `event.key` rather than a keyCode: on several non-US layouts the slash
      // lives on a different physical key, and the character is what people
      // press.
      if (event.key !== '/' || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      event.preventDefault();

      const { value, selectionStart, selectionEnd } = field;
      if (selectionStart === null || selectionEnd === null) return;

      const edit = toggleLatexComment(value, selectionStart, selectionEnd);

      field.setSelectionRange(edit.from, edit.to);
      const inserted =
        typeof document.execCommand === 'function' &&
        document.execCommand('insertText', false, edit.replacement);

      if (!inserted) {
        // Undo is gone for this edit, but the edit still happens.
        const next = value.slice(0, edit.from) + edit.replacement + value.slice(edit.to);
        field.value = next;
        onChangeRef.current(next);
      }
      field.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    };

    field.addEventListener('keydown', onKeyDown);
    return () => field.removeEventListener('keydown', onKeyDown);
    // `inputRef` is stable; the field it points at is created with the component.
  }, [inputRef]);
}
