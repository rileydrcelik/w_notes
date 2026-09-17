/**
 * `issue-retitle.ts` swaps a new issue's stand-in title for the model's real
 * one, immediately if the server answers and via `flushIssueRetitles` on a
 * later sync otherwise. See the module doc atop `issue-retitle.ts` for the
 * invariants pinned here — "THE STAND-IN IS THE LOCK" and "GIVING UP KEEPS THE
 * STAND-IN" are the two load-bearing ones.
 *
 * Mocking notes (same tactic as `github-outbox.test.ts`, whose header comment
 * explains the "why" in full):
 *
 * - `@/lib/db` is mocked because it imports `expo-sqlite`, a native module.
 * - `@/lib/sentry`, `@/lib/web-db-lock` and `@/lib/auth/token` are mocked so
 *   nothing transitively drags in React Native internals.
 * - `@/lib/sync/api` is mocked with a small stand-in `ApiError` class — the
 *   one thing `isRetryableTitleError` needs `instanceof`.
 * - `@/lib/issue-title` is mocked wholesale so `requestIssueTitle` is a bare
 *   `vi.fn()` this file drives directly, with no real network code involved.
 *
 * `issue-retitle.ts` holds MODULE-LEVEL state (`entries`, `inFlight`,
 * `idSnapshot`, the `chain`) that would otherwise bleed between tests. Every
 * test calls `vi.resetModules()` and re-imports fresh via `load()`, which also
 * calls `vi.resetAllMocks()` and re-arms every default — `resetModules()`
 * clears the real module registry, not the `vi.mock` factories, so the mocked
 * functions are the same `vi.fn()` instances across the whole file.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Issue } from '@/data/notes';

/**
 * The settings table the queue lives in. A Map rather than bare `vi.fn()`s
 * because each operation re-reads the stored blob before rewriting it (another
 * tab may have queued something), so a write that went nowhere would leave the
 * next operation reading an empty queue and dropping what came before it.
 * Wired up in `load()`; the factory below is hoisted above this declaration.
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
  // This realm owns the database, so the single-runner gates let work through.
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
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

vi.mock('@/lib/sentry', () => ({
  Sentry: {
    captureException: vi.fn(),
    addBreadcrumb: vi.fn(),
  },
}));

vi.mock('@/lib/issue-title', () => ({
  requestIssueTitle: vi.fn(),
}));

type IssueRow = Issue & { deletedAt: number | null };
type TitleResult = { title: string; duplicateOf: string | null };

function makeRow(overrides: Partial<IssueRow> = {}): IssueRow {
  return {
    id: 'i1',
    noteId: 't1',
    typeIds: ['t1'],
    title: 'Stub title',
    description: 'full text',
    done: false,
    attrs: {},
    position: 0,
    createdAt: 0,
    updatedAt: '2026-01-01',
    deletedAt: null,
    ...overrides,
  };
}

/** Drain enough microtask ticks for a chain of already-resolved promises
 * (mocked `db` calls, `serialize`'s `.then` hops) to run to completion, without
 * resolving anything that is genuinely still pending (e.g. a manually-held
 * `requestIssueTitle` promise). No timers are involved anywhere in the module
 * under test, so this is deterministic rather than a sleep. */
// 80 rather than 30: every queue operation now re-reads the stored queue before
// changing it (another tab may have written it), so there are more awaits
// between calling in and the request going out.
async function drainMicrotasks(times = 80): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function load() {
  vi.resetModules();
  // Imported sequentially, `@/lib/db` (etc.) fully before `@/lib/issue-retitle`
  // itself: `issue-retitle.ts` statically imports these same specifiers, and a
  // concurrent first resolution (Promise.all) has been observed to race with
  // vitest's mock module cache, handing the product module and this file two
  // different mock instances of `db`. Sequential awaits avoid the race.
  const { db } = await import('@/lib/db');
  const issueTitle = await import('@/lib/issue-title');
  const { Sentry } = await import('@/lib/sentry');
  const retitle = await import('@/lib/issue-retitle');

  vi.resetAllMocks();
  settings.clear();
  vi.mocked(db.getSetting).mockImplementation(async (key: string) => settings.get(key) ?? null);
  vi.mocked(db.setSetting).mockImplementation(async (key: string, value: string) => {
    settings.set(key, value);
  });
  vi.mocked(db.getIssueById).mockResolvedValue(null);

  return { db, issueTitle, Sentry, retitle };
}

