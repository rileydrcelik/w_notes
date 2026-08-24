# Development

## Repo layout

```
notes-app/          the Expo app (mobile + web)
  src/app/          screens, expo-router file-based routing
  src/lib/          data layer and feature logic
  src/components/   shared UI
  src/store/        in-memory state
  scripts/          build and deploy helpers
  e2e/              Playwright specs
  patches/          patch-package patches over node_modules
backend/            FastAPI + Postgres
  app/routers/      endpoints
  alembic/          migrations
  tests/            pytest
terraform/          AWS infrastructure
.github/workflows/  CI and deploys
.githooks/          versioned git hooks
docs/               this documentation
```

## Setup

```sh
# backend — API on :8000, Postgres on :5432, migrations run on start
cd backend && cp .env.example .env && docker compose up --build

# app
cd notes-app && npm install
npm run web
```

`npm install` runs `patch-package` and copies the pdf.js worker through the
`postinstall` script. Do not skip it.

The app works without the backend; it simply does not sync.

### Native builds

`npm run android` / `npm run ios` build a real binary. That is required — the app
uses native modules (`expo-sqlite`, `react-native-enriched`), so Expo Go cannot
run it.

Install the git hooks once per clone:

```sh
git config core.hooksPath .githooks
```

## Scripts

| Command | Does |
|---|---|
| `npm run web` / `android` / `ios` | Run the app |
| `npm test` | Vitest unit tests |
| `npm run test:watch` | Vitest, watching |
| `npm run lint` | ESLint via `expo lint` |
| `npx tsc --noEmit` | Type check |
| `npm run build:web` | Export the web bundle, fix it up, verify it |
| `npm run verify:web` | Check an existing export |
| `npm run test:e2e` | Playwright (see the warning below) |
| `npm run test:mobile` | Maestro flows on a device or emulator |

## Tests

CI (`.github/workflows/tests.yml`) runs pytest, vitest, and the app-version gate
on every push and PR. Let it.

**Run locally** — these take seconds, and a failure here is a real failure:

```sh
npx tsc --noEmit
npx expo lint
npm test
```

**Do not run locally:** `npm run test:e2e` or `npm run test:mobile`. Playwright
boots Metro, and a cold Windows bundle takes longer than the 60-second per-test
timeout, so every test fails at `page.goto` — including the ones that are fine.
That is an environment artifact, not a signal. CI runs them on Linux.

To check that a web change actually bundles — the thing e2e would have caught —
request the bundle instead:

```sh
curl -s http://localhost:8081/ | grep 'src='       # find the bundle URL
curl -s '<that url>' | grep -c 'somethingOnlyYourCodeHas'
```

That also proves Metro picked the `.web` variant.

Backend tests need a real Postgres (they use `ON CONFLICT`, `nextval`, and
advisory locks). See `backend/tests/README.md` — it runs on **5433** so it never
collides with the compose stack.

> There is one shared test database. Two pytest runs at the same time produce
> around twenty invented failures.

**Every new test must be mutation-checked**: break the code it covers, confirm it
goes red, restore. A test that cannot fail is worse than no test.

## Conventions

### Platform splits

Where a platform genuinely differs, split the file by extension —
`foo.ts` / `foo.web.ts` / `foo.native.ts`. Metro picks the right one.

> Both halves must export the same names. A missing native stub type-checks
> fine, passes every test, and breaks launch on device only.

### Design rules

- Glassmorphic and minimalist.
- Squircles and rounded rects — **not pills**.
- Radii come from the `Spacing` scale, never hand-picked numbers.
- Reuse the existing control before styling a new one: bordered chips for
  filters (`StateFilterBar`), 40px squircle icon buttons for secondary actions
  (`components/scroll-to-top.tsx`).
- **No scrollbars, on either platform.** Web is handled app-wide in
  `src/global.css`;
  every native `ScrollView`/`FlatList` spreads `noScrollbar` from
  `lib/scroll-style.ts`. To say more content lies below, design a signal — an
  edge fade, a half-visible next row — rather than bringing a bar back.
- Editing and selection are app-wide gestures wired through `lib/active-editor.ts`
  and `lib/edit-action.ts`. Never add a per-screen edit/preview toggle. See
  [features.md](features.md#getting-around).

### Keyboard avoidance

Do not use `KeyboardAvoidingView` — it is a no-op on edge-to-edge Android. Use
`hooks/use-keyboard-inset.ts` and `hooks/use-keyboard-reveal.ts`.

### Grids

Note and folder grids use an explicit per-column width with `flexGrow: 0`, not
`flex: 1`, so a partial last row stays the same size as a full one on web
(`src/lib/grid.ts`).

### Expo version

This project is on Expo 56. Check the versioned docs at
<https://docs.expo.dev/versions/v56.0.0/> before writing native or config code —
the API has moved.
