import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests for the web build.
 *
 * These are smoke tests, deliberately few. Their job is to catch *wiring*
 * breakage that no unit or integration test can see — the app failing to boot,
 * a route not rendering, a control not bound to its handler, OPFS failing to
 * initialise. Correctness of the logic underneath belongs in the fast suites,
 * which cost milliseconds instead of seconds.
 *
 * The app runs with sync switched OFF: `EXPO_PUBLIC_API_URL` is set empty, so
 * `syncConfigured` is false and the sync engine skips cleanly. That means no
 * backend, no Firebase, and no sign-in — the tests exercise the local-first
 * core (wa-sqlite over OPFS) which is what the app is built around anyway.
 * Testing signed-in sync needs a Firebase Auth emulator or a test-only token
 * path; that's a separate piece of work.
 */
export default defineConfig({
  testDir: './e2e',

  // A failing E2E test is far more often a race in the test than a bug in the
  // app, so give assertions room to settle before believing them.
  expect: { timeout: 10_000 },
  timeout: 60_000,

  // Serial locally: these share one OPFS origin, so parallel workers would
  // fight over the same database.
  workers: 1,
  fullyParallel: false,

  // Fail the run if a test is left `.only` — easy to commit by accident, and it
  // silently disables everything else.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: 'http://localhost:8081',
    // A trace is a step-by-step timeline with DOM snapshots. Kept for the first
    // retry only, so failures are debuggable without paying for it every run.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // Metro's dev server. `--port` must match `baseURL` above.
    command: 'npx expo start --web --port 8081',
    url: 'http://localhost:8081',
    reuseExistingServer: !process.env.CI,
    // Metro's first cold start compiles the whole app; it is not quick.
    timeout: 180_000,
    env: {
      // Explicitly empty, and explicitly here rather than in a .env file. A
      // stale `.env.local` once baked `http://localhost:8000` into a production
      // bundle; shell env beats the .env files, so this can't be overridden by
      // whatever happens to be on disk.
      EXPO_PUBLIC_API_URL: '',
      // No error reporting from a test run.
      EXPO_PUBLIC_SENTRY_DSN: '',
    },
  },
});
