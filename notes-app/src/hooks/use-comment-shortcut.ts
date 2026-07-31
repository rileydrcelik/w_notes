/**
 * Native no-op counterpart of the web hook.
 *
 * A soft keyboard has no Ctrl key, and React Native's `onKeyPress` reports the
 * key without the modifier even where a hardware keyboard is attached — so there
 * is no way to tell Ctrl+/ from a typed slash, and guessing would put a `/` in
 * someone's resume. Mobile comments a line by typing `%`, which is one character.
 *
 * **Its exported name and signature must match `use-comment-shortcut.web.ts`.**
 * A `.web` file that drifts from its base is invisible to TypeScript and to any
 * suite that runs one platform; `lib/__tests__/platform-parity.test.ts` covers
 * this pair automatically, and exists because that once cost three days of a
 * broken native launch with a green suite.
 */
import type { RefObject } from 'react';
import type { TextInput } from 'react-native';

export function useCommentShortcut(
  _inputRef: RefObject<TextInput | null>,
  _onChangeText: (text: string) => void,
): void {
  // Nothing to attach.
}
