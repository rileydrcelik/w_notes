/**
 * The spreadsheet formula engine for finance notes.
 *
 * Deliberately hand-rolled rather than pulled from a library: the surface we
 * need — cell refs, ranges, arithmetic, and a handful of aggregates — is small
 * enough that a general-purpose expression package would cost more in bundle
 * size and parity risk than it saves. This module is pure TypeScript with no
 * platform APIs, so native and web share it verbatim and there is no
 * `.native`/`.web` pair to drift.
 *
 * Nothing here throws. Every failure becomes an error *value* (`#DIV/0!`,
 * `#CIRC!`, …) that renders in its own cell, so one bad formula can't blank the
 * sheet — the same "isolate, don't poison" instinct as the per-row savepoints in
 * the sync backend.
 *
 * Formulas are stored as the text the user typed and evaluated fresh on every
 * device. Computed results are never persisted or synced: trusting a value off
 * the wire would let a change to this file silently disagree with numbers an
 * older app version wrote.
 */

/** A formula failure, rendered in the cell in place of a value. */
export type FormulaError =
  | '#REF!'
  | '#DIV/0!'
  | '#VALUE!'
  | '#CIRC!'
  | '#NAME?'
  | '#PARSE!';

/** What a cell evaluates to: a number, a text label, or an error marker. */
export type CellValue = number | string | { error: FormulaError };

/** Narrows a value to the error case. */
export function isFormulaError(v: CellValue): v is { error: FormulaError } {
  return typeof v === 'object' && v !== null && 'error' in v;
}

const err = (error: FormulaError): { error: FormulaError } => ({ error });

// ---- Cell addressing ----

/** `0` -> `A`, `25` -> `Z`, `26` -> `AA`. Used by the grid header and CSV. */
export function columnLabel(index: number): string {
  let out = '';
  let n = index;
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

/** `A` -> `0`, `Z` -> `25`, `AA` -> `26`. Case-insensitive. */
export function columnIndex(label: string): number {
  let n = 0;
  for (const ch of label.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** The `'row,col'` key a cell is stored under in `Sheet.cells`. */
export function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

/** Inverse of `cellKey`; returns null for a malformed key. */
export function parseCellKey(key: string): { row: number; col: number } | null {
  const m = /^(\d+),(\d+)$/.exec(key);
  if (!m) return null;
  return { row: Number(m[1]), col: Number(m[2]) };
}

/** `B2` -> `{row: 1, col: 1}`. Human-facing A1 notation is 1-based on rows. */
export function refToAddress(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref.trim());
  if (!m) return null;
  const row = Number(m[2]) - 1;
  if (row < 0) return null;
  return { row, col: columnIndex(m[1]) };
}

/** `{row: 1, col: 1}` -> `B2`, for the formula bar and error messages. */
export function addressToRef(row: number, col: number): string {
  return `${columnLabel(col)}${row + 1}`;
}

// ---- Tokenizer ----

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  /** A bare word: a function name (`SUM`), a cell ref (`B2`), or a column (`B`). */
  | { kind: 'word'; value: string }
  | { kind: 'punct'; value: string };

const PUNCT = new Set(['+', '-', '*', '/', '(', ')', ':', ',']);

/** Splits formula source into tokens. Returns null on an illegal character. */
function tokenize(src: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // Numbers: 42, 3.5, .5 — a leading sign is handled by the parser as unary
    // minus so that `A1-2` reads as a subtraction, not `A1` then `-2`.
    if ((ch >= '0' && ch <= '9') || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      // Reject `1.2.3` rather than letting Number() hand back NaN silently.
      if ((text.match(/\./g) ?? []).length > 1) return null;
      out.push({ kind: 'num', value: Number(text) });
      i = j;
      continue;
    }

    // Double-quoted string literal; `""` is an escaped quote, as in Excel.
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      for (;;) {
        if (j >= src.length) return null; // unterminated
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            text += '"';
            j += 2;
            continue;
          }
          j++;
          break;
        }
        text += src[j];
        j++;
      }
      out.push({ kind: 'str', value: text });
      i = j;
      continue;
    }

    // A word: letters, optional `$` anchors, optional trailing digits. Absolute
    // refs ($B$2) parse and evaluate identically to relative ones — nothing here
    // copies formulas between cells yet, so the anchors are accepted and ignored
    // rather than rejected, which keeps pasted spreadsheet formulas working.
    if (/[A-Za-z$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9$_.]/.test(src[j])) j++;
      out.push({ kind: 'word', value: src.slice(i, j) });
      i = j;
      continue;
    }

    if (PUNCT.has(ch)) {
      out.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }

    return null;
  }
  return out;
}

// ---- Parser ----

