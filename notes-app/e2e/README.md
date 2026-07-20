# Web end-to-end tests

Playwright against the web build. Three smoke tests — that number is deliberate,
not a starting point.

## Run

```sh
npm run test:e2e          # headless
npm run test:e2e:ui       # interactive: step through, inspect the DOM
npx playwright show-trace test-results/.../trace.zip
```

Playwright starts Metro itself (`webServer` in `playwright.config.ts`), so no
server needs to be running first. A cold Metro start is ~30s; the tests
themselves take 3–5s each.

## Scope

These catch **wiring** breakage — the app not booting, a route not rendering, a
control not bound to its handler, OPFS failing to initialise. That's the class of
bug the unit and integration suites structurally cannot see, because neither
loads a browser.

They do *not* check correctness of logic underneath. That belongs in the fast
suites, which cost milliseconds instead of seconds. Resist growing this file: a
large E2E suite is slow, flaky, and trains you to re-run red builds.

Sync is off — `EXPO_PUBLIC_API_URL` is set empty in the config, so
`syncConfigured` is false and the sync engine skips cleanly. No backend, no
Firebase, no sign-in. That's not a limitation for these tests: the app is
local-first, and this exercises the wa-sqlite/OPFS core it's built on. Testing
*signed-in* sync needs a Firebase Auth emulator or a test-only token path,
because Google/Apple sign-in can't be driven through the real provider UI.

## Selectors

Prefer `getByLabel` / `getByRole` / `getByPlaceholder` over `testID`. React
Native's `accessibilityLabel` becomes `aria-label` on web, so these selectors
test what a screen reader sees — they can't silently drift from real
accessibility the way a `data-testid` can. No `testID` props were needed.

## Known bug: the hydrate race

`waitForHydrate()` in `smoke.spec.ts` is a fixed 2.5s wait, which is normally a
smell. It compensates for a real defect:

`notes-store`'s mount effect calls `setNotes(data.notes)` when `db.bootstrap()`
resolves — a **replacement**, not a merge. `createNote` inserts optimistically
with `setNotes(prev => [note, ...prev])`. Create a note before the hydrate lands
and the optimistic entry is wiped from React state, and the editor renders
"This note could not be found".

Measured: clicking immediately fails; clicking after ~2s succeeds. The row **does
reach SQLite** — reloading the page shows the note. So nothing is lost, but the
user sees an error and would reasonably assume otherwise.

A person rarely clicks within the first second of a cold load. Playwright always
does, which is how this surfaced.

**Delete `waitForHydrate` once that's fixed** — the tests should pass without it,
and the wait existing is what stops these tests from catching a regression in
that path.
