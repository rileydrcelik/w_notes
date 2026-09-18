"""Reclaiming the S3 objects behind deleted note images.

Nothing in this app has ever deleted a stored object. Copa attachments leak by
design — a handful of manually added files was a bill nobody could see. Note
images change that arithmetic: pasting a screenshot is a keystroke, so the
orphans arrive at the speed of typing.

The decision about whether an image is dead is *not* made here. Only a device
can make it: the question is "does any body still reference this id", and the
client holds every body locally while the server would have to scan the whole
notes table per image. So a client tombstones the row, and this job's much
narrower job is to notice a tombstone that has aged out and drop the bytes.

Two things make that safe to do unattended:

* **The grace period.** A tombstone is a claim by one device. Another device may
  be offline, mid-download, or about to lose last-writer-wins and resurrect the
  row (the body is the authority on whether an image is alive; a tombstone is
  only a hint). ``_GRACE_MS`` is the window in which that can still play out.
* **The row outlives the bytes.** The object is deleted first and ``remote_key``
  cleared second, so a crash between them leaks an object rather than leaving a
  row pointing at bytes that are gone. A row whose key is NULL reads exactly
  like one whose upload never finished, which every client already handles.

It runs as a background task after a push commits, never inside it: the push
holds a per-user advisory lock until its commit, and S3 round trips inside that
window are how this backend wedged its connection pool in September.
"""

from __future__ import annotations

import logging
import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import SessionLocal
from app.models import NoteImage
from app.storage import delete_object, is_configured

log = logging.getLogger(__name__)

# How long a tombstone must stand before its bytes go. Matches the client's
# trash window (`trash-retention.ts`), which is the longest an undo can
# reasonably arrive from — and a device that has been offline longer than this
# re-downloads what it still needs on its next pass anyway.
_GRACE_MS = 30 * 24 * 60 * 60 * 1000

# Objects deleted per run. A push should never turn into a long S3 session; the
# backlog drains over subsequent pushes.
_BATCH = 20


async def purge_deleted_images(user_id: str) -> int:
    """Drop the S3 objects behind this user's aged-out image tombstones.

    Returns how many were deleted. Never raises: reclaiming storage is
    housekeeping, and a failure here must not surface anywhere near a sync.
    """
    if not is_configured():
        return 0
    try:
        async with SessionLocal() as session:
            rows = await _expired(session, user_id)
            deleted = 0
            for row in rows:
                key = row.remote_key
                if not key:
                    continue
                try:
                    delete_object(key)
                except Exception:
                    # Leave the row as it is: still tombstoned, still carrying
                    # the key, so the next push tries again.
                    log.exception("note image purge failed for key %s", key)
                    continue
                row.remote_key = None
                deleted += 1
            if deleted:
                await session.commit()
            return deleted
    except Exception:
        log.exception("note image purge failed for user %s", user_id)
        return 0


async def _expired(session: AsyncSession, user_id: str) -> list[NoteImage]:
    cutoff = int(time.time() * 1000) - _GRACE_MS
    result = await session.execute(
        select(NoteImage)
        .where(
            NoteImage.user_id == user_id,
            NoteImage.deleted_at.is_not(None),
            NoteImage.deleted_at < cutoff,
            NoteImage.remote_key.is_not(None),
        )
        .order_by(NoteImage.deleted_at)
        .limit(_BATCH)
    )
    return list(result.scalars().all())
