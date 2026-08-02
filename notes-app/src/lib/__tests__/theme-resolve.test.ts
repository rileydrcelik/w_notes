/**
 * `resolveTheme` is the map from the choice in Settings to the palette on
 * screen, and it is written as a chain of early returns with the device-following
 * case as the fallthrough. That shape has one specific failure: a key added to
 * the union but not to the chain doesn't error, it silently lands in the
 * `system` branch and tracks the device — exactly the bug that left "Light"
 * unreachable from a device in dark mode.
 *
 * So every key is asserted against *both* device schemes. The pinned ones must
 * ignore the device entirely; only `system` may listen to it.
 */
import { describe, expect, it } from 'vitest';

import { Colors } from '@/constants/theme';
import { migrateThemeKey, resolveTheme, THEME_KEYS, type ThemeKey } from '@/lib/theme-resolve';

const PINNED: { key: ThemeKey; scheme: 'light' | 'dark'; colors: (typeof Colors)[keyof typeof Colors] }[] = [
  { key: 'light', scheme: 'light', colors: Colors.light },
  { key: 'dark', scheme: 'dark', colors: Colors.dark },
  { key: 'solarized', scheme: 'light', colors: Colors.solarizedLight },
  { key: 'solarizedDark', scheme: 'dark', colors: Colors.solarizedDark },
  { key: 'midnight', scheme: 'dark', colors: Colors.midnight },
  { key: 'mocha', scheme: 'dark', colors: Colors.mocha },
];

describe('resolveTheme', () => {
  it.each(PINNED)('$key resolves to its own palette on a light device', ({ key, scheme, colors }) => {
    expect(resolveTheme(key, 'light')).toEqual({ scheme, colors });
  });

  it.each(PINNED)('$key ignores a dark device and stays itself', ({ key, scheme, colors }) => {
    expect(resolveTheme(key, 'dark')).toEqual({ scheme, colors });
  });

  it('system follows a light device', () => {
    expect(resolveTheme('system', 'light')).toEqual({ scheme: 'light', colors: Colors.light });
  });

  it('system follows a dark device', () => {
    expect(resolveTheme('system', 'dark')).toEqual({ scheme: 'dark', colors: Colors.dark });
  });

  it('gives Light and System-on-a-dark-device different answers', () => {
    // The whole point of adding the key: before it existed these were the same
    // call, and there was no way to ask for the plain light palette from a
    // device in dark mode.
    expect(resolveTheme('light', 'dark')).not.toEqual(resolveTheme('system', 'dark'));
  });

  it('keeps Light distinct from Solarized Light', () => {
    expect(resolveTheme('light', 'light').colors).not.toEqual(
      resolveTheme('solarized', 'light').colors,
    );
  });

  it('keeps the four dark themes distinct from one another', () => {
    // They all resolve to scheme 'dark', so scheme alone can't tell them apart —
    // the palette has to. Midnight and Mocha are the pair most at risk here:
    // Mocha is the name Midnight used to carry, so a half-finished rename would
    // leave both keys pointing at the same violet palette.
    const darks = (['dark', 'solarizedDark', 'midnight', 'mocha'] as const).map(
      (key) => resolveTheme(key, 'light').colors.background,
    );
    expect(new Set(darks).size).toBe(4);
  });

  it('reads Mocha as the brown palette, not the violet one it used to name', () => {
    expect(resolveTheme('mocha', 'light').colors).toEqual(Colors.mocha);
    expect(resolveTheme('midnight', 'light').colors).toEqual(Colors.midnight);
    // The brown is genuinely warm: red channel above blue on both base and text.
    const { background, text } = resolveTheme('mocha', 'light').colors;
    for (const hex of [background, text]) {
      const [r, , b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      expect(r).toBeGreaterThan(b);
    }
  });
});

describe('migrateThemeKey', () => {
  it('rewrites a pre-rename Mocha to Midnight', () => {
    // Without this, every device saved on Catppuccin turns brown on next launch.
    expect(migrateThemeKey('mocha')).toBe('midnight');
  });

  it('leaves every other key alone', () => {
    for (const key of THEME_KEYS.filter((k) => k !== 'mocha')) {
      expect(migrateThemeKey(key)).toBe(key);
    }
  });

  it('produces only keys the resolver actually knows', () => {
    for (const key of THEME_KEYS) {
      const migrated = migrateThemeKey(key);
      expect(THEME_KEYS).toContain(migrated as ThemeKey);
    }
  });

  it('every key in the union resolves to a palette the app actually defines', () => {
    // Catches the other half of the fallthrough bug: a key wired to a palette
    // name that does not exist, or quietly reusing another theme's.
    const defined = new Set<string>(Object.values(Colors).map((palette) => palette.background));
    for (const key of THEME_KEYS) {
      expect(defined.has(resolveTheme(key, 'light').colors.background)).toBe(true);
    }
  });
});
