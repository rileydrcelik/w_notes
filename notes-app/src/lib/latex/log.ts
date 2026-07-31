/**
 * Turns a TeX log into something a person can act on.
 *
 * A failed run prints hundreds of lines and buries the cause in two of them: a
 * `! …` message, and a `l.<n> …` marker naming the source line. This pulls those
 * out so the editor can say "Line 12: File `enumitem.sty' not found" instead of
 * dumping the whole log at the user.
 *
 * Two shapes arrive, because the server returns Tectonic's console output *and*
 * the TeX log file it wrote:
 *
 *   error: main.tex:4: ! LaTeX Error: File `x.sty' not found.   <- Tectonic
 *   ! ! LaTeX Error: File `x.sty' not found..                   <- the log file
 *   l.4 egin
 *
 * The first is better — it carries the line inline. The second arrives with its
 * `!` and its full stop doubled, which is why both are normalized away rather
 * than trusted verbatim. Identical errors from the two sources dedupe against
 * each other on the way out.
 *
 * Pure string work, no platform dependencies.
 */
import type { CompileDiagnostic } from '@/lib/latex/types';

/**
 * `!` lines TeX emits *about* an error it already reported. Matched against the
 * message with its `! ` stripped, so "! Emergency stop." — which always trails
 * the real cause and names none of it — never becomes a diagnostic of its own.
 */
const NOISE = /^(Emergency stop|==>|Type\s+H\s+<return>|\s*\.\.\.)/;

/** Tectonic's own error line, which names the file and line directly. */
const TECTONIC_ERROR = /^error:\s+[^\s:]+:(\d+):\s*(.+)$/;

/**
 * Strip the decoration TeX and Tectonic add around the same sentence: a repeated
 * leading `!`, and the trailing full stops that get doubled when one log quotes
 * another. Without this the two sources produce two spellings of one error and
 * both survive deduplication.
 */
function normalize(message: string): string {
  return message
    .replace(/^(?:!\s*)+/, '')
    .trim()
    .replace(/\.+$/, '')
    .trim();
}

/**
 * Extract the errors from a TeX log, in order, deduplicated by message+line.
 * Returns an empty array when the log holds no `!` lines (a compile that failed
 * for a non-TeX reason — a dead package fetch, say).
 */
export function parseTexLog(log: string): CompileDiagnostic[] {
  const lines = log.split('\n');
  const out: CompileDiagnostic[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    // Strip the worker's `[TeX] ` prefix when the log came through onLog.
    const text = line.replace(/^\[TeX(?: ERR)?\]\s?/, '');

    // A `l.<n>` marker names the source line of the error TeX is still working
    // through, so it belongs to the most recent diagnostic that hasn't got one.
    // It is NOT always within a line or two of that error: a missing package
    // prints the message, then a prompt, then "! Emergency stop.", and only then
    // the `l.<n>` — which is why this is a running attachment rather than a
    // fixed lookahead from the message.
    // Tectonic's form carries the source line with the message, so it needs no
    // `l.<n>` marker to pair with later.
    const tectonic = text.match(TECTONIC_ERROR);
    if (tectonic) {
      const message = normalize(tectonic[2]);
      if (message && !NOISE.test(message)) {
        out.push({ message, line: Number(tectonic[1]) });
      }
      continue;
    }

    const marker = text.match(/^l\.(\d+)/);
    if (marker) {
      const pending = out.findLast((d) => d.line === undefined);
      if (pending) pending.line = Number(marker[1]);
      continue;
    }

    if (!text.startsWith('! ')) continue;
    const message = normalize(text.slice(2));
    if (!message || NOISE.test(message)) continue;
    out.push({ message });
  }

  // Deduplicate only once every line is known — the same message can appear
  // twice in a multi-pass run.
  return out.filter((d) => {
    const key = `${d.message}@${d.line ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A one-line summary for the error banner: the first diagnostic, prefixed with
 * its source line when TeX knew one. Falls back to a generic message so the UI
 * always has something to show.
 */
/**
 * `LaTeX Font Warning: Font shape 'TU/phv/m/n' undefined` — the encoding/family
 * TeX wanted, which it then quietly replaced with something else.
 */
const FONT_SUBSTITUTION = /Font shape `([^']+)' undefined/g;

/**
 * Fonts a compile asked for and didn't get.
 *
 * This is the warning that cost this project an evening. A document requesting
 * Helvetica under the wrong engine doesn't fail — it renders in Latin Modern, a
 * page longer, and says so only here, in a log nobody reads because the compile
 * *succeeded*. Anything surfacing it beats reading a TeX log.
 *
 * Returns the distinct NFSS names (`T1/phv/m/n`), most useful first, or an empty
 * array when every font resolved.
 */
export function fontSubstitutions(log: string): string[] {
  const seen = new Set<string>();
  for (const match of log.matchAll(FONT_SUBSTITUTION)) seen.add(match[1]);
  return [...seen];
}

/**
 * A one-line account of substituted fonts, for a chip under a *successful*
 * preview. Names the family rather than the raw NFSS string where it can: "phv"
 * means nothing, "a font it asked for" at least says what happened.
 */
export function summarizeFontSubstitutions(substitutions: string[]): string {
  if (substitutions.length === 0) return '';
  const families = [...new Set(substitutions.map((s) => s.split('/')[1] ?? s))];
  const list = families.slice(0, 3).join(', ');
  const rest = families.length > 3 ? ` and ${families.length - 3} more` : '';
  return families.length === 1
    ? `A font this resume asked for (${list}) isn't available, so it was substituted.`
    : `Fonts this resume asked for (${list}${rest}) aren't available, so they were substituted.`;
}

export function summarizeDiagnostics(diagnostics: CompileDiagnostic[]): string {
  const first = diagnostics[0];
  if (!first) return 'The resume could not be compiled.';
  return first.line === undefined ? first.message : `Line ${first.line}: ${first.message}`;
}
