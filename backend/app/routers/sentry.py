"""Sentry proxy endpoints — read a project's issues on the client's behalf.

A "Sentry note" in the app carries a marker plus a small config naming which
``org``/``project`` it watches; those travel to this router per-request.

**The read endpoints act as the caller's own Sentry API token**, stored
encrypted per account (see ``app/credentials.py``) and never shipped in the Expo
bundle. A single server-wide token used to serve every account, which meant
everyone read issues through the operator's Sentry access.

The ``/autofix`` endpoints are the exception and stay on the server's own
credentials: they drive *this deployment's* pipeline — its repo, its workflow —
which is the operator's, not the caller's.

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
from typing import NamedTuple

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai_access import require_owner
from app.config import get_settings
from app.credentials import require_user_token
from app.db import get_session
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
    """A project the caller's token can see — enough to render a picker row and
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


async def _caller_token(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> str:
    """The **caller's own** Sentry API token, or 503 telling them to add one.

    Same reasoning as the GitHub proxy: a single server-wide token meant every
    account read issues through the operator's Sentry access. The autofix
    endpoints below are different — they drive *this deployment's* pipeline and
    legitimately use the server's own credentials.
    """
    return await require_user_token(session, user.id, "sentry")


def _client(token: str) -> httpx.AsyncClient:
    """A Sentry client acting as `token` — the caller's, never the server's."""
    settings = get_settings()
    return httpx.AsyncClient(
        base_url=settings.sentry_api_base.rstrip("/"),
        headers={"Authorization": f"Bearer {token}"},
        timeout=_TIMEOUT,
    )


async def _guarded(call, upstream: str = "Sentry") -> httpx.Response:
    """Run an upstream httpx call, turning a timeout/connection failure into a
    clean HTTPException instead of letting it bubble up as an unhandled 500
    (which is exactly what was reaching Sentry as a ReadTimeout crash)."""
    try:
        return await call
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT, f"{upstream} API request timed out"
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"{upstream} API request failed"
        ) from exc


def _raise_for_upstream(resp: httpx.Response) -> None:
    """Turn a non-2xx Sentry response into an HTTPException.

    A 401/403 now surfaces as **400, not 502**, for the same reason as the
    GitHub proxy: the token being rejected is the caller's own, so calling it a
    bad gateway would blame the server for a credential only the caller can
    replace. Other 4xx (e.g. an unknown project → 404) pass through.
    """
    if resp.is_success:
        return
    if resp.status_code in (401, 403):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Sentry rejected your token — check it in Settings → Plugins",
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
    token: str = Depends(_caller_token),
) -> IssueList:
    params: dict[str, object] = {"query": query, "limit": limit}
    if environment:
        params["environment"] = environment
    if cursor:
        params["cursor"] = cursor
    async with _client(token) as client:
        resp = await _guarded(client.get(f"/projects/{org}/{project}/issues/", params=params))
    _raise_for_upstream(resp)
    return IssueList(
        issues=[IssueSummary.model_validate(item) for item in resp.json()],
        next_cursor=_next_cursor(resp),
    )


@router.get("/issues/{issue_id}", response_model=IssueSummary)
async def get_issue(
    issue_id: str,
    token: str = Depends(_caller_token),
) -> IssueSummary:
    async with _client(token) as client:
        resp = await _guarded(client.get(f"/issues/{issue_id}/"))
    _raise_for_upstream(resp)
    return IssueSummary.model_validate(resp.json())


@router.get("/projects", response_model=ProjectList)
async def list_projects(
    token: str = Depends(_caller_token),
) -> ProjectList:
    """Every project the caller's token can see, each with its org slug — the
    source for the in-app picker that configures a Sentry note. Pages through
    Sentry's cursor so an org with many projects isn't truncated, with a hard
    cap so a malformed cursor can't loop forever."""
    projects: list[ProjectSummary] = []
    cursor: str | None = None
    async with _client(token) as client:
        for _ in range(20):
            params = {"cursor": cursor} if cursor else {}
            resp = await _guarded(client.get("/projects/", params=params))
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
    token: str = Depends(_caller_token),
) -> ResolveResponse:
    """Mark a Sentry issue resolved — the app's "Ignore" action. Sentry
    auto-reopens it on regression, so this is a dismissal, not a permanent mute.
    Same PUT the autofix workflow makes after opening a PR."""
    async with _client(token) as client:
        resp = await _guarded(client.put(f"/issues/{issue_id}/", json={"status": "resolved"}))
    _raise_for_upstream(resp)
    return ResolveResponse(resolved=True, issue_id=issue_id)


