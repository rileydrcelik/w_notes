/**
 * Native "save this PDF to the device". Writes the bytes to a cache file and
 * hands them off exactly the way an exported note or a copa file does: a folder
 * picker on Android (whose share sheet cannot save a file), the share sheet on
 * iOS, which offers "Save to Files".
 *
 * Nothing on native produces a PDF yet — no LaTeX engine (see `latex/engine.ts`)
 * — but the saver is platform-complete, so wiring the engine up later needs no
 * changes here.
 */
import { Alert } from 'react-native';
import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';

import { Sentry } from '@/lib/sentry';
import { canSaveToDevice, saveFileToDevice } from '@/lib/save-file';

/** Subdirectory under the cache dir that holds exported PDFs. */
const EXPORT_DIR = 'exports';

export async function savePdfToDevice(fileName: string, bytes: Uint8Array): Promise<void> {
  try {
    const dir = new Directory(Paths.cache, EXPORT_DIR);
    if (!dir.exists) dir.create({ intermediates: true });

    const dest = new File(dir, fileName);
    if (dest.exists) dest.delete();
    dest.create();
    dest.write(bytes);

    if (canSaveToDevice()) {
      const outcome = await saveFileToDevice({ uri: dest.uri, fileName });
      if (outcome.status === 'saved') {
        Alert.alert('Saved', `The resume was saved to ${outcome.folder}.`);
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
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
      dialogTitle: fileName,
    });
  } catch (e) {
    console.warn('[save-pdf] failed to save pdf:', e);
    Sentry.captureException(e, { tags: { source: 'save-pdf', op: 'save' } });
    Alert.alert('Could not save', 'Something went wrong saving this PDF.');
  }
}
