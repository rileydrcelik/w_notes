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
themselves take 2–3s each.

## In CI

They run on every push and PR as a separate job from the fast suites (~1m35s,
against ~1m for the backend and ~30s for the client). Keeping them apart means
E2E can't slow the quick feedback, and a red X says which kind of failure it was.

The config sets one retry under CI, so a test has to fail twice to fail the
build. On failure the HTML report — traces and screenshots per failed test — is
uploaded as an artifact; download it from the run page rather than trying to
reproduce locally. `npx playwright show-trace <file>` opens a trace.

**Flakiness:** 5 CI runs against known-good code, 0 spurious failures — the
check before letting these gate pushes, since a check that cries wolf poisons
the whole suite. Five runs is thin evidence (it only bounds the true rate to
somewhere under ~45%), so treat it as "no evidence of flakiness" rather than
proof of none. If a red build ever looks spurious, don't re-run and move on —
re-run to confirm, then either fix the race or move these out of the gating
path. Re-running red builds as a habit is how a suite stops meaning anything.

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

## Why they click immediately

`ready()` waits only for the create button to exist — no settling delay. That
immediacy is load-bearing, and it's why these tests earned their place.

They originally carried a 2.5s wait, because clicking sooner failed. The cause
was a real defect: `notes-store`'s `reload()` replaced state with a SQLite
snapshot, so a note created while that read was in flight was written to the
database but wiped from React state, and the editor rendered "This note could
not be found". Nothing was lost — reloading showed the note — but it read as
data loss.

A person rarely clicks within the first second of a cold load. Playwright always
does, which is the only reason it surfaced.

Fixed in `notes-store` (`persist` tracks in-flight writes; `reload` re-reads if
one lands mid-flight), and the wait is gone. Removing a race means these tests
now *guard* it: reintroduce the bug and they fail. Don't reintroduce a settle
delay to make a flaky test pass — that's the shape of a real bug.
