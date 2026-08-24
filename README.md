# w_notes

A cross-platform notes app. One codebase runs on Android, iOS, and the web.

Notes are stored on the device first, so the app works with no network, and sync
to a FastAPI backend when there is one. Beyond plain notes, a note can be a
spreadsheet, a LaTeX resume, a live view of a GitHub or Sentry project, or an
issue in a project tracker.

- **App:** Expo / React Native (`notes-app/`) — mobile and web from the same source
- **Backend:** FastAPI + Postgres (`backend/`) — sync, auth, and plugin proxies
- **Infra:** AWS via Terraform (`terraform/`) — ECS Fargate, RDS, S3, Cloudflare Tunnel
- **Live API:** `https://api.w-notes.app`

## Features at a glance

One row per section of [docs/features.md](docs/features.md) — follow a link for
the detail.

| | |
|---|---|
| [Getting around](docs/features.md#getting-around) | One floating navbar. Editing, selecting and exporting are app-wide gestures, not per-screen buttons |
| [Notes and folders](docs/features.md#notes-and-folders) | Rich text, nested folders, favorites, scored search, trash |
| [Copa](docs/features.md#copa--the-copypaste-feed) | A copy/paste feed of text snippets and files — one tap to copy or open |
| [Plugin notes](docs/features.md#plugin-notes) | A note can render live content instead of a body: |
| ↳ [Finance](docs/features.md#finance-spreadsheet) | A spreadsheet — formulas, CSV import and export |
| ↳ [Resume](docs/features.md#resume-latex) | LaTeX source, compiled to PDF server-side, with version history and AI tailoring |
| ↳ [GitHub](docs/features.md#github-issues) | Browse and file issues in one repo |
| ↳ [Sentry](docs/features.md#sentry-issues) | A project's live errors, and a Fix button that hands one to an AI |
| [Task manager](docs/features.md#task-manager) | A folder that is an issue tracker, with two-way GitHub issue sync |
| [Accounts and sync](docs/features.md#accounts-and-sync) | Works signed out; sign in with Google or Apple and the device's data merges in |
| [Publishing](docs/features.md#publishing) | Mark a note published to mirror it onto a portfolio website |
| [Settings](docs/features.md#settings) | Theme, editor hints, which plugins appear, and your own provider tokens |

## Quick start

```sh
# backend (Docker: API on :8000, Postgres on :5432)
cd backend && cp .env.example .env && docker compose up --build

# app
cd notes-app && npm install
npm run web          # browser
npm run android      # device or emulator (needs a native build)
```

The app runs without the backend — it just won't sync.

## Docs

- [Features](docs/features.md) — what the app does, screen by screen
- [Architecture](docs/architecture.md) — how the pieces fit together
- [Data model](docs/data-model.md) — tables on the device and on the server
- [API](docs/api.md) — backend endpoints and settings
- [Development](docs/development.md) — setup, scripts, tests, conventions
- [Deployment](docs/deployment.md) — shipping web, mobile, and backend

## License

MIT — see [LICENSE](LICENSE).
