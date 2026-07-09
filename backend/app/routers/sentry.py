"""Sentry proxy endpoints — read a project's issues on the client's behalf.

A "Sentry note" in the app carries a marker plus a small config naming which
``org``/``project`` it watches; those travel to this router per-request. The
Sentry REST API token stays here on the server (an internal-integration token,
loaded from config/SSM) and is never shipped in the Expo bundle.

Issue data is fetched **live** — it deliberately does not flow through the
sync/SQLite pipeline, so there's no stale copy and nothing to echo back.

- ``GET /sentry/issues`` — a project's issues (list).
- ``GET /sentry/issues/{issue_id}`` — one issue's detail.
- ``GET /sentry/issues/{issue_id}/latest-event`` — the latest event's stack.

Everything is gated by the same auth dependency as the rest of the API, so only
signed-in (or device-key) callers reach it. Responses are trimmed to the fields
the UI needs rather than passing Sentry's raw payloads straight through.
"""

from __future__ import annotations

import re

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.config import get_settings
from app.deps import get_current_user
from app.models import User

router = APIRouter(prefix="/sentry", tags=["sentry"])

# Upstream calls should fail fast rather than hang a request behind Sentry.
_TIMEOUT = httpx.Timeout(15.0)


# ---- Trimmed response shapes (snake_case out; Sentry's camelCase in via alias) ----


class IssueSummary(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    id: str
    short_id: str | None = Field(default=None, alias="shortId")
    title: str = ""
    culprit: str | None = None
    level: str | None = None
    status: str | None = None
    substatus: str | None = None
    platform: str | None = None
    logger: str | None = None
    # Sentry returns the event count as a string; keep it as-is for the UI.
    count: str | None = None
    user_count: int | None = Field(default=None, alias="userCount")
    first_seen: str | None = Field(default=None, alias="firstSeen")
    last_seen: str | None = Field(default=None, alias="lastSeen")
    permalink: str | None = None
    num_comments: int | None = Field(default=None, alias="numComments")
    is_unhandled: bool | None = Field(default=None, alias="isUnhandled")
    # Flattened from Sentry's nested `metadata` and `assignedTo` (see validator).
    # Aliased to camelCase so the whole payload stays camelCase for the client.
    metadata_value: str | None = Field(default=None, alias="metadataValue")
    metadata_type: str | None = Field(default=None, alias="metadataType")
    assigned_to: str | None = Field(default=None, alias="assignee")

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, data: object) -> object:
        """Lift a couple of nested Sentry fields to the top level so they map
        onto flat columns: the headline error text lives in ``metadata`` and the
        assignee in ``assignedTo`` (an object, a string, or null)."""
        if isinstance(data, dict):
            meta = data.get("metadata") or {}
            if isinstance(meta, dict):
                data.setdefault("metadata_value", meta.get("value"))
                data.setdefault("metadata_type", meta.get("type"))
                if data.get("is_unhandled") is None:
                    data["is_unhandled"] = meta.get("isUnhandled")
            assignee = data.get("assignedTo")
            if isinstance(assignee, dict):
                data["assigned_to"] = assignee.get("name") or assignee.get("email")
            elif isinstance(assignee, str):
                data["assigned_to"] = assignee
        return data


class IssueList(BaseModel):
    issues: list[IssueSummary]
    # Opaque cursor for the next page (Sentry Link header), or null when there's
    # no further page. Pass it back as ?cursor= to page.
    next_cursor: str | None = None


