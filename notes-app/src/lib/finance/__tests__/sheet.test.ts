/**
 * The finance sheet document: its codec, its evaluation pass, and the selection
 * transforms.
 *
 * Two of these tests guard against silent data loss rather than a visible bug,
 * and are the reason to be careful editing `sheet.ts`:
 *  - unknown keys must survive a parse/serialize round trip, or an older app
 *    version strips fields a newer one wrote, on every edit, with no error;
 *  - a reference cycle must resolve to #CIRC!, or the render pass never returns.
 */
import { describe, expect, it } from 'vitest';

import { cellKey } from '@/lib/finance/formula';
import {
  MAX_COLS,
  MAX_ROWS,
  applyStyle,
  cellKind,
  clearCells,
  clearFormatting,
  emptySheet,
  evaluateSheet,
  formatValue,
  getCell,
  isSheetEmpty,
  normalizeSelection,
  parseSheet,
  readableTextColor,
  resizeSheet,
  selectionContains,
  selectionHasStyle,
  serializeSheet,
  setCellRaw,
  type Sheet,
} from '@/lib/finance/sheet';

/** Builds a sheet from a literal grid of raw cell strings. */
function sheetOf(rows: string[][]): Sheet {
  const cells: Sheet['cells'] = {};
  rows.forEach((row, r) =>
    row.forEach((raw, c) => {
      if (raw !== '') cells[cellKey(r, c)] = { raw };
    }),
  );
  return { version: 1, rows: Math.max(rows.length, 5), cols: 5, cells };
}

const valueAt = (sheet: Sheet, row: number, col: number) =>
  formatValue(evaluateSheet(sheet).get(cellKey(row, col)));

describe('parseSheet', () => {
  it('returns an empty sheet for missing or corrupt JSON', () => {
    for (const input of [null, undefined, '', 'not json', '[]', '"str"', '42']) {
      expect(parseSheet(input).cells).toEqual({});
    }
  });

  it('round-trips a real document', () => {
    const sheet = setCellRaw(emptySheet(), 1, 1, '=SUM(A1:A3)');
    expect(parseSheet(serializeSheet(sheet))).toEqual(sheet);
  });

  it('preserves keys it does not recognise, at both levels', () => {
    // A newer app version wrote `frozenRows` and a per-cell `note`. Parsing and
    // re-serializing here must not drop either, or that version loses data every
    // time this one saves.
    const json = JSON.stringify({
      version: 1,
      rows: 10,
      cols: 4,
      frozenRows: 2,
      cells: { '0,0': { raw: '5', note: 'from the future', style: { bg: '#fff' } } },
    });

    const parsed = parseSheet(json);
    expect(parsed.frozenRows).toBe(2);
    expect(getCell(parsed, 0, 0)?.note).toBe('from the future');

    const reparsed = parseSheet(serializeSheet(parsed));
    expect(reparsed.frozenRows).toBe(2);
    expect(getCell(reparsed, 0, 0)?.note).toBe('from the future');
  });

  it('survives an unknown key through a style edit', () => {
    const parsed = parseSheet(
      JSON.stringify({ version: 1, rows: 5, cols: 5, cells: { '0,0': { raw: '5', note: 'keep' } } }),
    );
    const bolded = applyStyle(parsed, { r0: 0, c0: 0, r1: 0, c1: 0 }, { bold: true });
    expect(getCell(bolded, 0, 0)?.note).toBe('keep');
  });

  it('drops malformed cell entries without discarding the sheet', () => {
    const parsed = parseSheet(
      JSON.stringify({
        version: 1,
        rows: 5,
        cols: 5,
        cells: { '0,0': { raw: 'ok' }, bogus: { raw: 'x' }, '1,1': 'not an object' },
      }),
    );
    expect(getCell(parsed, 0, 0)?.raw).toBe('ok');
    expect(Object.keys(parsed.cells)).toEqual(['0,0']);
  });

  it('clamps an out-of-range or hostile grid size', () => {
    const huge = parseSheet(JSON.stringify({ rows: 999999, cols: 999999, cells: {} }));
    expect(huge.rows).toBe(MAX_ROWS);
    expect(huge.cols).toBe(MAX_COLS);

    const negative = parseSheet(JSON.stringify({ rows: -5, cols: 0, cells: {} }));
    expect(negative.rows).toBeGreaterThan(0);
    expect(negative.cols).toBeGreaterThan(0);
  });
});

