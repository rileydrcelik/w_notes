/**
 * Web "save note as PDF": render the note's document in a hidden same-origin
 * iframe and open the browser's own print dialog, where "Save as PDF" is a
 * destination. The browser's engine is already the best HTML renderer on the
 * machine, so this needs no dependency and no server round trip — the note
 * exports offline, with the formatting the editor gave it.
 *
 * The honest limitation: this is a print dialog, not a silent download. A file
 * that lands in Downloads without a dialog would mean shipping a PDF writer
 * (hand-maintaining a layout engine) or generating it server-side (which would
 * make exporting a note fail on a plane). Neither is worth it.
 *
 * Must export the same names as `save-note-pdf.ts` (`platform-parity.test.ts`).
 */
import type { Note } from '@/data/notes';
import { buildNoteDocument, noteHasExportableContent } from '@/lib/note-html-export';

/**
 * Safety net for browsers that never fire `afterprint` for an iframe. Removing
 * the frame while the dialog is still open would cancel the print, so this is
 * deliberately far longer than anyone spends choosing a destination.
 */
const CLEANUP_TIMEOUT_MS = 120_000;

export async function saveNotePdfToDevice(note: Note): Promise<void> {
  if (!noteHasExportableContent(note)) return;

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('title', 'Note export');
  // Off-screen rather than `display: none` — a hidden frame doesn't always get
  // laid out, and an unlaid-out document prints blank.
  frame.style.cssText =
    'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
  document.body.appendChild(frame);

  await new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      frame.remove();
      resolve();
    };

    frame.onload = () => {
      const win = frame.contentWindow;
      if (!win) {
        cleanup();
        return;
      }
      win.addEventListener('afterprint', cleanup);
      timer = setTimeout(cleanup, CLEANUP_TIMEOUT_MS);
      try {
        win.focus();
        win.print();
      } catch (e) {
        console.warn('[save-note-pdf] print failed:', e);
        cleanup();
      }
    };

    // `srcdoc` keeps the document same-origin, which is what lets us reach into
    // `contentWindow` to print it at all.
    frame.srcdoc = buildNoteDocument(note);
  });
}
