/**
 * Helpers for resume plugin notes. A resume note is the one plugin note that
 * still owns its `body`: it holds **LaTeX source**, not the app's canonical
 * rich-text HTML. Nothing may run it through `htmlToPlainText` or a rich-text
 * renderer — hence the `pluginType` branch on the note cards, which keeps a
 * resume out of `TextNoteCard` entirely.
 *
 * The note's `pluginConfig` carries three things, each with its own accessor
 * pair below: which TeX engine to compile with (absent means "decide from the
 * source" — see `lib/latex/engine-choice.ts`), which version of its history is
 * on screen, and which version is its master. Every writer copies the keys it
 * doesn't own through untouched.
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

/**
 * Which version of its history this resume is currently being edited as.
 *
 * Stored on the note rather than in the versions table because it is a property
 * of *this resume*, not of any one snapshot — and because it has to survive a
 * version being deleted, which a foreign key pointing the other way would not.
 * Absent means the resume has no history yet, or is on whatever its history calls
 * the original.
 *
 * Unrecognised values read as `null` for the same reason the engine does: a note
 * written by a newer build should fall back to sane behaviour, not break the
 * screen.
 */
export function resumeCurrentVersionId(
  note: Pick<Note, 'pluginType' | 'pluginConfig'>,
): string | null {
  if (note.pluginType !== 'resume' || !note.pluginConfig) return null;
  try {
    const parsed = JSON.parse(note.pluginConfig) as { versionId?: unknown };
    if (typeof parsed?.versionId === 'string' && parsed.versionId) return parsed.versionId;
  } catch {
    // A corrupt config reads as "no current version".
  }
  return null;
}

/**
 * `pluginConfig` with the current version set (or cleared, for `null`).
 *
 * Every other key is copied through untouched — the engine lives in here too, and
 * a config object that drops what it didn't recognise is how a future field gets
 * deleted by an old screen.
 */
export function resumeConfigWithVersion(
  note: Pick<Note, 'pluginConfig'>,
  versionId: string | null,
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
  if (versionId === null) delete config.versionId;
  else config.versionId = versionId;
  return JSON.stringify(config);
}

/**
 * Which version of its history this resume is *built from* — the master.
 *
 * The one a tailoring starts from, whatever document happens to be on screen.
 * Alongside `versionId` rather than replacing it, because the two answer
 * different questions: `versionId` is "which snapshot am I editing right now"
 * and moves constantly, while this one is a deliberate choice that moves only
 * when someone makes it.
 *
 * On the note, not on the versions table, for the reason
 * `lib/resume-master.ts` spells out at length for the folder-level pointer:
 * one row holding one key means "exactly one master" is structural rather than
 * an invariant anyone has to enforce, and two devices choosing different
 * masters offline is then an ordinary last-writer-wins conflict on one column.
 * A flag on each version row would be two writes that both succeed, leaving a
 * resume with two masters and nothing in the sync protocol able to notice.
 *
 * `plugin_config` is in `_PRESERVE_IF_NULL` on the server
 * (`backend/app/routers/sync.py`), so a build that predates this key cannot
 * null it out by syncing.
 *
 * Absent means "no explicit choice" — see `masterVersion` in
 * `lib/resume-versions.ts`, which falls back to the original.
 */
export function resumeMasterVersionId(
  note: Pick<Note, 'pluginType' | 'pluginConfig'>,
): string | null {
  if (note.pluginType !== 'resume' || !note.pluginConfig) return null;
  try {
    const parsed = JSON.parse(note.pluginConfig) as { masterVersionId?: unknown };
    if (typeof parsed?.masterVersionId === 'string' && parsed.masterVersionId) {
      return parsed.masterVersionId;
    }
  } catch {
    // A corrupt config reads as "no master chosen".
  }
  return null;
}

/**
 * `pluginConfig` with the master version set (or cleared, for `null`).
 *
 * Every other key is copied through untouched — the engine and the current
 * version both live in here, and a config object that drops what it didn't
 * recognise is how a future field gets deleted by an old screen.
 */
export function resumeConfigWithMasterVersion(
  note: Pick<Note, 'pluginConfig'>,
  versionId: string | null,
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
  if (versionId === null) delete config.masterVersionId;
  else config.masterVersionId = versionId;
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
