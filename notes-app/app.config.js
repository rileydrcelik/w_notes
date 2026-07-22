// Dynamic Expo config: picks app name + package/bundle ids per variant.
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

export default ({ config }) => {
  const variant = variantConfig();

  return {
    ...config,
    name: variant.name,
    scheme: variant.scheme,
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
