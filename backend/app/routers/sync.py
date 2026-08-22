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
from fastapi import APIRouter, BackgroundTasks, Depends, Query

from app.db import get_session
from app.deps import get_current_user
from app.publisher import collect_publish_actions, deliver
from app.models import (
    CopaItem,
    FinanceSheet,
    Folder,
    Issue,
    Note,
    ResumeTarget,
    ResumeVersion,
    User,
    UserSetting,
)
from app.schemas import (
    CopaItemIn,
    FinanceSheetIn,
    FolderIn,
    IssueIn,
    NoteIn,
    PullResponse,
    PushRequest,
    PushResponse,
    ResumeTargetIn,
    ResumeVersionIn,
    UserSettingIn,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/sync", tags=["sync"])

# Key columns never overwritten by an upsert's UPDATE branch.
_IMMUTABLE = {"user_id", "id", "created_at", "server_seq"}

# Rows per table per pull page. Sized so a typical account still syncs in one
# round trip (nothing changes for them) while an account large enough to time
# out the edge is broken into pages it can actually finish. Rows vary enormously
# in size — a copa item is bytes, a resume version is a whole LaTeX document — so
# this is deliberately conservative rather than tuned to the average.
_PULL_PAGE = 200
_PULL_PAGE_MAX = 1000

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
    # published: a client that predates the publish-to-website feature sends
    # NULL; without preservation a single sync from such a device would
    # unpublish every note on the public site.
    Note: ("plugin_type", "plugin_config", "published"),
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
        where=stmt.excluded.updated_at >= model.updated_at,
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
    background: BackgroundTasks,
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
    await _upsert_batch(session, FinanceSheet, user.id, payload.finance_sheets)
    # Inside the same advisory lock and per-row savepoints as everything else, so
    # version rows get the seq-gap protection and poison-row isolation for free.
    await _upsert_batch(session, ResumeVersion, user.id, payload.resume_versions)
    # Append-only rows, so unlike the versions above there is no "current"
    # row that keeps moving — the upsert's UPDATE branch only ever fires on a
    # re-sent push whose response was dropped, or on a tombstone.
    await _upsert_batch(session, ResumeTarget, user.id, payload.resume_targets)
    await _upsert_batch(session, UserSetting, user.id, payload.user_settings)

    await session.flush()

    # Mirror any published notes onto the public site. Resolved here — inside the
    # transaction, after the flush — so it reads the rows the upsert actually
    # stored rather than the incoming payload, which LWW may have rejected as
    # stale. The HTTP delivery itself is deferred to a background task: the
    # website is a side effect of syncing and must never be able to fail it.
    actions = await collect_publish_actions(
        session, user, [n.id for n in payload.notes]
    )
    if actions:
        background.add_task(deliver, actions)

    return PushResponse(server_seq=await _high_water(session, user.id))


@router.get("/pull", response_model=PullResponse)
async def pull(
    since: int = Query(0, ge=0, description="Last server_seq the client holds"),
    limit: int = Query(
        _PULL_PAGE, ge=1, le=_PULL_PAGE_MAX, description="Max rows per table per page"
    ),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> PullResponse:
    """One page of the delta, oldest change first.

    The pull used to be unbounded: every row above the cursor, in one response.
    That is fine until an account is big enough that building the page costs more
    wall clock than the edge will wait for, and then it fails *permanently* —
    the cursor never advances, so every retry asks for the same oversized page
    and times out again. A first sync of an account with large notes, resume
    versions (full LaTeX per version) or finance sheets (a whole JSON doc per
    row) is exactly that shape, and this endpoint is single-worker, so the
    serialization also blocks every other request while it runs.

    So each call now returns a bounded window and says whether more remains.
    """

    async def changed(model):
        # Oldest first, capped: with the (user_id, server_seq) index this reads
        # only the window, never the whole history.
        result = await session.execute(
            select(model)
            .where(model.user_id == user.id, model.server_seq > since)
            .order_by(model.server_seq)
            .limit(limit)
        )
        return list(result.scalars().all())

    folders = await changed(Folder)
    notes = await changed(Note)
    copa = await changed(CopaItem)
    issues = await changed(Issue)
    sheets = await changed(FinanceSheet)
    versions = await changed(ResumeVersion)
    targets = await changed(ResumeTarget)
    settings = await changed(UserSetting)

    # `settings` belongs in here with the rest. It arrived after the paging was
    # written, and a table left out of this tuple is invisible to both the
    # truncation check and the cutoff filter below — which is precisely how a
    # cursor gets handed back past rows that were never sent.
    tables = (folders, notes, copa, issues, sheets, versions, targets, settings)

    # A table that came back full is truncated — it has rows above its window we
    # haven't sent. The cursor may only advance to a point below which *every*
    # table is complete, so take the lowest such boundary. Rows above it are
    # dropped from this page and arrive on the next one.
    #
    # Getting this wrong is the classic delta-sync data-loss bug: hand back a
    # cursor past rows you didn't send and those rows are never pulled again.
    truncated = [rows[-1].server_seq for rows in tables if len(rows) == limit]
    has_more = bool(truncated)
    if has_more:
        cutoff = min(truncated)
        tables = tuple([r for r in rows if r.server_seq <= cutoff] for rows in tables)
    else:
        cutoff = since
    folders, notes, copa, issues, sheets, versions, targets, settings = tables

    # New cursor = the highest server_seq in this page, or the caller's if empty.
    # Every table must feed this max: a table left out here can hand back a
    # cursor past its own rows, so they are never pulled again. Reading it off
    # `tables` rather than naming each one is deliberate — that is the mistake
    # this line is most likely to grow, and it cannot be made this way.
    #
    # `cutoff` is in the max because a truncated page is complete *below* it even
    # when no single row reaches it: without it, a page whose tables all sit under
    # the cutoff would hand back a cursor lower than what it actually sent and
    # re-send the same rows for ever.
    high = max([since, cutoff, *[r.server_seq for rows in tables for r in rows]])
    return PullResponse(
        folders=[FolderIn.model_validate(r) for r in folders],
        notes=[NoteIn.model_validate(r) for r in notes],
        copa_items=[CopaItemIn.model_validate(r) for r in copa],
        issues=[IssueIn.model_validate(r) for r in issues],
        finance_sheets=[FinanceSheetIn.model_validate(r) for r in sheets],
        resume_versions=[ResumeVersionIn.model_validate(r) for r in versions],
        resume_targets=[ResumeTargetIn.model_validate(r) for r in targets],
        user_settings=[UserSettingIn.model_validate(r) for r in settings],
        server_seq=high,
        has_more=has_more,
    )


async def _high_water(session: AsyncSession, user_id: str) -> int:
    """The largest server_seq this user has across all tables (0 if none)."""
    high = 0
    for model in (
        Folder,
        Note,
        CopaItem,
        Issue,
        FinanceSheet,
        ResumeVersion,
        ResumeTarget,
        UserSetting,
    ):
        value = await session.scalar(
            select(func.max(model.server_seq)).where(model.user_id == user_id)
        )
        if value is not None:
            high = max(high, value)
    return high