describe('cellKind', () => {
  it('classifies by content', () => {
    expect(cellKind(undefined)).toBe('empty');
    expect(cellKind({ raw: '   ' })).toBe('empty');
    expect(cellKind({ raw: '=SUM(A1:A2)' })).toBe('formula');
    expect(cellKind({ raw: '42' })).toBe('number');
    expect(cellKind({ raw: '-3.5' })).toBe('number');
    expect(cellKind({ raw: 'Rent' })).toBe('text');
  });

  it('sees through rich-text markup to classify a number', () => {
    expect(cellKind({ raw: '<p><b>1200</b></p>' })).toBe('number');
    expect(cellKind({ raw: '<p>Rent</p>' })).toBe('text');
  });
});

describe('evaluateSheet', () => {
  it('computes formulas against other cells', () => {
    const sheet = sheetOf([
      ['Rent', '1200'],
      ['Food', '450'],
      ['Total', '=SUM(B1:B2)'],
    ]);
    expect(valueAt(sheet, 2, 1)).toBe('1650');
  });

  it('resolves a formula that depends on another formula', () => {
    const sheet = sheetOf([['2'], ['=A1*3'], ['=A2+1']]);
    expect(valueAt(sheet, 2, 0)).toBe('7');
  });

  it('reports a direct reference cycle as #CIRC! instead of hanging', () => {
    expect(valueAt(sheetOf([['=A1']]), 0, 0)).toBe('#CIRC!');
  });

  it('reports an indirect reference cycle as #CIRC!', () => {
    // A1 -> B1 -> A1. Without the visiting set this recurses until the stack dies.
    const sheet = sheetOf([['=B1', '=A1']]);
    expect(valueAt(sheet, 0, 0)).toBe('#CIRC!');
  });

  it('keeps evaluating unrelated cells after a cycle', () => {
    const sheet = sheetOf([['=A1'], ['5'], ['=A2+1']]);
    expect(valueAt(sheet, 0, 0)).toBe('#CIRC!');
    expect(valueAt(sheet, 2, 0)).toBe('6');
  });

  it('reads rich-text number cells as numbers', () => {
    const sheet = sheetOf([['<p>10</p>'], ['<p><b>5</b></p>'], ['=SUM(A1:A2)']]);
    expect(valueAt(sheet, 2, 0)).toBe('15');
  });
});

describe('formatValue', () => {
  it('renders errors, numbers and text', () => {
    expect(formatValue({ error: '#DIV/0!' })).toBe('#DIV/0!');
    expect(formatValue(42)).toBe('42');
    expect(formatValue('Rent')).toBe('Rent');
    expect(formatValue(undefined)).toBe('');
  });

  it('trims floating-point noise', () => {
    expect(formatValue(0.1 + 0.2)).toBe('0.3');
  });
});

describe('setCellRaw', () => {
  it('writes and overwrites a cell', () => {
    const sheet = setCellRaw(setCellRaw(emptySheet(), 0, 0, 'a'), 0, 0, 'b');
    expect(getCell(sheet, 0, 0)?.raw).toBe('b');
  });

  it('removes the entry when a cell is emptied, keeping the doc sparse', () => {
    const sheet = setCellRaw(setCellRaw(emptySheet(), 0, 0, 'a'), 0, 0, '');
    expect(getCell(sheet, 0, 0)).toBeUndefined();
  });

  it('keeps an emptied cell that still carries styling', () => {
    const styled = applyStyle(emptySheet(), { r0: 0, c0: 0, r1: 0, c1: 0 }, { bg: '#ff0' });
    const cleared = setCellRaw(styled, 0, 0, '');
    expect(getCell(cleared, 0, 0)?.style?.bg).toBe('#ff0');
  });

  it('does not mutate the input sheet', () => {
    const before = emptySheet();
    setCellRaw(before, 0, 0, 'x');
    expect(before.cells).toEqual({});
  });
});

describe('selection', () => {
  it('normalises a drag made in any direction', () => {
    const expected = { r0: 1, c0: 1, r1: 3, c1: 4 };
    expect(normalizeSelection({ row: 1, col: 1 }, { row: 3, col: 4 })).toEqual(expected);
    expect(normalizeSelection({ row: 3, col: 4 }, { row: 1, col: 1 })).toEqual(expected);
    expect(normalizeSelection({ row: 3, col: 1 }, { row: 1, col: 4 })).toEqual(expected);
  });

  it('tests membership inclusively', () => {
    const sel = { r0: 1, c0: 1, r1: 2, c1: 2 };
    expect(selectionContains(sel, 1, 1)).toBe(true);
    expect(selectionContains(sel, 2, 2)).toBe(true);
    expect(selectionContains(sel, 0, 1)).toBe(false);
    expect(selectionContains(sel, 3, 3)).toBe(false);
  });
});

