"""The task-manager issue namer — `POST /issues/title`.

The New issue screen asks for one field; what's typed is saved verbatim as the
description with a stand-in title, and this endpoint supplies the real one
(`app/routers/issue_title.py`). The client's whole retry story
(`lib/issue-retitle.ts`) is keyed off the status code this endpoint returns, so
that mapping is the load-bearing thing to pin here — a status drifting to the
wrong bucket would silently turn "try again later" into "give up forever" or
the reverse.

Like `test_resume.py`, this never opens a socket: `anthropic.AsyncAnthropic` is
replaced with a fake, and an autouse fixture makes the *real* class
unconstructable so a regressed guard clause fails loudly here instead of
quietly dialing out.
"""

from __future__ import annotations

import json

import httpx
import pytest

from app import ai_access
from app.config import get_settings
from app.routers import issue_title

TITLE = "/issues/title"


class _FakeBlock:
    def __init__(self, text: str):
        self.type = "text"
        self.text = text


class _FakeMessage:
    def __init__(self, text: str, stop_reason: str = "end_turn"):
        self.content = [_FakeBlock(text)]
        self.stop_reason = stop_reason


class _FakeMessages:
    """Stands in for `client.messages`. `create`, not `stream` — the endpoint's
    docstring is explicit that naming a paragraph needs no streaming, and a
    fake that only offers `create` catches a regression to the wrong call
    shape immediately rather than silently answering nothing."""

    def __init__(self, message: _FakeMessage | Exception):
        self._message = message

    async def create(self, **kwargs):
        _calls.append(kwargs)
        if isinstance(self._message, Exception):
            raise self._message
        return self._message


class _FakeAsyncAnthropic:
    def __init__(self, *args, **kwargs):
        _client_kwargs.append(kwargs)
        self.messages = _FakeMessages(_current_message["value"])

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


_current_message: dict = {"value": None}
_calls: list[dict] = []
_client_kwargs: list[dict] = []


def set_response(text: str, stop_reason: str = "end_turn") -> None:
    _current_message["value"] = _FakeMessage(text, stop_reason)


def set_error(exc: Exception) -> None:
    _current_message["value"] = exc


class _RefusingAsyncAnthropic:
    """The default for every test in this file: constructing it is itself a
    failure, so a guard clause that regresses cannot fall through to a real
    network call."""

    def __init__(self, *args, **kwargs):
        raise AssertionError(
            "a real Anthropic client must never be constructed by this test suite"
        )


@pytest.fixture(autouse=True)
def no_real_anthropic_calls(monkeypatch):
    monkeypatch.setattr(issue_title.anthropic, "AsyncAnthropic", _RefusingAsyncAnthropic)


@pytest.fixture
def fake_anthropic(monkeypatch):
    monkeypatch.setattr(issue_title.anthropic, "AsyncAnthropic", _FakeAsyncAnthropic)
    _calls.clear()
    _client_kwargs.clear()
    return set_response


@pytest.fixture
def fake_anthropic_error(monkeypatch):
    """Like `fake_anthropic`, but the "model" raises instead of answering."""
    monkeypatch.setattr(issue_title.anthropic, "AsyncAnthropic", _FakeAsyncAnthropic)
    _calls.clear()
    _client_kwargs.clear()
    return set_error


@pytest.fixture
def anthropic_key(monkeypatch):
    """Entitle the caller to reach the model, with a (fake) key. See
    `test_resume.py`'s fixture of the same name for the reasoning behind both
    halves of this patch."""
    settings = get_settings()
    monkeypatch.setattr(settings, "anthropic_api_key", "sk-ant-test-not-real", raising=False)
    monkeypatch.setattr(ai_access, "stored_key", lambda user: "sk-ant-test-not-real")
    yield
    get_settings.cache_clear()


async def _title(client, device, **overrides):
    body = {"text": "The export button does nothing on Android 14."}
    body.update(overrides)
    return await client.post(TITLE, json=body, headers=device)


# --------------------------------------------------------------------------
# Guard clauses.
# --------------------------------------------------------------------------


async def test_asks_an_ordinary_caller_for_a_key(client, device, monkeypatch):
    """402: the client reads this as "keep the stand-in title" rather than
    retrying, per the router's own docstring."""
    settings = get_settings()
    monkeypatch.setattr(settings, "anthropic_api_key", "", raising=False)
    try:
        res = await _title(client, device)
    finally:
        get_settings.cache_clear()
    assert res.status_code == 402


async def test_blank_text_is_400(client, device, anthropic_key):
    res = await _title(client, device, text="   ")
    assert res.status_code == 400


async def test_oversized_text_is_413(client, device, anthropic_key):
    huge = "x" * (issue_title.MAX_TEXT_CHARS + 1)
    res = await _title(client, device, text=huge)
    assert res.status_code == 413


async def test_413_is_checked_before_reaching_the_model(client, device, anthropic_key):
    """`no_real_anthropic_calls` is autouse, so this would itself fail loudly if
    the size guard let an oversized request through to construct a client."""
    huge = "x" * (issue_title.MAX_TEXT_CHARS + 1)
    res = await _title(client, device, text=huge)
    assert res.status_code == 413


