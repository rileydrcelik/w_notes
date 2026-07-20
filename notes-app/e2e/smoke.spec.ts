import { expect, test, type Page } from '@playwright/test';

/**
 * Web smoke tests.
 *
 * Deliberately few. Their job is to catch *wiring* breakage that no unit or
 * integration test can see — the app failing to boot, a route not rendering, a
 * control not bound to its handler, OPFS failing to initialise. Correctness of
 * the logic underneath belongs in the fast suites, which cost milliseconds.
 *
 * Sync is off (`EXPO_PUBLIC_API_URL` empty), so there's no backend, no Firebase
 * and no sign-in — these exercise the local-first core the app is built on.
 */

/**
 * Interact as soon as the create button exists — no settling delay.
 *
 * That immediacy is load-bearing. `notes-store` used to lose a note created
 * before its initial hydrate resolved (the mount effect replaced state with a
 * snapshot that predated the write), and clicking this fast is what exposed it.
 * `reload` now re-reads when a write lands mid-flight, so these tests double as
 * the regression guard: reintroduce that race and they fail.
 */
async function ready(page: Page): Promise<void> {
  await page.getByLabel('Create').waitFor();
}

test('the app boots without crashing', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/');

  // The create button lives in the tab bar, which only mounts once the app has
  // booted and the router has resolved a route — so it stands in for "the app
  // came up" rather than "some HTML rendered".
  await expect(page.getByLabel('Create')).toBeVisible();

  expect(pageErrors, 'uncaught exceptions during boot').toEqual([]);
  expect(consoleErrors, 'console errors during boot').toEqual([]);
});

/**
 * The one that matters most for a local-first app. Surviving a reload means the
 * write reached wa-sqlite, OPFS persisted it to disk, and the store read it back
 * on a cold start — a chain spanning the editor, the DB layer and browser
 * storage, none of which the Node-based unit tests can touch.
 */
test('a note survives a page reload', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  // Unique per run, so a stale OPFS database can't make this pass by accident.
  const title = `e2e note ${Date.now()}`;

  await page.getByLabel('Create').click();
  await page.getByPlaceholder('Title').fill(title);
  await page.getByLabel('Go back').click();

  await expect(page.getByText(title)).toBeVisible();

  await page.reload();

  await expect(page.getByText(title)).toBeVisible();
});

/**
 * Opening a note from the grid is the app's most-travelled navigation, and it
 * exercises expo-router's dynamic `[id]` route with a real id.
 */
test('a note can be reopened from the home grid', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  const title = `e2e reopen ${Date.now()}`;

  await page.getByLabel('Create').click();
  await page.getByPlaceholder('Title').fill(title);
  await page.getByLabel('Go back').click();

  await page.getByText(title).click();

  await expect(page).toHaveURL(/\/note\/note-/);
  await expect(page.getByPlaceholder('Title')).toHaveValue(title);
});
