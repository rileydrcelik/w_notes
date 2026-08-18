/**
 * Native PDF rendering — not built yet. This is now the *only* missing half:
 * native does compile a resume (the compile is a server call — see `engine.ts`),
 * so the bytes exist and the navbar will happily save them. Nothing here can
 * draw them, which is why the resume screen offers a phone the download and not
 * the page (`lib/resume-mode.ts`).
 *
 * Filling this in means a real native PDF viewer, which is a native module and
 * therefore a new build rather than an OTA update.
 *
 * Exports must mirror `pdf-render.web.ts` exactly (see `platform-parity.test.ts`).
 */
import type { PdfDocument } from '@/lib/latex/types';

/**
 * Native shows a resume, just not by drawing the PDF: the server sends page
 * images and `resume-preview.tsx` displays them. So this answers the question
 * it actually asks — "can this platform show a compiled resume at all" — and
 * the answer is now yes.
 */
export function isPdfPreviewSupported(): boolean {
  return true;
}

/**
 * Whether the server should be asked to draw the pages. True here and false on
 * web, which has pdf.js and would only be paying for pixels it throws away.
 *
 * Separate from `isPdfPreviewSupported` on purpose: the two used to be the same
 * question and stopped being one the moment native could show a resume without
 * being able to render a PDF.
 */
export function pageImagesRequested(): boolean {
  return true;
}

export async function loadPdf(_bytes: Uint8Array): Promise<PdfDocument> {
  throw new Error('Previewing a PDF is only available on the web app for now.');
}
