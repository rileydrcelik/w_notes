/**
 * Renders compiled PDF bytes to canvases with pdf.js, one canvas per page, so
 * the resume preview shows real page breaks — the thing you actually need to see
 * before sending a resume anywhere.
 *
 * The bytes come from the backend (`lib/latex/engine.ts`); this only draws them.
 * pdf.js's own worker is served from `/pdfjs/`, copied into `public/` by
 * `scripts/copy-pdfjs-worker.mjs` — Cloudflare drops anything under a
 * `node_modules` directory, so it can't simply be imported.
 */
import * as pdfjs from 'pdfjs-dist';

import type { PdfDocument } from '@/lib/latex/types';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

export function isPdfPreviewSupported(): boolean {
  return true;
}

/**
 * No: this platform draws the PDF itself, so server-rendered page images would
 * be bytes over the wire and CPU on a shared task for pictures it would throw
 * away. The native half returns true. See `pdf-render.ts`.
 */
export function pageImagesRequested(): boolean {
  return false;
}

export async function loadPdf(bytes: Uint8Array): Promise<PdfDocument> {
  // pdf.js takes ownership of the buffer it's handed (it transfers it to its
  // worker), which would detach the copy the download button still needs. Give
  // it a copy and keep ours intact.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;

  return {
    pageCount: doc.numPages,

    async pageSize(pageNumber: number) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      return { width: viewport.width, height: viewport.height };
    },

    async renderPage(pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number) {
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      // Scale to the width the layout gave us, then multiply by the device pixel
      // ratio so text stays crisp on a HiDPI screen; the canvas is sized back
      // down in CSS pixels by its style.
      const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 3);
      const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not get a 2d canvas context');
      await page.render({ canvas, canvasContext: context, viewport }).promise;
    },

    destroy() {
      // Destroying the loading task tears down the document *and* its worker;
      // the document proxy alone can't release the worker.
      void task.destroy();
    },
  };
}