/** A range's row bound is open-ended for whole-column refs like `B:B`. */
type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'ref'; row: number; col: number }
  | { kind: 'range'; r0: number; c0: number; r1: number; c1: number }
  | { kind: 'neg'; operand: Expr }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr }
  | { kind: 'call'; name: string; args: Expr[] };

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private eatPunct(value: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'punct' && t.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  /** Entry point. Throws `ParseFailure`; callers convert that to `#PARSE!`. */
  parse(): Expr {
    const e = this.expr();
    if (this.pos !== this.tokens.length) throw new ParseFailure();
    return e;
  }

  private expr(): Expr {
    let left = this.term();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'punct' && (t.value === '+' || t.value === '-')) {
        this.pos++;
        left = { kind: 'bin', op: t.value, left, right: this.term() };
        continue;
      }
      return left;
    }
  }

  private term(): Expr {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'punct' && (t.value === '*' || t.value === '/')) {
        this.pos++;
        left = { kind: 'bin', op: t.value, left, right: this.unary() };
        continue;
      }
      return left;
    }
  }

  private unary(): Expr {
    const t = this.peek();
    if (t?.kind === 'punct' && (t.value === '-' || t.value === '+')) {
      this.pos++;
      const operand = this.unary();
      return t.value === '-' ? { kind: 'neg', operand } : operand;
    }
    return this.primary();
  }

  private primary(): Expr {
    const t = this.peek();
    if (!t) throw new ParseFailure();

    if (t.kind === 'num') {
      this.pos++;
      return { kind: 'num', value: t.value };
    }

    if (t.kind === 'str') {
      this.pos++;
      return { kind: 'str', value: t.value };
    }

    if (t.kind === 'punct' && t.value === '(') {
      this.pos++;
      const inner = this.expr();
      if (!this.eatPunct(')')) throw new ParseFailure();
      return inner;
    }

    if (t.kind === 'word') {
      this.pos++;
      // `SUM(` — a call. Anything else starting with a word is an address.
      const next = this.peek();
      if (next?.kind === 'punct' && next.value === '(') {
        this.pos++;
        const args: Expr[] = [];
        if (!this.eatPunct(')')) {
          for (;;) {
            args.push(this.expr());
            if (this.eatPunct(',')) continue;
            if (this.eatPunct(')')) break;
            throw new ParseFailure();
          }
        }
        return { kind: 'call', name: t.value.toUpperCase(), args };
      }
      return this.address(t.value);
    }

    throw new ParseFailure();
  }

  /**
   * A cell (`B2`), a range (`B2:C9`), or a whole column (`B:B`). Whole-column
   * ranges get an open upper row bound, clamped to the sheet at evaluation time
   * so `=COUNT(B:B)` doesn't depend on how far the grid happens to extend.
   */
  private address(word: string): Expr {
    const isRange = this.peek()?.kind === 'punct' && (this.peek() as Token).value === ':';
    if (!isRange) {
      const addr = refToAddress(word);
      if (!addr) throw new ParseFailure();
      return { kind: 'ref', row: addr.row, col: addr.col };
    }

    this.pos++; // consume ':'
    const rhs = this.peek();
    if (!rhs || rhs.kind !== 'word') throw new ParseFailure();
    this.pos++;

    const a = refToAddress(word);
    const b = refToAddress(rhs.value);
    if (a && b) {
      return {
        kind: 'range',
        r0: Math.min(a.row, b.row),
        c0: Math.min(a.col, b.col),
        r1: Math.max(a.row, b.row),
        c1: Math.max(a.col, b.col),
      };
    }

    // Whole-column form: both sides must be bare column letters (`B:D`).
    const bare = /^\$?[A-Za-z]+$/;
    if (bare.test(word) && bare.test(rhs.value)) {
      const c0 = columnIndex(word.replace(/\$/g, ''));
      const c1 = columnIndex(rhs.value.replace(/\$/g, ''));
      return {
        kind: 'range',
        r0: 0,
        c0: Math.min(c0, c1),
        r1: Number.POSITIVE_INFINITY,
        c1: Math.max(c0, c1),
      };
    }

    throw new ParseFailure();
  }
}

/** Internal control flow only — never escapes this module. */
class ParseFailure extends Error {}

// ---- Evaluation ----

/** Resolves a cell's already-computed value. Out-of-range reads return `''`. */
export type CellResolver = (row: number, col: number) => CellValue;

/** The sheet extent, used to clamp open-ended whole-column ranges. */
export type SheetBounds = { rows: number; cols: number };

/**
 * Coerces a value for arithmetic. Blank reads as 0 (as in Excel, so a formula
 * over a partly-filled column still totals), numeric text converts, and any
 * other text is a `#VALUE!`.
 */
function toNumber(v: CellValue): number | { error: FormulaError } {
  if (typeof v === 'number') return v;
  if (isFormulaError(v)) return v;
  const text = v.trim();
  if (text === '') return 0;
  const n = Number(text);
  return Number.isFinite(n) ? n : err('#VALUE!');
}

