/**
 * `github-outbox.ts` is the offline queue that holds back task-manager GitHub
 * issue pushes and replays them once a sync pass gets through. See the module
 * doc atop `github-outbox.ts` for the invariants these tests pin.
 *
 * Mocking notes:
 *
 * - `@/lib/issue-github` is mocked wholesale (not `vi.importActual`), the same
 *   tactic `github-backsync.test.ts` uses (see its header comment): the real
 *   module imports `@/lib/sync/api` -> `@/lib/sentry` -> `@sentry/react-native`,
 *   which pulls in real React Native internals that don't resolve under this
 *   node-environment vitest config.
 * - `@/lib/db` is mocked for the same reason one layer down: `db.ts` imports
 *   `expo-sqlite`, a native module with no Node implementation.
 * - `@/lib/sentry`, `@/lib/web-db-lock` and `@/lib/auth/token` are mocked so
 *   nothing transitively drags in the above; `github-outbox.ts` only reads
 *   `Sentry.captureException`/`addBreadcrumb`, `isDbLockedError`, and the
 *   `AuthUnavailableError` class from them.
 * - `@/lib/sync/api` is mocked too, with a small stand-in `ApiError` class
 *   (message, status, body) — the one thing `isRetryable` needs `instanceof`.
 *
 * `github-outbox.ts` holds MODULE-LEVEL state (`entries`, `loading`,
 * `idSnapshot`, the write-serialization `chain`) that would otherwise bleed
 * from one test into the next. Every test calls `vi.resetModules()` and
 * re-imports the module under test fresh via the `load()` helper below, which
 * gives `github-outbox.ts` itself a clean slate.
 *
 * That reset does NOT touch the mocks, though: `vi.mock` factories run once
 * (they're not re-invoked by `resetModules()`, which only clears the *real*
 * module registry), so the mocked functions below are the same `vi.fn()`
 * instances across every test in this file. `load()` therefore also calls
 * `vi.resetAllMocks()` and re-arms every default itself — otherwise call
 * counts and resolved values from one test's mocks leak into the next.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Issue } from '@/data/notes';

/**
 * The settings table the queue actually lives in, keyed the way the real one is.
 *
 * A Map rather than bare `vi.fn()`s, because the queue is a genuine
 * read-modify-write now: every operation re-reads the stored blob before
 * changing it, so writes that went nowhere would leave each operation reading
 * an empty queue and discarding whatever the last one wrote. Losing entries
 * that way is the cross-tab bug this behaviour exists to prevent, and a mock
 * that cannot round trip would hide it.
 *
 * Wired up in `load()`, not in the factory below, which is hoisted above this.
 */
const settings = new Map<string, string>();

vi.mock('@/lib/db', () => ({
  db: {
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    getIssueById: vi.fn(),
  },
}));

vi.mock('@/lib/web-db-lock', () => ({
  isDbLockedError: vi.fn(() => false),
  // This realm owns the database, so the single-runner gate lets work through.
  ownsBackgroundWork: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@/lib/auth/token', () => ({
  AuthUnavailableError: class AuthUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AuthUnavailableError';
    }
  },
}));

vi.mock('@/lib/sync/api', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    body?: string;
    detail?: string;
    constructor(message: string, status: number, body?: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  },
}));

vi.mock('@/lib/sentry', () => ({
  Sentry: {
    captureException: vi.fn(),
    addBreadcrumb: vi.fn(),
  },
}));

vi.mock('@/lib/issue-github', () => ({
  createGithubIssue: vi.fn(),
  findGithubIssueByMarker: vi.fn(),
  getGithubIssueDetail: vi.fn(),
  githubIssueAssignees: vi.fn(),
  githubIssueBody: vi.fn(),
  githubIssueLabels: vi.fn(),
  githubSyncErrorMessage: vi.fn(),
  mergeManagedLabels: vi.fn(),
  setGithubIssueState: vi.fn(),
  updateGithubIssue: vi.fn(),
  upsertAttrsBlock: vi.fn(),
}));

type IssueRow = Issue & { deletedAt: number | null };

