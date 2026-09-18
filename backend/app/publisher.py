"""Keep embedded notes fresh on the portfolio site.

Placement belongs to the website: a note is embedded into a subject from the
portfolio admin. This side only keeps what was placed up to date — an edit
refreshes the embedded post and floats it to the top of the feed, and trashing
a note removes it wherever it was placed. The portfolio owns its own database,
so this is a one-way replication over HTTP; w_notes is the source of truth.

Crucially it never *creates* a post: this pushes every edit without knowing
which notes are embedded, so creating here would put unplaced notes on the site
unbidden. The portfolio's update endpoint matches on the note id and answers a
note nobody embedded with `404 {"detail": "Note is not embedded anywhere"}` --
the ordinary case, and the reason a 404 here is not on its own a failure. See
:func:`_handler_said_not_embedded` for how that is told apart from the 404 that
does matter.

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
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import SessionLocal, lock_user
from app.models import Folder, Note, User
from app.note_image_inline import inline_note_images

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
        # Presence is decided by whether the note still exists, and nothing else.
        #
        # It used to also require `published`, from when the app chose what to
        # publish. The website owns placement now, that flag is vestigial and
        # always false, and leaving it in this condition meant *every* edit
        # resolved to "should not be present" and deleted the embedded post.
        # Whether a note is embedded is the portfolio's business: the update is
        # update-only there and a note nobody embedded simply has nothing to
        # match.
        live = note.deleted_at is None and note.trashed_with_folder_id is None
        if not live:
            # Trashed or deleted: take it off the site wherever it was placed.
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


def _handler_said_not_embedded(response: httpx.Response) -> bool:
    """Whether a 404 came from the ingest handler, not from a missing route.

    The portfolio is update-only by design: placement happens in its admin, and
    this side pushes every edit without knowing what was placed. So it answers
    an upsert or delete for an unplaced note with

        404 {"detail": "Note is not embedded anywhere"}

    which is the ordinary case for most notes, not a failure.

    The failure worth shouting about 404s identically: if the endpoint is
    removed, renamed or misrouted, every publish stops and nothing says so. What
    separates them is who answered. The handler returns JSON naming its reason;
    an unrouted path falls through to Starlette's bare ``{"detail": "Not
    Found"}``, and a proxy or a wrong host returns HTML or nothing parseable.
    Only the first is ordinary.

    Deliberately keyed on "the application answered at all" rather than on the
    exact sentence, which is the portfolio's to reword. Getting this wrong in
    the safe direction costs one spurious Sentry report; the other direction
    hides an outage, which is how this arrived here in the first place.
    """
    try:
        detail = response.json().get("detail")
    except ValueError:
        return False
    return isinstance(detail, str) and detail.strip().casefold() != "not found"


async def record_embedded(user_id: str, answers: dict[str, bool]) -> None:
    """Store the portfolio's answers on the notes, for the app to show.

    The first thing in this codebase that writes into the sync stream from
    anywhere but a client push, so three guarantees the push path gets for free
    have to be re-established by hand:

    * **``server_seq`` is bumped explicitly.** Its column default fires on INSERT
      only, so a plain UPDATE leaves the row's stamp where it was, below every
      device's cursor — the value would be stored and never delivered to anyone.
    * **The per-user advisory lock is taken**, exactly as ``/sync/push`` does.
      Without it this can draw a sequence number, stall before committing, and
      have a concurrent push take a *later* number and commit first; a device
      that pulls in between stores the higher cursor and skips this row forever.
    * **``updated_at`` is left alone.** Sync is last-writer-wins on it in both
      directions, so bumping it would let this row beat a device's unpushed edit
      and overwrite a newer body with an older one — real data loss, from a write
      that only ever meant to set a flag.

    ``IS DISTINCT FROM`` keeps an unchanged answer a true no-op, so the common
    case — a note that was not embedded yesterday and still isn't — costs no
    sequence number and sends no row to any device.

    Best-effort, like everything else here: this runs after the response, and a
    failure means a stale flag that the next edit corrects.
    """
    if not answers:
        return
    try:
        async with SessionLocal() as session:
            await lock_user(session, user_id)
            for note_id, embedded in answers.items():
                await session.execute(
                    update(Note)
                    .where(
                        Note.user_id == user_id,
                        Note.id == note_id,
                        Note.embedded.is_distinct_from(embedded),
                    )
                    .values(embedded=embedded, server_seq=text("nextval('sync_seq')"))
                )
            await session.commit()
    except Exception as exc:  # noqa: BLE001 — background task, isolate
        log.warning("publish: recording embedded state for %s failed: %s", user_id, exc)
        sentry_sdk.capture_exception(exc)


async def deliver(actions: list[PublishAction], user_id: str | None = None) -> None:
    """Apply `actions` against the portfolio's ingest API.

    Runs as a background task, so it must swallow everything: an exception here
    surfaces as an unhandled error in the ASGI layer long after the user's sync
    succeeded. Each note is independent — one failure doesn't stop the rest.

    The portfolio's answer to each push says whether it has that note placed,
    which is the only way this side can know. With `user_id`, those answers are
    recorded on the notes afterwards (see :func:`record_embedded`) so the app can
    show it. All of the HTTP happens first: the write takes a per-user lock, and
    holding that across ten-second-timeout requests would serialize every other
    sync for the user behind a delivery.
    """
    if not actions:
        return
    settings = get_settings()
    if not settings.publishing_enabled:
        return

    # Only definite answers land here. A timeout, a 5xx, or a 404 from something
    # that isn't the ingest handler all leave the stored value alone — "we could
    # not ask" must never be recorded as "the site does not have it", or an
    # outage reads as every note being dropped from the portfolio at once.
    answers: dict[str, bool] = {}

    base = settings.portfolio_api_base.rstrip("/")
    headers = {"X-Ingest-Secret": settings.portfolio_ingest_secret}

    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=headers) as client:
        for action in actions:
            try:
                if action.present:
                    payload = action.payload
                    # Images are references (`wn-img:<id>`) that mean nothing off
                    # this device; resolve them to bytes the site can render.
                    # Here rather than in `collect_publish_actions`, which runs
                    # inside the push transaction holding the advisory lock.
                    if user_id:
                        payload = {
                            **payload,
                            "body_html": await inline_note_images(
                                user_id, payload.get("body_html", "")
                            ),
                        }
                    response = await client.post(
                        f"{base}/api/notes/ingest", json=payload
                    )
                else:
                    response = await client.delete(
                        f"{base}/api/notes/ingest/{action.note_id}"
                    )
                # 404 is the ordinary outcome on both verbs: this pushes every
                # edit without knowing which notes are embedded, and the
                # portfolio answers for one nobody placed with
                # `{"detail": "Note is not embedded anywhere"}`. Most notes are
                # not embedded, so reporting those buries real errors in noise —
                # 838 Sentry events in a month, and the endpoint was healthy the
                # whole time.
                #
                # But a missing or misrouted endpoint 404s too, and that one
                # means *every* publish is failing silently. The two are
                # distinguishable at the body: the handler names its reason,
                # while an unrouted path gets Starlette's bare
                # `{"detail": "Not Found"}` and a proxy's gets HTML.
                if response.status_code == 404 and _handler_said_not_embedded(response):
                    # The handler answered, and its answer is "not embedded" —
                    # a definite no, for an upsert or a delete alike.
                    answers[action.note_id] = False
                    continue
                response.raise_for_status()
                # It answered without complaint: for an upsert the note is
                # placed; for a delete it was, and now is not.
                answers[action.note_id] = action.present
            except Exception as exc:  # noqa: BLE001 — background task, isolate
                log.warning(
                    "publish: note %s (present=%s) failed: %s",
                    action.note_id,
                    action.present,
                    exc,
                )
                sentry_sdk.capture_exception(exc)

    if user_id and answers:
        await record_embedded(user_id, answers)
