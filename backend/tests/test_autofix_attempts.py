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

The same bug has a mirror image, which the run-aware cases below cover. An
attempt whose agent decides no code change is warranted pushes no branch and
opens no PR, so on branches-and-PRs alone it looks like an attempt that never
happened: W-NOTES-FASTAPI-A re-dispatched attempt 2 on every press, reached the
same "already fixed on main" conclusion in ~40s, and left nothing behind — a
green run, no artifact, and a chip that span for two minutes before claiming the
pipeline was "still working". A finished run with nothing to show for it is a
spent attempt.
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


def _run(ref: str, status: str = "completed", conclusion: str | None = "success") -> dict:
    """A workflow run for one attempt. The branch is carried in `display_title`,
    which is what `run-name` in sentry-autofix.yml puts there."""
    return {
        "display_title": f"Sentry autofix {ref}",
        "status": status,
        "conclusion": conclusion,
        "html_url": f"https://github.com/{REPO}/actions/runs/1",
    }


class FakeGitHub:
    """Just the three endpoints the branch chooser calls."""

    def __init__(self, pulls: list[dict], branches: list[str], runs: list[dict] | None = None):
        self._pulls = pulls
        self._branches = branches
        self._runs = runs or []
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
        if url.endswith("/runs"):
            return httpx.Response(200, json={"workflow_runs": self._runs}, request=request)
        raise AssertionError(f"unexpected GitHub call: {url}")


async def target(
    pulls: list[dict], branches: list[str], runs: list[dict] | None = None
) -> str | None:
    plan = await _autofix_target_branch(FakeGitHub(pulls, branches, runs), REPO, BASE)
    return plan.branch


async def reason(
    pulls: list[dict], branches: list[str], runs: list[dict] | None = None
) -> str | None:
    plan = await _autofix_target_branch(FakeGitHub(pulls, branches, runs), REPO, BASE)
    return plan.reason


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


# ---- runs: the attempt that produced nothing ---------------------------------


async def test_finished_run_with_no_branch_is_a_spent_attempt():
    """The W-NOTES-FASTAPI-A case: the agent concluded the code was already
    correct, so attempt 1 has a completed run but no branch and no PR. Without
    consulting runs this is indistinguishable from a clean slate, and every press
    re-ran the same attempt for the same verdict."""
    assert await target([], [], [_run(BASE)]) == f"{BASE}-2"


async def test_a_failed_run_is_spent_too():
    """A run that broke also pushed nothing. It gets a fresh attempt rather than
    pinning the issue to a branch that will never carry a commit."""
    assert await target([], [], [_run(BASE, conclusion="failure")]) == f"{BASE}-2"


async def test_a_live_run_blocks():
    """Dispatched but too early to have pushed. A second dispatch lands in the
    same concurrency group and cancels this one mid-fix."""
    assert await target([], [], [_run(BASE, status="in_progress", conclusion=None)]) is None
    assert "Already running" == await reason([], [], [_run(BASE, status="queued", conclusion=None)])


async def test_runs_for_other_issues_are_ignored():
    """`display_title` is matched against this issue's family, not merely parsed."""
    other = _run("autofixes/issue-w-notes-rn-e")
    assert await target([], [], [other]) == BASE


async def test_a_run_whose_title_carries_no_branch_is_ignored():
    """Runs from before `run-name` was set say only the event type. They must not
    be read as an attempt, or the first press after deploy would skip a branch."""
    assert await target([], [], [{"display_title": "sentry-autofix", "status": "completed"}]) == BASE


async def test_runs_are_not_fetched_when_a_branch_already_answers():
    """The runs list is a third API call on a path polled every 5s. It's only
    needed to tell "never started" from "finished empty-handed", so an attempt
    with a pushed branch must not pay for it."""
    gh = FakeGitHub([], [BASE], [_run(BASE)])
    assert (await _autofix_target_branch(gh, REPO, BASE)).branch is None
    assert not any(url.endswith("/runs") for url in gh.calls)


async def test_runs_are_fetched_once_across_several_spent_attempts():
    pulls = [_pr(4, BASE, state="closed")]
    gh = FakeGitHub(pulls, [BASE], [_run(f"{BASE}-2"), _run(f"{BASE}-3")])
    assert (await _autofix_target_branch(gh, REPO, BASE)).branch == f"{BASE}-4"
    assert len([url for url in gh.calls if url.endswith("/runs")]) == 1


async def test_missing_runs_endpoint_degrades_to_the_old_behaviour():
    """Autofix can target a repo without the workflow, and the server token may
    lack `actions:read`. Neither may break the dispatch."""

    class NoRuns(FakeGitHub):
        async def get(self, url: str, params=None) -> httpx.Response:
            if url.endswith("/runs"):
                self.calls.append(url)
                request = httpx.Request("GET", f"https://api.github.com{url}")
                return httpx.Response(404, json={"message": "Not Found"}, request=request)
            return await super().get(url, params)

    plan = await _autofix_target_branch(NoRuns([], []), REPO, BASE)
    assert plan.branch == BASE


# ---- refusals explain themselves --------------------------------------------


async def test_every_refusal_carries_a_reason():
    """`dispatched: false` with no reason is what let the app show a spinner for a
    run it never started."""
    assert await reason([_pr(4, BASE, state="open")], [BASE])
    assert await reason([], [BASE])
    assert await reason([], [], [_run(BASE, status="in_progress", conclusion=None)])


async def test_exhausted_attempts_say_so():
    pulls = [_pr(i, _attempt_branch_name(i), state="closed") for i in range(1, 11)]
    branches = [_attempt_branch_name(i) for i in range(1, 11)]
    plan = await _autofix_target_branch(FakeGitHub(pulls, branches), REPO, BASE)
    assert plan.branch is None
    assert "needs a person" in (plan.reason or "")


def _attempt_branch_name(n: int) -> str:
    return BASE if n == 1 else f"{BASE}-{n}"


async def test_a_dispatch_carries_no_reason():
    plan = await _autofix_target_branch(FakeGitHub([], []), REPO, BASE)
    assert plan.branch == BASE
    assert plan.reason is None


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
