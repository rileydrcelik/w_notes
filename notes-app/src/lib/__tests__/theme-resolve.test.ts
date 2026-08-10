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
  { key: 'midnight', scheme: 'dark', colors: Colors.midnight },
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

  it('keeps the dark themes distinct from one another', () => {
    // They both resolve to scheme 'dark', so scheme alone can't tell them apart —
    // the palette has to.
    const darks = (['dark', 'midnight'] as const).map(
      (key) => resolveTheme(key, 'light').colors.background,
    );
    expect(new Set(darks).size).toBe(2);
  });

  it('does not answer to a retired key', () => {
    // `resolveTheme` falls through to `system` on anything it doesn't recognise,
    // so a retired key left in the chain wouldn't error — it would go on quietly
    // rendering the theme that was supposed to be gone. Cast because the union
    // no longer admits these, which is the thing being checked.
    for (const retired of ['mocha', 'solarizedDark'] as unknown as ThemeKey[]) {
      expect(THEME_KEYS, retired).not.toContain(retired);
      expect(resolveTheme(retired, 'dark'), retired).toEqual({
        scheme: 'dark',
        colors: Colors.dark,
      });
    }
  });
});

describe('migrateThemeKey', () => {
  it('sends each retired theme to a theme that still exists', () => {
    // Both were darks. Landing them on 'system' instead — which is what an
    // unrecognised key does — would show a light screen to someone who had
    // deliberately asked for a dark one.
    expect(migrateThemeKey('mocha')).toBe('midnight');
    expect(migrateThemeKey('solarizedDark')).toBe('dark');
  });

  it('leaves every surviving key alone', () => {
    for (const key of THEME_KEYS) {
      expect(migrateThemeKey(key)).toBe(key);
    }
  });

  it('is idempotent, which is what lets it run on every hydrate', () => {
    // The store applies this to values arriving from sync, so it runs many times
    // against the same key. While Mocha was still choosable a second pass turned
    // a deliberate brown violet, and the rewrite had to be flag-guarded to once
    // per device. Nothing it produces is retired any more — if that stops being
    // true, this is where it shows.
    for (const key of ['mocha', 'solarizedDark', ...THEME_KEYS]) {
      const once = migrateThemeKey(key);
      expect(migrateThemeKey(once), key).toBe(once);
    }
  });

  it('produces only keys the resolver actually knows', () => {
    for (const key of ['mocha', 'solarizedDark', ...THEME_KEYS]) {
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
