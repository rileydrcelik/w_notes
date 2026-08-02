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
import { resolveTheme, THEME_KEYS, type ThemeKey } from '@/lib/theme-resolve';

const PINNED: { key: ThemeKey; scheme: 'light' | 'dark'; colors: (typeof Colors)[keyof typeof Colors] }[] = [
  { key: 'light', scheme: 'light', colors: Colors.light },
  { key: 'dark', scheme: 'dark', colors: Colors.dark },
  { key: 'solarized', scheme: 'light', colors: Colors.solarizedLight },
  { key: 'solarizedDark', scheme: 'dark', colors: Colors.solarizedDark },
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

  it('keeps the three dark themes distinct from one another', () => {
    // Mocha resolves to scheme 'dark' like the other two, so scheme alone can't
    // tell them apart — the palette has to.
    const darks = (['dark', 'solarizedDark', 'mocha'] as const).map(
      (key) => resolveTheme(key, 'light').colors.background,
    );
    expect(new Set(darks).size).toBe(3);
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
