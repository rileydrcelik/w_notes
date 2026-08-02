"""Encryption for per-user provider tokens (GitHub PATs, Sentry API tokens).

These are other people's credentials, which makes the database holding them a
target it wasn't before. Fernet (AES-128-CBC + HMAC-SHA256, from `cryptography`)
gives authenticated symmetric encryption with a key that lives in SSM rather
than in the database, so a dump of the `user_credentials` table on its own
yields nothing usable.

**Fails closed.** With no key configured, `encrypt` and `decrypt` both raise
rather than falling back to storing plaintext. A misconfigured deployment loses
the GitHub and Sentry plugins; it does not silently start writing PATs in the
clear.

Rotation is why `decrypt` accepts two keys: writes always use the current key,
reads try current-then-old, so a rotation can proceed while rows are still
encrypted under the previous one. A row is migrated whenever it is next written.
"""

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


class CredentialCryptoUnavailable(RuntimeError):
    """No usable encryption key is configured."""


class CredentialDecryptionError(RuntimeError):
    """A stored value could not be decrypted with any configured key.

    Means the key changed without the row being re-encrypted (or the row is
    corrupt). Deliberately distinct from "no credential stored": the caller must
    not treat it as absence, or a key mistake would look like every user having
    quietly forgotten their token.
    """


def _fernets() -> list[Fernet]:
    """Current key first, then the rotation key if one is set."""
    settings = get_settings()
    keys = [settings.credential_encryption_key, settings.credential_encryption_key_old]
    out: list[Fernet] = []
    for key in keys:
        if not key:
            continue
        try:
            out.append(Fernet(key.encode()))
        except (ValueError, TypeError) as exc:
            # A malformed key is a deployment error, not a per-request one.
            raise CredentialCryptoUnavailable(
                "credential_encryption_key is not a valid Fernet key"
            ) from exc
    return out


def crypto_available() -> bool:
    """Whether a usable key is configured. Lets routes answer 503 up front."""
    return bool(get_settings().credential_encryption_key)


def encrypt(plaintext: str) -> str:
    """Encrypt with the *current* key. Raises if none is configured."""
    fernets = _fernets()
    if not fernets:
        raise CredentialCryptoUnavailable("No credential encryption key configured")
    return fernets[0].encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    """Decrypt, trying the current key then the rotation key."""
    fernets = _fernets()
    if not fernets:
        raise CredentialCryptoUnavailable("No credential encryption key configured")
    for f in fernets:
        try:
            return f.decrypt(ciphertext.encode()).decode()
        except InvalidToken:
            continue
    raise CredentialDecryptionError(
        "Stored credential could not be decrypted with any configured key"
    )
