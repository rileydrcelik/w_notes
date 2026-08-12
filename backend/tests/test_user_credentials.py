"""Per-user provider credentials.

The bug these exist to kill was observed, not theorised: a second person opened
the GitHub plugin and was shown the *operator's* private repositories, because
`GET /github/repos` acted as one server-wide token and is documented as "every
repo the token can see". Authentication was never the gap — every route already
required a bearer token — authorization was. The routes bound `user` and then
never read it.

So the load-bearing tests here are the isolation ones: that one account cannot
read, use, or overwrite another's token, and that having no token fails closed
rather than falling back to the server's.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from app.crypto import decrypt, seal

pytestmark = pytest.mark.anyio


# ---- Storage ----


async def test_saving_a_token_reports_only_its_last_four(client, device, crypto_key):
    resp = await client.put(
        "/credentials/github", headers=device, json={"token": "ghp_secretvalue1234"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["saved"] is True
    assert body["hint"] == "1234"
    # The response must never carry the token back, under any key.
    assert "ghp_secretvalue1234" not in resp.text


async def test_listing_never_returns_the_token(client, device, crypto_key):
    await client.put(
        "/credentials/github", headers=device, json={"token": "ghp_secretvalue1234"}
    )
    resp = await client.get("/credentials", headers=device)
    assert resp.status_code == 200
    assert "ghp_secretvalue1234" not in resp.text
    github = next(c for c in resp.json()["credentials"] if c["provider"] == "github")
    assert github["saved"] is True
    assert github["hint"] == "1234"


async def test_unset_providers_report_not_saved(client, device, crypto_key):
    resp = await client.get("/credentials", headers=device)
    providers = {c["provider"]: c for c in resp.json()["credentials"]}
    # Both known providers are listed even when empty, so the UI can render a
    # row for each without a separate catalogue.
    assert providers["github"]["saved"] is False
    assert providers["sentry"]["saved"] is False


async def test_the_token_is_not_stored_in_plaintext(client, device, crypto_key, engine):
    """The whole point of encrypting: a table dump yields nothing usable."""
    secret = "ghp_averysecrettokenvalue"
    await client.put("/credentials/github", headers=device, json={"token": secret})
    async with engine.begin() as conn:
        stored = (
            await conn.execute(text("SELECT token_encrypted FROM user_credentials"))
        ).scalar_one()
    assert secret not in stored
    assert decrypt(stored) == secret


async def test_saving_again_replaces_rather_than_accumulates(
    client, device, crypto_key, engine
):
    await client.put("/credentials/github", headers=device, json={"token": "tok-first"})
    await client.put("/credentials/github", headers=device, json={"token": "tok-second"})
    async with engine.begin() as conn:
        rows = (
            await conn.execute(text("SELECT COUNT(*) FROM user_credentials"))
        ).scalar_one()
    assert rows == 1
    resp = await client.get("/credentials", headers=device)
    github = next(c for c in resp.json()["credentials"] if c["provider"] == "github")
    assert github["hint"] == "cond"  # last 4 of "tok-second"


async def test_surrounding_whitespace_is_stripped(client, device, crypto_key, engine):
    """Pasting a token commonly drags a newline along, which GitHub answers with
    an opaque 401 that looks like a bad token rather than a bad paste."""
    await client.put(
        "/credentials/github", headers=device, json={"token": "  ghp_padded  \n"}
    )
    async with engine.begin() as conn:
        stored = (
            await conn.execute(text("SELECT token_encrypted FROM user_credentials"))
        ).scalar_one()
    assert decrypt(stored) == "ghp_padded"


async def test_deleting_is_idempotent(client, device, crypto_key):
    # Deleting one that was never there must not 404: a Settings screen clearing
    # a field it isn't sure about would fail for no reason.
    assert (await client.delete("/credentials/github", headers=device)).status_code == 204
    await client.put("/credentials/github", headers=device, json={"token": "tok-abcd"})
    assert (await client.delete("/credentials/github", headers=device)).status_code == 204
    resp = await client.get("/credentials", headers=device)
    github = next(c for c in resp.json()["credentials"] if c["provider"] == "github")
    assert github["saved"] is False


async def test_unknown_provider_is_rejected(client, device, crypto_key):
    resp = await client.put(
        "/credentials/gitlab", headers=device, json={"token": "tok-abcd"}
    )
    assert resp.status_code == 404


# ---- Isolation: the actual bug ----


async def test_one_account_cannot_see_anothers_credential(
    client, device, other_device, crypto_key
):
    await client.put(
        "/credentials/github", headers=device, json={"token": "ghp_mine1234"}
    )
    resp = await client.get("/credentials", headers=other_device)
    assert "ghp_mine1234" not in resp.text
    github = next(c for c in resp.json()["credentials"] if c["provider"] == "github")
    assert github["saved"] is False
    assert github["hint"] == ""


async def test_one_account_cannot_overwrite_anothers_credential(
    client, device, other_device, crypto_key, engine
):
    await client.put("/credentials/github", headers=device, json={"token": "tok-mine"})
    await client.put(
        "/credentials/github", headers=other_device, json={"token": "tok-theirs"}
    )
    # Two rows, one per user — the composite key is (user_id, provider), so a
    # second account saving the same provider must not collide with the first.
    async with engine.begin() as conn:
        rows = (
            await conn.execute(text("SELECT COUNT(*) FROM user_credentials"))
        ).scalar_one()
    assert rows == 2
    mine = await client.get("/credentials", headers=device)
    assert next(
        c for c in mine.json()["credentials"] if c["provider"] == "github"
    )["hint"] == "mine"


async def test_deleting_does_not_touch_another_account(
    client, device, other_device, crypto_key
):
    await client.put("/credentials/github", headers=device, json={"token": "tok-mine"})
    await client.put(
        "/credentials/github", headers=other_device, json={"token": "tok-theirs"}
    )
    await client.delete("/credentials/github", headers=other_device)
    resp = await client.get("/credentials", headers=device)
    assert next(
        c for c in resp.json()["credentials"] if c["provider"] == "github"
    )["saved"] is True


# ---- Fail closed ----


async def test_github_routes_refuse_without_a_credential(client, device, crypto_key):
    """The regression that matters. Before per-user credentials this returned
    the operator's repositories; it must now refuse and say where to fix it."""
    resp = await client.get("/github/repos", headers=device)
    assert resp.status_code == 503
    detail = resp.json()["detail"]
    assert "GitHub" in detail
    assert "Settings" in detail


