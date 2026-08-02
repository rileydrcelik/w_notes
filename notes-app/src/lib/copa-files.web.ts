/**
 * Web counterpart of `copa-files.ts`. The native module copies bytes into the
 * app sandbox, generates video thumbnails, and hands files to the OS share/save
 * sheets via expo-file-system / -media-library / -sharing — none of which exist
 * on web. Here the picker hands back a browser object URL we use directly, and
 * opening/saving goes through a plain anchor download.
 *
 * Object URLs don't survive a page reload, so the uri a block holds here is
 * session-only. That's fine because the bytes themselves live in S3: the sync
 * engine uploads them (lib/sync/files.web.ts) and re-downloads them into a fresh
 * object URL each session.
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

/**
 * A file the browser hands over outside the picker — a clipboard paste or a
 * drag-and-drop. Structurally a DOM `File`, typed as a named `Blob` so the
 * native counterpart can declare the same signature without pulling in DOM
 * globals it doesn't have.
 */
export type DroppedFile = Blob & { name?: string };

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

/** Longest we'll wait for a frame before giving up on a thumbnail. */
const THUMBNAIL_TIMEOUT_MS = 8000;
/** Widest thumbnail we generate; a card never shows more than a few hundred px. */
const THUMBNAIL_MAX_WIDTH = 640;

/**
 * Generates a video frame thumbnail uri, or `undefined` if it can't — the web
 * counterpart of native's `expo-video-thumbnails` call.
 *
 * The browser has no thumbnail API, so this draws the frame itself: load the
 * video far enough to seek, seek a little way in, paint that frame onto a canvas
 * and keep the result as its own object URL. Seeking off zero on purpose — the
 * first frame of a lot of video is a black or blank lead-in, which makes for a
 * thumbnail that looks broken rather than empty.
 *
 * Never throws and never rejects. A block with no thumbnail falls back to the
 * film icon, which is a perfectly good outcome; a rejected promise here would
 * take down the import or the sync pass that asked for it. The timeout exists
 * for the same reason — a video the browser can't decode would otherwise leave
 * the caller waiting on an event that never comes.
 */
export async function generateVideoThumbnail(fileUri: string): Promise<string | undefined> {
  if (typeof document === 'undefined') return undefined;

  return new Promise<string | undefined>((resolve) => {
    const video = document.createElement('video');
    let settled = false;

    const finish = (uri: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Detach the source so the browser can release the decoded video.
      video.removeAttribute('src');
      video.load();
      resolve(uri);
    };

    const timer = setTimeout(() => finish(undefined), THUMBNAIL_TIMEOUT_MS);

    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.crossOrigin = 'anonymous';

    video.onerror = () => finish(undefined);

    video.onloadeddata = () => {
      // A short way in, but never past the end of a very short clip.
      const target = Number.isFinite(video.duration) ? Math.min(0.5, video.duration / 4) : 0;
      // Seeking to where we already are fires no `seeked` event, so draw now.
      if (target <= 0 || video.currentTime === target) draw();
      else video.currentTime = target;
    };

    video.onseeked = draw;

    function draw() {
      try {
        const { videoWidth, videoHeight } = video;
        if (!videoWidth || !videoHeight) return finish(undefined);
        const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / videoWidth);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(videoWidth * scale);
        canvas.height = Math.round(videoHeight * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return finish(undefined);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => finish(blob ? URL.createObjectURL(blob) : undefined),
          'image/jpeg',
          0.6,
        );
      } catch {
        // Tainted canvas, decode failure, anything — no thumbnail, no crash.
        finish(undefined);
      }
    }

    video.src = fileUri;
  });
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
    thumbUri: isVideo(asset.mimeType) ? await generateVideoThumbnail(asset.uri) : undefined,
  };
}

/**
 * Names a pasted/dropped file. Every clipboard screenshot arrives as the same
 * generic `image.png`, so those get stamped with the time they landed — five
 * pastes in a row should not produce five identically-named blocks.
 */
function droppedFileName(file: DroppedFile): string {
  const given = file.name?.trim();
  if (given && given !== 'image.png') return given;
  // `image/svg+xml` → `.svg`; a type-less blob falls back to `.bin`.
  const subtype = file.type.split('/')[1]?.split('+')[0];
  const ext = extensionOf(given ?? '') || `.${subtype || 'bin'}`;
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-');
  return `Pasted ${stamp}${ext}`;
}

/**
 * Imports a file the browser already handed us (a Ctrl+V paste or a drop) into a
 * new file block, skipping the picker. Same contract as `importPickedFile`: the
 * object URL becomes the block's `fileUri`, and the sync engine uploads its bytes
 * to S3 from there. Returns `null` if the file is over the size cap.
 */
export async function importDroppedFile(
  _id: string,
  file: DroppedFile,
): Promise<ImportedFile | null> {
  if (file.size > MAX_UPLOAD_BYTES) {
    window.alert('Files must be under 2 GB to add.');
    return null;
  }

  const fileUri = URL.createObjectURL(file);
  return {
    fileUri,
    fileName: droppedFileName(file),
    mimeType: file.type || undefined,
    fileSize: file.size || undefined,
    thumbUri: isVideo(file.type) ? await generateVideoThumbnail(fileUri) : undefined,
  };
}

/**
 * Best-effort cleanup of a block's object URLs (no-op for non-blob URIs).
 *
 * The thumbnail is its own object URL now that web generates one, so it needs
 * revoking alongside the file — leaving it behind pins the decoded frame in
 * memory for the rest of the session.
 */
export function removeCopaFiles({ fileUri, thumbUri }: { fileUri?: string; thumbUri?: string }): void {
  for (const uri of [fileUri, thumbUri]) {
    if (!uri?.startsWith('blob:')) continue;
    try {
      URL.revokeObjectURL(uri);
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
