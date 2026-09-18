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

/**
 * Wait until every optimistic write has actually committed to SQLite.
 *
 * The store renders a new note before its write reaches OPFS, so
 * `getByText(title)` is not evidence the note is on disk. Reloading on that
 * signal alone races the write: `page.reload()` destroys the JS context while
 * the write is still in flight, so it never lands and the note is gone on the
 * way back up. Both reload tests below failed exactly this way on main, in
 * bursts, which is what made them look flaky rather than wrong.
 *
 * The store already tracks in-flight writes for its own hydrate; this waits on
 * the same set. Fails loudly if the hook is missing rather than hanging until
 * the suite times out.
 */
async function writesSettled(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => typeof window.__notesWritesSettled), {
      message: 'notes-store never exposed __notesWritesSettled',
    })
    .toBe('function');
  await page.evaluate(() => window.__notesWritesSettled());
}

declare global {
  interface Window {
    /** See notes-store.tsx — resolves once no local write is in flight. */
    __notesWritesSettled: () => Promise<void>;
  }
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

  await writesSettled(page);
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

/**
 * The navbar's trailing button is shared by three behaviours that no unit test
 * can see wired together: create, edit, done. Inside a note there is nothing to
 * create, so it must offer editing instead — and hand back to the "done" check
 * once the editor actually has focus. Both halves are registrations made by the
 * screen at runtime (`lib/edit-action.ts`, `lib/active-editor.ts`), which is
 * exactly the kind of wiring that breaks silently: the button keeps rendering,
 * it just stops meaning anything.
 */
test('the navbar offers editing, not creating, inside a note', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  await page.getByLabel('Create').click();

  // Same slot, different job. Asserting Create is *gone* is the half that fails
  // if the note screen never registers.
  await expect(page.getByLabel('Edit')).toBeVisible();
  await expect(page.getByLabel('Create')).toHaveCount(0);

  const text = `e2e edit ${Date.now()}`;
  await page.getByLabel('Edit').click();

  // The body editor took focus, so the button becomes the done check.
  await expect(page.getByLabel('Done')).toBeVisible();

  // …and the caret is really in the body, not just visually implied.
  await page.keyboard.type(text);
  await expect(page.getByText(text)).toBeVisible();
});

/**
 * Copa's paste/drop entry points are window-level listeners bound in a
 * `.web`-only hook (`use-copa-paste-drop.web.ts`) — pure wiring, invisible to
 * every Node-based test, and silently dead if Metro ever resolved the native
 * no-op variant instead. Real clipboard/drag gestures can't be driven from
 * Playwright, so these dispatch the same events the browser would, carrying a
 * real `DataTransfer`.
 */
