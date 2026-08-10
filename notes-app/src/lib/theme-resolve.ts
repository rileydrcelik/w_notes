/**
 * Which palette a theme choice actually resolves to.
 *
 * Split out of `store/theme-store` so it can be tested: the store reaches for
 * SQLite the moment it's imported, which the unit runner has no way to load.
 * This half needs nothing but the palettes.
 */
import { Colors, type Palette } from '@/constants/theme';

/**
 * What the user picked in Settings. 'system' follows the device.
 *
 * 'light' and 'dark' pin the plain palettes regardless of what the device is
 * doing. Light was reachable only through 'system' for a while, which quietly
 * meant a device in dark mode had no way to ask for it at all — Solarized could
 * be chosen outright but its plain counterpart couldn't.
 *
 * Retired keys are deliberately absent rather than kept as hidden aliases: a key
 * the app can't offer shouldn't be a key it accepts. `migrateThemeKey` turns a
 * stored one into a surviving key before it ever reaches this union.
 */
export type ThemeKey = 'system' | 'light' | 'dark' | 'solarized' | 'midnight';

/** The light/dark axis some chrome still branches on (blur tint, status bar). */
export type Scheme = 'light' | 'dark';

export const THEME_KEYS: ThemeKey[] = ['system', 'light', 'dark', 'solarized', 'midnight'];

export const isThemeKey = (value: string): value is ThemeKey =>
  (THEME_KEYS as string[]).includes(value);

// The retired-key rewrite lives in `lib/theme-migrate`, which imports nothing so
// `lib/db` can run it at open time. Re-exported here because this is the module
// the rest of the app reads theme keys from.
export { migrateThemeKey, THEME_RENAME_FLAG } from '@/lib/theme-migrate';

/**
 * Resolve a chosen theme key (plus the device scheme) to a concrete look.
 *
 * Written as a chain of early returns with the device-following case as the
 * fallthrough, which has one specific failure mode worth knowing: a key added to
 * the union but not to the chain doesn't error, it lands in the `system` branch
 * and silently tracks the device.
 */
export function resolveTheme(
  themeKey: ThemeKey,
  device: Scheme,
): { scheme: Scheme; colors: Palette } {
  if (themeKey === 'solarized') return { scheme: 'light', colors: Colors.solarizedLight };
  if (themeKey === 'midnight') return { scheme: 'dark', colors: Colors.midnight };
  if (themeKey === 'dark') return { scheme: 'dark', colors: Colors.dark };
  if (themeKey === 'light') return { scheme: 'light', colors: Colors.light };
  return { scheme: device, colors: Colors[device] };
}
