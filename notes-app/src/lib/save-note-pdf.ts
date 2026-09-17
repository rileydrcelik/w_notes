/**
 * Native "save note as PDF". Renders the note's document with the platform's
 * own printer — the same engine the OS uses behind Print — and hands the result
 * to the ladder every other exporter here uses: a folder picker on Android
 * (whose share sheet cannot save a file), the share sheet on iOS, which offers
 * "Save to Files".
 *
 * `printToFileAsync` writes into the app's cache under a name of its own
 * choosing, so the result is copied to `exports/` under the name the user
 * should see before it goes anywhere — `saveFileToDevice` would stage a
 * mismatched name for us, but iOS's share sheet shows the file's own name and
 * "Untitled note.pdf" beats a printer-generated one.
 *
 * Margins are specified twice on purpose, because the two platforms read
 * different ones: Android honours the `@page` rule in the document's own
 * stylesheet, iOS ignores that and takes `margins` here. 51pt is the same 18mm
 * the stylesheet asks for, at 72 points to the inch.
 *
 * `useMarkupFormatter` is deliberately not used: it renders no images at all on
 * iOS, and it is the option whose malformed-input handling produces blank pages.
 */
import { Alert } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';

import { Sentry } from '@/lib/sentry';
import { canSaveToDevice, saveFileToDevice } from '@/lib/save-file';
import type { Note } from '@/data/notes';
import { noteExportName, noteFileTitle } from '@/lib/note-export';
import { buildNoteDocument, noteHasExportableContent } from '@/lib/note-html-export';

/** Subdirectory under the cache dir that holds exported note files. */
const EXPORT_DIR = 'exports';

/** 18mm in points (72 per inch) — the same margin the document's CSS asks for. */
const IOS_MARGIN_PT = 51;

/**
 * How long to wait for the printer before calling it a failure.
 *
 * expo-print's Android renderer resumes its coroutine only from the WebView's
 * `onPageFinished`, and has no timeout of its own — a document that never
 * finishes laying out leaves this promise pending for the life of the process.
 * That failure is invisible: no alert, no Sentry event, the menu row simply did
 * nothing. Long enough that a slow render on a cheap phone still wins.
 */
const PRINT_TIMEOUT_MS = 60_000;

/**
 * Documents longer than this are refused instead of printed.
 *
 * Android renders in a plain `WebView` whose client doesn't override
 * `onRenderProcessGone`, and the platform default for that is to kill the app
 * process — so an out-of-memory render is not an error this function can catch
 * and apologise for, it is a crash the user reads as "the app closed". The cap
 * is far above any note made of text (a whole novel is about a million
 * characters); what reaches it is a body stuffed with `data:` images. The
 * `.html` export sitting next to this one in the same menu carries those out
 * losslessly, which is why refusing is honest rather than a dead end.
 */
const MAX_DOCUMENT_CHARS = 8_000_000;

/**
 * One export at a time.
 *
 * Reopening the download menu while a big note is still rendering would start a
 * second printer — doubling peak memory in exactly the case that can already
 * kill the process — and its `dest.delete()` would pull the file out from under
 * the share sheet the first run is still holding, failing a save that was about
 * to succeed. A second call joins the first rather than racing it. It is
 * dropped even when it names a different note: the window is one render long,
 * and starting two printers is the thing being avoided.
 */
let inFlight: Promise<void> | null = null;

export function saveNotePdfToDevice(note: Note): Promise<void> {
  if (inFlight) return inFlight;
  const run = exportNotePdf(note).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

/**
 * `printToFileAsync` with a deadline, resolving to the printer's temp file uri.
 *
 * If the deadline wins, the render may still complete later and leave its temp
 * file behind; that is a cache file on a path that has already failed, and
 * there is no handle to delete it with. Reporting the failure is worth it.
 */
async function printToPdf(html: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Print.printToFileAsync({
        html,
        margins: {
          top: IOS_MARGIN_PT,
          right: IOS_MARGIN_PT,
          bottom: IOS_MARGIN_PT,
          left: IOS_MARGIN_PT,
        },
      }).then(({ uri }) => uri),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`printToFileAsync exceeded ${PRINT_TIMEOUT_MS}ms`)),
          PRINT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Best effort: a cache file we failed to remove is not worth an error. */
function discard(file: File | null): void {
  try {
    if (file?.exists) file.delete();
  } catch {
    // Ignored on purpose.
  }
}

async function exportNotePdf(note: Note): Promise<void> {
  // The printer's own temp file, distinct from the copy under `exports/`.
  let printed: File | null = null;
  let staged: File | null = null;
  // Set once something else owns the bytes — see the cleanup in `finally`.
  let handedOff = false;
  try {
    if (!noteHasExportableContent(note)) {
      Alert.alert('Nothing to export', 'This note is empty.');
      return;
    }

    const html = buildNoteDocument(note);
    if (html.length > MAX_DOCUMENT_CHARS) {
      Alert.alert(
        'Too long for a PDF',
        'This note is too large to print. Download it as a web page instead — it keeps the same formatting.',
      );
      return;
    }

    printed = new File(await printToPdf(html));

    const dir = new Directory(Paths.cache, EXPORT_DIR);
    if (!dir.exists) dir.create({ intermediates: true });

    const fileName = noteExportName(note, 'pdf');
    const dest = new File(dir, fileName);
    if (dest.exists) dest.delete();
    await printed.copy(dest);
    staged = dest;

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
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
      dialogTitle: noteFileTitle(note),
    });
    handedOff = true;
  } catch (e) {
    console.warn('[save-note-pdf] failed to save pdf:', e);
    Sentry.captureException(e, { tags: { source: 'save-note-pdf', op: 'save' } });
    Alert.alert('Could not save', 'Something went wrong making this PDF.');
  } finally {
    discard(printed);
    // The staged copy outlives this function only when the share sheet has it:
    // the receiving app reads the uri on its own schedule, after `shareAsync`
    // resolves, so deleting there would break a save that looked successful.
    // Every other ending — saved (`saveFileToDevice` copies the bytes into the
    // chosen folder), cancelled, or failed — is finished with the file, and
    // nothing in the app ever prunes `exports/`.
    if (!handedOff) discard(staged);
  }
}