// ---------------------------------------------------------------------------

describe('retitleIssue — immediate path', () => {
  it('applies the model title right away and reports titled', async () => {
    const { retitle, issueTitle } = await load();
    vi.mocked(issueTitle.requestIssueTitle).mockResolvedValue({ title: 'Model title', duplicateOf: null });
    const applyTitle = vi.fn().mockResolvedValue(true);

    const result = await retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle },
    );

    expect(result).toEqual({ status: 'titled', title: 'Model title' });
    expect(applyTitle).toHaveBeenCalledWith('i1', 'Stub title', 'Model title');
    expect(issueTitle.requestIssueTitle).toHaveBeenCalledWith('full text', []);
    expect(retitle.pendingRetitleIssueIds().has('i1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('a transport failure queues the entry for a later flush', () => {
  it('returns queued, applies nothing yet, and a later flush finishes the job', async () => {
    const { retitle, db, issueTitle } = await load();
    vi.mocked(issueTitle.requestIssueTitle).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const applyTitle = vi.fn().mockResolvedValue(true);

    const immediate = await retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle },
    );

    expect(immediate).toEqual({ status: 'queued' });
    expect(applyTitle).not.toHaveBeenCalled();
    expect(retitle.pendingRetitleIssueIds().has('i1')).toBe(true);

    // The next sync gets through.
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1' }));
    vi.mocked(issueTitle.requestIssueTitle).mockResolvedValueOnce({ title: 'Model title', duplicateOf: null });

    const flushResult = await retitle.flushIssueRetitles({ applyTitle });

    expect(flushResult).toEqual({ titled: 1, dropped: 0, remaining: 0 });
    expect(applyTitle).toHaveBeenCalledWith('i1', 'Stub title', 'Model title');
    expect(retitle.pendingRetitleIssueIds().has('i1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('answers that will never change are kept, not retried', () => {
  it.each([402, 422])(
    'drops the entry and never applies a title on ApiError %d',
    async (statusCode) => {
      const { retitle, issueTitle } = await load();
      const ApiError = (await import('@/lib/sync/api')).ApiError;
      vi.mocked(issueTitle.requestIssueTitle).mockRejectedValue(
        new ApiError('will not change', statusCode),
      );
      const applyTitle = vi.fn();

      const result = await retitle.retitleIssue(
        { issueId: 'i1', stub: 'Stub title', text: 'full text' },
        { applyTitle },
      );

      expect(result).toEqual({ status: 'kept' });
      expect(applyTitle).not.toHaveBeenCalled();
      expect(retitle.pendingRetitleIssueIds().has('i1')).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------

describe('a hand rename always wins', () => {
  it('drops the entry without asking again when the row was renamed before the retry ran', async () => {
    const { retitle, db, issueTitle } = await load();
    vi.mocked(issueTitle.requestIssueTitle).mockRejectedValueOnce(new TypeError('offline'));
    const applyTitle = vi.fn();

    await retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle },
    );
    expect(retitle.pendingRetitleIssueIds().has('i1')).toBe(true);

    // The person renamed it by hand while the queue was waiting to retry.
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1', title: 'Renamed by hand' }));

    const flushResult = await retitle.flushIssueRetitles({ applyTitle });

    expect(issueTitle.requestIssueTitle).toHaveBeenCalledTimes(1); // never asked again
    expect(applyTitle).not.toHaveBeenCalled();
    expect(flushResult).toEqual({ titled: 0, dropped: 1, remaining: 0 });
    expect(retitle.pendingRetitleIssueIds().has('i1')).toBe(false);
  });

  it('keeps the rename and drops the entry when the conditional write finds the stand-in gone', async () => {
    const { retitle, issueTitle } = await load();
    vi.mocked(issueTitle.requestIssueTitle).mockResolvedValue({ title: 'Model title', duplicateOf: null });
    // The rename committed while the model was writing, so the store's
    // stand-in-guarded write matches nothing.
    const applyTitle = vi.fn().mockResolvedValue(false);
    const onRetitled = vi.fn();

    const result = await retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle, onRetitled },
    );

    expect(result).toEqual({ status: 'kept' });
    expect(onRetitled).not.toHaveBeenCalled();
    expect(retitle.pendingRetitleIssueIds().has('i1')).toBe(false);
  });

  it('applies nothing when the issue is opened for editing while the request is out', async () => {
    const { retitle, issueTitle } = await load();
    let resolveTitle: (result: TitleResult) => void = () => {};
    vi.mocked(issueTitle.requestIssueTitle).mockReturnValue(
      new Promise<TitleResult>((resolve) => {
        resolveTitle = resolve;
      }),
    );
    const applyTitle = vi.fn().mockResolvedValue(true);

    const immediate = retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle },
    );
    await drainMicrotasks();
    expect(issueTitle.requestIssueTitle).toHaveBeenCalledTimes(1);

    await retitle.cancelIssueRetitle('i1');
    resolveTitle({ title: 'Model title', duplicateOf: null });

    expect(await immediate).toEqual({ status: 'kept' });
    expect(applyTitle).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('isRetitlePending — what the GitHub outbox holds a create on', () => {
  it('is true from the moment retitleIssue is called, before the entry has persisted', async () => {
    const { retitle, issueTitle } = await load();
    vi.mocked(issueTitle.requestIssueTitle).mockResolvedValue({ title: 'Model title', duplicateOf: null });

    const immediate = retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle: vi.fn().mockResolvedValue(true) },
    );
    // Synchronously — no await has happened yet, so the queue can't hold it.
    expect(retitle.pendingRetitleIssueIds().has('i1')).toBe(false);
    expect(retitle.isRetitlePending('i1')).toBe(true);

    await immediate;
    expect(retitle.isRetitlePending('i1')).toBe(false);
  });

  it('stays true while a retryable failure leaves the entry queued', async () => {
    const { retitle, issueTitle } = await load();
    const ApiError = (await import('@/lib/sync/api')).ApiError;
    // 404: the app shipped ahead of the backend route. Worth waiting out.
    vi.mocked(issueTitle.requestIssueTitle).mockRejectedValue(new ApiError('not found', 404));

    const result = await retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle: vi.fn().mockResolvedValue(true) },
    );

    expect(result).toEqual({ status: 'queued' });
    expect(retitle.isRetitlePending('i1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('the queue is per-identity', () => {
  it('skips an entry queued under a different account without asking for a title, and keeps it', async () => {
    const { retitle, db, issueTitle } = await load();
    settings.set('synced_uid', 'user-A');
    vi.mocked(issueTitle.requestIssueTitle).mockRejectedValueOnce(new TypeError('offline'));

    await retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle: vi.fn() },
    );
    expect(retitle.pendingRetitleIssueIds().has('i1')).toBe(true);

    settings.set('synced_uid', 'user-B'); // a different account signed in before the flush ran
    // A resolvable row (title still matching the stub) and a title the model
    // would happily hand back — proof that the skip below is really the
    // identity guard, and not a coincidental hold or drop.
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1', title: 'Stub title' }));
    vi.mocked(issueTitle.requestIssueTitle).mockResolvedValue({ title: 'Should never be used', duplicateOf: null });
    const applyTitle = vi.fn().mockResolvedValue(true);
    const flushResult = await retitle.flushIssueRetitles({ applyTitle });

    // Kept, not dropped: a mismatch here is the sign-in claim racing the flush,
    // and the claim is about to re-stamp it as this account's.
    expect(flushResult).toEqual({ titled: 0, dropped: 0, remaining: 1 });
    expect(issueTitle.requestIssueTitle).toHaveBeenCalledTimes(1); // never asked again
    expect(applyTitle).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('concurrency: the immediate attempt and a flush racing the same issue', () => {
  it('never asks the model twice for one issue, even when a flush starts while the immediate attempt is still outstanding', async () => {
    const { retitle, db, issueTitle } = await load();
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1' }));
    let resolveTitle: (result: TitleResult) => void = () => {};
    const pending = new Promise<TitleResult>((resolve) => {
      resolveTitle = resolve;
    });
    vi.mocked(issueTitle.requestIssueTitle).mockReturnValue(pending);
    const applyTitle = vi.fn().mockResolvedValue(true);

    // The New issue screen's immediate attempt. It will sit awaiting
    // `requestIssueTitle` until `resolveTitle` is called below.
    const immediate = retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle },
    );

    // Let it run up to (and mark itself in flight for) the still-unresolved
    // model call — the same interleaving a sync pass kicked off by the very
    // same save would race against.
    await drainMicrotasks();

    const flush = retitle.flushIssueRetitles({ applyTitle });
    const flushResult = await flush;

    // The flush found the issue already in flight and moved on without
    // asking again — the entry is still there because only the immediate
    // attempt (still pending) may resolve it.
    expect(flushResult).toEqual({ titled: 0, dropped: 0, remaining: 1 });
    expect(issueTitle.requestIssueTitle).toHaveBeenCalledTimes(1);

    resolveTitle({ title: 'Model title', duplicateOf: null });
    const immediateResult = await immediate;

    expect(immediateResult).toEqual({ status: 'titled', title: 'Model title' });
    expect(applyTitle).toHaveBeenCalledTimes(1);
    expect(issueTitle.requestIssueTitle).toHaveBeenCalledTimes(1); // still just the one call
    expect(retitle.pendingRetitleIssueIds().has('i1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('duplicate verdicts — "DUPLICATES RIDE ALONG"', () => {
  it('applies the duplicate before the title when the verdict names an offered candidate', async () => {
    const { retitle, issueTitle } = await load();
    const candidateList = [{ id: 'cand1', title: 'Earlier issue', description: '', done: false }];
    vi.mocked(issueTitle.requestIssueTitle).mockResolvedValue({
      title: 'Model title',
      duplicateOf: 'cand1',
    });
    const order: string[] = [];
    const applyDuplicate = vi.fn().mockImplementation(async () => {
      order.push('applyDuplicate');
      return true;
    });
    const applyTitle = vi.fn().mockImplementation(async () => {
      order.push('applyTitle');
      return true;
    });
    const candidates = vi.fn().mockReturnValue(candidateList);

    const result = await retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle, applyDuplicate, candidates },
    );

    expect(result).toEqual({ status: 'titled', title: 'Model title' });
    expect(applyDuplicate).toHaveBeenCalledWith('i1', 'cand1');
    expect(issueTitle.requestIssueTitle).toHaveBeenCalledWith('full text', candidateList);
    expect(order).toEqual(['applyDuplicate', 'applyTitle']);
  });

  it('does not apply a duplicate whose id was never among the offered candidates', async () => {
    const { retitle, issueTitle } = await load();
    vi.mocked(issueTitle.requestIssueTitle).mockResolvedValue({
      title: 'Model title',
      duplicateOf: 'not-offered',
    });
    const applyDuplicate = vi.fn().mockResolvedValue(true);
    const applyTitle = vi.fn().mockResolvedValue(true);
    const candidates = vi
      .fn()
      .mockReturnValue([{ id: 'cand1', title: '', description: '', done: false }]);

    const result = await retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle, applyDuplicate, candidates },
    );

    expect(result).toEqual({ status: 'titled', title: 'Model title' });
    expect(applyDuplicate).not.toHaveBeenCalled();
    expect(applyTitle).toHaveBeenCalledWith('i1', 'Stub title', 'Model title');
  });

  it('applies neither the duplicate nor the title when cancelled while the request is out', async () => {
    const { retitle, issueTitle } = await load();
    let resolveTitle: (result: TitleResult) => void = () => {};
    vi.mocked(issueTitle.requestIssueTitle).mockReturnValue(
      new Promise<TitleResult>((resolve) => {
        resolveTitle = resolve;
      }),
    );
    const applyDuplicate = vi.fn().mockResolvedValue(true);
    const applyTitle = vi.fn().mockResolvedValue(true);
    const candidates = vi
      .fn()
      .mockReturnValue([{ id: 'cand1', title: '', description: '', done: false }]);

    const immediate = retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle, applyDuplicate, candidates },
    );
    await drainMicrotasks();
    expect(issueTitle.requestIssueTitle).toHaveBeenCalledTimes(1);

    await retitle.cancelIssueRetitle('i1');
    resolveTitle({ title: 'Model title', duplicateOf: 'cand1' });

    expect(await immediate).toEqual({ status: 'kept' });
    expect(applyDuplicate).not.toHaveBeenCalled();
    expect(applyTitle).not.toHaveBeenCalled();
  });

  it('still applies the duplicate even when the title write loses to a hand rename', async () => {
    const { retitle, issueTitle } = await load();
    vi.mocked(issueTitle.requestIssueTitle).mockResolvedValue({
      title: 'Model title',
      duplicateOf: 'cand1',
    });
    const applyDuplicate = vi.fn().mockResolvedValue(true);
    // The rename committed while the model was writing, so the store's
    // stand-in-guarded title write matches nothing — outcome 'kept', per "a
    // hand rename always wins" above.
    const applyTitle = vi.fn().mockResolvedValue(false);
    const candidates = vi
      .fn()
      .mockReturnValue([{ id: 'cand1', title: '', description: '', done: false }]);

    const result = await retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle, applyDuplicate, candidates },
    );

    expect(result).toEqual({ status: 'kept' });
    expect(applyDuplicate).toHaveBeenCalledWith('i1', 'cand1');
  });

  it('requests with no candidates and still applies the title when deps.candidates throws', async () => {
    const { retitle, issueTitle } = await load();
    vi.mocked(issueTitle.requestIssueTitle).mockResolvedValue({
      title: 'Model title',
      duplicateOf: null,
    });
    const applyTitle = vi.fn().mockResolvedValue(true);
    const candidates = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle, candidates },
    );

    expect(result).toEqual({ status: 'titled', title: 'Model title' });
    expect(issueTitle.requestIssueTitle).toHaveBeenCalledWith('full text', []);
    expect(applyTitle).toHaveBeenCalledWith('i1', 'Stub title', 'Model title');
  });

  it('still applies the title when applyDuplicate throws', async () => {
    const { retitle, issueTitle } = await load();
    vi.mocked(issueTitle.requestIssueTitle).mockResolvedValue({
      title: 'Model title',
      duplicateOf: 'cand1',
    });
    const applyDuplicate = vi.fn().mockRejectedValue(new Error('boom'));
    const applyTitle = vi.fn().mockResolvedValue(true);
    const candidates = vi
      .fn()
      .mockReturnValue([{ id: 'cand1', title: '', description: '', done: false }]);

    const result = await retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle, applyDuplicate, candidates },
    );

    expect(result).toEqual({ status: 'titled', title: 'Model title' });
    expect(applyTitle).toHaveBeenCalledWith('i1', 'Stub title', 'Model title');
  });

  it('never gathers candidates or asks the model again when renamed before the flush runs', async () => {
    const { retitle, db, issueTitle } = await load();
    vi.mocked(issueTitle.requestIssueTitle).mockRejectedValueOnce(new TypeError('offline'));
    const applyTitle = vi.fn();

    await retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle },
    );
    expect(retitle.pendingRetitleIssueIds().has('i1')).toBe(true);

    // The person renamed it by hand while the queue was waiting to retry.
    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1', title: 'Renamed by hand' }));
    const candidates = vi.fn().mockReturnValue([]);

    const flushResult = await retitle.flushIssueRetitles({ applyTitle, candidates });

    expect(flushResult).toEqual({ titled: 0, dropped: 1, remaining: 0 });
    expect(candidates).not.toHaveBeenCalled();
    // Still just the one call from the immediate attempt above — the flush's
    // own attempt dropped the entry before reaching gatherCandidates or
    // requestIssueTitle at all.
    expect(issueTitle.requestIssueTitle).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------

