/**
 * Sentry initialization for the app. Importing this module (for its side effect)
 * once, as early as possible, sets up crash + error reporting.
 *
 * The DSN comes from `EXPO_PUBLIC_SENTRY_DSN`. When it is unset (e.g. before you
 * paste your React Native project DSN into `.env`), `init` is skipped and every
 * Sentry call elsewhere becomes a harmless no-op — the app runs unchanged.
 */
import * as Sentry from '@sentry/react-native';

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

export const sentryEnabled = !!dsn;

if (dsn) {
  Sentry.init({
    dsn,
    // Tag events so dev noise is separable from real installs.
    environment: __DEV__ ? 'development' : 'production',
    // Full tracing in dev; trim in production builds.
    tracesSampleRate: __DEV__ ? 1.0 : 0.2,
    // Keep PII out unless we deliberately decide otherwise.
    sendDefaultPii: false,
  });
}

export { Sentry };