describe('applyStyle', () => {
  const range = { r0: 0, c0: 0, r1: 1, c1: 1 };

  it('applies to every cell in the selection in one pass', () => {
    const sheet = applyStyle(sheetOf([['a', 'b'], ['c', 'd']]), range, { bold: true });
    for (const [r, c] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      expect(getCell(sheet, r, c)?.style?.bold).toBe(true);
    }
  });

  it('creates blank cells so a highlight on an empty range still shows', () => {
    const sheet = applyStyle(emptySheet(), range, { bg: '#ffef9f' });
    expect(getCell(sheet, 1, 1)?.style?.bg).toBe('#ffef9f');
    expect(getCell(sheet, 1, 1)?.raw).toBe('');
  });

  it('merges with existing style rather than replacing it', () => {
    const bold = applyStyle(sheetOf([['a']]), range, { bold: true });
    const both = applyStyle(bold, range, { color: '#c00' });
    expect(getCell(both, 0, 0)?.style).toMatchObject({ bold: true, color: '#c00' });
  });

  it('clears a mark passed as false or undefined', () => {
    const bold = applyStyle(sheetOf([['a']]), range, { bold: true });
    const plain = applyStyle(bold, range, { bold: false });
    expect(getCell(plain, 0, 0)?.style?.bold).toBeUndefined();
  });

  it('drops a styled-but-empty cell once its last mark is cleared', () => {
    const styled = applyStyle(emptySheet(), { r0: 0, c0: 0, r1: 0, c1: 0 }, { bg: '#ff0' });
    const cleared = applyStyle(styled, { r0: 0, c0: 0, r1: 0, c1: 0 }, { bg: undefined });
    expect(getCell(cleared, 0, 0)).toBeUndefined();
  });

  it('keeps content when its last style mark is cleared', () => {
    const styled = applyStyle(sheetOf([['keep']]), { r0: 0, c0: 0, r1: 0, c1: 0 }, { bg: '#ff0' });
    const cleared = applyStyle(styled, { r0: 0, c0: 0, r1: 0, c1: 0 }, { bg: undefined });
    expect(getCell(cleared, 0, 0)?.raw).toBe('keep');
  });
});

describe('selectionHasStyle', () => {
  it('is true only when every cell carries the mark', () => {
    const sel = { r0: 0, c0: 0, r1: 0, c1: 1 };
    const partial = applyStyle(sheetOf([['a', 'b']]), { r0: 0, c0: 0, r1: 0, c1: 0 }, { bold: true });
    expect(selectionHasStyle(partial, sel, 'bold')).toBe(false);

    const full = applyStyle(partial, sel, { bold: true });
    expect(selectionHasStyle(full, sel, 'bold')).toBe(true);
  });
});

describe('clearFormatting', () => {
  const sel = { r0: 0, c0: 0, r1: 0, c1: 1 };

  it('removes styling but keeps the values', () => {
    // The eraser is a formatting control; wiping numbers from it would be
    // unrecoverable, since there's no undo behind it.
    const styled = applyStyle(sheetOf([['Rent', '1200']]), sel, { bold: true, bg: '#ff0' });
    const cleared = clearFormatting(styled, sel);

    expect(getCell(cleared, 0, 0)?.raw).toBe('Rent');
    expect(getCell(cleared, 0, 1)?.raw).toBe('1200');
    expect(getCell(cleared, 0, 0)?.style).toBeUndefined();
    expect(getCell(cleared, 0, 1)?.style).toBeUndefined();
  });

  it('flattens rich markup to plain text', () => {
    const cleared = clearFormatting(sheetOf([['<p><b>Rent</b></p>']]), sel);
    expect(getCell(cleared, 0, 0)?.raw).toBe('Rent');
  });

  it('leaves a formula untouched', () => {
    // Flattening a formula risks mangling it, and it carries no markup anyway.
    const cleared = clearFormatting(sheetOf([['=SUM(B1:B3)']]), sel);
    expect(getCell(cleared, 0, 0)?.raw).toBe('=SUM(B1:B3)');
  });

  it('drops a cell that held only styling', () => {
    const styled = applyStyle(emptySheet(), sel, { bg: '#ff0' });
    expect(getCell(clearFormatting(styled, sel), 0, 0)).toBeUndefined();
  });

  it('leaves cells outside the selection alone', () => {
    const styled = applyStyle(sheetOf([['a', 'b'], ['c', 'd']]), { r0: 0, c0: 0, r1: 1, c1: 1 }, { bold: true });
    const cleared = clearFormatting(styled, sel);
    expect(getCell(cleared, 1, 0)?.style?.bold).toBe(true);
  });
});

