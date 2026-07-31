/**
 * Shared types for the LaTeX subsystem. Platform-neutral on purpose: the web
 * engine and the (not yet written) native one both speak these shapes, so the
 * screen never learns which is behind it.
 */

/** Coarse progress phases, for a status line while a compile runs. */
export type CompileStage = 'starting' | 'loading' | 'compiling' | 'done';

/**
 * The TeX engines the server offers. Which one runs is visible in the output,
 * so this is a property of the document, not an implementation detail:
 *
 * - `pdflatex` — Overleaf's default, and therefore what a pasted template was
 *   written against. Templates branch on it (`\ifPDFTeX`), so running the wrong
 *   one silently changes the font and the page count.
 * - `xelatex` — required by anything using fontspec or system fonts, which
 *   pdfTeX cannot run at all.
 *
 * Kept in step with `_ENGINE_FLAGS` in `backend/app/routers/latex.py`, which
 * rejects anything else.
 */
export type LatexEngine = 'pdflatex' | 'xelatex';

/** A parsed TeX error: the message, and the source line it points at if known. */
export type CompileDiagnostic = {
  /** The `! …` line from the TeX log, cleaned up. */
  message: string;
  /** 1-based line in the user's source, from the log's `l.<n>` marker. */
  line?: number;
};

export type CompileResult =
  | { ok: true; pdf: Uint8Array; log: string }
  | { ok: false; log: string; diagnostics: CompileDiagnostic[] };

export type CompileOptions = {
  /** Called as the compile moves through its phases. */
  onProgress?: (stage: CompileStage, detail?: string) => void;
  /** Which engine to compile with. The server defaults to `pdflatex`. */
  engine?: LatexEngine;
};

/**
 * An opened PDF, page by page. Deliberately narrow: the preview only needs to
 * know how many pages there are, how big each one is, and how to paint one — so
 * a native implementation can be something other than pdf.js without the viewer
 * noticing.
 */
export type PdfDocument = {
  readonly pageCount: number;
  /** Page size in PDF points at scale 1, for laying out before painting. */
  pageSize(pageNumber: number): Promise<{ width: number; height: number }>;
  /** Paint a page into `canvas`, fitted to `cssWidth` CSS pixels. */
  renderPage(pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<void>;
  destroy(): void;
};
