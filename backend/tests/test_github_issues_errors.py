"""GitHub error translation for the issues router.

Mirrors test_github_errors for sentry: a 403 from a valid-but-under-scoped
token should name the missing permission rather than reading as a bad token.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi import HTTPException

from app.routers.github_issues import _raise_for_upstream


def _resp(status_code: int, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(status_code, headers=headers or {}, request=httpx.Request("GET", "https://api.github.com/x"))


def test_success_passes_through():
    _raise_for_upstream(_resp(200))


def test_under_scoped_token_names_the_missing_permission():
    with pytest.raises(HTTPException) as exc:
        _raise_for_upstream(_resp(403, {"x-accepted-github-permissions": "issues=write"}))
    assert exc.value.status_code == 502
    assert "issues=write" in exc.value.detail


def test_rejection_without_the_header_keeps_the_plain_message():
    with pytest.raises(HTTPException) as exc:
        _raise_for_upstream(_resp(401))
    assert exc.value.detail == "GitHub rejected the server token"


def test_unknown_repo_404_passes_through():
    with pytest.raises(HTTPException) as exc:
        _raise_for_upstream(_resp(404))
    assert exc.value.status_code == 404