test('pasting text on the copa feed creates a block', async ({ page }) => {
  await page.goto('/copa');
  await ready(page);

  const text = `e2e paste ${Date.now()}`;

  await page.evaluate((value) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', value);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, text);

  // Deliberately no reload here. The store renders optimistically and writes to
  // wa-sqlite without awaiting it, and pasting is instant — so a reload lands
  // while the write is still queued behind the DB's own startup and would race,
  // testing nothing but timing. Durability of that same `db.createCopa` write is
  // already covered above, by the note that survives a reload.
  await expect(page.getByText(text)).toBeVisible();
});

/**
 * A new copy block is empty, so the only thing to do with it is write in it —
 * both create paths (a tap on the navbar button, and "New copy block" from its
 * long-press/right-click menu) open it with the editor already focused. "Add
 * file" from that same menu deliberately does *not* navigate (a file block is
 * finished the moment it's picked) and is out of scope here — it needs a real
 * file picker.
 *
 * The block does not exist yet at this point: (+) opens a *draft*, and the row
 * is written on the first keystroke — which is why the URL carries the draft
 * sentinel rather than a block id. The test after this one covers the other
 * half of that bargain, that an untouched draft leaves nothing behind.
 */
test('creating a copy block opens its editor, focused', async ({ page }) => {
  await page.goto('/copa');
  await ready(page);

  // Tap path: the navbar create button itself.
  await page.getByLabel('Create').click();

  // Still deliberately more specific than `/copa`, which would match the feed:
  // a dropped `router.push` is caught here exactly as it was before.
  await expect(page).toHaveURL(/\/copa\/new$/);
  await expect(page.getByPlaceholder('Title')).toBeVisible();
  // The body is a tiptap editor on web: its placeholder is a `data-placeholder`
  // decoration on the empty paragraph, not an input's `placeholder` attribute.
  await expect(page.locator('[data-placeholder="Contents to copy…"]')).toBeVisible();

  // Focused, not merely on screen — the part the previous version of this test
  // left open, while being named for it. The navbar's create button becomes the
  // done check the moment an editor takes focus, so its label is the observable
  // proof that focus actually landed.
  await expect(page.getByLabel('Done')).toBeVisible();

  // Menu path: right-click the create button to open the long-press menu, and
  // use its "New copy block" row instead of the tap shortcut.
  await page.goto('/copa');
  await ready(page);

  await page.getByLabel('Create').click({ button: 'right' });
  await page.getByLabel('New copy block').click();

  await expect(page).toHaveURL(/\/copa\/new$/);
  await expect(page.getByPlaceholder('Title')).toBeVisible();
  await expect(page.locator('[data-placeholder="Contents to copy…"]')).toBeVisible();
  await expect(page.getByLabel('Done')).toBeVisible();
});

/**
 * The other half of the draft: nothing is written until you type.
 *
 * A block used to be created the instant (+) was pressed, so opening one and
 * backing out left a blank tile behind — and copa syncs within 150ms, so that
 * tile reached every other device, where nothing would ever clear it. The only
 * automatic cleanup in the app ran when the block's own screen unmounted, which
 * is not something any other device ever does on its behalf.
 */
test('a copy block abandoned empty is never created', async ({ page }) => {
  await page.goto('/copa');
  await ready(page);

  await page.getByLabel('Create').click();
  await expect(page).toHaveURL(/\/copa\/new$/);
  await page.getByLabel('Go back').click();

  // A text tile is labelled `Copy <label>`, so an empty one would be "Copy "
  // and nothing more. This asserts no such tile exists at all.
  await expect(page.getByLabel(/^Copy\s*$/)).toHaveCount(0);

  // The same draft, typed into, does become a real block. Reload the feed
  // first: clicking back blurred the focused editor, and a create press within
  // 300ms of that reads as the tail of the same "done" gesture and is swallowed
  // (see `editorJustDismissed`). A fresh page resets that window; without it
  // this races the runner rather than testing anything.
  await page.goto('/copa');
  await ready(page);

  const title = `e2e draft ${Date.now()}`;
  await page.getByLabel('Create').click();
  await page.getByPlaceholder('Title').fill(title);
  await page.getByLabel('Go back').click();

  await expect(page.getByText(title)).toBeVisible();
});

test('dropping a file on the copa feed creates a file block', async ({ page }) => {
  await page.goto('/copa');
  await ready(page);

  const name = `e2e-drop-${Date.now()}.png`;

  // A drag has to be announced before it can be dropped: dragenter is what
  // raises the overlay, so asserting it also covers that half of the hook.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    // dragenter/dragover carry the *types* but never the files themselves.
    dt.setData('text/plain', '');
    document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
  });
  await expect(page.getByText('Drop to add a block')).toBeVisible();

  await page.evaluate((fileName) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], fileName, { type: 'image/png' }));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  }, name);

  // The card footer shows the file's name and size, so the name being on screen
  // means the file block rendered rather than an empty text block.
  await expect(page.getByText(name)).toBeVisible();
  await expect(page.getByText('Drop to add a block')).toBeHidden();
});

