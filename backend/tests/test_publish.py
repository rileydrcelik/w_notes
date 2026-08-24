"""Publish-to-portfolio tests.

Most of these cover the half that decides *what* gets published, where the
failure modes are silent and public: publishing a note nobody asked to publish,
publishing a stale body that last-writer-wins rejected, or letting an account
publish onto someone else's website.

The delivery half is plain HTTP, so only its one piece of real judgement is
exercised here: which upstream statuses count as failures. See the delivery
section at the bottom.
"""

from __future__ import annotations

import httpx
import pytest

from app import publisher
from app.config import get_settings
from app.publisher import PublishAction, collect_publish_actions, deliver, strip_html_wrapper
from app.db import SessionLocal
from app.models import User
from sqlalchemy import select

from tests.test_sync import note, push

PUSH = "/sync/push"


PUBLISHER = "owner@example.com"


@pytest.fixture
def publishing(monkeypatch):
    """Enable publishing for whichever email the test passes to `authorize`."""
    def authorize(email: str) -> None:
        settings = get_settings()
        monkeypatch.setattr(settings, "portfolio_api_base", "https://portfolio.test", raising=False)
        monkeypatch.setattr(settings, "portfolio_ingest_secret", "s3cret", raising=False)
        monkeypatch.setattr(settings, "publisher_emails", email, raising=False)
    yield authorize
    get_settings.cache_clear()


async def _user(device: dict[str, str], email: str | None = PUBLISHER) -> User:
    """The user minted for a device key by its first authenticated request.

    The suite authenticates with anonymous device keys, which carry no email —
    that is what a pre-sign-in account looks like. Tests that expect to publish
    set one explicitly, standing in for Firebase having populated it on sign-in.
    """
    token = device["Authorization"].removeprefix("Bearer ")
    async with SessionLocal() as session:
        user = (
            await session.execute(select(User).where(User.device_key == token))
        ).scalar_one()
        if email is not None:
            user.email = email
            await session.commit()
        await session.refresh(user)
        session.expunge(user)
        return user


async def _actions(user: User, note_ids: list[str]):
    async with SessionLocal() as session:
        return await collect_publish_actions(session, user, note_ids)


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
    publishing(PUBLISHER)

    actions = await _actions(await _user(device), [row["id"]])

    assert len(actions) == 1
    assert actions[0].present is True
    assert actions[0].payload["title"] == "Hello"
    # The wrapper is a storage artifact and must not reach the website.
    assert actions[0].payload["body_html"] == "<p>world</p>"


async def test_editing_a_note_updates_it_rather_than_removing_it(client, device, publishing):
    """A regression guard, and the bug it guards against was live.

    Presence used to also require the `published` flag. Once the website took
    over placement that flag became vestigial and always false, so every edit
    resolved to "should not be present" and deleted the embedded post — editing
    a note silently removed it from the site.

    Whether a note is embedded is the portfolio's business; this side always
    sends the update and lets it match nothing.
    """
    row = note(title="still here", published=False)
    await push(client, device, notes=[row])
    publishing(PUBLISHER)

    actions = await _actions(await _user(device), [row["id"]])

    assert [a.present for a in actions] == [True]
    assert actions[0].payload["title"] == "still here"


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
    publishing(PUBLISHER)

    actions = await _actions(await _user(device), [row["id"]])

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
    publishing(PUBLISHER)

    actions = await _actions(await _user(device), [row["id"]])

    assert actions[0].payload["body_html"] == "<p>current</p>"


async def test_edit_carries_the_notes_own_clock(client, device, publishing):
    """The portfolio sorts its feed on this value — it is what floats an edited
    note back to the top."""
    row = note(published=True, updated_at=9_999)
    await push(client, device, notes=[row])
    publishing(PUBLISHER)

    actions = await _actions(await _user(device), [row["id"]])

    assert actions[0].payload["updated_at_ms"] == 9_999


# ---- authorization ----------------------------------------------------------


async def test_unauthorized_user_publishes_nothing(client, device, publishing):
    """This API is multi-tenant and the portfolio is one person's website. An
    account outside the allowlist must not be able to put anything on it."""
    row = note(published=True)
    await push(client, device, notes=[row])
    publishing("someone.else@example.com")

    assert await _actions(await _user(device), [row["id"]]) == []


async def test_anonymous_account_cannot_publish(client, device, publishing):
    """A device-key account that has never signed in has no email, so it can
    never match the allowlist. Publishing requires a named account."""
    row = note(published=True)
    await push(client, device, notes=[row])
    publishing(PUBLISHER)

    # email=None: the pre-sign-in state, before Firebase populates it.
    assert await _actions(await _user(device, email=None), [row["id"]]) == []


async def test_allowlist_match_is_case_insensitive(client, device, publishing):
    """A capitalised letter in the env var silently disabling publishing would
    be a miserable thing to debug, and no real provider treats the local part
    as case-sensitive."""
    row = note(published=True)
    await push(client, device, notes=[row])
    publishing("Owner@Example.COM")

    actions = await _actions(await _user(device, email=PUBLISHER), [row["id"]])
    assert [a.present for a in actions] == [True]


