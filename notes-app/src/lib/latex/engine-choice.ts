/**
 * Which engine a resume should compile with.
 *
 * Overleaf makes this a dropdown the author sets once and forgets. We can do
 * better for the common case, because the source says which engine it needs:
 * a document loading `fontspec` cannot run under pdfTeX at all, and everything
 * else was almost certainly written against pdfLaTeX, which is what Overleaf
 * runs unless told otherwise.
 *
 * So the default is detected, and the note can override it — the override is
 * what a document nobody can auto-classify needs, and it's stored on the note
 * so it syncs and survives.
 *
 * Detection is deliberately narrow. It only asks "would this fail outright
 * under pdfTeX?", because that is the one question with an unambiguous answer.
 * Guessing more than that would silently change how a document renders, which
 * is the exact failure this whole subsystem exists to stop.
 */
import type { LatexEngine } from '@/lib/latex/types';

/** What a resume note stores. `null`/absent means "decide from the source". */
export type EnginePreference = LatexEngine | null;

/**
 * Loading fontspec, or setting a font through it. These are XeTeX/LuaTeX-only —
 * under pdfTeX they are an immediate error, not a difference of opinion.
 *
 * `\usepackage[...]{fontspec}` with options counts, hence the optional bracket
 * group; `unicode-math` and `polyglossia` pull fontspec in themselves.
 */
const XETEX_ONLY =
  /\\(usepackage|RequirePackage)\s*(\[[^\]]*\])?\s*\{[^}]*\b(fontspec|unicode-math|polyglossia)\b[^}]*\}|\\set(main|sans|mono|math)font\b|\\newfontfamily\b/;

/** Strip comments before matching, so a commented-out `\setmainfont` isn't read as one. */
function withoutComments(source: string): string {
  // A `%` escaped as `\%` is a literal percent sign, not a comment.
  return source.replace(/(^|[^\\])%.*$/gm, '$1');
}

/** The engine this source needs, ignoring any preference. */
export function detectEngine(source: string): LatexEngine {
  return XETEX_ONLY.test(withoutComments(source)) ? 'xelatex' : 'pdflatex';
}

/**
 * The engine to compile with: the note's choice if it made one, otherwise the
 * one its source implies.
 */
export function resolveEngine(source: string, preference: EnginePreference): LatexEngine {
  return preference ?? detectEngine(source);
}

/** Human label for the engine picker. */
export function engineLabel(engine: LatexEngine): string {
  return engine === 'xelatex' ? 'XeLaTeX' : 'pdfLaTeX';
}
