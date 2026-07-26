/**
 * Native file work for copa file blocks, kept out of the store/screens so those
 * stay declarative. Picks a file, copies its bytes into the app's persistent
 * document directory (the picker only hands back a cache copy), generates a
 * thumbnail for videos, and opens/cleans up files later.
 *
 * Files are local-only: bytes live under `Paths.document/copa/` and never sync,
 * so each file is keyed by its block id and removed from disk on delete.
 */

import type { ComponentProps } from 'react';
import { Alert } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as DocumentPicker from 'expo-document-picker';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Directory, File, Paths } from 'expo-file-system';

import { Sentry } from '@/lib/sentry';
import { canSaveToDevice, saveFileToDevice } from '@/lib/save-file';
import type { CopaItem } from '@/data/copa';

type FeatherName = ComponentProps<typeof Feather>['name'];

/** Subdirectory under the document dir that holds every copa attachment. */
const COPA_DIR = 'copa';

/** The file metadata fields an imported file contributes to a CopaItem. */
export type ImportedFile = Pick<
  CopaItem,
  'fileUri' | 'fileName' | 'mimeType' | 'fileSize' | 'thumbUri'
>;

/**
 * A file handed over by a clipboard paste or a drag-and-drop. Only web produces
 * these (see `copa-files.web.ts`); the type exists here so both modules expose
 * the same surface. Typed as a named `Blob` rather than a DOM `File` — `File` is
 * expo-file-system's class in this module.
 */
export type DroppedFile = Blob & { name?: string };

export const isImage = (mime?: string): boolean => !!mime?.startsWith('image/');
export const isVideo = (mime?: string): boolean => !!mime?.startsWith('video/');
export const isAudio = (mime?: string): boolean => !!mime?.startsWith('audio/');

/** Media the device's library (gallery/music) can store via expo-media-library. */
export const isSaveableMedia = (mime?: string): boolean =>
  isImage(mime) || isVideo(mime) || isAudio(mime);

/** Feather icon representing a file type when no thumbnail applies. */
export function fileIconFor(mime?: string): FeatherName {
  if (isImage(mime)) return 'image';
  if (isVideo(mime)) return 'film';
  if (mime?.startsWith('audio/')) return 'music';
  if (mime === 'application/pdf') return 'file-text';
  if (mime?.startsWith('text/')) return 'file-text';
  return 'file';
}

/** Human-readable byte size, e.g. `1.4 MB`. */
export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Extracts a lowercase extension (with dot) from a name, or '' if none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * Ensures the copa attachments directory exists and returns a fresh destination
 * `File` for a block id (deleting any existing file at that path first). Shared
 * by the picker import and the sync download so both write to the same place.
 */
export function copaDestination(id: string, ext: string): File {
  const dir = new Directory(Paths.document, COPA_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  const dest = new File(dir, `${id}${ext}`);
  if (dest.exists) dest.delete();
  return dest;
}

/** Generates a video frame thumbnail uri, or `undefined` if it can't. */
export async function generateVideoThumbnail(fileUri: string): Promise<string | undefined> {
  try {
    const thumb = await VideoThumbnails.getThumbnailAsync(fileUri, { time: 0, quality: 0.6 });
    return thumb.uri;
  } catch (e) {
    // A missing thumbnail just falls back to the file-type icon — not fatal.
    console.warn('[copa] video thumbnail failed:', e);
    Sentry.captureException(e, { tags: { source: 'copa-files', op: 'thumbnail' } });
    return undefined;
  }
}

/** Largest file we'll import/upload (2 GB). Matches the backend's advisory cap. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Prompts the user to pick a file of any type and imports it for the given block
 * id. Returns the persistent file metadata, or `null` if the user cancelled (or
 * the file is over the size cap). Throws only on an unexpected native failure.
 */
export async function importPickedFile(id: string): Promise<ImportedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];

  if (asset.size && asset.size > MAX_UPLOAD_BYTES) {
    Alert.alert('File too large', 'Files must be under 2 GB to add and sync.');
    return null;
  }

  // Keep the bytes around permanently: the picker's copy lives in the cache and
  // can be reclaimed by the OS at any time.
  const dest = copaDestination(id, extensionOf(asset.name));
  await new File(asset.uri).copy(dest);

  const thumbUri = isVideo(asset.mimeType) ? await generateVideoThumbnail(dest.uri) : undefined;

  return {
    fileUri: dest.uri,
    fileName: asset.name,
    mimeType: asset.mimeType,
    fileSize: asset.size,
    thumbUri,
  };
}

