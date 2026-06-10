/**
 * A tiny, dependency-free Markdown parser scoped to the "basic" subset notes
 * need: headings, bullet / numbered lists, checkboxes, blockquotes, code, and
 * inline bold / italic / code. It is line-oriented — each source line maps to
 * one block — so a checkbox can be toggled by rewriting its original line, and
 * single newlines are preserved the way people expect inside notes.
 *
 * Every token and block carries `offset`, the index of its visible text in the
 * raw source. That lets the renderer translate a tap on the formatted output
 * back to a caret position in the underlying text for tap-to-edit.
 */

/** One inline run of text with the marks that apply to it. */
export type InlineToken = {
  text: string;
  /** Raw-source index where this run's visible text starts. */
  offset: number;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
};

/** Shared by every block: where its content begins in the raw source. */
type BlockBase = { offset: number };

export type Block = BlockBase &
  (
    | { kind: 'heading'; level: 1 | 2 | 3; tokens: InlineToken[] }
    | { kind: 'checkbox'; checked: boolean; tokens: InlineToken[]; line: number }
    | { kind: 'bullet'; tokens: InlineToken[] }
    | { kind: 'ordered'; marker: string; tokens: InlineToken[] }
    | { kind: 'quote'; tokens: InlineToken[] }
    | { kind: 'code'; text: string }
    | { kind: 'paragraph'; tokens: InlineToken[] }
    | { kind: 'blank' }
  );

const HEADING = /^(#{1,3})\s+(.*)$/;
// An optional leading bullet, then brackets with any spacing inside, so a bare
// pasted `[  ] thing` is recognized as a checkbox just like `- [ ] thing`.
const CHECKBOX = /^([-*]\s+)?\[ *([xX]?) *\]\s*(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const ORDERED = /^(\d+)[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const FENCE = /^```/;

/** Matches the first **bold**, `code`, *italic*, or _italic_ run in a string. */
const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\n]+)\*|_([^_\n]+)_/;

/**
 * Split a line into styled runs. `base` is the raw-source index of `text[0]` so
 * each token can report where its visible content sits in the document. Bold
 * and code win over italic when nested.
 */
export function parseInline(text: string, base: number): InlineToken[] {
  const tokens: InlineToken[] = [];
  let pos = 0;

  while (pos < text.length) {
    const rest = text.slice(pos);
    const m = INLINE.exec(rest);
    if (!m) {
      tokens.push({ text: rest, offset: base + pos });
      break;
    }
    if (m.index > 0) tokens.push({ text: rest.slice(0, m.index), offset: base + pos });

    const start = pos + m.index;
    // The visible text sits past the opening marker (2 chars for **, else 1).
    if (m[1] !== undefined) tokens.push({ text: m[1], bold: true, offset: base + start + 2 });
    else if (m[2] !== undefined) tokens.push({ text: m[2], code: true, offset: base + start + 1 });
    else if (m[3] !== undefined) tokens.push({ text: m[3], italic: true, offset: base + start + 1 });
    else if (m[4] !== undefined) tokens.push({ text: m[4], italic: true, offset: base + start + 1 });

    pos = start + m[0].length;
  }

  return tokens;
}

/** Parse note/copa text into renderable blocks. */
export function parseMarkdown(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let offset = 0; // raw index of the current line's first character

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1; // advance past this line and its newline

    // `(.*)$` captures are line suffixes, so this is where the content begins.
    const contentStart = (content: string) => lineStart + (line.length - content.length);

    // Fenced code block: consume through the closing fence (or end of text).
    if (FENCE.test(line)) {
      const body: string[] = [];
      while (i + 1 < lines.length && !FENCE.test(lines[i + 1])) {
        body.push(lines[i + 1]);
        offset += lines[i + 1].length + 1;
        i++;
      }
      if (i + 1 < lines.length) {
        offset += lines[i + 1].length + 1; // closing fence
        i++;
      }
      blocks.push({ kind: 'code', text: body.join('\n'), offset: lineStart });
      continue;
    }

    if (line.trim() === '') {
      blocks.push({ kind: 'blank', offset: lineStart });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        tokens: parseInline(heading[2], contentStart(heading[2])),
        offset: contentStart(heading[2]),
      });
      continue;
    }

    const checkbox = CHECKBOX.exec(line);
    if (checkbox) {
      blocks.push({
        kind: 'checkbox',
        checked: checkbox[2].toLowerCase() === 'x',
        tokens: parseInline(checkbox[3], contentStart(checkbox[3])),
        line: i,
        offset: contentStart(checkbox[3]),
      });
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered) {
      blocks.push({
        kind: 'ordered',
        marker: `${ordered[1]}.`,
        tokens: parseInline(ordered[2], contentStart(ordered[2])),
        offset: contentStart(ordered[2]),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      blocks.push({
        kind: 'bullet',
        tokens: parseInline(bullet[1], contentStart(bullet[1])),
        offset: contentStart(bullet[1]),
      });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      blocks.push({
        kind: 'quote',
        tokens: parseInline(quote[1], contentStart(quote[1])),
        offset: contentStart(quote[1]),
      });
      continue;
    }

    blocks.push({ kind: 'paragraph', tokens: parseInline(line, lineStart), offset: lineStart });
  }

  return blocks;
}

/**
 * Flip the checkbox on `line` between `[ ]` and `[x]`, returning the new text.
 * Used by the renderer so a tap can toggle without entering edit mode.
 */
export function toggleCheckboxAt(text: string, line: number): string {
  const lines = text.split('\n');
  if (line < 0 || line >= lines.length) return text;
  // Normalize any spacing inside the brackets while flipping the state.
  lines[line] = lines[line].replace(/\[ *([xX]?) *\]/, (_m, state: string) =>
    state.toLowerCase() === 'x' ? '[ ]' : '[x]',
  );
  return lines.join('\n');
}
