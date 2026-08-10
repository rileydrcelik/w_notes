"""Symmetric encryption for the few secrets this server stores *on behalf of*
someone else — today, a user's own Anthropic API key.

Everything else the API holds is either the caller's own content (notes, which
they can already read) or a server credential that never touches the database
(``sentry_api_token``, ``github_token``, injected from SSM). A user's API key is
the first thing that is neither: a live credential, belonging to someone else,
that has to survive a restart and so has to be written down.

Fernet, from ``cryptography``. Authenticated (AES-CBC + HMAC), so a tampered
ciphertext fails loudly rather than decrypting to rubbish, and versioned, so the
format can move later. The key comes from ``app_secret_key`` — SSM in a
deployment, ``.env`` locally — and is never derived from anything in the
database, which is the whole point: a dump of Postgres on its own decrypts
nothing.

**Losing the key loses the ciphertexts.** That is a deliberate trade and an
acceptable one here: the plaintext is a credential the user can revoke and
re-enter in a minute, and the alternative — a key stored somewhere the database
can reach — buys recoverability by removing the protection.
"""

from __future__ import annotations

from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


class SecretStorageUnavailable(RuntimeError):
    """No ``app_secret_key`` is configured, so nothing can be sealed or opened.

    Raised rather than silently falling back to storing plaintext. A server that
    quietly downgraded would look identical to a working one right up until
    someone read the table.
    """


@lru_cache
def _fernet(key: str) -> Fernet:
    """Cached per key string — building a Fernet parses and validates the key,
    and this runs on every request that touches a stored credential."""
    return Fernet(key.encode("utf-8"))


def _cipher() -> Fernet:
    key = get_settings().app_secret_key
    if not key:
        raise SecretStorageUnavailable("app_secret_key is not configured")
    try:
        return _fernet(key)
    except (ValueError, TypeError) as exc:
        # A malformed key is a deploy error, not a request error. Say so in the
        # exception rather than letting a base64 complaint reach a caller who
        # can do nothing about it.
        raise SecretStorageUnavailable(
            "app_secret_key is not a valid Fernet key (32 url-safe base64 bytes)"
        ) from exc


def seal(plaintext: str) -> str:
    """Encrypt a secret for storage. The result is safe to put in a text column."""
    return _cipher().encrypt(plaintext.encode("utf-8")).decode("ascii")


def open_sealed(ciphertext: str) -> str | None:
    """Decrypt a stored secret, or None if it cannot be read.

    None rather than an exception for the one failure that is *expected* in
    normal operation: a ciphertext written under a key this server no longer
    has. That is a user whose stored credential is gone, which the caller
    handles the same way it handles a user who never set one — ask for it again.
    A missing `app_secret_key` still raises, because that is a broken deploy
    rather than a broken row.
    """
    # Built before the `try`, so a broken deploy still raises rather than being
    # mistaken for an unreadable row.
    cipher = _cipher()
    try:
        return cipher.decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        # `InvalidToken` covers what Fernet itself rejects — a token sealed under
        # a key we no longer have, and malformed base64, which it folds into the
        # same error. What it never sees is a column that isn't ASCII at all:
        # that dies in `.encode("ascii")` one line earlier, as `UnicodeEncodeError`.
        # `ValueError` is its base class, and also covers a decrypted payload
        # that isn't UTF-8. Only `seal()` writes here so none of this should
        # happen — but "unreadable credential" is a case the caller already
        # handles, and a 500 is not.
        return None


def hint_for(plaintext: str) -> str:
    """The last four characters, for showing someone which key is stored.

    Enough to answer "is this the one I think it is?" against a key they can see
    in the Anthropic console, and useless to anyone else. Deliberately not the
    *first* characters: an Anthropic key's prefix is a constant (``sk-ant-``)
    plus an account-identifying segment, so a prefix would say more about whose
    key it is while saying nothing about which.
    """
    return plaintext[-4:]
