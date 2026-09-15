"""The per-user advisory lock can no longer be held by a transaction nobody ends.

`sync.push` serialises on `pg_advisory_xact_lock(hashtext(user_id))`, which is
transaction-scoped — released on commit or rollback, and only then. On
2026-09-15 a push's transaction stalled between its last statement and its
commit: `get_session` committed after the response, Starlette ran the push's
background delivery before that, and the delivery asked for the same lock from
a second session. The session sat `idle in transaction` / `ClientRead` holding
the lock; every later push for that account queued behind it pinning a pooled
connection, the pool emptied, and the container was killed by its own health
check — hourly, for two days. That ordering is fixed and pinned in
`test_publish.py`; this module pins the backstop for the next stall, whatever
causes it.

The backstop is `app.db.lock_user`, which issues `SET LOCAL
idle_in_transaction_session_timeout` before taking the lock, so the *server*
ends a transaction that has stopped making progress. This module pins the three
things that can quietly stop being true:

1. an abandoned locked transaction really is terminated, and the lock really
   does come free for the next waiter;
2. the GUC really is applied, and really is `SET LOCAL` — a leak onto the pooled
   connection would impose the same tight cap on the long GitHub/Sentry proxy
   requests, which hold a transaction open across minutes of upstream calls; and
3. every advisory-lock site goes through the helper, so the guard cannot be
   bypassed by a future edit that reaches for `pg_advisory_xact_lock` directly.

**What the first test trades away.** It does not stall a real request. It
creates the end state directly: it calls `lock_user` and then simply abandons the
session — never commits, never rolls back, never closes. That is the exact state
observed in `pg_stat_activity` during the incident (asserted here: `idle in
transaction`, `ClientRead`, one advisory lock held), and the only thing left to
prove is that Postgres ends it, whatever left it there.

The budget is a deliberately tiny `IDLE_BUDGET_MS` rather than the configured
60s: the behaviour under test is "the transaction is ended and the lock comes
free", not the particular number, and the suite should not spend a minute proving
it. `DB_LOCKED_TXN_IDLE_TIMEOUT_MS` is the same knob in production.
"""

from __future__ import annotations

import ast
import asyncio
import random
import time
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app import db
from app.config import Settings, get_settings
from tests.test_db_timeouts import guc_ms

BACKEND_DIR = Path(db.__file__).resolve().parent.parent

# Small enough that the test costs a couple of seconds, large enough that the
# premise checks below (several fresh connections, short queries and a 100ms lock
# probe, all on the idle clock) cannot eat the budget on a loaded runner and
# leave the lock free before they look at it.
IDLE_BUDGET_MS = 2_000
# How long the wedged backend is given to die after that. Ten times the budget,
# so "it never went away" can only mean the GUC did nothing.
RELEASE_BUDGET_S = 20.0
# The blocked-waiter probe. Long enough not to be scheduling noise, short enough
# to leave most of IDLE_BUDGET_MS unspent.
PROBE_LOCK_TIMEOUT_MS = 100


def _user_id() -> str:
    """A user id no other test shares, so a leftover lock cannot decide this one."""
    return f"wedged-{random.getrandbits(48):x}"


async def _pid_is_alive(observer, pid: int) -> bool:
    async with observer.connect() as conn:
        return bool(
            await conn.scalar(
                text("SELECT count(*) FROM pg_stat_activity WHERE pid = :pid"),
                {"pid": pid},
            )
        )


