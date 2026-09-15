/**
 * Keeps deliberate spaces — an indent, a run between words — alive in stored
 * HTML. Every HTML parser collapses plain spaces: a run becomes one, and one
 * that follows a space or opens a block is dropped. That includes TipTap's on
 * the next load and the native editor's on a phone. A non-breaking space isn't
 * collapsible, so the ones that would be lost are written as U+00A0.
 *
 * Mirrors what the Android editor already writes (`EnrichedParser.withinStyle`):
 * a run of N spaces is N-1 non-breaking spaces then one plain space, so a body
 * edited on web serializes the same way as one edited on Android.
 *
 * Pure string logic so it can be unit-tested; the DOM walk that feeds it text
 * node by text node lives in `rich-html.web.ts`.
 */

const NBSP = ' ';

/**
 * Encodes one text node's collapsible spaces. `afterSpace` is true when this
 * text opens a block or the text before it in the block ended in a plain
 * space — the positions where even a single leading space would be dropped.
 */
export function encodeSignificantSpaces(text: string, afterSpace: boolean): string {
  return text.replace(/ +/g, (run: string, offset: number) => {
    if (run.length > 1) return NBSP.repeat(run.length - 1) + ' ';
    return offset === 0 && afterSpace ? NBSP : ' ';
  });
}
