"""``folders.color`` — the storage contract for a folder's accent colour.

'#rrggbb' is a colour; the literal string 'theme' (THEME_COLOR_TOKEN on the
client) is an explicit reset to the theme default; NULL means "never set, or
pushed by a client that predates the column". ``Folder`` is listed in
``_PRESERVE_IF_NULL`` (see ``app/routers/sync.py``) precisely so an ordinary
edit that doesn't know about colour — an old client, or this app's own push of
a field that happens to omit it — can never wipe a colour chosen elsewhere.
That's also why a reset has to be the string 'theme' rather than NULL: NULL
would be indistinguishable from "doesn't know", and would vanish on the very
next round trip.
"""

from __future__ import annotations

import uuid

from test_sync import pull, push


def folder(**overrides) -> dict:
    """A minimal valid folder row."""
    row = {
        "id": str(uuid.uuid4()),
        "name": "",
        "created_at": 1_000,
        "updated_at": 1_000,
    }
    row.update(overrides)
    return row


async def test_push_omitting_color_keeps_the_stored_colour(client, device):
    """The cross-version case: a push that carries no `color` key at all — an
    edit from a client that predates the column, or any push that simply
    doesn't touch colour — must not blank a colour set earlier."""
    row = folder(color="#ff0000", updated_at=1_000)
    await push(client, device, folders=[row])

    # A later edit of the same folder (a rename), with no `color` key present
    # in the payload — exactly what an old client would send.
    await push(
        client,
        device,
        folders=[
            {
                "id": row["id"],
                "name": "renamed",
                "created_at": 1_000,
                "updated_at": 2_000,
            }
        ],
    )

    pulled = (await pull(client, device))["folders"][0]
    assert pulled["name"] == "renamed", "the edit itself must still land"
    assert pulled["color"] == "#ff0000"


async def test_push_of_theme_replaces_the_stored_colour(client, device):
    """An explicit reset. 'theme' is a real, non-NULL value, so the ordinary
    last-writer-wins upsert overwrites the stored colour with it — no
    COALESCE guard applies to a non-NULL incoming value."""
    row = folder(color="#00ff00", updated_at=1_000)
    await push(client, device, folders=[row])

    await push(
        client,
        device,
        folders=[{**row, "color": "theme", "updated_at": 2_000}],
    )

    pulled = (await pull(client, device))["folders"][0]
    assert pulled["color"] == "theme"


async def test_a_later_push_with_no_colour_keeps_theme(client, device):
    """The reset must itself survive a subsequent NULL-color push exactly the
    way a hex colour would — 'theme' is preserved by the same COALESCE guard,
    not merely written once and left alone."""
    row = folder(color="#00ff00", updated_at=1_000)
    await push(client, device, folders=[row])
    await push(
        client,
        device,
        folders=[{**row, "color": "theme", "updated_at": 2_000}],
    )

    await push(
        client,
        device,
        folders=[
            {
                "id": row["id"],
                "name": "touched again",
                "created_at": 1_000,
                "updated_at": 3_000,
            }
        ],
    )

    pulled = (await pull(client, device))["folders"][0]
    assert pulled["name"] == "touched again"
    assert pulled["color"] == "theme"
