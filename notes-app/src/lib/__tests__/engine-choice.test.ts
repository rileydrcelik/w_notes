/**
 * Picking the TeX engine.
 *
 * Getting this wrong is silent in both directions, and both directions have
 * already bitten this project: pdfLaTeX on a fontspec document is a hard failure
 * with a confusing message, and XeLaTeX on an ordinary template skips its
 * `\ifPDFTeX` font setup and renders a different-looking, longer document that
 * nothing reports as an error.
 *
 * So detection only answers the question with an unambiguous answer — "would
 * this fail outright under pdfTeX?" — and everything else is pdfLaTeX, which is
 * what Overleaf runs and therefore what the document was written against.
 */
import { describe, expect, it } from 'vitest';

import { detectEngine, engineLabel, resolveEngine } from '@/lib/latex/engine-choice';

const PLAIN = '\\documentclass{article}\\begin{document}Riley\\end{document}';

describe('detectEngine', () => {
  it('defaults to the engine Overleaf uses', () => {
    expect(detectEngine(PLAIN)).toBe('pdflatex');
  });

  it('picks XeLaTeX for fontspec, which pdfTeX cannot run at all', () => {
    expect(detectEngine('\\usepackage{fontspec}')).toBe('xelatex');
  });

  it('picks XeLaTeX when fontspec is loaded with options', () => {
    expect(detectEngine('\\usepackage[no-math]{fontspec}')).toBe('xelatex');
  });

  it('picks XeLaTeX when fontspec rides in with another package', () => {
    expect(detectEngine('\\usepackage{unicode-math}')).toBe('xelatex');
  });

  it.each(['\\setmainfont{Carlito}', '\\setsansfont{Lato}', '\\newfontfamily\\x{Roboto}'])(
    'picks XeLaTeX for %s',
    (line) => {
      expect(detectEngine(line)).toBe('xelatex');
    },
  );

  // Templates are full of commented-out alternatives. Reading one as live code
  // would switch a working resume onto the other engine and change how it looks.
  it('ignores a commented-out font setup', () => {
    expect(detectEngine(`${PLAIN}\n% \\setmainfont{Calibri}`)).toBe('pdflatex');
  });

  it('still sees a font setup after an escaped percent sign', () => {
    expect(detectEngine('100\\% done\n\\setmainfont{Carlito}')).toBe('xelatex');
  });

  // The pdfTeX-only side of the same coin: RenderCV's preamble is full of
  // `\ifPDFTeX`, and it must not be mistaken for a reason to leave pdfLaTeX.
  it('leaves a RenderCV-style preamble on pdfLaTeX', () => {
    const preamble = [
      '\\usepackage{iftex}',
      '\\ifPDFTeX',
      '  \\input{glyphtounicode}',
      '  \\usepackage[scaled]{helvet}',
      '  \\renewcommand\\familydefault{\\sfdefault}',
      '\\fi',
    ].join('\n');
    expect(detectEngine(preamble)).toBe('pdflatex');
  });
});

describe('resolveEngine', () => {
  it('uses the detected engine when the note has no preference', () => {
    expect(resolveEngine('\\usepackage{fontspec}', null)).toBe('xelatex');
  });

  it('lets an explicit choice win over detection', () => {
    expect(resolveEngine('\\usepackage{fontspec}', 'pdflatex')).toBe('pdflatex');
    expect(resolveEngine(PLAIN, 'xelatex')).toBe('xelatex');
  });
});

describe('engineLabel', () => {
  it('spells the engines the way their documentation does', () => {
    expect(engineLabel('pdflatex')).toBe('pdfLaTeX');
    expect(engineLabel('xelatex')).toBe('XeLaTeX');
  });
});
