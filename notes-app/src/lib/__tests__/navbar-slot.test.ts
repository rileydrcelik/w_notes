/**
 * Every trailing-slot button in the navbar must sit *over* the slot, not in it.
 *
 * The slot's content changes identity whenever a screen changes what the button
 * is for — the (+) becoming a project's "new issue" compose button, a selection's
 * "⋯", a GitHub view's composer. Reanimated keeps the outgoing child mounted
 * while the incoming one fades in, so for ~150ms the slot holds two 48px squares.
 * As flow children they stack into a column and the whole navbar lifts half a
 * button, then drops back: the "jump" reported going in and out of a task-manager
 * project. Out of flow (`styles.slotItem`) they share the box and it's a plain
 * cross-fade.
 *
 * Nothing in the type system or the linter says a word if the next mode added to
 * that chain forgets the style — it looks fine until you navigate — and there's no
 * render-test setup in this project to catch it. So this reads the source and
 * insists, the way `no-scrollbar.test.ts` does for its own one-line invariant.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../../components/floating-tab-bar.tsx', import.meta.url)),
  'utf8',
);

/** The trailing slot's branch chain, from its comment to the create menu after it. */
function trailingSlot(): string {
  const start = SOURCE.indexOf('{/* Trailing slot:');
  const end = SOURCE.indexOf('{/* Create picker:');
  expect(start, 'trailing slot comment not found — has the navbar been restructured?').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('the navbar trailing slot', () => {
  it('has every branch out of flow, so a swap cross-fades in place', () => {
    const region = trailingSlot();
    const keys = [...region.matchAll(/key="([^"]+)"/g)].map((m) => m[1]);
    // If this ever reads 0 the region parse broke and the rest is vacuous.
    expect(keys.length).toBeGreaterThan(3);

    const missing = keys.filter((key) => {
      const at = region.indexOf(`key="${key}"`);
      // The style sits in the same JSX open tag, which ends at the first '>'.
      const openTag = region.slice(at, region.indexOf('>', at));
      return !openTag.includes('styles.slotItem');
    });
    expect(missing, `trailing-slot branches missing styles.slotItem: ${missing.join(', ')}`).toEqual([]);
  });

  it('takes those branches out of flow by position, not by margin', () => {
    expect(SOURCE).toMatch(/slotItem:\s*\{\s*position:\s*'absolute'/);
  });

  it('gives the slot both dimensions, since its content no longer sizes it', () => {
    // Height as well as width: with every child absolute there is nothing in flow
    // to give the slot a height, and a collapsed slot drags the cluster with it.
    expect(SOURCE).toMatch(
      /const slotStyle = \{\s*width: TabBar\.height,\s*height: TabBar\.height,?\s*\}/,
    );
  });
});
