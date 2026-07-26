# Mobile end-to-end tests (Maestro)

The native counterpart to `e2e/` (Playwright, web). Same job — catch wiring
breakage a browser-less test can't see — but on a real Android runtime, where
the app talks to `expo-sqlite`'s native module rather than wa-sqlite/OPFS.

That difference is the point. The web tests exercise one SQLite implementation
and these exercise the other, and the two have failed differently before.

## Prerequisites

These also run in CI (see below). To run them locally you need:

1. **Maestro** — a JVM CLI. `~/.maestro-cli/maestro/bin/maestro.bat` on Windows
   (the release zip ships a `.bat`; the documented `curl | bash` installer is
   Unix-only). Needs Java on PATH.
2. **A running emulator or device**
   ```sh
   $ANDROID_HOME/emulator/emulator -avd Medium_Phone_API_35
   adb devices     # confirm it appears
   ```
3. **A release build installed** — a real build, because `expo-sqlite` is a
   native module; there is no "just point at a dev server" here.
   ```sh
   cd notes-app
   SENTRY_DISABLE_AUTO_UPLOAD=true EXPO_PUBLIC_API_URL= EXPO_PUBLIC_SENTRY_DSN= \
     npx expo run:android --variant release
   ```

   `SENTRY_DISABLE_AUTO_UPLOAD=true` is required: the Sentry Gradle plugin
   uploads source maps on *release* builds only, and without an auth token it
   fails the build outright (`Auth token is required for this request`). A local
   test build has no reason to publish source maps.

   **Release, not debug — this matters.** A debug build is an expo-dev-client
   that loads its JS from Metro and remembers the server URL in app storage.
   `clearState` wipes that, so the next launch lands on the dev-client's
   "Development Servers" picker instead of the app, and every flow fails on the
   first assertion. Learned the hard way; the failure screenshot is the launcher.

   A release build embeds the JS bundle, so it launches straight into the app
   with no Metro running and no launcher in the way. It's also the artifact
   users actually get, which makes it the right thing to test — same reasoning
   as verifying the web export rather than the dev server.

   Release signs with the debug keystore (see `android/app/build.gradle`), so no
   signing setup is needed for local runs.

   Because the bundle is embedded, `EXPO_PUBLIC_*` values are **baked in at build
   time** — changing them means rebuilding.

Sync is switched off via the empty `EXPO_PUBLIC_API_URL`, matching the web
tests: no backend, no Firebase, no sign-in, and no chance of a test run creating
junk users in the production database.

## Run

One command, unattended — starts a headless emulator if one isn't already up,
runs the flows, and shuts down whatever it started:

```sh
npm run test:mobile             # flows only (assumes the installed build is current)
npm run test:mobile -- --build  # rebuild + install first — required after any code change
npm run test:mobile -- --keep   # leave the emulator running afterwards
```

Exits non-zero if a flow fails, so it can gate a release script. Roughly a
minute from cold (emulator boot dominates), or ~30s against a warm emulator.
An emulator you already had running is reused and left alone.

Or drive Maestro directly:

```sh
~/.maestro-cli/maestro/bin/maestro.bat test .maestro/
~/.maestro-cli/maestro/bin/maestro.bat test .maestro/smoke.yaml    # one flow
~/.maestro-cli/maestro/bin/maestro.bat studio                      # interactive
```

`studio` is worth using when writing a flow — it shows the live view hierarchy
and which selectors match.

## Selectors

Maestro matches on accessibility text, so the app's `accessibilityLabel` props
work here exactly as they do for Playwright's `getByLabel` on web. One set of
labels serves both platforms, which is why no `testID` props were needed.

## What these found on their first run

The app **would not launch on device at all**. `whenDbOwner` and
`subscribeDbRole` had been added to `web-db-lock.ts` (43d961c) along with callers
that run on every platform, but the `.native.ts` counterpart never got them — so
`db.ts`'s `await whenDbOwner()` threw, SQLite never opened, and AppShell crashed
before rendering. Broken for three days.

Nothing else could have caught it: the unit tests don't import those modules, the
backend tests are server-side, and Playwright drives the **web** build, which has
the functions. A platform-split module where one side is missing an export is
invisible until something runs the other side.

That's the argument for keeping these, despite the cost below.

## In CI

`.github/workflows/mobile-e2e.yml` runs these on every PR and every push to main
that touches `notes-app/**`, on a real emulator. It's a separate workflow from
`tests.yml` because it costs an order of magnitude more than the suites there —
it builds a release APK and boots an Android emulator, where the rest of the
pipeline finishes in ~1m30s.

Two caches are what make that affordable, and both have a failure mode worth
recognising:

- **Gradle build cache** — restored by `setup-gradle`, but only useful because
  `scripts/build-android-e2e.mjs` sets `org.gradle.caching=true` after prebuild.
  If a run logs `N actionable tasks: N executed` with no `FROM-CACHE`, that flag
  isn't landing and the build is doing ~27 minutes of avoidable work.
- **AVD snapshot** — keyed `avd-<api>-<target>-<arch>-v1`. Bump the `-v1` suffix
  to force a rebuild. A stale snapshot shows up as flows failing on a device in
  an odd state, not as a cache error.

Failures upload screenshots and per-step logs as the `maestro-artifacts`
artifact, kept 7 days.

Sync stays off in CI exactly as it does locally — same `E2E_BUILD_ENV`, shared
by both paths so a local run and a CI run can't test different apps.

## Before a push

`.githooks/pre-push` runs these locally before any push touching native-relevant
paths, which is faster feedback than waiting on CI. It's opt-in per clone:

```sh
git config core.hooksPath .githooks
```
