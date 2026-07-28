/**
 * The finance note's spreadsheet document: its shape, its codec, and the pure
 * transforms the UI applies to it.
 *
 * The whole sheet is one JSON document synced as a single row. That is a
 * deliberate choice over one synced row per cell: the sync backend upserts rows
 * sequentially, each in its own savepoint, with a per-user advisory lock held
 * across the batch — so a 500-cell paste under a per-cell design would hold that
 * lock across 500 round trips and stall the user's other devices. One row per
 * sheet collapses any edit, however large, into a single upsert. The cost is
 * whole-document last-writer-wins, the same trade note bodies already make.
 *
 * ## Unknown keys must survive
 *
 * Because the document is opaque to SQL, the backend's COALESCE-preserve guard
 * (which stops an older client from nulling a column it doesn't know about)
 * cannot see inside it. An older app version that parsed this into a strict
 * shape and re-serialized would silently drop every field it didn't recognise,
 * on every edit. So `Cell` and `Sheet` carry index signatures and **every**
 * transform in this file spreads the existing object rather than rebuilding it.
 * Do not "clean up" a transform into an explicit object literal — that is the
 * data-loss bug, not a style nit.
 */
import { htmlToPlainText } from '@/lib/html-text';
import {
  cellKey,
  evaluateFormula,
  isFormulaError,
  parseCellKey,
  type CellValue,
} from '@/lib/finance/formula';

/** Per-cell presentation. Colors are hex strings; absent means "inherit". */
export type CellStyle = {
  /** Cell background ("highlight"). */
  bg?: string;
  /** Text color. */
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  align?: 'left' | 'center' | 'right';
  /** Unrecognised keys from a newer app version. See the module note. */
  [extra: string]: unknown;
};

/**
 * One cell. `raw` is exactly what the user committed: a number (`42`), a
 * formula (`=SUM(B2:B5)`), or a text label — which may be the app's canonical
 * rich-text HTML, since label cells are rich-text editable.
 */
export type Cell = {
  raw: string;
  style?: CellStyle;
  /** Unrecognised keys from a newer app version. See the module note. */
  [extra: string]: unknown;
};

export type Sheet = {
  version: number;
  rows: number;
  cols: number;
  /** Sparse — only cells with content or styling get an entry, keyed `'row,col'`. */
  cells: Record<string, Cell>;
  /** Column index (as a string key) to pixel width. */
  colWidths?: Record<string, number>;
  /** Unrecognised keys from a newer app version. See the module note. */
  [extra: string]: unknown;
};

export const SHEET_VERSION = 1;

/** A comfortable starting grid; both axes grow on demand up to the caps below. */
const INITIAL_ROWS = 20;
const INITIAL_COLS = 6;

/**
 * Hard ceilings. The whole document is re-sent on every debounced edit and
 * nothing in the stack caps request size, so an unbounded sheet would quietly
 * turn into a multi-megabyte push on every keystroke-batch.
 */
export const MAX_ROWS = 500;
export const MAX_COLS = 52;

export function emptySheet(): Sheet {
  return { version: SHEET_VERSION, rows: INITIAL_ROWS, cols: INITIAL_COLS, cells: {} };
}

// ---- Codec ----

const clampRows = (n: unknown): number =>
  Math.min(MAX_ROWS, Math.max(1, Math.floor(typeof n === 'number' && n > 0 ? n : INITIAL_ROWS)));
const clampCols = (n: unknown): number =>
  Math.min(MAX_COLS, Math.max(1, Math.floor(typeof n === 'number' && n > 0 ? n : INITIAL_COLS)));

/**
 * Parses a stored document. Never throws and never returns null: a corrupt or
 * truncated blob degrades to an empty sheet rather than dead-ending the screen,
 * matching how the other plugin configs handle malformed JSON.
 */
export function parseSheet(json: string | null | undefined): Sheet {
  if (!json) return emptySheet();
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return emptySheet();
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptySheet();

  const obj = raw as Record<string, unknown>;
  const cells: Record<string, Cell> = {};
  const storedCells = obj.cells;
  if (storedCells && typeof storedCells === 'object' && !Array.isArray(storedCells)) {
    for (const [key, value] of Object.entries(storedCells as Record<string, unknown>)) {
      if (!parseCellKey(key)) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const cell = value as Record<string, unknown>;
      // Spread first so unknown keys ride along; only `raw` is normalised.
      cells[key] = { ...(cell as Cell), raw: typeof cell.raw === 'string' ? cell.raw : '' };
    }
  }

  return {
    // Spread the source document so top-level keys we don't know about survive.
    ...obj,
    version: typeof obj.version === 'number' ? obj.version : SHEET_VERSION,
    rows: clampRows(obj.rows),
    cols: clampCols(obj.cols),
    cells,
  };
}