class ProjectSummary(BaseModel):
    """A project the server token can see — enough to render a picker row and
    build a note's ``{org, project}`` config from the selection."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    slug: str
    name: str = ""
    platform: str | None = None
    # Org slug, flattened from Sentry's nested ``organization`` object so the
    # client gets a flat value it can drop straight into pluginConfig.
    organization: str = ""

    @model_validator(mode="before")
    @classmethod
    def _flatten_org(cls, data: object) -> object:
        if isinstance(data, dict):
            org = data.get("organization")
            if isinstance(org, dict):
                data["organization"] = org.get("slug") or ""
        return data


class ProjectList(BaseModel):
    projects: list[ProjectSummary]


class ContextLine(BaseModel):
    """One line of source around a frame: its number and the code text."""

    lineno: int
    code: str


class StackFrame(BaseModel):
    filename: str | None = None
    abs_path: str | None = None
    module: str | None = None
    package: str | None = None
    function: str | None = None
    lineno: int | None = None
    colno: int | None = None
    in_app: bool | None = None
    # Source lines around the frame ([lineno, code] pairs from Sentry), when the
    # SDK captured them. The errored line is the one whose number == `lineno`.
    context: list[ContextLine] = []


class Tag(BaseModel):
    key: str
    value: str


class Breadcrumb(BaseModel):
    """A single step in the trail that led to the error."""

    timestamp: str | None = None
    type: str | None = None
    category: str | None = None
    level: str | None = None
    message: str | None = None


class RequestInfo(BaseModel):
    url: str | None = None
    method: str | None = None


class EventUser(BaseModel):
    id: str | None = None
    email: str | None = None
    username: str | None = None
    ip_address: str | None = None


class LatestEvent(BaseModel):
    id: str
    title: str | None = None
    message: str | None = None
    culprit: str | None = None
    platform: str | None = None
    date_created: str | None = None
    # The raised exception's type + value (the human-readable headline).
    exception_type: str | None = None
    exception_value: str | None = None
    # Flattened from the event's exception entry, in Sentry's order (most recent
    # call last).
    frames: list[StackFrame] = []
    # Indexed context: browser/os/device/release/environment/url/... as key-value.
    tags: list[Tag] = []
    breadcrumbs: list[Breadcrumb] = []
    request: RequestInfo | None = None
    user: EventUser | None = None


# ---- Helpers ----


def _require_token() -> str:
    token = get_settings().sentry_api_token
    if not token:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Sentry API is not configured"
        )
    return token


def _client() -> httpx.AsyncClient:
    settings = get_settings()
    return httpx.AsyncClient(
        base_url=settings.sentry_api_base.rstrip("/"),
        headers={"Authorization": f"Bearer {settings.sentry_api_token}"},
        timeout=_TIMEOUT,
    )


def _raise_for_upstream(resp: httpx.Response) -> None:
    """Turn a non-2xx Sentry response into an HTTPException. A 401/403 means our
    server token is bad/under-scoped — that's a server misconfig, not the
    caller's fault, so it surfaces as 502 rather than leaking as the client's own
    auth failure. Other 4xx (e.g. an unknown project → 404) pass through."""
    if resp.is_success:
        return
    if resp.status_code in (401, 403):
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "Sentry rejected the server token"
        )
    code = resp.status_code if resp.status_code < 500 else status.HTTP_502_BAD_GATEWAY
    raise HTTPException(code, f"Sentry API error ({resp.status_code})")


def _next_cursor(resp: httpx.Response) -> str | None:
    """Extract the next-page cursor from Sentry's RFC 5988 Link header. Sentry
    always emits a ``rel="next"`` link but flags whether it actually has more
    with ``results="true"``; return the cursor only when it does."""
    link = resp.headers.get("link")
    if not link:
        return None
    for part in link.split(","):
        if 'rel="next"' in part and 'results="true"' in part:
            match = re.search(r'cursor="([^"]+)"', part)
            if match:
                return match.group(1)
    return None


def _entry(event: dict, entry_type: str) -> dict | None:
    """The first event entry of a given type (exception/breadcrumbs/request)."""
    for entry in event.get("entries", []):
        if entry.get("type") == entry_type:
            return entry
    return None


def _frame_from(frame: dict) -> StackFrame:
    context: list[ContextLine] = []
    for pair in frame.get("context") or []:
        # Sentry sends [lineno, code] pairs; code can be null on blank lines.
        if isinstance(pair, (list, tuple)) and len(pair) >= 2 and isinstance(pair[0], int):
            context.append(ContextLine(lineno=pair[0], code="" if pair[1] is None else str(pair[1])))
    return StackFrame(
        filename=frame.get("filename"),
        abs_path=frame.get("absPath"),
        module=frame.get("module"),
        package=frame.get("package"),
        function=frame.get("function"),
        lineno=frame.get("lineNo"),
        colno=frame.get("colNo"),
        in_app=frame.get("inApp"),
        context=context,
    )


def _extract_frames(event: dict) -> list[StackFrame]:
    frames: list[StackFrame] = []
    entry = _entry(event, "exception")
    if not entry:
        return frames
    for value in (entry.get("data") or {}).get("values", []):
        stacktrace = value.get("stacktrace") or {}
        for frame in stacktrace.get("frames", []):
            frames.append(_frame_from(frame))
    return frames


def _exception_head(event: dict) -> tuple[str | None, str | None]:
    """The raised exception's ``type`` and ``value``. With chained exceptions
    Sentry orders them cause-first, so the last value is the one raised."""
    entry = _entry(event, "exception")
    if not entry:
        return None, None
    values = (entry.get("data") or {}).get("values") or []
    if not values:
        return None, None
    raised = values[-1]
    return raised.get("type"), raised.get("value")


def _breadcrumbs(event: dict, limit: int = 20) -> list[Breadcrumb]:
    entry = _entry(event, "breadcrumbs")
    if not entry:
        return []
    values = (entry.get("data") or {}).get("values") or []
    crumbs = [
        Breadcrumb(
            timestamp=c.get("timestamp"),
            type=c.get("type"),
            category=c.get("category"),
            level=c.get("level"),
            message=c.get("message") or (c.get("data") or {}).get("url"),
        )
        for c in values
    ]
    # Most recent last in Sentry; keep the tail closest to the crash.
    return crumbs[-limit:]


def _request_info(event: dict) -> RequestInfo | None:
    entry = _entry(event, "request")
    if not entry:
        return None
    data = entry.get("data") or {}
    if not (data.get("url") or data.get("method")):
        return None
    return RequestInfo(url=data.get("url"), method=data.get("method"))


def _event_tags(event: dict) -> list[Tag]:
    tags: list[Tag] = []
    for tag in event.get("tags") or []:
        key, value = tag.get("key"), tag.get("value")
        if key and value is not None:
            tags.append(Tag(key=str(key), value=str(value)))
    return tags


def _event_user(event: dict) -> EventUser | None:
    user = event.get("user")
    if not isinstance(user, dict):
        return None
    out = EventUser(
        id=user.get("id"),
        email=user.get("email"),
        username=user.get("username"),
        ip_address=user.get("ip_address") or user.get("ipAddress"),
    )
    if not any([out.id, out.email, out.username, out.ip_address]):
        return None
    return out


# ---- Endpoints ----


@router.get("/issues", response_model=IssueList)
async def list_issues(
    org: str = Query(..., description="Sentry organization slug"),
    project: str = Query(..., description="Sentry project slug"),
    query: str = Query("is:unresolved", description="Sentry issue search query"),
    environment: str | None = Query(None),
    limit: int = Query(25, ge=1, le=100),
    cursor: str | None = Query(None, description="Opaque next-page cursor"),
    user: User = Depends(get_current_user),
) -> IssueList:
    _require_token()
    params: dict[str, object] = {"query": query, "limit": limit}
    if environment:
        params["environment"] = environment
    if cursor:
        params["cursor"] = cursor
    async with _client() as client:
        resp = await client.get(f"/projects/{org}/{project}/issues/", params=params)
    _raise_for_upstream(resp)
    return IssueList(
        issues=[IssueSummary.model_validate(item) for item in resp.json()],
        next_cursor=_next_cursor(resp),
    )


@router.get("/issues/{issue_id}", response_model=IssueSummary)
async def get_issue(
    issue_id: str,
    user: User = Depends(get_current_user),
) -> IssueSummary:
    _require_token()
    async with _client() as client:
        resp = await client.get(f"/issues/{issue_id}/")
    _raise_for_upstream(resp)
    return IssueSummary.model_validate(resp.json())


@router.get("/projects", response_model=ProjectList)
async def list_projects(
    user: User = Depends(get_current_user),
) -> ProjectList:
    """Every project the server token can see, each with its org slug — the
    source for the in-app picker that configures a Sentry note. Pages through
    Sentry's cursor so an org with many projects isn't truncated, with a hard
    cap so a malformed cursor can't loop forever."""
    _require_token()
    projects: list[ProjectSummary] = []
    cursor: str | None = None
    async with _client() as client:
        for _ in range(20):
            params = {"cursor": cursor} if cursor else {}
            resp = await client.get("/projects/", params=params)
            _raise_for_upstream(resp)
            projects.extend(ProjectSummary.model_validate(p) for p in resp.json())
            cursor = _next_cursor(resp)
            if not cursor:
                break
    # Group by org, then alphabetical — stable order for the picker list.
    projects.sort(key=lambda p: (p.organization.lower(), (p.name or p.slug).lower()))
    return ProjectList(projects=projects)


