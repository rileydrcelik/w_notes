/**
 * Reading substituted fonts out of a TeX log.
 *
 * This is the warning that cost an evening: a resume asking for Helvetica under
 * the wrong engine compiles *successfully* in Latin Modern, a page longer, and
 * announces it only as one line in a log nobody opens because nothing failed.
 * Surfacing it depends entirely on this parse.
 */
import { describe, expect, it } from 'vitest';

import { fontSubstitutions, summarizeFontSubstitutions } from '@/lib/latex/log';

// Verbatim from the log that started all this: a RenderCV resume compiled with
// XeLaTeX, where `helvet` declares no shape for XeTeX's TU encoding.
const REAL_LOG = `
LaTeX Font Warning: Font shape \`TU/phv/m/n' undefined
(Font)              using \`TU/lmr/m/n' instead on input line 116.
LaTeX Font Warning: Font shape \`TU/phv/b/n' undefined
(Font)              using \`TU/lmr/b/n' instead on input line 118.
LaTeX Font Warning: Font shape \`TU/phv/m/it' undefined
`;

describe('fontSubstitutions', () => {
  it('finds every font the compile did not get', () => {
    expect(fontSubstitutions(REAL_LOG)).toEqual(['TU/phv/m/n', 'TU/phv/b/n', 'TU/phv/m/it']);
  });

  it('is empty for a log where every font resolved', () => {
    expect(fontSubstitutions('This is pdfTeX\nOutput written on main.pdf (1 page).')).toEqual([]);
  });

  // The *substitute* is also named in the log, on the following line. Reporting
  // it as a missing font would blame Latin Modern for being missing when it is
  // the thing that stepped in.
  it('reports the font that was wanted, not the one that replaced it', () => {
    expect(fontSubstitutions(REAL_LOG)).not.toContain('TU/lmr/m/n');
  });
});

describe('summarizeFontSubstitutions', () => {
  it('says nothing when nothing was substituted', () => {
    expect(summarizeFontSubstitutions([])).toBe('');
  });

  it('collapses the shapes of one family into a single mention', () => {
    const summary = summarizeFontSubstitutions(fontSubstitutions(REAL_LOG));
    expect(summary).toContain('phv');
    // Three shapes of Helvetica are one problem, not three.
    expect(summary.match(/phv/g)).toHaveLength(1);
  });

  it('names several families and counts the rest', () => {
    const summary = summarizeFontSubstitutions([
      'T1/phv/m/n',
      'T1/ppl/m/n',
      'T1/pcr/m/n',
      'T1/bch/m/n',
    ]);
    expect(summary).toContain('and 1 more');
  });
});
