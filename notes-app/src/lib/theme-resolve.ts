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
 * meant a device in dark mode had no way to ask for it at all — the two
 * Solarized variants could be chosen outright but their plain counterpart
 * couldn't.
 */
export type ThemeKey = 'system' | 'light' | 'dark' | 'solarized' | 'solarizedDark' | 'mocha';

/** The light/dark axis some chrome still branches on (blur tint, status bar). */
export type Scheme = 'light' | 'dark';

export const THEME_KEYS: ThemeKey[] = [
  'system',
  'light',
  'dark',
  'solarized',
  'solarizedDark',
  'mocha',
];

export const isThemeKey = (value: string): value is ThemeKey =>
  (THEME_KEYS as string[]).includes(value);

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
  if (themeKey === 'solarizedDark') return { scheme: 'dark', colors: Colors.solarizedDark };
  if (themeKey === 'mocha') return { scheme: 'dark', colors: Colors.mocha };
  if (themeKey === 'dark') return { scheme: 'dark', colors: Colors.dark };
  if (themeKey === 'light') return { scheme: 'light', colors: Colors.light };
  return { scheme: device, colors: Colors[device] };
}
