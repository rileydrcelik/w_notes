/**
 * Every scroll container in the app must hide its scrollbar.
 *
 * `global.css` takes the bar away on web in one rule, but native draws its
 * indicator per container: a `ScrollView` added without
 * `noScrollbar` (`lib/scroll-style.ts`) grows a bar on device that it never had
 * in a browser, and nothing in the type system, the linter or the e2e suite
 * says a word — the web build looks right, and only a real phone shows the
 * difference. That's the same shape of blind spot `platform-parity.test.ts`
 * exists for, so it gets the same kind of guard: read the source, list the
 * scroll containers, insist each one opted out.
 *
 * A list wired to the back-to-top button satisfies this through
 * `useScrollToTop`, whose `scrollProps` carries `noScrollbar` — so `{...
 * scrollProps}` counts. Nothing else does; `{...someOtherScroll.scrollProps}`
 * is deliberately not accepted, because `useScrolled` returns a bag of that
 * name and it carries no indicator props at all.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../..', import.meta.url));

/** Every `.tsx` under `src`, minus the tests themselves. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__') walk(p, out);
    } else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * A JSX open tag for a scroll container, anchored to the start of a line so a
 * generic argument (`useScrollToTop<FlatList<Item>>()`) and a doc comment
 * (` * <ScrollView {...scrollProps}>`) don't read as elements.
 */
const OPEN_TAG = /^[ \t]*<((?:Animated\.)?(?:ScrollView|FlatList|SectionList|VirtualizedList))(?=[\s>])/gm;

/**
 * The element's attribute text: everything up to the `>` that ends the open tag,
 * skipping any `>` inside a `{…}` prop value (`{(a) => b}` is full of them).
 */
function openTagText(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

const OPTED_OUT = /\{\.\.\.noScrollbar\}|\{\.\.\.scrollProps\}/;

const offenders: string[] = [];
let scanned = 0;

for (const file of walk(SRC)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(OPEN_TAG)) {
    const start = match.index + match[0].indexOf('<');
    scanned++;
    if (OPTED_OUT.test(openTagText(source, start))) continue;
    const line = source.slice(0, start).split('\n').length;
    offenders.push(`${relative(SRC, file).replace(/\\/g, '/')}:${line} <${match[1]}>`);
  }
}

describe('scroll containers hide their scrollbar', () => {
  it('finds the containers to check', () => {
    // Guards the scan itself: a regex that stopped matching would leave an
    // empty offender list, and the assertion below would pass over nothing.
    expect(scanned).toBeGreaterThanOrEqual(20);
  });

  it('every one spreads noScrollbar (or useScrollToTop scrollProps)', () => {
    expect(
      offenders,
      'these scroll containers will show a scrollbar on native — spread ' +
        '`noScrollbar` from `@/lib/scroll-style` onto each',
    ).toEqual([]);
  });
});