# --------------------------------------------------------------------------
# What happens once the "model" answers.
# --------------------------------------------------------------------------


async def test_the_happy_path_returns_the_cleaned_title(
    client, device, anthropic_key, fake_anthropic
):
    fake_anthropic(json.dumps({"title": "  \"Export button does nothing.\"  "}))
    res = await _title(client, device)
    assert res.status_code == 200
    assert res.json()["title"] == "Export button does nothing"


async def test_the_request_uses_the_configured_title_model_and_no_effort(
    client, device, anthropic_key, fake_anthropic
):
    """Haiku, not Sonnet — the whole reason this is its own model setting — and
    no `effort` kwarg, which Haiku 4.5 rejects outright."""
    fake_anthropic(json.dumps({"title": "Fine"}))
    res = await _title(client, device)
    assert res.status_code == 200
    settings = get_settings()
    assert _calls[0]["model"] == settings.anthropic_title_model
    assert "effort" not in _calls[0]


async def test_a_refusal_is_422(client, device, anthropic_key, fake_anthropic):
    fake_anthropic("", stop_reason="refusal")
    res = await _title(client, device)
    assert res.status_code == 422


async def test_unparseable_json_is_a_502(client, device, anthropic_key, fake_anthropic):
    fake_anthropic("not json at all")
    res = await _title(client, device)
    assert res.status_code == 502


async def test_json_missing_the_title_key_is_a_502(client, device, anthropic_key, fake_anthropic):
    fake_anthropic(json.dumps({"nope": "wrong key"}))
    res = await _title(client, device)
    assert res.status_code == 502


async def test_an_empty_title_after_cleaning_is_a_502(
    client, device, anthropic_key, fake_anthropic
):
    fake_anthropic(json.dumps({"title": "   "}))
    res = await _title(client, device)
    assert res.status_code == 502


async def test_a_rate_limit_is_a_429(client, device, anthropic_key, fake_anthropic_error):
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx.Response(429, request=request)
    fake_anthropic_error(issue_title.anthropic.RateLimitError("slow down", response=response, body=None))
    res = await _title(client, device)
    assert res.status_code == 429


async def test_a_rejected_key_is_the_same_402_as_no_key(
    client, device, anthropic_key, fake_anthropic_error
):
    """A revoked or mistyped key has the remedy "no key" has. As a 502 the client
    would retry it on five more syncs with a key that can never work."""
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx.Response(401, request=request)
    fake_anthropic_error(
        issue_title.anthropic.AuthenticationError("invalid x-api-key", response=response, body=None)
    )
    res = await _title(client, device)
    assert res.status_code == 402


async def test_a_timeout_is_a_504(client, device, anthropic_key, fake_anthropic_error):
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    fake_anthropic_error(issue_title.anthropic.APITimeoutError(request=request))
    res = await _title(client, device)
    assert res.status_code == 504


async def test_a_connection_failure_is_a_502(client, device, anthropic_key, fake_anthropic_error):
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    fake_anthropic_error(issue_title.anthropic.APIConnectionError(request=request))
    res = await _title(client, device)
    assert res.status_code == 502


async def test_an_api_status_error_is_a_502(client, device, anthropic_key, fake_anthropic_error):
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx.Response(500, request=request)
    fake_anthropic_error(issue_title.anthropic.APIStatusError("server exploded", response=response, body=None))
    res = await _title(client, device)
    assert res.status_code == 502


# --------------------------------------------------------------------------
# `clean_title` — the string massage the endpoint applies before returning.
# --------------------------------------------------------------------------


def test_clean_title_strips_quotes_and_trailing_period():
    assert issue_title.clean_title('"Fix the export bug."') == "Fix the export bug"


def test_clean_title_strips_smart_quotes_and_backtick():
    assert issue_title.clean_title("“Smart quoted”") == "Smart quoted"
    assert issue_title.clean_title("`backticked`") == "backticked"


def test_clean_title_collapses_internal_whitespace_and_trims():
    assert issue_title.clean_title("  a   title\n with   gaps  ") == "a title with gaps"


def test_clean_title_caps_length_with_an_ellipsis():
    raw = " ".join(["word"] * 40)  # far past MAX_TITLE_CHARS
    cleaned = issue_title.clean_title(raw)
    assert len(cleaned) <= issue_title.MAX_TITLE_CHARS  # the ellipsis included
    assert cleaned.endswith("…")
    # No spaces to back up to, so the cut lands exactly on the limit — the case
    # where an ellipsis added *past* the cap would show.
    unbroken = issue_title.clean_title("x" * 300)
    assert len(unbroken) == issue_title.MAX_TITLE_CHARS
    assert unbroken.endswith("…")


def test_clean_title_leaves_a_short_title_untouched():
    assert issue_title.clean_title("Short title") == "Short title"


# --------------------------------------------------------------------------
# Duplicates ride along with the title request.
# --------------------------------------------------------------------------


