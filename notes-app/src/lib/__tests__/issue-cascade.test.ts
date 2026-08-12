/**
 * `planIssueCascade` decides which issues a deleted issue-type note takes down
 * with it, and `parseTypeIds` resolves a stored row's types. A bug here is
 * silent data loss in the other direction from `trash-visibility.ts`: instead
 * of a trashed thing wrongly hidden, it's a live issue wrongly tombstoned (or
 * a doomed one wrongly spared), which restoring the type never fixes.
 *
 * Pure logic, no expo-sqlite involved, so this runs directly against the
 * module — no stubbing needed (see the note atop trash-visibility.test.ts for
 * why db.ts itself can't be imported here).
 */
import { describe, expect, it } from 'vitest';

import { parseTypeIds, planIssueCascade, type IssueMembership } from '@/lib/issue-cascade';

describe('planIssueCascade', () => {
  it('spares an issue in [A, B] when only A is deleted, and queues B to check', () => {
    const issues: IssueMembership[] = [{ id: 'i1', types: ['A', 'B'] }];
    const { typesToCheck, doomed } = planIssueCascade(issues, ['A']);
    expect(typesToCheck).toEqual(['B']);
    // B turns out live: the issue is spared.
    expect(doomed(['B'])).toEqual([]);
  });

  it('dooms the same issue when its other type (B) is also already in the trash', () => {
    const issues: IssueMembership[] = [{ id: 'i1', types: ['A', 'B'] }];
    const { typesToCheck, doomed } = planIssueCascade(issues, ['A']);
    expect(typesToCheck).toEqual(['B']);
    // B is not among the live type ids the caller looked up (it's trashed too).
    expect(doomed([])).toEqual(['i1']);
  });

  it('dooms an issue when both of its types are deleted together, with nothing left to check', () => {
    const issues: IssueMembership[] = [{ id: 'i1', types: ['A', 'B'] }];
    const { typesToCheck, doomed } = planIssueCascade(issues, ['A', 'B']);
    expect(typesToCheck).toEqual([]);
    expect(doomed([])).toEqual(['i1']);
  });

  it('never touches an issue with no relation to the deleted types', () => {
    const issues: IssueMembership[] = [{ id: 'i1', types: ['C'] }];
    const { typesToCheck, doomed } = planIssueCascade(issues, ['A']);
    expect(typesToCheck).toEqual([]);
    expect(doomed(['C'])).toEqual([]);
  });

  it('dooms nothing when goingIds is empty', () => {
    const issues: IssueMembership[] = [
      { id: 'i1', types: ['A'] },
      { id: 'i2', types: ['B'] },
    ];
    const { typesToCheck, doomed } = planIssueCascade(issues, []);
    expect(typesToCheck).toEqual([]);
    expect(doomed([])).toEqual([]);
  });

  it('dedupes typesToCheck across multiple affected issues sharing a surviving type', () => {
    const issues: IssueMembership[] = [
      { id: 'i1', types: ['A', 'B'] },
      { id: 'i2', types: ['A', 'B'] },
    ];
    const { typesToCheck, doomed } = planIssueCascade(issues, ['A']);
    expect(typesToCheck).toEqual(['B']);
    expect(doomed(['B'])).toEqual([]);
    expect(doomed([])).toEqual(['i1', 'i2']);
  });
});

describe('parseTypeIds', () => {
  it('uses the type_ids array when it has entries, ignoring note_id', () => {
    expect(parseTypeIds('n1', '["A","B"]')).toEqual(['A', 'B']);
  });

  it('falls back to [noteId] for a pre-multi-type row with an empty type_ids array', () => {
    expect(parseTypeIds('n1', '[]')).toEqual(['n1']);
  });

  it('falls back to [noteId] when type_ids is null', () => {
    expect(parseTypeIds('n1', null)).toEqual(['n1']);
  });

  it('falls back to [noteId] on corrupt (non-JSON) type_ids without throwing', () => {
    expect(() => parseTypeIds('n1', 'not json')).not.toThrow();
    expect(parseTypeIds('n1', 'not json')).toEqual(['n1']);
  });

  it('falls back to [noteId] when type_ids parses to a non-array (null, object)', () => {
    expect(parseTypeIds('n1', 'null')).toEqual(['n1']);
    expect(parseTypeIds('n1', '{"a":1}')).toEqual(['n1']);
  });

  it('drops non-string members of a type_ids array rather than throwing, falling back if none remain', () => {
    expect(parseTypeIds('n1', '[1,2,3]')).toEqual(['n1']);
    expect(parseTypeIds('n1', '["A",1,null]')).toEqual(['A']);
  });
});
