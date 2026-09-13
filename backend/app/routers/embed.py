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
from sqlalchemy import func, select, text, update
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

    # The folder name becomes the post's album on the website, so it has to come
    # back with the note — embedding asks for nothing but which note it is.
    folder = None
    if note.folder_id:
        row = (
            await session.execute(
                select(Folder).where(
                    Folder.user_id == note.user_id, Folder.id == note.folder_id
                )
            )
        ).scalar_one_or_none()
        folder = (row.name or "").strip() or None if row else None

    body = strip_html_wrapper(note.body or "")
    return NoteDetail(
        id=note.id,
        title=note.title.strip() or "Untitled note",
        excerpt=_excerpt(body),
        folder=folder,
        updated_at=note.updated_at,
        body_html=body,
    )


class PlacementIn(BaseModel):
    """What the portfolio says it has done with a note."""

    embedded: bool


@router.post("/notes/{note_id}/placement", dependencies=[Depends(require_embed_secret)])
async def set_placement(
    note_id: str,
    placement: PlacementIn,
    session: AsyncSession = Depends(get_session),
) -> dict[str, bool]:
    """Record that the portfolio has placed this note on the site, or removed it.

    The authoritative source for the app's "on the website" indicator, and the
    only immediate one. The other writer infers placement from the answer to a
    push, which only happens when the note is *edited* — so a note placed in the
    portfolio's admin and then left alone would read as unplaced until someone
    happened to touch it. Placement is the portfolio's decision; this lets it say
    so at the moment it makes it.

    Idempotent, and quiet when nothing changed: ``IS DISTINCT FROM`` means
    re-sending the same answer costs no sequence number and pushes no row to any
    device.

    ``updated_at`` is deliberately untouched — see :func:`publisher.record_embedded`
    for why bumping it would let this beat a device's unpushed edit.
    """
    user_ids = await _publisher_user_ids(session)
    if not user_ids:
        raise HTTPException(status_code=404, detail="Note not found")

    # Same per-user lock the sync push takes, so the sequence number this draws
    # cannot be committed out of order with a concurrent push and stranded below
    # a device's cursor.
    for user_id in user_ids:
        await session.execute(select(func.pg_advisory_xact_lock(func.hashtext(user_id))))

    result = await session.execute(
        update(Note)
        .where(
            Note.user_id.in_(user_ids),
            Note.id == note_id,
            Note.embedded.is_distinct_from(placement.embedded),
        )
        .values(embedded=placement.embedded, server_seq=text("nextval('sync_seq')"))
    )
    if result.rowcount == 0:
        # Either no such note, or it already said this. Tell them apart so the
        # portfolio can distinguish a bad id from a no-op.
        exists = (
            await session.execute(
                select(Note.id).where(Note.user_id.in_(user_ids), Note.id == note_id)
            )
        ).scalar_one_or_none()
        if exists is None:
            raise HTTPException(status_code=404, detail="Note not found")

    return {"embedded": placement.embedded}