async def test_an_abandoned_locked_transaction_releases_the_lock(monkeypatch):
    # Patch the object `lock_user` actually reads, which is what a
    # `DB_LOCKED_TXN_IDLE_TIMEOUT_MS=1000` deployment would do. Not
    # `get_settings()`: other tests clear its cache on teardown, after which it
    # returns a fresh object that app.db never sees, and this becomes a 60s test.
    settings = db._settings
    monkeypatch.setattr(settings, "db_locked_txn_idle_timeout_ms", IDLE_BUDGET_MS)

    # The wedged connection carries the app's real connection-wide GUCs, so the
    # only thing that can end it inside this test's budget is the SET LOCAL that
    # `lock_user` issues. (10 minutes vs 1 second.)
    assert settings.db_idle_in_transaction_timeout_ms > 100 * IDLE_BUDGET_MS
    abandoned_engine = create_async_engine(
        settings.database_url,
        poolclass=NullPool,
        connect_args={"server_settings": db._server_settings(settings)},
    )
    # A separate engine for the outside view. NullPool on both: every connection
    # here is opened and closed by this test, so a terminated one can never be
    # handed to another test.
    observer = create_async_engine(settings.database_url, poolclass=NullPool)
    Session = async_sessionmaker(abandoned_engine, expire_on_commit=False)

    user_id = _user_id()
    session = Session()
    pid = None
    try:
        await db.lock_user(session, user_id)
        pid = await session.scalar(text("SELECT pg_backend_pid()"))
        abandoned_at = time.monotonic()
        # From here the session is abandoned: the test never commits it, never
        # rolls it back and never closes it — exactly what a stalled handler
        # leaves behind.

        # --- The premise. Without these the test could pass against a lock that
        # was never taken, or a transaction that had already ended. ---
        state = wait_event = None
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            async with observer.connect() as conn:
                state, wait_event = (
                    await conn.execute(
                        text(
                            "SELECT state, wait_event FROM pg_stat_activity"
                            " WHERE pid = :pid"
                        ),
                        {"pid": pid},
                    )
                ).one()
            if state == "idle in transaction":
                break
            await asyncio.sleep(0.02)
        assert state == "idle in transaction", (
            f"the abandoned session is {state!r}, not 'idle in transaction' — this"
            " test is not reproducing the incident state"
        )
        assert wait_event == "ClientRead", (
            f"expected the backend to be waiting on the client ({wait_event!r})"
        )

        async with observer.connect() as conn:
            held = await conn.scalar(
                text(
                    "SELECT count(*) FROM pg_locks"
                    " WHERE locktype = 'advisory' AND pid = :pid"
                ),
                {"pid": pid},
            )
            assert held == 1, (
                f"the abandoned transaction holds {held} advisory locks, not 1 —"
                " lock_user is not taking the per-user lock, so nothing below is"
                " evidence about releasing it"
            )

            # And the lock genuinely blocks the next push for that user: this is
            # the waiter that stacked up seven deep during the incident.
            await conn.execute(
                text(f"SET lock_timeout = {PROBE_LOCK_TIMEOUT_MS}")
            )
            with pytest.raises(DBAPIError) as blocked:
                await conn.execute(
                    text("SELECT pg_advisory_xact_lock(hashtext(:uid))"),
                    {"uid": user_id},
                )
            assert getattr(blocked.value.orig, "sqlstate", None) == "55P03", (
                "a second acquisition of the held lock did not block"
            )
            await conn.rollback()

        # --- The regression itself. ---
        while time.monotonic() - abandoned_at < RELEASE_BUDGET_S:
            if not await _pid_is_alive(observer, pid):
                break
            await asyncio.sleep(0.05)
        else:
            pytest.fail(
                f"the abandoned transaction was still holding the advisory lock"
                f" {RELEASE_BUDGET_S:.0f}s after being abandoned, with"
                f" idle_in_transaction_session_timeout set to {IDLE_BUDGET_MS}ms —"
                " lock_user is not bounding it, so one dropped push wedges every"
                " later push for that user until the pool is gone (2026-09-15)"
            )

        # Terminated is not the same as free: prove the next waiter gets the lock.
        async with observer.connect() as conn:
            await conn.execute(text("SET lock_timeout = 1000"))
            try:
                await conn.execute(
                    text("SELECT pg_advisory_xact_lock(hashtext(:uid))"),
                    {"uid": user_id},
                )
            except DBAPIError as exc:
                pytest.fail(
                    "the wedged backend is gone but its advisory lock is still"
                    f" blocking a new waiter: {exc.orig!r}"
                )
            await conn.rollback()
    finally:
        # Leave nothing wedged behind when this test fails — a surviving holder
        # would make the next run's premise checks lie.
        if pid is not None:
            async with observer.connect() as conn:
                await conn.execute(
                    text(
                        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity"
                        " WHERE pid = :pid AND pid <> pg_backend_pid()"
                    ),
                    {"pid": pid},
                )
        try:
            await session.close()
        except Exception:
            # Expected once Postgres has terminated the backend underneath it.
            pass
        await abandoned_engine.dispose()
        await observer.dispose()


