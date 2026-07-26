/**
 * Native "save note to device". Writes the note's exported text to a temp file
 * in the cache directory, then gets it out the same way a copa file block does:
 * into a user-chosen folder on Android (its share sheet can't save anywhere),
 * and via the share sheet on iOS, which offers "Save to Files", AirDrop, mail.
 */
import { Alert } from 'react-native';
import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';

import { Sentry } from '@/lib/sentry';
import { canSaveToDevice, saveFileToDevice } from '@/lib/save-file';
import type { Note } from '@/data/notes';
import { buildNoteText, noteFileName, noteFileTitle } from '@/lib/note-export';

/** Subdirectory under the cache dir that holds exported note files. */
const EXPORT_DIR = 'exports';

export async function saveNoteToDevice(note: Note): Promise<void> {
  try {
    const dir = new Directory(Paths.cache, EXPORT_DIR);
    if (!dir.exists) dir.create({ intermediates: true });

    const dest = new File(dir, noteFileName(note));
    if (dest.exists) dest.delete();
    dest.create();
    dest.write(buildNoteText(note));

    if (canSaveToDevice()) {
      const outcome = await saveFileToDevice({
        uri: dest.uri,
        fileName: noteFileName(note),
      });
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
      mimeType: 'text/plain',
      UTI: 'public.plain-text',
      dialogTitle: noteFileTitle(note),
    });
  } catch (e) {
    console.warn('[save-note] failed to save note:', e);
    Sentry.captureException(e, { tags: { source: 'save-note', op: 'save' } });
    Alert.alert('Could not save', 'Something went wrong saving this note.');
  }
}
