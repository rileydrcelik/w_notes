"""Postgres-side timeouts on the app's own connections.

These bound waits the application cannot see, and on 2026-09-14/15 their absence
took production down hourly: one sync push wedged `idle in transaction` while
holding `pg_advisory_xact_lock(hashtext(user_id))` (routers/sync.py). That lock
is transaction-scoped, so it was never released; every later push for the account
queued behind it — seven waiters over nine minutes, confirmed in
`pg_stat_activity` — each pinning a pooled connection until the pool was gone and
the container failed its own health check.

The cure is two GUCs set on every connection (`app.db._server_settings`), so this
module checks the two things that can silently stop being true:

1. asyncpg actually applies them — `server_settings` is handed to the driver, not
   to SQLAlchemy, and nothing else in the suite would notice if a rename or a
   typo made it a no-op.
2. `lock_timeout` really aborts a blocked lock wait. Applied-but-ineffective is
   the failure mode that reads as "configured" in a review and still hangs.

The second test runs against a deliberately tiny `lock_timeout` (see
LOCK_TIMEOUT_MS) rather than the configured 15s — the behaviour under test is
"the wait ends", not the specific budget, and the suite should not spend 15s
proving it.
"""

from __future__ import annotations

import asyncio
import random
import re
import time
from types import SimpleNamespace

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from app import db
from app.config import get_settings

# Postgres normalises a millisecond-valued GUC on the way out: 15000 comes back
# from SHOW as "15s", 600000 as "10min", 250 as "250ms". Parse it back so the
# assertions can be written in the units the setting is declared in.
_UNIT_MS = {"us": 0.001, "ms": 1, "s": 1_000, "min": 60_000, "h": 3_600_000, "d": 86_400_000}


def guc_ms(shown: str) -> float:
    """`SHOW <a ms-valued GUC>` -> milliseconds."""
    match = re.fullmatch(r"(\d+)\s*([a-z]*)", shown.strip())
    assert match, f"unparseable GUC value {shown!r}"
    amount, unit = int(match.group(1)), match.group(2) or "ms"
    assert unit in _UNIT_MS, f"unknown GUC unit {unit!r} in {shown!r}"
    return amount * _UNIT_MS[unit]


@pytest.fixture(params=["engine", "health_engine"])
async def pooled_engine(request):
    """Each of the app's two real engines in turn.

    Both are exercised: they are built separately and the health one is easy to
    forget, which is how it would come to be the one connection in the system
    with no timeouts on it. Disposed afterwards so no test inherits a live
    checkout from this one — `app.db`'s engines are module-level and otherwise
    outlive the test that touched them.
    """
    engine = getattr(db, request.param)
    yield engine
    await engine.dispose()


async def test_connections_carry_the_timeout_gucs(pooled_engine):
    settings = get_settings()

    # A zero here means "wait forever", which is the pre-incident behaviour; the
    # assertions below would still pass against it, so rule it out first.
    assert settings.db_lock_timeout_ms > 0, "lock_timeout of 0 disables the fix"
    assert settings.db_idle_in_transaction_timeout_ms > 0

    async with pooled_engine.connect() as conn:
        lock_timeout = await conn.scalar(text("SHOW lock_timeout"))
        idle_timeout = await conn.scalar(text("SHOW idle_in_transaction_session_timeout"))

    assert guc_ms(lock_timeout) == settings.db_lock_timeout_ms, (
        f"lock_timeout is {lock_timeout!r} on a connection from this engine, not the"
        f" configured {settings.db_lock_timeout_ms}ms — a waiter on the push advisory"
        " lock would queue indefinitely and hold its pooled connection while it did"
    )
    assert guc_ms(idle_timeout) == settings.db_idle_in_transaction_timeout_ms, (
        f"idle_in_transaction_session_timeout is {idle_timeout!r}, not the configured"
        f" {settings.db_idle_in_transaction_timeout_ms}ms — a wedged transaction would"
        " hold its advisory lock forever, as one did on 2026-09-14"
    )


# Small enough that the test costs a quarter of a second, large enough that a
# loaded CI runner cannot mistake scheduling delay for lock acquisition.
LOCK_TIMEOUT_MS = 250
# How long the blocked waiter is given before the test gives up on it. Well clear
# of LOCK_TIMEOUT_MS, and far below the configured 15s, so "it timed out" can only
# mean the GUC did nothing.
WAIT_BUDGET_S = 5.0


async def test_lock_timeout_aborts_a_blocked_advisory_lock_wait():
    """The incident, in miniature: one session holds the push lock, another asks
    for it. The second must come back with an error rather than wait."""
    settings = get_settings()
    # The real helper, with a small timeout — so this test still fails if
    # `_server_settings` stops emitting `lock_timeout`, which is the point.
    impatient = SimpleNamespace(
        db_lock_timeout_ms=LOCK_TIMEOUT_MS,
        db_idle_in_transaction_timeout_ms=settings.db_idle_in_transaction_timeout_ms,
    )

    # NullPool on both: each connection is opened and closed by this test alone,
    # so a cancelled or aborted one can never be handed to another test.
    holder_engine = create_async_engine(settings.database_url, poolclass=NullPool)
    waiter_engine = create_async_engine(
        settings.database_url,
        poolclass=NullPool,
        connect_args={"server_settings": db._server_settings(impatient)},
    )

    # An arbitrary key, not derived from any row, so a leftover lock from another
    # test cannot make this one pass (or fail) for the wrong reason.
    key = random.getrandbits(31)

    async def take_the_lock() -> None:
        async with waiter_engine.begin() as conn:
            await conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})

    try:
        async with holder_engine.begin() as holder:
            await holder.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})

            started = time.monotonic()
            try:
                await asyncio.wait_for(take_the_lock(), timeout=WAIT_BUDGET_S)
            except asyncio.TimeoutError:
                pytest.fail(
                    f"the blocked waiter was still waiting after {WAIT_BUDGET_S}s with"
                    f" lock_timeout={LOCK_TIMEOUT_MS}ms — the GUC is not being applied,"
                    " so a contended push holds its pooled connection indefinitely"
                )
            except DBAPIError as exc:
                elapsed = time.monotonic() - started
                aborted = exc
            else:
                pytest.fail(
                    "acquiring the advisory lock succeeded while another transaction"
                    " held it — the test proved nothing about lock_timeout"
                )
    finally:
        await waiter_engine.dispose()
        await holder_engine.dispose()

    # 55P03 is lock_not_available: Postgres aborted the statement on the timeout.
    # Asserting the code (rather than just "some error") keeps a connection
    # failure or a bad key from passing as a timeout.
    assert getattr(aborted.orig, "sqlstate", None) == "55P03", (
        f"expected a lock_not_available (55P03) abort, got {aborted.orig!r}"
    )
    assert elapsed < WAIT_BUDGET_S, (
        f"the wait took {elapsed:.2f}s, which is not the configured timeout"
    )
