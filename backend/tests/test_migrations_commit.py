"""`alembic upgrade head` must leave the schema behind.

The container's CMD is `alembic upgrade head && uvicorn ...` (see Dockerfile), so
a migration step that *reports* success without committing is invisible: the
deploy goes green, the API starts, and the schema is whatever it was before. That
is worse than the stranded-lock failure this suite's `lock_timeout` guard was
added for, because a blocked DDL at least fails loudly.

Nothing else here checks the outcome rather than the exit code — conftest migrates
a fresh database at session start, and if that silently did nothing every test
fails on a missing table, which points anywhere but at Alembic.

Run against a scratch database of its own, created and dropped by the fixture, so
it cannot disturb the session's.
"""

from __future__ import annotations

import os
import subprocess
import sys

import asyncpg
import pytest

from app.config import get_settings
from conftest import BACKEND_DIR


@pytest.fixture(autouse=True)
def _clean_tables():
    """Opt out of conftest's TRUNCATE (this overrides it for this module only).

    Nothing here touches the session's database — the fixture below makes one of
    its own — and the truncate would be the first casualty of the very failure
    under test: a migration that commits nothing leaves no tables to truncate, so
    every test in the suite errors in setup and this one never gets to say why.
    Without the override the diagnosis costs a bisect; with it, one named test
    fails with the reason.
    """
    yield


def _split(url: str) -> tuple[str, str]:
    """(admin DSN on `postgres`, database name) from a SQLAlchemy URL."""
    raw = url.replace("postgresql+asyncpg://", "postgresql://")
    base, _, name = raw.rpartition("/")
    return f"{base}/postgres", name


@pytest.fixture
async def scratch_database() -> str:
    """An empty database, dropped afterwards. Returns its SQLAlchemy URL."""
    admin_dsn, name = _split(get_settings().database_url)
    scratch = f"{name}_migrations"

    conn = await asyncpg.connect(admin_dsn)
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{scratch}" WITH (FORCE)')
        await conn.execute(f'CREATE DATABASE "{scratch}"')
    finally:
        await conn.close()

    yield f"{admin_dsn.rsplit('/', 1)[0]}/{scratch}".replace(
        "postgresql://", "postgresql+asyncpg://"
    )

    conn = await asyncpg.connect(admin_dsn)
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{scratch}" WITH (FORCE)')
    finally:
        await conn.close()


async def test_upgrade_head_commits_the_schema(scratch_database):
    # The deploy's own command, run the deploy's own way: a subprocess, so the
    # connection alembic opens is closed the same way it is in production. An
    # in-process call could leave the outcome to a connection this test still
    # holds, which is the exact difference being tested.
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=str(BACKEND_DIR),
        env={**os.environ, "DATABASE_URL": scratch_database},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        f"alembic upgrade head failed:\n{result.stdout}\n{result.stderr}"
    )

    dsn = scratch_database.replace("postgresql+asyncpg://", "postgresql://")
    conn = await asyncpg.connect(dsn)
    try:
        tables = {
            row["tablename"]
            for row in await conn.fetch(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
            )
        }
    finally:
        await conn.close()

    # A fresh connection, after the migrating process exited: anything visible
    # here was committed. `notes` comes from 0001 and `issues` from 0005, so a
    # partial application shows up as one present and the other missing.
    assert "alembic_version" in tables, (
        "alembic reported every migration applied and committed none of them — a"
        " deploy running this would start the API against the old schema and say"
        f" nothing. Tables present: {sorted(tables)}"
    )
    assert {"users", "notes", "issues"} <= tables, (
        f"schema incomplete after upgrade head; tables present: {sorted(tables)}"
    )
