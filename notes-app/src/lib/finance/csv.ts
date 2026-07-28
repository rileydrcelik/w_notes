/**
 * Turning a finance sheet into a CSV file for "save to device".
 *
 * CSV has no notion of rich text, colors, or formulas, so the export flattens:
 * label cells go through the same `htmlToPlainText` used for note exports and
 * previews, and formula cells export their *computed value* rather than their
 * source — a spreadsheet opened elsewhere should show 1650, not `=SUM(B2:B5)`.
 * Cell highlighting and text colors are dropped outright; that is the accepted
 * trade for a format anything can open.
 *
 * Platform-agnostic on purpose, so the native (share-sheet) and web
 * (anchor-download) savers emit identical bytes — same split as `note-export`.
 */
import type { Note } from '@/data/notes';
import { cellKey } from '@/lib/finance/formula';
import { evaluateSheet, formatValue, parseSheet, type Sheet } from '@/lib/finance/sheet';

/**
 * Escapes one field per RFC 4180: wrap in quotes when it contains a comma,
 * quote, or newline, and double any embedded quotes.
 */
export function escapeCsvField(value: string): string {
  if (value === '') return '';

  // Neutralise formula injection. A label starting with one of these is
  // interpreted as a formula by Excel and Sheets when the file is opened there,
  // so a pasted label could execute in someone else's spreadsheet. Prefixing a
  // tab makes it inert and still displays as text. (`=` can't reach here — a
  // cell whose raw text starts with `=` is a formula and exports its computed
  // value — but it's covered so the rule holds if that ever changes.)
  // A genuine number is exempt, or every negative figure in the sheet would be
  // tab-prefixed and import as text.
  const risky = /^[=+\-@\t\r]/.test(value) && !Number.isFinite(Number(value));
  const safe = risky ? `\t${value}` : value;

  if (/[",\r\n\t]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

/**
 * The sheet as CSV text. Trailing empty rows and columns are trimmed so a
 * mostly-blank 20x6 starter grid doesn't export as a wall of commas, but
 * interior blanks are preserved so cells stay in their original columns.
 */
export function buildSheetCsv(sheet: Sheet): string {
  const computed = evaluateSheet(sheet);

  const cellText = (row: number, col: number): string => {
    const key = cellKey(row, col);
    if (!sheet.cells[key]) return '';
    return formatValue(computed.get(key));
  };

  // Find the used extent so the file matches what the user actually filled in.
  let lastRow = -1;
  let lastCol = -1;
  for (let r = 0; r < sheet.rows; r++) {
    for (let c = 0; c < sheet.cols; c++) {
      if (cellText(r, c) !== '') {
        if (r > lastRow) lastRow = r;
        if (c > lastCol) lastCol = c;
      }
    }
  }
  if (lastRow < 0) return '';

  const lines: string[] = [];
  for (let r = 0; r <= lastRow; r++) {
    const fields: string[] = [];
    for (let c = 0; c <= lastCol; c++) fields.push(escapeCsvField(cellText(r, c)));
    lines.push(fields.join(','));
  }
  // Trailing newline, matching `buildNoteText`.
  return lines.join('\r\n') + '\r\n';
}

/** Reads the note's stored sheet and renders it as CSV. */
export function buildNoteCsv(sheetJson: string | null | undefined): string {
  return buildSheetCsv(parseSheet(sheetJson));
}

/** Display title for an untitled sheet, used in the document and its filename. */
export function sheetFileTitle(note: Pick<Note, 'title'>): string {
  return note.title.trim() || 'Untitled sheet';
}

/** A filesystem-safe `.csv` filename derived from the note's title. */
export function sheetFileName(note: Pick<Note, 'title'>): string {
  const base =
    sheetFileTitle(note)
      // Drop characters that are illegal in file names across platforms.
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'sheet';
  return `${base}.csv`;
}
