/**
 * Web "save note to device". Builds the exported text as a blob and triggers a
 * plain anchor download, matching the copa web download flow.
 */
import type { Note } from '@/data/notes';
import { buildNoteText, noteFileName } from '@/lib/note-export';

export async function saveNoteToDevice(note: Note): Promise<void> {
  const blob = new Blob([buildNoteText(note)], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = noteFileName(note);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
