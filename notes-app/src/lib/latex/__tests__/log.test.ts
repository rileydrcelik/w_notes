/**
 * `parseTexLog` is the only thing standing between a raw pdfTeX log (hundreds
 * of lines) and a usable diagnostic list. These fixtures are lifted from the
 * shape a real failed compile produces: a `! …` message, a `l.<n>` marker a
 * few lines later, and an `! Emergency stop.` banner at the very end that must
 * NOT be reported as its own error.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseTexLog, summarizeDiagnostics } from '@/lib/latex/log';

/** A realistic failed run: a missing package, its source line, then the
 * generic emergency-stop banner TeX always tacks on. */
const MISSING_PACKAGE_LOG = `This is pdfTeX, Version 3.14159265-2.6-1.40.21
entering extended mode
(./resume.tex
LaTeX2e <2020-02-02>
! LaTeX Error: File \`enumitem.sty' not found.

Type X to quit or <RETURN> to proceed,
or enter new name. (Default extension: sty)

Enter file name:
! Emergency stop.
<read *>

l.5 \\usepackage{enumitem}

No pages of output.
Transcript written on resume.log.`;

describe('parseTexLog', () => {
  it('returns no diagnostics for a log with no ! lines', () => {
    expect(parseTexLog('This is pdfTeX\nNo pages of output.')).toEqual([]);
  });

  // This pair caught a real bug when it was written: NOISE was matched against
  // the line *including* its leading `! `, so "! Emergency stop." never matched,
  // survived as a bogus second diagnostic, and stole the `l.5` marker from the
  // error that actually owned it.
  it('pairs a ! message with the l.<n> marker that follows it', () => {
    const diagnostics = parseTexLog(MISSING_PACKAGE_LOG);
    expect(diagnostics).toEqual([
      { message: "LaTeX Error: File `enumitem.sty' not found", line: 5 },
    ]);
  });

  it('does not report "! Emergency stop." as its own diagnostic', () => {
    // If NOISE matched it (as documented — "Lines TeX always emits after a
    // real error; they add nothing to the message"), the array above would
    // have only the one entry. Assert the exact length so the regression is
    // caught, not just the first diagnostic's shape.
    const diagnostics = parseTexLog(MISSING_PACKAGE_LOG);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics.some((d) => d.message.includes('Emergency stop'))).toBe(false);
  });

  it('strips the worker\'s [TeX] / [TeX ERR] prefixes before matching', () => {
    const log = [
      '[TeX] entering extended mode',
      "[TeX ERR] ! Undefined control sequence.",
      '[TeX] l.12 \\foo',
    ].join('\n');
    expect(parseTexLog(log)).toEqual([
      { message: 'Undefined control sequence', line: 12 },
    ]);
  });

  it('dedupes identical message+line pairs', () => {
    const log = [
      '! Undefined control sequence.',
      'l.3 \\foo',
      '! Undefined control sequence.',
      'l.3 \\foo',
    ].join('\n');
    expect(parseTexLog(log)).toHaveLength(1);
  });

  it('keeps two diagnostics with the same message but different lines', () => {
    const log = [
      '! Undefined control sequence.',
      'l.3 \\foo',
      '! Undefined control sequence.',
      'l.9 \\bar',
    ].join('\n');
    expect(parseTexLog(log)).toEqual([
      { message: 'Undefined control sequence', line: 3 },
      { message: 'Undefined control sequence', line: 9 },
    ]);
  });

  it('leaves the line out when no l.<n> marker follows', () => {
    const log = '! Something bad happened.\nNo pages of output.';
    expect(parseTexLog(log)).toEqual([{ message: 'Something bad happened' }]);
  });

  it('attributes a l.<n> marker however far it trails its error', () => {
    // Distance is not the signal: a missing package prints the message, a
    // prompt, "! Emergency stop.", then several lines of context before the
    // marker. The marker belongs to the last error still missing one, whatever
    // sits in between.
    const lines = ['! First error.'];
    for (let i = 0; i < 12; i += 1) lines.push('filler');
    lines.push('l.99 \\faraway');
    expect(parseTexLog(lines.join('\n'))).toEqual([{ message: 'First error', line: 99 }]);
  });

  it('gives a marker to the most recent unattached error, not the oldest', () => {
    // TeX prints the context for the error it is currently on, so when two
    // messages arrive before any marker the line belongs to the second.
    const log = ['! First error.', '! Second error.', 'l.7 \\here'].join('\n');
    expect(parseTexLog(log)).toEqual([
      { message: 'First error' },
      { message: 'Second error', line: 7 },
    ]);
  });

  it('does not let a later marker overwrite an error that already has a line', () => {
    const log = ['! First error.', 'l.1 \\a', '! Second error.', 'l.2 \\b'].join('\n');
    expect(parseTexLog(log)).toEqual([
      { message: 'First error', line: 1 },
      { message: 'Second error', line: 2 },
    ]);
  });

  it('preserves source order across multiple distinct errors', () => {
    const log = [
      '! First error.',
      'l.1 \\a',
      '! Second error.',
      'l.2 \\b',
    ].join('\n');
    expect(parseTexLog(log)).toEqual([
      { message: 'First error', line: 1 },
      { message: 'Second error', line: 2 },
    ]);
  });
});

