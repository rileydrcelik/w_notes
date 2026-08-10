"""Whose Anthropic key a request is allowed to spend.

The AI endpoints in ``routers/resume.py`` used to read ``anthropic_api_key``
straight off the settings, which meant every account in a multi-tenant API drew
on the operator's balance. This module is the gate that replaced that read.

Two ways to be allowed through, and no third:

- The account's email is in ``ai_owner_emails``. It spends the server's key,
  the one from SSM. This is the operator riding their own deployment.
- The account has stored a key of its own. It spends that.

Anything else is refused with **402**, which the client reads as "ask for a
key". A distinct status matters more than it usually would: the client has to
tell "you need to set this up" apart from "the model is busy" or "your resume is
too long", and it puts a different thing on screen for each.

The resolved key is delivered as a ``Settings`` copy rather than as an extra
parameter threaded through the call chain. Every helper down there
(``_ask_model``, ``_write_until_it_fits``, ``_tailor``, ``_harden``) already
takes ``settings`` and reads the key off it, so overriding the one field leaves
them untouched and leaves exactly one place — here — that decides whose money is
being spent. ``model_copy`` does not mutate the cached singleton.
"""

from __future__ import annotations

from fastapi import HTTPException, status

from app.config import Settings, get_settings
from app.crypto import SecretStorageUnavailable, open_sealed
from app.models import User

# "Payment Required". Literally the case: the caller has to supply a credential
# that bills them before this endpoint will run.
KEY_REQUIRED_STATUS = status.HTTP_402_PAYMENT_REQUIRED

# One message, because there is one remedy. The client matches on the status,
# not on this text, so it can be edited freely.
KEY_REQUIRED_DETAIL = (
    "This feature runs on Anthropic's API and needs your own key. "
    "Add one in Settings → AI to turn it on."
)


def is_owner(settings: Settings, user: User) -> bool:
    """Whether this account may spend the server's key.

    An anonymous device-key user has no email and so is never an owner, which is
    the desired default rather than a special case — the same reasoning as the
    publisher allowlist in `config.py`.
    """
    email = (user.email or "").strip().lower()
    return bool(email) and email in settings.ai_owner_email_set


def require_owner(user: User, action: str) -> Settings:
    """Refuse anyone but an owner, for AI work a caller's own key cannot pay for.

    **403, not 402**, and the difference is whether there is anything the person
    could do. The resume endpoints answer 402 because "bring your own key" is a
    real remedy. Sentry autofix has none: the run happens in GitHub Actions
    inside the *operator's* repo, on the operator's Actions secret, and ends —
    where autofix-ship is wired up — in an automatic merge and deploy of that
    repo. There is no key a stranger could supply that would make any of that
    theirs, so the honest answer is "not yours", not "pay up".

    Until this existed, `get_current_user` was the only thing in front of that
    dispatch: anyone who could sign in could spend roughly $0.40 a press of the
    operator's money and land a commit in their repo.
    """
    settings = get_settings()
    if not is_owner(settings, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"{action} runs in this server's own repository, so it is limited to its operator.",
        )
    return settings


def stored_key(user: User) -> str | None:
    """The account's own key in the clear, or None if it has none it can use.

    None also covers a ciphertext that no longer opens — a row written under an
    `app_secret_key` this server has since lost. That reads as "no key", because
    the remedy is identical: the owner enters one again. Treating it as an error
    instead would strand someone on a 500 with nothing to do about it.
    """
    if not user.anthropic_key_ct:
        return None
    try:
        return open_sealed(user.anthropic_key_ct)
    except SecretStorageUnavailable:
        # A deploy with no `app_secret_key` cannot read anything it stored. That
        # is the operator's problem, not the caller's, and it presents to the
        # caller as an account with no key.
        return None


def model_access(user: User) -> Settings:
    """Settings for this caller, with `anthropic_api_key` set to their key.

    Raises 402 when they have none, and 503 when an owner's server key is itself
    missing — those are different problems with different audiences. An owner
    seeing 503 has a deployment to fix; anyone seeing 402 has a key to paste.
    """
    settings = get_settings()

    if is_owner(settings, user):
        if not settings.anthropic_api_key:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="This server has no Anthropic key configured.",
            )
        return settings

    key = stored_key(user)
    if not key:
        raise HTTPException(status_code=KEY_REQUIRED_STATUS, detail=KEY_REQUIRED_DETAIL)
    return settings.model_copy(update={"anthropic_api_key": key})
