# Backend tests

Integration tests for the sync API. They run against a **real Postgres** — the
endpoints depend on `INSERT ... ON CONFLICT`, `nextval('sync_seq')` and
`pg_advisory_xact_lock`, none of which SQLite can stand in for.

## Setup

Install the test tooling once:

```sh
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -e ".[dev]"
```

Start a disposable Postgres for tests. It lives on **5433** so it never collides
with the compose stack (or any local install) on 5432:

```sh
docker run -d --name wnotes-test-pg \
  -e POSTGRES_USER=wnotes -e POSTGRES_PASSWORD=wnotes -e POSTGRES_DB=wnotes \
  -p 5433:5432 postgres:16
```

## Run

```sh
./.venv/Scripts/python.exe -m pytest -q           # fast suite (default) — ~2.5s
./.venv/Scripts/python.exe -m pytest -q -m slow   # stress/race tests — ~19s
./.venv/Scripts/python.exe -m pytest -q -m ""     # everything
./.venv/Scripts/python.exe -m pytest -k stale     # one test
```

Two tiers, because they earn different levels of trust:

- **`test_sync.py`** — 11 deterministic contract tests. Same input, same result,
  every run. These are the ones to gate a commit on.
- **`test_sync_concurrency.py`, `test_first_contact.py`** — marked `slow` and
  excluded by default. They provoke races, so they cost seconds and a pass is
  evidence rather than proof. `addopts = "-m 'not slow'"` keeps the default run
  fast enough to stay habitual.

`test_first_contact.py` is `xfail(strict=True)` — it documents an **open bug**
(non-atomic user creation in `deps.py`). It stays green while the bug is open and
flips to a failure the moment it's fixed, prompting removal of the marker.

Point them elsewhere with `TEST_DATABASE_URL`:

```sh
TEST_DATABASE_URL=postgresql+asyncpg://user:pass@host:5432/wnotes_test pytest
```

> The database named in that URL is **dropped and recreated** on every run. Keep
> it a dedicated one.

## How the harness works

`conftest.py` sets `DATABASE_URL` before importing anything from `app`, so both
the app's engine and Alembic's `env.py` resolve to the test database.

- **Schema** comes from `alembic upgrade head`, not `create_all`. That keeps the
  migrations themselves under test, and `sync_seq` only exists in migration 0001.
- **Isolation** is a `TRUNCATE ... CASCADE` before each test — much faster than
  re-migrating, and every test mints fresh device keys anyway.
- **Auth** needs no Firebase. With no credential configured, `get_current_user`
  treats any opaque bearer token as an anonymous device key, so the `device` and
  `other_device` fixtures are just distinct UUIDs — i.e. two separate users.
- **Sessions** are overridden onto a `NullPool` engine, but the override mirrors
  `get_session`'s commit/rollback exactly. That fidelity matters: `push` takes a
  transaction-scoped advisory lock, so a session that never commits would be
  testing nothing.