export function serializeSheet(sheet: Sheet): string {
  return JSON.stringify(sheet);
}

// ---- Cell classification ----

export type CellKind = 'empty' | 'formula' | 'number' | 'text';

/** A cell's raw text as the user would read it, with any rich markup flattened. */
export function cellPlainText(cell: Cell | undefined): string {
  if (!cell) return '';
  return htmlToPlainText(cell.raw ?? '').trim();
}

export function cellKind(cell: Cell | undefined): CellKind {
  if (!cell) return 'empty';
  const raw = (cell.raw ?? '').trim();
  if (raw === '') return 'empty';
  if (raw.startsWith('=')) return 'formula';
  const plain = cellPlainText(cell);
  if (plain === '') return 'empty';
  return Number.isFinite(Number(plain)) ? 'number' : 'text';
}

export const getCell = (sheet: Sheet, row: number, col: number): Cell | undefined =>
  sheet.cells[cellKey(row, col)];

// ---- Evaluation ----

/**
 * Computes every cell's value, resolving formulas against each other.
 *
 * Formula results are memoised within the pass so a range referencing other
 * formulas doesn't re-evaluate them once per reference, and a `visiting` set
 * turns a reference cycle into `#CIRC!` instead of infinite recursion.
 */
export function evaluateSheet(sheet: Sheet): Map<string, CellValue> {
  const computed = new Map<string, CellValue>();
  const visiting = new Set<string>();
  const bounds = { rows: sheet.rows, cols: sheet.cols };

  const resolve = (row: number, col: number): CellValue => {
    const key = cellKey(row, col);
    const cached = computed.get(key);
    if (cached !== undefined) return cached;

    if (visiting.has(key)) return { error: '#CIRC!' };

    const cell = sheet.cells[key];
    const kind = cellKind(cell);

    let value: CellValue;
    if (kind === 'empty') value = '';
    else if (kind === 'number') value = Number(cellPlainText(cell));
    else if (kind === 'text') value = cellPlainText(cell);
    else {
      visiting.add(key);
      try {
        value = evaluateFormula((cell as Cell).raw, resolve, bounds);
      } finally {
        // Always release, so one #CIRC! doesn't mark unrelated later reads.
        visiting.delete(key);
      }
    }

    computed.set(key, value);
    return value;
  };

  for (let r = 0; r < sheet.rows; r++) {
    for (let c = 0; c < sheet.cols; c++) {
      const key = cellKey(r, c);
      if (!computed.has(key) && sheet.cells[key]) resolve(r, c);
    }
  }
  return computed;
}

/** How a computed value renders in a cell (and exports to CSV). */
export function formatValue(value: CellValue | undefined): string {
  if (value === undefined) return '';
  if (isFormulaError(value)) return value.error;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '#VALUE!';
    // Trim floating-point noise (0.1+0.2) without truncating real precision.
    return String(Math.round(value * 1e10) / 1e10);
  }
  return value;
}

// ---- Selection ----

/** An inclusive rectangle of cells, already normalised (`r0 <= r1`). */
export type Selection = { r0: number; c0: number; r1: number; c1: number };

/** Builds a normalised selection from the drag's anchor and current cell. */
export function normalizeSelection(
  anchor: { row: number; col: number },
  focus: { row: number; col: number },
): Selection {
  return {
    r0: Math.min(anchor.row, focus.row),
    c0: Math.min(anchor.col, focus.col),
    r1: Math.max(anchor.row, focus.row),
    c1: Math.max(anchor.col, focus.col),
  };
}

export function selectionContains(sel: Selection, row: number, col: number): boolean {
  return row >= sel.r0 && row <= sel.r1 && col >= sel.c0 && col <= sel.c1;
}

export function selectionCells(sel: Selection): { row: number; col: number }[] {
  const out: { row: number; col: number }[] = [];
  for (let r = sel.r0; r <= sel.r1; r++) {
    for (let c = sel.c0; c <= sel.c1; c++) out.push({ row: r, col: c });
  }
  return out;
}

// ---- Transforms (pure; every one spreads to preserve unknown keys) ----

/** Replaces one cell's raw content, dropping the entry when it empties out. */
export function setCellRaw(sheet: Sheet, row: number, col: number, raw: string): Sheet {
  const key = cellKey(row, col);
  const existing = sheet.cells[key];
  const cells = { ...sheet.cells };

  if (raw.trim() === '' && !existing?.style) delete cells[key];
  else cells[key] = { ...(existing ?? {}), raw };

  return { ...sheet, cells };
}