class ResolveResponse(BaseModel):
    resolved: bool
    issue_id: str


@router.post("/issues/{issue_id}/resolve", response_model=ResolveResponse)
async def resolve_issue(
    issue_id: str,
    user: User = Depends(get_current_user),
) -> ResolveResponse:
    """Mark a Sentry issue resolved — the app's "Ignore" action. Sentry
    auto-reopens it on regression, so this is a dismissal, not a permanent mute.
    Same PUT the autofix workflow makes after opening a PR."""
    _require_token()
    async with _client() as client:
        resp = await client.put(f"/issues/{issue_id}/", json={"status": "resolved"})
    _raise_for_upstream(resp)
    return ResolveResponse(resolved=True, issue_id=issue_id)


@router.get("/issues/{issue_id}/latest-event", response_model=LatestEvent)
async def latest_event(
    issue_id: str,
    user: User = Depends(get_current_user),
) -> LatestEvent:
    _require_token()
    async with _client() as client:
        resp = await client.get(f"/issues/{issue_id}/events/latest/")
    _raise_for_upstream(resp)
    event = resp.json()
    exc_type, exc_value = _exception_head(event)
    return LatestEvent(
        id=event.get("id", ""),
        title=event.get("title"),
        message=event.get("message") or event.get("metadata", {}).get("value"),
        culprit=event.get("culprit"),
        platform=event.get("platform"),
        date_created=event.get("dateCreated"),
        exception_type=exc_type,
        exception_value=exc_value,
        frames=_extract_frames(event),
        tags=_event_tags(event),
        breadcrumbs=_breadcrumbs(event),
        request=_request_info(event),
        user=_event_user(event),
    )


