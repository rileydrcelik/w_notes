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
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * Prompts the user to pick a file of any type and imports it for the given block
 * id. Returns the persistent file metadata, or `null` if the user cancelled.
 * Throws only on an unexpected native/filesystem failure.
 */
export async function importPickedFile(id: string): Promise<ImportedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];

  // Keep the bytes around permanently: the picker's copy lives in the cache and
  // can be reclaimed by the OS at any time.
  const dir = new Directory(Paths.document, COPA_DIR);
  if (!dir.exists) dir.create({ intermediates: true });

  const dest = new File(dir, `${id}${extensionOf(asset.name)}`);
  if (dest.exists) dest.delete();
  await new File(asset.uri).copy(dest);

  let thumbUri: string | undefined;
  if (isVideo(asset.mimeType)) {
    try {
      const thumb = await VideoThumbnails.getThumbnailAsync(dest.uri, { time: 0, quality: 0.6 });
      thumbUri = thumb.uri;
    } catch (e) {
      // A missing thumbnail just falls back to the file-type icon — not fatal.
      console.warn('[copa] video thumbnail failed:', e);
      Sentry.captureException(e, { tags: { source: 'copa-files', op: 'thumbnail' } });
    }
  }

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
 * saved straight into the device's media library after a write permission
 * prompt; any other type falls back to the share sheet (which offers "Save to
 * Files"). Surfaces a short alert on success/denial.
 */
export async function downloadCopaFile(item: CopaItem): Promise<void> {
  if (!item.fileUri) return;

  if (isSaveableMedia(item.mimeType)) {
    try {
      // Write-only is all we need to save, and asks for the least access.
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) {
        Alert.alert('Permission needed', 'Allow media access to save files to your device.');
        return;
      }
      await MediaLibrary.Asset.create(item.fileUri);
      Alert.alert('Saved', 'The file was saved to your device.');
      return;
    } catch (e) {
      // Fall through to sharing so the user can still get the file out.
      console.warn('[copa] save to device failed:', e);
      Sentry.captureException(e, { tags: { source: 'copa-files', op: 'save' } });
    }
  }

  await openCopaFile(item);
}
