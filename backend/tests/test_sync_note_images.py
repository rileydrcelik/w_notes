"""``note_images`` — the row that says where an embedded image's bytes are.

A note body carries a reference (``<img src="wn-img:{id}">``) and this table
carries the pointer to the bytes. The dangerous column is ``remote_key``: it is
stamped once, asynchronously, by whichever device finished the upload, so a peer
that hasn't pulled that stamp yet genuinely holds NULL. Plain last-writer-wins
would let that peer's next ordinary push erase the only pointer to the bytes on
every device — the image is then unreachable and the object is orphaned in S3
with nothing pointing at it. ``NoteImage`` is in ``_PRESERVE_IF_NULL`` (see
``app/routers/sync.py``) for exactly that reason.

The other half tested here is authorization: ``/files/download-url`` used to
presign a GET only for keys backed by a ``copa_items`` row, so every device that
did *not* upload a note image would have been refused its own picture.
"""

from __future__ import annotations

import uuid

from test_sync import pull, push


def image(**overrides) -> dict:
    """A minimal valid note-image row."""
    row = {
        "id": str(uuid.uuid4()),
        "created_at": 1_000,
        "updated_at": 1_000,
    }
    row.update(overrides)
    return row


async def test_pushed_image_comes_back_on_pull(client, device):
    row = image(mime_type="image/png", file_size=2048, width=1170, height=640)

    await push(client, device, note_images=[row])
    pulled = await pull(client, device)

    assert [i["id"] for i in pulled["note_images"]] == [row["id"]]
    got = pulled["note_images"][0]
    assert got["mime_type"] == "image/png"
    assert (got["width"], got["height"]) == (1170, 640)


async def test_push_omitting_remote_key_keeps_the_stored_key(client, device):
    """The one that strands an image. Device A uploads and stamps the key;
    device B, which hasn't pulled that yet, pushes the row it holds — with no
    key. That must not wipe A's."""
    row = image(remote_key="note-images/abc", updated_at=1_000)
    await push(client, device, note_images=[row])

    await push(
        client,
        device,
        note_images=[
            {
                "id": row["id"],
                "created_at": 1_000,
                "updated_at": 2_000,
                "width": 800,
            }
        ],
    )

    pulled = (await pull(client, device))["note_images"][0]
    assert pulled["width"] == 800, "the edit itself must still land"
    assert pulled["remote_key"] == "note-images/abc"


async def test_image_rows_are_per_user(client, device, other_device):
    row = image(remote_key="note-images/abc")
    await push(client, device, note_images=[row])

    assert (await pull(client, other_device))["note_images"] == []


async def test_tombstone_propagates(client, device):
    row = image(remote_key="note-images/abc")
    await push(client, device, note_images=[row])

    await push(
        client,
        device,
        note_images=[{**row, "updated_at": 2_000, "deleted_at": 2_000}],
    )

    pulled = (await pull(client, device))["note_images"][0]
    assert pulled["deleted_at"] == 2_000
    # The key survives the tombstone: the purge job needs it to find the object,
    # and a device mid-download still has to be able to presign a GET.
    assert pulled["remote_key"] == "note-images/abc"


async def test_download_url_accepts_a_note_image_key(client, device, monkeypatch):
    """Authorization used to be copa-only: without this branch every device that
    didn't upload the image is refused its own picture with a 403."""
    import app.routers.files as files

    monkeypatch.setattr(files, "is_configured", lambda: True)
    monkeypatch.setattr(files, "presign_get", lambda key: f"https://s3.test/{key}")

    await push(client, device, note_images=[image(remote_key="note-images/abc")])

    response = await client.post(
        "/files/download-url", json={"key": "note-images/abc"}, headers=device
    )
    assert response.status_code == 200, response.text
    assert response.json()["url"] == "https://s3.test/note-images/abc"


async def test_download_url_still_refuses_another_users_key(
    client, device, other_device, monkeypatch
):
    import app.routers.files as files

    monkeypatch.setattr(files, "is_configured", lambda: True)
    monkeypatch.setattr(files, "presign_get", lambda key: f"https://s3.test/{key}")

    await push(client, device, note_images=[image(remote_key="note-images/abc")])

    response = await client.post(
        "/files/download-url", json={"key": "note-images/abc"}, headers=other_device
    )
    assert response.status_code == 403


async def test_upload_url_uses_a_separate_prefix_for_note_images(
    client, device, monkeypatch
):
    """Copa attachments and note images live under different prefixes so a
    lifecycle rule or the purge can address one without the other. A prefix
    cannot be introduced retroactively — the objects are already named."""
    import app.routers.files as files

    monkeypatch.setattr(files, "is_configured", lambda: True)
    monkeypatch.setattr(files, "presign_put", lambda key, mime: f"https://s3.test/{key}")

    note_image = await client.post(
        "/files/upload-url", json={"kind": "note-image"}, headers=device
    )
    assert note_image.status_code == 200, note_image.text
    assert note_image.json()["key"].startswith("note-images/")

    # No kind at all is what a client predating note images sends.
    copa = await client.post("/files/upload-url", json={}, headers=device)
    assert copa.status_code == 200, copa.text
    assert copa.json()["key"].startswith("attachments/")

    unknown = await client.post(
        "/files/upload-url", json={"kind": "nonsense"}, headers=device
    )
    assert unknown.status_code == 400