# ---- Autofix: dispatch an issue to a GitHub Actions coding agent ----
#
# The heavy lifting (checkout, fix, PR) happens in a GitHub Actions workflow in
# the target repo — the FastAPI container has no repo/git/write creds and is the
# wrong place for it. This router only gathers issue context from Sentry and
# fires a `repository_dispatch`, then reads back the resulting branch/PR so the
# app can poll status. Guardrails live in the workflow (PR only, never merge).


# Models the autofix workflow will accept as a per-issue override. The default
# (Haiku) lives in the workflow; a caller passes one of these to escalate a hard
# fix ("Sonnet on demand"). Allowlisted because the value is interpolated into the
# workflow's `--model` arg — an arbitrary string there could inject extra CLI args.
_AUTOFIX_MODELS = frozenset(
    {"claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8"}
)


# A GitHub "owner/name" slug. The repo an autofix targets is interpolated into
# API paths and (downstream) the workflow, so an override is only honored when it
# matches this shape — no path traversal, no query smuggling.
_REPO_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")


class AutofixRequest(BaseModel):
    issue_id: str
    org: str
    project: str
    # Optional per-note target repo ("owner/name"). Falls back to the server's
    # configured `autofix_repo` when absent — so a note that watches project X
    # can PR fixes into X's repo instead of one hardcoded repo.
    repo: str | None = None
    # Optional model override for a tougher fix. Ignored unless it's in
    # _AUTOFIX_MODELS; omitted => the workflow's default (Haiku).
    model: str | None = None


class AutofixResponse(BaseModel):
    dispatched: bool
    issue_id: str
    short_id: str | None = None
    branch: str


