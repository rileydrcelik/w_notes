/**
 * Sync engine — delta sync against the backend, keyed on the device key.
 *
 * A pass is: push every locally-dirty row, then pull everything the server has
 * changed since our cursor and apply it last-writer-wins. Conflict resolution
 * lives in the DB layer (`applyServerRows`); this module orchestrates the round
 * trip, the cursor, concurrency, and notifying the stores when data changed.
 *
 * Identity is still the anonymous device key this pass — enough to back up and
 * round-trip a single device. Real cross-device sync arrives with auth (a shared
 * account identity); the engine itself won't change, only how the bearer token
 * is obtained.
 */
import { Sentry } from '@/lib/sentry';
import { db, type SyncPayload } from '@/lib/db';
import { isDbLockedError } from '@/lib/web-db-lock';
import { AuthUnavailableError } from '@/lib/auth/token';
import { ApiError, apiFetch, syncConfigured } from './api';
import { getDeviceKey, rotateDeviceKey } from './device-key';
import { downloadCopaFile, prepareLocalFiles, uploadCopaFile } from './files';

const SYNCED_UID = 'synced_uid';

type PullResponse = SyncPayload & { server_seq: number };

export type SyncResult =
  | { status: 'ok'; cursor: number; pushed: number; pulled: number }
  | { status: 'skipped'; reason: string };

// ---- "data changed" subscription, so stores can refresh after a pull ----

const listeners = new Set<() => void>();

/** Subscribe to "sync applied remote changes"; returns an unsubscribe fn. */
export function subscribeSynced(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitSynced(): void {
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      Sentry.captureException(e, { tags: { source: 'sync-engine', op: 'emit' } });
    }
  }
}

// ---- Core pass (deduped so overlapping triggers share one in-flight run) ----

let inflight: Promise<SyncResult> | null = null;

// One-time per-session reconciliation of local file paths (see prepareLocalFiles).
let filesPrepared = false;

/**
 * Runs one sync pass. Safe to call from anywhere and as often as you like:
 * concurrent calls return the same in-flight promise, and it no-ops cleanly when
 * sync isn't configured.
 */