function makeRow(overrides: Partial<IssueRow> = {}): IssueRow {
  return {
    id: 'i1',
    noteId: 't1',
    typeIds: ['t1'],
    title: 'Fix the bug',
    description: '',
    done: false,
    attrs: {},
    position: 0,
    createdAt: 0,
    updatedAt: '2026-01-01',
    deletedAt: null,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<{ repo: string; connected: boolean }> = {}) {
  return {
    repo: 'acme/widgets',
    attributes: [],
    typeTitles: [],
    projectTypeNames: [],
    connected: true,
    ...overrides,
  };
}

/**
 * Reset the real module registry (so `github-outbox.ts` gets fresh
 * `entries`/`idSnapshot`/`chain` state) and re-arm every mock with the
 * defaults each test can build on. See the header comment for why both steps
 * are necessary.
 */
async function load() {
  vi.resetModules();
  const [{ db }, issueGithub, { ApiError }, { Sentry }, outbox] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/issue-github'),
    import('@/lib/sync/api'),
    import('@/lib/sentry'),
    import('@/lib/github-outbox'),
  ]);

  vi.resetAllMocks();
  settings.clear();
  vi.mocked(db.getSetting).mockImplementation(async (key: string) => settings.get(key) ?? null);
  vi.mocked(db.setSetting).mockImplementation(async (key: string, value: string) => {
    settings.set(key, value);
  });
  vi.mocked(db.getIssueById).mockResolvedValue(null);
  vi.mocked(issueGithub.findGithubIssueByMarker).mockResolvedValue(null);
  vi.mocked(issueGithub.getGithubIssueDetail).mockResolvedValue({ labels: [], body: null });
  vi.mocked(issueGithub.githubIssueAssignees).mockReturnValue([]);
  // Real shape enough to assert on: embeds the id the way the real marker does.
  vi.mocked(issueGithub.githubIssueBody).mockImplementation(
    (_description: unknown, _attributes: unknown, _attrs: unknown, id?: string) =>
      `<!-- w-notes:issue:${id} -->`,
  );
  vi.mocked(issueGithub.githubIssueLabels).mockReturnValue([]);
  vi.mocked(issueGithub.githubSyncErrorMessage).mockImplementation((e: unknown) =>
    e instanceof Error ? e.message : 'Unknown error.',
  );
  vi.mocked(issueGithub.mergeManagedLabels).mockReturnValue([]);
  vi.mocked(issueGithub.setGithubIssueState).mockResolvedValue(undefined);
  vi.mocked(issueGithub.updateGithubIssue).mockResolvedValue(undefined);
  vi.mocked(issueGithub.upsertAttrsBlock).mockImplementation(
    (body?: string | null) => `UPSERTED[${body ?? ''}]`,
  );

  return { db, issueGithub, ApiError, Sentry, outbox };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('isRetryable', () => {
  it('is true for a bare TypeError — apiFetch throws ApiError only for a response the server actually sent, so anything else is offline/DNS/CORS', async () => {
    const { outbox } = await load();
    expect(outbox.isRetryable(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('is true for AuthUnavailableError — a mid-session-restore failure resolves on its own', async () => {
    const { outbox } = await load();
    const { AuthUnavailableError } = await import('@/lib/auth/token');
    expect(outbox.isRetryable(new AuthUnavailableError('restoring'))).toBe(true);
  });

  it.each([400, 404, 410, 422, 502, 503])(
    'is false for ApiError %d — a refusal, not a connectivity blip',
    async (status) => {
      const { outbox, ApiError } = await load();
      expect(outbox.isRetryable(new ApiError('nope', status))).toBe(false);
    },
  );

  it.each([429, 504])(
    'is true for ApiError %d — throttled or timed out, not refused',
    async (status) => {
      const { outbox, ApiError } = await load();
      expect(outbox.isRetryable(new ApiError('slow down', status))).toBe(true);
    },
  );

  it('is false for the unconfigured-build error ("EXPO_PUBLIC_API_URL is not set") — there is no server to ever come back to', async () => {
    const { outbox } = await load();
    expect(outbox.isRetryable(new Error('EXPO_PUBLIC_API_URL is not set'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('pushOrQueue', () => {
  it('returns pushed and queues nothing on success', async () => {
    const { outbox, db } = await load();
    const push = vi.fn().mockResolvedValue(undefined);

    const result = await outbox.pushOrQueue({ issueId: 'i1', repo: 'acme/widgets', push });

    expect(result).toEqual({ status: 'pushed' });
    expect(outbox.pendingGithubIssueIds().has('i1')).toBe(false);
    expect(db.setSetting).not.toHaveBeenCalled();
  });

  it('returns queued and adds a pending id on a transport failure', async () => {
    const { outbox } = await load();
    const push = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await outbox.pushOrQueue({ issueId: 'i2', repo: 'acme/widgets', push });

    expect(result).toEqual({ status: 'queued' });
    expect(outbox.pendingGithubIssueIds().has('i2')).toBe(true);
  });

  it('returns failed with a message and queues NOTHING on a refusal (ApiError 400)', async () => {
    const { outbox, ApiError } = await load();
    const push = vi.fn().mockRejectedValue(new ApiError('bad token', 400));

    const result = await outbox.pushOrQueue({ issueId: 'i3', repo: 'acme/widgets', push });

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.message).toBeTruthy();
    expect(outbox.pendingGithubIssueIds().has('i3')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('facet OR-merge (queueGithubPush)', () => {
  it('collapses an edit (details) then a done-toggle (state) for the same issue into one entry carrying both, preserving the original queuedAt', async () => {
    const { outbox, db } = await load();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    await outbox.queueGithubPush('i1', 'acme/widgets', { details: true });
    vi.setSystemTime(5_000);
    await outbox.queueGithubPush('i1', 'acme/widgets', { state: true });

    expect(outbox.pendingGithubIssueIds().size).toBe(1);
    // The persisted queue is the durable record the merge writes; read it back
    // rather than reaching into module-private state.
    const lastPersist = vi.mocked(db.setSetting).mock.calls.at(-1);
    const persisted = JSON.parse(lastPersist?.[1] as string);
    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0]).toMatchObject({
      issueId: 'i1',
      details: true,
      state: true,
      queuedAt: 1_000,
    });
  });
});

// ---------------------------------------------------------------------------

describe('flushGithubOutbox — a create that waits on its AI title', () => {
  it('holds the create while holdCreate says the title is still being written, then opens it once it is not', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('i1', 'acme/widgets', { details: true });
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1', title: 'Model title' }));
    vi.mocked(issueGithub.createGithubIssue).mockResolvedValue(99);
    const resolve = vi.fn().mockReturnValue(makeCtx());
    const setGhNumber = vi.fn();
    let titling = true;
    const holdCreate = vi.fn(() => titling);

    const held = await outbox.flushGithubOutbox({ resolve, setGhNumber, holdCreate });

    expect(issueGithub.createGithubIssue).not.toHaveBeenCalled();
    expect(held).toEqual({ pushed: 0, dropped: 0, remaining: 1 });
    expect(outbox.pendingGithubIssueIds().has('i1')).toBe(true);

    titling = false;
    const opened = await outbox.flushGithubOutbox({ resolve, setGhNumber, holdCreate });

    expect(issueGithub.createGithubIssue).toHaveBeenCalledWith(
      'acme/widgets',
      expect.objectContaining({ title: 'Model title' }),
    );
    expect(setGhNumber).toHaveBeenCalledWith('i1', 99);
    expect(opened).toEqual({ pushed: 1, dropped: 0, remaining: 0 });
  });

  it('pushes a rename that landed while the create was out, since nothing else would', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('i1', 'acme/widgets', { details: true });
    vi.mocked(db.getIssueById)
      .mockResolvedValueOnce(makeRow({ id: 'i1', title: 'Stand-in' }))
      // Read back after the create returns: renamed in the meantime.
      .mockResolvedValue(makeRow({ id: 'i1', title: 'Renamed by hand', ghNumber: 99 }));
    vi.mocked(issueGithub.createGithubIssue).mockResolvedValue(99);
    const resolve = vi.fn().mockReturnValue(makeCtx());

    const result = await outbox.flushGithubOutbox({ resolve, setGhNumber: vi.fn() });

    expect(issueGithub.createGithubIssue).toHaveBeenCalledWith(
      'acme/widgets',
      expect.objectContaining({ title: 'Stand-in' }),
    );
    expect(issueGithub.updateGithubIssue).toHaveBeenCalledWith('acme/widgets', 99, {
      title: 'Renamed by hand',
    });
    expect(result).toEqual({ pushed: 1, dropped: 0, remaining: 0 });
  });

  it('sends no follow-up when the title did not change during the create', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('i1', 'acme/widgets', { details: true });
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1', title: 'Model title' }));
    vi.mocked(issueGithub.createGithubIssue).mockResolvedValue(99);

    await outbox.flushGithubOutbox({ resolve: vi.fn().mockReturnValue(makeCtx()), setGhNumber: vi.fn() });

    expect(issueGithub.updateGithubIssue).not.toHaveBeenCalled();
  });

  it('flushGithubOutboxNow uses the registered deps and reports a refusal to its caller', async () => {
    const { outbox, db, issueGithub, ApiError } = await load();
    expect(await outbox.flushGithubOutboxNow()).toBeNull(); // no runner mounted yet

    await outbox.queueGithubPush('i1', 'acme/widgets', { details: true });
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1' }));
    vi.mocked(issueGithub.createGithubIssue).mockRejectedValue(new ApiError('Repo not found', 404));
    outbox.setGithubOutboxDeps({ resolve: vi.fn().mockReturnValue(makeCtx()), setGhNumber: vi.fn() });
    const onRefused = vi.fn();

    const result = await outbox.flushGithubOutboxNow(onRefused);

    expect(onRefused).toHaveBeenCalledWith('i1', 'Repo not found');
    expect(result).toEqual({ pushed: 0, dropped: 1, remaining: 0 });
    outbox.setGithubOutboxDeps(null);
  });
});

// ---------------------------------------------------------------------------

describe('flushGithubOutbox — create path (no ghNumber yet)', () => {
  it('creates the GitHub issue with a body carrying the id marker, then records the number', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('i1', 'acme/widgets', {});
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1', done: false }));
    vi.mocked(issueGithub.createGithubIssue).mockResolvedValue(99);
    const setGhNumber = vi.fn();
    const resolve = vi.fn().mockReturnValue(makeCtx());

    const result = await outbox.flushGithubOutbox({ resolve, setGhNumber });

    expect(issueGithub.createGithubIssue).toHaveBeenCalledWith(
      'acme/widgets',
      expect.objectContaining({ body: expect.stringContaining('w-notes:issue:i1') }),
    );
    expect(setGhNumber).toHaveBeenCalledWith('i1', 99);
    expect(issueGithub.setGithubIssueState).not.toHaveBeenCalled();
    expect(result).toEqual({ pushed: 1, dropped: 0, remaining: 0 });
  });

  it('also closes the freshly-created issue when the local row is already done', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('i1', 'acme/widgets', {});
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1', done: true }));
    vi.mocked(issueGithub.createGithubIssue).mockResolvedValue(99);
    const resolve = vi.fn().mockReturnValue(makeCtx());

    await outbox.flushGithubOutbox({ resolve, setGhNumber: vi.fn() });

    expect(issueGithub.setGithubIssueState).toHaveBeenCalledWith('acme/widgets', 99, true);
  });
});

// ---------------------------------------------------------------------------

describe('flushGithubOutbox — adopt-or-create (duplicate-prevention invariant)', () => {
  it('does NOT scan for an existing issue on the first flush of a never-attempted (queueGithubPush) entry, but DOES on the retry', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('i1', 'acme/widgets', {});
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1' }));
    const resolve = vi.fn().mockReturnValue(makeCtx());
    const setGhNumber = vi.fn();

    // First flush: a transport failure on the create leaves the entry queued
    // with `attempts` bumped from 0 to 1 (bumpAttempts runs *before* the
    // request). 1 is not > 1, so the marker scan must not run yet.
    vi.mocked(issueGithub.createGithubIssue).mockRejectedValueOnce(new TypeError('offline'));
    const first = await outbox.flushGithubOutbox({ resolve, setGhNumber });
    expect(first).toEqual({ pushed: 0, dropped: 0, remaining: 1 });
    expect(issueGithub.findGithubIssueByMarker).not.toHaveBeenCalled();
    expect(issueGithub.createGithubIssue).toHaveBeenCalledTimes(1); // the failed attempt itself

    // Second flush: attempts is now 2 (>1), so the retry scans for the marker
    // first. Finding one, it must adopt that number rather than create again.
    vi.mocked(issueGithub.findGithubIssueByMarker).mockResolvedValue(77);
    const second = await outbox.flushGithubOutbox({ resolve, setGhNumber });

    expect(issueGithub.findGithubIssueByMarker).toHaveBeenCalledWith('acme/widgets', 'i1');
    expect(issueGithub.createGithubIssue).toHaveBeenCalledTimes(1); // not called again
    expect(setGhNumber).toHaveBeenCalledWith('i1', 77);
    expect(second).toEqual({ pushed: 1, dropped: 0, remaining: 0 });
  });

  it('scans for an existing issue on the very FIRST flush when the push had already been attempted once (pushOrQueue) — the earlier POST may have reached GitHub with only the response lost', async () => {
    const { outbox, db, issueGithub } = await load();
    const push = vi.fn().mockRejectedValue(new TypeError('offline'));
    await outbox.pushOrQueue({ issueId: 'i1', repo: 'acme/widgets', push });
    expect(outbox.pendingGithubIssueIds().has('i1')).toBe(true);

    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1' }));
    vi.mocked(issueGithub.findGithubIssueByMarker).mockResolvedValue(88);
    const resolve = vi.fn().mockReturnValue(makeCtx());
    const setGhNumber = vi.fn();

    const result = await outbox.flushGithubOutbox({ resolve, setGhNumber });

    expect(issueGithub.findGithubIssueByMarker).toHaveBeenCalledWith('acme/widgets', 'i1');
    expect(issueGithub.createGithubIssue).not.toHaveBeenCalled();
    expect(setGhNumber).toHaveBeenCalledWith('i1', 88);
    expect(result).toEqual({ pushed: 1, dropped: 0, remaining: 0 });
  });
});

// ---------------------------------------------------------------------------

describe('flushGithubOutbox — state intent survives a failed close after create', () => {
  it('persists the state intent BEFORE attempting the close, so a retryable failure there is retried as an update carrying state rather than losing the completion', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('i1', 'acme/widgets', {});
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1', done: true }));
    vi.mocked(issueGithub.createGithubIssue).mockResolvedValue(42);
    vi.mocked(issueGithub.setGithubIssueState).mockRejectedValueOnce(new TypeError('offline'));
    const resolve = vi.fn().mockReturnValue(makeCtx());
    const setGhNumber = vi.fn((id: string, n: number) => {
      // Mirror what the real store does: once numbered, the row read on the
      // next flush reflects the mirrored number.
      vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id, ghNumber: n, done: true }));
    });

    // First flush: the create succeeds, but the follow-up close fails offline.
    const first = await outbox.flushGithubOutbox({ resolve, setGhNumber });
    expect(first).toEqual({ pushed: 0, dropped: 0, remaining: 1 });
    expect(setGhNumber).toHaveBeenCalledWith('i1', 42);

    // Second flush: the entry now has ghNumber, so replay takes the update
    // branch — the surviving `state` intent must still ask GitHub to close it.
    const second = await outbox.flushGithubOutbox({ resolve, setGhNumber });

    expect(issueGithub.createGithubIssue).toHaveBeenCalledTimes(1); // never created twice
    const fields = vi.mocked(issueGithub.updateGithubIssue).mock.calls[0][2];
    expect(fields).toMatchObject({ state: 'closed', stateReason: 'completed' });
    expect(second).toEqual({ pushed: 1, dropped: 0, remaining: 0 });
  });
});

// ---------------------------------------------------------------------------

describe('flushGithubOutbox — seq guards a concurrent requeue', () => {
  it('does not drop an entry whose seq moved on because a fresh intent landed on it mid-replay', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('i1', 'acme/widgets', {});
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1' }));
    const resolve = vi.fn().mockReturnValue(makeCtx());
    const setGhNumber = vi.fn();

    // While this push is in flight, a fresh edit lands on the very same issue.
    vi.mocked(issueGithub.createGithubIssue).mockImplementation(async () => {
      await outbox.queueGithubPush('i1', 'acme/widgets', { details: true });
      return 5;
    });

    const result = await outbox.flushGithubOutbox({ resolve, setGhNumber });

    // The push that was in flight did go out...
    expect(setGhNumber).toHaveBeenCalledWith('i1', 5);
    // ...but the entry must survive to carry the intent that arrived after it
    // was captured for sending, rather than being deleted along with it.
    expect(outbox.pendingGithubIssueIds().has('i1')).toBe(true);
    expect(result).toEqual({ pushed: 1, dropped: 0, remaining: 1 });
  });
});

// ---------------------------------------------------------------------------

describe('flushGithubOutbox — edit path (ghNumber already set)', () => {
  it('preserves GitHub\'s body via upsertAttrsBlock and omits title/state when the queued edit touched neither', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('i1', 'acme/widgets', {}); // no details, no state
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1', ghNumber: 42, title: 'New title' }));
    vi.mocked(issueGithub.getGithubIssueDetail).mockResolvedValue({ labels: ['bug'], body: 'GITHUB BODY' });
    const resolve = vi.fn().mockReturnValue(makeCtx());

    await outbox.flushGithubOutbox({ resolve, setGhNumber: vi.fn() });

    expect(issueGithub.upsertAttrsBlock).toHaveBeenCalledWith('GITHUB BODY', [], {}, 'i1');
    expect(issueGithub.githubIssueBody).not.toHaveBeenCalled();
    const fields = vi.mocked(issueGithub.updateGithubIssue).mock.calls[0][2];
    expect(fields.body).toBe('UPSERTED[GITHUB BODY]');
    expect(fields).not.toHaveProperty('title');
    expect(fields).not.toHaveProperty('state');
  });

  it('rewrites both title and body via githubIssueBody when the queued edit touched details', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('i1', 'acme/widgets', { details: true });
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1', ghNumber: 42, title: 'New title' }));
    vi.mocked(issueGithub.getGithubIssueDetail).mockResolvedValue({ labels: [], body: 'GITHUB BODY' });
    const resolve = vi.fn().mockReturnValue(makeCtx());

    await outbox.flushGithubOutbox({ resolve, setGhNumber: vi.fn() });

    expect(issueGithub.upsertAttrsBlock).not.toHaveBeenCalled();
    expect(issueGithub.githubIssueBody).toHaveBeenCalled();
    const fields = vi.mocked(issueGithub.updateGithubIssue).mock.calls[0][2];
    expect(fields.title).toBe('New title');
    expect(fields.body).toContain('w-notes:issue:i1');
  });

  it('sends a state field only when the queued edit toggled done', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('i1', 'acme/widgets', { state: true });
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1', ghNumber: 42, done: true }));
    vi.mocked(issueGithub.getGithubIssueDetail).mockResolvedValue({ labels: [], body: null });
    const resolve = vi.fn().mockReturnValue(makeCtx());

    await outbox.flushGithubOutbox({ resolve, setGhNumber: vi.fn() });

    const fields = vi.mocked(issueGithub.updateGithubIssue).mock.calls[0][2];
    expect(fields).toMatchObject({ state: 'closed', stateReason: 'completed' });
    expect(fields).not.toHaveProperty('title');
  });

  it('sends the title but preserves GitHub\'s body via upsertAttrsBlock when the queued edit only carries a model retitle (title facet, no details)', async () => {
    // The retitle queue (issue-retitle.ts) sets ONLY the `title` facet — the
    // model replaced the stand-in, nothing about the description changed —
    // and the whole point of that facet is that it must NOT trigger the same
    // full-body rewrite `details` does: unlike `details`, a retitle must leave
    // whatever GitHub holds for the body alone apart from the managed
    // attributes block.
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('i1', 'acme/widgets', { title: true });
    vi.mocked(db.getIssueById).mockResolvedValue(
      makeRow({ id: 'i1', ghNumber: 42, title: 'Model-written title' }),
    );
    vi.mocked(issueGithub.getGithubIssueDetail).mockResolvedValue({ labels: [], body: 'GITHUB BODY' });
    const resolve = vi.fn().mockReturnValue(makeCtx());

    await outbox.flushGithubOutbox({ resolve, setGhNumber: vi.fn() });

    expect(issueGithub.upsertAttrsBlock).toHaveBeenCalledWith('GITHUB BODY', [], {}, 'i1');
    expect(issueGithub.githubIssueBody).not.toHaveBeenCalled();
    const fields = vi.mocked(issueGithub.updateGithubIssue).mock.calls[0][2];
    expect(fields.title).toBe('Model-written title');
    expect(fields.body).toBe('UPSERTED[GITHUB BODY]');
    expect(fields).not.toHaveProperty('state');
  });
});

