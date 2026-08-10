"""Who gets to spend which Anthropic key, and what the key store gives back.

These endpoints are the expensive ones — a frontier model over a whole resume,
several times per press for the tailor — so the gate in front of them is a cost
control as much as an auth check. The failure that matters is the quiet one: a
gate that looks closed and isn't, letting an ordinary account draw on the
operator's balance until the invoice says otherwise. Nothing in a 200 response
distinguishes "spent your key" from "spent mine", which is exactly why the split
is asserted here rather than left to be noticed later.

The other half is the store itself. A stored key must go in, stay in, come back
out *only* as the last four characters, and never appear in any response body.

`get_current_user` accepts any opaque bearer token as an anonymous device key
when Firebase isn't configured (see conftest), and an anonymous user has no
email — so a test that needs an *owner* has to write the email onto the row
itself. That is what `signed_in` does.
"""

from __future__ import annotations

import uuid

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select, text, update

from app.config import get_settings
from app.models import User

AI_KEY = "/me/ai-key"
# A valid EntryRequest, so a rejection here is the gate talking and not the
# schema. A 422 would pass an `assert != 200` while proving nothing.
ENTRY_REQUEST = {
    "source": r"\documentclass{article}\begin{document}\end{document}",
    "section": "Experience",
    "title": "Engineer",
}
GOOD_KEY = "sk-ant-api03-pretendthisisreal-Ab12"
# Likewise valid, so a refusal is the gate and not the schema.
AUTOFIX_REQUEST = {"issue_id": "123", "org": "acme", "project": "w-notes-fastapi"}


@pytest.fixture(autouse=True)
def _secret_key(monkeypatch):
    """A real Fernet key for the whole module, and a settings cache that reflects
    it. `get_settings` is `lru_cache`d, so an env change without the clear is a
    change the app never sees — the kind of thing that makes a test pass against
    the wrong configuration."""
    monkeypatch.setenv("APP_SECRET_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-server-side-key")
    monkeypatch.setenv("AI_OWNER_EMAILS", "")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def signed_in(client, engine, headers, email: str) -> None:
    """Attach an email to the device-key user these headers resolve to.

    The user row is created lazily on first authenticated request, so this makes
    one and then updates it — mirroring what Firebase sign-in does to the same
    row in production.
    """
    # One authenticated request first: the row is created lazily, so updating
    # before it exists silently touches nothing and the test asserts against a
    # user that was never an owner.
    await client.get(AI_KEY, headers=headers)
    token = headers["Authorization"].split(" ", 1)[1]
    async with engine.begin() as conn:
        result = await conn.execute(
            text("UPDATE users SET email = :email WHERE device_key = :key"),
            {"email": email, "key": token},
        )
    assert result.rowcount == 1, "no user row to sign in"


async def stored_row(engine, headers) -> User | None:
    token = headers["Authorization"].split(" ", 1)[1]
    async with engine.connect() as conn:
        result = await conn.execute(
            text(
                "SELECT anthropic_key_ct, anthropic_key_hint FROM users "
                "WHERE device_key = :key"
            ),
            {"key": token},
        )
        return result.first()


async def test_a_fresh_account_has_no_key_and_is_not_an_owner(client, device):
    response = await client.get(AI_KEY, headers=device)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "configured": False,
        "hint": None,
        "owner": False,
        "can_store": True,
    }


async def test_storing_a_key_reports_it_configured_with_only_the_last_four(client, device):
    put = await client.put(AI_KEY, json={"key": GOOD_KEY}, headers=device)

    assert put.status_code == 200, put.text
    assert put.json()["configured"] is True
    assert put.json()["hint"] == "Ab12"
    # The whole point: the key itself is not in the answer.
    assert GOOD_KEY not in put.text


async def test_a_stored_key_survives_the_request_that_stored_it(client, device, engine):
    """`get_current_user` hands back a *detached* User, so writing through it
    would commit nothing while still answering 200. This is that bug's test."""
    await client.put(AI_KEY, json={"key": GOOD_KEY}, headers=device)

    row = await stored_row(engine, device)

    assert row is not None
    assert row.anthropic_key_hint == "Ab12"
    assert row.anthropic_key_ct
    # Stored sealed, not in the clear.
    assert GOOD_KEY not in row.anthropic_key_ct