describe('summarizeDiagnostics', () => {
  it('falls back to a generic message when there are no diagnostics', () => {
    expect(summarizeDiagnostics([])).toBe('The resume could not be compiled.');
  });

  it('prefixes the line number when the first diagnostic has one', () => {
    expect(summarizeDiagnostics([{ message: 'Boom', line: 5 }])).toBe('Line 5: Boom');
  });

  it('omits the line prefix when the first diagnostic has none', () => {
    expect(summarizeDiagnostics([{ message: 'Boom' }])).toBe('Boom');
  });

  it('uses only the first diagnostic, even when several are present', () => {
    expect(
      summarizeDiagnostics([
        { message: 'First', line: 1 },
        { message: 'Second', line: 2 },
      ]),
    ).toBe('Line 1: First');
  });
});

describe('parseTexLog on a log from the real engine', () => {
  // Captured by compiling a document with a missing package inside the actual
  // backend image (Tectonic), not hand-written. It holds both shapes at once:
  // Tectonic's `error: main.tex:4: ! …` console line and the TeX log file's
  // doubled `! ! LaTeX Error: … not found..`, plus a trailing `l.4` marker —
  // and each appears twice, because Tectonic echoes the engine output.
  const log = readFileSync(
    join(__dirname, 'fixtures', 'tectonic-missing-package.log'),
    'utf8',
  );

  it('reports the missing package once, with its source line', () => {
    const diagnostics = parseTexLog(log);
    expect(diagnostics).toEqual([
      { message: "LaTeX Error: File `definitely-not-a-real-package.sty' not found", line: 4 },
    ]);
  });

  it('produces a banner naming the file and line', () => {
    expect(summarizeDiagnostics(parseTexLog(log))).toBe(
      "Line 4: LaTeX Error: File `definitely-not-a-real-package.sty' not found",
    );
  });

  it('reads Tectonic\'s own error line when there is no TeX log to fall back on', () => {
    // The server appends the TeX log file to the console output, but a run that
    // dies early enough never writes one — then Tectonic's `error: file:line:`
    // form is the only thing naming the problem, and it doesn't start with `!`,
    // so the classic parser would find nothing at all.
    const consoleOnly = [
      'note: "version 2" Tectonic command-line interface activated',
      'note: Running TeX ...',
      "error: main.tex:12: ! Undefined control sequence.",
      'error: the XeTeX engine had an unrecoverable error',
    ].join('\n');
    expect(parseTexLog(consoleOnly)).toEqual([
      { message: 'Undefined control sequence', line: 12 },
    ]);
  });
});
