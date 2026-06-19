/**
 * File-attachment transfer for sync. Bytes for a copa file block live in S3, not
 * in the sync payload — the row only carries a `remote_key`. This module moves
 * the bytes: it asks the backend for a short-lived presigned URL, then the device
 * transfers directly to/from S3 (the bytes never touch the API).
 *
 * Orchestration (which rows need uploading/downloading, persisting the key/path)
 * lives in the sync engine; these are the two transfer primitives.
 */
import { File, UploadType } from 'expo-file-system';

import { copaDestination, extensionOf, generateVideoThumbnail, isVideo } from '@/lib/copa-files';
import { apiFetch } from './api';

/**
 * Per-session prep before the file passes. Native bytes live durably on disk, so
 * there's nothing to reconcile — the web counterpart clears stale object URLs.
 */
export async function prepareLocalFiles(): Promise<void> {}

/**
 * Uploads a local file to S3 and returns the object key to store on the row.
 * Throws on failure so the caller can leave the row pending for the next pass.
 */
export async function uploadCopaFile(fileUri: string, mimeType: string | null): Promise<string> {
  const { key, url } = await apiFetch<{ key: string; url: string }>('/files/upload-url', {
    method: 'POST',
    body: { mime_type: mimeType },
  });
  await new File(fileUri).upload(url, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers: mimeType ? { 'Content-Type': mimeType } : {},
  });
  return key;
}

/**
 * Downloads a block's bytes from S3 into the device's document dir and returns
 * the local paths to persist (plus a regenerated video thumbnail where it
 * applies). Throws on failure so the row stays queued for the next pass.
 */
export async function downloadCopaFile(row: {
  id: string;
  remoteKey: string;
  mimeType: string | null;
  fileName: string | null;
}): Promise<{ fileUri: string; thumbUri: string | null }> {
  const { url } = await apiFetch<{ url: string }>('/files/download-url', {
    method: 'POST',
    body: { key: row.remoteKey },
  });
  const dest = copaDestination(row.id, extensionOf(row.fileName ?? ''));
  await File.downloadFileAsync(url, dest, { idempotent: true });
  const thumbUri = isVideo(row.mimeType ?? undefined)
    ? ((await generateVideoThumbnail(dest.uri)) ?? null)
    : null;
  return { fileUri: dest.uri, thumbUri };
}
