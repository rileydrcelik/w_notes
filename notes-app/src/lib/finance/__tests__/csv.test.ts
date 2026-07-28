/**
 * CSV export. The sharp edges are the flattening rules — a formula must export
 * as its computed value and rich text as plain text, or the file opens in a
 * spreadsheet showing markup and `=SUM(...)` instead of numbers — and RFC 4180
 * escaping, where a single missed quote shifts every later column.
 */
import { describe, expect, it } from 'vitest';

import type { Note } from '@/data/notes';
import { cellKey } from '@/lib/finance/formula';
import { buildSheetCsv, escapeCsvField, sheetFileName, sheetFileTitle } from '@/lib/finance/csv';
import type { Sheet } from '@/lib/finance/sheet';

function sheetOf(rows: string[][]): Sheet {
  const cells: Sheet['cells'] = {};
  rows.forEach((row, r) =>
    row.forEach((raw, c) => {
      if (raw !== '') cells[cellKey(r, c)] = { raw };
    }),
  );
  return { version: 1, rows: Math.max(rows.length, 10), cols: 6, cells };
}

describe('escapeCsvField', () => {
  it('leaves a plain field alone', () => {
    expect(escapeCsvField('Rent')).toBe('Rent');
    expect(escapeCsvField('')).toBe('');
  });

  it('neutralises a label that would execute as a formula elsewhere', () => {
    // Excel and Sheets treat a leading =, +, - or @ as a formula when opening a
    // CSV, so a pasted label must not arrive live in someone else's spreadsheet.
    for (const attack of ['+1+1', '@SUM(A1)', '=cmd|calc', '-2+3+cmd']) {
      expect(escapeCsvField(attack).startsWith('"\t')).toBe(true);
    }
  });

  it('leaves a negative number alone', () => {
    // The injection guard must not tab-prefix real figures, or every negative
    // value in the sheet imports as text.
    expect(escapeCsvField('-1200')).toBe('-1200');
    expect(escapeCsvField('-3.5')).toBe('-3.5');
  });

  it('quotes fields containing a comma, quote or newline', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField('two\nlines')).toBe('"two\nlines"');
  });
});

describe('buildSheetCsv', () => {
  it('writes rows and columns in order', () => {
    const csv = buildSheetCsv(sheetOf([
      ['Item', 'Cost'],
      ['Rent', '1200'],
    ]));
    expect(csv).toBe('Item,Cost\r\nRent,1200\r\n');
  });

  it('exports a formula as its computed value, not its source', () => {
    const csv = buildSheetCsv(sheetOf([
      ['Rent', '1200'],
      ['Food', '450'],
      ['Total', '=SUM(B1:B2)'],
    ]));
    expect(csv).toContain('Total,1650');
    expect(csv).not.toContain('SUM');
  });

  it('flattens rich text to plain text', () => {
    const csv = buildSheetCsv(sheetOf([['<p><b>Rent</b></p>', '<p>1200</p>']]));
    expect(csv).toBe('Rent,1200\r\n');
  });

  it('escapes a label containing a comma so columns do not shift', () => {
    const csv = buildSheetCsv(sheetOf([['Rent, London', '1200']]));
    expect(csv).toBe('"Rent, London",1200\r\n');
  });

  it('preserves interior blanks but trims trailing empty rows and columns', () => {
    // The starter grid is 20x6; a two-cell sheet must not export as a wall of commas.
    const csv = buildSheetCsv(sheetOf([['a', '', 'c']]));
    expect(csv).toBe('a,,c\r\n');
  });

  it('returns an empty string for a sheet with nothing in it', () => {
    expect(buildSheetCsv(sheetOf([]))).toBe('');
  });

  it('exports an error value as its marker rather than crashing', () => {
    expect(buildSheetCsv(sheetOf([['=1/0']]))).toBe('#DIV/0!\r\n');
  });
});

describe('filenames', () => {
  const note = (title: string) => ({ title }) as Note;

  it('appends .csv', () => {
    expect(sheetFileName(note('Budget 2026'))).toBe('Budget 2026.csv');
  });

  it('falls back for an untitled sheet', () => {
    expect(sheetFileTitle(note('  '))).toBe('Untitled sheet');
    expect(sheetFileName(note(''))).toBe('Untitled sheet.csv');
  });

  it('strips characters the filesystem rejects', () => {
    expect(sheetFileName(note('Q1/Q2: costs?'))).toBe('Q1Q2 costs.csv');
  });
});
