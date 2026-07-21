"""Mirror published notes onto the public portfolio site.

A note with ``published=true`` becomes a post in the portfolio's ``notes``
category; clearing the flag (or trashing the note) removes it again. The
portfolio owns its own database, so this is a one-way replication over HTTP —
w_notes is the source of truth and the portfolio holds a derived copy.

Shape of the integration:

- **Trigger.** ``/sync/push`` calls :func:`collect_publish_actions` after its
  flush, so it reads back what the upsert actually *stored*. That matters:
  last-writer-wins can reject an incoming row as stale, and publishing the
  rejected version would put content on the website that no device holds.
- **Delivery.** The HTTP calls run in a FastAPI background task
  (:func:`deliver`), after the response is returned. A portfolio outage must
  never fail a user's sync — the notes app is the product, the website is a
  side effect. Failures are logged and reported to Sentry, not retried; the
  next edit to the note republishes it.
- **Authorization.** Only accounts whose email is in ``publisher_emails`` may
  publish. This API is multi-tenant and the portfolio is one specific person's
  website. Anonymous device-key accounts have no email and so never qualify.

Body handling: note bodies are the app's canonical rich-text HTML, wrapped in
``<html>…</html>``. We strip that wrapper and send the inner fragment. The
portfolio sanitizes it on arrival — sanitizing at the trust boundary that
renders the markup, not the one that emits it.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import httpx
import sentry_sdk
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import Folder, Note, User

log = logging.getLogger(__name__)

# Notes with no folder land in a default album — the portfolio requires every
# post to belong to one, and its feed uses albums as the category's filter tabs.
DEFAULT_ALBUM = "notes"

# Total budget for one ingest call. Generous: this is off the request path.
_TIMEOUT = httpx.Timeout(10.0)

# The `<html>` wrapper `tiptapHtmlToStored` adds around every stored body.
_HTML_WRAPPER = re.compile(r"^\s*<html>(.*)</html>\s*$", re.DOTALL | re.IGNORECASE)


@dataclass(frozen=True)
class PublishAction:
    """One note's desired state on the portfolio, resolved from stored rows."""

    note_id: str
    # False => the note should be absent from the site (unpublished or trashed).
    present: bool
    payload: dict | None = None


def strip_html_wrapper(body: str) -> str:
    """Return the inner fragment of a stored rich-text body.

    Bodies round-trip through the editor as ``<html>…</html>``; the wrapper is a
    storage artifact the native editor needs, not content. An unwrapped body
    (older note, or already a fragment) passes through untouched.
    """
    if not body:
        return ""
    match = _HTML_WRAPPER.match(body)
    return match.group(1).strip() if match else body.strip()


def _title_for(note: Note) -> str:
    """Posts require a non-empty title; untitled notes get a stable stand-in."""
    return note.title.strip() or "Untitled note"


async def collect_publish_actions(
    session: AsyncSession,
    user: User,
    note_ids: list[str],
) -> list[PublishAction]:
    """Resolve what the portfolio should hold for the notes just pushed.

    Reads the *stored* rows (post-flush) rather than trusting the incoming
    payload, so a push that last-writer-wins rejected as stale publishes
    nothing. Returns an empty list when publishing is disabled or the caller
    isn't an authorized publisher — the caller then skips delivery entirely.
    """
    settings = get_settings()
    if not settings.publishing_enabled:
        return []
    # An anonymous device-key account has no email and therefore no way to match
    # the allowlist — publishing requires a signed-in, named account.
    if not user.email or user.email.lower() not in settings.publisher_email_set:
        return []
    if not note_ids:
        return []

    user_id = user.id

    rows = (
        await session.execute(
            select(Note).where(Note.user_id == user_id, Note.id.in_(note_ids))
        )
    ).scalars().all()

    # Resolve folder names in one query — the folder's name becomes the post's
    # album, so the website's notes feed gets the same album tabs every other
    # category has.
    folder_ids = {n.folder_id for n in rows if n.folder_id}
    folder_names: dict[str, str] = {}
    if folder_ids:
        folders = (
            await session.execute(
                select(Folder).where(
                    Folder.user_id == user_id, Folder.id.in_(folder_ids)
                )
            )
        ).scalars().all()
        folder_names = {f.id: f.name.strip() for f in folders if f.name.strip()}

    actions: list[PublishAction] = []
    for note in rows:
        # A trashed or soft-deleted note comes off the site regardless of flag.
        live = note.deleted_at is None and note.trashed_with_folder_id is None
        if not (note.published and live):
            actions.append(PublishAction(note_id=note.id, present=False))
            continue

        actions.append(
            PublishAction(
                note_id=note.id,
                present=True,
                payload={
                    "source_id": note.id,
                    "title": _title_for(note),
                    "body_html": strip_html_wrapper(note.body or ""),
                    "album": folder_names.get(note.folder_id or "", DEFAULT_ALBUM),
                    "is_favorite": bool(note.favorite),
                    # The portfolio feed sorts on `date`; using the note's own
                    # updated_at is what floats an edited note back to the top.
                    "updated_at_ms": note.updated_at,
                    "created_at_ms": note.created_at,
                },
            )
        )
    return actions


async def deliver(actions: list[PublishAction]) -> None:
    """Apply `actions` against the portfolio's ingest API.

    Runs as a background task, so it must swallow everything: an exception here
    surfaces as an unhandled error in the ASGI layer long after the user's sync
    succeeded. Each note is independent — one failure doesn't stop the rest.
    """
    if not actions:
        return
    settings = get_settings()
    if not settings.publishing_enabled:
        return

    base = settings.portfolio_api_base.rstrip("/")
    headers = {"X-Ingest-Secret": settings.portfolio_ingest_secret}

    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=headers) as client:
        for action in actions:
            try:
                if action.present:
                    response = await client.post(
                        f"{base}/api/notes/ingest", json=action.payload
                    )
                else:
                    response = await client.delete(
                        f"{base}/api/notes/ingest/{action.note_id}"
                    )
                # A delete of a note that was never published is the normal case
                # for every edit to an unpublished note — not worth reporting.
                if response.status_code == 404 and not action.present:
                    continue
                response.raise_for_status()
            except Exception as exc:  # noqa: BLE001 — background task, isolate
                log.warning(
                    "publish: note %s (present=%s) failed: %s",
                    action.note_id,
                    action.present,
                    exc,
                )
                sentry_sdk.capture_exception(exc)