/**
 * Web-only counterpart of `importPickedFile`, for a file that arrived by paste
 * or drag-and-drop. Neither gesture exists on native — the paste/drop hook is a
 * no-op there — so this never has a file to import and always returns `null`.
 * It's declared here only to keep the module's exports identical across
 * platforms; see `copa-files.web.ts` for the real implementation.
 */
export async function importDroppedFile(
  _id: string,
  _file: DroppedFile,
): Promise<ImportedFile | null> {
  return null;
}

/** Best-effort removal of a block's file bytes (and thumbnail) from disk. */
export function removeCopaFiles({ fileUri, thumbUri }: { fileUri?: string; thumbUri?: string }): void {
  for (const uri of [fileUri, thumbUri]) {
    if (!uri) continue;
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch (e) {
      console.warn('[copa] failed to delete file:', e);
    }
  }
}

/** Opens the OS share/open sheet for a file block. No-op for text blocks. */
export async function openCopaFile(item: CopaItem): Promise<void> {
  if (!item.fileUri) return;
  if (!(await Sharing.isAvailableAsync())) return;
  await Sharing.shareAsync(item.fileUri, {
    mimeType: item.mimeType,
    dialogTitle: item.label || item.fileName,
  });
}

/**
 * Handles the download action for a file block. Where it goes depends on what
 * it is, and the two routes are deliberately exclusive:
 *
 * - Media (image/video/audio) goes into the device's media library, where the
 *   gallery and music apps will find it. If that doesn't work out it falls back
 *   to the share sheet, never to the folder below — a photo saved into some
 *   folder is a photo the gallery won't show.
 * - Anything else on Android — a PDF, a zip, a doc — is written to a folder the
 *   user picks once, the picker opening at Downloads. Android's share sheet can
 *   only hand bytes to another app, so without this a PDF had no way at all to
 *   reach the user's own files.
 *
 * The share sheet backs both up: on iOS it offers "Save to Files" / "Save
 * image" and needs no permission, so there's always a path.
 */
export async function downloadCopaFile(item: CopaItem): Promise<void> {
  if (!item.fileUri) return;

  if (isSaveableMedia(item.mimeType)) {
    if (await saveToMediaLibrary(item.fileUri)) {
      Alert.alert('Saved', 'The file was saved to your device.');
      return;
    }
  } else if (canSaveToDevice()) {
    try {
      const outcome = await saveFileToDevice({
        uri: item.fileUri,
        fileName: saveNameFor(item),
      });
      // A cancelled folder pick is the user saying no — don't then surprise
      // them with a share sheet they didn't ask for.
      if (outcome.status === 'saved') {
        Alert.alert('Saved', `The file was saved to ${outcome.folder}.`);
        return;
      }
      if (outcome.status === 'cancelled') return;
    } catch (e) {
      console.warn('[copa] save to folder failed:', e);
      Sentry.captureException(e, { tags: { source: 'copa-files', op: 'save-file' } });
    }
  }

  await openCopaFile(item);
}

/**
 * Adds a file to the device's media library, reporting whether it landed.
 *
 * The save is *attempted before any permission is requested*, because on
 * Android 10+ none is needed — an app may always add its own asset to
 * MediaStore. Asking first was worse than useless there: on Android 13+ the
 * request covers broad read-media access, so choosing "Select photos" (partial
 * access) comes back `granted: false`, and a save that would have succeeded was
 * abandoned untried. Permission is only worth asking for when the attempt
 * actually fails — older Android, which writes through external storage, and
 * iOS, where PhotoKit needs authorization.
 */
async function saveToMediaLibrary(fileUri: string): Promise<boolean> {
  try {
    await MediaLibrary.Asset.create(fileUri);
    return true;
  } catch {
    // Expected wherever the media library really is permission-gated.
  }

  try {
    // Write-only is all we need to save, and asks for the least access. Only
    // (re)prompt when it can help — a permanently denied permission
    // (canAskAgain: false) gives up here rather than prompting into a wall.
    let perm = await MediaLibrary.getPermissionsAsync(true);
    if (!perm.granted && perm.canAskAgain) {
      perm = await MediaLibrary.requestPermissionsAsync(true);
    }
    // Declining the prompt is a choice, not an error, so it isn't reported.
    if (!perm.granted) return false;

    await MediaLibrary.Asset.create(fileUri);
    return true;
  } catch (e) {
    console.warn('[copa] save to media library failed:', e);
    Sentry.captureException(e, { tags: { source: 'copa-files', op: 'save' } });
    return false;
  }
}

/** The name a file block should be written under, however sparse its metadata. */
function saveNameFor(item: CopaItem): string {
  if (item.fileName) return item.fileName;
  const ext = extensionOf(item.fileUri ?? '');
  return `${item.label || 'file'}${ext}`;
}
