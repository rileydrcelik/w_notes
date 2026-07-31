/**
 * The line diff behind the tailor's review step.
 *
 * This is the only thing standing between someone and applying a whole rewritten
 * resume, so what it must never do is *look* right while being wrong: a diff that
 * shows an unchanged line as changed teaches you to stop reading it, and one that
 * shows a changed line as unchanged hides the thing you opened it for.
 */
import { describe, expect, it } from 'vitest';

import {
  collapseUnchanged,
  describeDiff,
  diffLines,
  diffStat,
  foldCommentToggles,
  type DiffLine,
} from '@/lib/latex/diff';

const render = (lines: DiffLine[]) =>
  lines.map((l) => `${l.kind === 'added' ? '+' : l.kind === 'removed' ? '-' : ' '}${l.text}`);

describe('diffLines', () => {
  it('reports nothing changed for identical documents', () => {
    const lines = diffLines('a\nb\nc', 'a\nb\nc');
    expect(lines.every((l) => l.kind === 'same')).toBe(true);
    expect(diffStat(lines)).toEqual({ added: 0, removed: 0, commented: 0, uncommented: 0 });
  });

  it('finds an inserted line without disturbing its neighbours', () => {
    expect(render(diffLines('a\nc', 'a\nb\nc'))).toEqual([' a', '+b', ' c']);
  });

  it('finds a removed line', () => {
    expect(render(diffLines('a\nb\nc', 'a\nc'))).toEqual([' a', '-b', ' c']);
  });

  it('shows a replaced line as the old one then the new one', () => {
    // Order matters for reading: "this became that".
    expect(render(diffLines('a\nb\nc', 'a\nB\nc'))).toEqual([' a', '-b', '+B', ' c']);
  });

  it('keeps a moved-but-unchanged line as one add and one remove, not four', () => {
    // The minimal edit script. A naive line-by-line compare would mark every
    // line from the move onwards as changed.
    const stat = diffStat(diffLines('a\nb\nc\nd', 'b\nc\nd\na'));
    expect(stat).toEqual({ added: 1, removed: 1, commented: 0, uncommented: 0 });
  });

  it('handles the LaTeX case it exists for: commenting an entry out', () => {
    const before = ['\\section{Experience}', '\\textbf{Barista}', '\\end{document}'].join('\n');
    const after = ['\\section{Experience}', '% \\textbf{Barista}', '\\end{document}'].join('\n');
    expect(render(diffLines(before, after))).toEqual([
      ' \\section{Experience}',
      '-\\textbf{Barista}',
      '+% \\textbf{Barista}',
      ' \\end{document}',
    ]);
  });

  it('keeps the tail of the old document when the new one runs out first', () => {
    // The main walk stops as soon as either side is exhausted; without the
    // clean-up loop afterwards, everything past that point vanishes from the diff
    // — a deletion the review would never show you.
    expect(render(diffLines('a\nb\nc', 'a'))).toEqual([' a', '-b', '-c']);
  });

  it('keeps the tail of the new document when the old one runs out first', () => {
    expect(render(diffLines('a', 'a\nb\nc'))).toEqual([' a', '+b', '+c']);
  });

  it('treats an empty document as all-added', () => {
    expect(diffStat(diffLines('', 'a\nb'))).toEqual({ added: 2, removed: 1, commented: 0, uncommented: 0 });
    expect(diffStat(diffLines('a\nb', ''))).toEqual({ added: 1, removed: 2, commented: 0, uncommented: 0 });
  });

  it('does not treat trailing whitespace as the same line', () => {
    // In LaTeX it can matter, and a diff that hides a change is the worse failure.
    expect(diffStat(diffLines('a', 'a '))).toEqual({ added: 1, removed: 1, commented: 0, uncommented: 0 });
  });

  it('falls back to a whole-document replacement beyond the size guard', () => {
    // The LCS table is O(n·m); past the cap it would freeze the tab rather than
    // merely be slow, and at that size a line-by-line read is useless anyway.
    //
    // Deliberately two *identical* huge documents: a real LCS would call every
    // line 'same', so this only passes if the guard actually fired. Comparing
    // against something unrelated would have passed either way.
    const huge = new Array(3_001).fill('x').join('\n');
    const lines = diffLines(huge, huge);
    expect(lines.some((l) => l.kind === 'same')).toBe(false);
    expect(lines).toHaveLength(3_001 * 2);
  });
});

