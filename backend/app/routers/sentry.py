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
from fastapi import APIRouter, Depends, HTTPException, Query, status
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
