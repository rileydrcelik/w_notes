"""Request dependencies — resolve the caller to a durable user row.

Two bearer-token shapes are accepted on ``Authorization: Bearer <token>``:

- A **Firebase ID token** (a JWT) once the user has signed in with Google/Apple.
  It's verified with the Firebase Admin SDK and mapped to a user by ``uid``.
- An anonymous **device key** (an opaque UUID) before sign-in, mapped by
  ``device_key``. This keeps offline/pre-login sync working; on first sign-in the
  client merges the device-key user's data into the Firebase account.

Tokens are told apart by shape (a JWT has two dots). Firebase verification is
only attempted when a service-account credential is configured; otherwise only
device keys are accepted.
"""

from __future__ import annotations

import json
import threading

import firebase_admin
from firebase_admin import auth as firebase_auth, credentials
from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.models import User

# Lazily-initialized Firebase app (None when no credentials are configured).
_firebase_app: firebase_admin.App | None = None
_firebase_lock = threading.Lock()


def _load_credential(raw: str) -> credentials.Certificate:
    """Build a Firebase credential from either inline service-account JSON or a
    path to the JSON file. Inline JSON (detected by a leading ``{``) is how the
    deployed container receives it — injected as an env var from a secrets
    manager — while a path stays convenient for local development."""
    stripped = raw.strip()
    if stripped.startswith("{"):
        return credentials.Certificate(json.loads(stripped))
    return credentials.Certificate(stripped)


def _firebase() -> firebase_admin.App | None:
    """Returns the initialized Firebase app, or None if auth isn't configured."""
    global _firebase_app
    if _firebase_app is not None:
        return _firebase_app
    raw = get_settings().firebase_credentials
    if not raw:
        return None
    with _firebase_lock:
        if _firebase_app is None:
            _firebase_app = firebase_admin.initialize_app(_load_credential(raw))
    return _firebase_app


def _looks_like_jwt(token: str) -> bool:
    return token.count(".") == 2


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token"
        )
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Empty bearer token"
        )
    return token


async def _user_by_firebase(session: AsyncSession, uid: str, email: str | None) -> User:
    user = (
        await session.execute(select(User).where(User.firebase_uid == uid))
    ).scalar_one_or_none()
    if user is None:
        user = User(firebase_uid=uid, email=email)
        session.add(user)
        await session.flush()
    return user


async def _user_by_device_key(session: AsyncSession, device_key: str) -> User:
    user = (
        await session.execute(select(User).where(User.device_key == device_key))
    ).scalar_one_or_none()
    if user is None:
        user = User(device_key=device_key)
        session.add(user)
        await session.flush()
    return user


async def get_current_user(
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> User:
    token = _bearer(authorization)

    app = _firebase()
    if app is not None and _looks_like_jwt(token):
        try:
            decoded = firebase_auth.verify_id_token(token, app=app)
        except Exception as exc:  # invalid/expired token, clock skew, etc.
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Firebase ID token",
            ) from exc
        return await _user_by_firebase(session, decoded["uid"], decoded.get("email"))

    # Anonymous pre-login identity.
    return await _user_by_device_key(session, token)
