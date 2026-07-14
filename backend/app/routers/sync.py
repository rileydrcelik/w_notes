"""Sync endpoints — delta sync keyed on the authenticated user.

Model: the client holds the source of truth on-device and exchanges deltas with
the server. Every row carries an ``updated_at`` (epoch ms) and the server stamps
each write with a global ``server_seq``.

- ``POST /sync/push`` — the client sends rows it changed locally. Each is
  upserted by ``(user_id, id)`` with **last-writer-wins**: the incoming row only
  overwrites the stored one when its ``updated_at`` is newer-or-equal. Soft
  deletes are just rows with ``deleted_at`` set, so they sync like any edit.
- ``GET /sync/pull?since=N`` — returns every row for this user with
  ``server_seq > N``, plus the new high-water cursor the client should store.

Conflict resolution is intentionally simple (LWW on a millisecond clock); it's
adequate for a single user syncing their own devices.
"""

from __future__ import annotations

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import APIRouter, Depends, Query

from app.db import get_session
from app.deps import get_current_user
from app.models import CopaItem, Folder, Issue, Note, User
from app.schemas import (
    CopaItemIn,
    FolderIn,
    IssueIn,
    NoteIn,
    PullResponse,
    PushRequest,
    PushResponse,
)

router = APIRouter(prefix="/sync", tags=["sync"])

# Key columns never overwritten by an upsert's UPDATE branch.
_IMMUTABLE = {"user_id", "id", "created_at", "server_seq"}


async def _upsert(session: AsyncSession, model, user_id: str, row: dict) -> None:
    """Insert a row, or update the existing one only if the incoming version is
    newer (last-writer-wins on ``updated_at``). Every applied write advances
    ``server_seq`` so the change is visible to the next pull."""
    values = {**row, "user_id": user_id}
    stmt = pg_insert(model).values(**values)
    update_cols = {
        col: getattr(stmt.excluded, col)
        for col in values
        if col not in _IMMUTABLE
    }
    # Bump the change stamp on update (the column default only fires on insert).
    update_cols["server_seq"] = text("nextval('sync_seq')")
    stmt = stmt.on_conflict_do_update(
        index_elements=["user_id", "id"],
        set_=update_cols,
        # Skip the write entirely when our stored copy is newer.
        where=stmt.excluded.updated_at >= model.updated_at,
    )
    await session.execute(stmt)


@router.post("/push", response_model=PushResponse)
async def push(
    payload: PushRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> PushResponse:
    for row in payload.folders:
        await _upsert(session, Folder, user.id, row.model_dump())
    for row in payload.notes:
        await _upsert(session, Note, user.id, row.model_dump())
    for row in payload.copa_items:
        await _upsert(session, CopaItem, user.id, row.model_dump())
    for row in payload.issues:
        await _upsert(session, Issue, user.id, row.model_dump())

    await session.flush()
    return PushResponse(server_seq=await _high_water(session, user.id))


@router.get("/pull", response_model=PullResponse)
async def pull(
    since: int = Query(0, ge=0, description="Last server_seq the client holds"),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> PullResponse:
    async def changed(model):
        result = await session.execute(
            select(model).where(model.user_id == user.id, model.server_seq > since)
        )
        return result.scalars().all()

    folders = await changed(Folder)
    notes = await changed(Note)
    copa = await changed(CopaItem)
    issues = await changed(Issue)

    # New cursor = the highest server_seq in this batch, or the caller's if empty.
    high = max(
        [since, *[r.server_seq for r in (*folders, *notes, *copa, *issues)]]
    )
    return PullResponse(
        folders=[FolderIn.model_validate(r) for r in folders],
        notes=[NoteIn.model_validate(r) for r in notes],
        copa_items=[CopaItemIn.model_validate(r) for r in copa],
        issues=[IssueIn.model_validate(r) for r in issues],
        server_seq=high,
    )


async def _high_water(session: AsyncSession, user_id: str) -> int:
    """The largest server_seq this user has across all tables (0 if none)."""
    high = 0
    for model in (Folder, Note, CopaItem, Issue):
        value = await session.scalar(
            select(func.max(model.server_seq)).where(model.user_id == user_id)
        )
        if value is not None:
            high = max(high, value)
    return high
