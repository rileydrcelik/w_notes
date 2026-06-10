# w_notes sync backend

FastAPI + Postgres sync API. **Scaffold pass:** auth, schema, migrations, and
`/health` are real; `/sync/push` and `/sync/pull` are stubbed (return 501) until
the delta-sync merge pass.

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

No signup. The client sends `Authorization: Bearer <device-key>` (a UUID it
generates and stores on-device). The server get-or-creates a `users` row for
that key. Real email/password auth later attaches credentials to the same
`users.id` — a migration, not a rewrite, so existing data never moves.

## Sentry

Set `SENTRY_DSN` in `.env` (your **Python** project DSN). Empty = disabled.
Verify with `curl http://localhost:8000/sentry-debug` (raises on purpose) and
check the event lands in Sentry, then it's safe to ignore/remove that route.

## Next pass (not built yet)

- Implement `/sync/push` (upsert by `(user_id, id)`, last-writer-wins on
  `updated_at`, honor soft deletes) and `/sync/pull` (rows with
  `server_seq > since`, return new cursor).
- Wire `syncNow()` into the client store mutation path + a background loop.
- Real auth UI.
