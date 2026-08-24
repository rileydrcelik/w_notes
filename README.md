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

| | |
|---|---|
| **Notes and folders** | Rich text, nested folders, favorites, search, trash |
| **Offline first** | On-device SQLite is the source of truth; sync is a background catch-up |
| **Sync** | Delta sync across devices; anonymous until you sign in, then merged into your account |
| **Copa** | A copy/paste feed of text snippets and files — one tap to copy or open |
| **Finance** | A note that is a spreadsheet: formulas, CSV import and export |
| **Resume** | A note that is LaTeX source, compiled to PDF server-side, with version history and AI tailoring |
| **Task manager** | A folder that is an issue tracker, with two-way GitHub issue sync |
| **GitHub plugin** | A note that browses and files issues in one repo |
| **Sentry plugin** | A note that shows a project's live errors, and can hand one to an AI to fix |
| **Publishing** | Mark a note published to mirror it onto a portfolio website |
| **Export** | Save any note or compiled resume as a file, from the navbar |

Each one is described in [docs/features.md](docs/features.md).

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
