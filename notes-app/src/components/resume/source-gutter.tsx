/**
 * Native counterpart of the line-number gutter: there isn't one.
 *
 * The gutter depends on the editor not wrapping, and a phone is the one place
 * where that trade goes the wrong way — turning wrapping off to make room for
 * numbers means every `\resumeSubheading` runs off the side of a 390pt screen
 * and has to be scrolled to be read. Numbers are worth scrolling sideways on a
 * desktop and not worth it on a phone, so `gutterWidth` returns zero here and
 * the editor lays out as it always has.
 *
 * **Its exported names and signatures must match `source-gutter.web.tsx`.** A
 * `.web` file that drifts from its base is invisible to TypeScript and to any
 * suite that runs one platform; `lib/__tests__/platform-parity.test.ts` covers
 * this pair automatically, and exists because that once cost three days of a
 * broken native launch with a green suite.
 */
import type { RefObject } from 'react';
import type { TextInput } from 'react-native';

/** The editor's line box. Native has no gutter, but the editor still reads these. */
export const LINE_HEIGHT = 20;
export const FONT_SIZE = 13;

/** No gutter, so no room reserved for one. */
export function gutterWidth(_lineCount: number): number {
  return 0;
}

export function SourceGutter(_props: {
  inputRef: RefObject<TextInput | null>;
  text: string;
  topInset: number;
}) {
  return null;
}
