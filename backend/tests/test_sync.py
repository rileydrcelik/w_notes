"""Delta-sync contract tests for POST /sync/push and GET /sync/pull.

These cover the guarantees the client depends on and that have historically been
where the expensive bugs lived: cursor semantics, last-writer-wins, per-user
isolation, cross-version NULL handling, and batch poisoning.
"""

from __future__ import annotations

import uuid

PUSH = "/sync/push"
PULL = "/sync/pull"


def note(**overrides) -> dict:
    """A minimal valid note row. `updated_at` drives last-writer-wins, so tests
    that care about ordering set it explicitly rather than relying on this."""
    row = {
        "id": str(uuid.uuid4()),
        "title": "",
        "body": "",
        "created_at": 1_000,
        "updated_at": 1_000,
    }
    row.update(overrides)
    return row


async def push(client, headers, **tables) -> dict:
    """POST a batch and return the parsed response, failing loudly on non-200."""
    response = await client.post(PUSH, json=tables, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def pull(client, headers, since: int = 0) -> dict:
    response = await client.get(PULL, params={"since": since}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def test_pushed_note_comes_back_on_pull(client, device):
    row = note(title="hello", body="<p>world</p>")

    await push(client, device, notes=[row])
    pulled = await pull(client, device)

    assert [n["id"] for n in pulled["notes"]] == [row["id"]]
    assert pulled["notes"][0]["title"] == "hello"
    assert pulled["notes"][0]["body"] == "<p>world</p>"


async def test_pull_returns_only_rows_newer_than_the_cursor(client, device):
    """The core delta guarantee: a client that pulls with its stored cursor sees
    the second push and not the first."""
    first, second = note(title="first"), note(title="second")

    cursor = (await push(client, device, notes=[first]))["server_seq"]
    await push(client, device, notes=[second])

    delta = await pull(client, device, since=cursor)

    assert [n["title"] for n in delta["notes"]] == ["second"]
    assert delta["server_seq"] > cursor


async def test_pull_with_no_changes_holds_the_cursor_steady(client, device):
    """An idle pull must not rewind the cursor, or the client re-downloads
    everything on every poll."""
    cursor = (await push(client, device, notes=[note()]))["server_seq"]

    idle = await pull(client, device, since=cursor)

    assert idle["notes"] == []
    assert idle["server_seq"] == cursor


async def test_a_newer_edit_overwrites(client, device):
    row = note(title="original", updated_at=1_000)
    await push(client, device, notes=[row])

    await push(client, device, notes=[{**row, "title": "edited", "updated_at": 2_000}])

    assert (await pull(client, device))["notes"][0]["title"] == "edited"


async def test_a_stale_edit_is_ignored(client, device):
    """Last-writer-wins: a device that was offline pushes an old version of a row
    it already had. The server must keep the newer copy rather than let the late
    arrival resurrect stale content."""
    row = note(title="newer", updated_at=2_000)
    await push(client, device, notes=[row])

    await push(client, device, notes=[{**row, "title": "stale", "updated_at": 1_000}])

    assert (await pull(client, device))["notes"][0]["title"] == "newer"


async def test_soft_delete_syncs_like_any_other_edit(client, device):
    row = note(title="doomed", updated_at=1_000)
    await push(client, device, notes=[row])

    await push(client, device, notes=[{**row, "deleted_at": 3_000, "updated_at": 3_000}])

    pulled = (await pull(client, device))["notes"]
    assert len(pulled) == 1, "a delete is a row update, not a row disappearance"
    assert pulled[0]["deleted_at"] == 3_000


async def test_one_users_rows_are_invisible_to_another(client, device, other_device):
    await push(client, device, notes=[note(title="private")])

    assert (await pull(client, other_device))["notes"] == []


async def test_an_older_client_cannot_null_out_a_column_it_predates(client, device):
    """Cross-version safety. A client built before plugin notes existed sends no
    `plugin_type`/`plugin_config`; a plain last-writer-wins upsert would write
    those NULLs and silently strip the plugin from every device."""
    row = note(
        title="sentry note",
        updated_at=1_000,
        plugin_type="sentry",
        plugin_config='{"org":"acme"}',
    )
    await push(client, device, notes=[row])

    # The old client round-trips the row: newer timestamp, no knowledge of the
    # plugin columns, so they are simply absent from its payload.
    await push(
        client,
        device,
        notes=[note(id=row["id"], title="retitled", created_at=1_000, updated_at=2_000)],
    )

    pulled = (await pull(client, device))["notes"][0]
    assert pulled["title"] == "retitled", "the edit itself must still land"
    assert pulled["plugin_type"] == "sentry"
    assert pulled["plugin_config"] == '{"org":"acme"}'


async def test_a_deliberate_null_still_propagates(client, device):
    """The flip side of the rule above: `folder_id` is excluded from the
    preserve-on-NULL set because clearing it is a real user action (moving a note
    back to home). That NULL must reach the other devices."""
    row = note(folder_id="folder-1", updated_at=1_000)
    await push(client, device, notes=[row])

    await push(client, device, notes=[{**row, "folder_id": None, "updated_at": 2_000}])

    assert (await pull(client, device))["notes"][0]["folder_id"] is None


async def test_one_unstorable_row_does_not_block_the_rest_of_the_batch(client, device):
    """Each row upserts inside its own SAVEPOINT. Without that, a single row the
    server can't store aborts the whole transaction, and because the client keeps
    retrying the same batch, that device's sync stops permanently."""
    good_before = note(title="before")
    good_after = note(title="after")
    # A NUL byte is valid JSON and valid Python, but Postgres text cannot hold
    # one — so this row fails *server-side* and aborts the transaction. That
    # matters: a value the driver rejects client-side (an out-of-range bigint,
    # say) never reaches Postgres and so never exercises the SAVEPOINT at all.
    poison = note(title="poison\x00row")

    result = await push(client, device, notes=[good_before, poison, good_after])

    titles = {n["title"] for n in (await pull(client, device))["notes"]}
    assert titles == {"before", "after"}
    assert result["server_seq"] > 0


async def test_every_table_shares_one_cursor(client, device):
    """Folders, notes, copa items and issues all stamp from the same sequence, so
    a single cursor orders changes across all four."""
    cursor = (await push(client, device, notes=[note()]))["server_seq"]

    await push(
        client,
        device,
        folders=[{"id": "f1", "name": "Project", "created_at": 1, "updated_at": 1}],
    )

    delta = await pull(client, device, since=cursor)
    assert delta["notes"] == []
    assert [f["name"] for f in delta["folders"]] == ["Project"]
