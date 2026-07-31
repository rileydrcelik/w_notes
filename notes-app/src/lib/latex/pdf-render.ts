/**
 * Native PDF rendering — not built yet, for the same reason as `engine.ts`:
 * nothing on this platform compiles the resume in the first place. Exports must
 * mirror `pdf-render.web.ts` exactly (see `platform-parity.test.ts`).
 */
import type { PdfDocument } from '@/lib/latex/types';

export function isPdfPreviewSupported(): boolean {
  return false;
}

export async function loadPdf(_bytes: Uint8Array): Promise<PdfDocument> {
  throw new Error('Previewing a PDF is only available on the web app for now.');
}
