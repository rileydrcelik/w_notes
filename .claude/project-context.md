# w_notes — Project Context

Shared orientation for subagents and contributors. This file is the single source of truth for "how the project is built." Treat specifics (URLs, columns, resource names) as a map, not gospel — verify against the actual code before relying on them, and update this file when the architecture changes.

## What it is

w_notes is a cross-platform notes app: Expo/React Native on mobile **and** web, backed by a FastAPI/Postgres sync service on AWS. Notes support rich text and file attachments, sync across devices, and work offline.

## Repo layout

- `notes-app/` — the Expo app (mobile + web). Source in `notes-app/src/`.
  - `src/app/` — expo-router screens/routing.
  - `src/lib/db.ts` — on-device SQLite (the source of truth).
  - `src/lib/sync/sync-engine.ts`, `src/hooks/use-sync-refresh.ts` — delta sync client.
  - `src/lib/auth/` — auth (Firebase: Google/Apple).
  - `src/components/` — UI; `glass-surface.tsx`, `themed-text.tsx`, `themed-view.tsx`, `ui/`.
  - `src/constants/theme.ts`, `src/store/theme-store.tsx`, `src/hooks/use-theme.ts` — theming.
  - `notes-app/scripts/` — build/deploy scripts, incl. `fix-web-export.mjs` (web deploy fixup). (Note: `scripts/` is at the `notes-app/` root, not under `src/`.)
- `backend/` — FastAPI + Postgres sync/auth service. `app/routers/` (`sync.py`, `files.py`, `sentry.py`, `health.py`), `app/models.py`, `app/schemas.py`, `app/storage.py`, `alembic/` migrations.
- `terraform/` — AWS infra (us-east-1).
- `.github/workflows/` — CI/CD (build → ECR → ECS; autofix pipeline).

## Persistence & sync (the core, and the riskiest surface)

- **On-device SQLite is the source of truth.** The backend reconciles; it does not overwrite blindly.
- **Delta sync** between client and FastAPI/Postgres. Deltas must be idempotent and safe to retry.
- **Auth:** Firebase (Google/Apple via JS SDK).
- **Anonymous → account "claim once" merge:** a device starts anonymous with a device key; on sign-in its local data is merged into the account exactly once. Merge/conflict rules are the highest-stakes logic in the app — silent data loss lives here.
- **Web reuses the native `db.ts`/sync-engine** via wa-sqlite over OPFS. Web-specific gaps handled: CORS (API CORSMiddleware + S3 bucket CORS, `web_origins` tf var) and web file-byte transfer (`files.web.ts`).

## Rich text

- Note bodies are **one canonical rich-text HTML format on both platforms.**
- Mobile: native `react-native-enriched` editor. Web: custom `@tiptap/core` editor (markdown keyboard input + undo, no toolbar).
- The old markdown translation layer was removed.

## File attachments (copa)

- "Copa" blocks can hold any file (thumbnails for image/video).
- Bytes sync cross-device via **S3 presigned URLs**; a `remote_key` column links metadata to the S3 object. Backend side in `app/storage.py` + `app/routers/files.py`.

## Deployment (AWS, us-east-1, ~$26/mo)

- Terraform in `terraform/`: **ECS Fargate (Spot) + RDS Postgres (private) + Cloudflare Tunnel (no ALB) + S3 + SSM Parameter Store + ECR.**
- Ingress is the **Cloudflare tunnel**, not a load balancer. RDS is private — reach it via a VPC CloudShell (public subnet + `wnotes-ecs` SG) with `psql sslmode=require`; DB password in SSM `/wnotes/database-url`.
- Live API: `api.w-notes.app` (`/health` → 200 through the tunnel).
- **Two-step gotcha:** many changes need `terraform apply` **and** a backend redeploy (new image) to take effect.

## Web deploy (Cloudflare)

- Expo export → wrangler. Cloudflare **drops `node_modules` dirs**, which breaks icon fonts + `wa-sqlite.wasm` on the live site. Fix: run `scripts/fix-web-export.mjs` after export, before deploy.

## App variants

- `dev` / `preview` / `prod` use distinct Android package names via `app.config.js` `APP_VARIANT`.
- Each new Android package needs its own Google Cloud OAuth client (package + SHA-1) or Google Sign-In throws `DEVELOPER_ERROR`.

## Observability

- **Sentry on every surface** (mobile, web, backend).
- A "Sentry plugin" note kind shows a Sentry project's live issues with Fix/Ignore actions. Autofix: Fix → GitHub Actions → PR (runs Sonnet, target repo `rileydrcelik/w_notes`); Ignore resolves the issue (needs `event:write` on the Sentry token).

## Selection & the "⋯" actions menu (app-wide UI pattern)

Across the app, **you act on things by selecting them, then using the "⋯" (more) button** that appears in the floating navbar's trailing slot (where the create `+` normally sits). The pattern is consistent, but it's backed by **several independent selection stores**, one per domain — each surfaces its own contextual "⋯" menu.

- **How you select:** long-press a card/row, or **right-click on web** (`hooks/use-context-menu.ts` — a no-op on native). The first selection enters "selection mode"; while it's on, a plain tap toggles more items, so you can multi-select. Selection is **ephemeral (in-memory only) — it never touches SQLite/sync.**
- **The "⋯" button** (`more-horizontal`, with a count badge) replaces the `+`: **tap opens that domain's actions menu/sheet; long-press or right-click cancels the selection.** Tapping empty space (`components/selection-dismiss-view.tsx`) or changing route (`components/selection-backdrop.tsx`) also clears it.
- **Menus are contextual glass bottom sheets** — the offered actions adapt to what (and how many) items are selected.

