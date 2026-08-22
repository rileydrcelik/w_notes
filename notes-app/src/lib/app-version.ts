import Constants from 'expo-constants';

/**
 * What the running app calls itself.
 *
 * Read from the Expo config rather than re-typed here: `app.json`'s
 * `expo.version` is the single place the version bump lands, and a hand-copied
 * string is identical to it right up until the day someone moves the real one.
 * After an OTA update this reflects the update's manifest, so it names the code
 * you are actually running, not the binary you originally installed.
 */
export const APP_VERSION: string | null = Constants.expoConfig?.version ?? null;

/**
 * The native build number, when the config carries one. EAS manages these
 * remotely for production builds (`appVersionSource: "remote"` in eas.json), so
 * it is usually absent on web and in local builds — hence the null, and hence
 * `appVersionLabel` treating it as an optional suffix rather than a field that
 * must be filled.
 */
export const APP_BUILD: string | null = (() => {
  const config = Constants.expoConfig;
  const build = config?.ios?.buildNumber ?? config?.android?.versionCode;
  return build == null ? null : String(build);
})();

/**
 * "Version 1.0.0", or "Version 1.0.0 (15)" where a build number exists. Null
 * when there is no version to show at all — the caller renders nothing rather
 * than a label with a blank where the number should be.
 */
export function appVersionLabel(): string | null {
  if (!APP_VERSION) return null;
  return APP_BUILD ? `Version ${APP_VERSION} (${APP_BUILD})` : `Version ${APP_VERSION}`;
}
