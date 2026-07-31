## WORKING STYLE
- When requirements are ambiguous, ask before implementing rather than assuming.
  Permission prompts are off in this repo, so a clarifying question is the only
  checkpoint left — use it when two readings of a request would lead to
  materially different work.

## DESIGN RULES
- use glassmorphic, minimalist design language
- for design, use squircle/rounded rects, avoid using pill shapes
- make sure the navbar is consistent, and that the back button and create buttons are present where appropriate
- use smooth transitions between screens
- editing is one app-wide gesture, not a per-screen control. A screen shows its
  read view; you tap the content to edit it; the navbar's create (+) button
  becomes a "done" checkmark while an editor is focused, and pressing it returns
  to the read view. Never add an edit/preview toggle, tab, or segmented control
  to a screen — wire the editor to `lib/active-editor.ts` instead (see
  `markdown-editor.web.tsx` and `components/resume/latex-source-editor.tsx`).
- the navbar's trailing button offers **create** only where something can be
  created *inside* what you're looking at. A screen showing a leaf object — a
  note, a copy block, a resume, a sheet — offers an **edit pencil** there
  instead; it has no children, and a (+) that quietly made a sibling somewhere
  else was the old, wrong behaviour. Register the screen's "start editing" via
  `hooks/use-edit-action.ts`; the pencil becomes the done check once the editor
  takes focus, so the whole gesture reads pencil → check. Long-press still opens
  the create menu.
- the pencil assumes there's a read view to start editing *from*. Where a screen
  is already in edit mode by default, there's nothing for it to offer, and the
  slot goes to whatever that screen can't otherwise show you. The **resume** is
  the one such screen today: it opens straight into its source, and side by side
  the source never leaves the screen, so it offers its **version history**
  (`hooks/use-version-action.ts`) instead of a pencil. This is a real exception,
  not an oversight — don't "restore" the pencil there. It is also the whole test:
  a screen that opens in a read view keeps the pencil, no matter how leaf-like.
- exporting is a navbar action too, never a button on the screen. While you're
  *reading* a document — a note, a compiled resume — a download icon appears
  inside the navbar's pill, growing it; it's absent while an editor is focused,
  and absent when there's nothing to export yet. A screen whose export the navbar
  can't derive on its own registers it via `hooks/use-save-action.ts` (see
  `app/(home)/resume/[id].tsx`); a plain note needs nothing, the bar reads its
  body from the store.
- reuse the existing control for a job before styling a new one: bordered chips
  for filters (`StateFilterBar` in `app/(home)/github/[id].tsx`), 40px squircle
  icon buttons for secondary actions (`components/scroll-to-top.tsx`). Radii come
  from the `Spacing` scale, not hand-picked numbers.

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