describe('collapseUnchanged', () => {
  const lines = (n: number, kind: DiffLine['kind'] = 'same'): DiffLine[] =>
    Array.from({ length: n }, (_, i) => ({ kind, text: `line ${i}` }));

  it('leaves a short unchanged run alone', () => {
    const rows = collapseUnchanged([...lines(2), { kind: 'added', text: 'x' }], 3);
    expect(rows.some((r) => r.kind === 'gap')).toBe(false);
  });

  it('collapses a long unchanged run and says how long it was', () => {
    const rows = collapseUnchanged(
      [...lines(30), { kind: 'added', text: 'x' }, ...lines(30)],
      3,
    );
    const gaps = rows.filter((r): r is { kind: 'gap'; count: number } => r.kind === 'gap');
    expect(gaps).toHaveLength(2);
    // Nothing is silently dropped — the counts account for every hidden line.
    expect(gaps[0].count + gaps[1].count).toBe(60 - 6);
  });

  it('keeps context either side of a change', () => {
    const rows = collapseUnchanged([...lines(10), { kind: 'added', text: 'x' }], 3);
    const kept = rows.filter((r) => r.kind !== 'gap');
    // Three lines of context plus the change itself.
    expect(kept).toHaveLength(4);
  });

  it('collapses nothing when everything changed', () => {
    const rows = collapseUnchanged(lines(20, 'added'), 3);
    expect(rows.some((r) => r.kind === 'gap')).toBe(false);
  });

  it('collapses an entirely unchanged document to one gap', () => {
    const rows = collapseUnchanged(lines(40), 3);
    expect(rows).toEqual([{ kind: 'gap', count: 40 }]);
  });
});


describe('foldCommentToggles', () => {
  const fold = (before: string, after: string) => foldCommentToggles(diffLines(before, after));
  const show = (lines: DiffLine[]) =>
    lines.map((l) => `${l.kind}:${l.text.trim()}`);

  it('reads an entry taken off the page as one change, not two per line', () => {
    // The real case, and the one that made this necessary: a project commented
    // out showed as 11 removed + 11 added, every line paired with a near-copy of
    // itself differing by a single `%`.
    const before = [
      '\\section{Projects}',
      '  \\textbf{Startup AI}',
      '  \\begin{highlights}',
      '    \\item Built an ML model.',
      '  \\end{highlights}',
      '\\end{document}',
    ].join('\n');
    const after = [
      '\\section{Projects}',
      '  % \\textbf{Startup AI}',
      '  % \\begin{highlights}',
      '  %   \\item Built an ML model.',
      '  % \\end{highlights}',
      '\\end{document}',
    ].join('\n');

    const folded = fold(before, after);
    expect(diffStat(folded)).toEqual({
      added: 0,
      removed: 0,
      commented: 4,
      uncommented: 0,
    });
    // And it shows the line as it read on the page, not as the comment it became.
    expect(show(folded)).toContain('commented:\\textbf{Startup AI}');
  });

  it('reads an entry put back on the page as uncommented', () => {
    const before = ['\\section{X}', '  % \\textbf{Hooli}', '\\end{document}'].join('\n');
    const after = ['\\section{X}', '  \\textbf{Hooli}', '\\end{document}'].join('\n');
    expect(diffStat(fold(before, after))).toEqual({
      added: 0,
      removed: 0,
      commented: 0,
      uncommented: 1,
    });
  });

  it('leaves a real rewrite alone', () => {
    // Not a comment toggle, so nothing should be folded away.
    const folded = fold('a\nb\nc', 'a\nB\nc');
    expect(diffStat(folded)).toEqual({ added: 1, removed: 1, commented: 0, uncommented: 0 });
  });

  it('does not fold a block that only partly pairs up', () => {
    // One line commented out *and* another genuinely deleted. Folding half of
    // that would report less than actually happened, so the block stays whole.
    const before = ['keep', 'one', 'two', 'end'].join('\n');
    const after = ['keep', '% one', 'end'].join('\n');
    const stat = diffStat(fold(before, after));
    expect(stat.commented).toBe(0);
    expect(stat.removed).toBeGreaterThan(0);
  });

  it('does not fold when the text differs by more than the marker', () => {
    const before = 'the original bullet';
    const after = '% a completely different bullet';
    expect(diffStat(fold(before, after)).commented).toBe(0);
  });

  it('ignores re-indentation around the marker', () => {
    // The marker goes in after the indentation, and indentation shifting around
    // it is not a change worth showing as one.
    const before = '    \\item Something';
    const after = '  % \\item Something';
    expect(diffStat(fold(before, after)).commented).toBe(1);
  });

  it('does not fold a blank line into a comment toggle', () => {
    // "" vs "%" would otherwise pair, and a blank line becoming a bare `%` is
    // not an entry coming off the page.
    expect(diffStat(fold('', '%')).commented).toBe(0);
  });

  it('is a no-op on an unchanged document', () => {
    expect(fold('a\nb', 'a\nb').every((l) => l.kind === 'same')).toBe(true);
  });
});

describe('describeDiff', () => {
  it('says what happened to the page, in the resume s own terms', () => {
    const before = ['\\textbf{A}', '\\textbf{B}'].join('\n');
    const after = ['% \\textbf{A}', '\\textbf{B}'].join('\n');
    expect(describeDiff(foldCommentToggles(diffLines(before, after)))).toBe(
      '1 taken off the page',
    );
  });

  it('leads with what went on the page rather than what came off', () => {
    const lines: DiffLine[] = [
      { kind: 'commented', text: 'x' },
      { kind: 'uncommented', text: 'y' },
      { kind: 'added', text: 'z' },
    ];
    expect(describeDiff(lines)).toBe(
      '1 put back on the page · 1 taken off the page · 1 added',
    );
  });

  it('says so when nothing changed', () => {
    expect(describeDiff(diffLines('a', 'a'))).toBe('No changes');
  });
});