/**
 * Applies a style patch to every cell in the selection — the "select a range,
 * then hit bold" path. A key set to `undefined` in the patch clears it, so the
 * same call both applies and removes a mark.
 *
 * This is one document mutation for the whole range, which is why a bulk format
 * costs exactly one synced row no matter how many cells it touches.
 */
export function applyStyle(sheet: Sheet, sel: Selection, patch: CellStyle): Sheet {
  const cells = { ...sheet.cells };

  for (const { row, col } of selectionCells(sel)) {
    const key = cellKey(row, col);
    const existing = cells[key];
    const style: CellStyle = { ...(existing?.style ?? {}) };

    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === false || v === '') delete style[k];
      else style[k] = v;
    }

    const hasStyle = Object.keys(style).length > 0;
    if (!existing) {
      // Styling a blank cell still has to create it, or the color vanishes.
      if (hasStyle) cells[key] = { raw: '', style };
      continue;
    }

    if (hasStyle) cells[key] = { ...existing, style };
    else {
      const { style: _dropped, ...rest } = existing;
      // A cleared style on an empty cell leaves nothing worth storing.
      if ((rest.raw ?? '').trim() === '') delete cells[key];
      else cells[key] = rest as Cell;
    }
  }

  return { ...sheet, cells };
}

/**
 * Whether every cell in the selection already has this style mark, so a toolbar
 * button can act as a true toggle (and render its active state).
 */
export function selectionHasStyle(sheet: Sheet, sel: Selection, key: keyof CellStyle): boolean {
  return selectionCells(sel).every(({ row, col }) => {
    const value = getCell(sheet, row, col)?.style?.[key];
    return value !== undefined && value !== false && value !== '';
  });
}

/**
 * Strips formatting across a range, leaving the values alone.
 *
 * Distinct from `clearCells`, which also deletes the content. This is the
 * toolbar's eraser: it should undo what the toolbar applied and nothing more —
 * wiping a user's numbers from a formatting control would be a nasty surprise
 * with no undo behind it.
 *
 * Rich markup in the value is flattened at the same time, so "remove the
 * formatting" also covers markup carried in from a paste rather than leaving
 * cells that still render styled.
 */
export function clearFormatting(sheet: Sheet, sel: Selection): Sheet {
  const cells = { ...sheet.cells };

  for (const { row, col } of selectionCells(sel)) {
    const key = cellKey(row, col);
    const existing = cells[key];
    if (!existing) continue;

    const raw = existing.raw ?? '';
    // A formula is already plain text; flattening would only risk mangling it.
    const plain = raw.trim().startsWith('=') ? raw : htmlToPlainText(raw);

    const { style: _dropped, ...rest } = existing;
    // Nothing left worth storing once both the style and the value are gone.
    if (plain.trim() === '') delete cells[key];
    else cells[key] = { ...rest, raw: plain } as Cell;
  }

  return { ...sheet, cells };
}

/** Clears content and styling across a range, e.g. for a Delete keypress. */
export function clearCells(sheet: Sheet, sel: Selection): Sheet {
  const cells = { ...sheet.cells };
  for (const { row, col } of selectionCells(sel)) delete cells[cellKey(row, col)];
  return { ...sheet, cells };
}

/** Grows the grid, honouring the size caps. */
export function resizeSheet(sheet: Sheet, rows: number, cols: number): Sheet {
  return { ...sheet, rows: clampRows(rows), cols: clampCols(cols) };
}

/**
 * A legible foreground for a highlighted cell.
 *
 * Highlight colours are fixed swatches, but the theme's text colour is not: in
 * dark themes it's near-white, which on a pale yellow highlight is effectively
 * invisible. Highlighting without also picking a text colour is the common
 * path, so the readable colour has to be derived rather than left to the theme.
 *
 * Uses WCAG relative luminance, so it stays correct if the swatch list changes.
 */
export function readableTextColor(background: string): string {
  const hex = background.replace('#', '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return DARK_INK;

  const channel = (offset: number) => {
    const v = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.45 ? DARK_INK : LIGHT_INK;
}

const DARK_INK = '#1A1A1A';
const LIGHT_INK = '#F5F5F5';

/** True once the sheet holds nothing a user typed — used by the empty-note guard. */
export function isSheetEmpty(sheet: Sheet): boolean {
  return Object.values(sheet.cells).every((cell) => (cell.raw ?? '').trim() === '');
}
