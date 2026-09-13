/**
 * `selectDuplicateCandidates` — what a new issue is checked against for
 * duplicates before the title request goes out. See the module doc atop
 * `issue-duplicates.ts` for "EARLIER ONLY" and the no-embeddings rationale.
 *
 * Pure function, no mocking needed: `@/data/notes` only exports plain types and
 * `effectiveTypeIds`/`normalizeTypeIds`, neither of which touches anything native.
 */
import { describe, expect, it } from 'vitest';

import type { Issue } from '@/data/notes';
import {
  CANDIDATE_EXCERPT_CHARS,
  MAX_DUPLICATE_CANDIDATES,
  selectDuplicateCandidates,
} from '@/lib/issue-duplicates';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'i0',
    noteId: 't1',
    typeIds: ['t1'],
    title: '',
    description: '',
    done: false,
    attrs: {},
    position: 0,
    createdAt: 0,
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

describe('selectDuplicateCandidates', () => {
  it('excludes the issue itself', () => {
    const self = makeIssue({ id: 'self', typeIds: ['t1'], title: 'Export crashes' });

    const result = selectDuplicateCandidates({
      selfId: 'self',
      text: 'Export crashes',
      projectTypeIds: new Set(['t1']),
      issues: [self],
    });

    expect(result).toEqual([]);
  });

  it("excludes issues filed under another project's types", () => {
    const other = makeIssue({ id: 'other', noteId: 't2', typeIds: ['t2'], title: 'Export crashes' });

    const result = selectDuplicateCandidates({
      selfId: 'self',
      text: 'Export crashes',
      projectTypeIds: new Set(['t1']),
      issues: [other],
    });

    expect(result).toEqual([]);
  });

  it('includes a legacy issue with empty typeIds via its noteId', () => {
    const legacy = makeIssue({ id: 'legacy', noteId: 't1', typeIds: [], title: 'Export crashes' });

    const result = selectDuplicateCandidates({
      selfId: 'self',
      text: 'Export crashes',
      projectTypeIds: new Set(['t1']),
      issues: [legacy],
    });

    expect(result.map((c) => c.id)).toEqual(['legacy']);
  });

  it('excludes issues created at or after createdBefore', () => {
    const earlier = makeIssue({ id: 'earlier', createdAt: 5, title: 'match' });
    const same = makeIssue({ id: 'same', createdAt: 10, title: 'match' });
    const later = makeIssue({ id: 'later', createdAt: 15, title: 'match' });

    const result = selectDuplicateCandidates({
      selfId: 'self',
      createdBefore: 10,
      text: 'match',
      projectTypeIds: new Set(['t1']),
      issues: [earlier, same, later],
    });

    expect(result.map((c) => c.id)).toEqual(['earlier']);
  });

  it('ranks by shared word count, then open before done, then newest first', () => {
    const text = 'export crashes now';
    const zeroShared = makeIssue({ id: 'zero', title: 'totally unrelated stuff', createdAt: 1 });
    const twoShared = makeIssue({ id: 'two', title: 'export crashes always', createdAt: 1 });
    const oneSharedDone = makeIssue({
      id: 'one-done',
      title: 'export only',
      done: true,
      createdAt: 100,
    });
    const oneSharedOpenOld = makeIssue({
      id: 'one-open-old',
      title: 'export only',
      done: false,
      createdAt: 1,
    });
    const oneSharedOpenNew = makeIssue({
      id: 'one-open-new',
      title: 'export only',
      done: false,
      createdAt: 5,
    });

    const result = selectDuplicateCandidates({
      selfId: 'self',
      text,
      projectTypeIds: new Set(['t1']),
      issues: [zeroShared, twoShared, oneSharedDone, oneSharedOpenOld, oneSharedOpenNew],
    });

    expect(result.map((c) => c.id)).toEqual([
      'two',
      'one-open-new',
      'one-open-old',
      'one-done',
      'zero',
    ]);
  });

  it('caps the result at MAX_DUPLICATE_CANDIDATES', () => {
    const issues = Array.from({ length: MAX_DUPLICATE_CANDIDATES + 10 }, (_, i) =>
      makeIssue({ id: `i${i}`, title: 'export crashes', createdAt: i }),
    );

    const result = selectDuplicateCandidates({
      selfId: 'self',
      text: 'export crashes',
      projectTypeIds: new Set(['t1']),
      issues,
    });

    expect(result).toHaveLength(MAX_DUPLICATE_CANDIDATES);
  });

  it('truncates the description to CANDIDATE_EXCERPT_CHARS', () => {
    const long = 'x'.repeat(CANDIDATE_EXCERPT_CHARS + 50);
    const issue = makeIssue({ id: 'long', title: 'export', description: long });

    const result = selectDuplicateCandidates({
      selfId: 'self',
      text: 'export',
      projectTypeIds: new Set(['t1']),
      issues: [issue],
    });

    expect(result[0].description).toHaveLength(CANDIDATE_EXCERPT_CHARS);
    expect(result[0].description).toBe(long.slice(0, CANDIDATE_EXCERPT_CHARS));
  });
});
