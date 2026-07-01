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
from pydantic import BaseModel, ConfigDict, Field

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
    # Sentry returns the event count as a string; keep it as-is for the UI.
    count: str | None = None
    user_count: int | None = Field(default=None, alias="userCount")
    first_seen: str | None = Field(default=None, alias="firstSeen")
    last_seen: str | None = Field(default=None, alias="lastSeen")
    permalink: str | None = None


class IssueList(BaseModel):
    issues: list[IssueSummary]
    # Opaque cursor for the next page (Sentry Link header), or null when there's
    # no further page. Pass it back as ?cursor= to page.
    next_cursor: str | None = None


class StackFrame(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    filename: str | None = None
    function: str | None = None
    lineno: int | None = Field(default=None, alias="lineNo")
    in_app: bool | None = Field(default=None, alias="inApp")


class LatestEvent(BaseModel):
    id: str
    title: str | None = None
    culprit: str | None = None
    platform: str | None = None
    date_created: str | None = None
    # Flattened from the event's exception entry, in Sentry's order (most recent
    # call last).
    frames: list[StackFrame] = []


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


def _extract_frames(event: dict) -> list[StackFrame]:
    frames: list[StackFrame] = []
    for entry in event.get("entries", []):
        if entry.get("type") != "exception":
            continue
        for value in (entry.get("data") or {}).get("values", []):
            stacktrace = value.get("stacktrace") or {}
            for frame in stacktrace.get("frames", []):
                frames.append(StackFrame.model_validate(frame))
    return frames


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
    return LatestEvent(
        id=event.get("id", ""),
        title=event.get("title"),
        culprit=event.get("culprit"),
        platform=event.get("platform"),
        date_created=event.get("dateCreated"),
        frames=_extract_frames(event),
    )
