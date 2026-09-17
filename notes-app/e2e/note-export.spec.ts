import { expect, test, type Page } from '@playwright/test';

/**
 * The navbar's download button carries two gestures wired up in
 * `SaveButton`/`ExportMenu` (`components/floating-tab-bar.tsx`): a plain tap
 * exports the obvious thing (a note's `.txt`), while a long-press or
 * right-click opens a format menu. Neither is reachable from a unit test —
 * `note-export.test.ts` and `note-html-export.test.ts` already cover the
 * byte-building logic those formats produce, so this only exercises the
 * wiring: that the right gesture opens the right thing, gated to a plain
 * note in view mode.
 *
 * "Download as PDF" opens the browser's print dialog via a hidden iframe
 * (`save-note-pdf.web.ts`) — that's asserted by presence in the menu only, not
 * triggered, since a real print dialog would hang the run.
 */

async function ready(page: Page): Promise<void> {
  await page.getByLabel('Create').waitFor();
}

test('right-clicking the download button opens the export format menu', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  // A fresh note lands on its own screen in view mode (title autofocused, but
  // the body editor — the thing that flips the navbar into "done" mode — is
  // untouched), which is exactly the state the download button is gated on.
  await page.getByLabel('Create').click();
  await expect(page).toHaveURL(/\/note\/note-/);

  const download = page.getByLabel('Save note to device');
  await expect(download).toBeVisible();

  await download.click({ button: 'right' });

  await expect(page.getByLabel('Download as PDF')).toBeVisible();
  await expect(page.getByLabel('Download as web page')).toBeVisible();
  await expect(page.getByLabel('Download as plain text')).toBeVisible();
});

test('a plain click on the download button exports a .txt file', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  // Deliberately untitled: the title only reaches the store on a 350ms debounce
  // (or an unmount flush), and racing that would test the debounce rather than
  // the button. An untitled note's exported name is deterministic either way —
  // `noteFileTitle` falls back to "Untitled note" — so this is the plain-tap
  // path with nothing else in flight.
  await page.getByLabel('Create').click();
  await expect(page).toHaveURL(/\/note\/note-/);

  const download = page.getByLabel('Save note to device');
  await expect(download).toBeVisible();

  const [dl] = await Promise.all([page.waitForEvent('download'), download.click()]);

  expect(dl.suggestedFilename()).toBe('Untitled note.txt');
  // The right-click menu never opened, so nothing intercepted the tap — this
  // is the plain-export path and not a leftover menu row.
  await expect(page.getByLabel('Download as plain text')).toHaveCount(0);
});