@router.get("/issues/{issue_id}/latest-event", response_model=LatestEvent)
async def latest_event(
    issue_id: str,
    token: str = Depends(_caller_token),
) -> LatestEvent:
    async with _client(token) as client:
        resp = await _guarded(client.get(f"/issues/{issue_id}/events/latest/"))
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

# How many times one Sentry issue may be re-attempted on its own branch. A cap
# rather than unbounded retries: an issue that has burned this many agent runs
# without sticking wants a person, not another run.
_MAX_AUTOFIX_ATTEMPTS = 10

# The workflow file the dispatch triggers, used to look its runs back up. A
# `repository_dispatch` run exposes its `client_payload` nowhere in the REST API,
# so the run is correlated to an attempt through its *name* — which is why
# `sentry-autofix.yml` sets `run-name` to include the attempt branch.
_AUTOFIX_WORKFLOW = "sentry-autofix.yml"


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
    # Why nothing was dispatched, in words the app can show. Without it a refusal
    # is indistinguishable from a fresh run to the client, which then polls and
    # reports whatever the *previous* attempt did as the outcome of this press.
    reason: str | None = None


class AutofixStatus(BaseModel):
    # none        => nothing yet (queued / run not started)
    # branch_created => the agent pushed a branch but no PR yet
    # pr_*        => a PR exists in that state
    # no_fix      => the run finished without pushing anything. Either the agent
    #                judged that no code change was warranted, or the run itself
    #                failed; `run_conclusion` says which. Terminal — the app must
    #                stop polling, because nothing more is coming.
    state: str
    branch: str
    pr_number: int | None = None
    pr_url: str | None = None
    title: str | None = None
    # The workflow run behind this attempt, when there's no PR to link instead.
    # For a `no_fix` it is the only place the agent's reasoning can be read.
    run_url: str | None = None
    run_conclusion: str | None = None


def _require_github_token() -> str:
    """The GitHub token, or 503 if autofix isn't configured. The target repo is
    resolved separately (a note may supply its own) — see ``_resolve_repo``."""
    token = get_settings().github_token
    if not token:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Autofix is not configured"
        )
    return token


def _autofix_projects() -> set[str]:
    """Sentry project slugs whose code lives in the default ``autofix_repo``."""
    raw = get_settings().autofix_projects
    return {slug.strip() for slug in raw.split(",") if slug.strip()}