class AutofixStatus(BaseModel):
    # none => nothing yet (queued / run not started); branch_created => the agent
    # pushed a branch but no PR yet; pr_* => a PR exists in that state.
    state: str
    branch: str
    pr_number: int | None = None
    pr_url: str | None = None
    title: str | None = None


def _require_github_token() -> str:
    """The GitHub token, or 503 if autofix isn't configured. The target repo is
    resolved separately (a note may supply its own) — see ``_resolve_repo``."""
    token = get_settings().github_token
    if not token:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Autofix is not configured"
        )
    return token


def _resolve_repo(override: str | None) -> str:
    """The repo an autofix acts on: the note's own ``owner/name`` when it passes
    a valid one, else the server default. A malformed override is rejected (422)
    rather than silently ignored, and a missing repo with no default is a 503."""
    if override:
        if not _REPO_RE.match(override):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Invalid repo (expected owner/name)",
            )
        return override
    repo = get_settings().autofix_repo
    if not repo:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Autofix is not configured"
        )
    return repo


def _github_client() -> httpx.AsyncClient:
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


def _branch_for(short_id: str) -> str:
    """Deterministic branch name shared by dispatch, the workflow, and the status
    poll — so all three agree without passing state around. e.g.
    ``PYTHON-FASTAPI-3`` -> ``autofixes/issue-python-fastapi-3``."""
    slug = re.sub(r"[^a-z0-9-]+", "-", short_id.lower()).strip("-") or "unknown"
    return f"autofixes/issue-{slug}"


def _raise_for_github(resp: httpx.Response) -> None:
    """Like ``_raise_for_upstream`` but for GitHub. A 401/403 means our server
    token is bad/under-scoped — a server misconfig, surfaced as 502."""
    if resp.is_success:
        return
    if resp.status_code in (401, 403):
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "GitHub rejected the server token"
        )
    code = resp.status_code if resp.status_code < 500 else status.HTTP_502_BAD_GATEWAY
    raise HTTPException(code, f"GitHub API error ({resp.status_code})")


def _autofix_payload(
    issue: dict, event: dict, branch: str, model: str | None = None
) -> dict:
    """A trimmed, JSON-safe context bundle for the coding agent. Kept small (well
    under GitHub's ~64 KB client_payload cap): the headline, culprit, permalink,
    and the in-app stack frames closest to the crash with a little source.

    GitHub's `repository_dispatch` allows at most **10 top-level** properties in
    `client_payload`, so the bulkier context (stack frames, request, breadcrumbs)
    is nested under a single ``details`` key. The workflow still reaches it via
    ``toJSON(client_payload)``; the individually-interpolated fields stay top-level.
    """
    exc_type, exc_value = _exception_head(event)
    meta = issue.get("metadata") or {}
    # In-app frames only, tail (nearest the crash) first, capped.
    in_app = [f for f in _extract_frames(event) if f.in_app]
    frames = [
        {
            "filename": f.filename or f.module,
            "function": f.function,
            "lineno": f.lineno,
            "context": [{"lineno": c.lineno, "code": c.code} for c in f.context[:8]],
        }
        for f in reversed(in_app[-15:])
    ]
    request = _request_info(event)
    return {
        # Top-level (≤10), each referenced individually by the workflow prompt.
        "branch": branch,
        "issue_id": str(issue.get("id", "")),
        "short_id": issue.get("shortId"),
        "title": issue.get("title") or (meta.get("value") if isinstance(meta, dict) else None),
        "culprit": issue.get("culprit"),
        "level": issue.get("level"),
        "permalink": issue.get("permalink"),
        "exception_type": exc_type,
        "exception_value": exc_value or (meta.get("value") if isinstance(meta, dict) else None),
        # Everything bulkier rides in one nested object (the 10th top-level key).
        # `model` (optional) lives here too so it doesn't add an 11th top-level key;
        # the workflow reads it as client_payload.details.model.
        "details": {
            "frames": frames,
            "request": {"url": request.url, "method": request.method} if request else None,
            "breadcrumbs": [
                {"category": c.category, "level": c.level, "message": c.message}
                for c in _breadcrumbs(event, limit=8)
            ],
            **({"model": model} if model else {}),
        },
    }


