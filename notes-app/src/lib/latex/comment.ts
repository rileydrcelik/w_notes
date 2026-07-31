/**
 * Toggling `%` comments over a run of LaTeX lines — the Ctrl+/ edit, worked out
 * as pure text so it can be tested without a DOM.
 *
 * This matters more in this plugin than a comment shortcut usually would. A
 * resume here is kept as a **superset**: experience and projects that aren't
 * currently on the page live on as commented-out lines, a bench the tailor and
 * the hardener promote from and demote to. Commenting a block out is therefore
 * not a debugging aid, it is the app's main manual gesture for "keep this, but
 * not on this page" — and doing it by hand to a twelve-line `\resumeSubheading`
 * block is the kind of chore people stop bothering with.
 *
 * Returns a **replacement over a span** rather than a whole new document, for
 * the same reason `/resume/edit` does: the caller can hand that span to the
 * browser as an ordinary edit, which keeps the textarea's own undo stack intact.
 * A wholesale value swap is one Ctrl+Z away from losing everything typed before
 * it.
 */

/** LaTeX's comment character. */
export const COMMENT = '%';

/** What Ctrl+/ should do to the document, as a span replacement. */
export type CommentEdit = {
  /** Start of the first affected line. */
  from: number;
  /** End of the last affected line, before its newline. */
  to: number;
  /** What the run from `from` to `to` becomes. */
  replacement: string;
  /** Where the caret or selection should sit afterwards. */
  selectionStart: number;
  selectionEnd: number;
  /** True when this removed comment markers rather than adding them. */
  uncommented: boolean;
};

/** Leading whitespace of a line. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function isCommented(line: string): boolean {
  return line.trimStart().startsWith(COMMENT);
}

/**
 * The lines a selection touches.
 *
 * A selection that ends exactly at the start of a line does **not** include that
 * line. Selecting three whole lines by dragging down the gutter leaves the caret
 * at the start of the fourth, and commenting a line nobody highlighted is the
 * kind of surprise that makes people stop trusting the shortcut.
 */
function affectedRange(text: string, start: number, end: number): [number, number] {
  // `start === 0` is special-cased because `lastIndexOf(needle, -1)` does not
  // search backwards from nowhere and find nothing — it clamps the position to 0
  // and inspects index 0. In a document that opens with a blank line that finds
  // the very newline the caret is sitting in front of, and the shortcut acts on
  // the second line while the caret is visibly on the first.
  const from = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  const lastTouched = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const nextBreak = text.indexOf('\n', lastTouched);
  return [from, nextBreak === -1 ? text.length : nextBreak];
}

/**
 * Comment or uncomment the lines a selection touches.
 *
 * Uncomments only when **every** line it would act on is already commented —
 * the rule every editor uses, and the one that makes the shortcut reversible: a
 * mixed block is commented first, and pressing it again takes all of it back off.
 *
 * Commenting inserts at the block's **shallowest indent** rather than at column
 * zero, so a nested `\resumeItem` keeps its shape and reads as benched code
 * rather than as flattened text.
 */
export function toggleLatexComment(text: string, start: number, end: number): CommentEdit {
  const [from, to] = affectedRange(text, start, end);
  const lines = text.slice(from, to).split('\n');

  // Blank lines are passengers: they don't decide whether the block counts as
  // commented, and they don't get a marker of their own. A selection that is
  // *entirely* blank has no passengers, only lines, so it acts on all of them.
  const contentIndexes = lines.map((line, i) => (isBlank(line) ? -1 : i)).filter((i) => i >= 0);
  const targets = contentIndexes.length > 0 ? contentIndexes : lines.map((_line, i) => i);

  const uncommented = targets.every((i) => isCommented(lines[i]));

  const indent = uncommented
    ? ''
    : targets.reduce((shortest, i) => {
        const own = indentOf(lines[i]);
        return own.length < shortest.length ? own : shortest;
      }, indentOf(lines[targets[0]]));

  const next = [...lines];
  for (const i of targets) {
    const line = lines[i];
    if (uncommented) {
      const at = line.indexOf(COMMENT);
      const after = line.slice(at + COMMENT.length);
      // Drop the single space a comment is written with, and only that one —
      // `%   \item` is someone's alignment, not padding to tidy away.
      next[i] = line.slice(0, at) + (after.startsWith(' ') ? after.slice(1) : after);
    } else {
      next[i] = `${indent}${COMMENT} ${line.slice(indent.length)}`;
    }
  }

  const replacement = next.join('\n');

  // A caret keeps its place in its own line; a selection keeps hold of every
  // line it had. Anything else moves the view out from under whoever pressed the
  // key.
  if (start === end) {
    const caret = caretAfter(lines, next, from, start);
    return { from, to, replacement, selectionStart: caret, selectionEnd: caret, uncommented };
  }
  return {
    from,
    to,
    replacement,
    selectionStart: from,
    selectionEnd: from + replacement.length,
    uncommented,
  };
}

/**
 * Where a caret lands once its own line has grown or shrunk.
 *
 * Clamped to the line it started on. Without that, uncommenting a line with the
 * caret sitting inside the `% ` being deleted would push it onto the line above.
 */
function caretAfter(before: string[], after: string[], from: number, caret: number): number {
  let oldStart = from;
  let newStart = from;
  for (let i = 0; i < before.length; i += 1) {
    const oldEnd = oldStart + before[i].length;
    if (caret <= oldEnd) {
      const delta = after[i].length - before[i].length;
      return Math.min(Math.max(caret + delta, newStart), newStart + after[i].length);
    }
    oldStart = oldEnd + 1;
    newStart += after[i].length + 1;
  }
  return caret;
}
