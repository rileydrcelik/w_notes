"""Request dependencies — turns the device key into a durable user row."""

from __future__ import annotations

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import User


async def get_current_user(
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> User:
    """Resolve (or lazily create) the user behind an ``Authorization: Bearer
    <device-key>`` header.

    The anonymous device key is the first credential type; get-or-create means a
    fresh install starts syncing with no signup step. When real auth lands, the
    same lookup just gains email/password credential types pointing at this row.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer device key",
        )
    device_key = authorization.split(" ", 1)[1].strip()
    if not device_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Empty device key"
        )

    user = (
        await session.execute(select(User).where(User.device_key == device_key))
    ).scalar_one_or_none()
    if user is None:
        user = User(device_key=device_key)
        session.add(user)
        await session.flush()  # assigns user.id within this transaction
    return user
