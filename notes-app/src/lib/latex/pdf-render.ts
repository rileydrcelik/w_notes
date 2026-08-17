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

export function isPdfPreviewSupported(): boolean {
  return false;
}

export async function loadPdf(_bytes: Uint8Array): Promise<PdfDocument> {
  throw new Error('Previewing a PDF is only available on the web app for now.');
}
