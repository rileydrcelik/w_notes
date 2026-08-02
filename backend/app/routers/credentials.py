"""Managing your own provider tokens.

Write-only by design: a token goes in and never comes back out. `GET` reports
*whether* one is saved and its last four characters, which is enough for the
Settings screen to show "saved …ab12" without the API ever being a way to
exfiltrate a stored PAT — including by the account that owns it, since a stolen
session should not yield a reusable GitHub credential.

Every route is scoped to `user.id` from the bearer token, so there is no path to
another account's credential.
"""

import time

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.credentials import PROVIDERS
from app.crypto import CredentialCryptoUnavailable, crypto_available, encrypt
from app.db import get_session
from app.deps import get_current_user
from app.models import User, UserCredential

router = APIRouter(prefix="/credentials", tags=["credentials"])


class CredentialStatus(BaseModel):
    provider: str
    saved: bool
    # Last 4 characters of the token, "" when nothing is saved.
    hint: str = ""
    updated_at: int | None = None


class CredentialList(BaseModel):
    credentials: list[CredentialStatus]


class CredentialIn(BaseModel):
    # A GitHub PAT is 40+ chars and a Sentry token 64; the floor only catches
    # obvious mistakes (a pasted username, an empty field) before they reach the
    # provider as a confusing 401. The ceiling bounds what we agree to encrypt.
    token: str = Field(min_length=8, max_length=500)


def _validate_provider(provider: str) -> str:
    if provider not in PROVIDERS:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Unknown provider (expected one of: {', '.join(PROVIDERS)})",
        )
    return provider


@router.get("", response_model=CredentialList)
async def list_credentials(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> CredentialList:
    """Which providers this account has a token for. Never returns a token."""
    rows = (
        await session.execute(
            select(UserCredential).where(UserCredential.user_id == user.id)
        )
    ).scalars()
    by_provider = {r.provider: r for r in rows}
    return CredentialList(
        credentials=[
            CredentialStatus(
                provider=p,
                saved=p in by_provider,
                hint=by_provider[p].hint if p in by_provider else "",
                updated_at=by_provider[p].updated_at if p in by_provider else None,
            )
            for p in PROVIDERS
        ]
    )


@router.put("/{provider}", response_model=CredentialStatus)
async def save_credential(
    provider: str,
    body: CredentialIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> CredentialStatus:
    """Store (or replace) this account's token for one provider."""
    _validate_provider(provider)
    if not crypto_available():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Credential storage is not configured on this server",
        )

    # Surrounding whitespace is the single most common paste error and turns
    # into an opaque 401 from the provider.
    token = body.token.strip()
    if not token:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Token is empty")

    try:
        ciphertext = encrypt(token)
    except CredentialCryptoUnavailable as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Credential storage is not configured on this server",
        ) from exc

    now = int(time.time() * 1000)
    hint = token[-4:]
    stmt = (
        pg_insert(UserCredential)
        .values(
            user_id=user.id,
            provider=provider,
            token_encrypted=ciphertext,
            hint=hint,
            created_at=now,
            updated_at=now,
        )
        .on_conflict_do_update(
            index_elements=["user_id", "provider"],
            set_={"token_encrypted": ciphertext, "hint": hint, "updated_at": now},
        )
    )
    await session.execute(stmt)
    await session.commit()
    return CredentialStatus(provider=provider, saved=True, hint=hint, updated_at=now)


@router.delete("/{provider}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_credential(
    provider: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Forget this account's token for one provider.

    Idempotent: deleting a credential that isn't there is a 204, not a 404, so
    a Settings screen clearing a field it isn't sure about can't fail.
    """
    _validate_provider(provider)
    await session.execute(
        delete(UserCredential).where(
            UserCredential.user_id == user.id,
            UserCredential.provider == provider,
        )
    )
    await session.commit()
