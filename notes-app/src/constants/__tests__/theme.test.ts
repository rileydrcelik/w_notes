/**
 * Palette-shape invariants for `Colors`.
 *
 * `Palette` is `Record<ThemeColor, string>` with `ThemeColor` derived from
 * `keyof typeof Colors.light` — a type-level promise that every other palette
 * carries the exact same keys as `light`. TypeScript enforces that at the call
 * sites that pass a `Palette` around, but `Colors` itself is declared `as const`
 * with no explicit `Record<ThemeColor, Palette>` annotation, so nothing forces
 * a *sibling* palette's own object literal to match `light`'s shape — a typo'd
 * or missing key in `midnight` or `solarizedLight` would compile today and only
 * surface as an `undefined` token wherever that palette gets used on screen.
 *
 * `theme-resolve.test.ts` covers `resolveTheme`/`migrateThemeKey`; this file
 * covers `Colors` itself, one level down.
 */
import { describe, expect, it } from 'vitest';

import { Colors } from '@/constants/theme';

const PALETTE_NAMES = Object.keys(Colors) as (keyof typeof Colors)[];

describe('Colors palette shape', () => {
  it('gives every palette the exact same set of keys as light', () => {
    const expected = Object.keys(Colors.light).sort();
    for (const name of PALETTE_NAMES) {
      expect(Object.keys(Colors[name]).sort(), `Colors.${name}`).toEqual(expected);
    }
  });

  it('has at least the tokens the app actually reads (a full smoke set, not just a count)', () => {
    // A key-count match alone would pass two palettes that swapped one token's
    // name for another (e.g. `textSecondary` -> `secondaryText`) as long as both
    // still had six keys. Naming the tokens closes that gap.
    const required = [
      'text',
      'background',
      'backgroundElement',
      'backgroundElementAlt',
      'backgroundSelected',
      'textSecondary',
    ].sort();
    for (const name of PALETTE_NAMES) {
      expect(Object.keys(Colors[name]).sort(), `Colors.${name}`).toEqual(required);
    }
  });

  it('gives every token a non-empty #rrggbb value in every palette', () => {
    const hex6 = /^#[0-9a-fA-F]{6}$/;
    for (const name of PALETTE_NAMES) {
      for (const [token, value] of Object.entries(Colors[name])) {
        expect(value, `Colors.${name}.${token}`).toMatch(hex6);
      }
    }
  });

  it('keeps every palette genuinely distinct, not an alias of another', () => {
    // A palette added by copy-pasting a neighbour's literal and forgetting to
    // change the hexes is a wrong-looking screen and nothing else — no error,
    // no type failure. This is the one place it shows up as a content match.
    // It replaces a narrower check on `mocha` vs `midnight`, which were the pair
    // most at risk while one was the other's former name.
    for (const a of PALETTE_NAMES) {
      for (const b of PALETTE_NAMES) {
        if (a === b) continue;
        expect(Colors[a], `Colors.${a} vs Colors.${b}`).not.toEqual(Colors[b]);
      }
    }
  });

  it('keeps no palette behind a retired theme name', () => {
    // Deleting a theme means deleting its palette too. Left in `Colors` it is
    // dead weight that still passes every shape check above, and reads to the
    // next person as a theme that exists but has lost its way into Settings.
    for (const retired of ['mocha', 'solarizedDark']) {
      expect(PALETTE_NAMES, `Colors.${retired}`).not.toContain(retired);
    }
  });
});
