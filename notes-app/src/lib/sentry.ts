/**
 * Sentry initialization for the app. Importing this module (for its side effect)
 * once, as early as possible, sets up crash + error reporting.
 *
 * The DSN comes from `EXPO_PUBLIC_SENTRY_DSN`. When it is unset (e.g. before you
 * paste your React Native project DSN into `.env`), `init` is skipped and every
 * Sentry call elsewhere becomes a harmless no-op — the app runs unchanged.
 *
 * Dev builds do not transmit. See `shouldSendEvents` for why that is stronger
 * than tagging them and sending anyway; set `EXPO_PUBLIC_SENTRY_DEV=1` when you
 * are deliberately testing the Sentry integration itself.
 */
import * as Sentry from '@sentry/react-native';

import { shouldSendEvents } from './sentry-reporting';

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

/**
 * Whether a DSN is configured at all. Note this says nothing about whether
 * events are being sent — a dev build has a DSN and still stays quiet.
 */
export const sentryEnabled = !!dsn;

const sendEvents = shouldSendEvents({
  isDev: __DEV__,
  devOptIn: process.env.EXPO_PUBLIC_SENTRY_DEV,
});

if (dsn) {
  Sentry.init({
    dsn,
    // Init still runs in dev so every Sentry.* call elsewhere keeps working and
    // the integrations stay installed; `enabled` is what holds events back. That
    // way the only difference between dev and prod is transmission, rather than
    // a whole code path that only ever runs in production.
    enabled: sendEvents,
    // Tag events so dev noise is separable from real installs — still worth
    // doing for the opt-in case above.
    environment: __DEV__ ? 'development' : 'production',
    // Full tracing in dev; trim in production builds.
    tracesSampleRate: __DEV__ ? 1.0 : 0.2,
    // Keep PII out unless we deliberately decide otherwise.
    sendDefaultPii: false,
  });
}

export { Sentry };