// ---------------------------------------------------------------------------

describe('flushGithubOutbox — drops and holds', () => {
  it('drops an entry whose issue row no longer exists', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('gone', 'acme/widgets', {});
    vi.mocked(db.getIssueById).mockResolvedValue(null);

    const result = await outbox.flushGithubOutbox({ resolve: vi.fn(), setGhNumber: vi.fn() });

    expect(result).toEqual({ pushed: 0, dropped: 1, remaining: 0 });
    expect(outbox.pendingGithubIssueIds().has('gone')).toBe(false);
    expect(issueGithub.createGithubIssue).not.toHaveBeenCalled();
  });

  it('holds (does not drop) a tombstoned issue — a type-delete cascade is restorable, so the TTL is the only backstop', async () => {
    const { outbox, db } = await load();
    await outbox.queueGithubPush('trashed', 'acme/widgets', {});
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'trashed', deletedAt: 123 }));

    const result = await outbox.flushGithubOutbox({ resolve: vi.fn(), setGhNumber: vi.fn() });

    expect(result).toEqual({ pushed: 0, dropped: 0, remaining: 1 });
    expect(outbox.pendingGithubIssueIds().has('trashed')).toBe(true);
  });

  it('drops an entry when the project has been re-pointed at a different repo', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('i1', 'acme/widgets', {});
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1' }));
    const resolve = vi.fn().mockReturnValue(makeCtx({ repo: 'acme/other-repo' }));

    const result = await outbox.flushGithubOutbox({ resolve, setGhNumber: vi.fn() });

    expect(result).toEqual({ pushed: 0, dropped: 1, remaining: 0 });
    expect(issueGithub.updateGithubIssue).not.toHaveBeenCalled();
    expect(issueGithub.createGithubIssue).not.toHaveBeenCalled();
  });

  it('drops a create when tracking was turned off on GitHub while the push waited', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('i1', 'acme/widgets', {});
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1' })); // no ghNumber -> create path
    const resolve = vi.fn().mockReturnValue(makeCtx({ connected: false }));

    const result = await outbox.flushGithubOutbox({ resolve, setGhNumber: vi.fn() });

    expect(result).toEqual({ pushed: 0, dropped: 1, remaining: 0 });
    expect(issueGithub.createGithubIssue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('flushGithubOutbox — stops at the first retryable failure', () => {
  it('leaves the remaining entries queued rather than hammering them after a connection drop', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.queueGithubPush('first', 'acme/widgets', {});
    await outbox.queueGithubPush('second', 'acme/widgets', {});
    const rows: Record<string, IssueRow> = {
      first: makeRow({ id: 'first', ghNumber: 1 }),
      second: makeRow({ id: 'second', ghNumber: 2 }),
    };
    vi.mocked(db.getIssueById).mockImplementation(async (id: string) => rows[id] ?? null);
    vi.mocked(issueGithub.updateGithubIssue).mockRejectedValueOnce(new TypeError('offline'));
    const resolve = vi.fn().mockReturnValue(makeCtx());

    const result = await outbox.flushGithubOutbox({ resolve, setGhNumber: vi.fn() });

    expect(result).toEqual({ pushed: 0, dropped: 0, remaining: 2 });
    expect(issueGithub.updateGithubIssue).toHaveBeenCalledTimes(1);
    expect(outbox.pendingGithubIssueIds()).toEqual(new Set(['first', 'second']));
  });
});

// ---------------------------------------------------------------------------

describe('flushGithubOutbox — identity guard', () => {
  it('drops an entry stamped with a different identity than the current synced_uid, rather than pushing it', async () => {
    const { outbox, db, issueGithub } = await load();
    settings.set('synced_uid', 'user-A'); // the account that queued it
    await outbox.queueGithubPush('i1', 'acme/widgets', {});
    settings.set('synced_uid', 'user-B'); // a different account by the time it flushes
    // A row and a resolvable, connected context are both ready to push — proof
    // the drop below is really the identity guard, and not a coincidental drop
    // from a missing row or an unresolved project (which would produce the same
    // { dropped: 1 } outcome even if the guard were bypassed entirely).
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1' }));
    vi.mocked(issueGithub.createGithubIssue).mockResolvedValue(1);
    const resolve = vi.fn().mockReturnValue(makeCtx());

    const result = await outbox.flushGithubOutbox({ resolve, setGhNumber: vi.fn() });

    expect(result).toEqual({ pushed: 0, dropped: 1, remaining: 0 });
    expect(resolve).not.toHaveBeenCalled();
    expect(issueGithub.createGithubIssue).not.toHaveBeenCalled();
  });
});

describe('reassignGithubOutbox', () => {
  const stored = (identity: string) =>
    JSON.stringify({
      v: 1,
      entries: [
        {
          issueId: 'i1',
          repo: 'acme/widgets',
          identity,
          queuedAt: Date.now(),
          attempts: 0,
          seq: 1,
          details: true,
        },
      ],
    });

  it('re-stamps an entry that is only on disk — the claim can beat hydration', async () => {
    const { db, outbox } = await load();
    settings.set('github_outbox', stored(''));

    // Deliberately no loadGithubOutbox() first. onSignIn reaches the claim
    // straight from the auth callback, which can run before the runner has
    // hydrated — and that is precisely when this used to no-op, leaving the
    // stored entry stamped '' for the flush to drop as another account's.
    await outbox.reassignGithubOutbox('uid-1');

    const written = vi.mocked(db.setSetting).mock.calls.at(-1)?.[1];
    expect(JSON.parse(String(written)).entries[0].identity).toBe('uid-1');
  });

  it('keeps the rest of the entry intact while re-stamping it', async () => {
    const { db, outbox } = await load();
    settings.set('github_outbox', stored(''));

    await outbox.reassignGithubOutbox('uid-1');

    const entry = JSON.parse(String(vi.mocked(db.setSetting).mock.calls.at(-1)?.[1])).entries[0];
    expect(entry).toMatchObject({ issueId: 'i1', repo: 'acme/widgets', details: true, seq: 1 });
  });

  it('writes nothing when the queue really is empty', async () => {
    const { db, outbox } = await load(); // getSetting resolves null
    await outbox.reassignGithubOutbox('uid-1');
    expect(db.setSetting).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('flushGithubOutbox — only the tab that owns the database', () => {
  it('files nothing and keeps the entry queued when another tab owns the database', async () => {
    // Opening a GitHub issue is not idempotent — the queue exists precisely
    // because these are side effects that cannot be re-run — so two tabs
    // flushing the same entry files the same issue twice. `flushing` dedupes
    // only within one realm, so this gate is the whole defence.
    const { outbox, db, issueGithub } = await load();
    const { ownsBackgroundWork } = await import('@/lib/web-db-lock');
    await outbox.queueGithubPush('i1', 'acme/widgets', {});
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1' }));
    vi.mocked(issueGithub.createGithubIssue).mockResolvedValue(99);
    vi.mocked(ownsBackgroundWork).mockResolvedValue(false);

    const result = await outbox.flushGithubOutbox({
      resolve: vi.fn().mockReturnValue(makeCtx()),
      setGhNumber: vi.fn(),
    });

    expect(issueGithub.createGithubIssue).not.toHaveBeenCalled();
    expect(issueGithub.updateGithubIssue).not.toHaveBeenCalled();
    // Kept, not dropped: the owning tab still has to push it.
    expect(result).toEqual({ pushed: 0, dropped: 0, remaining: 1 });
  });
});

// ---------------------------------------------------------------------------

describe('two tabs, one stored queue', () => {
  /** The blob as another tab would have left it. */
  const otherTabsQueue = (issueId: string) =>
    JSON.stringify({
      v: 1,
      entries: [
        {
          issueId,
          repo: 'acme/widgets',
          identity: '',
          queuedAt: Date.now(),
          attempts: 0,
          seq: 1,
          details: true,
        },
      ],
    });

  it('keeps an entry another tab queued when this tab writes its own', async () => {
    // Every tab used to read this blob once at start-up, so the next write from
    // any of them replaced the lot — dropping a push another tab was holding,
    // which is the exact loss the outbox exists to prevent.
    const { outbox } = await load();
    await outbox.loadGithubOutbox();
    settings.set('github_outbox', otherTabsQueue('from-other-tab'));

    await outbox.queueGithubPush('from-this-tab', 'acme/widgets', { details: true });

    const stored = JSON.parse(String(settings.get('github_outbox')));
    expect(stored.entries.map((e: { issueId: string }) => e.issueId).sort()).toEqual([
      'from-other-tab',
      'from-this-tab',
    ]);
  });

  it('replays an entry another tab queued after this tab had loaded', async () => {
    const { outbox, db, issueGithub } = await load();
    await outbox.loadGithubOutbox();
    settings.set('github_outbox', otherTabsQueue('from-other-tab'));
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'from-other-tab' }));
    vi.mocked(issueGithub.createGithubIssue).mockResolvedValue(7);

    const result = await outbox.flushGithubOutbox({
      resolve: vi.fn().mockReturnValue(makeCtx()),
      setGhNumber: vi.fn(),
    });

    expect(issueGithub.createGithubIssue).toHaveBeenCalled();
    expect(result.pushed).toBe(1);
  });
});
