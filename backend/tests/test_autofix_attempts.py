"""Autofix re-attempt semantics.

The bug these lock down cost a real fix: `_autofix_in_flight` treated a PR in
*any* state as proof the work was already done, so once PR #4 on
`autofixes/issue-w-notes-rn-c` was closed, W-NOTES-RN-C could never be
dispatched again. Tapping Fix returned `dispatched: false` and the status poll
answered with that same closed PR for ever — the app showed "PR #4 closed" as
the outcome of a run that had never started.

The distinction that matters: an *open* PR (or a pushed branch with no PR yet)
is work in progress and must not be duplicated. A closed or merged PR is a spent
attempt, and a Sentry issue that is live again deserves a fresh one.
"""

from __future__ import annotations

import httpx
import pytest

from app.routers.sentry import (
    _attempt_of,
    _autofix_target_branch,
    _branch_for,
)

BASE = _branch_for("W-NOTES-RN-C")  # autofixes/issue-w-notes-rn-c
REPO = "owner/w_notes"


def _pr(number: int, ref: str, state: str = "open", merged: bool = False) -> dict:
    return {
        "number": number,
        "state": state,
        "merged_at": "2026-01-01T00:00:00Z" if merged else None,
        "html_url": f"https://github.com/{REPO}/pull/{number}",
        "title": f"Autofix #{number}",
        "head": {"ref": ref},
    }


class FakeGitHub:
    """Just the two endpoints the branch chooser calls."""

    def __init__(self, pulls: list[dict], branches: list[str]):
        self._pulls = pulls
        self._branches = branches
        self.calls: list[str] = []

    async def get(self, url: str, params=None) -> httpx.Response:
        self.calls.append(url)
        request = httpx.Request("GET", f"https://api.github.com{url}")
        if url.endswith("/pulls"):
            return httpx.Response(200, json=self._pulls, request=request)
        if "/git/matching-refs/heads/" in url:
            prefix = url.split("/git/matching-refs/heads/", 1)[1]
            refs = [
                {"ref": f"refs/heads/{b}"} for b in self._branches if b.startswith(prefix)
            ]
            return httpx.Response(200, json=refs, request=request)
        raise AssertionError(f"unexpected GitHub call: {url}")


async def target(pulls: list[dict], branches: list[str]) -> str | None:
    return await _autofix_target_branch(FakeGitHub(pulls, branches), REPO, BASE)


# ---- the regression ----------------------------------------------------------


async def test_closed_pr_does_not_block_a_new_attempt():
    """The W-NOTES-RN-C case exactly: PR #4 closed on the base branch."""
    assert await target([_pr(4, BASE, state="closed")], [BASE]) == f"{BASE}-2"


async def test_merged_pr_does_not_block_a_recurrence():
    """A merged fix that didn't hold is still a recurrence worth another run."""
    assert await target([_pr(7, BASE, state="closed", merged=True)], [BASE]) == f"{BASE}-2"


async def test_attempts_keep_climbing_past_spent_ones():
    pulls = [_pr(4, BASE, state="closed"), _pr(9, f"{BASE}-2", state="closed")]
    assert await target(pulls, [BASE, f"{BASE}-2"]) == f"{BASE}-3"


# ---- what must still be deduped ---------------------------------------------


async def test_open_pr_blocks():
    """The original point of the guard: don't bill a second agent run for work
    that's already sitting in review."""
    assert await target([_pr(4, BASE, state="open")], [BASE]) is None


async def test_open_pr_on_a_later_attempt_blocks():
    pulls = [_pr(4, BASE, state="closed"), _pr(11, f"{BASE}-2", state="open")]
    assert await target(pulls, [BASE, f"{BASE}-2"]) is None


async def test_pushed_branch_without_a_pr_blocks():
    """The agent is mid-run — it has pushed but the PR isn't up yet."""
    assert await target([], [BASE]) is None


async def test_clean_slate_uses_the_bare_base_branch():
    """First attempt keeps the historic name, so nothing else has to change."""
    assert await target([], []) == BASE


async def test_unrelated_branches_are_ignored():
    """A PR for a different issue must not be read as this issue's attempt —
    including one whose branch merely starts with the same characters."""
    pulls = [_pr(4, "autofixes/issue-w-notes-rn-cx", state="open")]
    assert await target(pulls, ["autofixes/issue-w-notes-rn-cx"]) == BASE


# ---- family membership -------------------------------------------------------


@pytest.mark.parametrize(
    "branch,expected",
    [
        (BASE, 1),
        (f"{BASE}-2", 2),
        (f"{BASE}-10", 10),
        (f"{BASE}x", None),
        ("autofixes/issue-something-else", None),
        (f"{BASE}-abc", None),
    ],
)
def test_attempt_of(branch, expected):
    assert _attempt_of(BASE, branch) == expected
