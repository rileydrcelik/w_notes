import { describe, expect, it } from 'vitest';

import { canMoveFolder, folderSubtreeIds, invalidMoveTargets } from '@/lib/folder-tree';

/** a > b > c, with d a sibling of a at the root. */
const tree = [
  { id: 'a', parentId: null },
  { id: 'b', parentId: 'a' },
  { id: 'c', parentId: 'b' },
  { id: 'd', parentId: null },
];

describe('folderSubtreeIds', () => {
  it('includes the folder itself', () => {
    expect(folderSubtreeIds(tree, 'c')).toEqual(new Set(['c']));
  });

  it('reaches every depth, not just direct children', () => {
    expect(folderSubtreeIds(tree, 'a')).toEqual(new Set(['a', 'b', 'c']));
  });

  it('does not wander into siblings', () => {
    expect(folderSubtreeIds(tree, 'd')).toEqual(new Set(['d']));
  });

  it('does not depend on the order folders arrive in', () => {
    // The store holds folders newest-first, so a child routinely precedes its
    // parent. A single pass down the list would stop at the first such pair.
    const reversed = [...tree].reverse();
    expect(folderSubtreeIds(reversed, 'a')).toEqual(new Set(['a', 'b', 'c']));
  });

  it('terminates on a cycle instead of hanging', () => {
    // Shouldn't exist, but a bad sync or a hand-edited row could produce one,
    // and a hung render is worse than a wrong answer.
    const cyclic = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ];
    expect(folderSubtreeIds(cyclic, 'x')).toEqual(new Set(['x', 'y']));
  });

  it('handles a folder that is not in the list', () => {
    expect(folderSubtreeIds(tree, 'missing')).toEqual(new Set(['missing']));
  });
});

describe('invalidMoveTargets', () => {
  it('blocks the moving folder and everything under it', () => {
    expect(invalidMoveTargets(tree, ['a'])).toEqual(new Set(['a', 'b', 'c']));
  });

  it('blocks the union when several folders move at once', () => {
    expect(invalidMoveTargets(tree, ['b', 'd'])).toEqual(new Set(['b', 'c', 'd']));
  });

  it('blocks nothing when only notes are moving', () => {
    expect(invalidMoveTargets(tree, [])).toEqual(new Set());
  });
});

describe('canMoveFolder', () => {
  it('allows a move to Home', () => {
    expect(canMoveFolder(tree, 'b', null)).toBe(true);
  });

  it('allows a move to an unrelated folder', () => {
    expect(canMoveFolder(tree, 'b', 'd')).toBe(true);
  });

  it('allows a move to its own parent (a no-op, not an error)', () => {
    expect(canMoveFolder(tree, 'b', 'a')).toBe(true);
  });

  it('refuses a move into itself', () => {
    expect(canMoveFolder(tree, 'a', 'a')).toBe(false);
  });

  it('refuses a move into its own child', () => {
    expect(canMoveFolder(tree, 'a', 'b')).toBe(false);
  });

  it('refuses a move into a deeper descendant', () => {
    // The one that a shallow "is this my direct child" check would let through,
    // detaching a>b>c from the root for good.
    expect(canMoveFolder(tree, 'a', 'c')).toBe(false);
  });
});
