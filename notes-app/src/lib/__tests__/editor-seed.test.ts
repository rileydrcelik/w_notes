/**
 * The native note body must be seeded imperatively, never through `defaultValue`.
 *
 * `react-native-enriched` measures a `defaultValue` down a different path from
 * the one that measures typing, and that path parses the HTML *without* the
 * normalizer the view renders with. So precisely the markup the normalizer
 * exists to canonicalize — a list pasted from another app, `<ul
 * data-type="checkbox">`, `<li checked>` — measures as one line however many
 * items it holds. The editor then gets laid out at its `minHeight` while drawing
 * the whole document: a 35-item checklist showed six rows, with the remaining 29
 * scrolling inside that little box and no way to make it taller. Seeding through
 * `setValue` puts the content down the same path a keystroke takes, which
 * measures what is actually rendered.
 *
 * `defaultValue={initialValue}` is the obvious-looking shape and the one any
 * future tidy-up would reach for, it costs a device to notice, and there is no
 * render-test setup here — so this reads the source and insists, the way
 * `no-scrollbar.test.ts` and `navbar-slot.test.ts` do for their own invariants.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../../components/markdown-editor.tsx', import.meta.url)),
  'utf8',
);

describe('the native editor body', () => {
  it('is seeded through setValue', () => {
    expect(SOURCE).toMatch(/\.setValue\(initialValue\)/);
  });

  it('does not hand the body to defaultValue', () => {
    expect(SOURCE).not.toMatch(/defaultValue=\{initialValue\}/);
    expect(SOURCE).toMatch(/defaultValue=""/);
  });

  it('tells the seed echo from a keystroke by focus, not by timing', () => {
    // The note screen marks the note edited on every change event, so reporting
    // the seed would flag an untouched note as edited and re-commit its body.
    // The gate has to be focus: setValue is applied on a later native tick, so
    // the echo can arrive after the field is focused, and any rule counting
    // events would either report the seed as an edit or swallow a keystroke.
    expect(SOURCE).toMatch(/if \(!touched\.current\) return;/);
    expect(SOURCE).toMatch(/touched\.current = true;/);
  });

  it('does not gate the echo on a timer', () => {
    // A timer would be back to guessing at ordering — and one that fired late
    // would swallow a real edit, which is lost text.
    expect(SOURCE).not.toMatch(/setTimeout/);
  });
});
