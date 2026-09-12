/**
 * `github-issue-drafts.ts` holds issues composed on a GitHub plugin note that
 * never reached GitHub. See the module doc for why it carries a payload — and so
 * never drops one silently — where `github-outbox.ts` carries an intent it can
 * always rebuild.
 *
 * Mocking follows `github-outbox.test.ts` exactly; see its header for why every
 * dependency is mocked wholesale rather than partially (`db.ts` pulls in
 * `expo-sqlite`, `issue-github.ts` reaches `@sentry/react-native`, neither of
 * which resolves under this node-environment vitest config).
 *
 * The module holds MODULE-LEVEL state (`drafts`, `loading`, `snapshot`), so each
 * test re-imports it fresh through `load()`, which also re-arms the mocks —
 * `vi.resetModules()` does not re-run `vi.mock` factories, so the same `vi.fn()`
 * instances persist across tests and would otherwise leak call counts.
 */
import { describe, expect, it, vi } from 'vitest';

// Defaults live in the factory, not only in `load()`: `vi.fn(impl)` keeps that
// impl through `resetAllMocks`, so the module under test can never observe a
// bare mock returning undefined no matter when it first reaches one.
vi.mock('@/lib/db', () => ({
  db: {
    getSetting: vi.fn(async () => ''),
    setSetting: vi.fn(async () => undefined),
    deleteSetting: vi.fn(async () => undefined),
    listSettings: vi.fn(async () => []),
  },
}));

vi.mock('@/lib/web-db-lock', () => ({
  isDbLockedError: vi.fn(() => false),
}));