async def test_sentry_routes_refuse_without_a_credential(client, device, crypto_key):
    resp = await client.get("/sentry/projects", headers=device)
    assert resp.status_code == 503
    assert "Settings" in resp.json()["detail"]


async def test_a_github_credential_does_not_unlock_sentry(
    client, device, save_credential
):
    """Credentials are per provider. Saving one must not imply the other, or the
    fail-closed check becomes 'has any credential at all'."""
    await save_credential(device, "github")
    resp = await client.get("/sentry/projects", headers=device)
    assert resp.status_code == 503


async def test_saving_is_refused_when_encryption_is_unconfigured(client, device):
    """No key configured => 503, never a plaintext write.

    Note this test deliberately omits the `crypto_key` fixture. A deployment
    that forgets the SSM parameter should lose the plugin, not silently start
    storing other people's PATs in the clear.
    """
    resp = await client.put(
        "/credentials/github", headers=device, json={"token": "ghp_plaintext"}
    )
    assert resp.status_code == 503


# ---- Crypto ----


def test_encrypt_round_trips(crypto_key):
    assert decrypt(seal("ghp_value")) == "ghp_value"


def test_ciphertext_differs_each_time(crypto_key):
    """Fernet includes a random IV, so the same token encrypts differently every
    time. Without that, equal ciphertexts would reveal which users share a
    token."""
    assert seal("same") != seal("same")


def test_a_row_encrypted_under_the_old_key_still_reads(crypto_key, monkeypatch):
    """Rotation: reads try the current key, then the previous one.

    Without the fallback, rotating the key would present every user as having
    silently lost their token.
    """
    from app.config import get_settings

    old_key = "8_1J1NCH8Zj0Xz3vN7yQ9pKcR2sT4uV6wX8yZ0aB1cE="
    new_key = "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-AbCdE="
    ciphertext = seal("ghp_before_rotation")

    settings = get_settings()
    monkeypatch.setattr(settings, "app_secret_key", new_key, raising=False)
    monkeypatch.setattr(settings, "app_secret_key_old", old_key, raising=False)
    assert decrypt(ciphertext) == "ghp_before_rotation"
