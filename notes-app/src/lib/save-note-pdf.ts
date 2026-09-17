/**
 * Native "save note as PDF" — **not implemented yet, on purpose.**
 *
 * Making a PDF on a phone means rendering HTML with the platform's own printer
 * (`expo-print`), which is a *native* module. The OTA runtime lineage is the
 * app version with its patch digit dropped (`app.config.js`), so shipping an
 * import of a native module that installed binaries don't carry would crash
 * them at launch — it can only arrive with a full build and a minor version
 * bump. Until that build ships, this offers the export that does work today and
 * says plainly why.
 *
 * Replacing this file's body is the whole of that later change:
 *   const { uri } = await Print.printToFileAsync({ html: buildNoteDocument(note), margins })
 * then hand `uri` to the same `saveFileToDevice` / `Sharing` ladder the other
 * savers use (see `save-pdf.ts`, which already does exactly that for bytes).
 */
import { Alert } from 'react-native';

import type { Note } from '@/data/notes';
import { saveNoteHtmlToDevice } from '@/lib/save-note-html';

export async function saveNotePdfToDevice(note: Note): Promise<void> {
  Alert.alert(
    'PDF export needs an app update',
    "This version can't make a PDF yet. Saving as a web page keeps all the same formatting, and opens in any browser.",
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Save as web page', onPress: () => void saveNoteHtmlToDevice(note) },
    ],
  );
}
