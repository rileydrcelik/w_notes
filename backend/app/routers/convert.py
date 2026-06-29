"""Markdown ↔ rich-text conversion endpoint.

The web client edits in markdown but the synced body is the native editor's HTML
(see ``app.conversion``). Rather than maintain that conversion in JS, the web
client posts its markdown here and stores the HTML we return. Auth is required —
this only ever handles the caller's own note content, and gating it keeps the
service from being an open conversion endpoint.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.conversion import markdown_to_html
from app.deps import get_current_user
from app.models import User
from app.schemas import ToHtmlRequest, ToHtmlResponse

router = APIRouter(prefix="/convert", tags=["convert"])


@router.post("/to-html", response_model=ToHtmlResponse)
async def to_html(
    payload: ToHtmlRequest,
    _user: User = Depends(get_current_user),
) -> ToHtmlResponse:
    return ToHtmlResponse(html=markdown_to_html(payload.markdown))
