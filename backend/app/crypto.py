"""Symmetric encryption for the secrets this server stores *on behalf of*
someone else — a user's own Anthropic API key, and their GitHub and Sentry
provider tokens.

Everything else the API holds is either the caller's own content (notes, which
they can already read) or a server credential that never touches the database
(injected from SSM). These are the things that are neither: live credentials,
belonging to someone else, that have to survive a restart and so have to be
written down. That makes the database holding them a target it wasn't before.

Fernet, from ``cryptography``. Authenticated (AES-CBC + HMAC), so a tampered
ciphertext fails loudly rather than decrypting to rubbish, and versioned, so the
format can move later. The key comes from ``app_secret_key`` — SSM in a
deployment, ``.env`` locally — and is never derived from anything in the
database, which is the whole point: a dump of Postgres on its own decrypts
nothing.

**Fails closed.** With no key configured, sealing and opening both raise rather
than falling back to plaintext. A server that quietly downgraded would look
identical to a working one right up until someone read the table.

**Losing the key loses the ciphertexts.** That is a deliberate trade and an
acceptable one here: every plaintext under this key is a credential the user can
revoke and re-enter in a minute, and the alternative — a key stored somewhere the
database can reach — buys recoverability by removing the protection.

Rotation is why reads try two keys: writes always use ``app_secret_key``, reads
try it and then ``app_secret_key_old``, so a rotation can proceed while rows are
still sealed under the previous one. A row is migrated whenever it is next
written.

Note the two read contracts below — ``open_sealed`` treats an unreadable value as
absence and ``decrypt`` refuses to. That difference is deliberate; see each.
"""

from __future__ import annotations

from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


class SecretStorageUnavailable(RuntimeError):
    """No usable ``app_secret_key`` is configured, so nothing can be sealed or
    opened.

    Raised rather than silently falling back to storing plaintext. This is a
    broken deploy, not a broken row, and the difference matters to every caller
    below.
    """


class CredentialDecryptionError(RuntimeError):
    """A stored value could not be opened with any configured key.

    Means the key changed without the row being re-sealed (or the row is
    corrupt). Deliberately distinct from "nothing stored": a caller that treated
    it as absence would turn one key mistake into every user having apparently
    forgotten their token.
    """


@lru_cache
def _fernet(key: str) -> Fernet:
    """Cached per key string — building a Fernet parses and validates the key,
    and this runs on every request that touches a stored credential."""
    return Fernet(key.encode("utf-8"))


def _ciphers() -> list[Fernet]:
    """Current key first, then the rotation key if one is set.

    Empty is impossible: no key at all raises instead, so a caller never has to
    distinguish "no keys" from "none of them worked".
    """
    settings = get_settings()
    keys = [settings.app_secret_key, settings.app_secret_key_old]
    out: list[Fernet] = []
    for key in keys:
        if not key:
            continue
        try:
            out.append(_fernet(key))
        except (ValueError, TypeError) as exc:
            # A malformed key is a deploy error, not a request error. Say so in
            # the exception rather than letting a base64 complaint reach a
            # caller who can do nothing about it.
            raise SecretStorageUnavailable(
                "app_secret_key is not a valid Fernet key (32 url-safe base64 bytes)"
            ) from exc
    if not out:
        raise SecretStorageUnavailable("app_secret_key is not configured")
    return out


def crypto_available() -> bool:
    """Whether a usable key is configured. Lets routes answer 503 up front
    rather than after accepting a credential they can't store."""
    return bool(get_settings().app_secret_key)


def seal(plaintext: str) -> str:
    """Encrypt a secret for storage, with the *current* key. The result is safe
    to put in a text column."""
    return _ciphers()[0].encrypt(plaintext.encode("utf-8")).decode("ascii")


def _try_open(ciphertext: str) -> str | None:
    """The shared read path: each configured key in turn, None if none fit."""
    for cipher in _ciphers():
        try:
            return cipher.decrypt(ciphertext.encode("ascii")).decode("utf-8")
        except (InvalidToken, ValueError):
            # `InvalidToken` covers what Fernet itself rejects — a token sealed
            # under a key we no longer have, and malformed base64, which it
            # folds into the same error. What it never sees is a column that
            # isn't ASCII at all: that dies in `.encode("ascii")` one line
            # earlier, as `UnicodeEncodeError`. `ValueError` is its base class,
            # and also covers a decrypted payload that isn't UTF-8.
            continue
    return None


def open_sealed(ciphertext: str) -> str | None:
    """Decrypt a stored secret, or None if it cannot be read.

    None rather than an exception for the one failure that is *expected* in
    normal operation: a ciphertext written under a key this server no longer
    has. That is a user whose stored credential is gone, which the caller
    handles the same way it handles a user who never set one — ask for it again.
    A missing ``app_secret_key`` still raises, because that is a broken deploy
    rather than a broken row.

    Used for the Anthropic key, where "ask again" is the whole recovery story.
    Provider tokens want `decrypt` instead.
    """
    return _try_open(ciphertext)


def decrypt(ciphertext: str) -> str:
    """Decrypt a stored secret, raising if it cannot be read.

    The counterpart to `open_sealed`, for credentials where silence would be
    misleading. A saved provider token that won't open is still *there* — the
    user has nothing to re-enter and no way to know why the plugin went dark —
    so this raises `CredentialDecryptionError` and the route turns it into a 503
    that names the cause.
    """
    plaintext = _try_open(ciphertext)
    if plaintext is None:
        raise CredentialDecryptionError(
            "Stored credential could not be decrypted with any configured key"
        )
    return plaintext


def hint_for(plaintext: str) -> str:
    """The last four characters, for showing someone which credential is stored.

    Enough to answer "is this the one I think it is?" against a key they can see
    in the provider's console, and useless to anyone else. Deliberately not the
    *first* characters: an Anthropic key's prefix is a constant (``sk-ant-``)
    plus an account-identifying segment, and a GitHub PAT's is ``ghp_``, so a
    prefix would say more about whose credential it is while saying nothing
    about which.
    """
    return plaintext[-4:]
