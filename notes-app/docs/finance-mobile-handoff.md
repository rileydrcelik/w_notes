# Finance plugin — handoff for mobile work

Written 2026-07-28, at the point where the spreadsheet note kind is built and the
backend is deployed, but no client has shipped. Next task: make it work on
device.

## Where things stand

- `main` is at `b7bfac2`. Two commits:
  - `fc2c440` — the finance plugin
  - `b7bfac2` — an unrelated copa paste/drop leak fix (see below)
- **Backend is deployed** (Actions run `30368767161`, 2026-07-28). Migration
  `0008_finance_sheets` ran on container boot, so `finance_sheets` exists in
  prod RDS and `/sync/push` + `/sync/pull` carry it.
- **Web and mobile are NOT deployed.** Everything user-visible is still only in
  git. Prod has a backend that understands sheets and no client that makes them
  — deliberate ordering, but it means nothing has been exercised against real
  data yet.
- Local verification at handoff: `npx tsc --noEmit` clean, `npm test` 163
  passing, backend `pytest` 49 passing. Lint reports 57 problems / 15 errors,
  **all pre-existing** in files this work didn't touch (`theme-store.tsx` and
  friends) — that count was the same before the feature landed, so treat any
  increase as yours.

## What the feature is

A `pluginType='finance'` note that renders an interactive spreadsheet. Cells
hold numbers, text labels, or formulas. Per-cell formatting (bold / italic /
underline / strike, background highlight, text colour) applies to a whole
drag-selected range at once. Exports to CSV. Reachable from the create menu as
"New sheet", gated by the `financeEnabled` toggle in Settings → PLUGINS.

## Decisions that should not be quietly undone

Each of these cost real analysis; the reasoning is in the code comments and the
commit message for `fc2c440`.

1. **One JSON document per sheet, in its own `finance_sheets` table**, keyed by
   the note id (`id` *is* the note id — no separate `note_id`, no FK to `notes`,
   because sync applies tables in arbitrary order and a sheet can legitimately
   arrive before its note). Rejected: one sync row per cell (the backend upserts
   rows sequentially under a per-user advisory lock, so a few-hundred-cell paste
   would stall the user's other devices) and `notes.body` (which is full-text
   searched at `index.tsx:63` and `right-sidebar.tsx:69,77,108`, and copied raw
   at `item-options-modal.tsx:300`).

2. **Unknown keys must round-trip.** The document is opaque to SQL, so the
   backend's COALESCE-preserve guard cannot see inside it. An older client that
   parsed it into a strict shape and re-serialized would silently strip fields a
   newer one wrote, on every edit. `Cell` and `Sheet` carry index signatures and
   **every transform in `lib/finance/sheet.ts` spreads rather than rebuilding**.
   Do not "clean up" those spreads into object literals — that is the data-loss
   bug, and there is a test for it.

3. **Formulas sync as source text only**; computed values are never persisted.
   Trusting a value off the wire would let a change to the parser disagree
   silently with numbers an older app version wrote.

4. **Formatting is per cell, not inline marks in the cell's text.** Neither
   rich-text editor in this repo has colour or highlight marks
   (`react-native-enriched`'s instance API has none; the tiptap build in
   `package.json` omits `extension-text-style` / `-color` / `-highlight`), and
   rewriting the HTML of every cell in a range is far more fragile than patching
   a style object.

5. **Range bounds are clamped to the sheet** in `formula.ts`. Without it a
   pasted `=SUM(A1:A1048576)` loops millions of times on the JS thread and the
   app appears to freeze with no recovery.

## The files

Pure logic (no platform APIs, shared verbatim by both platforms):

- `src/lib/finance/formula.ts` — tokenizer, recursive-descent parser, evaluator.
  Cell refs, ranges, whole-column ranges, `+ - * /`, parens, unary minus, string
  literals, and `SUM / AVERAGE / COUNT / MIN / MAX`. Never throws; every failure
  is an error *value* (`#PARSE!`, `#DIV/0!`, `#REF!`, `#CIRC!`, `#NAME?`,
  `#VALUE!`).
- `src/lib/finance/sheet.ts` — document model, codec, evaluation pass with
  memoisation and cycle detection, selection transforms, `readableTextColor`.
- `src/lib/finance/csv.ts` — RFC 4180 export; formulas export their computed
  value, rich text is flattened, formula-injection prefixes are neutralised.
- `src/lib/finance/pending.ts` — lets the CSV exporter flush the screen's
  debounced write before reading storage.

UI:

- `src/components/finance/finance-grid.tsx` — the grid. **This is the file
  mobile work will live in.**
- `src/components/finance/finance-toolbar.tsx` — formatting bar, styled to match
  `formatting-toolbar.tsx` (same accent, bar height, radii, glass, shadow,
  flyout pattern, keyboard tracking).
- `src/app/(home)/finance/[id].tsx` — the screen: title, formula/address bar,
  grid host, debounced save, remote-change adoption.
- `src/components/notes/sheet-glyph.tsx` — the mini-grid drawn on the card.
  Shared by `cards.tsx` and `cards.web.tsx` on purpose.
