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
  const lock = await import('@/lib/web-db-lock');
  const api = await import('@/lib/sync/api');
  const deviceKey = await import('@/lib/sync/device-key');
  const engine = await import('@/lib/sync/sync-engine');
  return { engine, lock, api, deviceKey };
}

describe('syncNow — only the tab that owns the database', () => {
  it('runs the pass in the tab that owns the database', async () => {
    const { engine, lock, deviceKey } = await load();
    vi.mocked(lock.ownsBackgroundWork).mockResolvedValue(true);

    const result = await engine.syncNow();

    expect(result.status).not.toBe('skipped');
    expect(deviceKey.getDeviceKey).toHaveBeenCalled();
  });

  it('skips the pass entirely in a tab that does not', async () => {
    const { engine, lock, api, deviceKey } = await load();
    vi.mocked(lock.ownsBackgroundWork).mockResolvedValue(false);

    const result = await engine.syncNow();

    expect(result).toEqual({
      status: 'skipped',
      reason: 'sync runs in the tab that owns the database',
    });
    // Nothing reached the network, and nothing even got as far as the device
    // key — the gate sits ahead of the whole pass, not inside it.
    expect(api.apiFetch).not.toHaveBeenCalled();
    expect(deviceKey.getDeviceKey).not.toHaveBeenCalled();
  });
});
