/**
 * `reconcileProjectWithGithub` is the *pull* half of the task-manager's GitHub
 * two-way sync — see the module doc atop github-backsync.ts. These tests pin
 * its `done` reconciliation, which is what made the push/pull asymmetry bug
 * destructive: pull is gated on nothing (every ghNumber'd issue is matched and
 * reconciled, regardless of any per-type `githubConnected` flag), so any local
 * `done` change that failed to push — for whatever reason — gets silently
 * reverted on the very next back-sync. The push-side fix (in
 * `app/(home)/project/[id]/type/[typeId].tsx`) lives inside a screen component
 * with no pure/exported gating function, so it isn't reachable from this node-
 * environment vitest config (see the note atop vitest.config.ts: component
 * tests would need a renderer, which isn't set up here) — left to CI/manual QA.
 *
 * `@/lib/issue-github` is mocked wholesale (not `vi.importActual`) — its real
 * module imports `@/lib/sync/api` → `@/lib/sentry` → `@sentry/react-native`,
 * which pulls in real `react-native` internals that don't resolve under this
 * node-environment config (see `ai-key.test.ts` for the same pattern). The
 * fakes below reproduce just the two pure behaviours these tests rely on:
 * `githubDone` maps GitHub's `state` the same way the real one does, and
 * `githubToAttrs` is the identity function, which matches the real one
 * whenever `attributes` is `[]` (true for every fixture here).
 */
// Above `vi.mock` deliberately: vitest hoists the mock factory above every
// import at transform time, so these still resolve to the mock (see
// ai-key.test.ts for the same pattern).
import { describe, expect, it, vi } from 'vitest';

import type { Issue } from '@/data/notes';
import { reconcileProjectWithGithub, type BacksyncActions } from '@/lib/github-backsync';
import { listGithubIssues } from '@/lib/issue-github';

vi.mock('@/lib/issue-github', () => ({
  listGithubIssues: vi.fn(),
  githubDone: (state?: string | null) => state === 'closed',
  githubToAttrs: (
    _attributes: unknown,
    _body: unknown,
    _assignees: unknown,
    existing: Record<string, unknown>,
  ) => existing,
  githubIssueDescription: (body?: string | null) => body ?? undefined,
}));

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    noteId: 'type-a',
    typeIds: ['type-a'],
    title: 'Fix the bug',
    description: '',
    done: false,
    attrs: {},
    position: 0,
    createdAt: 0,
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

function makeActions() {
  return {
    createIssue: vi.fn(() => 'new-id'),
    updateIssue: vi.fn(),
    ensureUnorganizedType: vi.fn(() => 'unorganized'),
  } satisfies BacksyncActions as BacksyncActions & {
    createIssue: ReturnType<typeof vi.fn>;
    updateIssue: ReturnType<typeof vi.fn>;
    ensureUnorganizedType: ReturnType<typeof vi.fn>;
  };
}

describe('reconcileProjectWithGithub', () => {
  it('reverts a locally-completed issue back to open when GitHub never saw the close — pins the pull-side half of the push/pull asymmetry bug', async () => {
    // Exact shape of the regression: a mirrored issue was checked done locally,
    // but the close never reached GitHub (the bug: push was gated on the
    // *viewed type's* githubConnected, not the issue's own ghNumber). The next
    // pull sees GitHub's issue still open and, matching purely by ghNumber,
    // reverts the local done flag — the checkbox silently un-checks itself.
    // This is why the push-side fix must never skip a mirrored issue's push.
    vi.mocked(listGithubIssues).mockResolvedValue({
      issues: [{ number: 42, title: 'Fix the bug', state: 'open', body: null, labels: [], assignees: [] }],
      next_cursor: null,
    });
    const local = makeIssue({ id: 'i1', ghNumber: 42, done: true });
    const actions = makeActions();

    const result = await reconcileProjectWithGithub({
      repo: 'acme/widgets',
      attributes: [],
      issues: [local],
      actions,
    });

    expect(actions.updateIssue).toHaveBeenCalledWith('i1', { done: false });
    expect(result.updated).toBe(1);
    expect(result.imported).toBe(0);
  });

  it('leaves an issue untouched when its local done flag already matches GitHub (round trip, no needless patch)', async () => {
    vi.mocked(listGithubIssues).mockResolvedValue({
      issues: [{ number: 42, title: 'Fix the bug', state: 'closed', body: null, labels: [], assignees: [] }],
      next_cursor: null,
    });
    const local = makeIssue({ id: 'i1', ghNumber: 42, done: true });
    const actions = makeActions();

    const result = await reconcileProjectWithGithub({
      repo: 'acme/widgets',
      attributes: [],
      issues: [local],
      actions,
    });

    expect(actions.updateIssue).not.toHaveBeenCalled();
    expect(result.updated).toBe(0);
  });

  it('reopens a local issue when GitHub shows it closed (the symmetric direction of the done patch)', async () => {
    vi.mocked(listGithubIssues).mockResolvedValue({
      issues: [{ number: 7, title: 'Reopen me', state: 'closed', body: null, labels: [], assignees: [] }],
      next_cursor: null,
    });
    const local = makeIssue({ id: 'i2', ghNumber: 7, title: 'Reopen me', done: false });
    const actions = makeActions();

    const result = await reconcileProjectWithGithub({
      repo: 'acme/widgets',
      attributes: [],
      issues: [local],
      actions,
    });

    expect(actions.updateIssue).toHaveBeenCalledWith('i2', { done: true });
    expect(result.updated).toBe(1);
  });
});
