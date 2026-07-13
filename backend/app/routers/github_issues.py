"""GitHub Issues proxy endpoints — read and act on a repo's issues on the
client's behalf.

A "GitHub note" in the app carries a marker plus a small config naming which
``repo`` (``owner/name``) it watches; that travels to this router per-request.
The GitHub REST API token stays here on the server (loaded from config/SSM) and
is never shipped in the Expo bundle — the same token the Sentry autofix code
uses, so it must additionally carry **Issues: Read and write** to create, close,
reopen, or comment.

Issue data is fetched **live** — it deliberately does not flow through the
sync/SQLite pipeline, so there's no stale copy and nothing to echo back.

- ``GET  /github/repos``                       — repos the token can see (picker).
- ``GET  /github/issues``                      — a repo's issues (list).
- ``GET  /github/issues/{number}``             — one issue's detail (full body).
- ``GET  /github/issues/{number}/comments``    — an issue's comments.
- ``GET  /github/labels|assignees|milestones`` — options for the create form.
- ``POST /github/issues``                      — create an issue.
- ``PATCH /github/issues/{number}``            — close / reopen an issue.
- ``POST /github/issues/{number}/comments``    — add a comment.

Everything is gated by the same auth dependency as the rest of the API, and the
``repo`` is validated against ``_REPO_RE`` before it's interpolated into any API
path. Responses are trimmed to the fields the UI needs.
"""

from __future__ import annotations

import re

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.config import get_settings
from app.deps import get_current_user
from app.models import User

router = APIRouter(prefix="/github", tags=["github"])

# Upstream calls should fail fast rather than hang a request behind GitHub.
_TIMEOUT = httpx.Timeout(15.0)

# A GitHub "owner/name" slug. The repo is interpolated into API paths, so it's
# only accepted when it matches this shape — no path traversal, no query
# smuggling. Mirrors the client's REPO_RE and sentry.py's ``_REPO_RE``.
_REPO_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")


# ---- Trimmed response shapes (snake_case out; GitHub's camelCase in via alias) ----


class RepoSummary(BaseModel):
    """A repo the server token can see — enough to render a picker row and build
    a note's ``{repo}`` config from the selection."""

    model_config = ConfigDict(extra="ignore")

    full_name: str
    name: str = ""
    owner: str = ""
    private: bool = False
    # NB: GitHub's REST API is snake_case, so these fields match its keys directly
    # — no camelCase aliases (unlike the Sentry proxy, whose upstream is camelCase).
    open_issues_count: int | None = None
    description: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _flatten_owner(cls, data: object) -> object:
        """Lift GitHub's nested ``owner.login`` to a flat ``owner`` string."""
        if isinstance(data, dict):
            owner = data.get("owner")
            if isinstance(owner, dict):
                data["owner"] = owner.get("login") or ""
        return data


class RepoList(BaseModel):
    repos: list[RepoSummary]


class Label(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    # GitHub returns a 6-hex color without the leading '#'.
    color: str | None = None


class SimpleUser(BaseModel):
    model_config = ConfigDict(extra="ignore")

    login: str
    avatar_url: str | None = None


class Milestone(BaseModel):
    model_config = ConfigDict(extra="ignore")

    number: int
    title: str = ""
    state: str | None = None


class IssueSummary(BaseModel):
    """One issue, trimmed. GitHub's issues list also returns pull requests; those
    carry a ``pull_request`` key and are dropped before this model is built (see
    ``_is_pull_request``)."""

    model_config = ConfigDict(extra="ignore")

    number: int
    title: str = ""
    state: str | None = None
    state_reason: str | None = None
    body: str | None = None
    html_url: str | None = None
    # Flattened from the nested ``user`` object.
    author: str | None = None
    labels: list[Label] = []
    assignees: list[str] = []
    comments: int | None = None
    created_at: str | None = None
    updated_at: str | None = None
    milestone: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, data: object) -> object:
        """Flatten a few nested GitHub fields onto flat columns: the author's
        login, assignee logins, and the milestone title. Labels can arrive as
        strings or objects; keep only object labels (name + color)."""
        if isinstance(data, dict):
            user = data.get("user")
            if isinstance(user, dict):
                data["author"] = user.get("login")
            assignees = data.get("assignees")
            if isinstance(assignees, list):
                data["assignees"] = [
                    a.get("login") for a in assignees if isinstance(a, dict) and a.get("login")
                ]
            labels = data.get("labels")
            if isinstance(labels, list):
                data["labels"] = [ln for ln in labels if isinstance(ln, dict)]
            milestone = data.get("milestone")
            if isinstance(milestone, dict):
                data["milestone"] = milestone.get("title")
            elif not isinstance(milestone, str):
                data["milestone"] = None
        return data


