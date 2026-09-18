/**
 * What typing does inside a code block: brackets that close themselves, and
 * indentation that follows the code.
 *
 * Pure text in, edit out — offsets are into the block's own text, which is all a
 * code block holds (no marks, no inline nodes), so the editor maps them onto
 * document positions by adding the block's start. Kept free of TipTap so the
 * rules can be tested without a DOM.
 */

/** A replacement of `[from, to)` in the block's text, then where the caret goes.
 *  `anchor`, when set, makes it a selection from `anchor` to `caret`. */
export type CodeEdit = { from: number; to: number; insert: string; caret: number; anchor?: number };

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set(Object.values(PAIRS));
/** A line ending in one of these opens a level: `if x:`, `fn() {`, `[`, `(`. */
const OPENS_LEVEL = new Set([':', '{', '[', '(']);

function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

function lineEndOf(text: string, offset: number): number {
  const end = text.indexOf('\n', offset);
  return end === -1 ? text.length : end;
}

function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/** Offset of the unclosed opener `closer` would close, scanning back from
 *  `before`, or null. Brackets of other kinds are ignored: in half-typed code
 *  they're as likely unbalanced as not, and one pair is enough to line up by. */
function matchingOpener(text: string, before: number, closer: string): number | null {
  const opener = Object.keys(PAIRS).find((o) => PAIRS[o] === closer)!;
  let depth = 0;
  for (let i = before - 1; i >= 0; i--) {
    if (text[i] === closer) depth++;
    else if (text[i] === opener) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return null;
}

/**
 * A character typed over `[from, to)`. Returns null to let it insert as usual.
 *
 * - An opener closes itself, but only where a closer makes sense next — before
 *   whitespace, the end of the line, another closer or a separator. Typed just
 *   in front of a word (`(|foo`) it's the start of wrapping that word by hand,
 *   and a stray `)` there would be something to delete.
 * - With text selected, an opener wraps it and keeps it selected.
 * - A closer typed where that same closer already sits steps over it, so typing
 *   through `()` by habit doesn't leave `())`.
 * - A closer typed on a line that is only indentation so far drops back a level,
 *   so the `}` lines up with the line that opened it.
 */
export function typeInCode(text: string, from: number, to: number, ch: string, tabSize: number): CodeEdit | null {
  const closer = PAIRS[ch];
  if (closer) {
    if (from !== to) {
      const selected = text.slice(from, to);
      return { from, to, insert: ch + selected + closer, anchor: from + 1, caret: from + 1 + selected.length };
    }
    const next = text[to];
    if (next !== undefined && !/[\s)\]},;]/.test(next)) return null;
    return { from, to, insert: ch + closer, caret: from + 1 };
  }
  if (CLOSERS.has(ch) && from === to) {
    if (text[from] === ch) return { from, to: from, insert: '', caret: from + 1 };
    const start = lineStartOf(text, from);
    const before = text.slice(start, from);
    if (before.length > 0 && /^[ \t]+$/.test(before)) {
      // Line up with the line holding the matching opener, so a closer typed
      // at a level Backspace already took back doesn't drop one further.
      const opener = matchingOpener(text, start, ch);
      if (opener !== null) {
        const target = indentOf(text.slice(lineStartOf(text, opener)));
        return { from: start, to, insert: target + ch, caret: start + target.length + 1 };
      }
      // No opener to go by: drop one level. A tab is a whole level on its own;
      // otherwise a level is `tabSize` spaces.
      const spaces = /( *)$/.exec(before)![1].length;
      const cut = before.endsWith('\t') ? 1 : Math.min(tabSize, spaces);
      return { from: from - cut, to, insert: ch, caret: from - cut + 1 };
    }
  }
  return null;
}

/**
 * Enter at `offset`: the new line starts at the current line's indentation, one
 * level deeper after a line that opens one. Pressed between a pair (`{|}`) the
 * closer moves to its own line at the outer level, with the caret on the
 * indented line between.
 *
 * Whitespace on either side of the caret is dropped — trailing spaces left on
 * the line above, or leading ones carried into the new line, would double the
 * indent it's about to be given.
 */
export function enterInCode(text: string, from: number, to: number, tabSize: number): CodeEdit {
  const start = lineStartOf(text, from);
  const head = text.slice(start, from);
  const indent = indentOf(head);
  const trimmedHead = head.trimEnd();
  const last = trimmedHead[trimmedHead.length - 1];
  const opens = last !== undefined && OPENS_LEVEL.has(last);
  const inner = opens ? indent + ' '.repeat(tabSize) : indent;

  // With nothing but indentation before the caret, Enter is opening a line
  // above the text, not splitting it — the text keeps every bit of its own
  // indentation, and the new line gets what was before the caret.
  if (trimmedHead.length === 0) {
    return { from, to, insert: '\n' + head, caret: from + 1 + head.length };
  }

  // Trim trailing spaces before the caret.
  const cutFrom = start + trimmedHead.length;
  const rest = text.slice(to, lineEndOf(text, to));
  const lead = /^[ \t]*/.exec(rest)![0].length;
  const cutTo = to + lead;
  const nextChar = rest[lead];

  if (opens && nextChar !== undefined && PAIRS[last] === nextChar) {
    const insert = '\n' + inner + '\n' + indent;
    return { from: cutFrom, to: cutTo, insert, caret: cutFrom + 1 + inner.length };
  }
  return { from: cutFrom, to: cutTo, insert: '\n' + inner, caret: cutFrom + 1 + inner.length };
}

/**
 * Enter pressed on the third empty line at the end of a block leaves it — the
 * stock rule, restated for auto-indent: those "empty" lines now hold the
 * indentation Enter gave them, so they read as whitespace-only rather than as
 * literally empty. Returns the offset to cut the block back to, or null.
 */
export function exitOffset(text: string, offset: number): number | null {
  if (offset !== text.length) return null;
  const match = /\n[ \t]*\n[ \t]*$/.exec(text);
  return match ? match.index : null;
}

/**
 * Backspace at `offset` with nothing selected. Between an empty pair it removes
 * both halves; inside a line's indentation it removes a whole level, the
 * reverse of the Tab that put it there. Null means an ordinary backspace.
 */
export function backspaceInCode(text: string, offset: number, tabSize: number): CodeEdit | null {
  if (offset === 0) return null;
  const prev = text[offset - 1];
  if (PAIRS[prev] !== undefined && text[offset] === PAIRS[prev]) {
    return { from: offset - 1, to: offset + 1, insert: '', caret: offset - 1 };
  }
  const start = lineStartOf(text, offset);
  const before = text.slice(start, offset);
  if (before.length >= 2 && /^ +$/.test(before)) {
    const drop = before.length % tabSize || tabSize;
    return { from: offset - drop, to: offset, insert: '', caret: offset - drop };
  }
  return null;
}
