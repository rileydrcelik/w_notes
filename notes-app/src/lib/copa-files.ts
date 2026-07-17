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
import type { CopaItem } from '@/data/copa';

type FeatherName = ComponentProps<typeof Feather>['name'];

/** Subdirectory under the document dir that holds every copa attachment. */
const COPA_DIR = 'copa';

/** The file metadata fields an imported file contributes to a CopaItem. */
export type ImportedFile = Pick<
  CopaItem,
  'fileUri' | 'fileName' | 'mimeType' | 'fileSize' | 'thumbUri'
>;

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
 * Handles the download action for a file block. Media (image/video/audio) is
 * saved straight into the device's media library; any other type (or a media
 * save we couldn't complete) falls back to the share sheet, which offers "Save
 * to Files" / "Save image" and needs no permission — so there's always a path.
 *
 * Android note: `writeOnly` is effectively an iOS-only hint. On Android 13+ the
 * request is for broad read-media access, and picking "Select photos" (partial
 * access) resolves to `granted: false` with `accessPrivileges: 'limited'`. That
 * limited grant is still enough to add our *own* asset, so we treat it as OK and
 * only fall through to sharing on a hard denial (which previously dead-ended).
 */
export async function downloadCopaFile(item: CopaItem): Promise<void> {
  if (!item.fileUri) return;

  if (isSaveableMedia(item.mimeType)) {
    try {
      // Write-only is all we need to save, and asks for the least access. Only
      // (re)prompt when it can actually help — a permanently denied permission
      // (canAskAgain: false) skips straight to the share-sheet fallback below.
      let perm = await MediaLibrary.getPermissionsAsync(true);
      if (!perm.granted && perm.canAskAgain) {
        perm = await MediaLibrary.requestPermissionsAsync(true);
      }
      if (perm.granted) {
        await MediaLibrary.Asset.create(item.fileUri);
        Alert.alert('Saved', 'The file was saved to your device.');
        return;
      }
      // Denied, or a partial "Select photos" grant (Android 13+) — which this
      // SDK reports as not-granted: fall through to the share sheet instead of
      // dead-ending. It saves the file ("Save image" / "Save to Files") with no
      // media permission at all, so there's always a way out. A user declining
      // the prompt isn't an error, so it isn't reported to Sentry.
    } catch (e) {
      // An unexpected native failure during the save itself: fall through to
      // sharing so the user can still get the file out.
      console.warn('[copa] save to device failed:', e);
      Sentry.captureException(e, { tags: { source: 'copa-files', op: 'save' } });
    }
  }

  await openCopaFile(item);
}
