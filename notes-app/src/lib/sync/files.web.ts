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
 * bytes from S3 into a new URL. The previous session's dead URLs are cleared
 * when the database is opened rather than from here — see
 * `clearEphemeralFilePaths` in lib/db.ts for why that timing matters.
 */
import { generateVideoThumbnail, isVideo } from '@/lib/copa-files';
import { apiFetch } from './api';

/**
 * Nothing left to do here. Dropping the previous session's object-URL paths now
 * happens when the database is opened (`clearEphemeralFilePaths` in lib/db.ts),
 * which is the only point early enough: the stores hydrate before the first sync
 * pass, so a reset that waited for this hook let the copa feed render dead URLs
 * as broken previews until the bytes came back.
 *
 * Running it again from here would be worse than pointless — by the time a sync
 * pass reaches this hook the user may already have attached a file, and nulling
 * that fresh `blob:` URL would strand its bytes with nothing left to upload.
 *
 * Kept as an export because native declares it too, and the pair must match
 * name-for-name (see lib/__tests__/platform-parity.test.ts).
 */
export async function prepareLocalFiles(): Promise<void> {}

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
 * from, plus a freshly drawn thumbnail for a video. Throws on failure so the row
 * stays queued.
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
  const fileUri = URL.createObjectURL(blob);
  // `thumb_uri` is a device-local column and never syncs, so a video block that
  // arrived from another device has no thumbnail here however many times it has
  // been synced — this device has to draw its own. The bytes are already in hand
  // at this point, so generating costs a decode and nothing more; a failure just
  // leaves the film icon.
  const thumbUri = isVideo(_row.mimeType ?? undefined)
    ? ((await generateVideoThumbnail(fileUri)) ?? null)
    : null;
  return { fileUri, thumbUri };
}
