"""GitHub error translation.

`_raise_for_github` is the last thing standing between a GitHub refusal and
whoever has to work out why autofix stopped. A 403 has two very different
causes — a bad token, and a valid token missing one permission — and the
original message described only the first, which sends you inspecting a token
that turns out to be fine.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi import HTTPException

from app.routers.sentry import _raise_for_github


def _resp(status_code: int, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(status_code, headers=headers or {}, request=httpx.Request("GET", "https://api.github.com/x"))


def test_success_passes_through():
    _raise_for_github(_resp(200))  # no raise


def test_under_scoped_token_names_the_missing_permission():
    """The real case: the token is valid, one grant is missing, and GitHub says
    which in a header nobody was reading."""
    with pytest.raises(HTTPException) as exc:
        _raise_for_github(_resp(403, {"x-accepted-github-permissions": "contents=write"}))
    assert exc.value.status_code == 502
    assert "contents=write" in exc.value.detail


def test_rejection_without_the_header_keeps_the_plain_message():
    """Not every 401/403 carries the header — an actually-invalid token doesn't.
    The message must stay clean rather than trailing an empty parenthetical."""
    with pytest.raises(HTTPException) as exc:
        _raise_for_github(_resp(401))
    assert exc.value.status_code == 502
    assert exc.value.detail == "GitHub rejected the server token"


def test_other_errors_are_unchanged():
    with pytest.raises(HTTPException) as exc:
        _raise_for_github(_resp(404))
    assert exc.value.status_code == 404

    # 5xx from GitHub is our 502 — their outage is not the client's fault.
    with pytest.raises(HTTPException) as exc:
        _raise_for_github(_resp(503))
    assert exc.value.status_code == 502