describe('clearCells', () => {
  it('removes content and styling across the range only', () => {
    const sheet = applyStyle(sheetOf([['a', 'b'], ['c', 'd']]), { r0: 0, c0: 0, r1: 1, c1: 1 }, { bold: true });
    const cleared = clearCells(sheet, { r0: 0, c0: 0, r1: 0, c1: 1 });
    expect(getCell(cleared, 0, 0)).toBeUndefined();
    expect(getCell(cleared, 0, 1)).toBeUndefined();
    expect(getCell(cleared, 1, 0)?.raw).toBe('c');
  });
});

describe('resizeSheet', () => {
  it('honours the size caps', () => {
    expect(resizeSheet(emptySheet(), 99999, 99999)).toMatchObject({
      rows: MAX_ROWS,
      cols: MAX_COLS,
    });
  });

  it('keeps content that falls outside a shrunk grid', () => {
    // Shrinking then re-growing must not destroy data.
    const filled = setCellRaw(emptySheet(), 10, 4, 'kept');
    const shrunk = resizeSheet(filled, 3, 3);
    expect(getCell(shrunk, 10, 4)?.raw).toBe('kept');
  });

  it('is what makes a cell past the edge count — growth must precede the write', () => {
    // Typing into the grid's trailing ghost row is committed as a resize plus a
    // write. Without the resize the cell is stored but never evaluated, so the
    // value would simply not appear.
    const beyond = setCellRaw(emptySheet(), 0, 0, '=SUM(A2:A3)');
    const written = setCellRaw(beyond, 25, 0, '5');
    expect(evaluateSheet(written).get(cellKey(25, 0))).toBeUndefined();

    const grown = resizeSheet(written, 26, written.cols);
    expect(evaluateSheet(grown).get(cellKey(25, 0))).toBe(5);
  });
});

describe('readableTextColor', () => {
  it('picks dark ink on every highlight swatch the toolbar offers', () => {
    // The bug this guards: a highlighted cell fell back to the theme's text
    // colour, which is near-white in dark mode — invisible on a pale swatch.
    for (const bg of ['#FFEF9F', '#C8E6C9', '#BBDEFB', '#F8BBD0', '#E1BEE7']) {
      expect(readableTextColor(bg)).toBe('#1A1A1A');
    }
  });

  it('picks light ink on a dark background', () => {
    for (const bg of ['#000000', '#1976D2', '#7B1FA2']) {
      expect(readableTextColor(bg)).toBe('#F5F5F5');
    }
  });

  it('accepts shorthand hex and degrades safely on junk', () => {
    expect(readableTextColor('#fff')).toBe('#1A1A1A');
    expect(readableTextColor('#000')).toBe('#F5F5F5');
    expect(readableTextColor('not-a-colour')).toBe('#1A1A1A');
  });
});

describe('isSheetEmpty', () => {
  it('is true for a fresh or purely-styled sheet, false once content exists', () => {
    expect(isSheetEmpty(emptySheet())).toBe(true);
    expect(isSheetEmpty(applyStyle(emptySheet(), { r0: 0, c0: 0, r1: 0, c1: 0 }, { bg: '#ff0' }))).toBe(true);
    expect(isSheetEmpty(setCellRaw(emptySheet(), 0, 0, 'x'))).toBe(false);
  });

  it('is unaffected by the recognised keys, including a colWidths map', () => {
    const sheet: Sheet = { ...emptySheet(), colWidths: { '0': 120, '3': 80 } };
    expect(isSheetEmpty(sheet)).toBe(true);
  });

  it('is never empty when a top-level key this version does not recognise is present', () => {
    const sheet = { ...emptySheet(), fromTheFuture: true } as Sheet;
    expect(isSheetEmpty(sheet)).toBe(false);
  });

  it('is never empty when a cell carries a key this version does not recognise, even with a blank raw', () => {
    const sheet: Sheet = {
      ...emptySheet(),
      cells: { [cellKey(0, 0)]: { raw: '', futureField: 'x' } as Sheet['cells'][string] },
    };
    expect(isSheetEmpty(sheet)).toBe(false);
  });

  it('a document round-tripped through parseSheet with an unknown key is non-empty', () => {
    // parseSheet deliberately spreads unknown top-level keys through (see the
    // module note) rather than dropping them, so this is the realistic path:
    // a newer app version's document, read back by this one.
    const json = JSON.stringify({
      version: 1,
      rows: 5,
      cols: 5,
      cells: {},
      fromTheFuture: 'preserve me',
    });
    expect(isSheetEmpty(parseSheet(json))).toBe(false);
  });
});
