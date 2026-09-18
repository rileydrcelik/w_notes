/**
 * One sync pass per browser profile, not per tab.
 *
 * `inflight` inside `sync-engine.ts` dedupes concurrent passes within one
 * JavaScript realm, which was the whole story while only one tab could reach
 * the database. Now that every tab can, each would run its own pass — and they
 * would collide on the backend's per-user advisory lock, where the loser waits
 * out `lock_timeout` holding a connection from a small pool. That is the outage
 * in docs/HANDOFF-2026-09-15-sync-wedge.md, turned from an edge case into a
 * steady state. `ownsBackgroundWork` is the only thing standing in the way, so
 * this pins that `syncNow` actually asks it.
 *
 * Everything `sync-engine.ts` imports is mocked: the real chain reaches
 * `expo-sqlite` and `@sentry/react-native`, neither of which resolves under
 * this node-environment vitest config.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: {
    getDirty: vi.fn(() => Promise.resolve({})),
    markSynced: vi.fn(() => Promise.resolve()),
    getCursor: vi.fn(() => Promise.resolve(0)),
    setCursor: vi.fn(() => Promise.resolve()),
    applyServerRows: vi.fn(() => Promise.resolve()),
    getSetting: vi.fn(() => Promise.resolve(null)),
    setSetting: vi.fn(() => Promise.resolve()),
    getCopaUploads: vi.fn(() => Promise.resolve([])),
    getCopaDownloads: vi.fn(() => Promise.resolve([])),
    getNoteImageUploads: vi.fn(() => Promise.resolve([])),
    getNoteImageDownloads: vi.fn(() => Promise.resolve([])),
    sweepNoteImages: vi.fn(() => Promise.resolve()),
    setCopaLocalFile: vi.fn(() => Promise.resolve()),
    setCopaRemoteKey: vi.fn(() => Promise.resolve()),
    ensureOpen: vi.fn(() => Promise.resolve()),
    clearAllData: vi.fn(() => Promise.resolve()),
    markAllDirty: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('@/lib/web-db-lock', () => ({
  isDbLockedError: vi.fn(() => false),
  ownsBackgroundWork: vi.fn(() => Promise.resolve(true)),
}));

/**
 * The seam, standing in for "this tab owns the database" and "it doesn't".
 *
 * `routed` records what a non-owning tab handed to the owner, which is the
 * whole distinction here: skipping the work and reporting success is not the
 * same as having it done somewhere it can be.
 */
const routed: string[] = [];
let ownsDb = true;

vi.mock('@/lib/db-tabs', () => ({
  runInDbOwner:
    (name: string, fn: (...args: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]) => {
      if (ownsDb) return fn(...args);
      routed.push(name);
      // What the owner answered. Deliberately not a 'skipped' shape: the caller
      // is entitled to treat this as a pass that really happened.
      return { status: 'ok', cursor: 0, pushed: 0, pulled: 0 };
    },
}));

vi.mock('@/lib/sentry', () => ({
  Sentry: { captureException: vi.fn(), addBreadcrumb: vi.fn() },
}));

vi.mock('@/lib/auth/token', () => ({
  AuthUnavailableError: class AuthUnavailableError extends Error {},
}));

vi.mock('@/lib/github-outbox', () => ({
  clearGithubOutbox: vi.fn(() => Promise.resolve()),
  reassignGithubOutbox: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/issue-retitle', () => ({
  clearIssueRetitles: vi.fn(() => Promise.resolve()),
  reassignIssueRetitles: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/github-issue-drafts', () => ({
  holdGithubDraftsForAccountChange: vi.fn(() => Promise.resolve()),
  reassignGithubDrafts: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/sync/api', () => ({
  ApiError: class ApiError extends Error {},
  apiFetch: vi.fn(() => Promise.resolve({ server_seq: 0 })),
  syncConfigured: true,
}));

vi.mock('@/lib/sync/device-key', () => ({
  getDeviceKey: vi.fn(() => Promise.resolve('device-key')),
  rotateDeviceKey: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/sync/files', () => ({
  downloadCopaFile: vi.fn(() => Promise.resolve({ fileUri: '', thumbUri: null })),
  prepareLocalFiles: vi.fn(() => Promise.resolve()),
  uploadCopaFile: vi.fn(() => Promise.resolve('key')),
}));

/** Fresh module state (`inflight`, `filesPrepared`) and re-armed mocks. */
async function load() {
  vi.resetModules();
  // `vi.mock` factories run once, so the same `vi.fn()` instances are shared by
  // every test here; without this, one test's call counts leak into the next.
  vi.clearAllMocks();
  routed.length = 0;
  ownsDb = true;
  const lock = await import('@/lib/web-db-lock');
  const api = await import('@/lib/sync/api');
  const deviceKey = await import('@/lib/sync/device-key');
  const engine = await import('@/lib/sync/sync-engine');
  return { engine, lock, api, deviceKey };
}

describe('syncNow — the pass belongs to the tab that owns the database', () => {
  it('runs the pass here when this tab owns it', async () => {
    const { engine, deviceKey } = await load();

    const result = await engine.syncNow();

    expect(result.status).not.toBe('skipped');
    expect(deviceKey.getDeviceKey).toHaveBeenCalled();
    expect(routed).toEqual([]);
  });

  it('hands the pass to the owner rather than skipping it', async () => {
    const { engine, api, deviceKey } = await load(); // resets ownsDb, so set it after
    ownsDb = false;

    const result = await engine.syncNow();

    // Asked for, not silently dropped. A tab that reported "skipped" still
    // looked to its caller like a tab that had synced — which is what let
    // sign-out wipe the database behind a flush that never ran.
    expect(routed).toContain('sync:now');
    expect(result.status).toBe('ok');
    // And none of it ran here: this tab has no business touching the network or
    // the device key on behalf of a database it doesn't hold.
    expect(api.apiFetch).not.toHaveBeenCalled();
    expect(deviceKey.getDeviceKey).not.toHaveBeenCalled();
  });

  it('hands sign-out to the owner too, so its flush cannot be skipped', async () => {
    const { engine } = await load(); // resets ownsDb, so set it after
    ownsDb = false;
    const { db } = await import('@/lib/db');

    await engine.onSignOut();

    expect(routed).toContain('sync:onSignOut');
    // The wipe is the second half of that operation. Running it here while the
    // flush was skipped is precisely how an unpushed edit was lost: deleted
    // locally through the seam, never sent anywhere.
    expect(db.clearAllData).not.toHaveBeenCalled();
  });
});

describe('a pass whose account changes underneath it', () => {
  it('pushes, then refuses to write bookkeeping belonging to the old identity', async () => {
    const { engine, api } = await load();
    const { db } = await import('@/lib/db');
    vi.mocked(db.getDirty).mockResolvedValue({ notes: [{ id: 'n1' }] } as never);
    // Anonymous when the pass starts; signed in by the time the push returns.
    vi.mocked(db.getSetting).mockResolvedValueOnce('').mockResolvedValue('uid-1');

    const result = await engine.syncNow();

    expect(api.apiFetch).toHaveBeenCalled();
    // Clearing `dirty` here would strip the flags the claim just set, so those
    // rows would never be pushed to the account that now owns them; saving the
    // cursor would store a watermark earned under the device key as the
    // account's, hiding every older row of that account for good.
    expect(db.markSynced).not.toHaveBeenCalled();
    expect(db.setCursor).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'skipped', reason: 'account changed mid-pass' });
  });
});