async def _autofix_in_flight(gh: httpx.AsyncClient, repo: str, branch: str) -> bool:
    """True if a fix for this issue's branch already exists (a PR in any state, or
    the pushed branch) — so we don't dispatch a second billed agent run to redo
    work that's already done or in progress. Mirrors the checks in
    ``autofix_status``."""
    pulls = await gh.get(f"/repos/{repo}/pulls", params={"state": "all", "per_page": 30})
    _raise_for_github(pulls)
    if any((pr.get("head") or {}).get("ref") == branch for pr in pulls.json()):
        return True
    br = await gh.get(f"/repos/{repo}/branches/{branch}")
    if br.status_code == 404:
        return False
    _raise_for_github(br)
    return True


@router.post("/autofix", response_model=AutofixResponse, status_code=status.HTTP_202_ACCEPTED)
async def autofix(
    req: AutofixRequest = Body(...),
    user: User = Depends(get_current_user),
) -> AutofixResponse:
    _require_token()  # need Sentry to gather context
    _require_github_token()  # and GitHub to dispatch
    repo = _resolve_repo(req.repo)  # the note's repo, or the server default

    # Pull issue detail + latest event to build the context bundle.
    async with _client() as client:
        issue_resp = await client.get(f"/issues/{req.issue_id}/")
        _raise_for_upstream(issue_resp)
        issue = issue_resp.json()
        event_resp = await client.get(f"/issues/{req.issue_id}/events/latest/")
        _raise_for_upstream(event_resp)
        event = event_resp.json()

    short_id = issue.get("shortId") or req.issue_id
    branch = _branch_for(short_id)
    # Only honor an allowlisted override; anything else falls back to the workflow
    # default (Haiku). Guards against injecting arbitrary text into `--model`.
    model = req.model if req.model in _AUTOFIX_MODELS else None

    # Dedup: if a fix is already in flight or landed, don't burn another agent run.
    async with _github_client() as gh:
        if await _autofix_in_flight(gh, repo, branch):
            return AutofixResponse(
                dispatched=False, issue_id=req.issue_id, short_id=short_id, branch=branch
            )

        payload = _autofix_payload(issue, event, branch, model)
        resp = await gh.post(
            f"/repos/{repo}/dispatches",
            json={"event_type": "sentry-autofix", "client_payload": payload},
        )
    _raise_for_github(resp)

    # Return the *resolved* short id (the one the branch was built from) so the
    # app polls status with a value that recomputes to the same branch.
    return AutofixResponse(
        dispatched=True, issue_id=req.issue_id, short_id=short_id, branch=branch
    )


@router.get("/autofix/status", response_model=AutofixStatus)
async def autofix_status(
    short_id: str = Query(..., description="Sentry issue short id, e.g. PYTHON-FASTAPI-3"),
    repo: str | None = Query(None, description="Target repo (owner/name); defaults to the server repo"),
    user: User = Depends(get_current_user),
) -> AutofixStatus:
    _require_github_token()
    repo = _resolve_repo(repo)
    branch = _branch_for(short_id)

    async with _github_client() as gh:
        # A PR is the strongest signal — check first (covers open/merged/closed).
        pulls = await gh.get(f"/repos/{repo}/pulls", params={"state": "all", "per_page": 30})
        _raise_for_github(pulls)
        for pr in pulls.json():
            if (pr.get("head") or {}).get("ref") == branch:
                if pr.get("merged_at"):
                    state = "pr_merged"
                elif pr.get("state") == "closed":
                    state = "pr_closed"
                else:
                    state = "pr_open"
                return AutofixStatus(
                    state=state,
                    branch=branch,
                    pr_number=pr.get("number"),
                    pr_url=pr.get("html_url"),
                    title=pr.get("title"),
                )

        # No PR yet — has the agent at least pushed the branch?
        br = await gh.get(f"/repos/{repo}/branches/{branch}")
    if br.status_code == 404:
        return AutofixStatus(state="none", branch=branch)
    _raise_for_github(br)
    return AutofixStatus(state="branch_created", branch=branch)
