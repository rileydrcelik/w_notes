import type { RefObject } from 'react';
import type { EnrichedTextInputInstance, OnChangeStateEvent } from 'react-native-enriched';

type Props = {
  editorRef: RefObject<EnrichedTextInputInstance | null>;
  state: OnChangeStateEvent | null;
  visible: boolean;
};

/**
 * No-op on web: the formatting toolbar drives the native rich editor's
 * imperative commands, which don't exist for the markdown textarea. The web
 * editor edits raw markdown, so there's nothing to format. Kept as a matching
 * export so the note/copa screens can render `<FormattingToolbar>` unchanged.
 */
export function FormattingToolbar(_props: Props) {
  return null;
}
