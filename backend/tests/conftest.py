"""Test harness — a real Postgres, migrated by Alembic, truncated per test.

The sync endpoints lean on Postgres-specific machinery (``INSERT ... ON CONFLICT``,
``nextval('sync_seq')``, ``pg_advisory_xact_lock``), so there is no substituting
SQLite here: the tests need a real server. Point ``TEST_DATABASE_URL`` at one, or
run the compose stack's ``db`` service and take the default.

The database named in that URL is **dropped and recreated** at the start of every
session, so never aim it at a database you care about. Schema comes from
``alembic upgrade head`` rather than ``create_all`` so the migrations themselves
stay under test — and because ``sync_seq`` only exists in migration 0001.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    # Port 5433, not the compose stack's 5432 — see tests/README.md. Tests get a
    # disposable container of their own so a run can never touch dev data.
    "postgresql+asyncpg://wnotes:wnotes@localhost:5433/wnotes_test",
)

# Set before importing anything under `app`: config.Settings reads the
# environment at import time and app.db builds its engine from it. Alembic's
# env.py pulls the same setting, so this one line aims both at the test database.
os.environ["DATABASE_URL"] = TEST_DATABASE_URL
# Keep the suite hermetic: no Sentry events, no Firebase. With no Firebase
# credential configured, deps.get_current_user accepts any opaque bearer token as
# an anonymous device key — which is exactly the identity the tests want.
os.environ["SENTRY_DSN"] = ""
os.environ["FIREBASE_CREDENTIALS"] = ""

import asyncpg  # noqa: E402
import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from app.db import get_session  # noqa: E402
from app.main import app  # noqa: E402

# Every table the suite wipes between tests. `users` included: each test mints
# fresh device keys, and leftover users would accumulate across the session.
_TABLES = ("issues", "copa_items", "notes", "folders", "users")


def _admin_dsn_and_dbname() -> tuple[str, str]:
    """Split the test URL into a plain-asyncpg DSN for the `postgres` maintenance
    database and the name of the database to create. asyncpg.connect wants a bare
    postgresql:// URL, not SQLAlchemy's `+asyncpg` dialect form."""
    raw = TEST_DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")
    base, _, dbname = raw.rpartition("/")
    return f"{base}/postgres", dbname


@pytest.fixture(scope="session", autouse=True)
async def _database() -> None:
    """Drop and recreate the test database, then migrate it to head."""
    admin_dsn, dbname = _admin_dsn_and_dbname()
    conn = await asyncpg.connect(admin_dsn)
    try:
        # Terminate stragglers first; DROP DATABASE fails while sessions are open.
        await conn.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE datname = $1 AND pid <> pg_backend_pid()",
            dbname,
        )
        await conn.execute(f'DROP DATABASE IF EXISTS "{dbname}"')
        await conn.execute(f'CREATE DATABASE "{dbname}"')
    finally:
        await conn.close()

    # Alembic's env.py calls asyncio.run(), which explodes inside a running loop,
    # so the migration runs on a worker thread with a loop of its own.
    import asyncio

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    await asyncio.to_thread(command.upgrade, cfg, "head")


@pytest.fixture(scope="session")
async def engine(_database):
    """Session-wide engine. NullPool keeps no connection alive between tests, so
    nothing holds a transaction (or an advisory lock) open across a boundary."""
    eng = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    yield eng
    await eng.dispose()


@pytest.fixture(autouse=True)
async def _clean_tables(engine):
    """Truncate everything before each test — cheaper than re-migrating, and it
    resets the ownership graph so tests can't leak rows into one another."""
    async with engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE {', '.join(_TABLES)} CASCADE"))


@pytest.fixture
async def client(engine) -> AsyncClient:
    """An HTTP client wired to the app in-process, with the request session
    swapped for one on the test engine.

    The override mirrors ``app.db.get_session`` exactly — commit on success,
    rollback on error. That fidelity matters: the push handler's advisory lock is
    transaction-scoped, so a session that never commits would test nothing real.
    """
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async def _session_override():
        async with Session() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_session] = _session_override
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


@pytest.fixture
def device() -> dict[str, str]:
    """Auth headers for a fresh anonymous device key — i.e. a brand-new user."""
    return {"Authorization": f"Bearer {uuid.uuid4()}"}


@pytest.fixture
def other_device() -> dict[str, str]:
    """A second, unrelated user, for isolation tests."""
    return {"Authorization": f"Bearer {uuid.uuid4()}"}
