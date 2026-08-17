"""When a no-fix run may report the issue as dismissed.

The autofix workflow closes a Sentry issue it proposed no fix for, but only when
the fix is already on `main` *and* the error hasn't fired since that code
deployed. The app's chip has to tell that apart from a plain "proposed nothing",
and it does so by asking Sentry whether the issue is actually resolved.

The direction that matters is one-way. Reporting a dismissal that didn't happen
tells someone an error is handled while it is still arriving — the exact failure
W-NOTES-FASTAPI-A is: `4ee6168` is the fix, and its 404 is still reported on
every publish because the cause is a service outside this repo. So every way
this lookup can fail must answer False.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi import HTTPException

from app.routers import sentry as sentry_router
from app.routers.sentry import _issue_is_resolved


class _FakeSentry:
    def __init__(self, response: httpx.Response | Exception):
        self._response = response

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url: str) -> httpx.Response:
        if isinstance(self._response, Exception):
            raise self._response
        return self._response


def _issue(status: str) -> httpx.Response:
    request = httpx.Request("GET", "https://sentry.io/api/0/issues/1/")
    return httpx.Response(200, json={"id": "1", "status": status}, request=request)


@pytest.fixture
def sentry_returns(monkeypatch):
    """Point the router at a canned Sentry, with a credential that resolves."""

    def _install(response):
        async def _token(session, user_id, provider):
            return "sentry-token"

        monkeypatch.setattr(sentry_router, "require_user_token", _token)
        monkeypatch.setattr(sentry_router, "_client", lambda token: _FakeSentry(response))

    return _install


async def test_a_resolved_issue_reports_dismissed(sentry_returns):
    sentry_returns(_issue("resolved"))
    assert await _issue_is_resolved(None, _user(), "1") is True


async def test_an_unresolved_issue_does_not(sentry_returns):
    """The W-NOTES-FASTAPI-A shape: the run proposed nothing and the issue is
    still open, because it is still happening."""
    sentry_returns(_issue("unresolved"))
    assert await _issue_is_resolved(None, _user(), "1") is False


async def test_an_ignored_issue_is_not_a_dismissal(sentry_returns):
    """Sentry has more statuses than two. Only `resolved` means "finished with"."""
    sentry_returns(_issue("ignored"))
    assert await _issue_is_resolved(None, _user(), "1") is False


async def test_an_upstream_error_does_not_claim_a_dismissal(sentry_returns):
    """The body carries `status: resolved` on purpose. A failed response is not
    an issue payload — Sentry's 4xx bodies have their own shape, and a proxy or
    error page can say anything — so the status code has to be checked before
    the body is read, not merely relied on to be unparseable."""
    request = httpx.Request("GET", "https://sentry.io/api/0/issues/1/")
    sentry_returns(httpx.Response(404, json={"status": "resolved"}, request=request))
    assert await _issue_is_resolved(None, _user(), "1") is False


async def test_a_timeout_does_not_claim_a_dismissal(sentry_returns):
    """`_guarded` turns this into a 504. A status poll must survive it — the chip
    losing its wording is a cosmetic loss, a false dismissal is not."""
    sentry_returns(httpx.TimeoutException("slow"))
    assert await _issue_is_resolved(None, _user(), "1") is False


async def test_a_missing_credential_does_not_claim_a_dismissal(monkeypatch):
    async def _no_token(session, user_id, provider):
        raise HTTPException(503, "Add a Sentry token")

    monkeypatch.setattr(sentry_router, "require_user_token", _no_token)
    assert await _issue_is_resolved(None, _user(), "1") is False


def _user():
    class _U:
        id = "user-1"

    return _U()