export function syncNow(): Promise<SyncResult> {
  if (inflight) return inflight;
  inflight = runSync().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function runSync(): Promise<SyncResult> {
  if (!syncConfigured) {
    return { status: 'skipped', reason: 'EXPO_PUBLIC_API_URL not set' };
  }

  try {
    // Ensure the device key exists + is persisted before the first request.
    await getDeviceKey();

    // Once per session, reconcile local file paths before any file pass (web
    // clears stale object URLs so their bytes re-download; native no-ops).
    if (!filesPrepared) {
      await prepareLocalFiles();
      filesPrepared = true;
    }

    // 0) Upload bytes for any file blocks not yet in S3, stamping each row with
    //    its remote_key so the push below carries it across to other devices.
    await uploadPendingFiles();

    // 1) Push local changes. The server takes them last-writer-wins; on success
    //    we clear the dirty flags for exactly what we sent.
    const dirty = await db.getDirty();
    const pushed =
      dirty.folders.length + dirty.notes.length + dirty.copa_items.length + dirty.issues.length;
    if (pushed > 0) {
      await apiFetch('/sync/push', { method: 'POST', body: dirty });
      await db.markSynced(dirty);
    }

    // 2) Pull everything changed since our cursor and apply it locally.
    const cursor = await db.getCursor();
    const pulled = await apiFetch<PullResponse>(`/sync/pull?since=${cursor}`);
    const changed = await db.applyServerRows(pulled);
    await db.setCursor(pulled.server_seq);

    // 3) Download bytes for any file blocks we now know about but don't hold
    //    locally yet (e.g. created on another device).
    const downloaded = await downloadMissingFiles();

    if (changed > 0 || downloaded > 0) emitSynced();
    return { status: 'ok', cursor: pulled.server_seq, pushed, pulled: changed };
  } catch (e) {
    // 501 = endpoints not wired (shouldn't happen now, but stays graceful).
    if (e instanceof ApiError && e.status === 501) {
      return { status: 'skipped', reason: 'sync endpoints not implemented' };
    }
    // The account's Firebase session isn't available yet (restoring on launch,
    // or dropped). Defer rather than fork the account's data onto the device key.
    if (e instanceof AuthUnavailableError) {
      return { status: 'skipped', reason: 'auth session unavailable' };
    }
    // A follower browser tab can't reach the OPFS database (another tab owns it);
    // the DbTabGuard handles that, so skip rather than report it as an error.
    if (isDbLockedError(e)) {
      return { status: 'skipped', reason: 'database owned by another tab' };
    }
    Sentry.captureException(e, { tags: { source: 'sync-engine' } });
    throw e;
  }
}

/**
 * Uploads bytes for every file block that isn't in S3 yet, recording the
 * returned object key on the row (which re-queues it to push). Each file is
 * best-effort: a failure is logged and left pending for the next pass.
 */
async function uploadPendingFiles(): Promise<void> {
  const uploads = await db.getCopaUploads();
  for (const u of uploads) {
    try {
      const key = await uploadCopaFile(u.fileUri, u.mimeType);
      await db.setCopaRemoteKey(u.id, key);
    } catch (e) {
      console.warn('[sync] file upload failed:', e);
      Sentry.captureException(e, { tags: { source: 'sync-engine', op: 'upload' } });
    }
  }
}

/**
 * Downloads bytes for every file block we know of (has a remote_key) but don't
 * hold locally. Returns how many landed, so the caller can refresh the UI.
 */
async function downloadMissingFiles(): Promise<number> {
  const downloads = await db.getCopaDownloads();
  let landed = 0;
  for (const d of downloads) {
    try {
      const { fileUri, thumbUri } = await downloadCopaFile(d);
      await db.setCopaLocalFile(d.id, fileUri, thumbUri);
      landed += 1;
    } catch (e) {
      console.warn('[sync] file download failed:', e);
      Sentry.captureException(e, { tags: { source: 'sync-engine', op: 'download' } });
    }
  }
  return landed;
}

// ---- Account transitions (merge on sign-in, clean swap on sign-out) ----
//
// The bearer the API client sends is determined by the auth layer (Firebase ID
// token when signed in, else device key). These two functions keep the *local*
// data consistent across that transition. The caller (auth context) must update
// the active user *before* invoking them so the sync runs under the right
// identity.

/**
 * Run when a Firebase user signs in. The first account on a device claims the
 * anonymous local notes (mark everything dirty so it re-pushes under the new
 * identity); a different account replaces the local data instead. Either way we
 * reset the pull cursor — we're a different server user now — then sync.
 */
export async function onSignIn(uid: string): Promise<void> {
  const prev = await db.getSetting(SYNCED_UID);
  if (prev !== uid) {
    if (!prev) {
      await db.markAllDirty(); // claim anonymous data into this account
    } else {
      await db.clearAllData(); // switched accounts without a clean sign-out
    }
    await db.setCursor(0);
    await db.setSetting(SYNCED_UID, uid);
  }
  await syncNow().catch(() => {});
  emitSynced(); // refresh the UI even if the pull brought nothing
}

/**
 * Run when the user signs out: flush pending changes under the account, then
 * wipe the local copy and rotate to a fresh anonymous device key so the next
 * (anonymous) session is a clean, separate identity.
 */
export async function onSignOut(): Promise<void> {
  await syncNow().catch(() => {});
  await db.clearAllData();
  await db.setCursor(0);
  await db.setSetting(SYNCED_UID, '');
  await rotateDeviceKey();
  emitSynced();
}

// ---- Debounced trigger for the write path ----

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 800;

/**
 * Fire-and-forget sync, coalesced so a burst of edits results in a single pass
 * shortly after the user stops typing. Errors are swallowed (already reported to
 * Sentry inside the pass) so callers in the optimistic write path stay simple.
 */
export function requestSync(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void syncNow().catch(() => {});
  }, DEBOUNCE_MS);
}