async def test_publishing_is_off_until_configured(client, device):
    """Fail closed: with no destination or credential configured, a `published`
    note still produces no actions."""
    row = note(published=True)
    await push(client, device, notes=[row])

    assert await _actions(await _user(device), [row["id"]]) == []


# ---- delivery: which upstream statuses count as failures ---------------------


class _FakeClient:
    """Stands in for httpx.AsyncClient, returning one canned response."""

    def __init__(self, response: httpx.Response, calls: list[str]):
        self._response = response
        self._calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None):
        self._calls.append("POST")
        return self._response

    async def delete(self, url):
        self._calls.append("DELETE")
        return self._response


@pytest.fixture
def delivery(monkeypatch, publishing):
    """Run `deliver` against a canned upstream response, capturing Sentry reports.

    Returns a coroutine taking (action, status, body) and returning the list of
    exceptions `deliver` reported. `body` matters on a 404: the portfolio's own
    reason for one is what separates "this note isn't embedded" from "the
    endpoint is gone", so a test that only sets a status cannot tell them apart.
    """
    publishing(PUBLISHER)
    reported: list[Exception] = []
    monkeypatch.setattr(
        publisher.sentry_sdk, "capture_exception", lambda exc: reported.append(exc)
    )

    async def run(
        action: PublishAction, status: int, body: object = NOT_EMBEDDED
    ) -> list[Exception]:
        request = httpx.Request("POST", "https://portfolio.test/ingest")
        if isinstance(body, (bytes, str)):
            response = httpx.Response(status, request=request, content=body)
        else:
            response = httpx.Response(status, request=request, json=body)
        calls: list[str] = []
        monkeypatch.setattr(
            publisher.httpx,
            "AsyncClient",
            lambda **kw: _FakeClient(response, calls),
        )
        await deliver([action])
        return reported

    return run


# What the portfolio actually answers for a note nobody embedded -- verified
# against the live endpoint, not assumed. The bare {"detail": "Not Found"} below
# is what an unrouted path returns instead, and the whole point of the
# distinction is that these two arrive with the same status code.
NOT_EMBEDDED = {"detail": "Note is not embedded anywhere"}
ROUTE_MISSING = {"detail": "Not Found"}


_UPSERT = PublishAction(note_id="n1", present=True, payload={"title": "t"})
_DELETE = PublishAction(note_id="n1", present=False)


async def test_delete_treats_not_embedded_404_as_success(delivery):
    """Most notes are not embedded anywhere, so a delete 404s routinely.
    Reporting those would bury real errors in noise."""
    assert await delivery(_DELETE, 404, NOT_EMBEDDED) == []


async def test_upsert_treats_not_embedded_404_as_success(delivery):
    """The upsert case, which used to be reported and should not be.

    This pushes every edit without knowing which notes are embedded, so a 404
    saying the note was never placed is the *ordinary* answer for most notes,
    not a failure. Reporting it produced 838 Sentry events in a month against a
    perfectly healthy endpoint, and buried the errors that did matter.
    """
    assert await delivery(_UPSERT, 404, NOT_EMBEDDED) == []


async def test_upsert_reports_404_from_a_missing_route(delivery):
    """The silent failure the old rule existed to catch, kept catchable.

    If the endpoint is removed, renamed or misrouted, every publish stops and
    nothing else says so. It 404s exactly like a note that isn't embedded, and
    only the body tells them apart: an unrouted path never reaches the handler,
    so it carries Starlette's bare {"detail": "Not Found"}.
    """
    reported = await delivery(_UPSERT, 404, ROUTE_MISSING)

    assert len(reported) == 1
    assert isinstance(reported[0], httpx.HTTPStatusError)


async def test_delete_reports_404_from_a_missing_route(delivery):
    """Deletes get the same discrimination, and always should have.

    The old rule skipped *every* delete 404, so an endpoint that vanished took
    every unpublish down with it silently -- the same hole that was closed for
    upserts, still open here.
    """
    reported = await delivery(_DELETE, 404, ROUTE_MISSING)

    assert len(reported) == 1


async def test_reports_404_that_is_not_json(delivery):
    """A proxy or a wrong host answers 404 with HTML, never reaching the app.

    That is the "everything is failing" case wearing a different disguise, so
    unparseable must not be read as ordinary.
    """
    reported = await delivery(_UPSERT, 404, b"<html><body>404 Not Found</body></html>")

    assert len(reported) == 1


async def test_upsert_reports_server_errors(delivery):
    reported = await delivery(_UPSERT, 500)

    assert len(reported) == 1
    assert isinstance(reported[0], httpx.HTTPStatusError)


async def test_delete_still_reports_non_404_failures(delivery):
    """Narrowing the 404 skip must not make deletes swallow everything else."""
    reported = await delivery(_DELETE, 500)

    assert len(reported) == 1


async def test_success_reports_nothing(delivery):
    assert await delivery(_UPSERT, 200) == []
