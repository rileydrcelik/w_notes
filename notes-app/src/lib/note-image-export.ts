/**
 * Preparing a note for export: its images come along as bytes.
 *
 * A stored body references images (`wn-img:<id>`), and everything that leaves
 * the app — a `.html` file, a PDF, a printed page — has to stand on its own on
 * a machine that has never heard of this app's database. So each reference is
 * resolved to a `data:` URI before the document is built.
 *
 * Sits between the export entry points and `buildNoteDocument`, which stays pure
 * and string-only on purpose: it runs on native, on web and under vitest, none
 * of which agree on having a filesystem.
 */
import type { Note } from '@/data/notes';
import { db } from '@/lib/db';
import { readNoteImageDataUri } from '@/lib/note-image-files';
import { collectNoteImageIds, inlineNoteImages } from '@/lib/note-images';

/**
 * The note as it should be exported: same note, with image references replaced
 * by their bytes.
 *
 * An image whose bytes this device doesn't hold — never downloaded, or an object
 * URL from a previous page session on web — keeps its reference, and the export
 * sanitizer drops it. A gap in the page beats a broken-image box, and it is the
 * honest outcome: those bytes genuinely aren't here.
 */
export async function noteForExport(note: Note): Promise<Note> {
  const body = note.body ?? '';
  if (collectNoteImageIds(body).length === 0) return note;

  let index: { id: string; uri: string | null; mimeType: string | null }[] = [];
  try {
    index = await db.getNoteImageIndex();
  } catch {
    return note;
  }
  const byId = new Map(index.map((row) => [row.id, row]));

  const inlined = await inlineNoteImages(body, async (id) => {
    const row = byId.get(id);
    if (!row?.uri) return null;
    return readNoteImageDataUri(row.uri, row.mimeType);
  });
  return { ...note, body: inlined };
}
