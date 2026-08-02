/**
 * The autofix chip used to vanish on reload: progress lived only in the Sentry
 * screen's React state while the GitHub workflow it described ran for minutes
 * afterwards. `autofix-progress.ts` is the round trip through the settings row
 * that fixes that, so what's asserted here is what a reload has to preserve —
 * and, just as importantly, what it has to *drop*: expired chips, a stale
 * "gave up" flag, and a corrupt blob that must not take the screen down.
 */
import { describe, expect, it } from 'vitest';

import {
  FIX_TTL_MS,
  fixStorageKey,
  isPollable,
  parseFixes,
  resumeDispatching,
  serializeFixes,
  type FixState,
} from '@/lib/autofix-progress';

const NOW = 1_800_000_000_000;

describe('serialize → parse round trip', () => {
  it('brings a tracked fix back with its PR intact', () => {
    const fixes: Record<string, FixState> = {
      'issue-1': {
        phase: 'tracking',
        shortId: 'PYTHON-FASTAPI-3',
        status: { state: 'pr_open', branch: 'autofixes/issue-python-fastapi-3', pr_number: 12 },
      },
    };
    const restored = parseFixes(serializeFixes(fixes, NOW), NOW + 1000);
    expect(restored).toEqual(fixes);
  });

  it('keeps a fix that is still within the TTL', () => {
    const raw = serializeFixes({ 'issue-1': { phase: 'tracking', shortId: 'A-1' } }, NOW);
    expect(Object.keys(parseFixes(raw, NOW + FIX_TTL_MS - 1))).toEqual(['issue-1']);
  });

  it('drops a fix older than the TTL', () => {
    const raw = serializeFixes({ 'issue-1': { phase: 'tracking', shortId: 'A-1' } }, NOW);
    expect(parseFixes(raw, NOW + FIX_TTL_MS + 1)).toEqual({});
  });

  it('restores a timed-out fix unstopped, so polling gets another window', () => {
    const raw = serializeFixes(
      { 'issue-1': { phase: 'tracking', shortId: 'A-1', stopped: true, status: { state: 'none', branch: 'b' } } },
      NOW,
    );
    const restored = parseFixes(raw, NOW);
    expect(restored['issue-1'].stopped).toBeUndefined();
    expect(isPollable(restored['issue-1'])).toBe(true);
  });
});

describe('parseFixes rejects bad input rather than throwing', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['not JSON', '{oh no'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON scalar', '42'],
  ])('returns {} for %s', (_label, raw) => {
    expect(parseFixes(raw as string | null | undefined, NOW)).toEqual({});
  });

  it('skips entries with no timestamp or an unknown phase', () => {
    const raw = JSON.stringify({
      'no-ts': { phase: 'tracking', shortId: 'A-1' },
      'bad-phase': { phase: 'wat', ts: NOW },
      good: { phase: 'error', message: 'Autofix failed to start', ts: NOW },
    });
    expect(Object.keys(parseFixes(raw, NOW))).toEqual(['good']);
  });
});

describe('isPollable', () => {
  it('polls a tracked fix that has no PR yet', () => {
    expect(isPollable({ phase: 'tracking', shortId: 'A-1', status: { state: 'none', branch: 'b' } })).toBe(true);
  });

  it('polls once the branch exists but the PR does not', () => {
    expect(
      isPollable({ phase: 'tracking', shortId: 'A-1', status: { state: 'branch_created', branch: 'b' } }),
    ).toBe(true);
  });

  it.each(['pr_open', 'pr_merged', 'pr_closed'] as const)('stops once the PR is %s', (state) => {
    expect(isPollable({ phase: 'tracking', shortId: 'A-1', status: { state, branch: 'b' } })).toBe(false);
  });

  it('does not poll a fix with no short id — there is nothing to ask about', () => {
    expect(isPollable({ phase: 'tracking', status: { state: 'none', branch: 'b' } })).toBe(false);
  });

  it.each([undefined, { phase: 'dispatching' } as FixState, { phase: 'error' } as FixState])(
    'does not poll %o',
    (fix) => {
      expect(isPollable(fix)).toBe(false);
    },
  );
});

describe('resumeDispatching', () => {
  const issues = [
    { id: 'issue-1', shortId: 'PYTHON-FASTAPI-3' },
    { id: 'issue-2', shortId: null },
  ];

  it('hands a stranded dispatch its short id so polling can take over', () => {
    const next = resumeDispatching({ 'issue-1': { phase: 'dispatching' } }, issues);
    expect(next['issue-1']).toEqual({ phase: 'tracking', shortId: 'PYTHON-FASTAPI-3' });
  });

  it('leaves a dispatch alone when the issue has no short id', () => {
    const fixes: Record<string, FixState> = { 'issue-2': { phase: 'dispatching' } };
    expect(resumeDispatching(fixes, issues)).toBe(fixes);
  });

  it('returns the same object when nothing is mid-dispatch, so no re-render', () => {
    const fixes: Record<string, FixState> = { 'issue-1': { phase: 'tracking', shortId: 'A-1' } };
    expect(resumeDispatching(fixes, issues)).toBe(fixes);
  });

  it('does not invent progress for an issue that was never fixed', () => {
    expect(resumeDispatching({}, issues)).toEqual({});
  });
});

describe('fixStorageKey', () => {
  it('scopes progress to one Sentry note', () => {
    expect(fixStorageKey('note-a')).toBe('sentryFix.note-a');
    expect(fixStorageKey('note-a')).not.toBe(fixStorageKey('note-b'));
  });
});
