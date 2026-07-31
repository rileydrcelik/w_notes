/**
 * Ctrl+/ over LaTeX source.
 *
 * The stakes here are higher than a comment shortcut usually carries. A resume in
 * this app is a superset — benched experience lives on as commented-out lines —
 * so this is the gesture that moves work on and off the page, and it is pressed
 * against documents people have spent months on. A toggle that drops a character,
 * eats someone's indentation, or comments a line they didn't select is a silent
 * edit to a document they are about to send to an employer.
 *
 * `toggleLatexComment` returns a span replacement rather than a whole document,
 * so every assertion below checks the *applied* result — a correct-looking
 * replacement pinned to the wrong offsets would pass otherwise.
 */
import { describe, expect, it } from 'vitest';

import { toggleLatexComment } from '@/lib/latex/comment';

/** Apply the edit, so offsets are tested alongside the text. */
function apply(text: string, start: number, end = start) {
  const edit = toggleLatexComment(text, start, end);
  return {
    text: text.slice(0, edit.from) + edit.replacement + text.slice(edit.to),
    selectionStart: edit.selectionStart,
    selectionEnd: edit.selectionEnd,
    uncommented: edit.uncommented,
  };
}

/** Offset of the start of line `n` (1-based). */
function lineStart(text: string, n: number): number {
  return text.split('\n').slice(0, n - 1).join('\n').length + (n > 1 ? 1 : 0);
}

describe('toggleLatexComment', () => {
  it('comments the line the caret sits on', () => {
    const result = apply('\\item Built the thing', 6);
    expect(result.text).toBe('% \\item Built the thing');
    expect(result.uncommented).toBe(false);
  });

  it('uncomments a commented line, taking the marker and its one space', () => {
    const result = apply('% \\item Built the thing', 6);
    expect(result.text).toBe('\\item Built the thing');
    expect(result.uncommented).toBe(true);
  });

  it('round-trips: comment then uncomment is the document you started with', () => {
    const original = '  \\resumeItem{Cut deploy time 40\\%}';
    const commented = apply(original, 4);
    const back = apply(commented.text, 4);
    expect(back.text).toBe(original);
  });

  it('keeps a marker with no space after it from eating the next character', () => {
    // `%\item` is a line someone typed by hand. Removing two characters would
    // silently delete the backslash and leave `item`, which still compiles.
    const result = apply('%\\item Built it', 3);
    expect(result.text).toBe('\\item Built it');
  });

  it("leaves alignment alone — only the comment's own space is a space to remove", () => {
    const result = apply('%   \\item aligned', 8);
    expect(result.text).toBe('  \\item aligned');
  });
});

describe('multi-line selections', () => {
  const block = ['\\resumeSubheading', '  {Backend Engineer}', '  {Globex}', '\\resumeEnd'].join(
    '\n',
  );

  it('comments every line the selection touches', () => {
    const result = apply(block, 0, block.length);
    expect(result.text).toBe(
      ['% \\resumeSubheading', '%   {Backend Engineer}', '%   {Globex}', '% \\resumeEnd'].join('\n'),
    );
  });

  it('comments at the block\'s shallowest indent, so nesting survives', () => {
    const nested = ['  \\resumeItemListStart', '    \\resumeItem{One}'].join('\n');
    const result = apply(nested, 0, nested.length);
    // The marker goes in at column 2 — the shallower of the two — so the second
    // line stays visibly nested inside the first.
    expect(result.text).toBe(['  % \\resumeItemListStart', '  %   \\resumeItem{One}'].join('\n'));
  });

  it('does not touch the line after a selection that ends at a line break', () => {
    // Dragging down the gutter over two lines leaves the caret at the start of
    // the third. Commenting a line nobody highlighted is the surprise that makes
    // people stop trusting the shortcut.
    const result = apply(block, 0, lineStart(block, 3));
    expect(result.text.split('\n')[2]).toBe('  {Globex}');
    expect(result.text.split('\n')[0]).toBe('% \\resumeSubheading');
    expect(result.text.split('\n')[1]).toBe('%   {Backend Engineer}');
  });

  it('comments a mixed block rather than uncommenting the commented half', () => {
    // The rule every editor uses, and the one that makes the shortcut
    // reversible: press again and all of it comes back off.
    const mixed = ['% \\resumeSubheading', '  {Globex}'].join('\n');
    const once = apply(mixed, 0, mixed.length);
    expect(once.uncommented).toBe(false);
    expect(once.text).toBe(['% % \\resumeSubheading', '%   {Globex}'].join('\n'));
    const twice = apply(once.text, 0, once.text.length);
    expect(twice.text).toBe(mixed);
  });

  it('uncomments only when every line it would act on is commented', () => {
    const all = ['% one', '% two'].join('\n');
    const result = apply(all, 0, all.length);
    expect(result.uncommented).toBe(true);
    expect(result.text).toBe(['one', 'two'].join('\n'));
  });

  it('steps over blank lines rather than marking them', () => {
    const spaced = ['\\item One', '', '\\item Two'].join('\n');
    const result = apply(spaced, 0, spaced.length);
    expect(result.text).toBe(['% \\item One', '', '% \\item Two'].join('\n'));
  });

  it('does not let a blank line make a commented block look mixed', () => {
    const spaced = ['% \\item One', '', '% \\item Two'].join('\n');
    const result = apply(spaced, 0, spaced.length);
    expect(result.uncommented).toBe(true);
    expect(result.text).toBe(['\\item One', '', '\\item Two'].join('\n'));
  });

  it('comments an entirely blank selection, having no content lines to prefer', () => {
    const result = apply('\n\n', 0, 2);
    expect(result.text).toBe('% \n% \n');
  });

  it('acts on the first line when the document opens with a blank one', () => {
    // Regression. `lastIndexOf('\n', -1)` does not search nothing and return -1;
    // it clamps the position to 0 and inspects index 0. So a caret at the very
    // start of a document beginning with a newline found the newline it was
    // sitting in front of, and the shortcut commented the line *below* the
    // visible caret.
    const result = apply('\n\\item One', 0);
    expect(result.text).toBe('% \n\\item One');
  });
});

describe('where the caret and selection end up', () => {
  it('keeps a caret in its own line when the line grows', () => {
    const text = '\\item Built it';
    const result = apply(text, 6);
    // Was before "Built"; the line gained "% ", so it still is.
    expect(result.text.slice(result.selectionStart, result.selectionStart + 5)).toBe('Built');
  });

  it('keeps a caret in its own line when the line shrinks', () => {
    const result = apply('% \\item Built it', 8);
    expect(result.text.slice(result.selectionStart, result.selectionStart + 5)).toBe('Built');
  });

  it('does not push a caret onto the line above when the text under it is removed', () => {
    // Caret inside the "% " that uncommenting deletes. Without clamping it lands
    // before the newline, i.e. on the previous line.
    const text = ['\\section{X}', '% \\item One'].join('\n');
    const caret = lineStart(text, 2) + 1;
    const result = apply(text, caret);
    expect(result.selectionStart).toBeGreaterThanOrEqual(lineStart(result.text, 2));
  });

  it('keeps hold of every line a selection had, so pressing again toggles the same block', () => {
    const block = ['one', 'two', 'three'].join('\n');
    const edit = toggleLatexComment(block, 0, block.length);
    const commented = block.slice(0, edit.from) + edit.replacement + block.slice(edit.to);
    const again = toggleLatexComment(commented, edit.selectionStart, edit.selectionEnd);
    expect(
      commented.slice(0, again.from) + again.replacement + commented.slice(again.to),
    ).toBe(block);
  });
});
