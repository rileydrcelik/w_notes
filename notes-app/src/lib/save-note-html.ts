/**
 * Native "save note as a web page". Mirrors `save-note.ts` exactly — same
 * staging directory, same Android-folder-picker-then-share-sheet fallback order
 * — differing only in the bytes (a full HTML document rather than flattened
 * text) and the `text/html` type.
 *
 * The same formatting the PDF export keeps, in a file that stays editable and
 * weighs nothing; see `save-note-pdf.ts` for the printed half.
 */
import { Alert } from 'react-native';
import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';

import { Sentry } from '@/lib/sentry';
import { canSaveToDevice, saveFileToDevice } from '@/lib/save-file';
import type { Note } from '@/data/notes';
import { noteExportName, noteFileTitle } from '@/lib/note-export';
import { buildNoteDocument, noteHasExportableContent } from '@/lib/note-html-export';
import { noteForExport } from '@/lib/note-image-export';

/** Subdirectory under the cache dir that holds exported note files. */
const EXPORT_DIR = 'exports';

export async function saveNoteHtmlToDevice(note: Note): Promise<void> {
  try {
    if (!noteHasExportableContent(note)) {
      Alert.alert('Nothing to export', 'This note is empty.');
      return;
    }

    const dir = new Directory(Paths.cache, EXPORT_DIR);
    if (!dir.exists) dir.create({ intermediates: true });

    const fileName = noteExportName(note, 'html');
    const dest = new File(dir, fileName);
    if (dest.exists) dest.delete();
    dest.create();
    // Images travel as bytes: a reference means nothing outside the app.
    dest.write(buildNoteDocument(await noteForExport(note)));

    if (canSaveToDevice()) {
      const outcome = await saveFileToDevice({ uri: dest.uri, fileName });
      if (outcome.status === 'saved') {
        Alert.alert('Saved', `The note was saved to ${outcome.folder}.`);
        return;
      }
      // Cancelling the folder pick means no — don't fall through to sharing.
      if (outcome.status === 'cancelled') return;
    }

    if (!(await Sharing.isAvailableAsync())) {
      Alert.alert('Unavailable', 'Sharing is not available on this device.');
      return;
    }
    await Sharing.shareAsync(dest.uri, {
      mimeType: 'text/html',
      UTI: 'public.html',
      dialogTitle: noteFileTitle(note),
    });
  } catch (e) {
    console.warn('[save-note-html] failed to save note:', e);
    Sentry.captureException(e, { tags: { source: 'save-note-html', op: 'save' } });
    Alert.alert('Could not save', 'Something went wrong saving this note.');
  }
}
