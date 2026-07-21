"""Publish-to-portfolio tests.

The delivery half is plain HTTP and is not exercised here; what these cover is
the half that decides *what* gets published, where the failure modes are silent
and public: publishing a note nobody asked to publish, publishing a stale body
that last-writer-wins rejected, or letting an account publish onto someone
else's website.
"""

from __future__ import annotations

import uuid

import pytest

from app.config import get_settings
from app.publisher import collect_publish_actions, strip_html_wrapper
from app.db import SessionLocal
from app.models import User
from sqlalchemy import select

from tests.test_sync import note, push

PUSH = "/sync/push"


@pytest.fixture
def publishing(monkeypatch):
    """Enable publishing for whichever user id the test passes to `authorize`."""
    def authorize(user_id: str) -> None:
        settings = get_settings()
        monkeypatch.setattr(settings, "portfolio_api_base", "https://portfolio.test", raising=False)
        monkeypatch.setattr(settings, "portfolio_ingest_secret", "s3cret", raising=False)
        monkeypatch.setattr(settings, "publisher_user_ids", user_id, raising=False)
    yield authorize
    get_settings.cache_clear()


async def _user_id(device: dict[str, str]) -> str:
    """The user id minted for a device key by its first authenticated request."""
    token = device["Authorization"].removeprefix("Bearer ")
    async with SessionLocal() as session:
        user = (
            await session.execute(select(User).where(User.device_key == token))
        ).scalar_one()
        return user.id


async def _actions(user_id: str, note_ids: list[str]):
    async with SessionLocal() as session:
        return await collect_publish_actions(session, user_id, note_ids)


# ---- body shaping -----------------------------------------------------------


def test_strip_html_wrapper_unwraps_stored_bodies():
    assert strip_html_wrapper("<html><p>hi</p></html>") == "<p>hi</p>"


def test_strip_html_wrapper_passes_through_fragments():
    # Notes written before the rich editor were never wrapped.
    assert strip_html_wrapper("<p>plain</p>") == "<p>plain</p>"
    assert strip_html_wrapper("") == ""


# ---- what gets published ----------------------------------------------------


async def test_published_note_produces_a_publish_action(client, device, publishing):
    row = note(title="Hello", body="<html><p>world</p></html>", published=True)
    await push(client, device, notes=[row])
    publishing(await _user_id(device))

    actions = await _actions(await _user_id(device), [row["id"]])

    assert len(actions) == 1
    assert actions[0].present is True
    assert actions[0].payload["title"] == "Hello"
    # The wrapper is a storage artifact and must not reach the website.
    assert actions[0].payload["body_html"] == "<p>world</p>"


async def test_unpublished_note_produces_a_removal(client, device, publishing):
    row = note(published=False)
    await push(client, device, notes=[row])
    publishing(await _user_id(device))

    actions = await _actions(await _user_id(device), [row["id"]])

    assert [a.present for a in actions] == [False]


async def test_trashed_note_comes_off_the_site_even_while_flagged(
    client, device, publishing
):
    """Deleting a published note must unpublish it. The flag stays set — the
    note is only in the trash — so `published` alone is not enough."""
    row = note(published=True, updated_at=1_000)
    await push(client, device, notes=[row])
    await push(
        client, device, notes=[note(id=row["id"], published=True, updated_at=2_000, deleted_at=2_000)]
    )
    publishing(await _user_id(device))

    actions = await _actions(await _user_id(device), [row["id"]])

    assert [a.present for a in actions] == [False]


async def test_stale_push_does_not_publish_its_body(client, device, publishing):
    """A push the server rejects as older must not reach the website. Publishing
    the incoming payload rather than the stored row would put text on a public
    page that no device actually holds."""
    row = note(published=True, body="<html><p>current</p></html>", updated_at=5_000)
    await push(client, device, notes=[row])
    # Same note, older clock: last-writer-wins drops it.
    await push(
        client,
        device,
        notes=[note(id=row["id"], published=True, body="<html><p>stale</p></html>", updated_at=1_000)],
    )
    publishing(await _user_id(device))

    actions = await _actions(await _user_id(device), [row["id"]])

    assert actions[0].payload["body_html"] == "<p>current</p>"


async def test_edit_carries_the_notes_own_clock(client, device, publishing):
    """The portfolio sorts its feed on this value — it is what floats an edited
    note back to the top."""
    row = note(published=True, updated_at=9_999)
    await push(client, device, notes=[row])
    publishing(await _user_id(device))

    actions = await _actions(await _user_id(device), [row["id"]])

    assert actions[0].payload["updated_at_ms"] == 9_999


# ---- authorization ----------------------------------------------------------


async def test_unauthorized_user_publishes_nothing(client, device, publishing):
    """This API is multi-tenant and the portfolio is one person's website. An
    account outside the allowlist must not be able to put anything on it."""
    row = note(published=True)
    await push(client, device, notes=[row])
    publishing(str(uuid.uuid4()))  # somebody else entirely

    assert await _actions(await _user_id(device), [row["id"]]) == []


async def test_publishing_is_off_until_configured(client, device):
    """Fail closed: with no destination or credential configured, a `published`
    note still produces no actions."""
    row = note(published=True)
    await push(client, device, notes=[row])

    assert await _actions(await _user_id(device), [row["id"]]) == []