The selection stores, and the navbar's precedence when more than one could be active (highest first), all live/branch in `components/floating-tab-bar.tsx`:

1. **Sentry autofix** (`store/autofix-selection-store.tsx`, accent `#7553FF`) — select Sentry issues → **Fix / Dismiss / Copy**.
2. **GitHub issues** (`store/github-selection-store.tsx`, accent `#8250df`) — select GitHub-view issues → **Close (completed / not planned) / Reopen / Comment / Copy**.
3. **Task-manager issues** (`store/task-selection-store.tsx`, accent `#16a394`) — select issues within an issue-type screen → **Mark done / not done / Edit attributes / Open on GitHub / Delete**.
4. **Notes / folders / issue types** (`store/item-selection-store.tsx`) — the shared card selection used on Home, folders, and the task-manager project feed. Its "⋯" opens the **shared `OptionsSheet` in `components/item-options-modal.tsx`**, whose rows adapt: notes/folders get **Favorite / Rename / Move / Share / Delete**; a single **issue type** (`SelectedItem.type === 'issuetype'`) gets **Rename / Track (or Stop tracking) on GitHub / Delete** — favorite/share/move are gated off, and delete cascades to the type's issues. `RenameDialog` and the delete-confirm copy branch on the target type.

When adding a new selectable surface, follow this pattern: a small ephemeral selection store + a branch in `floating-tab-bar.tsx` that swaps the `+` for a "⋯" and mounts a contextual sheet. Reuse `item-selection-store` + `OptionsSheet` when the targets are notes/folders/issue types.

## Editing & the "done" check (app-wide UI pattern)

**Editing is one gesture everywhere, and no screen owns a mode control of its own.** A screen shows its read view; you tap the content to edit it; the floating navbar's create `+` becomes a **"done" checkmark** while an editor is focused; pressing it (or blurring any other way) returns to the read view. Never add an edit/preview toggle, tab, or segmented control to a screen.

- The bridge is `lib/active-editor.ts`. A focused editor calls `setActiveEditorDismiss(fn)` with a callback that blurs it, and clears it on blur/unmount. The navbar reads that registration (`isEditorActive`/`subscribeActiveEditor`) and swaps its icon.
- **Why a registration and not just the keyboard:** the native rich editor (`EnrichedTextInput`) isn't registered with RN's `TextInputState`, so `Keyboard.dismiss()` can't blur it; and web has no on-screen keyboard to track at all. On native the check follows the keyboard, on web it follows this registration (`doneMode` in `components/floating-tab-bar.tsx`).
- **Listen to the blur, not the button press.** On web the navbar press blurs the editor *before* its own `onPress` fires, so a screen that waits for the dismiss callback to change state will never hear it (`editorJustDismissed()` exists to patch the navbar's own fallthrough). Drive screen state from `onFocusChange(false)`.
- Implementations to copy: `components/markdown-editor.web.tsx` (notes) and `components/resume/latex-source-editor.tsx` (LaTeX source → compiled preview).

**Getting *into* edit mode is the other half, and it's the same button.** On a screen showing a **leaf object** — one with nothing to create inside it (note, copy block, resume, sheet) — the trailing `+` is an **edit pencil** (`edit-2`) that opens that screen's editor. Focus it and the pencil becomes the done check: pencil in, check out. A `+` there used to create a *sibling* in the parent folder, which is not what "+ while reading a note" means to anyone.

- The bridge is `lib/edit-action.ts`, and screens use `hooks/use-edit-action.ts`: `useEditAction(() => editorRef.current?.focus())`, or `useEditAction(null)` when there's nothing to edit (a copa block holding a file). Pass the screen's *own* render condition so the pencil appears exactly when an editor is on screen.
- **Register on focus, not on mount.** `useEditAction` uses `useFocusEffect` for this: expo-router keeps screens below the top of the stack mounted, and the whole copa tab stays mounted in the top-tab pager (see the copa paste/drop leak) — mount is never a proxy for "the user is looking at it".
- **Clearing is keyed by the callback's identity** (`clearEditAction(fn)` no-ops unless `fn` still owns the slot). React Navigation doesn't promise the outgoing screen's blur cleanup runs before the incoming screen's focus effect, and a blind `setEditAction(null)` would leave the new screen showing a `+`. `src/lib/__tests__/edit-action.test.ts` pins both orderings.
- Precedence in `floating-tab-bar.tsx`: selection "⋯" > done check > edit pencil > create. Long-press keeps opening the create menu everywhere, so a leaf screen isn't a dead end.

## Design language (hard rules, from CLAUDE.md)

- Glassmorphic, minimalist.
- Squircles / rounded rects — **avoid pill shapes.**
- Consistent navbar; back + create buttons present where appropriate — and on a leaf object "appropriate" means an edit pencil, not a create `+`.
- Smooth transitions between screens.
- Editing is the app-wide gesture above — no per-screen mode toggles.
- **Reuse the existing control before styling a new one.** Bordered chips for filters (`StateFilterBar`, `app/(home)/github/[id].tsx`); 40px squircle icon buttons for secondary actions (`components/scroll-to-top.tsx`); radii from the `Spacing` scale, never hand-picked numbers.
