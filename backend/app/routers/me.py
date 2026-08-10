"""The signed-in account's own settings — today, just its Anthropic API key.

Deliberately not part of ``/sync``. Everything in the sync payload is content
the client owns and holds a full local copy of; a credential is the opposite of
that. It goes up once, is stored sealed, and never comes back down — so it
exists on exactly one device (the one that typed it) and in one column, rather
than on every device the account has ever touched.

Nothing here returns a key. ``GET`` answers the only three questions the UI
actually has: is one set, which one is it (last four), and does this account
even need one.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai_access import is_owner, stored_key
from app.config import get_settings
from app.crypto import SecretStorageUnavailable, hint_for, seal
from app.db import get_session
from app.deps import get_current_user
from app.models import User

router = APIRouter(prefix="/me", tags=["me"])

# Anthropic keys start `sk-ant-`. Checked here so a typo — a pasted placeholder,
# half a key, the *Sentry* token from the next field along — is refused while the
# person is still looking at the field they typed it into, rather than becoming a
# 401 from Anthropic three screens later inside a resume tailor.
#
# A prefix check, not a length or charset one: the prefix is documented and
# stable, while key length is Anthropic's to change and a rule about it would
# eventually reject a valid key for no reason.
_KEY_PREFIX = "sk-ant-"


class AiKeyState(BaseModel):
    """What the client needs to draw the AI section of Settings."""

    configured: bool
    # Last four characters of the stored key, or None when there isn't one.
    hint: str | None = None
    # True when this account rides the server's key and needs none of its own.
    # The UI says so rather than showing an empty field that changes nothing.
    owner: bool = False
    # False when the server has no `app_secret_key` and so cannot store a key at
    # all. The field would otherwise accept input and silently fail.
    can_store: bool = True


class AiKeyRequest(BaseModel):
    key: str = Field(min_length=1, max_length=500)


async def _write_key(session: AsyncSession, user: User, ct: str | None, hint: str | None) -> None:
    """Persist the key columns with an explicit UPDATE, not by mutating `user`.

    `get_current_user` hands back a **detached** row on purpose: it resolves the
    account in a short-lived session and closes it, so a slow upstream call never
    sits on a pooled connection (see the note in `deps.py`). `user` therefore
    belongs to no session, and assigning to its attributes and committing this
    one would write nothing at all — quietly, with a 200 on the way out. An
    UPDATE by id sidesteps the question entirely.

    The in-memory row is updated to match afterwards, so the response describes
    what was just stored rather than what was there when the request arrived.
    """
    await session.execute(
        update(User)
        .where(User.id == user.id)
        .values(anthropic_key_ct=ct, anthropic_key_hint=hint)
    )
    await session.commit()
    user.anthropic_key_ct = ct
    user.anthropic_key_hint = hint


def _state(settings, user: User) -> AiKeyState:
    return AiKeyState(
        configured=bool(user.anthropic_key_ct) or is_owner(settings, user),
        hint=user.anthropic_key_hint,
        owner=is_owner(settings, user),
        can_store=bool(settings.app_secret_key),
    )


@router.get("/ai-key", response_model=AiKeyState)
async def read_ai_key(user: User = Depends(get_current_user)) -> AiKeyState:
    """Whether this account can use the AI features, and on whose key."""
    return _state(get_settings(), user)


@router.put("/ai-key", response_model=AiKeyState)
async def store_ai_key(
    payload: AiKeyRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> AiKeyState:
    """Store (or replace) this account's Anthropic key.

    The key is verified only for shape, not by calling Anthropic. A live check
    would be a nicer confirmation and a worse trade: it spends a request on
    someone else's account to answer a question the first real use answers
    anyway, and it would make saving a key fail whenever Anthropic is having a
    bad afternoon.
    """
    key = payload.key.strip()
    if not key.startswith(_KEY_PREFIX):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That doesn't look like an Anthropic API key — they start with 'sk-ant-'.",
        )

    try:
        sealed = seal(key)
    except SecretStorageUnavailable:
        # Nothing the caller did. Say it is the server, so nobody retypes a
        # perfectly good key three times.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="This server is not set up to store API keys.",
        ) from None

    await _write_key(session, user, sealed, hint_for(key))
    return _state(get_settings(), user)


@router.delete("/ai-key", response_model=AiKeyState)
async def forget_ai_key(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> AiKeyState:
    """Forget this account's key. Both columns, so no hint outlives the key it
    describes and claims a key is stored when none is."""
    await _write_key(session, user, None, None)
    return _state(get_settings(), user)


__all__ = ["router", "stored_key"]