class IssueList(BaseModel):
    issues: list[IssueSummary]
    # Page-number cursor for the next page (from GitHub's Link header), or null
    # when there's no further page. Pass it back as ?cursor= to page.
    next_cursor: str | None = None


class Comment(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    author: str | None = None
    body: str | None = None
    created_at: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _flatten_user(cls, data: object) -> object:
        if isinstance(data, dict):
            user = data.get("user")
            if isinstance(user, dict):
                data["author"] = user.get("login")
        return data


class CommentList(BaseModel):
    comments: list[Comment]


class LabelList(BaseModel):
    labels: list[Label]


class AssigneeList(BaseModel):
    assignees: list[SimpleUser]


class MilestoneList(BaseModel):
    milestones: list[Milestone]


# ---- Helpers ----


def _require_token() -> str:
    token = get_settings().github_token
    if not token:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "GitHub API is not configured"
        )
    return token


def _require_repo(repo: str) -> str:
    """Validate an ``owner/name`` before it's interpolated into an API path. A
    malformed value is rejected (422) rather than reaching GitHub."""
    if not _REPO_RE.match(repo):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid repo (expected owner/name)"
        )
    return repo


def _client() -> httpx.AsyncClient:
    settings = get_settings()
    return httpx.AsyncClient(
        base_url=settings.github_api_base.rstrip("/"),
        headers={
            "Authorization": f"Bearer {settings.github_token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=_TIMEOUT,
    )


def _raise_for_upstream(resp: httpx.Response) -> None:
    """Turn a non-2xx GitHub response into an HTTPException. A 401/403 means our
    server token is bad/under-scoped (e.g. missing Issues write) — that's a
    server misconfig, not the caller's fault, so it surfaces as 502 rather than
    leaking as the client's own auth failure. Other 4xx (e.g. an unknown repo →
    404) pass through."""
    if resp.is_success:
        return
    if resp.status_code in (401, 403):
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "GitHub rejected the server token"
        )
    code = resp.status_code if resp.status_code < 500 else status.HTTP_502_BAD_GATEWAY
    raise HTTPException(code, f"GitHub API error ({resp.status_code})")


def _next_page(resp: httpx.Response) -> int | None:
    """Extract the next-page number from GitHub's RFC 5988 Link header. GitHub
    emits a ``rel="next"`` link with a ``page=N`` query param only while more
    pages remain; return that number, or None at the end."""
    link = resp.headers.get("link")
    if not link:
        return None
    for part in link.split(","):
        if 'rel="next"' in part:
            match = re.search(r"[?&]page=(\d+)", part)
            if match:
                return int(match.group(1))
    return None


def _is_pull_request(item: dict) -> bool:
    """GitHub's issues list returns PRs too; they carry a ``pull_request`` key.
    Drop them so a "GitHub Issues" view shows only issues."""
    return isinstance(item, dict) and item.get("pull_request") is not None


# ---- Endpoints ----


@router.get("/repos", response_model=RepoList)
async def list_repos(
    user: User = Depends(get_current_user),
) -> RepoList:
    """Every repo the server token can see — the source for the in-app picker
    that configures a GitHub note. Pages through GitHub's Link header so an
    account with many repos isn't truncated, with a hard cap so a runaway
    paginator can't loop forever. Sorted by most-recently pushed."""
    _require_token()
    repos: list[RepoSummary] = []
    page = 1
    async with _client() as client:
        for _ in range(20):
            resp = await client.get(
                "/user/repos",
                params={"per_page": 100, "sort": "pushed", "page": page},
            )
            _raise_for_upstream(resp)
            repos.extend(RepoSummary.model_validate(r) for r in resp.json())
            nxt = _next_page(resp)
            if not nxt:
                break
            page = nxt
    return RepoList(repos=repos)


