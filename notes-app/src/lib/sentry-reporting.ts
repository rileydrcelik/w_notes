/**
 * Whether Sentry should actually transmit events.
 *
 * Split out from `sentry.ts` so it can be unit-tested: that module imports
 * `@sentry/react-native`, which has no Node implementation and cannot load in
 * the vitest environment. This file imports nothing, so the rule itself is
 * checkable — and the rule is the part worth checking, because getting it
 * backwards would silently switch off production error reporting.
 *
 * Dev builds stayed silent-but-sending for a long time: events were tagged
 * `environment: development` and shipped anyway. That is worse than noise here.
 * `.github/workflows/sentry-autofix.yml` treats any issue it is pointed at as
 * "a production error", so a crash from someone's laptop could open a PR and
 * ride the ship pipeline to a prod deploy.
 */

/** Values of `EXPO_PUBLIC_SENTRY_DEV` that mean "yes, report from dev too". */
const OPT_IN = new Set(['1', 'true', 'yes']);

export function shouldSendEvents(options: {
  /** React Native's `__DEV__`: true under Metro and in dev-client builds. */
  isDev: boolean;
  /** Raw `EXPO_PUBLIC_SENTRY_DEV`, absent unless deliberately set. */
  devOptIn?: string | null;
}): boolean {
  // Production always reports. No env var can turn that off — an accidental
  // `EXPO_PUBLIC_SENTRY_DEV=0` left in a `.env` must not blind the live app.
  if (!options.isDev) return true;

  const flag = options.devOptIn?.trim().toLowerCase();
  return flag != null && OPT_IN.has(flag);
}