vi.mock('@/lib/sentry', () => ({
  Sentry: { captureException: vi.fn(), addBreadcrumb: vi.fn() },
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

// `isRetryable` is the real policy in github-outbox; stubbed here so a draft
// test states the branch it means rather than depending on status-code tables
// that github-outbox.test.ts already pins.
vi.mock('@/lib/github-outbox', () => ({
  isRetryable: vi.fn(() => false),
}));

vi.mock('@/lib/issue-github', () => ({
  createGithubIssue: vi.fn(async () => 1),
  findGithubIssueByMarker: vi.fn(async () => null),
  githubIssueBody: vi.fn(
    (desc: unknown, _a: unknown, _v: unknown, id?: string) => `${String(desc ?? '')}<!--${id}-->`,
  ),
  githubSyncErrorMessage: vi.fn((e: unknown) =>
    e instanceof Error ? e.message : 'Unknown error.',
  ),
}));

async function load() {
  vi.resetModules();
  // The module under test is imported FIRST, so it resolves its dependencies and
  // the handles taken below are the very instances it holds. Imported after it,
  // they can be a second set of factory mocks — armed here, unused there, and the
  // assertions then watch a mock nothing ever calls.
  const drafts = await import('@/lib/github-issue-drafts');
  const [{ db }, issueGithub, outbox, { ApiError }] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/issue-github'),
    import('@/lib/github-outbox'),
    import('@/lib/sync/api'),
  ]);

  vi.resetAllMocks();
  vi.mocked(db.getSetting).mockResolvedValue('');
  vi.mocked(db.setSetting).mockResolvedValue(undefined);
  vi.mocked(db.deleteSetting).mockResolvedValue(undefined);
  vi.mocked(db.listSettings).mockResolvedValue([]);
  vi.mocked(outbox.isRetryable).mockReturnValue(false);
  vi.mocked(issueGithub.createGithubIssue).mockResolvedValue(1);
  vi.mocked(issueGithub.findGithubIssueByMarker).mockResolvedValue(null);
  vi.mocked(issueGithub.githubIssueBody).mockImplementation(
    (desc: unknown, _a: unknown, _v: unknown, id?: string) => `${String(desc ?? '')}<!--${id}-->`,
  );
  vi.mocked(issueGithub.githubSyncErrorMessage).mockImplementation((e: unknown) =>
    e instanceof Error ? e.message : 'Unknown error.',
  );

  return { db, issueGithub, outbox, ApiError, drafts };
}

const input = (over: Partial<Record<string, unknown>> = {}) => ({
  repo: 'acme/widgets',
  title: 'Fix the folder seam',
  body: 'It reads as two shapes.',
  labels: [] as string[],
  assignees: [] as string[],
  milestone: null,
  ...over,
});

/** The JSON written for a given draft id, as the device would hold it. */
function storedRow(id: string, over: Record<string, unknown> = {}) {
  return {
    key: `github_draft:${id}`,
    value: JSON.stringify({
      id,
      repo: 'acme/widgets',
      title: 'Fix the folder seam',
      body: 'It reads as two shapes.',
      labels: [],
      assignees: [],
      milestone: null,
      identity: '',
      queuedAt: 1000,
      attempts: 0,
      ...over,
    }),
  };
}

// ---------------------------------------------------------------------------

describe('saveGithubDraft', () => {
  it('writes the draft under its own key, so one bad value costs one draft', async () => {
    const { db, drafts } = await load();
    await drafts.saveGithubDraft('d1', input());
    expect(db.setSetting).toHaveBeenCalledWith('github_draft:d1', expect.any(String));
  });

  it('keeps the text verbatim', async () => {
    const { db, drafts } = await load();
    await drafts.saveGithubDraft('d1', input());
    const written = JSON.parse(String(vi.mocked(db.setSetting).mock.calls[0][1]));
    expect(written).toMatchObject({
      title: 'Fix the folder seam',
      body: 'It reads as two shapes.',
      repo: 'acme/widgets',
    });
  });

  it('editing a pending draft updates it rather than adding a second', async () => {
    const { drafts } = await load();
    await drafts.saveGithubDraft('d1', input());
    await drafts.saveGithubDraft('d1', input({ title: 'Fixed the seam' }));
    expect(drafts.githubDrafts()).toHaveLength(1);
    expect(drafts.githubDrafts()[0].title).toBe('Fixed the seam');
  });

  it('stamps the identity it was composed under', async () => {
    const { db, drafts } = await load();
    vi.mocked(db.getSetting).mockResolvedValue('uid-1');
    await drafts.saveGithubDraft('d1', input());
    expect(drafts.githubDrafts()[0].identity).toBe('uid-1');
  });
});

describe('loadGithubDrafts', () => {
  it('reads every stored draft', async () => {
    const { db, drafts } = await load();
    vi.mocked(db.listSettings).mockResolvedValue([storedRow('d1'), storedRow('d2')]);
    await drafts.loadGithubDrafts();
    expect(drafts.githubDrafts()).toHaveLength(2);
  });

  it('survives one unreadable draft and keeps the others — the whole reason for a row each', async () => {
    const { db, drafts } = await load();
    vi.mocked(db.listSettings).mockResolvedValue([
      { key: 'github_draft:bad', value: '{ not json' },
      storedRow('d2'),
    ]);
    await drafts.loadGithubDrafts();
    expect(drafts.githubDrafts().map((d) => d.id)).toEqual(['d2']);
  });

  it('does not expire a draft by age — text is not reconstructible', async () => {
    const { db, drafts } = await load();
    // Older than the intent queue's 7-day abandon window, which deliberately
    // does not apply here.
    vi.mocked(db.listSettings).mockResolvedValue([
      storedRow('old', { queuedAt: Date.now() - 40 * 24 * 60 * 60 * 1000 }),
    ]);
    await drafts.loadGithubDrafts();
    expect(drafts.githubDrafts()).toHaveLength(1);
  });
});

describe('pendingDraftForRepo', () => {
  it('finds the draft the compose sheet should resume', async () => {
    const { drafts } = await load();
    await drafts.saveGithubDraft('d1', input());
    expect(drafts.pendingDraftForRepo('acme/widgets')?.id).toBe('d1');
  });

  it('ignores another repoes draft, so a sheet never resumes the wrong one', async () => {
    const { drafts } = await load();
    await drafts.saveGithubDraft('d1', input({ repo: 'other/repo' }));
    expect(drafts.pendingDraftForRepo('acme/widgets')).toBeUndefined();
  });

  it('does not offer a held draft for editing', async () => {
    const { db, drafts } = await load();
    vi.mocked(db.listSettings).mockResolvedValue([storedRow('d1', { failure: 'Bad token.' })]);
    await drafts.loadGithubDrafts();
    expect(drafts.pendingDraftForRepo('acme/widgets')).toBeUndefined();
  });
});

describe('flushGithubDrafts', () => {
  it('sends a queued draft and removes it', async () => {
    const { db, issueGithub, drafts } = await load();
    await drafts.saveGithubDraft('d1', input());
    const result = await drafts.flushGithubDrafts();
    expect(issueGithub.createGithubIssue).toHaveBeenCalledOnce();
    expect(result.sent).toBe(1);
    expect(db.deleteSetting).toHaveBeenCalledWith('github_draft:d1');
  });

  it('marks the body so a lost response cannot file it twice', async () => {
    const { issueGithub, drafts } = await load();
    await drafts.saveGithubDraft('d1', input());
    await drafts.flushGithubDrafts();
    const sent = vi.mocked(issueGithub.createGithubIssue).mock.calls[0][1];
    expect(sent.body).toContain('<!--d1-->');
  });

  it('adopts an already-created issue on a retry instead of creating another', async () => {
    const { db, issueGithub, drafts } = await load();
    // attempts: 1 == a previous attempt whose outcome is unknown.
    vi.mocked(db.listSettings).mockResolvedValue([storedRow('d1', { attempts: 1 })]);
    vi.mocked(issueGithub.findGithubIssueByMarker).mockResolvedValue(42);
    await drafts.loadGithubDrafts();

    await drafts.flushGithubDrafts();

    expect(issueGithub.findGithubIssueByMarker).toHaveBeenCalledWith('acme/widgets', 'd1');
    expect(issueGithub.createGithubIssue).not.toHaveBeenCalled();
    expect(db.deleteSetting).toHaveBeenCalledWith('github_draft:d1');
  });

  it('counts the attempt before the request, so a crash mid-send still forces a search', async () => {
    const { db, issueGithub, drafts } = await load();
    await drafts.saveGithubDraft('d1', input());
    vi.mocked(issueGithub.createGithubIssue).mockRejectedValue(new Error('died'));
    vi.mocked(db.setSetting).mockClear();

    await drafts.flushGithubDrafts();

    const attempts = vi
      .mocked(db.setSetting)
      .mock.calls.map((c) => JSON.parse(String(c[1])).attempts as number);
    expect(Math.max(...attempts)).toBeGreaterThan(0);
  });

  it('keeps the text when GitHub refuses, rather than dropping it', async () => {
    const { issueGithub, drafts } = await load();
    await drafts.saveGithubDraft('d1', input());
    vi.mocked(issueGithub.createGithubIssue).mockRejectedValue(new Error('Bad token.'));

    const result = await drafts.flushGithubDrafts();

    expect(result.held).toBe(1);
    const kept = drafts.githubDrafts()[0];
    expect(kept.title).toBe('Fix the folder seam');
    expect(kept.failure).toBe('Bad token.');
  });

  it('stops at the first retryable failure instead of walking the rest', async () => {
    const { issueGithub, outbox, drafts } = await load();
    await drafts.saveGithubDraft('d1', input());
    await drafts.saveGithubDraft('d2', input({ title: 'Second' }));
    vi.mocked(outbox.isRetryable).mockReturnValue(true);
    vi.mocked(issueGithub.createGithubIssue).mockRejectedValue(new TypeError('offline'));

    await drafts.flushGithubDrafts();

    expect(issueGithub.createGithubIssue).toHaveBeenCalledOnce();
    expect(drafts.githubDrafts()).toHaveLength(2);
    expect(drafts.githubDrafts().every((d) => !d.failure)).toBe(true);
  });

  it('retries without the pickers on a 422 rather than losing the words to a stale label', async () => {
    const { issueGithub, ApiError, drafts } = await load();
    await drafts.saveGithubDraft('d1', input({ labels: ['gone'], assignees: ['ghost'] }));
    vi.mocked(issueGithub.createGithubIssue)
      .mockRejectedValueOnce(new ApiError('Validation Failed', 422))
      .mockResolvedValueOnce(7);

    const result = await drafts.flushGithubDrafts();

    expect(result.sent).toBe(1);
    const second = vi.mocked(issueGithub.createGithubIssue).mock.calls[1][1];
    expect(second.labels).toBeUndefined();
    expect(second.assignees).toBeUndefined();
    expect(second.title).toBe('Fix the folder seam');
  });

  it('holds a draft composed under another account instead of filing it as this one', async () => {
    const { db, drafts } = await load();
    vi.mocked(db.listSettings).mockResolvedValue([storedRow('d1', { identity: 'uid-old' })]);
    vi.mocked(db.getSetting).mockResolvedValue('uid-new');
    await drafts.loadGithubDrafts();

    const result = await drafts.flushGithubDrafts();

    expect(result.held).toBe(1);
    expect(drafts.githubDrafts()[0].title).toBe('Fix the folder seam');
  });
});

describe('account changes', () => {
  it('re-stamps drafts onto a claimed account, hydrating first', async () => {
    const { db, drafts } = await load();
    vi.mocked(db.listSettings).mockResolvedValue([storedRow('d1', { identity: '' })]);

    // No loadGithubDrafts() first — onSignIn reaches the claim off the auth
    // callback, which can beat the runner's load.
    await drafts.reassignGithubDrafts('uid-1');

    expect(drafts.githubDrafts()[0].identity).toBe('uid-1');
  });

  it('keeps the text when a different account signs in', async () => {
    const { db, drafts } = await load();
    vi.mocked(db.listSettings).mockResolvedValue([storedRow('d1')]);
    await drafts.loadGithubDrafts();

    await drafts.holdGithubDraftsForAccountChange();

    expect(db.deleteSetting).not.toHaveBeenCalled();
    expect(drafts.githubDrafts()[0].title).toBe('Fix the folder seam');
    expect(drafts.githubDrafts()[0].failure).toBeTruthy();
  });
});

describe('discardGithubDraft', () => {
  it('is the only thing that removes a draft for good', async () => {
    const { db, drafts } = await load();
    await drafts.saveGithubDraft('d1', input());
    await drafts.discardGithubDraft('d1');
    expect(db.deleteSetting).toHaveBeenCalledWith('github_draft:d1');
    expect(drafts.githubDrafts()).toHaveLength(0);
  });
});