def _resolve_repo(override: str | None, project: str | None = None) -> str:
    """The repo an autofix acts on: the note's own ``owner/name`` when it passes
    a valid one, else the server default. A malformed override is rejected (422)
    rather than silently ignored, and a missing repo with no default is a 503.

    ``project`` is the Sentry project the issue came from. Pass it whenever the
    call has side effects — it gates the *fallback*, which is the dangerous path:
    without it, a note watching an unrelated project silently resolves to this
    server's repo, and the agent gets dispatched to fix a bug that lives in a
    different codebase entirely. Downstream that PR is auto-merged and deployed,
    so a wrong repo is not a harmless confusion. Read-only callers can omit it.

    Left unconfigured (``autofix_projects`` empty) the check can't be made and
    the fallback stays open, matching the behaviour before the guard existed.
    """
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
    known = _autofix_projects()
    if project and known and project not in known:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Issue belongs to Sentry project '{project}', whose code is not in "
            f"{repo} (that repo covers: {', '.join(sorted(known))}). Set the "
            "note's repo to the one holding this project's code.",
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
    token is bad/under-scoped — a server misconfig, surfaced as 502.

    When the token is merely under-scoped, GitHub says exactly which permission
    was wanted in ``x-accepted-github-permissions``. Passing that through turns
    "GitHub rejected the server token" — which reads like the token is invalid,
    and sends you checking the token itself — into a message naming the missing
    grant. Diagnosing this the hard way costs an hour; the header was there the
    whole time.
    """
    if resp.is_success:
        return
    if resp.status_code in (401, 403):
        needed = resp.headers.get("x-accepted-github-permissions")
        detail = "GitHub rejected the server token"
        if needed:
            detail = f"{detail} (needs: {needed})"
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail)
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


def _attempt_branch(base: str, n: int) -> str:
    """The nth attempt at fixing one issue. Attempt 1 keeps the bare base name so
    existing branches, PRs and workflow runs are unaffected."""
    return base if n <= 1 else f"{base}-{n}"


def _attempt_of(base: str, branch: str) -> int | None:
    """Which attempt a branch is, or None if it isn't in this issue's family."""
    if branch == base:
        return 1
    suffix = branch[len(base) + 1 :] if branch.startswith(f"{base}-") else ""
    return int(suffix) if suffix.isdigit() else None


async def _family_prs(gh: httpx.AsyncClient, repo: str, base: str) -> dict[str, dict]:
    """Newest PR per branch across every attempt at this issue, keyed by branch."""
    pulls = await _guarded(
        gh.get(f"/repos/{repo}/pulls", params={"state": "all", "per_page": 100}), "GitHub"
    )
    _raise_for_github(pulls)
    found: dict[str, dict] = {}
    for pr in pulls.json():  # newest first
        ref = (pr.get("head") or {}).get("ref") or ""
        if _attempt_of(base, ref) is not None:
            found.setdefault(ref, pr)
    return found


async def _family_branches(gh: httpx.AsyncClient, repo: str, base: str) -> set[str]:
    """Every pushed branch in this issue's attempt family, in one request. The
    matching-refs endpoint is a prefix match, so the family test still filters."""
    resp = await _guarded(gh.get(f"/repos/{repo}/git/matching-refs/heads/{base}"), "GitHub")
    _raise_for_github(resp)
    refs = set()
    for ref in resp.json():
        name = (ref.get("ref") or "").removeprefix("refs/heads/")
        if _attempt_of(base, name) is not None:
            refs.add(name)
    return refs


async def _family_runs(
    gh: httpx.AsyncClient, repo: str, base: str
) -> dict[str, dict]:
    """Newest workflow run per attempt branch, keyed by branch.

    The correlation is the run's display title: a ``repository_dispatch`` run
    carries its ``client_payload`` nowhere the REST API will show it, so
    ``sentry-autofix.yml`` puts the attempt branch in ``run-name``. Any token of
    the title that parses as a member of this issue's family identifies the run,
    which keeps the match working if the surrounding wording ever changes.

    Runs are best-effort context, never a hard dependency: a repo without the
    workflow (autofix can target another codebase) or a token without
    ``actions:read`` yields an empty map, and every caller then behaves exactly as
    it did before runs were consulted at all.
    """
    resp = await _guarded(
        gh.get(
            f"/repos/{repo}/actions/workflows/{_AUTOFIX_WORKFLOW}/runs",
            params={"event": "repository_dispatch", "per_page": 100},
        ),
        "GitHub",
    )
    if resp.status_code in (403, 404):
        return {}
    _raise_for_github(resp)
    found: dict[str, dict] = {}
    for run in resp.json().get("workflow_runs", []):  # newest first
        for token in (run.get("display_title") or "").split():
            if _attempt_of(base, token) is not None:
                found.setdefault(token, run)
                break
    return found


def _run_is_live(run: dict) -> bool:
    """Whether a run may still push a branch. Anything but ``completed`` counts,
    so a status GitHub adds later reads as live rather than as a finished run
    that produced nothing."""
    return run.get("status") != "completed"


class AutofixPlan(NamedTuple):
    """What a Fix press should do: dispatch on ``branch``, or nothing, in which
    case ``reason`` says why in words the app can put on the card."""

    branch: str | None
    # Short enough to sit in the card's chip next to "PR #12 open" — this is a
    # label, not an explanation.
    reason: str | None = None


async def _autofix_target_branch(
    gh: httpx.AsyncClient, repo: str, base: str
) -> AutofixPlan:
    """The branch a new autofix run should use, or no branch when one is already
    in flight and a second billed run would only duplicate it.

    An attempt is *spent* once its PR is closed or merged. Closed means the
    proposal was rejected; merged means a fix landed — and if Sentry is reporting
    the issue again, neither is a reason to refuse to try again. Only an open PR
    (still under review), a pushed branch with no PR yet, or a run that hasn't
    finished is genuinely in flight.

    Treating a spent attempt as in-flight is what made W-NOTES-RN-C permanently
    unfixable: PR #4 on ``autofixes/issue-w-notes-rn-c`` was closed, so every
    later dispatch short-circuited to ``dispatched: false`` and the status poll
    reported that same closed PR back to the app for ever. Nothing retried,
    because from the outside it looked like the work had already been done.

    The mirror image of that bug is why runs are consulted here. An attempt whose
    agent decided no code change was warranted pushes *no branch and opens no PR*,
    so on branches-and-PRs alone it is indistinguishable from an attempt that
    never happened: every later press re-dispatched the same attempt number, the
    agent reached the same conclusion in ~40s, and the whole loop was invisible —
    a green run, no artifact, and a chip that spun for two minutes. A finished run
    with nothing to show for it is a spent attempt, and the next press moves on to
    a fresh one (main may genuinely have changed since).
    """
    prs = await _family_prs(gh, repo, base)
    if any(pr.get("state") == "open" for pr in prs.values()):
        return AutofixPlan(None, "Already up for review")

    branches = await _family_branches(gh, repo, base)
    # Fetched lazily: only an attempt with neither a PR nor a branch needs runs to
    # tell "never started" from "finished empty-handed".
    runs: dict[str, dict] | None = None
    for n in range(1, _MAX_AUTOFIX_ATTEMPTS + 1):
        branch = _attempt_branch(base, n)
        if branch in prs:
            continue  # spent — closed or merged
        if branch in branches:
            # Pushed but no PR yet: a run is live (or the workflow is about to
            # open one). Don't race it with a second run on the same branch.
            return AutofixPlan(None, "Already being written")
        if runs is None:
            runs = await _family_runs(gh, repo, base)
        run = runs.get(branch)
        if run is None:
            return AutofixPlan(branch)  # nothing has ever run here
        if _run_is_live(run):
            # Dispatched, but too early to have pushed. A second dispatch would
            # land in the same concurrency group and cancel this one mid-fix.
            return AutofixPlan(None, "Already running")
        continue  # spent — the run finished without proposing anything
    return AutofixPlan(
        None, f"Tried {_MAX_AUTOFIX_ATTEMPTS} times — needs a person"
    )


@router.post("/autofix", response_model=AutofixResponse, status_code=status.HTTP_202_ACCEPTED)
async def autofix(
    req: AutofixRequest = Body(...),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> AutofixResponse:
    # Owner-only, and checked first: this is the expensive, irreversible one.
    # It bills an agent run and, where autofix-ship is wired up, ends in an
    # automatic merge and deploy of the operator's repo. No caller-supplied
    # key can pay for that, so the answer is 403 rather than the resume
    # endpoints' 402 — see `require_owner`.
    #
    # This is also what closes DEPLOYMENT-READINESS.md §A2, which the per-user
    # credentials could not: the two sides of this endpoint use different tokens
    # on purpose — the caller's Sentry token to gather context, the *server's*
    # GitHub token to dispatch, because the pipeline being driven is the
    # operator's and not the caller's. That asymmetry meant anyone who could
    # reach this route could spend the operator's agent budget. The gate is what
    # makes it safe, so it has to be the first thing that runs.
    #
    # Which is why the caller's Sentry token is fetched *here* rather than as a
    # `Depends(_caller_token)` like every read route above. Dependencies resolve
    # before the handler body, so as a dependency it would answer a non-owner
    # with "add a Sentry token" (503) — sending someone off to configure a
    # credential for a route they will be refused from either way, and saying
    # more about the deployment than a 403 does.
    require_owner(user, "Autofix")
    token = await require_user_token(session, user.id, "sentry")  # gathers context
    _require_github_token()  # and GitHub to dispatch
    # The note's repo, or the server default — but the fallback is only allowed
    # for projects whose code actually lives there. This dispatch bills an agent
    # run and, in a repo with autofix-ship wired up, ends in an automatic merge
    # and deploy; aiming it at the wrong codebase is not recoverable by review.
    repo = _resolve_repo(req.repo, req.project)

    # Pull issue detail + latest event to build the context bundle.
    async with _client(token) as client:
        issue_resp = await _guarded(client.get(f"/issues/{req.issue_id}/"))
        _raise_for_upstream(issue_resp)
        issue = issue_resp.json()
        event_resp = await _guarded(client.get(f"/issues/{req.issue_id}/events/latest/"))
        _raise_for_upstream(event_resp)
        event = event_resp.json()

    short_id = issue.get("shortId") or req.issue_id
    base = _branch_for(short_id)
    # Only honor an allowlisted override; anything else falls back to the workflow
    # default (Haiku). Guards against injecting arbitrary text into `--model`.
    model = req.model if req.model in _AUTOFIX_MODELS else None

    # Dedup: if a run is genuinely in flight, don't burn another agent run. A
    # recurrence after a closed or merged attempt gets a fresh branch instead.
    async with _github_client() as gh:
        branch, reason = await _autofix_target_branch(gh, repo, base)
        if branch is None:
            return AutofixResponse(
                dispatched=False,
                issue_id=req.issue_id,
                short_id=short_id,
                branch=base,
                reason=reason,
            )

        payload = _autofix_payload(issue, event, branch, model)
        resp = await _guarded(
            gh.post(
                f"/repos/{repo}/dispatches",
                json={"event_type": "sentry-autofix", "client_payload": payload},
            ),
            "GitHub",
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
    branch: str | None = Query(
        None,
        description="The attempt branch this poll is about, as returned by /autofix. "
        "Omit to report the newest attempt.",
    ),
    issue_id: str | None = Query(
        None,
        description="The Sentry issue this poll is about. Only used to tell a run "
        "that proposed nothing from one whose verdict closed the issue.",
    ),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> AutofixStatus:
    # Same gate as the dispatch. Nobody but an owner can have started a run,
    # so for anyone else this only reports on the operator's open pull
    # requests — which is not theirs to read either.
    require_owner(user, "Autofix")
    _require_github_token()
    repo = _resolve_repo(repo)
    base = _branch_for(short_id)
    # Only ever report on this issue's own branches — `branch` arrives from the
    # client, so it must not be able to point the poll at an unrelated PR.
    want = branch if branch and _attempt_of(base, branch) is not None else None

    async with _github_client() as gh:
        # Report the attempt the caller actually started. Falling back to "newest
        # attempt" (for clients that don't send one) still beats "first match",
        # which pinned the chip to a stale PR: the app would show a run that
        # finished months ago as the outcome of the fix you just started.
        prs = await _family_prs(gh, repo, base)
        if want is not None:
            prs = {ref: pr for ref, pr in prs.items() if ref == want}
        if prs:
            newest_pr = max(prs, key=lambda ref: _attempt_of(base, ref) or 0)
            pr = prs[newest_pr]
            branch = newest_pr
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

        # No PR yet — has the agent at least pushed a branch?
        branches = await _family_branches(gh, repo, base)
        if want is not None:
            branches = {ref for ref in branches if ref == want}
        if branches:
            newest = max(branches, key=lambda ref: _attempt_of(base, ref) or 0)
            return AutofixStatus(state="branch_created", branch=newest)

        # Nothing pushed. That is not automatically "still starting up": a run
        # that has *finished* with no branch and no PR is a real outcome — the
        # agent judged no code change was warranted, or the run broke — and
        # without asking the run, the app can only keep saying "Queued…" until it
        # times out and claims the pipeline is "still working" on something that
        # ended in seconds.
        runs = await _family_runs(gh, repo, base)

    if want is not None:
        runs = {ref: run for ref, run in runs.items() if ref == want}
    if not runs:
        return AutofixStatus(state="none", branch=want or base)
    newest = max(runs, key=lambda ref: _attempt_of(base, ref) or 0)
    run = runs[newest]
    if _run_is_live(run):
        return AutofixStatus(
            state="none", branch=newest, run_url=run.get("html_url")
        )
    # The run is over and proposed nothing. It may also have *closed* the issue —
    # the workflow dismisses one whose fix is already on main and which hasn't
    # fired since that code deployed. Sentry is the authority on whether that
    # happened, so ask it rather than trying to read the verdict back out of a
    # workflow run. Without an answer the honest report is the plain no-fix, which
    # is what the app shows if this lookup is unavailable.
    state = "no_fix"
    if issue_id and await _issue_is_resolved(session, user, issue_id):
        state = "dismissed"
    return AutofixStatus(
        state=state,
        branch=newest,
        run_url=run.get("html_url"),
        run_conclusion=run.get("conclusion"),
    )


async def _issue_is_resolved(
    session: AsyncSession, user: User, issue_id: str
) -> bool:
    """Whether Sentry now considers this issue resolved. Best-effort by design:
    an owner without a Sentry credential, or an upstream that refuses, must not
    turn a status poll into an error — it only costs the chip its wording."""
    try:
        token = await require_user_token(session, user.id, "sentry")
        async with _client(token) as client:
            resp = await _guarded(client.get(f"/issues/{issue_id}/"))
        if not resp.is_success:
            return False
        return (resp.json().get("status") or "") == "resolved"
    except HTTPException:
        return False