class IssueCount(BaseModel):
    count: int


@router.get("/issue-count", response_model=IssueCount)
async def issue_count(
    repo: str = Query(..., description="Target repo (owner/name)"),
    user: User = Depends(get_current_user),
) -> IssueCount:
    """Accurate count of OPEN ISSUES ONLY, excluding pull requests. The repo
    object's ``open_issues_count`` lumps issues and PRs together, so the picker
    can't use it for a true issue count. GitHub's search API reports the real
    total via ``total_count``. Search is rate-limited, so the picker calls this
    lazily per repo rather than folding it into the repo list."""
    _require_token()
    _require_repo(repo)
    async with _client() as client:
        resp = await client.get(
            "/search/issues",
            params={"q": f"repo:{repo} is:issue is:open", "per_page": 1},
        )
    _raise_for_upstream(resp)
    return IssueCount(count=int(resp.json().get("total_count", 0)))


@router.get("/issues", response_model=IssueList)
async def list_issues(
    repo: str = Query(..., description="Target repo (owner/name)"),
    state: str = Query("open", pattern="^(open|closed|all)$"),
    limit: int = Query(25, ge=1, le=100),
    cursor: str | None = Query(None, description="Opaque next-page cursor (page number)"),
    user: User = Depends(get_current_user),
) -> IssueList:
    _require_token()
    _require_repo(repo)
    params: dict[str, object] = {"state": state, "per_page": limit, "sort": "updated"}
    if cursor and cursor.isdigit():
        params["page"] = int(cursor)
    async with _client() as client:
        resp = await client.get(f"/repos/{repo}/issues", params=params)
    _raise_for_upstream(resp)
    items = [item for item in resp.json() if not _is_pull_request(item)]
    nxt = _next_page(resp)
    return IssueList(
        issues=[IssueSummary.model_validate(item) for item in items],
        next_cursor=str(nxt) if nxt else None,
    )


@router.get("/issues/{number}", response_model=IssueSummary)
async def get_issue(
    number: int,
    repo: str = Query(..., description="Target repo (owner/name)"),
    user: User = Depends(get_current_user),
) -> IssueSummary:
    _require_token()
    _require_repo(repo)
    async with _client() as client:
        resp = await client.get(f"/repos/{repo}/issues/{number}")
    _raise_for_upstream(resp)
    return IssueSummary.model_validate(resp.json())


@router.get("/issues/{number}/comments", response_model=CommentList)
async def list_comments(
    number: int,
    repo: str = Query(..., description="Target repo (owner/name)"),
    user: User = Depends(get_current_user),
) -> CommentList:
    _require_token()
    _require_repo(repo)
    async with _client() as client:
        resp = await client.get(
            f"/repos/{repo}/issues/{number}/comments", params={"per_page": 50}
        )
    _raise_for_upstream(resp)
    return CommentList(comments=[Comment.model_validate(c) for c in resp.json()])


@router.get("/labels", response_model=LabelList)
async def list_labels(
    repo: str = Query(..., description="Target repo (owner/name)"),
    user: User = Depends(get_current_user),
) -> LabelList:
    _require_token()
    _require_repo(repo)
    async with _client() as client:
        resp = await client.get(f"/repos/{repo}/labels", params={"per_page": 100})
    _raise_for_upstream(resp)
    return LabelList(labels=[Label.model_validate(ln) for ln in resp.json()])


