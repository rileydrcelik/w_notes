"""Reading a caller's own provider token.

The one place plugin routes get a credential. It exists so that "which token do
we act as?" has exactly one answer, and that answer is never "the operator's".

Before per-user credentials, `/github/*` used a single server-wide PAT and every
route bound `user` without reading it. The result was reported from the field: a
second person opened the GitHub plugin and was shown the operator's private
repositories, because `GET /github/repos` is documented as "every repo the
server token can see". That is the failure this module removes.

**Fails closed.** No credential means 503 with an actionable message, never a
fallback to the operator's token. An account that has not supplied a PAT simply
cannot use the GitHub plugin.
"""

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.crypto import (
    CredentialDecryptionError,
    SecretStorageUnavailable,
    decrypt,
)
from app.models import UserCredential

# Providers a user can store a token for. Kept here rather than in the model so
# the DB doesn't need a migration to learn a new one.
PROVIDERS = ("github", "sentry")

_LABEL = {"github": "GitHub", "sentry": "Sentry"}


def _settings_hint(provider: str) -> str:
    return (
        f"No {_LABEL.get(provider, provider)} token saved for this account. "
        f"Add one in Settings → Plugins."
    )


async def get_user_token(
    session: AsyncSession, user_id: str, provider: str
) -> str | None:
    """The caller's decrypted token, or None if they haven't saved one.

    Raises (rather than returning None) when a row exists but cannot be
    decrypted: that means the encryption key changed without re-encryption, and
    reporting it as "no token saved" would send the user off to re-enter a
    credential that is already there.
    """
    row = (
        await session.execute(
            select(UserCredential).where(
                UserCredential.user_id == user_id,
                UserCredential.provider == provider,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    try:
        return decrypt(row.token_encrypted)
    except SecretStorageUnavailable as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Credential storage is not configured on this server",
        ) from exc
    except CredentialDecryptionError as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            f"Saved {_LABEL.get(provider, provider)} token could not be read "
            "(server key changed). Re-save it in Settings → Plugins.",
        ) from exc


async def require_user_token(
    session: AsyncSession, user_id: str, provider: str
) -> str:
    """The caller's token, or 503 telling them where to add one."""
    token = await get_user_token(session, user_id, provider)
    if not token:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, _settings_hint(provider)
        )
    return token
