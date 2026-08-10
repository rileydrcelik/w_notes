/**
 * What a stored theme key means once the theme it names is gone, kept in a
 * module of its own.
 *
 * Deliberately imports nothing. `lib/theme-resolve`, `lib/db` and
 * `store/theme-store` all need this rule, and `lib/db` is loaded by unit tests
 * that must not drag in `constants/theme` — which imports `global.css` and
 * would fail outside a bundler. A pure string function has no such reach.
 */

/**
 * The row the chosen theme is stored under — now in the synced `user_settings`
 * table rather than the device-local `settings` one, so a theme follows the
 * account across devices.
 */
export const THEME_SETTING_KEY = 'themeKey';

/**
 * Settings row that records the one-time move of the theme preference out of the
 * device-local `settings` table and into the synced one. Named for the rename it
 * originally carried across; the string is what's on disk, so it stays.
 */
export const THEME_RENAME_FLAG = 'theme_rename_v1';

/** Retired theme keys, each mapped to the surviving theme it becomes. */
const RETIRED: Record<string, string> = {
  // `mocha` has named two different palettes: Catppuccin's violet, and then the
  // warm brown it was renamed *out of the way of*. Both are gone now — the
  // violet answers to `midnight`, and the brown was cut — so the one mapping
  // serves a device saved under either meaning.
  mocha: 'midnight',
  solarizedDark: 'dark',
};

/**
 * Rewrite a `themeKey` naming a theme the app no longer has.
 *
 * Both retired themes were darks, and both land on darks. The alternative is to
 * let the key fail its guard and fall through to `system`, which would hand a
 * device in light mode a white screen that someone had deliberately chosen
 * against — a removal the user never asked for, dressed up as a default.
 *
 * **Idempotent**, and that's the change from what this used to be. While Mocha
 * was a real choosable theme the rewrite had to run exactly once per device,
 * guarded by {@link THEME_RENAME_FLAG}, because a second pass would take a
 * deliberate choice of brown and turn it violet. No output of this function is a
 * retired key any more, so running it twice is running it once — which is what
 * lets it also be applied to a value arriving from sync. That matters: a device
 * still on an older build goes on pushing `mocha`, and without this the value
 * that comes back would be unrecognised and read as 'system'.
 */
export const migrateThemeKey = (saved: string): string => RETIRED[saved] ?? saved;