async def test_a_later_get_still_never_returns_the_key(client, device):
    await client.put(AI_KEY, json={"key": GOOD_KEY}, headers=device)

    response = await client.get(AI_KEY, headers=device)

    assert response.json()["hint"] == "Ab12"
    assert GOOD_KEY not in response.text


async def test_a_key_of_the_wrong_shape_is_refused_before_it_is_stored(client, device, engine):
    response = await client.put(AI_KEY, json={"key": "not-a-key"}, headers=device)

    assert response.status_code == 400
    row = await stored_row(engine, device)
    assert row is None or row.anthropic_key_ct is None


async def test_forgetting_a_key_clears_the_hint_with_it(client, device, engine):
    """A hint outliving its key would report a key that cannot be spent."""
    await client.put(AI_KEY, json={"key": GOOD_KEY}, headers=device)

    response = await client.delete(AI_KEY, headers=device)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "configured": False,
        "hint": None,
        "owner": False,
        "can_store": True,
    }
    row = await stored_row(engine, device)
    assert row.anthropic_key_ct is None
    assert row.anthropic_key_hint is None


async def test_without_a_key_an_ai_endpoint_asks_for_one_rather_than_running(client, device):
    """402, distinctly — the client shows "add your key", which is a different
    screen from "too long" (413) and "server misconfigured" (503)."""
    response = await client.post(
        "/resume/entry",
        json=ENTRY_REQUEST,
        headers=device,
    )

    assert response.status_code == 402, response.text
    assert "key" in response.json()["detail"].lower()


async def test_an_owner_needs_no_key_of_their_own(client, device, engine, monkeypatch):
    monkeypatch.setenv("AI_OWNER_EMAILS", "owner@example.com")
    get_settings.cache_clear()
    await signed_in(client, engine, device, "owner@example.com")

    response = await client.get(AI_KEY, headers=device)

    assert response.json()["owner"] is True
    assert response.json()["configured"] is True


async def test_the_owner_list_is_matched_case_insensitively(client, device, engine, monkeypatch):
    """A capitalised letter in an env var silently disabling the operator's own
    access is a miserable thing to debug — the same reasoning as
    `publisher_email_set`, which this mirrors."""
    monkeypatch.setenv("AI_OWNER_EMAILS", "Owner@Example.com")
    get_settings.cache_clear()
    await signed_in(client, engine, device, "owner@example.com")

    assert (await client.get(AI_KEY, headers=device)).json()["owner"] is True


async def test_someone_elses_account_is_not_an_owner(client, device, engine, monkeypatch):
    """The gate's whole job. If this passes while the account is a stranger's,
    the operator is paying for it."""
    monkeypatch.setenv("AI_OWNER_EMAILS", "owner@example.com")
    get_settings.cache_clear()
    await signed_in(client, engine, device, "someone.else@example.com")

    state = await client.get(AI_KEY, headers=device)
    assert state.json()["owner"] is False
    assert state.json()["configured"] is False

    denied = await client.post(
        "/resume/entry",
        json=ENTRY_REQUEST,
        headers=device,
    )
    assert denied.status_code == 402


async def test_an_anonymous_account_can_never_be_an_owner(client, device, monkeypatch):
    """An anonymous device-key user has no email at all. Empty must not match an
    empty entry in the allowlist and let every pre-login device ride free."""
    monkeypatch.setenv("AI_OWNER_EMAILS", ",, ,")
    get_settings.cache_clear()

    assert (await client.get(AI_KEY, headers=device)).json()["owner"] is False


async def test_with_no_server_secret_the_field_says_so_instead_of_failing_later(
    client, device, monkeypatch
):
    monkeypatch.setenv("APP_SECRET_KEY", "")
    get_settings.cache_clear()

    state = await client.get(AI_KEY, headers=device)
    assert state.json()["can_store"] is False

    refused = await client.put(AI_KEY, json={"key": GOOD_KEY}, headers=device)
    assert refused.status_code == 503


async def test_a_key_sealed_under_a_lost_secret_reads_as_no_key(client, device, monkeypatch):
    """Rotating `app_secret_key` orphans every stored ciphertext. That has to
    present as "no key" — the remedy is to enter one again — rather than as a
    500 the person can do nothing about."""
    await client.put(AI_KEY, json={"key": GOOD_KEY}, headers=device)

    monkeypatch.setenv("APP_SECRET_KEY", Fernet.generate_key().decode())
    get_settings.cache_clear()

    response = await client.post(
        "/resume/entry",
        json=ENTRY_REQUEST,
        headers=device,
    )
    assert response.status_code == 402


