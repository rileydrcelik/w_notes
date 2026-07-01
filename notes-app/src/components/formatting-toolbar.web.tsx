import type { RefObject } from 'react';
import type { EnrichedTextInputInstance, OnChangeStateEvent } from 'react-native-enriched';

type Props = {
  editorRef: RefObject<EnrichedTextInputInstance | null>;
  state: OnChangeStateEvent | null;
  visible: boolean;
};

/**
 * No formatting toolbar on web. The web editor (`markdown-editor.web.tsx`) is a
 * TipTap editor with markdown-style keyboard input (`**bold**`, `# `, `- `,
 * `1. `, `> `, `[ ] `, `` ` ``) and undo/redo, so formatting is applied by typing
 * rather than tapping a bar. The screens still render `<FormattingToolbar>`
 * unconditionally with the same props as native; this platform variant just
 * renders nothing.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function FormattingToolbar(_props: Props): null {
  return null;
}
