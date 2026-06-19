/**
 * Web counterpart of the sync file-transfer primitives. Cross-device file bytes
 * ride an S3 presigned-URL flow: the row carries only a `remote_key`, and the
 * client transfers the bytes directly to/from S3 (they never touch the API).
 *
 * The native module moves bytes with expo-file-system's File API into the app
 * sandbox. On web there's no durable filesystem, so S3 is the source of truth: an
 * upload reads the picked file's object-URL bytes and PUTs them; a download
 * fetches them back into a fresh object URL for the session.
 *
 * Object URLs don't survive a page reload, so each session re-downloads a block's
 * bytes from S3 into a new URL. `prepareLocalFiles` (called once per session by
 * the sync engine) clears the stale URLs so that re-download happens.
 */
import { db } from '@/lib/db';
import { apiFetch } from './api';

/**
 * Drops object-URL paths left over from a previous session so the engine
 * re-downloads their bytes from S3. Runs once per session before the file passes.
 */
export async function prepareLocalFiles(): Promise<void> {
  await db.resetEphemeralFiles();
}

/**
 * Uploads a picked file's bytes to S3 and returns the object key to store on the
 * row. `fileUri` is the browser object URL the picker handed back; fetching it
 * yields the underlying bytes. Throws on failure so the caller leaves the row
 * pending for the next pass.
 */
export async function uploadCopaFile(fileUri: string, mimeType: string | null): Promise<string> {
  const blob = await (await fetch(fileUri)).blob();
  const { key, url } = await apiFetch<{ key: string; url: string }>('/files/upload-url', {
    method: 'POST',
    body: { mime_type: mimeType },
  });
  const res = await fetch(url, {
    method: 'PUT',
    headers: mimeType ? { 'Content-Type': mimeType } : {},
    body: blob,
  });
  if (!res.ok) throw new Error(`S3 upload failed: ${res.status} ${res.statusText}`);
  return key;
}

/**
 * Downloads a block's bytes from S3 and returns a session object URL to render
 * from. There's no video-thumbnail step on web (no native generator), so
 * `thumbUri` is always null. Throws on failure so the row stays queued.
 */
export async function downloadCopaFile(_row: {
  id: string;
  remoteKey: string;
  mimeType: string | null;
  fileName: string | null;
}): Promise<{ fileUri: string; thumbUri: string | null }> {
  const { url } = await apiFetch<{ url: string }>('/files/download-url', {
    method: 'POST',
    body: { key: _row.remoteKey },
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`S3 download failed: ${res.status} ${res.statusText}`);
  const blob = await res.blob();
  return { fileUri: URL.createObjectURL(blob), thumbUri: null };
}
