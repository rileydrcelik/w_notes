import { describe, expect, it } from 'vitest';

import {
  canMoveFolder,
  folderSubtreeIds,
  foldersToRehome,
  invalidMoveTargets,
} from '@/lib/folder-tree';

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

describe('foldersToRehome', () => {
  const dated = (id: string, parentId: string | null, updatedAt: number) => ({ id, parentId, updatedAt });

  it('leaves a healthy tree alone', () => {
    expect(
      foldersToRehome([dated('a', null, 1), dated('b', 'a', 2), dated('c', 'b', 3)]),
    ).toEqual([]);
  });

  it('breaks the two-folder cycle two devices can create', () => {
    // Device 1 put a inside b; device 2, not yet aware, put b inside a. Both
    // rows are valid on their own and last-writer-wins applies them both.
    const cyclic = [dated('a', 'b', 100), dated('b', 'a', 200)];
    // The older move loses, so the newer one (b into a) survives.
    expect(foldersToRehome(cyclic)).toEqual(['a']);
  });

  it('breaks a longer cycle at its oldest link', () => {
    expect(foldersToRehome([dated('a', 'c', 300), dated('b', 'a', 100), dated('c', 'b', 200)])).toEqual(['b']);
  });

  it('breaks a self-parented folder', () => {
    expect(foldersToRehome([dated('a', 'a', 5)])).toEqual(['a']);
  });

  it('picks the same loser whichever device repairs it', () => {
    // Both devices run this over the same rows, so the answer has to be a
    // function of the rows alone — including when the timestamps tie.
    const rows = [dated('b', 'a', 100), dated('a', 'b', 100)];
    expect(foldersToRehome(rows)).toEqual(foldersToRehome([...rows].reverse()));
  });

  it('spares folders that merely hang off a cycle', () => {
    // `d` is inside the cycle's subtree but is not itself part of the loop;
    // cutting one link inside the loop is enough to give it a path to Home.
    const rows = [dated('a', 'b', 100), dated('b', 'a', 200), dated('d', 'a', 300)];
    expect(foldersToRehome(rows)).toEqual(['a']);
  });

  it('handles several independent cycles at once', () => {
    const rows = [
      dated('a', 'b', 100),
      dated('b', 'a', 200),
      dated('x', 'y', 400),
      dated('y', 'x', 300),
    ];
    expect(foldersToRehome(rows).sort()).toEqual(['a', 'y']);
  });

  it('ignores a dangling parent rather than treating it as a loop', () => {
    expect(foldersToRehome([dated('a', 'gone', 1)])).toEqual([]);
  });
});