- `src/components/sheet-help.tsx` — formula cheatsheet, bottom-left, gated by the
  `formattingHints` pref. Cross-platform (unlike `markdown-help`, which is a
  web-only pair with a native `null` stub).

Persistence: `src/lib/db.ts` (`finance_sheets` table + the six sync
registration points + `WRITE_METHODS`), `src/lib/sync/sync-engine.ts` (the
`pushed` counter — it *gates* the request, so a missing table means a sync that
changed only that table pushes nothing), `backend/app/models.py`,
`backend/app/schemas.py`, `backend/app/routers/sync.py`,
`backend/alembic/versions/0008_finance_sheets.py`.

## Mobile: what is actually untested

All the interaction work was tuned against web. `finance-grid.tsx` deliberately
takes **two different paths**, and the native one has had far less exercise:

- **Web**: the grid container claims the gesture in the capture phase
  (`onStartShouldSetResponderCapture`), so no cell `Pressable` ever becomes the
  responder. Tap vs drag is decided by whether the pointer reached a different
  cell. This was rewritten after three failed attempts — the earlier versions
  relied on the container *stealing* the responder from a cell mid-gesture,
  which is a negotiation the current responder can refuse, and that is why range
  selection behaved differently from one attempt to the next.
- **Native**: capture returns `false`, so cells keep their `Pressable`. Tap
  opens a cell for typing, swipe scrolls, and range selection sits behind a
  220ms long-press (`armDrag`). Scrolling is disabled for the duration of a drag.

Specific things to check first on device, roughly in order of expected trouble:

1. **Long-press-then-drag feel.** `delayLongPress={220}` is a guess. If it
   misfires, the next things to try are lowering it or adding a small movement
   threshold before the drag commits.
2. **Coordinate mapping.** `cellAt` divides by *measured* cell metrics
   (`metricsRef`, set from the content box in `onContentLayout`) rather than the
   `COL_W` / `ROW_H` constants — a constant-based version drifted progressively
   left across the grid on web. Confirm the measured version is right on device
   too, especially after scrolling (origin refreshes via `onScroll`).
3. **The keyboard.** Cell inputs focus in place and Android runs edge-to-edge,
   so the screen wraps the grid in `KeyboardAvoidingView` and the toolbar tracks
   the IME inset via `useAnimatedKeyboard`. Verify the edited cell and the
   toolbar both stay visible with the keyboard up.
4. **The ghost row/column** (one faded row/col past the end; typing into it
   grows the sheet on commit, not on tap). Tapping near the grid edge on a phone
   is fiddlier than with a mouse.
5. **Whether tap-to-type fights scrolling.** Every tap now opens a cell for
   editing; on a touch device that may make it too easy to open a cell while
   trying to scroll.

## Constraints to respect

- `notes-app/AGENTS.md`: read the **exact versioned** Expo docs at
  <https://docs.expo.dev/versions/v56.0.0/> before writing code.
- `.claude/CLAUDE.md` testing rules: run `npx tsc --noEmit`, `npx expo lint`,
  `npm test` locally. Do **not** run `npm run test:e2e` or `npm run test:mobile`
  locally — Metro's cold bundle on Windows blows the 60s per-test timeout and
  every test fails at `page.goto`, which is an environment artifact, not signal.
  CI runs them.
- Mutation-check every new test: break the code it covers, confirm red, restore.
- `.native.ts` / `.web.ts` pairs **must export identical names**. A missing
  native stub once broke app launch for three days with all tests green.
- `cards.tsx` and `cards.web.tsx` are full duplicates, and `platform-parity.test.ts`
  only compares **exported names** — it cannot catch a branch added to one file
  and not the other. Edit both in the same change.

## Open items

- **`qa-test-engineer` never reported back** on the e2e regression test for the
  copa leak (paste/drop while on a finance note and on home, asserting copa
  stays empty). Treat as not done. Existing tests for that feature all
  `page.goto('/copa')` first, so they cannot catch it.
- **Web is not deployed**, so the copa leak fix is not live. Deploying web is
  manual: Expo export → `scripts/fix-web-export.mjs` → wrangler. Grep `dist` for
  `localhost:8000` (must be 0) before uploading.
- **Rich text inside a single cell is not implemented.** Cells edit as plain
  text; formatting is per cell. The data model supports HTML in `Cell.raw` and
  the grid flattens it for display, but there is no in-cell rich editor.
- **No shift-click / ctrl-click to extend or add to a selection.** A new drag
  always replaces the previous range, which is what was asked for.
- **`=(B2,B5)` is not supported** — parens only group an expression, so a comma
  inside them is `#PARSE!`. `=SUM(B2,B5)` and `=B2+B5` both work. Adding
  comma-as-union would be a parser change.
- **Formula scope** is arithmetic plus the five aggregates. No `IF`, no
  comparisons, no `&` concatenation. `sheet-help.tsx` documents only what the
  parser actually accepts — keep it that way.
- `aws-actions/configure-aws-credentials@v4` in `deploy-backend.yml` targets
  Node 20 and is being force-run on Node 24. Works now; will need a bump.

## Verify the handoff state

```
cd notes-app && npx tsc --noEmit && npx vitest run    # expect 163 passing
cd backend && .venv/Scripts/python.exe -m pytest -q   # expect 49 passing
```
