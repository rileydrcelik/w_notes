/**
 * Saving a file out of the app and into the device's own storage.
 *
 * iOS needs nothing special: its share sheet carries a "Save to Files" target.
 * Android's does not — ACTION_SEND only lists apps to hand the bytes to — so a
 * PDF passed to `Sharing.shareAsync` can be sent to Drive or Gmail but can never
 * land in the user's files. That is the gap this module fills, using the Storage
 * Access Framework folder picker and writing the file into the chosen folder.
 *
 * SAF grants are persistable, so the folder is remembered: the user is asked
 * once and every later save writes straight to it with no prompt at all.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';

/** Where the chosen save folder (a SAF tree uri) is remembered. */
const SAVE_DIR_KEY = 'save.directoryUri';

/**
 * Where the folder picker opens. `EXTRA_INITIAL_URI` wants the *document* form
 * of a folder even for a tree picker, hence `/document/` here while the granted
 * uri comes back as `/tree/`.
 *
 * Downloads is the starting point rather than the answer: since Android 11 the
 * system refuses to grant `Download` itself through this picker (along with the
 * storage roots), so the user lands there and picks a subfolder — `Downloads/
 * w_notes`, say, which the Files app shows right under Downloads. Selecting
 * Download itself is blocked by the picker, so no unusable grant comes back.
 */
const DOWNLOADS_URI =
  'content://com.android.externalstorage.documents/document/primary%3ADownload';

/** Holds files renamed for saving; see `writeInto`. Cleared as it goes. */
const STAGING_DIR = 'saves';

/** A file on disk and the name it should be saved under. */
export type SaveRequest = {
  uri: string;
  fileName: string;
};

/** `folder` is a readable path like `Download/w_notes`, for the confirmation. */
export type SaveOutcome =
  | { status: 'saved'; folder: string }
  | { status: 'cancelled' }
  | { status: 'unsupported' };

/** Whether this platform has a real save-to-storage path (Android only). */
export function canSaveToDevice(): boolean {
  return Platform.OS === 'android';
}

/**
 * The human-readable path inside a tree uri, which spells the folder as
 * `.../tree/primary%3ADownload%2Fw_notes` — everything after the volume id.
 */
function folderLabel(dir: Directory): string {
  const decoded = decodeURIComponent(dir.uri);
  const path = decoded.slice(decoded.lastIndexOf(':') + 1);
  return path || 'your device';
}

/** The previously granted folder, or `null` if there isn't a usable one. */
async function rememberedDirectory(): Promise<Directory | null> {
  const uri = await AsyncStorage.getItem(SAVE_DIR_KEY);
  if (!uri) return null;
  try {
    const dir = new Directory(uri);
    // The grant outlives a restart but not a reinstall, a revoke, or the folder
    // being deleted — any of which means asking for a folder again.
    return dir.exists ? dir : null;
  } catch {
    return null;
  }
}

/** Prompts for a folder and remembers it. `null` if the user backed out. */
async function pickDirectory(): Promise<Directory | null> {
  try {
    const dir = await Directory.pickDirectoryAsync(DOWNLOADS_URI);
    await AsyncStorage.setItem(SAVE_DIR_KEY, dir.uri);
    return dir;
  } catch {
    // The native module throws on cancel. Backing out isn't an error.
    return null;
  }
}

/**
 * Copies the request's bytes into `dir`.
 *
 * The copy must target the *directory*, not a file inside it. Only expo's
 * directory-destination path mints a real SAF document under the tree — a
 * `File` built by joining a name onto a tree uri isn't addressable, and
 * `Directory.createFile` can't stand in for it because its Android argument
 * order is the reverse of its TypeScript signature (native takes mimeType
 * first), so no JS call site can get both arguments right.
 *
 * That path names the new document after the *source* file, so a source stored
 * under some other name — copa keeps its files under the block id — is staged
 * through the cache under the name we want. The saved file's type is inferred
 * from that name's extension.
 */
async function writeInto(dir: Directory, { uri, fileName }: SaveRequest): Promise<void> {
  const source = new File(uri);
  if (source.name === fileName) {
    await source.copy(dir, { overwrite: true });
    return;
  }

  const staging = new Directory(Paths.cache, STAGING_DIR);
  if (!staging.exists) staging.create({ intermediates: true });
  const staged = new File(staging, fileName);
  if (staged.exists) staged.delete();

  await source.copy(staged);
  try {
    await staged.copy(dir, { overwrite: true });
  } finally {
    if (staged.exists) staged.delete();
  }
}

/**
 * Saves a local file into the user's storage, asking for a folder the first
 * time. Returns `unsupported` on platforms with no such path (iOS, where the
 * share sheet is the better answer) so callers can fall back. Throws only if a
 * freshly picked folder can't be written to.
 */
export async function saveFileToDevice(request: SaveRequest): Promise<SaveOutcome> {
  if (!canSaveToDevice()) return { status: 'unsupported' };

  const remembered = await rememberedDirectory();
  if (remembered) {
    try {
      await writeInto(remembered, request);
      return { status: 'saved', folder: folderLabel(remembered) };
    } catch (e) {
      // Some stale grants only show themselves on the write itself. Drop it and
      // ask again rather than dead-ending on a folder picked months ago.
      console.warn('[save-file] remembered folder failed, asking again:', e);
      await AsyncStorage.removeItem(SAVE_DIR_KEY);
    }
  }

  const picked = await pickDirectory();
  if (!picked) return { status: 'cancelled' };
  await writeInto(picked, request);
  return { status: 'saved', folder: folderLabel(picked) };
}
