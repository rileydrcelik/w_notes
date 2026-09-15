"""Async SQLAlchemy engine + session dependency."""

from collections.abc import AsyncIterator

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings


class Base(DeclarativeBase):
    """Declarative base shared by every model."""


def _server_settings(settings) -> dict[str, str]:
    """Postgres GUCs applied to every connection.

    These bound waits that the application itself cannot observe. See the
    comments on the matching settings for why each exists; the short version is
    that without `lock_timeout` a single wedged transaction drained the pool and
    took the service down hourly on 2026-09-14/15.

    asyncpg requires every value to be a string.
    """
    return {
        "lock_timeout": str(settings.db_lock_timeout_ms),
        "idle_in_transaction_session_timeout": str(
            settings.db_idle_in_transaction_timeout_ms
        ),
    }


_settings = get_settings()

engine = create_async_engine(
    _settings.database_url,
    pool_pre_ping=True,
    pool_size=_settings.db_pool_size,
    max_overflow=_settings.db_max_overflow,
    pool_timeout=_settings.db_pool_timeout,
    pool_recycle=_settings.db_pool_recycle_seconds,
    connect_args={"server_settings": _server_settings(_settings)},
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


# The health probe gets its own engine, deliberately tiny and separate.
#
# It used to share the pool it was meant to be reporting on, which inverted the
# signal: when the pool filled, `/health` was the first thing to block, so the
# container was killed for being busy rather than broken — and a restart does
# not empty a pool that a stuck transaction is holding. Isolating it keeps the
# probe answering about reachability (its original point) while load-shedding
# stays a matter for the request pool.
#
# One connection is enough for `SELECT 1` every 30s, and the checkout timeout
# stays inside the probe's own 5s budget so a failure reads as a failure rather
# than a timeout.
health_engine = create_async_engine(
    _settings.database_url,
    pool_pre_ping=True,
    pool_size=1,
    max_overflow=1,
    pool_timeout=2.0,
    pool_recycle=_settings.db_pool_recycle_seconds,
    # `timeout` bounds establishing a connection, which `pool_timeout` does not:
    # with Postgres unreachable this would otherwise sit on asyncpg's 60s default
    # and the probe would be scored as a hang rather than answering honestly.
    connect_args={"server_settings": _server_settings(_settings), "timeout": 3},
)
HealthSessionLocal = async_sessionmaker(health_engine, expire_on_commit=False)


async def lock_user(session: AsyncSession, user_id: str) -> None:
    """Take the per-user advisory lock, and bound how long it can be held idle.

    Every writer that assigns `server_seq` serialises on this lock so sequence
    numbers are committed in order (see routers/sync.py). It is transaction
    scoped, which is what makes it correct — and what makes it dangerous: a
    transaction that stops making progress without ending holds it, every later
    push for that user queues behind it pinning a pooled connection of its own,
    and the pool is gone within the hour.

    That is what happened on 2026-09-15. The push left its commit to
    `get_session`, which FastAPI runs after background tasks, so its `deliver`
    task ran with the lock still held and `record_embedded` waited for a lock
    only its own push could release. The push now commits before scheduling
    anything, but the shape is one careless await away: anything slow between
    taking this lock and committing.

    So the transaction also gets an idle bound enforced by the server. `SET
    LOCAL` scopes it to this transaction alone, leaving the long-running proxy
    requests on the connection-wide budget. The flip side is a rule for callers:
    never await network calls or background work while holding this lock. A
    transaction idle past the budget is terminated and rolled back, and if its
    response has already gone out, the client believes rows are stored that
    are not.
    """
    # SET LOCAL takes no bind parameters. The value is an int from settings, so
    # there is nothing to interpolate but a number.
    await session.execute(
        text(
            "SET LOCAL idle_in_transaction_session_timeout = "
            f"{int(_settings.db_locked_txn_idle_timeout_ms)}"
        )
    )
    await session.execute(select(func.pg_advisory_xact_lock(func.hashtext(user_id))))


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding a session that commits on success.

    This commit runs *after* the response is sent, and after any background
    tasks — that is how FastAPI scopes yield dependencies. A handler whose 200
    must mean "stored", or that schedules background work touching the same rows
    or locks, commits for itself first (see `routers/sync.push`), and then there
    is nothing left to do here.
    """
    async with SessionLocal() as session:
        try:
            yield session
            if session.in_transaction():
                await session.commit()
        except Exception:
            await session.rollback()
            raise
