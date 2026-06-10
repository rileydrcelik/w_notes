/**
 * Sync engine — SCAFFOLD. Wires up the device key + API client and defines the
 * shape of a sync pass, but the actual push/pull merge is stubbed on both ends
 * this pass (the server returns 501). `syncNow()` is safe to call: it no-ops
 * gracefully when sync isn't configured and swallows the stub's 501.
 *
 * ── Next pass: how this hooks into the app ──────────────────────────────────
 * 1. Persist a `sync_cursor` setting (last server_seq) via db.getSetting/
 *    setSetting, mirroring device-key.ts.
 * 2. push(): gather rows changed since the last push from `@/lib/db` (add a
 *    `dirty` flag or a `changes` journal to the schema) and POST /sync/push.
 * 3. pull(): GET /sync/pull?since=<cursor>, upsert returned rows into SQLite
 *    (last-writer-wins on updated_at, honor deleted_at), advance the cursor.
 * 4. Trigger: call syncNow() from NotesProvider/CopaProvider after the
 *    optimistic mutations (next to the existing `db.*().catch(syncFailed)`
 *    calls) plus on app foreground, debounced.
 */
import { Sentry } from '@/lib/sentry';
import { ApiError, apiFetch, syncConfigured } from './api';
import { getDeviceKey } from './device-key';

export type PushRequest = {
  folders: unknown[];
  notes: unknown[];
  copa_items: unknown[];
};

export type PullResponse = {
  folders: unknown[];
  notes: unknown[];
  copa_items: unknown[];
  server_seq: number;
};

export type SyncResult =
  | { status: 'ok'; cursor: number }
  | { status: 'skipped'; reason: string };

/**
 * Runs a single sync pass. STUBBED: the endpoints return 501 this pass, so this
 * verifies connectivity + auth end-to-end and then reports it was skipped. Wire
 * the real merge in per the steps above; the call sites won't need to change.
 */
export async function syncNow(): Promise<SyncResult> {
  if (!syncConfigured) {
    return { status: 'skipped', reason: 'EXPO_PUBLIC_API_URL not set' };
  }

  // Ensures the device key exists (and is persisted) before the first request.
  await getDeviceKey();

  try {
    // TODO(next pass): gather local changes and send a real payload.
    const payload: PushRequest = { folders: [], notes: [], copa_items: [] };
    await apiFetch('/sync/push', { method: 'POST', body: payload });

    // TODO(next pass): read + persist the real cursor, then upsert pulled rows.
    const pulled = await apiFetch<PullResponse>('/sync/pull?since=0');
    return { status: 'ok', cursor: pulled.server_seq };
  } catch (e) {
    // The scaffold server answers 501 until the merge lands — treat that as an
    // expected "not wired yet" rather than an error worth reporting.
    if (e instanceof ApiError && e.status === 501) {
      return { status: 'skipped', reason: 'sync endpoints not implemented yet' };
    }
    Sentry.captureException(e, { tags: { source: 'sync-engine' } });
    throw e;
  }
}
