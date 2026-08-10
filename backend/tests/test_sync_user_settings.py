"""Delta-sync contract tests for the `user_settings` table.

This table moved the theme preference from the client's device-local `settings`
KV store to an account-scoped, synced one, so it's worth pinning the same
guarantees the other synced tables get (see test_sync_finance.py's docstring for
why a new synced table fails silently when a wiring spot is missed) plus the
failure class this migration specifically had to avoid:

  * a preference-only push must still advance `server_seq` — a table that never
    stamps a row leaves a client's cursor sitting still while every other table
    moves, which reads as an idle sync until you push *only* a preference and
    the client re-downloads nothing changed;
  * last-writer-wins is exactly as important here as for a note body: a stale
    device pushing an old theme choice must not clobber a value stored later.
"""

from __future__ import annotations

import uuid

PUSH = "/sync/push"
PULL = "/sync/pull"


def setting(**overrides) -> dict:
    """A minimal valid user_settings row. `id` is the preference name."""
    row = {
        "id": "themeKey",
        "value": "midnight",
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


async def test_pushed_preference_comes_back_on_pull(client, device):
    row = setting(id="themeKey", value="solarized")

    await push(client, device, user_settings=[row])
    pulled = await pull(client, device)

    assert [s["id"] for s in pulled["user_settings"]] == [row["id"]]
    assert pulled["user_settings"][0]["value"] == "solarized"


async def test_a_preference_only_push_still_advances_the_cursor(client, device):
    """The seq-gap failure class: a push touching only user_settings has to move
    server_seq, or a client that pulls with the resulting cursor never sees it."""
    cursor = (await pull(client, device))["server_seq"]

    result = await push(client, device, user_settings=[setting()])

    assert result["server_seq"] > cursor
    delta = await pull(client, device, since=cursor)
    assert len(delta["user_settings"]) == 1
    assert delta["server_seq"] > cursor


async def test_pull_returns_only_settings_newer_than_the_cursor(client, device):
    first = setting(id="themeKey", value="midnight")
    second = setting(id="otherPref", value="anything")

    cursor = (await push(client, device, user_settings=[first]))["server_seq"]
    await push(client, device, user_settings=[second])

    delta = await pull(client, device, since=cursor)

    assert [s["id"] for s in delta["user_settings"]] == [second["id"]]


async def test_newer_edit_wins_and_an_older_one_is_ignored(client, device):
    """Last-writer-wins on `updated_at`: a stale device pushing an old theme
    choice must not overwrite a value a later write already stored."""
    row = setting(value="midnight", updated_at=2_000)
    await push(client, device, user_settings=[row])

    # A stale push (older updated_at) arrives after the fact — must be ignored.
    await push(client, device, user_settings=[{**row, "value": "dark", "updated_at": 1_000}])

    pulled = (await pull(client, device))["user_settings"]
    assert pulled[0]["value"] == "midnight"


async def test_a_genuinely_newer_edit_does_overwrite(client, device):
    row = setting(value="midnight", updated_at=1_000)
    await push(client, device, user_settings=[row])

    await push(client, device, user_settings=[{**row, "value": "solarized", "updated_at": 2_000}])

    pulled = (await pull(client, device))["user_settings"]
    assert pulled[0]["value"] == "solarized"


async def test_settings_are_isolated_per_user(client, device, other_device):
    await push(client, device, user_settings=[setting()])

    assert (await pull(client, other_device))["user_settings"] == []


async def test_one_bad_setting_does_not_poison_the_batch(client, device):
    """Per-row savepoints, same guarantee as the other synced tables: a row the
    server can't store is skipped and reported, and the good rows in the same
    push still land."""
    good_before = setting(id="before")
    good_after = setting(id="after")
    poison = setting(id="poison\x00row")

    await push(client, device, user_settings=[good_before, poison, good_after])

    ids = {s["id"] for s in (await pull(client, device))["user_settings"]}
    assert ids == {"before", "after"}
