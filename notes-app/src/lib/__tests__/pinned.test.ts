/**
 * Pinning is one line of sort, and every way it can go wrong is an ordering the
 * eye would have to catch: a pin that reshuffles the unstarred tail, a sort that
 * isn't stable so the feed's recency order quietly scrambles, or an input array
 * mutated in place while the store still holds a reference to it. Those are the
 * three things asserted here — not "starred items come first", which is the
 * easy half.
 */
import { describe, expect, it } from 'vitest';

import { pinnedFirst } from '@/lib/pinned';

const names = (items: { name: string }[]) => items.map((i) => i.name);

describe('pinnedFirst', () => {
  it('lifts starred items to the front', () => {
    const items = [
      { name: 'a' },
      { name: 'b', favorite: true },
      { name: 'c' },
      { name: 'd', favorite: true },
    ];
    expect(names(pinnedFirst(items))).toEqual(['b', 'd', 'a', 'c']);
  });

  it('keeps the incoming order inside each band — the feed is already sorted', () => {
    // Recency order in, recency order out: starred b before d, unstarred a
    // before c. A non-stable sort would be free to swap either pair.
    const items = [
      { name: 'a' },
      { name: 'b', favorite: true },
      { name: 'c' },
      { name: 'd', favorite: true },
      { name: 'e' },
    ];
    expect(names(pinnedFirst(items))).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('does not mutate the array it was given', () => {
    const items = [{ name: 'a' }, { name: 'b', favorite: true }];
    const before = names(items);
    pinnedFirst(items);
    expect(names(items)).toEqual(before);
  });

  it('returns a new array even when nothing is starred', () => {
    const items: { name: string; favorite?: boolean }[] = [{ name: 'a' }, { name: 'b' }];
    expect(pinnedFirst(items)).not.toBe(items);
    expect(names(pinnedFirst(items))).toEqual(['a', 'b']);
  });

  it('treats a missing favorite the same as false', () => {
    const items = [{ name: 'a', favorite: undefined }, { name: 'b' }, { name: 'c', favorite: false }];
    expect(names(pinnedFirst(items))).toEqual(['a', 'b', 'c']);
  });

  it('leaves an all-starred list in its original order', () => {
    const items = [{ name: 'a', favorite: true }, { name: 'b', favorite: true }];
    expect(names(pinnedFirst(items))).toEqual(['a', 'b']);
  });

  it('handles an empty list', () => {
    expect(pinnedFirst([])).toEqual([]);
  });

  it('pins across mixed kinds, so a starred note outranks an unstarred folder', () => {
    // The home/folder feeds concatenate folders then notes and sort the whole
    // thing, which is what makes a pin outrank the grouping.
    const items = [
      { name: 'folder-1', kind: 'folder' },
      { name: 'folder-2', kind: 'folder', favorite: true },
      { name: 'note-1', kind: 'note' },
      { name: 'note-2', kind: 'note', favorite: true },
    ];
    expect(names(pinnedFirst(items))).toEqual(['folder-2', 'note-2', 'folder-1', 'note-1']);
  });
});