describe('onRetitled ordering', () => {
  it('runs onRetitled before the entry leaves pendingRetitleIssueIds()', async () => {
    const { retitle, issueTitle } = await load();
    vi.mocked(issueTitle.requestIssueTitle).mockResolvedValue({ title: 'Model title', duplicateOf: null });
    let sawPendingDuringCallback: boolean | null = null;
    const onRetitled = vi.fn((issueId: string) => {
      sawPendingDuringCallback = retitle.pendingRetitleIssueIds().has(issueId);
    });

    await retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle: vi.fn().mockResolvedValue(true), onRetitled },
    );

    expect(onRetitled).toHaveBeenCalledWith('i1', 'Model title');
    expect(sawPendingDuringCallback).toBe(true);
    expect(retitle.pendingRetitleIssueIds().has('i1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('only the tab that owns the database flushes', () => {
  it('bills nobody and keeps the entry queued when another tab owns the database', async () => {
    // A retitle is a model call billed to the user's own key. Two tabs
    // replaying the queue would pay for every title twice and then race to
    // write the winner; `flushing` dedupes only within one realm.
    const { retitle, db, issueTitle } = await load();
    const { ownsBackgroundWork } = await import('@/lib/web-db-lock');
    const applyTitle = vi.fn().mockResolvedValue(true);

    vi.mocked(issueTitle.requestIssueTitle).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await retitle.retitleIssue(
      { issueId: 'i1', stub: 'Stub title', text: 'full text' },
      { applyTitle },
    );
    expect(retitle.pendingRetitleIssueIds().has('i1')).toBe(true);

    vi.mocked(db.getIssueById).mockResolvedValue(makeRow({ id: 'i1' }));
    vi.mocked(issueTitle.requestIssueTitle).mockResolvedValue({
      title: 'Model title',
      duplicateOf: null,
    });
    vi.mocked(ownsBackgroundWork).mockResolvedValue(false);

    const flushResult = await retitle.flushIssueRetitles({ applyTitle });

    expect(issueTitle.requestIssueTitle).not.toHaveBeenCalledTimes(2);
    expect(applyTitle).not.toHaveBeenCalled();
    // Kept, not dropped: the owning tab still has to title it.
    expect(flushResult).toEqual({ titled: 0, dropped: 0, remaining: 1 });
    expect(retitle.pendingRetitleIssueIds().has('i1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('two tabs, one stored queue', () => {
  /** The blob as another tab would have left it. */
  const otherTabsQueue = (issueId: string) =>
    JSON.stringify({
      v: 1,
      entries: [
        { issueId, stub: 'Stub title', identity: '', queuedAt: Date.now(), attempts: 0 },
      ],
    });

  it('keeps a title another tab queued when this tab writes its own', async () => {
    // One blob, every tab. Each used to read it once at start-up, so the next
    // write from any of them replaced the lot — and a title queued elsewhere
    // was gone, with the stand-in left on the issue for good.
    const { retitle, issueTitle } = await load();
    await retitle.loadIssueRetitles();
    settings.set('issue_retitle_queue', otherTabsQueue('from-other-tab'));
    vi.mocked(issueTitle.requestIssueTitle).mockRejectedValue(new TypeError('offline'));

    await retitle.retitleIssue(
      { issueId: 'from-this-tab', stub: 'Stub title', text: 'full text' },
      { applyTitle: vi.fn() },
    );

    const stored = JSON.parse(String(settings.get('issue_retitle_queue')));
    expect(stored.entries.map((e: { issueId: string }) => e.issueId).sort()).toEqual([
      'from-other-tab',
      'from-this-tab',
    ]);
  });
});
