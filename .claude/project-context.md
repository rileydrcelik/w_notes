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

## Design language (hard rules, from CLAUDE.md)

- Glassmorphic, minimalist.
- Squircles / rounded rects — **avoid pill shapes.**
- Consistent navbar; back + create buttons present where appropriate.
- Smooth transitions between screens.
