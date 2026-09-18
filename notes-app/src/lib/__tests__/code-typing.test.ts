import { describe, expect, it } from 'vitest';

import { backspaceInCode, enterInCode, exitOffset, typeInCode, type CodeEdit } from '../code-typing';

/** Apply an edit to `text` and render the caret as `|` (a selection as `[…]`). */
function run(text: string, edit: CodeEdit | null): string | null {
  if (!edit) return null;
  const out = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  if (edit.anchor !== undefined && edit.anchor !== edit.caret) {
    return out.slice(0, edit.anchor) + '[' + out.slice(edit.anchor, edit.caret) + ']' + out.slice(edit.caret);
  }
  return out.slice(0, edit.caret) + '|' + out.slice(edit.caret);
}

/** `|` in `src` marks the caret; returns [text, offset]. */
function at(src: string): [string, number] {
  const i = src.indexOf('|');
  return [src.slice(0, i) + src.slice(i + 1), i];
}

const type = (src: string, ch: string) => {
  const [text, i] = at(src);
  return run(text, typeInCode(text, i, i, ch, 2));
};
const enter = (src: string) => {
  const [text, i] = at(src);
  return run(text, enterInCode(text, i, i, 2));
};
const backspace = (src: string) => {
  const [text, i] = at(src);
  return run(text, backspaceInCode(text, i, 2));
};

describe('typeInCode', () => {
  it('closes each opener', () => {
    expect(type('|', '{')).toBe('{|}');
    expect(type('foo|', '(')).toBe('foo(|)');
    expect(type('x = |', '[')).toBe('x = [|]');
  });

  it('closes before whitespace, a closer or a separator', () => {
    expect(type('|\nnext', '(')).toBe('(|)\nnext');
    expect(type('f(|)', '[')).toBe('f([|])');
    expect(type('a|, b', '(')).toBe('a(|), b');
  });

  it('does not close in front of a word', () => {
    expect(type('|foo', '(')).toBeNull();
  });

  it('wraps a selection and keeps it selected', () => {
    expect(run('a foo b', typeInCode('a foo b', 2, 5, '(', 2))).toBe('a ([foo]) b');
  });

  it('steps over a closer that is already there', () => {
    expect(type('f(|)', ')')).toBe('f()|');
    expect(type('{|}', '}')).toBe('{}|');
  });

  it('inserts a closer normally when a different one follows', () => {
    expect(type('f(x|]', ')')).toBeNull();
  });

  it('lines a closer on an indentation-only line up with its opener', () => {
    expect(type('if {\n    |', '}')).toBe('if {\n}|');
    expect(type('{\n  [\n    |', ']')).toBe('{\n  [\n  ]|');
    // Already at the opener's level (Backspace took the indent back): stays put.
    expect(type('  fn() {\n    a\n  |', '}')).toBe('  fn() {\n    a\n  }|');
    // A pair already closed doesn't count — nothing to line up with, so it
    // falls back to dropping a level.
    expect(type('  {\n  }\n    |', '}')).toBe('  {\n  }\n  }|');
  });

  it('drops a level when there is no opener to line up with', () => {
    expect(type('    |', ')')).toBe('  )|');
    expect(type('\t|', ']')).toBe(']|');
  });

  it('leaves other characters alone', () => {
    expect(type('|', 'a')).toBeNull();
    expect(type('|', ':')).toBeNull();
  });
});

describe('enterInCode', () => {
  it('keeps the current indentation', () => {
    expect(enter('    foo|')).toBe('    foo\n    |');
  });

  it('indents a level after an opening character', () => {
    expect(enter('if x:|')).toBe('if x:\n  |');
    expect(enter('  fn() {|')).toBe('  fn() {\n    |');
    expect(enter('xs = [|')).toBe('xs = [\n  |');
    expect(enter('call(|')).toBe('call(\n  |');
  });

  it('splits a pair onto three lines', () => {
    expect(enter('  f() {|}')).toBe('  f() {\n    |\n  }');
    expect(enter('g(|)')).toBe('g(\n  |\n)');
  });

  it('drops whitespace around the caret', () => {
    expect(enter('foo {   |   }')).toBe('foo {\n  |\n}');
    expect(enter('a|   b')).toBe('a\n|b');
  });

  it('keeps an indentation-only line as it is', () => {
    expect(enter('  |')).toBe('  \n  |');
  });

  it('opens a line above without touching the indentation after the caret', () => {
    expect(enter('foo\n|    bar')).toBe('foo\n\n|    bar');
    expect(enter('  |  bar')).toBe('  \n  |  bar');
  });

  it('only looks at the line the caret is on', () => {
    expect(enter('if x:\n  y|')).toBe('if x:\n  y\n  |');
  });
});

describe('exitOffset', () => {
  it('leaves after two blank lines at the end, indented or not', () => {
    expect(exitOffset('a\n\n', 3)).toBe(1);
    expect(exitOffset('  a\n  \n  ', 9)).toBe(3);
  });

  it('stays while there is still text after the caret or a single blank', () => {
    expect(exitOffset('a\n\n', 2)).toBeNull();
    expect(exitOffset('a\n  ', 4)).toBeNull();
  });
});

describe('backspaceInCode', () => {
  it('removes an empty pair together', () => {
    expect(backspace('f(|)')).toBe('f|');
    expect(backspace('{|}')).toBe('|');
  });

  it('removes a whole level of indentation', () => {
    expect(backspace('    |')).toBe('  |');
    expect(backspace('x\n   |')).toBe('x\n  |');
  });

  it('is an ordinary backspace elsewhere', () => {
    expect(backspace('ab|')).toBeNull();
    expect(backspace(' |')).toBeNull();
    expect(backspace('|')).toBeNull();
    expect(backspace('(x|)')).toBeNull();
  });
});
