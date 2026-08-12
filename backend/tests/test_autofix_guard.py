"""Autofix repo-resolution guard.

The failure this protects against is quiet and expensive: a Sentry note watching
an unrelated project taps Fix, `repo` is absent, and the server falls back to its
own `autofix_repo`. An agent is then dispatched to fix a bug that lives in a
different codebase — and in a repo running autofix-ship, whatever it produces is
merged and deployed without anyone reading it. Review is not the backstop here,
so the routing has to be right at dispatch time.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.config import get_settings
from app.routers import sentry
from app.routers.sentry import _resolve_repo

AUTOFIX = "/sentry/autofix"

REPO = "owner/w_notes"
# Two Sentry projects, one repo — the backend and the RN client both report here.
OWN_PROJECTS = "w-notes-fastapi,w-notes-rn"


@pytest.fixture
def autofix_configured(monkeypatch):
    """Point the server at REPO, covering OWN_PROJECTS, with autofix enabled."""
    settings = get_settings()
    monkeypatch.setattr(settings, "sentry_api_token", "sentry-tok", raising=False)
    monkeypatch.setattr(settings, "github_token", "gh-tok", raising=False)
    monkeypatch.setattr(settings, "autofix_repo", REPO, raising=False)
    monkeypatch.setattr(settings, "autofix_projects", OWN_PROJECTS, raising=False)
    yield settings
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _past_the_owner_gate(monkeypatch):
    """Let these tests reach the repo guard.

    `/sentry/autofix` is owner-only now — the dispatch spends the operator's
    money and lands a commit in the operator's repo, so a stranger is refused
    before anything else happens (see `require_owner`). These tests authenticate
    as anonymous device users, who can never be owners, so without this every
    one of them would be turned away at the gate and stop proving anything about
    routing.

    Patched rather than seeded, for the same reason `test_resume.py` patches its
    gate: whether the gate opens is `test_ai_access.py`'s subject, and a test
    should fail for one reason. The *ordering* between the two guards is pinned
    there too, by `test_autofix_is_refused_before_any_upstream_call`.
    """
    monkeypatch.setattr(sentry, "require_owner", lambda user, action: get_settings())


def test_fallback_allowed_for_a_project_the_repo_holds(autofix_configured):
    assert _resolve_repo(None, "w-notes-fastapi") == REPO
    # The second project maps to the same repo — a single-project check would
    # have wrongly blocked every client-side fix.
    assert _resolve_repo(None, "w-notes-rn") == REPO


def test_fallback_refused_for_a_foreign_project(autofix_configured):
    with pytest.raises(HTTPException) as exc:
        _resolve_repo(None, "python-fastapi")
    assert exc.value.status_code == 422
    # The message has to name the project and the repo, or the person reading it
    # in the app has no idea which note is misconfigured.
    assert "python-fastapi" in exc.value.detail
    assert REPO in exc.value.detail


def test_explicit_repo_is_honoured_for_any_project(autofix_configured):
    """The guard constrains the *fallback*, not the feature. A note that names
    its own repo is doing exactly what multi-project autofix is for."""
    assert _resolve_repo("other/repo", "python-fastapi") == "other/repo"


def test_unconfigured_projects_leaves_the_fallback_open(monkeypatch):
    """With no project list the server can't tell own from foreign, so it behaves
    as it did before the guard existed rather than refusing everything."""
    settings = get_settings()
    monkeypatch.setattr(settings, "autofix_repo", REPO, raising=False)
    monkeypatch.setattr(settings, "autofix_projects", "", raising=False)
    try:
        assert _resolve_repo(None, "anything-at-all") == REPO
    finally:
        get_settings.cache_clear()


def test_read_only_callers_skip_the_check(autofix_configured):
    """`/autofix/status` resolves the same repo but only reads. Omitting the
    project must not start refusing status polls for foreign-project notes."""
    assert _resolve_repo(None) == REPO


async def test_dispatch_refused_before_any_upstream_call(
    client, device, autofix_configured, save_credential
):
    """End to end: the rejection lands before Sentry or GitHub is contacted.

    Nothing is stubbed here on purpose — if the guard were ordered after the
    context-gathering calls, this test would hang or error on a real network
    call instead of returning 422, which is exactly the regression to catch.

    The caller is given a Sentry credential first so the request actually
    reaches the repo guard. Without one the route now stops earlier, at the
    missing-credential 503 — safe, but it would test nothing about routing.
    """
    await save_credential(device, "sentry")
    resp = await client.post(
        AUTOFIX,
        headers=device,
        json={
            "issue_id": "7627623445",
            "org": "aiko-6q",
            "project": "python-fastapi",
        },
    )
    assert resp.status_code == 422
    assert "python-fastapi" in resp.json()["detail"]


async def test_dispatch_refused_without_a_sentry_credential(
    client, device, autofix_configured
):
    """No credential means no dispatch — and nothing upstream is contacted.

    Autofix gathers its context through the caller's own Sentry token, so an
    account that hasn't supplied one cannot start a run. Worth pinning
    separately: this is the ordering that keeps a credential-less caller from
    reaching any upstream call at all.
    """
    resp = await client.post(
        AUTOFIX,
        headers=device,
        json={"issue_id": "7627623445", "org": "aiko-6q", "project": "w-notes-fastapi"},
    )
    assert resp.status_code == 503
    assert "Settings" in resp.json()["detail"]
