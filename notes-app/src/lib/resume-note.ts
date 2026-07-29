/**
 * Helpers for resume plugin notes. A resume note is the one plugin note that
 * still owns its `body`: it holds **LaTeX source**, not the app's canonical
 * rich-text HTML. Nothing may run it through `htmlToPlainText` or a rich-text
 * renderer — hence the `pluginType` branch on the note cards, which keeps a
 * resume out of `TextNoteCard` entirely.
 *
 * The note's `pluginConfig` carries one thing: which TeX engine to compile with,
 * and only when the author overrode the engine the source implies. Absent means
 * "decide from the source" — see `lib/latex/engine-choice.ts`.
 */
import type { Note } from '@/data/notes';
import type { EnginePreference } from '@/lib/latex/engine-choice';
import type { LatexEngine } from '@/lib/latex/types';

/** True for a resume note (LaTeX body). */
export function isResumeNote(note: Pick<Note, 'pluginType'>): boolean {
  return note.pluginType === 'resume';
}

/**
 * The engine this resume was pinned to, or `null` to let the source decide.
 *
 * Unrecognised values read as `null` rather than throwing: a note written by a
 * newer build (or hand-edited) should fall back to detection, not break the
 * screen.
 */
export function resumeEnginePreference(
  note: Pick<Note, 'pluginType' | 'pluginConfig'>,
): EnginePreference {
  if (note.pluginType !== 'resume' || !note.pluginConfig) return null;
  try {
    const parsed = JSON.parse(note.pluginConfig) as { engine?: unknown };
    if (parsed?.engine === 'pdflatex' || parsed?.engine === 'xelatex') return parsed.engine;
  } catch {
    // fall through to "decide from the source"
  }
  return null;
}

/**
 * `pluginConfig` with the engine set (or cleared, for `null`).
 *
 * Every other key is copied through untouched. Nothing else writes here today,
 * but a config object that silently drops what it didn't recognise is how a
 * future field gets deleted by an old screen — the finance sheet learned that
 * one the expensive way.
 */
export function resumeConfigWithEngine(
  note: Pick<Note, 'pluginConfig'>,
  engine: LatexEngine | null,
): string {
  let config: Record<string, unknown> = {};
  if (note.pluginConfig) {
    try {
      const parsed = JSON.parse(note.pluginConfig) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // A corrupt config is replaced rather than propagated.
    }
  }
  if (engine === null) delete config.engine;
  else config.engine = engine;
  return JSON.stringify(config);
}

/** Display title for an untitled resume, used in headers and filenames. */
export function resumeTitle(note: Pick<Note, 'title'>): string {
  return note.title.trim() || 'Untitled resume';
}

/** A filesystem-safe `.pdf` filename derived from the note's title. */
export function resumePdfFileName(note: Pick<Note, 'title'>): string {
  const base =
    resumeTitle(note)
      // Drop characters that are illegal in file names across platforms.
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'resume';
  return `${base}.pdf`;
}

/**
 * A short plain-text excerpt of the LaTeX source, for the note card preview.
 * Skips comments and the preamble noise (`\documentclass`, `\usepackage`, …)
 * that every template opens with and that says nothing about *this* resume, so
 * the card shows content rather than boilerplate. Returns raw source lines — no
 * HTML is ever involved here.
 */
export function resumeSourceExcerpt(source: string, maxLines = 4): string {
  const skip = /^\\(documentclass|usepackage|input|include|RequirePackage|newcommand|renewcommand|def|title|author|date|pagestyle|geometry|setlength|definecolor|titleformat|titlespacing|begin\{document\}|end\{document\})/;
  const lines: string[] = [];
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('%') || skip.test(line)) continue;
    lines.push(line);
    if (lines.length === maxLines) break;
  }
  return lines.join('\n');
}

/**
 * A minimal single-page resume the user can start from instead of a blank
 * editor. Deliberately plain `article` + `enumitem` + `titlesec` — the shape
 * most pasted templates take — so it compiles quickly and is easy to gut.
 */
export const STARTER_RESUME = String.raw`\documentclass[letterpaper,11pt]{article}
\usepackage[margin=0.75in]{geometry}
\usepackage{enumitem}
\usepackage{titlesec}
\usepackage{hyperref}

\titleformat{\section}{\large\bfseries}{}{0em}{}[\titlerule]
\titlespacing{\section}{0pt}{12pt}{6pt}
\pagestyle{empty}

\begin{document}

\begin{center}
  {\huge \textbf{Your Name}}\\[4pt]
  you@example.com $\cdot$ (555) 555-5555 $\cdot$ City, Country
\end{center}

\section{Experience}
\textbf{Job Title} \hfill 2024--Present\\
\textit{Company} \hfill \textit{City}
\begin{itemize}[leftmargin=*, noitemsep, topsep=4pt]
  \item What you did and what changed because of it.
  \item A second bullet, with a number in it.
\end{itemize}

\section{Education}
\textbf{Degree} \hfill 2020--2024\\
\textit{University} \hfill \textit{City}

\section{Skills}
Languages, tools, and anything else worth listing.

\end{document}
`;
