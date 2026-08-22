"""Delta-sync contract tests for the `resume_targets` table.

This is the corpus behind retrieval-assisted resume tailoring
(`notes-app/src/lib/latex/corpus.ts`): one row per job a resume was
successfully aimed at. It gets the same push/pull/LWW/isolation coverage every
other synced table gets (see `test_sync_finance.py`'s docstring for the two
silent-failure classes a new table can fall into — a field Pydantic drops
before the router sees it, and a table `pull` forgets to include) plus one
thing specific to this table: `note_id`/`folder_id` carry **no foreign key**
(see `ResumeTarget`'s docstring in `app/models.py`), so a row naming a note or
folder that doesn't exist on this server at all must still push and pull
cleanly — that's provenance, not corruption.
"""

from __future__ import annotations

import uuid

PUSH = "/sync/push"
PULL = "/sync/pull"


def resume_target(**overrides) -> dict:
    """A minimal valid resume_targets row."""
    row = {
        "id": str(uuid.uuid4()),
        "note_id": str(uuid.uuid4()),
        "folder_id": str(uuid.uuid4()),
        "company": "Acme",
        "role": "Backend Engineer",
        "facets": '{"roleFamily":"back end engineer","requirements":["kubernetes"]}',
        "job_description": "must know kubernetes",
        "source": "\\documentclass{article}",
        "base_hash": "abc12345",
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


async def test_pushed_row_comes_back_on_pull(client, device):
    row = resume_target(company="Globex", role="Staff Engineer")

    await push(client, device, resume_targets=[row])
    pulled = await pull(client, device)

    assert [t["id"] for t in pulled["resume_targets"]] == [row["id"]]
    assert pulled["resume_targets"][0]["company"] == "Globex"
    assert pulled["resume_targets"][0]["role"] == "Staff Engineer"
    assert pulled["resume_targets"][0]["source"] == row["source"]
    assert pulled["resume_targets"][0]["base_hash"] == row["base_hash"]


async def test_a_targets_only_push_still_advances_the_cursor(client, device):
    """The seq-gap failure class: a push touching only resume_targets has to
    move server_seq, or a client that pulls with the resulting cursor never
    sees it."""
    cursor = (await pull(client, device))["server_seq"]

    result = await push(client, device, resume_targets=[resume_target()])

    assert result["server_seq"] > cursor
    delta = await pull(client, device, since=cursor)
    assert len(delta["resume_targets"]) == 1
    assert delta["server_seq"] > cursor


async def test_pull_returns_only_rows_newer_than_the_cursor(client, device):
    first = resume_target(id="row-1")
    second = resume_target(id="row-2")

    cursor = (await push(client, device, resume_targets=[first]))["server_seq"]
    await push(client, device, resume_targets=[second])

    delta = await pull(client, device, since=cursor)

    assert [t["id"] for t in delta["resume_targets"]] == [second["id"]]


async def test_newer_edit_wins_and_an_older_one_is_ignored(client, device):
    """Last-writer-wins on `updated_at`, same as every other synced table. Rows
    here are meant to be append-only in normal use, but the upsert's UPDATE
    branch still exists (a re-sent push after a dropped response, or a
    tombstone), so it has to obey the same rule as everywhere else."""
    row = resume_target(id="row-1", company="Acme", updated_at=2_000)
    await push(client, device, resume_targets=[row])

    await push(
        client, device, resume_targets=[{**row, "company": "Stale Co", "updated_at": 1_000}]
    )

    pulled = (await pull(client, device))["resume_targets"]
    assert pulled[0]["company"] == "Acme"


async def test_a_genuinely_newer_edit_does_overwrite(client, device):
    row = resume_target(id="row-1", company="Acme", updated_at=1_000)
    await push(client, device, resume_targets=[row])

    await push(
        client, device, resume_targets=[{**row, "company": "Globex", "updated_at": 2_000}]
    )

    pulled = (await pull(client, device))["resume_targets"]
    assert pulled[0]["company"] == "Globex"


async def test_rows_are_isolated_per_user(client, device, other_device):
    await push(client, device, resume_targets=[resume_target()])

    assert (await pull(client, other_device))["resume_targets"] == []


async def test_one_bad_row_does_not_poison_the_batch(client, device):
    """Per-row savepoints, same guarantee as the other synced tables: a row the
    server can't store is skipped and reported, and the good rows in the same
    push still land."""
    good_before = resume_target(id="before")
    good_after = resume_target(id="after")
    poison = resume_target(id="poison\x00row")

    await push(client, device, resume_targets=[good_before, poison, good_after])

    ids = {t["id"] for t in (await pull(client, device))["resume_targets"]}
    assert ids == {"before", "after"}


async def test_a_row_naming_no_real_note_or_folder_still_pushes_and_pulls(client, device):
    """`note_id`/`folder_id` carry no foreign key on purpose (see the
    `ResumeTarget` docstring): a corpus row legitimately arrives before the
    note it names, or outlives it. A row naming ids that exist nowhere on this
    server must round-trip exactly like any other — this is not corruption."""
    row = resume_target(
        note_id="note-that-does-not-exist",
        folder_id="folder-that-does-not-exist",
    )

    await push(client, device, resume_targets=[row])
    pulled = (await pull(client, device))["resume_targets"]

    assert len(pulled) == 1
    assert pulled[0]["note_id"] == "note-that-does-not-exist"
    assert pulled[0]["folder_id"] == "folder-that-does-not-exist"


async def test_the_home_screen_folder_id_is_the_empty_string_not_null(client, device):
    """`folder_id: ""` is the home screen — a real, meaningful value, not an
    absence — and must survive the round trip as-is."""
    row = resume_target(folder_id="")

    await push(client, device, resume_targets=[row])
    pulled = (await pull(client, device))["resume_targets"]

    assert pulled[0]["folder_id"] == ""