async def test_no_candidates_uses_the_title_only_schema_and_null_duplicate(
    client, device, anthropic_key, fake_anthropic
):
    fake_anthropic(json.dumps({"title": "Fine"}))
    res = await _title(client, device)
    assert res.status_code == 200
    assert _calls[0]["output_config"]["format"]["schema"] == issue_title._TITLE_SCHEMA
    assert res.json()["duplicate_of"] is None


async def test_a_numeric_answer_maps_to_the_matching_candidates_id(
    client, device, anthropic_key, fake_anthropic
):
    fake_anthropic(json.dumps({"title": "Fine", "duplicate_of": 2}))
    candidates = [
        {"id": "cand-a", "title": "First candidate", "description": "d1"},
        {"id": "cand-b", "title": "Second candidate", "description": "d2"},
    ]
    res = await _title(client, device, candidates=candidates)
    assert res.status_code == 200
    assert res.json()["duplicate_of"] == "cand-b"
    assert _calls[0]["output_config"]["format"]["schema"] == issue_title._TITLE_AND_DUPLICATE_SCHEMA

    prompt = _calls[0]["messages"][0]["content"]
    assert "<existing_issues>" in prompt
    # The model sees candidates by number, never by id.
    assert "cand-a" not in prompt
    assert "cand-b" not in prompt


@pytest.mark.parametrize("value", [0, 3, -1, "2", True])
async def test_an_out_of_range_or_wrong_typed_answer_is_simply_no_duplicate(
    client, device, anthropic_key, fake_anthropic, value
):
    """0 (none qualifies), 3 (N+1 — only 2 candidates offered), -1, a string, and
    a bool (which `isinstance(x, int)` would otherwise wrongly accept, since
    `bool` subclasses `int`) all fall back to "no duplicate" rather than 502ing
    the title along with them."""
    fake_anthropic(json.dumps({"title": "Fine", "duplicate_of": value}))
    candidates = [
        {"id": "cand-a", "title": "First candidate", "description": ""},
        {"id": "cand-b", "title": "Second candidate", "description": ""},
    ]
    res = await _title(client, device, candidates=candidates)
    assert res.status_code == 200
    assert res.json()["title"] == "Fine"
    assert res.json()["duplicate_of"] is None


async def test_omitting_duplicate_of_is_no_duplicate(client, device, anthropic_key, fake_anthropic):
    fake_anthropic(json.dumps({"title": "Fine"}))
    candidates = [{"id": "cand-a", "title": "First candidate", "description": ""}]
    res = await _title(client, device, candidates=candidates)
    assert res.status_code == 200
    assert res.json()["title"] == "Fine"
    assert res.json()["duplicate_of"] is None


async def test_two_hundred_hefty_candidates_dont_413_and_the_prompt_is_capped(
    client, device, anthropic_key, fake_anthropic
):
    """A candidate list far past the budget must still get the issue its title —
    "clamped, never rejected", per the router's own docstring."""
    fake_anthropic(json.dumps({"title": "Fine", "duplicate_of": 0}))
    candidates = [
        {"id": f"cand-{i}", "title": f"Candidate {i}", "description": "x" * 5_000}
        for i in range(200)
    ]
    res = await _title(client, device, candidates=candidates)
    assert res.status_code == 200
    assert res.json()["title"] == "Fine"

    prompt = _calls[0]["messages"][0]["content"]
    listing = json.loads(prompt.split("<existing_issues>\n", 1)[1].split("\n</existing_issues>", 1)[0])
    assert len(listing) <= issue_title.MAX_CANDIDATES
    assert len(listing) < len(candidates)


async def test_more_than_max_candidates_are_capped_to_max_candidates(
    client, device, anthropic_key, fake_anthropic
):
    """Isolates the *count* cap from the byte budget above: these candidates are
    tiny, so MAX_CANDIDATES (not MAX_CANDIDATES_CHARS) is what has to stop the
    list."""
    fake_anthropic(json.dumps({"title": "Fine", "duplicate_of": 0}))
    candidates = [
        {"id": f"cand-{i}", "title": f"C{i}", "description": ""} for i in range(200)
    ]
    res = await _title(client, device, candidates=candidates)
    assert res.status_code == 200

    prompt = _calls[0]["messages"][0]["content"]
    listing = json.loads(prompt.split("<existing_issues>\n", 1)[1].split("\n</existing_issues>", 1)[0])
    assert len(listing) == issue_title.MAX_CANDIDATES


async def test_malformed_candidates_are_dropped_not_a_422(
    client, device, anthropic_key, fake_anthropic
):
    fake_anthropic(json.dumps({"title": "Fine", "duplicate_of": 0}))
    candidates = [
        {"id": "", "title": "Blank id", "description": ""},
        {"id": "cand-a", "title": "Real candidate", "description": ""},
        {"id": "cand-a", "title": "Same id again", "description": ""},
    ]
    res = await _title(client, device, candidates=candidates)
    assert res.status_code == 200

    prompt = _calls[0]["messages"][0]["content"]
    listing = json.loads(prompt.split("<existing_issues>\n", 1)[1].split("\n</existing_issues>", 1)[0])
    assert len(listing) == 1
    assert listing[0]["title"] == "Real candidate"
