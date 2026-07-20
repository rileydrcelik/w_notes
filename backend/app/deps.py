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
import uuid

import firebase_admin
from firebase_admin import auth as firebase_auth, credentials
from fastapi import Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import SessionLocal
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


async def _get_or_create_user(
    session: AsyncSession, *, column, value: str, conflict_on: str, **extra
) -> User:
    """Resolve the user identified by ``column == value``, creating it on a miss.

    A plain SELECT-then-INSERT races: two requests arriving together for an
    identity the server has never seen both miss the SELECT, both INSERT, and the
    second dies on the unique index. That's a 500 on a device's very first
    contact — reachable from two browser tabs sharing a device key, and from any
    concurrency the client grows later.

    ``ON CONFLICT DO NOTHING`` makes the insert idempotent instead. When another
    transaction is mid-insert, Postgres blocks until it commits and then skips
    ours, so the re-SELECT below finds their row. Both requests end up on one
    user, which is the point — a second user row would silently fork the
    device's data.
    """
    found = (await session.execute(select(User).where(column == value))).scalar_one_or_none()
    if found is not None:
        return found

    await session.execute(
        pg_insert(User)
        .values(id=str(uuid.uuid4()), **{column.key: value}, **extra)
        .on_conflict_do_nothing(index_elements=[conflict_on])
    )

    found = (await session.execute(select(User).where(column == value))).scalar_one_or_none()
    if found is None:
        # The insert was skipped but the row still isn't there — the conflict was
        # on some *other* unique column (e.g. an email already attached to a
        # different uid), which is a real conflict rather than a race.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Could not resolve account; conflicting identity",
        )
    return found


async def _user_by_firebase(session: AsyncSession, uid: str, email: str | None) -> User:
    return await _get_or_create_user(
        session, column=User.firebase_uid, value=uid, conflict_on="firebase_uid", email=email
    )


async def _user_by_device_key(session: AsyncSession, device_key: str) -> User:
    return await _get_or_create_user(
        session, column=User.device_key, value=device_key, conflict_on="device_key"
    )


async def get_current_user(
    authorization: str | None = Header(default=None),
) -> User:
    token = _bearer(authorization)

    # Verify the token *before* touching the pool, so token verification (which
    # can make its own network call) never holds a DB connection.
    uid: str | None = None
    email: str | None = None
    app = _firebase()
    if app is not None and _looks_like_jwt(token):
        try:
            decoded = firebase_auth.verify_id_token(token, app=app)
        except Exception as exc:  # invalid/expired token, clock skew, etc.
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Firebase ID token",
            ) from exc
        uid, email = decoded["uid"], decoded.get("email")

    # Resolve (and lazily create) the user in a short-lived session so the pooled
    # connection is returned as soon as auth is done — NOT held for the whole
    # request. Endpoints that then do slow upstream I/O (the /sentry proxy's httpx
    # calls) would otherwise keep a connection checked out idle for the duration,
    # exhausting the QueuePool under concurrent load and timing out every request
    # — including /health. `expire_on_commit=False` keeps the returned User's
    # already-loaded columns usable after the session closes.
    async with SessionLocal() as session:
        if uid is not None:
            user = await _user_by_firebase(session, uid, email)
        else:
            # Anonymous pre-login identity.
            user = await _user_by_device_key(session, token)
        await session.commit()
        return user