@pytest.mark.parametrize("junk", ["not base64 at all!!", "kÃ©y-with-non-ascii-Ã¸", ""])
async def test_a_ciphertext_column_that_isnt_fernet_output_reads_as_no_key(
    client, device, engine, junk
):
    """Only `seal()` writes this column, so none of these should ever be in it.

    But "unreadable stored credential" is a case the caller already handles, and
    whether it *is* handled turns on which exception the decrypt happens to
    raise. Fernet answers `InvalidToken` for the first and last of these, so they
    were always fine; the non-ASCII one never reaches Fernet at all — it dies in
    the `.encode("ascii")` before it — and that is the case this pins. A row
    corrupted by anything other than key rotation must land where rotation does.
    """
    await client.put(AI_KEY, json={"key": GOOD_KEY}, headers=device)
    token = device["Authorization"].split(" ", 1)[1]
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE users SET anthropic_key_ct = :ct WHERE device_key = :key"),
            {"ct": junk, "key": token},
        )

    response = await client.post("/resume/entry", json=ENTRY_REQUEST, headers=device)

    assert response.status_code == 402, response.text


async def test_two_accounts_do_not_share_a_key(client, engine):
    """One column per user, and no cache keyed on anything but the user."""
    first = {"Authorization": f"Bearer {uuid.uuid4()}"}
    second = {"Authorization": f"Bearer {uuid.uuid4()}"}

    await client.put(AI_KEY, json={"key": GOOD_KEY}, headers=first)

    assert (await client.get(AI_KEY, headers=second)).json()["configured"] is False


# --------------------------------------------------------------------------
# Sentry autofix — the other AI feature, gated differently and for a reason.
# --------------------------------------------------------------------------


async def test_autofix_is_refused_to_an_ordinary_account(client, device, monkeypatch):
    """403, not 402. A dispatch runs in the *operator's* repo on the operator's
    Actions secret and, with autofix-ship wired up, merges and deploys it — so
    there is no key a caller could bring that would make it theirs. Before this
    gate, anyone who could sign in could spend ~$0.40 a press and land a commit.
    """
    monkeypatch.setenv("AI_OWNER_EMAILS", "owner@example.com")
    get_settings.cache_clear()

    response = await client.post(
        "/sentry/autofix",
        json=AUTOFIX_REQUEST,
        headers=device,
    )

    assert response.status_code == 403, response.text


async def test_autofix_is_refused_before_any_upstream_call(client, device, monkeypatch):
    """The gate has to come before `_require_token`, or a server with no Sentry
    token answers 503 and the refusal reads as "misconfigured" rather than "not
    yours" — and a server *with* one starts spending on context before the
    caller has been checked at all."""
    monkeypatch.setenv("AI_OWNER_EMAILS", "owner@example.com")
    monkeypatch.setenv("SENTRY_API_TOKEN", "")
    monkeypatch.setenv("GITHUB_TOKEN", "")
    get_settings.cache_clear()

    response = await client.post(
        "/sentry/autofix",
        json=AUTOFIX_REQUEST,
        headers=device,
    )

    assert response.status_code == 403, response.text


async def test_autofix_status_is_refused_too(client, device, monkeypatch):
    """Nobody but an owner can have started a run, so for anyone else this only
    reports on the operator's open pull requests."""
    monkeypatch.setenv("AI_OWNER_EMAILS", "owner@example.com")
    get_settings.cache_clear()

    response = await client.get(
        "/sentry/autofix/status", params={"short_id": "PYTHON-FASTAPI-3"}, headers=device
    )

    assert response.status_code == 403, response.text


async def test_an_owner_is_not_stopped_by_the_autofix_gate(client, device, engine, monkeypatch):
    """The gate must let the operator through. With no Sentry token configured
    the request then fails at `_require_token` with 503 — which is the proof it
    got *past* the gate rather than being turned away at it."""
    monkeypatch.setenv("AI_OWNER_EMAILS", "owner@example.com")
    monkeypatch.setenv("SENTRY_API_TOKEN", "")
    get_settings.cache_clear()
    await signed_in(client, engine, device, "owner@example.com")

    response = await client.post(
        "/sentry/autofix",
        json=AUTOFIX_REQUEST,
        headers=device,
    )

    assert response.status_code == 503, response.text
