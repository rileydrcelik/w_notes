"""The push handler's advisory lock — the guarantee that a row can't go missing.

Split from test_sync.py because this is a *stress* test, not a contract test: it
provokes a race rather than asserting a fixed input/output pair, so it is slower
and reasons about probability rather than certainty.

The race it defends against:

    T1 takes server_seq 5.  T2 takes server_seq 6.
    T2 commits.  A polling client pulls, sees 6, stores cursor = 6.
    T1 commits.  Its row carries seq 5, which is now behind the cursor.
    That client asks for "> 6" forever and never sees the row again.

The row is in the database, present and correct, and simply invisible to the
device that asked at the wrong moment — the shape of a "note disappeared from one
device" report. ``push`` closes the window with a transaction-scoped
``pg_advisory_xact_lock`` on the user, so seq values are assigned *and* committed
in the same order.

**Known limits — read before trusting a green run.** Measured by deleting the
lock and re-running: it caught the regression in 3 of 4 runs, and takes ~18s
against ~2.5s for the whole contract suite. So a pass is evidence, not proof, and
it is marked ``slow`` and excluded from the default run (see tests/README.md).
Tuning is a narrow window: below ~40 writers the race never surfaced, and above
~100 in-flight requests the run dies of connection exhaustion instead, which
looks like a failure but tests nothing. If you widen it, re-check both ends.
"""

from __future__ import annotations

import asyncio

import pytest

from test_sync import note, pull, push

pytestmark = pytest.mark.slow

# Total pushes, and how many may be in flight at once. Every in-flight request
# holds its own connection (the test engine uses NullPool), so IN_FLIGHT has to
# stay well under Postgres's default max_connections of 100 — otherwise the run
# dies of "too many clients" and tells you nothing about ordering. Total is kept
# high because each push is only a *chance* to hit the race window.
WRITERS = 300
IN_FLIGHT = 30


async def test_concurrent_pushes_never_hide_a_row_from_a_polling_client(client, device):
    # Create the user up front. Resolving a brand-new device key concurrently is
    # its own race (see test_first_contact_race.py) and would otherwise fail this
    # test for an unrelated reason.
    await push(client, device, notes=[note(title="seed")])

    rows = [note(title=f"note-{i:03d}") for i in range(WRITERS)]
    expected = {row["title"] for row in rows}

    seen: set[str] = set()
    cursor = 0
    polling = True

    async def poller() -> None:
        """A client doing exactly what the real one does: pull from its cursor,
        absorb the rows, advance the cursor to the batch high-water mark. It only
        ever moves forward — which is what makes a skipped seq unrecoverable."""
        nonlocal cursor
        while polling:
            batch = await pull(client, device, since=cursor)
            seen.update(n["title"] for n in batch["notes"])
            cursor = batch["server_seq"]


    gate = asyncio.Semaphore(IN_FLIGHT)

    async def write(row: dict) -> None:
        async with gate:
            await push(client, device, notes=[row])

    poll_task = asyncio.create_task(poller())
    try:
        await asyncio.gather(*(write(row) for row in rows))
        # Let the poller drain whatever committed after its last read.
        for _ in range(5):
            await asyncio.sleep(0.05)
    finally:
        polling = False
        await poll_task

    # One last pull from the cursor the client actually holds. Anything absent
    # here is genuinely unreachable for this device, not merely late.
    final = await pull(client, device, since=cursor)
    seen.update(n["title"] for n in final["notes"])

    missing = expected - seen
    assert not missing, (
        f"{len(missing)} row(s) unreachable from cursor {cursor}: {sorted(missing)[:5]}"
        " — a push committed a server_seq below a cursor the client had already"
        " advanced past, so the row is stored but invisible to this device."
    )
