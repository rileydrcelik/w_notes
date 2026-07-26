## DESIGN RULES
- use glassmorphic, minimalist design language
- for design, use squircle/rounded rects, avoid using pill shapes
- make sure the navbar is consistent, and that the back button and create buttons are present where appropriate
- use smooth transitions between screens

## TESTING
CI (`.github/workflows/tests.yml`) runs pytest, vitest and the Playwright e2e
suite on every push and PR. Let it. Don't re-run a suite locally just to see it
pass — write the test, then push.

- Run locally: `npx tsc --noEmit`, `npx expo lint`, `npm test` (vitest). These
  are seconds, and a failure here is a real failure.
- Do NOT run locally: `npm run test:e2e` (Playwright) or `npm run test:mobile`.
  Playwright boots Metro, whose cold bundle on Windows takes longer than the
  60s per-test timeout, so every test fails at `page.goto` — including ones that
  are fine. That's an environment artifact, not a signal, and chasing it wastes
  minutes per run. CI runs them on a clean Linux runner.
- To check that a web change actually bundles (the thing e2e would have caught),
  request the bundle instead of running Playwright: `curl` the `src=` URL from
  `http://localhost:8081/` and grep it for a string only your new code has. That
  also proves Metro picked the `.web` variant.
- A new test must be mutation-checked: break the code it covers, confirm it goes
  red, restore. A test that can't fail is worse than no test.
