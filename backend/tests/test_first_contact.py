"""Resolving a brand-new identity under concurrency.

``deps._get_or_create_user`` used to SELECT and then INSERT on a miss, with
nothing serializing the two. Requests arriving together for a device key the
server had never seen all missed the SELECT, all INSERTed, and every one after
the first died on the unique index — a 500 on a device's very first contact.

Reachability was narrow but real: the client serializes its own sync cycle
(``syncNow`` returns the in-flight promise), so one app instance wouldn't trigger
it, but two browser tabs share a device key with independent guards, and any
future parallelism would open it wide.

Fixed by making the insert idempotent (``ON CONFLICT DO NOTHING`` then
re-select), so concurrent first contacts converge on one user row rather than
racing to create several. This test holds that line.
"""

from __future__ import annotations

import asyncio

import pytest

from test_sync import note, pull, push

pytestmark = pytest.mark.slow

# Two is enough; more only makes the collision likelier.
SIMULTANEOUS = 8


async def test_first_contact_from_several_requests_at_once(client, device):
    """A device the server has never seen makes its first requests concurrently.
    Every one should succeed and they should all land on a single user."""
    await asyncio.gather(
        *(push(client, device, notes=[note(title=f"first-{i}")]) for i in range(SIMULTANEOUS))
    )

    titles = {n["title"] for n in (await pull(client, device))["notes"]}
    assert titles == {f"first-{i}" for i in range(SIMULTANEOUS)}
