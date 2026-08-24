# Architecture

## The shape of it

```
Android / iOS / Web            AWS (us-east-1)
┌───────────────────┐          ┌──────────────────────────────┐
│  Expo app         │          │  Cloudflare Tunnel           │
│  ┌─────────────┐  │  HTTPS   │        │                     │
│  │ SQLite      │◄─┼──────────┼─► ECS Fargate (FastAPI)      │
│  │ (source of  │  │          │        │                     │
│  │  truth)     │  │          │        ├─► RDS Postgres      │
│  └─────────────┘  │          │        └─► S3 (file bytes)   │
└───────────────────┘          └──────────────────────────────┘
        ▲                                    │
        └──── presigned S3 URLs ─────────────┘
```

Three rules explain most of the design:

1. **The device owns the data.** Every read and write goes to on-device SQLite.
   The UI never waits on the network.
2. **The server is a mirror, not an authority.** It reconciles what devices send
   and hands back what other devices changed. It does not overwrite blindly.
3. **File bytes never pass through the API.** The row carries a key; the device
   transfers the bytes to S3 directly with a short-lived presigned URL.

## The app (`notes-app/`)

One Expo project builds all three platforms. Where a platform genuinely differs,
the file is split by extension — `foo.ts` / `foo.web.ts` / `foo.native.ts` — and
Metro picks the right one.

> Both halves of a split pair must export the same names. A missing export in
> one half type-checks fine and breaks only that platform, at runtime.

| Layer | Where |
|---|---|
| Screens and routing | `src/app/` (expo-router, file-based) |
| Local database | `src/lib/db.ts` |
| Sync client | `src/lib/sync/` |
| Auth | `src/lib/auth/` (Firebase: Google, Apple) |
| In-memory state | `src/store/` (React context stores) |
| Shared UI | `src/components/` |
| Feature logic | `src/lib/` (finance, latex, project, search, export…) |
| Theming | `src/constants/theme.ts`, `src/store/theme-store.tsx` |

State flows one way: SQLite → a store → the screen. A screen calls a store
method, the store writes to SQLite and updates itself, and sync picks the change
up later.

### Web is not a port

Web runs the same `db.ts` and the same sync engine, backed by
[wa-sqlite](https://github.com/rhashimoto/wa-sqlite) over OPFS instead of
`expo-sqlite`. Only the storage driver and a handful of platform files differ.

## Sync

`src/lib/sync/sync-engine.ts` runs one pass at a time:

1. **Push** every locally-dirty row to `POST /sync/push`.
2. **Pull** everything the server changed since our cursor from `GET /sync/pull`,
   paged, and apply it last-writer-wins.
3. **Transfer file bytes** for any row that gained or lost a `remote_key`.

The cursor is a global `server_seq` the backend hands out. Conflict resolution
lives in `db.ts` (`applyServerRows`), not in the engine — the engine only
orchestrates the round trip.

Passes are triggered by app foreground, a poll timer (`sync/poll.ts`), and
before the app is hidden (`sync/flush-on-hide.ts`).

### Identity

A device starts **anonymous**, with a UUID device key it generates and stores
locally. The server creates a user row for that key. When you sign in with
Google or Apple, the device's data is **claimed once** into the Firebase account
and the two histories are merged.

> This merge is the highest-stakes code in the project. If a signed-in device
> ever silently falls back to its device key — say, an expired token treated as
> "not signed in" — it forks into a second account and its notes stop appearing
> anywhere else. `src/lib/auth/token.ts` guards that boundary.

## The backend (`backend/`)

FastAPI + async SQLAlchemy + Postgres. It does four things:

- **Sync** (`app/routers/sync.py`) — the push/pull delta endpoints.
- **Files** (`app/routers/files.py`) — mints presigned S3 upload/download URLs.
- **Plugin proxies** (`sentry.py`, `github_issues.py`) — call third-party APIs
  with the *caller's own* stored token, so one account never sees another's
  repos.
- **AI and LaTeX** (`resume.py`, `latex.py`) — compile LaTeX to PDF, and run
  Claude for resume drafting and tailoring.

Auth is one `Authorization: Bearer` header carrying either a Firebase ID token
(a JWT) or an anonymous device key (a UUID); the server tells them apart by
shape.

Per-user secrets (Anthropic key, GitHub and Sentry tokens) are encrypted at rest
with a Fernet key from `app_secret_key` (`app/crypto.py`). With no key set,
those features fail closed rather than falling back to a shared token.

## Infrastructure (`terraform/`)

ECS Fargate (Spot) behind a **Cloudflare Tunnel** — there is no load balancer,
which is most of why it costs about $26/month. RDS Postgres is private and has
no public address. Secrets live in SSM Parameter Store. Images go to ECR.

> Many changes need **both** `terraform apply` **and** a backend redeploy: the
> first creates the parameter, the second gives the task a definition that reads
> it. CI never runs `terraform apply` — that is always by hand.

See [deployment.md](deployment.md).

## Observability

Sentry runs on all three surfaces (mobile, web, backend). The app also *reads*
Sentry: a Sentry plugin note lists a project's live issues, and "Fix" dispatches
a GitHub Actions workflow that has Claude open a PR — which, if it passes a
six-condition gate, merges and deploys itself.