async def test_lock_user_sets_the_guc_and_does_not_leak_it_to_the_next_transaction():
    """`SET LOCAL`, not `SET`.

    The tight budget is correct for a transaction holding the per-user lock and
    badly wrong for the rest of the app: the GitHub and Sentry proxies keep a
    transaction open (a `require_user_token` SELECT autobegins one) across
    minutes of upstream paging. If the setting outlived its transaction on a
    pooled connection, whichever request drew that connection next would be
    killed at 60s of legitimate idling.
    """
    settings = get_settings()
    assert settings.db_locked_txn_idle_timeout_ms > 0, (
        "a locked-transaction idle budget of 0 means 'wait forever', which is the"
        " pre-incident behaviour"
    )
    assert (
        settings.db_locked_txn_idle_timeout_ms
        < settings.db_idle_in_transaction_timeout_ms
    ), "the locked-transaction budget is supposed to be the tighter of the two"

    # One connection, no overflow, so the second transaction is guaranteed to be
    # the same physical backend — which is the only way a leak could show.
    engine = create_async_engine(
        settings.database_url,
        pool_size=1,
        max_overflow=0,
        connect_args={"server_settings": db._server_settings(settings)},
    )
    Session = async_sessionmaker(engine, expire_on_commit=False)
    show = text("SHOW idle_in_transaction_session_timeout")

    try:
        async with Session() as session:
            pid = await session.scalar(text("SELECT pg_backend_pid()"))
            connection_wide = await session.scalar(show)
            await db.lock_user(session, _user_id())
            while_locked = await session.scalar(show)
            await session.commit()

        async with Session() as session:
            pid_after_commit = await session.scalar(text("SELECT pg_backend_pid()"))
            after_commit = await session.scalar(show)
            await session.rollback()

        # A rolled-back locked transaction must not leak it either.
        async with Session() as session:
            await db.lock_user(session, _user_id())
            await session.rollback()

        async with Session() as session:
            pid_after_rollback = await session.scalar(text("SELECT pg_backend_pid()"))
            after_rollback = await session.scalar(show)
            await session.rollback()
    finally:
        await engine.dispose()

    assert pid_after_commit == pid == pid_after_rollback, (
        "the three transactions did not share a pooled connection, so this test"
        " could not observe a leak even if there were one"
    )
    assert guc_ms(connection_wide) == settings.db_idle_in_transaction_timeout_ms, (
        f"the connection starts at {connection_wide!r}, not the configured"
        f" {settings.db_idle_in_transaction_timeout_ms}ms"
    )
    assert guc_ms(while_locked) == settings.db_locked_txn_idle_timeout_ms, (
        f"inside the locked transaction idle_in_transaction_session_timeout is"
        f" {while_locked!r}, not the configured"
        f" {settings.db_locked_txn_idle_timeout_ms}ms — the guard is not applied,"
        " so an abandoned push holds the advisory lock for the connection-wide"
        " budget (10 minutes) or forever"
    )
    assert guc_ms(after_commit) == guc_ms(connection_wide), (
        f"after committing, the pooled connection is still at {after_commit!r} —"
        " the locked-transaction budget leaked out of its transaction and now caps"
        " every request that borrows this connection, including the GitHub and"
        " Sentry proxies that idle for minutes"
    )
    assert guc_ms(after_rollback) == guc_ms(connection_wide), (
        f"after rolling back, the pooled connection is still at {after_rollback!r}"
        " — the locked-transaction budget leaked out of its transaction"
    )


def test_the_budget_is_settable_from_the_environment(monkeypatch):
    """`DB_LOCKED_TXN_IDLE_TIMEOUT_MS` is the production knob. Pinned because a
    field rename would leave the default in place and the override silently
    ignored."""
    monkeypatch.setenv("DB_LOCKED_TXN_IDLE_TIMEOUT_MS", "1234")
    assert Settings(_env_file=None).db_locked_txn_idle_timeout_ms == 1234


# --- Structural: nobody takes the lock without the guard ------------------------

# Every module that serialises on the per-user advisory lock. `lock_user` lives in
# db.py, so db.py is the one place allowed to name `pg_advisory_xact_lock`.
LOCK_CALL_SITES = (
    "app/routers/sync.py",
    "app/routers/embed.py",
    "app/publisher.py",
)


def _app_sources() -> list[Path]:
    return sorted(p for p in (BACKEND_DIR / "app").rglob("*.py"))


def test_only_db_names_the_advisory_lock():
    """The guard is only as good as the call sites that use it.

    Taking `pg_advisory_xact_lock` directly is a one-line thing to write while
    adding a fourth writer, and it reinstates the 2026-09-15 failure exactly:
    correct-looking code, transaction-scoped lock, no bound on holding it.
    """
    offenders = []
    for path in _app_sources():
        if path.name == "db.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            # `func.pg_advisory_xact_lock(...)` — the SQLAlchemy spelling.
            if isinstance(node, ast.Attribute) and node.attr.startswith(
                "pg_advisory_"
            ):
                offenders.append(f"{path.relative_to(BACKEND_DIR)}:{node.lineno}")
            # ...and raw SQL. Comments are gone by now, so only live strings and
            # docstrings can match.
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                if "pg_advisory_" in node.value:
                    offenders.append(f"{path.relative_to(BACKEND_DIR)}:{node.lineno}")

    assert not offenders, (
        "advisory lock taken outside app/db.py at "
        + ", ".join(offenders)
        + " — call app.db.lock_user instead, or the transaction gets the lock"
        " without the idle bound that keeps an abandoned request from holding it"
        " forever"
    )


@pytest.mark.parametrize("relpath", LOCK_CALL_SITES)
def test_every_lock_site_calls_lock_user(relpath):
    """The other half: the three writers still serialise at all.

    A site that dropped the lock entirely would pass the test above — and lose
    the ordering guarantee `server_seq` depends on.
    """
    tree = ast.parse((BACKEND_DIR / relpath).read_text(encoding="utf-8"))
    calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "lock_user"
    ]
    assert calls, (
        f"{relpath} no longer calls lock_user — it either stopped taking the"
        " per-user advisory lock (losing server_seq ordering) or is taking it"
        " some other way (losing the idle bound)"
    )
