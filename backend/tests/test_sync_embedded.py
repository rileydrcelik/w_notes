"""``notes.embedded`` — the one column a client may not write.

Every other field in the sync stream belongs to the device that sent it. This one
is the portfolio's answer about its own site, written server-side, and the whole
point of the tests here is that a push cannot touch it.

That is not paranoia about a hypothetical old client. The obvious alternative —
reusing ``published`` with the ``_PRESERVE_IF_NULL`` guard — fails on day one,
because that guard keeps a stored value only when the incoming one is NULL and
every shipped client holds ``published`` as ``NOT NULL DEFAULT 0`` and pushes a
confident ``false``. These tests pin the difference.
"""

from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models import Note
from test_sync import note, pull, push


async def _set_embedded(engine, note_id: str, value: bool) -> None:
    """Stand in for the publisher's write, which runs in a background task."""
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        await session.execute(
            update(Note).where(Note.id == note_id).values(embedded=value)
        )
        await session.commit()


async def _read_embedded(engine, note_id: str):
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        return (
            await session.execute(select(Note.embedded).where(Note.id == note_id))
        ).scalar_one()


async def test_pull_carries_embedded(client, device, engine):
    row = note()
    await push(client, device, notes=[row])
    await _set_embedded(engine, row["id"], True)

    pulled = await pull(client, device)

    assert pulled["notes"][0]["embedded"] is True


async def test_a_push_cannot_clear_it(client, device, engine):
    """The case that rules out reusing ``published``.

    An ordinary edit — a typo fix — carrying the column's value. If the client
    could write it, this would blank the site's answer on every device.
    """
    row = note(updated_at=1_000)
    await push(client, device, notes=[row])
    await _set_embedded(engine, row["id"], True)

    await push(client, device, notes=[note(**{**row, "updated_at": 2_000, "embedded": False})])

    assert await _read_embedded(engine, row["id"]) is True


async def test_a_push_cannot_set_it(client, device, engine):
    """The other direction: a client cannot claim to be on the website."""
    row = note(updated_at=1_000)
    await push(client, device, notes=[row])

    await push(client, device, notes=[note(**{**row, "updated_at": 2_000, "embedded": True})])

    assert await _read_embedded(engine, row["id"]) is None


async def test_a_first_push_cannot_seed_it(client, device, engine):
    """The INSERT branch, not just the UPDATE one.

    Skipping the column only when updating — the way ``_IMMUTABLE`` works — would
    still let a note arriving for the first time carry its own answer.
    """
    row = note(embedded=True)

    await push(client, device, notes=[row])

    assert await _read_embedded(engine, row["id"]) is None


async def test_a_claim_style_push_cannot_clear_it(client, device, engine):
    """Claiming an anonymous device re-pushes every local row at once.

    So whatever a push does to this column, it does to the entire account in one
    request. Same assertion as above, stated at the scale that made it urgent.
    """
    rows = [note(id=f"n{i}", updated_at=1_000) for i in range(3)]
    await push(client, device, notes=rows)
    for row in rows:
        await _set_embedded(engine, row["id"], True)

    await push(
        client,
        device,
        notes=[note(**{**row, "updated_at": 2_000, "embedded": False}) for row in rows],
    )

    for row in rows:
        assert await _read_embedded(engine, row["id"]) is True


async def test_unknown_is_not_false(client, device):
    """A note nobody has asked about reads as unknown, not as "not on the site".

    The distinction the nullable column exists for: if the portfolio is
    unreachable the publisher records nothing, and that has to stay tellable
    apart from the portfolio saying no.
    """
    row = note()
    await push(client, device, notes=[row])

    pulled = await pull(client, device)

    assert pulled["notes"][0]["embedded"] is None
