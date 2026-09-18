"""Turning a note's image references into bytes the portfolio can render.

A stored body says ``<img src="wn-img:{id}">``. That is meaningless anywhere but
inside this app: the bytes sit in a private S3 bucket, and the portfolio has
neither the table to resolve the id nor credentials to read the object. Publish a
body untouched and every screenshot in it is a broken image on a public website.

So the reference is resolved here, into a ``data:`` URI carrying the bytes. The
alternative was a public-read prefix in the bucket, which trades a heavier page
for making anything ever published world-readable by URL, forever, whatever
happens to the note afterwards. Inlining keeps the bucket private and keeps an
unpublished note unreachable.

This runs in the ``deliver`` background task, never in
``collect_publish_actions``: that one is called from inside the push
transaction, which holds a per-user advisory lock until it commits, and S3 round
trips inside that window are exactly how this backend wedged its connection pool
in September.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import re

from sqlalchemy import select

from app.db import SessionLocal
from app.models import NoteImage
from app.storage import get_object_bytes, is_configured

log = logging.getLogger(__name__)

_REF = re.compile(r'src="wn-img:([A-Za-z0-9_-]+)"')

# Images larger than this are left as a reference (and so dropped by the
# portfolio's own sanitizer) rather than inlined. A published page is one HTML
# document; a few of these would make it slower to load than it is worth. Images
# are downscaled when they're inserted, so reaching this means something unusual.
_MAX_INLINE_BYTES = 4 * 1024 * 1024


async def inline_note_images(user_id: str, html: str) -> str:
    """Replace this body's image references with ``data:`` URIs.

    Never raises and never partially mangles a body: anything that fails leaves
    the reference in place, which the portfolio drops. A body with no images —
    almost all of them — costs one regex and returns immediately.
    """
    if not html:
        return html
    ids = set(_REF.findall(html))
    if not ids or not is_configured():
        return html

    try:
        data_uris = await _fetch(user_id, ids)
    except Exception:
        log.exception("publish: resolving images for %s failed", user_id)
        return html

    def replace(match: re.Match[str]) -> str:
        uri = data_uris.get(match.group(1))
        return f'src="{uri}"' if uri else match.group(0)

    return _REF.sub(replace, html)


async def _fetch(user_id: str, ids: set[str]) -> dict[str, str]:
    """`id → data: URI` for every image whose bytes we can actually get."""
    async with SessionLocal() as session:
        result = await session.execute(
            select(NoteImage).where(
                NoteImage.user_id == user_id,
                NoteImage.id.in_(ids),
                NoteImage.deleted_at.is_(None),
                NoteImage.remote_key.is_not(None),
            )
        )
        rows = list(result.scalars().all())

    out: dict[str, str] = {}
    for row in rows:
        if row.file_size and row.file_size > _MAX_INLINE_BYTES:
            continue
        try:
            # boto3 is blocking; this runs on the event loop that is serving
            # every other request.
            raw = await asyncio.to_thread(get_object_bytes, row.remote_key)
        except Exception:
            log.exception("publish: reading image %s failed", row.id)
            continue
        if len(raw) > _MAX_INLINE_BYTES:
            continue
        mime = row.mime_type or "image/png"
        out[row.id] = f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"
    return out
