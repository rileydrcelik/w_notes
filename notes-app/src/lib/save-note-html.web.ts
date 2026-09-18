/**
 * Web "save note as a web page": blob + anchor download, the same shape as
 * `save-note.web.ts`, differing only in the bytes and the `text/html` type.
 *
 * Must export the same names as `save-note-html.ts` — a variant pair that
 * drifts is how this app once shipped a build that crashed on launch for three
 * days (`__tests__/platform-parity.test.ts`).
 */
import type { Note } from '@/data/notes';
import { noteExportName } from '@/lib/note-export';
import { buildNoteDocument, noteHasExportableContent } from '@/lib/note-html-export';
import { noteForExport } from '@/lib/note-image-export';

export async function saveNoteHtmlToDevice(note: Note): Promise<void> {
  if (!noteHasExportableContent(note)) return;

  // Images travel as bytes: a reference means nothing outside the app.
  const document_ = buildNoteDocument(await noteForExport(note));
  const blob = new Blob([document_], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = noteExportName(note, 'html');
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
