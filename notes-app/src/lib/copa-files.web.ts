/**
 * Web counterpart of `copa-files.ts`. The native module copies bytes into the
 * app sandbox, generates video thumbnails, and hands files to the OS share/save
 * sheets via expo-file-system / -media-library / -sharing — none of which exist
 * on web. Here the picker hands back a browser object URL we use directly, and
 * opening/saving goes through a plain anchor download.
 *
 * Scoped limitation (local-only first pass): object URLs don't survive a page
 * reload, so a web-attached file's bytes are session-only. The row metadata
 * (name, type, size) persists; the bytes would need the S3 sync path to round-
 * trip, which isn't wired on web yet.
 */
import type { ComponentProps } from 'react';
import Feather from '@expo/vector-icons/Feather';
import * as DocumentPicker from 'expo-document-picker';

import type { CopaItem } from '@/data/copa';

type FeatherName = ComponentProps<typeof Feather>['name'];

export type ImportedFile = Pick<
  CopaItem,
  'fileUri' | 'fileName' | 'mimeType' | 'fileSize' | 'thumbUri'
>;

export const isImage = (mime?: string): boolean => !!mime?.startsWith('image/');
export const isVideo = (mime?: string): boolean => !!mime?.startsWith('video/');
export const isAudio = (mime?: string): boolean => !!mime?.startsWith('audio/');

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

/** Largest file we'll import (2 GB). Matches the native cap / backend advisory. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Prompts the user to pick a file and imports it for the given block id. On web
 * the picker returns a browser object URL, which we keep as the block's
 * `fileUri`. Returns `null` if the user cancelled (or the file is over the cap).
 */
export async function importPickedFile(_id: string): Promise<ImportedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: false,
  });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];

  if (asset.size && asset.size > MAX_UPLOAD_BYTES) {
    window.alert('Files must be under 2 GB to add.');
    return null;
  }

  return {
    fileUri: asset.uri,
    fileName: asset.name,
    mimeType: asset.mimeType,
    fileSize: asset.size ?? undefined,
    thumbUri: undefined,
  };
}

/** Best-effort cleanup of a block's object URL (no-op for non-blob URIs). */
export function removeCopaFiles({ fileUri }: { fileUri?: string; thumbUri?: string }): void {
  if (fileUri?.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(fileUri);
    } catch {
      // Already revoked / not an object URL — nothing to do.
    }
  }
}

/** Opens the file in a new browser tab. No-op for text blocks. */
export async function openCopaFile(item: CopaItem): Promise<void> {
  if (!item.fileUri) return;
  window.open(item.fileUri, '_blank', 'noopener');
}

/** Triggers a browser download of the file. */
export async function downloadCopaFile(item: CopaItem): Promise<void> {
  if (!item.fileUri) return;
  const a = document.createElement('a');
  a.href = item.fileUri;
  a.download = item.fileName ?? 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
