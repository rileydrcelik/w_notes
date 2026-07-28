"""Delta-sync contract tests for the finance_sheets table.

A new synced table has to be registered in several independent places, and most
of them fail *silently* when missed — no error, no 4xx, no failing test
elsewhere. Two are worth naming, because these tests exist mainly to catch them:

  * a field missing from ``PushRequest`` is dropped by Pydantic before the
    router ever sees it, so the server returns 200 and throws the data away
    while the client clears its dirty flags believing the push landed;
  * a table missing from ``pull``'s ``changed()`` set never leaves the server,
    so edits sync one way forever.

Neither shows up in the existing suite, which only exercises notes/folders.
"""

from __future__ import annotations

import json
import uuid

PUSH = "/sync/push"
PULL = "/sync/pull"


def sheet(**overrides) -> dict:
    """A minimal valid finance sheet row. ``id`` is the owning note's id."""
    row = {
        "id": str(uuid.uuid4()),
        "data": json.dumps({"version": 1, "rows": 20, "cols": 6, "cells": {}}),
        "created_at": 1_000,
        "updated_at": 1_000,
    }
    row.update(overrides)
    return row


async def push(client, headers, **tables) -> dict:
    response = await client.post(PUSH, json=tables, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def pull(client, headers, since: int = 0) -> dict:
    response = await client.get(PULL, params={"since": since}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def test_pushed_sheet_comes_back_on_pull(client, device):
    """The round trip. Fails if the field is missing from PushRequest (silently
    discarded), from PullResponse (silently omitted), or from pull's changed()."""
    document = json.dumps(
        {
            "version": 1,
            "rows": 20,
            "cols": 6,
            "cells": {"0,0": {"raw": "Rent"}, "0,1": {"raw": "1200"}},
        }
    )
    row = sheet(data=document)

    await push(client, device, finance_sheets=[row])
    pulled = await pull(client, device)

    assert [s["id"] for s in pulled["finance_sheets"]] == [row["id"]]
    # Byte-identical: the server must never reformat a document it doesn't parse.
    assert pulled["finance_sheets"][0]["data"] == document


async def test_sheet_advances_the_cursor(client, device):
    """A push of only a sheet has to move server_seq, or the client's cursor
    outruns its own rows and they are never pulled again."""
    cursor = (await pull(client, device))["server_seq"]

    await push(client, device, finance_sheets=[sheet()])
    delta = await pull(client, device, since=cursor)

    assert len(delta["finance_sheets"]) == 1
    assert delta["server_seq"] > cursor


async def test_pull_returns_only_sheets_newer_than_the_cursor(client, device):
    first, second = sheet(), sheet()

    cursor = (await push(client, device, finance_sheets=[first]))["server_seq"]
    await push(client, device, finance_sheets=[second])

    delta = await pull(client, device, since=cursor)

    assert [s["id"] for s in delta["finance_sheets"]] == [second["id"]]


async def test_newer_edit_wins_and_older_one_is_ignored(client, device):
    """Whole-document last-writer-wins. This is the accepted trade for storing
    the sheet as one row: a stale device's push must not resurrect old cells."""
    row = sheet(data='{"v":"first"}', updated_at=1_000)
    await push(client, device, finance_sheets=[row])

    await push(
        client, device, finance_sheets=[{**row, "data": '{"v":"newer"}', "updated_at": 2_000}]
    )
    await push(
        client, device, finance_sheets=[{**row, "data": '{"v":"stale"}', "updated_at": 500}]
    )

    pulled = await pull(client, device)
    assert pulled["finance_sheets"][0]["data"] == '{"v":"newer"}'


async def test_tombstoned_sheet_propagates(client, device):
    """Deleting a finance note soft-deletes its sheet; the tombstone has to reach
    other devices, or a device that never pulled it pushes the sheet back."""
    row = sheet()
    cursor = (await push(client, device, finance_sheets=[row]))["server_seq"]

    await push(
        client,
        device,
        finance_sheets=[{**row, "deleted_at": 3_000, "updated_at": 3_000}],
    )

    delta = await pull(client, device, since=cursor)
    assert delta["finance_sheets"][0]["deleted_at"] == 3_000


async def test_a_large_document_survives_the_round_trip(client, device):
    """A realistic worst case: every cell of a 100x20 grid filled and styled.
    Guards against a size limit appearing between the client and Postgres."""
    cells = {
        f"{r},{c}": {"raw": str(r * c), "style": {"bg": "#ffef9f", "bold": True}}
        for r in range(100)
        for c in range(20)
    }
    document = json.dumps({"version": 1, "rows": 100, "cols": 20, "cells": cells})

    row = sheet(data=document)
    await push(client, device, finance_sheets=[row])
    pulled = await pull(client, device)

    assert pulled["finance_sheets"][0]["data"] == document


async def test_one_bad_sheet_does_not_poison_the_batch(client, device):
    """Per-row savepoints: a row the server can't store is skipped and reported,
    and the good rows in the same push still land.

    A NUL byte is valid JSON but Postgres text cannot hold one, so this fails
    *server-side* and exercises the SAVEPOINT. A value the driver or Pydantic
    rejects first would 422 the whole request and never reach it."""
    good = sheet()
    bad = sheet(data='{"cells":"\x00"}')

    await push(client, device, finance_sheets=[bad, good])
    pulled = await pull(client, device)

    assert [s["id"] for s in pulled["finance_sheets"]] == [good["id"]]


async def test_sheets_are_isolated_per_user(client, device, other_device):
    """A sheet pushed by one account must never appear in another's pull."""
    await push(client, device, finance_sheets=[sheet()])

    assert (await pull(client, other_device))["finance_sheets"] == []
