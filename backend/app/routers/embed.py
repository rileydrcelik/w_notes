"""Read API for embedding notes on the portfolio website.

The portfolio's admin lets you place a note inside any subject: pick a subject,
pick "note", then choose which note. That picker needs to see the notes, and the
two services have separate databases — so this exposes them read-only.

Authenticated with the same shared secret as the ingest direction, because the
caller is the portfolio *backend*, never a browser. The admin page is a browser
app and must never hold this secret, so the portfolio proxies these calls behind
its own Firebase-authenticated routes.

Scope is the publisher allowlist: only accounts whose email appears in
``publisher_emails`` are readable, and with an empty allowlist nothing is (fail
closed, same as publishing). Trashed and deleted notes are excluded — you cannot
embed something you have thrown away.
"""

from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.models import Folder, Note, User
from app.publisher import strip_html_wrapper

router = APIRouter(prefix="/embed", tags=["embed"])


async def require_embed_secret(
    x_ingest_secret: str | None = Header(default=None),
) -> None:
    """Authenticate the portfolio backend.

    Fails closed: with no secret configured the endpoints are disabled rather
    than open. Compared with ``compare_digest`` — a plain ``==`` on a secret
    leaks its prefix through response timing.
    """
    expected = get_settings().portfolio_ingest_secret
    if not expected:
        raise HTTPException(status_code=503, detail="Embedding is not configured")
    if not x_ingest_secret or not secrets.compare_digest(x_ingest_secret, expected):
        raise HTTPException(status_code=401, detail="Invalid embed credentials")


class NoteSummary(BaseModel):
    """One row in the website's note picker."""

    id: str
    title: str
    # Plain-text preview so the picker can show what a note is without the
    # caller having to parse rich-text HTML to render a list.
    excerpt: str
    folder: str | None = None
    updated_at: int


class NoteDetail(NoteSummary):
    # Rich-text HTML with the storage wrapper stripped. The portfolio sanitizes
    # it on arrival — at the boundary that renders it, not the one that emits it.
    body_html: str


def _excerpt(html: str, limit: int = 200) -> str:
    """Flatten a rich-text body to a short single-line preview."""
    import re

    text = re.sub(r"<[^>]+>", " ", html or "")
    text = (
        text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&amp;", "&")
    )
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


async def _publisher_user_ids(session: AsyncSession) -> list[str]:
    """Ids of the accounts whose notes may be embedded (empty => none)."""
    emails = get_settings().publisher_email_set
    if not emails:
        return []
    rows = (await session.execute(select(User))).scalars().all()
    return [u.id for u in rows if u.email and u.email.lower() in emails]


def _live(query):
    """Exclude trashed and soft-deleted notes."""
    return query.where(Note.deleted_at.is_(None), Note.trashed_with_folder_id.is_(None))


@router.get(
    "/notes",
    response_model=list[NoteSummary],
    dependencies=[Depends(require_embed_secret)],
)
async def list_notes(session: AsyncSession = Depends(get_session)) -> list[NoteSummary]:
    """Every embeddable note, newest first — the website's picker list."""
    user_ids = await _publisher_user_ids(session)
    if not user_ids:
        return []

    notes = (
        await session.execute(
            _live(select(Note).where(Note.user_id.in_(user_ids))).order_by(
                Note.updated_at.desc()
            )
        )
    ).scalars().all()

    # Plugin notes render live data (Sentry/GitHub issues) rather than a body,
    # so there is nothing to embed; issue types belong to a project.
    notes = [n for n in notes if not n.plugin_type]

    folders = (
        await session.execute(select(Folder).where(Folder.user_id.in_(user_ids)))
    ).scalars().all()
    names = {f.id: f.name for f in folders if f.name}

    return [
        NoteSummary(
            id=n.id,
            title=n.title.strip() or "Untitled note",
            excerpt=_excerpt(strip_html_wrapper(n.body or "")),
            folder=names.get(n.folder_id or ""),
            updated_at=n.updated_at,
        )
        for n in notes
    ]


@router.get(
    "/notes/{note_id}",
    response_model=NoteDetail,
    dependencies=[Depends(require_embed_secret)],
)
async def get_note(
    note_id: str, session: AsyncSession = Depends(get_session)
) -> NoteDetail:
    """One note with its full body — fetched when a note is actually placed."""
    user_ids = await _publisher_user_ids(session)
    if not user_ids:
        raise HTTPException(status_code=404, detail="Note not found")

    note = (
        await session.execute(
            _live(select(Note).where(Note.user_id.in_(user_ids), Note.id == note_id))
        )
    ).scalar_one_or_none()
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")

    body = strip_html_wrapper(note.body or "")
    return NoteDetail(
        id=note.id,
        title=note.title.strip() or "Untitled note",
        excerpt=_excerpt(body),
        folder=None,
        updated_at=note.updated_at,
        body_html=body,
    )
