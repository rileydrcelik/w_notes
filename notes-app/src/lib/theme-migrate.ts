/**
 * The one-time rename of the stored theme key, kept in a module of its own.
 *
 * Deliberately imports nothing. Both `lib/theme-resolve` and `lib/db` need this
 * rule, and `lib/db` is loaded by unit tests that must not drag in
 * `constants/theme` — which imports `global.css` and would fail outside a
 * bundler. A pure string function has no such reach.
 */

/**
 * The row the chosen theme is stored under — now in the synced `user_settings`
 * table rather than the device-local `settings` one, so a theme follows the
 * account across devices.
 */
export const THEME_SETTING_KEY = 'themeKey';

/** Settings row that records the rename has already run on this device. */
export const THEME_RENAME_FLAG = 'theme_rename_v1';

/**
 * Rewrite a `themeKey` saved before Mocha was renamed to Midnight.
 *
 * `mocha` used to name the Catppuccin violet palette, which is now `midnight`;
 * the name was freed up for the brown palette that actually looks like coffee.
 * A value written before that swap therefore asks for a theme that no longer
 * answers to its name, and left alone every device sitting on Catppuccin would
 * quietly turn brown on next launch.
 *
 * Apply this **exactly once per device**, against the value already on disk, and
 * record `THEME_RENAME_FLAG` so it never runs again. Running it a second time is
 * not harmless: after the rename `mocha` is a real, choosable theme, so a second
 * pass would take a deliberate choice of brown and turn it violet. That is also
 * why it belongs at database-open time rather than in the theme store — the
 * store re-hydrates on every sync, and a pull can carry another device's
 * legitimate `mocha` into a device that hasn't migrated yet.
 */
export const migrateThemeKey = (saved: string): string =>
  saved === 'mocha' ? 'midnight' : saved;
