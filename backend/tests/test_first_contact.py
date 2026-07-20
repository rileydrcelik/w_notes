"""Resolving a brand-new identity under concurrency — a known open bug.

``deps._user_by_device_key`` (and ``_user_by_firebase`` alongside it) does a
SELECT, and on a miss an INSERT, with nothing serializing the two. Two requests
arriving together for a device key the server has never seen both miss the
SELECT, both INSERT, and the second loses to the unique index on
``users.device_key`` — a 500 rather than a shared user row.

Reachability is narrow but real. The client serializes its own sync cycle
(``syncNow`` returns the in-flight promise), so one app instance won't trigger
it. Two browser tabs share one device key with independent guards, and any future
parallelism — splitting push/pull, concurrent file uploads — opens it wide.

Marked ``xfail(strict=True)``: the suite stays green while the bug is open, and
the moment someone fixes it this test fails as XPASS to say so. Fix it by making
the insert idempotent (``ON CONFLICT (device_key) DO NOTHING`` then re-select)
rather than by loosening this test.
"""

from __future__ import annotations

import asyncio

import pytest

from test_sync import note, pull, push

pytestmark = pytest.mark.slow

# Two is enough; more only makes the collision likelier.
SIMULTANEOUS = 8


@pytest.mark.xfail(
    strict=True,
    reason="known bug: SELECT-then-INSERT in deps._user_by_device_key is not "
    "atomic, so a first contact from several requests at once 500s",
)
async def test_first_contact_from_several_requests_at_once(client, device):
    """A device the server has never seen makes its first requests concurrently.
    Every one should succeed and they should all land on a single user."""
    await asyncio.gather(
        *(push(client, device, notes=[note(title=f"first-{i}")]) for i in range(SIMULTANEOUS))
    )

    titles = {n["title"] for n in (await pull(client, device))["notes"]}
    assert titles == {f"first-{i}" for i in range(SIMULTANEOUS)}