/**
 * Back, from a screen the browser opened directly.
 *
 * A note reached by *tapping* has home under it in the stack, so back has
 * something to pop and this passes trivially. A note reached by URL — a reload,
 * a shared link — does not: the stack is rebuilt from the path alone. Back then
 * escapes the home stack entirely and is handled by the pager above it, which
 * used to answer by sliding to the copa tab.
 *
 * Only a real browser can set that up, which is why this is here and not in the
 * fast suites: the bug lives in how the router reconstructs state from a URL.
 * `unstable_settings.anchor` in `(home)/_layout.tsx` and `backBehavior` on the
 * pager are the two halves of the fix, and asserting we land on `/` rather than
 * merely "not on the note" is what tells them apart from a back that did nothing.
 */
test('back from a directly-opened note goes home, not to copa', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  const title = `e2e deep link ${Date.now()}`;
  await page.getByLabel('Create').click();
  await page.getByPlaceholder('Title').fill(title);
  await page.getByLabel('Go back').click();
  await expect(page.getByText(title)).toBeVisible();

  // Reload home before going any further. The store renders a new note
  // optimistically without awaiting wa-sqlite, so navigating straight to its URL
  // races the write and lands on "This note could not be found" — a failure that
  // looks like a routing bug but isn't one. Surviving this reload means the note
  // is really on disk, so what follows tests routing and nothing else.
  await writesSettled(page);
  await page.reload();
  await expect(page.getByText(title)).toBeVisible();

  await page.getByText(title).click();
  await expect(page).toHaveURL(/\/note\/note-/);

  // The reported repro: reload while the note is open, so the stack is rebuilt
  // from the URL alone with nothing behind it.
  await writesSettled(page);
  await page.reload();
  await expect(page.getByPlaceholder('Title')).toHaveValue(title);

  await page.getByLabel('Go back').click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(title)).toBeVisible();
});

/**
 * Code blocks, which nothing cheaper can cover.
 *
 * The transform that carries one between the editor and storage needs a real
 * DOM, and the vitest config here is deliberately Node-only (see its header), so
 * this round trip is only observable in a browser. It is also the transform
 * where being wrong is expensive: the stored dialect is `<codeblock>` with one
 * `<p>` per line — what the native editor reads and writes — while TipTap holds
 * plain text with newlines in it. Get the translation wrong and a code block
 * written on a phone comes back as a run-together paragraph, or the indentation
 * is eaten on every load.
 */
test('three backticks make a code block that survives a reload', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  const title = `e2e code ${Date.now()}`;

  await page.getByLabel('Create').click();
  await page.getByPlaceholder('Title').fill(title);

  const body = page.locator('.wn-rich .ProseMirror');
  await body.click();
  // The shortcut, not a menu: ``` turns the line into a real block rather than
  // leaving three backticks sitting in the text.
  await page.keyboard.type('```');
  await expect(page.locator('.wn-rich .ProseMirror codeblock')).toBeVisible();

  // An empty block to put things into — the caret is already inside it.
  // `(` and `{` close themselves, and Enter between `{}` puts the `}` on its
  // own line with the caret indented a level inside.
  await page.keyboard.type('if (x) {');
  await page.keyboard.press('Enter');
  // Tab indents rather than moving focus out of the editor.
  await page.keyboard.press('Tab');
  await page.keyboard.type('run();');

  // Exact text, not toContainText: that normalises whitespace, and the
  // indentation is the thing under test.
  const block = page.locator('.wn-rich .ProseMirror codeblock');
  const expected = 'if (x) {\n    run();\n}';
  await expect.poll(() => block.evaluate((el) => el.textContent)).toBe(expected);

  await page.getByLabel('Go back').click();
  await writesSettled(page);
  await page.reload();

  await page.getByText(title).click();
  const reloaded = page.locator('.wn-rich .ProseMirror codeblock');
  await expect(reloaded).toBeVisible();
  // Both lines, still one block, indentation intact — the round trip through
  // the stored `<p>`-per-line dialect and back.
  await expect.poll(() => reloaded.evaluate((el) => el.textContent)).toBe(expected);
});
