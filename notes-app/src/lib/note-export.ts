/**
 * Turns a note into a plain-text file for "save to device". Bodies are the app's
 * canonical rich-text HTML, so we flatten them with the same `htmlToPlainText`
 * used for previews/clipboard (keeps line structure, bullets, and checkbox
 * markers). The title becomes the first line. Kept platform-agnostic so both the
 * native (share-sheet) and web (anchor-download) savers build the same bytes.
 */
import type { Note } from '@/data/notes';
import { htmlToPlainText } from '@/lib/html-text';

/** Display title for an untitled note, used in the document and its filename. */
export function noteFileTitle(note: Note): string {
  return note.title.trim() || 'Untitled note';
}

/** The formats a note can be exported as; each is one menu row in the navbar. */
export type NoteExportExtension = 'txt' | 'html' | 'pdf';

/**
 * A filesystem-safe filename for one export format. The stem is shared by all
 * three on purpose — the same note downloaded twice should differ only in its
 * extension, so the files sort together.
 */
export function noteExportName(note: Note, ext: NoteExportExtension): string {
  const base =
    noteFileTitle(note)
      // Drop characters that are illegal in file names across platforms.
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'note';
  return `${base}.${ext}`;
}

/** A filesystem-safe `.txt` filename derived from the note's title. */
export function noteFileName(note: Note): string {
  return noteExportName(note, 'txt');
}

/**
 * Build the plain-text contents for the note: the title on the first line, a
 * blank line, then the flattened body. A titleless or empty body degrades
 * gracefully (no stray blank lines).
 */
export function buildNoteText(note: Note): string {
  const title = note.title.trim();
  const body = htmlToPlainText(note.body ?? '');
  return [title, body].filter((part) => part.length > 0).join('\n\n') + '\n';
}
