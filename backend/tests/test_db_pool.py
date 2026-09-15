"""The connection pools, and the health probe's independence from the big one.

On 2026-09-14/15 a single wedged transaction drained the request pool (then
SQLAlchemy's implicit 5 + 10). `/health` drew from that same pool, so the first
thing to fail was the probe: ECS killed the container for being *busy*, which
cleared nothing — the lock holder was in Postgres, not in the process — and cost
a silent sync outage on every restart, roughly hourly.

So the probe now has an engine of its own (`app.db.health_engine`) and the
request pool is sized and bounded explicitly from settings. Two things to pin:

- the pool really is configured from those settings, rather than back on the
  defaults that made 15 connections the whole ceiling; and
- `/health` still answers when the request pool is completely checked out.

That second one is the regression that actually killed the container, so it is
written the literal way: hold every connection the request pool can produce, then
ask for a 200. It costs about a second and needs no timing luck — saturation is
asserted, not assumed.
"""

from __future__ import annotations

import asyncio

import inspect

import pytest
from fastapi import params as fastapi_params
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from app import db
from app.config import get_settings
from app.db import get_session
from app.main import app
from app.routers import health as health_router

# The ECS container health check gives the probe 5s. A `/health` that answers
# later than that is a `/health` that fails, whatever it eventually returns.
HEALTH_BUDGET_S = 5.0
# Opening a connection to Postgres is tens of milliseconds; this is only here so
# a mis-sized pool reports itself instead of blocking for `pool_timeout`.
CHECKOUT_BUDGET_S = 5.0


@pytest.fixture
async def request_engine():
    """`app.db.engine` — the pool a real request draws from.

    Disposed afterwards: this module deliberately saturates it, and a leaked
    checkout would surface as an unrelated test hanging.
    """
    yield db.engine
    await db.engine.dispose()


@pytest.fixture
async def probe_client():
    """A client with **no** dependency overrides.

    conftest's `client` swaps `get_session` onto the test engine, which is right
    for the sync tests and fatal here: it would hide the very coupling under
    test, since a `/health` wired back to `get_session` would quietly borrow the
    test pool and pass.
    """
    assert not app.dependency_overrides, "this module needs the app's own pools"
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


def _declared_dependencies() -> list:
    """Everything `/health` is declared to depend on: the endpoint's own
    `Depends(...)` parameters plus any the router applies to it.

    Read off the endpoint rather than out of `app.routes`: FastAPI 0.139 no
    longer flattens included routers into the app's route list, and a test that
    reaches into whichever private attribute happens to hold them this release
    is a test that breaks on an unrelated upgrade.
    """
    declared = [
        param.default
        for param in inspect.signature(health_router.health).parameters.values()
        if isinstance(param.default, fastapi_params.Depends)
    ]
    declared.extend(health_router.router.dependencies)
    return [d.dependency for d in declared]


def test_health_does_not_depend_on_the_request_session():
    """The structural half of the isolation, and the one that fails instantly.

    `Depends(get_session)` is a one-line thing to add back while "just adding a
    query to the probe", and it re-couples the probe to the pool it is supposed
    to be reporting on.
    """
    assert get_session not in _declared_dependencies(), (
        "/health takes the request-pool session again — a saturated pool will fail"
        " the probe before it fails a request, and the container gets killed for"
        " being busy"
    )


async def test_health_answers_while_the_request_pool_is_saturated(
    request_engine, probe_client
):
    settings = get_settings()
    capacity = settings.db_pool_size + settings.db_max_overflow

    held = []
    try:
        for n in range(capacity):
            # Bounded, so a pool that is *smaller* than its settings fails here
            # with a name rather than by silently queueing for `pool_timeout`.
            try:
                conn = await asyncio.wait_for(
                    _checkout(request_engine), timeout=CHECKOUT_BUDGET_S
                )
            except asyncio.TimeoutError:
                pytest.fail(
                    f"the request pool would not hand out connection {n + 1} of"
                    f" {capacity} within {CHECKOUT_BUDGET_S}s — its real capacity is"
                    " below the configured pool_size + max_overflow"
                )
            # Actually talk to Postgres: a checked-out connection that was never
            # used is not evidence the pool can produce a working one.
            await conn.execute(text("SELECT 1"))
            held.append(conn)

        # Prove the premise. Without this the test would still pass against a
        # pool that had room left, which would make the 200 below meaningless.
        try:
            extra = await asyncio.wait_for(_checkout(request_engine), timeout=1.0)
        except asyncio.TimeoutError:
            pass
        else:
            await extra.close()
            pytest.fail(
                f"the request pool served a {capacity + 1}th connection, so it was"
                " never saturated and this test proves nothing"
            )

        try:
            resp = await asyncio.wait_for(
                probe_client.get("/health"), timeout=HEALTH_BUDGET_S
            )
        except asyncio.TimeoutError:
            pytest.fail(
                f"/health did not answer within the {HEALTH_BUDGET_S}s ECS probe budget"
                " while the request pool was saturated — this is exactly the state that"
                " got the container killed hourly on 2026-09-14"
            )
    finally:
        for conn in held:
            await conn.close()

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"status": "ok"}


async def _checkout(engine):
    return await engine.connect()


def test_request_pool_is_sized_and_bounded_from_settings():
    """Sizes and timeouts are settings, not SQLAlchemy defaults.

    Reaching into `_max_overflow` is deliberate: the ceiling that ran out during
    the incident is the sum of size and overflow, and the pool exposes no public
    reader for the second half.
    """
    settings = get_settings()
    pool = db.engine.pool

    assert pool.size() == settings.db_pool_size
    assert pool._max_overflow == settings.db_max_overflow
    assert pool.timeout() == settings.db_pool_timeout
    assert pool._recycle == settings.db_pool_recycle_seconds
    assert pool._pre_ping is True

    # Queueing past the probe's budget is how a busy pool became a dead
    # container: the request was still waiting when ECS gave up on the process.
    assert pool.timeout() < 30, (
        "SQLAlchemy's default 30s checkout wait is six times the ECS probe timeout"
    )


def test_health_engine_is_a_separate_tiny_pool():
    settings = get_settings()
    pool = db.health_engine.pool

    assert db.health_engine is not db.engine
    assert pool is not db.engine.pool, (
        "the probe shares the request pool again — the failure mode is that the"
        " probe reports on its own queue rather than on Postgres"
    )
    assert pool.size() == 1
    assert pool._max_overflow == 1
    # A `SELECT 1` every 30s needs one connection; what matters is that failing to
    # get one is reported inside the 5s probe budget rather than waiting past it.
    assert pool.timeout() < HEALTH_BUDGET_S
    assert pool._recycle == settings.db_pool_recycle_seconds
