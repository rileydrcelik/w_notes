# w_notes sync backend

FastAPI + Postgres delta-sync API. Auth, schema, migrations, `/health`, and the
`/sync/push` + `/sync/pull` delta-sync endpoints are all implemented. The
on-device SQLite stays the source of truth; the server stores a per-user mirror
and exchanges deltas keyed on a global `server_seq` cursor.

## Run

```sh
cd backend
cp .env.example .env        # optional: paste your Sentry Python DSN
docker compose up --build
```

- API: http://localhost:8000  (OpenAPI docs at `/docs`)
- Health: `curl http://localhost:8000/health` → `{"status":"ok"}`
- Postgres: localhost:5432 (user/pass/db all `wnotes`)

Migrations run automatically on container start (`alembic upgrade head`).

## Auth model

The `Authorization: Bearer <token>` header carries one of two shapes, told apart
by structure:

- A **Firebase ID token** (a JWT) once the user has signed in with Google/Apple,
  verified with the Firebase Admin SDK and mapped to a user by `uid`. Requires
  `FIREBASE_CREDENTIALS` (service-account JSON path); unset → Firebase disabled.
- An anonymous **device key** (a UUID the client generates and stores
  on-device) before sign-in. The server get-or-creates a `users` row for it.

On first sign-in the client claims the device-key user's data into the Firebase
account, so a device's pre-login notes survive signing in.

## Sentry

Set `SENTRY_DSN` in `.env` (your **Python** project DSN). Empty = disabled.

## Not built yet (deployment)

- A production host + managed Postgres + public HTTPS URL (compose here is
  local-dev only).
- Platform secrets for `DATABASE_URL`, `SENTRY_DSN`, `FIREBASE_CREDENTIALS`.
