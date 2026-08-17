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

/**
 * One page of a compiled resume, drawn server-side.
 *
 * For platforms with no PDF renderer of their own — every phone, since a real
 * viewer is a native module and this app ships over the air. The dimensions
 * travel with the bytes so a page can be laid out before it decodes, rather
 * than the list reflowing under you as each image arrives.
 */
export type RenderedPage = {
  width: number;
  height: number;
  png: Uint8Array;
};

/**
 * A rendered page once it's been written to the cache — what the preview shows.
 *
 * Lives here, beside `RenderedPage`, rather than in either preview component:
 * both platform halves take the same props so the screen has one call site and
 * no `Platform.OS` branch, and a type that only one half could import would
 * leave the other's signature free to drift.
 */
export type PreviewPage = {
  /** `file://` path to the rendered PNG. */
  uri: string;
  /** The pixel size it was rendered at — the source of the aspect ratio. */
  width: number;
  height: number;
};

export type CompileResult =
  | {
      ok: true;
      pdf: Uint8Array;
      log: string;
      /** Present only when pages were asked for and the server drew them. */
      pages?: RenderedPage[];
      /**
       * The compile succeeded but the pages didn't. Distinct from `ok: false`,
       * and deliberately not fatal: there is still a PDF here to download, so a
       * client that can't draw one says *this* rather than showing an empty
       * page and calling it success.
       */
      pagesError?: string;
    }
  | { ok: false; log: string; diagnostics: CompileDiagnostic[] };

export type CompileOptions = {
  /** Called as the compile moves through its phases. */
  onProgress?: (stage: CompileStage, detail?: string) => void;
  /** Which engine to compile with. The server defaults to `pdflatex`. */
  engine?: LatexEngine;
  /**
   * Ask the server to draw each page at this pixel width. Omitted by callers
   * that can render the PDF themselves, so web never pays for images it will
   * not show. The width comes from the caller because only the caller knows its
   * screen size and pixel density.
   */
  pages?: { width: number };
};

/**
 * Widest a page is ever drawn, so a tablet or a maximised window doesn't render
 * a wall-sized sheet.
 *
 * It lives here, with the shapes both previews share, because the two halves
 * draw the *same document* by different means — web paints the PDF, native
 * paints server-rendered images of it — and the promise is that a page break
 * falls in the same place either way. Two copies of this number is that promise
 * kept by coincidence, and only until someone tunes one of them.
 */
export const MAX_PREVIEW_PAGE_WIDTH = 720;

/** Fallback shape while a page's real dimensions are unknown: US Letter. */
export const LETTER_ASPECT = 1.294;

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
