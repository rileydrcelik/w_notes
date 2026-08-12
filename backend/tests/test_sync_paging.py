"""Paged pull.

`GET /sync/pull` used to return every row above the cursor in one response. On a
big enough account that exceeds what the edge will wait for, and it then fails
*permanently*: the cursor never advances, so every retry asks for the same
oversized page and times out again — the 504 on `/sync/pull` that no amount of
retrying could clear.

Paging fixes that, but it introduces the one bug that must never ship in a delta
sync: handing back a cursor above rows that weren't in the page. Those rows are
then never pulled again, on any device, and nothing reports an error. That is
what most of this file is about.
"""

from __future__ import annotations

import uuid

PUSH = "/sync/push"
PULL = "/sync/pull"


def note(**overrides) -> dict:
    row = {
        "id": str(uuid.uuid4()),
        "title": "",
        "body": "",
        "created_at": 1_000,
        "updated_at": 1_000,
    }
    row.update(overrides)
    return row


def folder(**overrides) -> dict:
    row = {
        "id": str(uuid.uuid4()),
        "name": "f",
        "created_at": 1_000,
        "updated_at": 1_000,
    }
    row.update(overrides)
    return row


async def push(client, headers, **tables) -> dict:
    response = await client.post(PUSH, json=tables, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def pull(client, headers, since: int = 0, limit: int | None = None) -> dict:
    params = {"since": since}
    if limit is not None:
        params["limit"] = limit
    response = await client.get(PULL, params=params, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def drain(client, headers, limit: int) -> tuple[list[str], int, int]:
    """Follow `has_more` to exhaustion. Returns (note ids in order, pages, cursor)."""
    ids: list[str] = []
    cursor = 0
    pages = 0
    while True:
        page = await pull(client, headers, since=cursor, limit=limit)
        pages += 1
        ids.extend(n["id"] for n in page["notes"])
        assert page["server_seq"] >= cursor
        cursor = page["server_seq"]
        if not page["has_more"]:
            return ids, pages, cursor
        assert pages < 50, "pull did not terminate"


async def test_small_account_still_syncs_in_one_page(client, device):
    """The common case must not regress into extra round trips."""
    rows = [note(title=str(i)) for i in range(3)]
    await push(client, device, notes=rows)

    page = await pull(client, device)

    assert page["has_more"] is False
    assert len(page["notes"]) == 3


async def test_a_full_backlog_arrives_across_pages(client, device):
    rows = [note(title=str(i)) for i in range(10)]
    await push(client, device, notes=rows)

    ids, pages, _ = await drain(client, device, limit=3)

    assert pages > 1, "limit=3 over 10 rows should have paged"
    assert sorted(ids) == sorted(r["id"] for r in rows)
    assert len(ids) == len(set(ids)), "a row was sent on two pages"


async def test_pages_do_not_skip_rows_across_tables(client, device):
    """The cursor rule under multi-table truncation.

    Notes and folders interleave in `server_seq`. If the cursor were allowed to
    advance to the highest seq in the *notes* page, the folders sitting below it
    but outside the folder page would be stepped over and lost. Every row pushed
    must come back exactly once.
    """
    notes = [note(title=str(i)) for i in range(6)]
    folders = [folder(name=str(i)) for i in range(6)]
    # One batch, so the two tables' seqs interleave rather than sitting in
    # separate ranges.
    await push(client, device, notes=notes, folders=folders)

    seen_notes: list[str] = []
    seen_folders: list[str] = []
    cursor = 0
    for _ in range(50):
        page = await pull(client, device, since=cursor, limit=2)
        seen_notes.extend(n["id"] for n in page["notes"])
        seen_folders.extend(f["id"] for f in page["folders"])
        cursor = page["server_seq"]
        if not page["has_more"]:
            break

    assert sorted(seen_notes) == sorted(n["id"] for n in notes)
    assert sorted(seen_folders) == sorted(f["id"] for f in folders)
    assert len(seen_notes) == len(set(seen_notes))
    assert len(seen_folders) == len(set(seen_folders))


async def test_cursor_never_passes_an_unsent_row(client, device):
    """Stated directly: after any single page, nothing at or below the returned
    cursor may still be undelivered. Re-pulling from the previous cursor must
    reproduce the same page."""
    rows = [note(title=str(i)) for i in range(8)]
    await push(client, device, notes=rows)

    first = await pull(client, device, since=0, limit=3)
    assert first["has_more"] is True
    delivered = {n["id"] for n in first["notes"]}

    # Asking again from the same place is stable, not a moving window.
    again = await pull(client, device, since=0, limit=3)
    assert {n["id"] for n in again["notes"]} == delivered
    assert again["server_seq"] == first["server_seq"]

    # The invariant itself: resuming from the cursor this page handed back
    # yields precisely the rows it did *not* deliver. A cursor that had stepped
    # over anything would show up here as a row that neither page ever sends.
    rest: set[str] = set()
    cursor = first["server_seq"]
    for _ in range(50):
        page = await pull(client, device, since=cursor, limit=3)
        rest.update(n["id"] for n in page["notes"])
        cursor = page["server_seq"]
        if not page["has_more"]:
            break

    assert delivered | rest == {r["id"] for r in rows}
    assert not (delivered & rest), "a row was delivered on both sides of the cursor"


async def test_cursor_advances_so_the_loop_terminates(client, device):
    """A page that reports `has_more` must move the cursor, or a draining client
    spins on the same request for ever — the failure mode paging was meant to
    end, reintroduced as a hang."""
    await push(client, device, notes=[note(title=str(i)) for i in range(5)])

    page = await pull(client, device, since=0, limit=2)

    assert page["has_more"] is True
    assert page["server_seq"] > 0


async def test_empty_pull_reports_no_more(client, device):
    page = await pull(client, device, since=0)
    assert page["has_more"] is False
    assert page["server_seq"] == 0


async def test_pull_past_the_end_holds_the_cursor(client, device):
    cursor = (await push(client, device, notes=[note()]))["server_seq"]

    page = await pull(client, device, since=cursor)

    assert page["notes"] == []
    assert page["has_more"] is False
    assert page["server_seq"] == cursor
