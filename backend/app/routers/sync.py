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

import logging

import sentry_sdk
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

log = logging.getLogger(__name__)

router = APIRouter(prefix="/sync", tags=["sync"])

# Key columns never overwritten by an upsert's UPDATE branch.
_IMMUTABLE = {"user_id", "id", "created_at", "server_seq"}

# Per-model columns that a NULL in an incoming push must NOT overwrite. These are
# schema-extension fields added in later app versions (folder kind/config, note
# plugin config, copa file metadata). An older client that predates a column
# can't send it and would otherwise null it out on every device via a normal LWW
# round trip — silent cross-version data loss. They are set-once / never
# legitimately cleared to NULL by the UI, so COALESCE-preserving the stored value
# is safe. Fields with real null transitions (folder_id, parent_id, deleted_at,
# trashed_with_folder_id, gh_number) are deliberately excluded — a NULL there is
# a genuine user action (move to home, restore, untrack) and must propagate.
_PRESERVE_IF_NULL = {
    Folder: ("kind", "config"),
    Note: ("plugin_type", "plugin_config"),
    CopaItem: ("file_name", "mime_type", "file_size", "remote_key"),
    # type_ids: an older client can't send it (multi-type came later); a NULL
    # push must not wipe the stored set. An issue always keeps ≥1 type, so it's
    # never legitimately cleared to NULL by the UI — COALESCE-preserve is safe.
    Issue: ("type_ids",),
}


async def _upsert(session: AsyncSession, model, user_id: str, row: dict) -> None:
    """Insert a row, or update the existing one only if the incoming version is
    newer (last-writer-wins on ``updated_at``). Every applied write advances
    ``server_seq`` so the change is visible to the next pull."""
    values = {**row, "user_id": user_id}
    preserve = _PRESERVE_IF_NULL.get(model, ())
    stmt = pg_insert(model).values(**values)
    update_cols = {}
    for col in values:
        if col in _IMMUTABLE:
            continue
        incoming = getattr(stmt.excluded, col)
        # Never let an older client's NULL wipe a value it simply doesn't know
        # about; keep the stored one when the incoming column is NULL.
        if col in preserve:
            update_cols[col] = func.coalesce(incoming, getattr(model, col))
        else:
            update_cols[col] = incoming
    # Bump the change stamp on update (the column default only fires on insert).
    update_cols["server_seq"] = text("nextval('sync_seq')")
    stmt = stmt.on_conflict_do_update(
        index_elements=["user_id", "id"],
        set_=update_cols,
        # Skip the write entirely when our stored copy is newer.
    )
    await session.execute(stmt)


async def _upsert_batch(session: AsyncSession, model, user_id: str, rows) -> None:
    """Upsert a batch of rows, each in its own SAVEPOINT so one bad row can't
    abort the whole push. A row the server can't store (e.g. a shape from a newer
    client version) is skipped and reported, not left to poison every retry — the
    old behaviour silently blocked *all* of a device's sync behind one bad row."""
    for row in rows:
        try:
            async with session.begin_nested():
                await _upsert(session, model, user_id, row.model_dump())
        except Exception as exc:  # noqa: BLE001 — isolate, report, keep going
            log.warning(
                "sync push: skipped bad %s row id=%s: %s",
                model.__tablename__,
                getattr(row, "id", "?"),
                exc,
            )
            sentry_sdk.capture_exception(exc)


@router.post("/push", response_model=PushResponse)
async def push(
    payload: PushRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> PushResponse:
    # Serialize pushes for this user so ``server_seq`` values are assigned *and*
    # committed in order. Without this, two devices pushing at once can commit a
    # lower seq after a higher one has already advanced a puller's cursor, so the
    # lower-seq row is never pulled again — a row that silently vanishes from that
    # device. The lock is transaction-scoped (released on commit/rollback) and
    # keyed on the user, so different users never contend. Pulls are read-only
    # snapshots and need no lock.
    await session.execute(
        select(func.pg_advisory_xact_lock(func.hashtext(user.id)))
    )

    await _upsert_batch(session, Folder, user.id, payload.folders)
    await _upsert_batch(session, Note, user.id, payload.notes)
    await _upsert_batch(session, CopaItem, user.id, payload.copa_items)
    await _upsert_batch(session, Issue, user.id, payload.issues)

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
