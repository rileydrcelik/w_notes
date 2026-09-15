"""Alembic environment — async engine, URL + metadata pulled from the app."""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy.ext.asyncio import async_engine_from_config
from sqlalchemy import pool

from app.config import get_settings
from app.db import Base

# Import models so their tables register on Base.metadata for autogenerate.
from app import models  # noqa: F401

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Feed the app's DATABASE_URL into Alembic's config at runtime.
config.set_main_option("sqlalchemy.url", get_settings().database_url)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def _do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    # `lock_timeout` is set on the connection, never with a `SET` statement here.
    #
    # Never wait indefinitely for a lock to run DDL: on 2026-09-13
    # `0014_issue_duplicate`'s `ALTER TABLE issues ADD COLUMN` blocked on a
    # relation lock held by an already-wedged session. Each replacement
    # container queued behind the last, none ever reached uvicorn, the deploy's
    # `services-stable` waiter timed out after ten minutes, and production
    # silently stayed on the previous image for two days — with the apps already
    # shipping the client half of that migration. Failing in 30s instead makes
    # that a loud deploy failure naming the lock rather than a stale image.
    #
    # It has to ride on `connect_args`. Issuing `SET lock_timeout` on the
    # connection before `context.configure` would autobegin a transaction, and
    # alembic, seeing one it does not own, hands back a `nullcontext()` instead
    # of the `_ProxyTransaction` that commits — so every migration, and the
    # `alembic_version` bump with it, would roll back on close while the process
    # exited 0. A green deploy that applied nothing is worse than the hang.
    #
    # This bounds *waiting* for a lock, never *holding* one, so a genuinely slow
    # `ALTER` or backfill is unaffected. See test_migrations_commit.py.
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        connect_args={"server_settings": {"lock_timeout": "30s"}},
    )
    async with connectable.connect() as connection:
        await connection.run_sync(_do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