@router.get("/assignees", response_model=AssigneeList)
async def list_assignees(
    repo: str = Query(..., description="Target repo (owner/name)"),
    user: User = Depends(get_current_user),
) -> AssigneeList:
    """Users who can be assigned issues in the repo (its collaborators)."""
    _require_token()
    _require_repo(repo)
    async with _client() as client:
        resp = await client.get(f"/repos/{repo}/assignees", params={"per_page": 100})
    _raise_for_upstream(resp)
    return AssigneeList(assignees=[SimpleUser.model_validate(u) for u in resp.json()])


@router.get("/milestones", response_model=MilestoneList)
async def list_milestones(
    repo: str = Query(..., description="Target repo (owner/name)"),
    user: User = Depends(get_current_user),
) -> MilestoneList:
    _require_token()
    _require_repo(repo)
    async with _client() as client:
        resp = await client.get(
            f"/repos/{repo}/milestones", params={"state": "open", "per_page": 100}
        )
    _raise_for_upstream(resp)
    return MilestoneList(milestones=[Milestone.model_validate(m) for m in resp.json()])


# ---- Mutations ----


class CreateIssueRequest(BaseModel):
    title: str = Field(..., min_length=1)
    body: str | None = None
    labels: list[str] = []
    assignees: list[str] = []
    # A milestone's *number* (GitHub's create API keys milestones by number).
    milestone: int | None = None


@router.post("/issues", response_model=IssueSummary, status_code=status.HTTP_201_CREATED)
async def create_issue(
    repo: str = Query(..., description="Target repo (owner/name)"),
    req: CreateIssueRequest = Body(...),
    user: User = Depends(get_current_user),
) -> IssueSummary:
    _require_token()
    _require_repo(repo)
    payload: dict[str, object] = {"title": req.title}
    if req.body:
        payload["body"] = req.body
    if req.labels:
        payload["labels"] = req.labels
    if req.assignees:
        payload["assignees"] = req.assignees
    if req.milestone is not None:
        payload["milestone"] = req.milestone
    async with _client() as client:
        resp = await client.post(f"/repos/{repo}/issues", json=payload)
    _raise_for_upstream(resp)
    return IssueSummary.model_validate(resp.json())


class UpdateStateRequest(BaseModel):
    # "closed" to resolve, "open" to reopen.
    state: str = Field(..., pattern="^(open|closed)$")
    # Why it closed: "completed" or "not_planned"; "reopened" on reopen. Ignored
    # by GitHub when it doesn't apply.
    state_reason: str | None = Field(default=None, pattern="^(completed|not_planned|reopened)$")


class IssueStateResponse(BaseModel):
    number: int
    state: str | None = None
    state_reason: str | None = None


@router.patch("/issues/{number}", response_model=IssueStateResponse)
async def update_issue_state(
    number: int,
    repo: str = Query(..., description="Target repo (owner/name)"),
    req: UpdateStateRequest = Body(...),
    user: User = Depends(get_current_user),
) -> IssueStateResponse:
    """Close or reopen an issue. Closing is the app's "resolve" action; the
    optional ``state_reason`` records whether it was completed or won't be done."""
    _require_token()
    _require_repo(repo)
    payload: dict[str, object] = {"state": req.state}
    if req.state_reason:
        payload["state_reason"] = req.state_reason
    async with _client() as client:
        resp = await client.patch(f"/repos/{repo}/issues/{number}", json=payload)
    _raise_for_upstream(resp)
    issue = resp.json()
    return IssueStateResponse(
        number=number,
        state=issue.get("state"),
        state_reason=issue.get("state_reason"),
    )


class CreateCommentRequest(BaseModel):
    body: str = Field(..., min_length=1)


@router.post(
    "/issues/{number}/comments",
    response_model=Comment,
    status_code=status.HTTP_201_CREATED,
)
async def add_comment(
    number: int,
    repo: str = Query(..., description="Target repo (owner/name)"),
    req: CreateCommentRequest = Body(...),
    user: User = Depends(get_current_user),
) -> Comment:
    _require_token()
    _require_repo(repo)
    async with _client() as client:
        resp = await client.post(
            f"/repos/{repo}/issues/{number}/comments", json={"body": req.body}
        )
    _raise_for_upstream(resp)
    return Comment.model_validate(resp.json())
