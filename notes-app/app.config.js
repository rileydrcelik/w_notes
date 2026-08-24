// Dynamic Expo config: picks app name + package/bundle ids per variant, and
// derives the OTA runtime lineage from the display version.
// Variant is selected via the APP_VARIANT env var, set per profile in eas.json
// (and defaulting to "development" for local `expo run:*` builds).
//
// The base config is read from app.json and passed in as `config`.

const VARIANT = process.env.APP_VARIANT ?? 'development';

const IS_PROD = VARIANT === 'production';
const IS_PREVIEW = VARIANT === 'preview';

const BASE_PACKAGE = 'com.rileydrcelik.wnotes';

function variantConfig() {
  if (IS_PROD) {
    return {
      name: 'notes-app',
      // New Play app entry: the old `com.rileydrcelik.wnotes` listing is locked to
      // a lost upload key, and Play won't let a package name be reused — so prod
      // moves to `.app`. Dev/preview keep deriving from BASE_PACKAGE below.
      package: `${BASE_PACKAGE}.app`,
      scheme: 'notesapp',
    };
  }
  if (IS_PREVIEW) {
    return {
      name: 'notes-app (Preview)',
      package: `${BASE_PACKAGE}.preview`,
      scheme: 'notesapp-preview',
    };
  }
  // development (default)
  return {
    name: 'notes-app (Dev)',
    package: `${BASE_PACKAGE}.dev`,
    scheme: 'notesapp-dev',
  };
}

/**
 * The OTA runtime lineage for a display version: `1.2.3` → `1.2`.
 *
 * These are two different numbers wearing one string, and conflating them is
 * what `runtimeVersion: { policy: "appVersion" }` used to do here.
 *
 * `expo.version` is the *display* version. It moves on every push — the third
 * digit covers backend deploys, OTA pushes and small fixes — because it is what
 * Settings shows and what a bug report quotes.
 *
 * `runtimeVersion` is a *compatibility boundary*: an `eas update` only reaches
 * devices whose installed binary was built at the same runtime version. Tying
 * that to the full display version meant every third-digit bump started a fresh
 * lineage, so each update shipped to a population of zero and the fix had to
 * wait for a store build. Dropping the third digit is the whole fix: patches
 * ride over the air to binaries already in the field, and a *minor* bump is the
 * deliberate act of declaring "this needs a real build" — which is exactly what
 * the second digit is for.
 *
 * Strict on purpose. A version this can't parse would silently pick some other
 * lineage and quietly orphan every install, so it throws at config-eval time —
 * before a build exists to be wrong.
 */
export function runtimeVersionFor(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? ''));
  if (!match) {
    throw new Error(
      `app.json expo.version must be major.minor.patch, got ${JSON.stringify(version)}. ` +
        'The runtime version is derived from it, so an unparseable version would ' +
        'orphan every installed build from OTA updates.',
    );
  }
  return `${match[1]}.${match[2]}`;
}

export default ({ config }) => {
  const variant = variantConfig();

  return {
    ...config,
    name: variant.name,
    scheme: variant.scheme,
    runtimeVersion: runtimeVersionFor(config.version),
    ios: {
      ...config.ios,
      bundleIdentifier: variant.package,
    },
    android: {
      ...config.android,
      package: variant.package,
    },
    web: {
      ...config.web,
      // The website is a single product — it doesn't carry the variant suffix
      // the app builds use. `web.name` drives the exported <title>.
      name: 'w-notes',
      shortName: 'w-notes',
    },
  };
};
