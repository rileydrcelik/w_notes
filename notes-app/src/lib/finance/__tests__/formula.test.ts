/**
 * The formula engine. The sharp edges here are the ones that would corrupt a
 * user's numbers silently rather than visibly: a reference cycle that hangs the
 * UI, a range that reads the wrong cells, and a stray text label inside a summed
 * column. Everything must degrade to an error *value*, never an exception.
 */
import { describe, expect, it } from 'vitest';

import {
  addressToRef,
  columnIndex,
  columnLabel,
  evaluateFormula,
  refToAddress,
  type CellValue,
} from '@/lib/finance/formula';

const bounds = { rows: 10, cols: 6 };

/** Resolver over a literal grid, indexed `[row][col]`. Blanks read as ''. */
const grid =
  (rows: CellValue[][]) =>
  (row: number, col: number): CellValue =>
    rows[row]?.[col] ?? '';

const evalWith = (src: string, rows: CellValue[][] = []) =>
  evaluateFormula(src, grid(rows), bounds);

describe('column labels', () => {
  it('round-trips single and multi-letter columns', () => {
    expect(columnLabel(0)).toBe('A');
    expect(columnLabel(25)).toBe('Z');
    expect(columnLabel(26)).toBe('AA');
    expect(columnLabel(51)).toBe('AZ');
    for (const i of [0, 25, 26, 51, 200]) expect(columnIndex(columnLabel(i))).toBe(i);
  });
});

describe('cell references', () => {
  it('parses A1 notation as 1-based rows', () => {
    expect(refToAddress('B2')).toEqual({ row: 1, col: 1 });
    expect(refToAddress('A1')).toEqual({ row: 0, col: 0 });
    expect(refToAddress('AA10')).toEqual({ row: 9, col: 26 });
  });

  it('accepts absolute refs, since pasted formulas carry them', () => {
    expect(refToAddress('$B$2')).toEqual({ row: 1, col: 1 });
  });

  it('rejects a non-reference', () => {
    expect(refToAddress('SUM')).toBeNull();
    expect(refToAddress('2B')).toBeNull();
  });

  it('renders back to A1 notation', () => {
    expect(addressToRef(1, 1)).toBe('B2');
  });
});

describe('arithmetic', () => {
  it('evaluates the four operators with correct precedence', () => {
    expect(evalWith('=2+3*4')).toBe(14);
    expect(evalWith('=(2+3)*4')).toBe(20);
    expect(evalWith('=10-4-3')).toBe(3); // left-associative, not 9
    expect(evalWith('=100/5/2')).toBe(10);
  });

  it('handles unary minus and decimals', () => {
    expect(evalWith('=-5+2')).toBe(-3);
    expect(evalWith('=1.5*2')).toBe(3);
    expect(evalWith('=.5+.5')).toBe(1);
  });

  it('reads cell references', () => {
    expect(evalWith('=B1+B2*2', [[0, 5], [0, 10]])).toBe(25);
  });

  it('treats a blank cell as zero but a label as #VALUE!', () => {
    expect(evalWith('=A1+5', [[]])).toBe(5);
    expect(evalWith('=A1+5', [['Rent']])).toEqual({ error: '#VALUE!' });
  });

  it('reports division by zero rather than returning Infinity', () => {
    expect(evalWith('=1/0')).toEqual({ error: '#DIV/0!' });
    expect(evalWith('=1/A1', [[]])).toEqual({ error: '#DIV/0!' });
  });
});

describe('aggregates', () => {
  const sheet: CellValue[][] = [
    ['Rent', 1200],
    ['Food', 450],
    ['Travel', 300],
  ];

  it('sums a range', () => {
    expect(evalWith('=SUM(B1:B3)', sheet)).toBe(1950);
  });

  it('sums a range written bottom-to-top the same way', () => {
    expect(evalWith('=SUM(B3:B1)', sheet)).toBe(1950);
  });

  it('skips labels inside the range instead of erroring', () => {
    // A header row above the numbers is the common case and must not break it.
    expect(evalWith('=SUM(A1:B3)', sheet)).toBe(1950);
  });

  it('mixes scalars, refs and ranges in one call', () => {
    expect(evalWith('=SUM(B1:B2, B3, 50)', sheet)).toBe(2000);
  });

  it('computes AVERAGE, COUNT, MIN and MAX over numbers only', () => {
    expect(evalWith('=AVERAGE(B1:B3)', sheet)).toBe(650);
    expect(evalWith('=COUNT(A1:B3)', sheet)).toBe(3);
    expect(evalWith('=MIN(B1:B3)', sheet)).toBe(300);
    expect(evalWith('=MAX(B1:B3)', sheet)).toBe(1200);
  });

  it('reads a whole-column range, clamped to the sheet height', () => {
    expect(evalWith('=SUM(B:B)', sheet)).toBe(1950);
    expect(evalWith('=COUNT(B:B)', sheet)).toBe(3);
  });

  it('clamps an oversized range to the sheet instead of hanging', () => {
    // Pasting a real Excel whole-column formula, or a very wide range, must not
    // loop millions of times on the JS thread. Both bounds have to be clamped:
    // the row bound here is finite, so the open-ended-range clamp alone misses it.
    const started = Date.now();
    expect(evalWith('=SUM(B1:B1048576)', sheet)).toBe(1950);
    expect(evalWith('=SUM(A1:ZZZZZ1048576)', sheet)).toBe(1950);
    expect(evalWith('=COUNT(A:ZZZZZ)', sheet)).toBe(3);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reports a range starting past the grid as #REF!', () => {
    expect(evalWith('=SUM(A99:A200)', sheet)).toEqual({ error: '#REF!' });
    expect(evalWith('=SUM(ZZ1:ZZ9)', sheet)).toEqual({ error: '#REF!' });
  });

  it('averages an empty range to #DIV/0! rather than NaN', () => {
    expect(evalWith('=AVERAGE(A1:A3)', [[]])).toEqual({ error: '#DIV/0!' });
  });

  it('nests calls', () => {
    expect(evalWith('=SUM(B1:B2)/COUNT(B1:B2)', sheet)).toBe(825);
  });
});

describe('errors', () => {
  it('names an unknown function', () => {
    expect(evalWith('=VLOOKUP(A1)')).toEqual({ error: '#NAME?' });
  });

  it('reports malformed source without throwing', () => {
    for (const src of ['=1+', '=(1+2', '=SUM(', '=**', '=1.2.3', '="unterminated']) {
      expect(evaluateFormula(src, grid([]), bounds)).toEqual({ error: '#PARSE!' });
    }
  });

  it('rejects a bare range used as a scalar', () => {
    expect(evalWith('=A1:A3')).toEqual({ error: '#VALUE!' });
    expect(evalWith('=A1:A3+1')).toEqual({ error: '#VALUE!' });
  });

  it('propagates an error from a referenced cell', () => {
    expect(evalWith('=A1+1', [[{ error: '#DIV/0!' }]])).toEqual({ error: '#DIV/0!' });
  });

  it('treats an empty formula as blank', () => {
    expect(evalWith('=')).toBe('');
  });

  it('accepts source with or without the leading =', () => {
    expect(evalWith('SUM(B1:B1)', [[0, 7]])).toBe(7);
  });
});

describe('string literals', () => {
  it('evaluates a quoted string, unescaping doubled quotes', () => {
    expect(evalWith('="hello"')).toBe('hello');
    expect(evalWith('="say ""hi"""')).toBe('say "hi"');
  });
});