/** Aggregates read only genuine numbers; blanks and labels are skipped. */
function numbersIn(
  values: CellValue[],
): number[] | { error: FormulaError } {
  const out: number[] = [];
  for (const v of values) {
    if (isFormulaError(v)) return v;
    if (typeof v === 'number') {
      out.push(v);
      continue;
    }
    const text = v.trim();
    if (text === '') continue;
    const n = Number(text);
    // A stray label inside a summed column is skipped, matching Excel, rather
    // than poisoning the total with #VALUE! — a header row above the range is
    // the common case and shouldn't break the sum.
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function evaluateExpr(
  node: Expr,
  resolve: CellResolver,
  bounds: SheetBounds,
): CellValue | CellValue[] {
  switch (node.kind) {
    case 'num':
      return node.value;

    case 'str':
      return node.value;

    case 'ref': {
      if (node.row < 0 || node.col < 0) return err('#REF!');
      return resolve(node.row, node.col);
    }

    case 'range': {
      // Every bound is clamped to the sheet, not just the open-ended one. An
      // unclamped range is a hang rather than a wrong answer: a formula pasted
      // from a real spreadsheet (`=SUM(A1:A1048576)`) or a wide one
      // (`=SUM(A:ZZZZZ)`) would otherwise loop millions of times on the JS
      // thread, which on device reads as a freeze with no way out — results
      // aren't cached, so reopening the note just hangs again.
      const maxRow = Math.max(0, bounds.rows - 1);
      const maxCol = Math.max(0, bounds.cols - 1);
      if (node.r0 < 0 || node.c0 < 0) return err('#REF!');
      // Starting past the grid entirely is a mistake worth reporting, rather
      // than silently summing an empty range to 0.
      if (node.r0 > maxRow || node.c0 > maxCol) return err('#REF!');

      const r1 = Math.min(Number.isFinite(node.r1) ? node.r1 : maxRow, maxRow);
      const c1 = Math.min(node.c1, maxCol);

      const values: CellValue[] = [];
      for (let r = node.r0; r <= r1; r++) {
        for (let c = node.c0; c <= c1; c++) values.push(resolve(r, c));
      }
      return values;
    }

    case 'neg': {
      const inner = evaluateExpr(node.operand, resolve, bounds);
      if (Array.isArray(inner)) return err('#VALUE!');
      const n = toNumber(inner);
      return typeof n === 'number' ? -n : n;
    }

    case 'bin': {
      const l = evaluateExpr(node.left, resolve, bounds);
      const r = evaluateExpr(node.right, resolve, bounds);
      // A bare range in arithmetic (`=A1:A3 + 1`) has no scalar meaning.
      if (Array.isArray(l) || Array.isArray(r)) return err('#VALUE!');
      const ln = toNumber(l);
      if (typeof ln !== 'number') return ln;
      const rn = toNumber(r);
      if (typeof rn !== 'number') return rn;
      switch (node.op) {
        case '+':
          return ln + rn;
        case '-':
          return ln - rn;
        case '*':
          return ln * rn;
        case '/':
          return rn === 0 ? err('#DIV/0!') : ln / rn;
      }
      return err('#PARSE!');
    }

    case 'call':
      return evaluateCall(node, resolve, bounds);
  }
}

function evaluateCall(
  node: Extract<Expr, { kind: 'call' }>,
  resolve: CellResolver,
  bounds: SheetBounds,
): CellValue {
  // Flatten every argument, so SUM(A1, B1:B4, 10) works like the real thing.
  const flat: CellValue[] = [];
  for (const arg of node.args) {
    const v = evaluateExpr(arg, resolve, bounds);
    if (Array.isArray(v)) flat.push(...v);
    else flat.push(v);
  }

  const nums = numbersIn(flat);
  if (!Array.isArray(nums)) return nums;

  switch (node.name) {
    case 'SUM':
      return nums.reduce((a, b) => a + b, 0);

    case 'AVERAGE':
      return nums.length === 0 ? err('#DIV/0!') : nums.reduce((a, b) => a + b, 0) / nums.length;

    case 'COUNT':
      return nums.length;

    // Excel answers 0 for MIN/MAX over an empty range rather than erroring;
    // matching that keeps a fresh sheet from filling with error markers.
    case 'MIN':
      return nums.length === 0 ? 0 : Math.min(...nums);

    case 'MAX':
      return nums.length === 0 ? 0 : Math.max(...nums);

    default:
      return err('#NAME?');
  }
}

/**
 * Evaluates one formula's source (with or without its leading `=`) against a
 * resolver. Total: a malformed formula yields `#PARSE!` rather than throwing.
 */
export function evaluateFormula(
  source: string,
  resolve: CellResolver,
  bounds: SheetBounds,
): CellValue {
  const body = source.startsWith('=') ? source.slice(1) : source;
  if (body.trim() === '') return '';

  const tokens = tokenize(body);
  if (!tokens) return err('#PARSE!');

  let ast: Expr;
  try {
    ast = new Parser(tokens).parse();
  } catch {
    return err('#PARSE!');
  }

  const value = evaluateExpr(ast, resolve, bounds);
  // A range as the whole formula (`=A1:A3`) has no single value.
  return Array.isArray(value) ? err('#VALUE!') : value;
}
