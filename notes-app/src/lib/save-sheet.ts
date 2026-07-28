/**
 * Native "save sheet to device". Writes the finance note's CSV to a temp file in
 * the cache directory, then hands it off the same way an exported note does:
 * into a user-chosen folder on Android (whose share sheet can't save anywhere),
 * and via the share sheet on iOS, which offers "Save to Files".
 *
 * Mirrors `save-note.ts` deliberately — same staging directory conventions, same
 * fallback order — differing only in the bytes and the `text/csv` type.
 */
import { Alert } from 'react-native';
import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';

import { Sentry } from '@/lib/sentry';
import { canSaveToDevice, saveFileToDevice } from '@/lib/save-file';
import type { Note } from '@/data/notes';
import { db } from '@/lib/db';
import { buildNoteCsv, sheetFileName, sheetFileTitle } from '@/lib/finance/csv';
import { flushPendingSheet } from '@/lib/finance/pending';

/** Subdirectory under the cache dir that holds exported sheets. */
const EXPORT_DIR = 'exports';

export async function saveSheetToDevice(note: Note): Promise<void> {
  try {
    // Write any edit still sitting in the screen's debounce before reading, or
    // the CSV silently omits whatever was typed in the last few hundred ms.
    await flushPendingSheet();
    const csv = buildNoteCsv(await db.getFinanceSheet(note.id));
    if (csv.trim() === '') {
      Alert.alert('Nothing to export', 'This sheet is empty.');
      return;
    }

    const dir = new Directory(Paths.cache, EXPORT_DIR);
    if (!dir.exists) dir.create({ intermediates: true });

    const name = sheetFileName(note);
    const dest = new File(dir, name);
    if (dest.exists) dest.delete();
    dest.create();
    dest.write(csv);

    if (canSaveToDevice()) {
      const outcome = await saveFileToDevice({ uri: dest.uri, fileName: name });
      if (outcome.status === 'saved') {
        Alert.alert('Saved', `The sheet was saved to ${outcome.folder}.`);
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
      mimeType: 'text/csv',
      UTI: 'public.comma-separated-values-text',
      dialogTitle: sheetFileTitle(note),
    });
  } catch (e) {
    console.warn('[save-sheet] failed to save sheet:', e);
    Sentry.captureException(e, { tags: { source: 'save-sheet', op: 'save' } });
    Alert.alert('Could not save', 'Something went wrong saving this sheet.');
  }
}
