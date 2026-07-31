"""The resume adder's server side — `POST /resume/entry`.

The endpoint's whole safety property is described in `app/routers/resume.py`'s
docstring: whatever the model returns, it can only ever become **a new entry**,
never an edit to the rest of the document — and the *section* that entry lands
in is the one the client asked for, not whatever the model echoed back. That
second half is a deliberate trust boundary (a misread or adversarial response
must not be able to file an entry under a heading nobody chose) and is the one
test below that would be easy to get backwards without ever going red.

This does not exercise the real Anthropic API. `anthropic.AsyncAnthropic` is
replaced with a fake that never opens a socket, in the same spirit as
`test_latex_compile.py` stubbing the TeX subprocess: the guard clauses and the
response-handling branches are pure control flow, and asserting them doesn't
need — and must never risk — a real model call. An autouse fixture goes
further and makes the *real* class unconstructable for the whole file, so a
guard clause that regresses (e.g. the empty-API-key check silently passing)
fails loudly here instead of quietly dialing out with a live key that happens
to be sitting in the environment.
"""

from __future__ import annotations

import json

import pytest

from app.config import get_settings
from app.routers import resume

ENTRY = "/resume/entry"


def _payload(**overrides) -> dict:
    """A complete, valid request body. Tests override just the field(s) they
    care about."""
    payload = {
        "source": (
            "\\documentclass{article}\\begin{document}"
            "\\section{Experience}\\end{document}"
        ),
        "section": "Experience",
        "section_exists": True,
        "title": "Software Engineer",
        "subtitle": "Acme Corp",
        "location": "Remote",
        "date_from": "2024",
        "date_to": "Present",
        "link": "",
        "description": "Built the thing.",
    }
    payload.update(overrides)
    return payload


async def _draft(client, device, **overrides):
    return await client.post(ENTRY, json=_payload(**overrides), headers=device)


# --------------------------------------------------------------------------
# Fakes for the Anthropic client. Nothing here touches the network.
# --------------------------------------------------------------------------


class _FakeBlock:
    def __init__(self, text: str):
        self.type = "text"
        self.text = text


class _FakeMessage:
    def __init__(self, text: str, stop_reason: str = "end_turn"):
        self.content = [_FakeBlock(text)]
        self.stop_reason = stop_reason


class _FakeMessages:
    """Stands in for `client.messages`. Answers with whatever the test set.

    Records every call's kwargs in `_calls`, because the interesting properties
    of the context-links feature are things the router *sends* — which tool it
    attaches, scoped to which domains — not things the model says back.
    """

    def __init__(self, messages: list[_FakeMessage]):
        self._messages = messages

    async def create(self, **kwargs):
        _calls.append(kwargs)
        # The last queued message repeats, so a test that only cares about the
        # request doesn't have to queue one per continuation.
        index = min(len(_calls) - 1, len(self._messages) - 1)
        return self._messages[index]


class _FakeAsyncAnthropic:
    """Stands in for `anthropic.AsyncAnthropic` — an async context manager
    whose `.messages.create(...)` returns a canned message."""

    def __init__(self, *args, **kwargs):
        _client_kwargs.append(kwargs)
        self.messages = _FakeMessages(_current_message["value"])

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


# The fake needs to read *some* per-test state, but the class itself is only
# constructed once `create` is actually invoked deep inside the router — so
# the message it will answer with is threaded through this module-level box
# rather than a constructor argument. `set_response` is the only thing tests
# touch.
_current_message: dict = {"value": None}

# Every `messages.create(**kwargs)` and every client construction, in order.
_calls: list[dict] = []
_client_kwargs: list[dict] = []


def set_response(text: str, stop_reason: str = "end_turn") -> None:
    _current_message["value"] = [_FakeMessage(text, stop_reason)]


def set_responses(*messages: tuple[str, str]) -> None:
    """Queue a sequence of (text, stop_reason) answers, one per create() call."""
    _current_message["value"] = [_FakeMessage(text, reason) for text, reason in messages]


class _RefusingAsyncAnthropic:
    """The default for every test in this file (see `no_real_anthropic_calls`
    below): constructing it is itself a test failure, so a guard clause that
    regresses cannot fall through to a real network call."""

    def __init__(self, *args, **kwargs):
        raise AssertionError(
            "a real Anthropic client must never be constructed by this test suite"
        )


@pytest.fixture(autouse=True)
def no_real_anthropic_calls(monkeypatch):
    """Refuse to construct a real client by default. Tests that need the
    endpoint to reach the model use the `fake_anthropic` fixture, which
    overrides this."""
    monkeypatch.setattr(resume.anthropic, "AsyncAnthropic", _RefusingAsyncAnthropic)


@pytest.fixture
def fake_anthropic(monkeypatch):
    """Opt-in for tests that need the endpoint to reach the "model" step.
    Returns `set_response` so the test controls what comes back."""
    monkeypatch.setattr(resume.anthropic, "AsyncAnthropic", _FakeAsyncAnthropic)
    _calls.clear()
    _client_kwargs.clear()
    return set_response


@pytest.fixture
def anthropic_key(monkeypatch):
    """Give the endpoint a (fake) API key, the way `test_publish.py`'s
    `publishing` fixture enables its feature — mutate the cached Settings
    instance directly, then clear the cache so later tests get a fresh one."""
    settings = get_settings()
    monkeypatch.setattr(settings, "anthropic_api_key", "sk-ant-test-not-real", raising=False)
    yield
    get_settings.cache_clear()


# --------------------------------------------------------------------------
# Guard clauses — none of these should reach the "model".
# --------------------------------------------------------------------------


async def test_returns_503_when_no_api_key_is_configured(client, device, monkeypatch):
    """A deploy problem, not a bad request — the same distinction
    `/latex/compile` draws for a missing TeX Live install.

    Explicit, rather than relying on the field's own empty-string default: the
    real process environment this suite runs in may well have an
    ANTHROPIC_API_KEY set for unrelated reasons, and this test must not depend
    on it being absent.
    """
    settings = get_settings()
    monkeypatch.setattr(settings, "anthropic_api_key", "", raising=False)
    try:
        res = await _draft(client, device)
    finally:
        get_settings.cache_clear()
    assert res.status_code == 503


async def test_returns_400_when_the_title_is_missing(client, device, anthropic_key):
    res = await _draft(client, device, title="   ")
    assert res.status_code == 400


async def test_returns_400_when_the_section_is_missing(client, device, anthropic_key):
    res = await _draft(client, device, section="   ")
    assert res.status_code == 400


async def test_returns_413_when_the_source_is_oversized(client, device, anthropic_key):
    huge = "x" * (resume._MAX_SOURCE_BYTES + 1)
    res = await _draft(client, device, source=huge)
    assert res.status_code == 413


async def test_size_is_checked_before_the_missing_field_checks(client, device, anthropic_key):
    """Belt-and-suspenders: an oversized *and* otherwise-invalid request still
    reports the size problem, matching the order the router checks in — and
    proving the 413 test above isn't accidentally passing for some other
    reason (e.g. a title/section check that happens to also reject it)."""
    huge = "x" * (resume._MAX_SOURCE_BYTES + 1)
    res = await _draft(client, device, source=huge, title="", section="")
    assert res.status_code == 413


# --------------------------------------------------------------------------
# What happens once the "model" answers.
# --------------------------------------------------------------------------


async def test_a_refusal_is_reported_as_422(client, device, anthropic_key, fake_anthropic):
    """`stop_reason == "refusal"` is a 200 with no usable content — it has to
    be checked before the response body is read at all."""
    fake_anthropic("", stop_reason="refusal")
    res = await _draft(client, device)
    assert res.status_code == 422


async def test_a_non_json_response_is_a_502(client, device, anthropic_key, fake_anthropic):
    """The API constrains generation to a JSON schema, so this is close to
    unreachable in production — but `max_tokens` truncating mid-JSON lands
    here, and it must be a clean 502, not a 500 with a stack trace."""
    fake_anthropic("this is not json")
    res = await _draft(client, device)
    assert res.status_code == 502


async def test_an_empty_latex_field_is_a_502(client, device, anthropic_key, fake_anthropic):
    fake_anthropic(json.dumps({"section": "Experience", "latex": "   "}))
    res = await _draft(client, device)
    assert res.status_code == 502


async def test_the_happy_path_returns_the_section_and_latex(
    client, device, anthropic_key, fake_anthropic
):
    fake_anthropic(
        json.dumps({"section": "Experience", "latex": "\\resumeItem{Shipped the thing}"})
    )
    res = await _draft(client, device)
    assert res.status_code == 200
    body = res.json()
    assert body["section"] == "Experience"
    assert body["latex"] == "\\resumeItem{Shipped the thing}"


async def test_the_returned_section_is_the_requests_not_the_models(
    client, device, anthropic_key, fake_anthropic
):
    """The deliberate security property from the router's own docstring: "the
    client decides where text lands and it asked for a specific section.
    Trusting the echo would let a misread response file the entry under a
    heading nobody chose." A response that echoes back a *different* section
    than the one requested must still be filed under the requested one.
    """
    fake_anthropic(
        json.dumps(
            {
                # The model claims a section the caller never asked for —
                # this must be ignored, not trusted.
                "section": "Personal Projects",
                "latex": "\\resumeItem{Shipped the thing}",
            }
        )
    )
    res = await _draft(client, device, section="Experience")
    assert res.status_code == 200
    assert res.json()["section"] == "Experience"
    assert res.json()["section"] != "Personal Projects"


# --------------------------------------------------------------------------
# Context links.
#
# These pages are read by Anthropic's `web_fetch` server tool, never by this
# process — that is the design, and it is why a user-supplied URL here is not
# an SSRF against the VPC this service runs in. What is left to get wrong lives
# entirely in the request the router builds, so that is what these assert:
# which URLs survive validation, and how tightly the tool is scoped once they
# do.
# --------------------------------------------------------------------------


def test_clean_links_keeps_only_http_urls():
    """`file:`, `data:` and friends are dropped rather than passed along.

    The fetch happens on Anthropic's side, so this is belt-and-braces — but a
    scheme check is one line and the thing it prevents fails silently.
    """
    cleaned = resume._clean_links(
        [
            "https://github.com/me/project",
            "file:///etc/passwd",
            "data:text/html,<script>",
            "gopher://internal/",
            "http://myblog.dev/post",
            "not a url at all",
        ]
    )
    assert cleaned == ["https://github.com/me/project", "http://myblog.dev/post"]


def test_clean_links_drops_urls_with_no_host():
    """`http:///foo` parses as http but has nowhere to go."""
    assert resume._clean_links(["http:///nowhere"]) == []


def test_clean_links_trims_dedupes_and_caps():
    links = resume._clean_links(
        ["  https://a.test/x  ", "https://a.test/x", "", "   "]
        + [f"https://host{n}.test/" for n in range(10)]
    )
    assert links[0] == "https://a.test/x"
    assert links.count("https://a.test/x") == 1
    assert len(links) == resume._MAX_CONTEXT_LINKS


def test_clean_links_rejects_an_absurdly_long_url():
    assert resume._clean_links(["https://a.test/" + "x" * resume._MAX_LINK_CHARS]) == []


def test_allowed_domains_are_the_hosts_asked_for():
    assert resume._allowed_domains(
        ["https://github.com/me/a", "https://github.com/me/b", "https://blog.test/post"]
    ) == ["github.com", "blog.test"]


async def test_no_links_means_no_fetch_tool(client, device, anthropic_key, fake_anthropic):
    """The common case stays a single plain call — no server-tool loop, no
    fetch latency, nothing to continue."""
    fake_anthropic(json.dumps({"section": "Experience", "latex": "\\resumeItem{x}"}))
    res = await _draft(client, device)
    assert res.status_code == 200
    assert _calls[0]["tools"] == []


async def test_links_attach_a_domain_scoped_fetch_tool(
    client, device, anthropic_key, fake_anthropic
):
    """The property that matters: `web_fetch` will fetch any URL in the
    conversation, and the pasted resume is in the conversation. Scoping the
    tool to the hosts the person actually attached is what stops an injected
    link in that resume from being reachable."""
    fake_anthropic(json.dumps({"section": "Experience", "latex": "\\resumeItem{x}"}))
    res = await _draft(
        client,
        device,
        context_links=["https://github.com/me/project", "https://blog.test/post"],
    )
    assert res.status_code == 200

    (tool,) = _calls[0]["tools"]
    assert tool["type"] == "web_fetch_20260209"
    assert tool["allowed_domains"] == ["github.com", "blog.test"]
    # One fetch per link the person chose — the fan-out cannot grow on its own.
    assert tool["max_uses"] == 2


async def test_a_rejected_link_does_not_widen_the_allowlist(
    client, device, anthropic_key, fake_anthropic
):
    """A link that fails validation must not reach `allowed_domains` — that
    would be scoping the tool to a host nobody successfully asked for."""
    fake_anthropic(json.dumps({"section": "Experience", "latex": "\\resumeItem{x}"}))
    res = await _draft(
        client,
        device,
        context_links=["https://github.com/me/project", "file:///etc/passwd"],
    )
    assert res.status_code == 200

    (tool,) = _calls[0]["tools"]
    assert tool["allowed_domains"] == ["github.com"]
    assert tool["max_uses"] == 1


async def test_links_that_all_fail_validation_leave_the_tool_off(
    client, device, anthropic_key, fake_anthropic
):
    """Not an error — just nothing to read. Attaching a zero-use fetch tool
    would be a request the API has every right to reject."""
    fake_anthropic(json.dumps({"section": "Experience", "latex": "\\resumeItem{x}"}))
    res = await _draft(client, device, context_links=["file:///etc/passwd", "nonsense"])
    assert res.status_code == 200
    assert _calls[0]["tools"] == []


async def test_the_links_reach_the_prompt(client, device, anthropic_key, fake_anthropic):
    """web_fetch only fetches URLs already present in the conversation, so a
    link that never makes it into the prompt is a link that is never read."""
    fake_anthropic(json.dumps({"section": "Experience", "latex": "\\resumeItem{x}"}))
    await _draft(client, device, context_links=["https://github.com/me/project"])
    prompt = _calls[0]["messages"][0]["content"]
    assert "https://github.com/me/project" in prompt


async def test_a_paused_turn_is_continued(client, device, anthropic_key, fake_anthropic):
    """The server runs the fetch loop and stops at its own iteration limit with
    `pause_turn`. Treating that as a finished answer would parse an empty body
    as the entry; it has to be sent back to resume."""
    set_responses(
        ("", "pause_turn"),
        (json.dumps({"section": "Experience", "latex": "\\resumeItem{done}"}), "end_turn"),
    )
    res = await _draft(client, device, context_links=["https://github.com/me/project"])
    assert res.status_code == 200
    assert res.json()["latex"] == "\\resumeItem{done}"
    assert len(_calls) == 2
    # Resumed by sending the turn back — with no extra user message, which the
    # model would read as a new instruction.
    assert _calls[1]["messages"][-1]["role"] == "assistant"


async def test_endless_pausing_gives_up_rather_than_billing_forever(
    client, device, anthropic_key, fake_anthropic
):
    set_responses(("", "pause_turn"))
    res = await _draft(client, device, context_links=["https://github.com/me/project"])
    assert res.status_code == 504
    assert len(_calls) == resume._MAX_CONTINUATIONS + 1


async def test_links_extend_the_client_timeout(client, device, anthropic_key, fake_anthropic):
    """A request with links waits on someone else's web servers as well as on
    generation, so it gets more room — but only per link."""
    fake_anthropic(json.dumps({"section": "Experience", "latex": "\\resumeItem{x}"}))
    await _draft(client, device, context_links=["https://github.com/me/project"])
    with_link = _client_kwargs[0]["timeout"]

    _calls.clear()
    _client_kwargs.clear()
    await _draft(client, device)
    without = _client_kwargs[0]["timeout"]

    assert with_link > without


# --------------------------------------------------------------------------
# Editing an entry — `POST /resume/edit`.
#
# The adder is insert-only, and this is the one endpoint that reaches existing
# text. What keeps that narrow is that the model must **quote** what it wants
# replaced, and the quote is verified here against the real source before
# anything travels back. These assert that verification, because it is the
# whole reason the endpoint is safe to have.
# --------------------------------------------------------------------------

EDIT = "/resume/edit"

EDITABLE = "\n".join([
    r"\documentclass{article}",
    r"\begin{document}",
    r"\section{Experience}",
    r"  \resumeItem{Cut p99 latency 38\% by replacing the pricing cache.}",
    r"\end{document}",
])

BULLET = r"  \resumeItem{Cut p99 latency 38\% by replacing the pricing cache.}"


def _edit_payload(**overrides) -> dict:
    payload = {
        "source": EDITABLE,
        "target": "the pricing cache bullet",
        "instructions": "mention that it was rewritten in Rust",
    }
    payload.update(overrides)
    return payload


async def _edit(client, device, **overrides):
    return await client.post(EDIT, json=_edit_payload(**overrides), headers=device)


async def test_edit_returns_503_without_an_api_key(client, device, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "anthropic_api_key", "", raising=False)
    res = await _edit(client, device)
    assert res.status_code == 503
    get_settings.cache_clear()


async def test_edit_requires_a_target(client, device, anthropic_key):
    res = await _edit(client, device, target="   ")
    assert res.status_code == 400


async def test_edit_requires_instructions(client, device, anthropic_key):
    res = await _edit(client, device, instructions="")
    assert res.status_code == 400


async def test_edit_rejects_an_oversized_resume(client, device, anthropic_key):
    res = await _edit(client, device, source="x" * (resume._MAX_SOURCE_BYTES + 1))
    assert res.status_code == 413


async def test_the_happy_path_returns_both_halves(client, device, anthropic_key, fake_anthropic):
    replacement = r"  \resumeItem{Cut p99 latency 38\% by rewriting the pricing cache in Rust.}"
    fake_anthropic(json.dumps({"old_latex": BULLET, "new_latex": replacement}))
    res = await _edit(client, device)
    assert res.status_code == 200
    body = res.json()
    assert body["old_latex"] == BULLET
    assert body["new_latex"] == replacement


async def test_an_empty_old_latex_is_the_model_saying_it_could_not_find_it(
    client, device, anthropic_key, fake_anthropic
):
    """The prompt asks for an empty quote rather than a guess, so this is a
    reportable outcome and not a malformed answer."""
    fake_anthropic(json.dumps({"old_latex": "", "new_latex": "anything"}))
    res = await _edit(client, device)
    assert res.status_code == 422
    # Specifically the could-not-find wording. Without the guard this still
    # 422s — an empty string matches everywhere, so the occurrence check calls
    # it ambiguous — but "that matches more than one place" is nonsense to read
    # when the model was telling you it found nothing.
    assert (
        res.json()["detail"]
        == "Could not find that part of the resume. Try describing it differently."
    )


async def test_a_quote_that_is_not_in_the_document_is_refused(
    client, device, anthropic_key, fake_anthropic
):
    """The verification the design rests on. A quote the model retyped rather
    than copied must not be applied to anything."""
    fake_anthropic(
        json.dumps({"old_latex": r"\resumeItem{Something never written.}", "new_latex": "x"})
    )
    res = await _edit(client, device)
    assert res.status_code == 422


async def test_an_ambiguous_quote_is_refused_rather_than_applied_to_the_first(
    client, device, anthropic_key, fake_anthropic
):
    """Two matches means one of them is not the entry anyone meant. Picking
    silently would edit text nobody looked at."""
    twice = "\n".join([r"\resumeItem{Same.}", r"\resumeItem{Same.}"])
    fake_anthropic(json.dumps({"old_latex": r"\resumeItem{Same.}", "new_latex": "x"}))
    res = await _edit(client, device, source=twice)
    assert res.status_code == 422
    assert "more than one" in res.json()["detail"]


async def test_a_no_op_edit_is_reported_rather_than_returned(
    client, device, anthropic_key, fake_anthropic
):
    fake_anthropic(json.dumps({"old_latex": BULLET, "new_latex": BULLET}))
    res = await _edit(client, device)
    assert res.status_code == 422


async def test_a_refusal_is_422(client, device, anthropic_key, fake_anthropic):
    fake_anthropic("", stop_reason="refusal")
    res = await _edit(client, device)
    assert res.status_code == 422


async def test_edit_sends_no_fetch_tool(client, device, anthropic_key, fake_anthropic):
    """Context links are an adder feature. Editing does not take them, so the
    request must not carry a tool with an empty domain allowlist — which would
    be a fetch tool scoped to nothing in particular."""
    fake_anthropic(json.dumps({"old_latex": BULLET, "new_latex": "x"}))
    await _edit(client, device)
    assert _calls[0]["tools"] == []


async def test_edit_can_delete_text(client, device, anthropic_key, fake_anthropic):
    """An empty replacement is a legitimate edit — it is how a bullet is
    removed — and must not be confused with an empty *quote*."""
    fake_anthropic(json.dumps({"old_latex": BULLET, "new_latex": ""}))
    res = await _edit(client, device)
    assert res.status_code == 200
    assert res.json()["new_latex"] == ""


async def test_an_overlapping_quote_is_ambiguous(
    client, device, anthropic_key, fake_anthropic
):
    """`str.count` counts non-overlapping matches and would call this unique.

    A quote of two newlines inside a run of three matches at two offsets, and
    replacing at each gives a different document — so it is ambiguous, and the
    server has to agree with the client about that (`replaceResumeEntry` steps
    by one for the same reason).
    """
    # Non-whitespace, because a whitespace-only quote is caught earlier by the
    # `old_latex.strip()` guard and never reaches the occurrence check.
    # "aba" matches "ababa" at offsets 0 and 2 — overlapping, and each
    # replacement yields a different document.
    fake_anthropic(json.dumps({"old_latex": "aba", "new_latex": "X"}))
    res = await _edit(client, device, source="ababa")
    assert res.status_code == 422
    assert "more than one" in res.json()["detail"]


def test_count_occurrences_counts_overlaps():
    assert resume._count_occurrences("aaa", "aa") == 2
    assert resume._count_occurrences("abcabc", "abc") == 2
    assert resume._count_occurrences("abc", "zzz") == 0
    # An empty needle would otherwise loop forever, or match everywhere.
    assert resume._count_occurrences("abc", "") == 0


# --------------------------------------------------------------------------
# Tailoring. The endpoint compiles what the model wrote before returning it,
# so `compile_source` is stubbed here — a real TeX run belongs in the latex
# suite, and what matters at this level is what the endpoint does with each
# possible answer.
# --------------------------------------------------------------------------

_RESUME = "\n".join(
    [
        r"\documentclass{article}",
        r"\begin{document}",
        r"\section{Experience}",
        r"Something I did.",
        r"% \section{Benched}",
        r"% A project not currently on the page.",
        r"\end{document}",
    ]
)

_ONE_PAGE = (True, "Output written on main.pdf (1 page, 900 bytes).", 1)
_TWO_PAGES = (True, "Output written on main.pdf (2 pages, 1800 bytes).", 2)


def _stub_compile(monkeypatch, *outcomes, incoming=_ONE_PAGE, probe=True):
    """Queue (succeeded, log, pages) results, one per compile. The last repeats.

    The tailor compiles the *incoming* document first, to decide whether it needs
    condensing to a page before anything is written. `incoming` is that probe's
    answer and defaults to one page, so a test that says nothing about it gets the
    single-pass flow; pass `incoming=_TWO_PAGES` to exercise the selection pass.
    `probe=False` for the edit endpoint, which has no such measurement — its only
    compile is the one verifying a whole-document rewrite.

    Records each source it was handed, so a test can assert a retry compiled the
    *new* document rather than the one that was already rejected. The probe's own
    call is not recorded — it is a measurement, not an attempt.
    """
    seen: list[str] = []
    probed = {"done": not probe}

    async def fake(source: str, engine: str):
        if not probed["done"]:
            probed["done"] = True
            return incoming
        seen.append(source)
        return outcomes[min(len(seen) - 1, len(outcomes) - 1)]

    monkeypatch.setattr(resume, "compile_source", fake)
    return seen


async def _tailor(client, device, **overrides):
    body = {
        "source": _RESUME,
        "company": "Acme",
        "role": "Backend Engineer",
        "job_description": "You will build APIs. Requires Postgres and Kubernetes.",
    }
    body.update(overrides)
    return await client.post("/resume/tailor", json=body, headers=device)


async def test_tailor_returns_503_without_an_api_key(client, device, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "anthropic_api_key", "", raising=False)
    try:
        res = await _tailor(client, device)
    finally:
        get_settings.cache_clear()
    assert res.status_code == 503


async def test_tailor_needs_a_role(client, device, anthropic_key):
    res = await _tailor(client, device, role="   ")
    assert res.status_code == 400


async def test_tailor_needs_a_job_description(client, device, anthropic_key):
    res = await _tailor(client, device, job_description="  ")
    assert res.status_code == 400
    assert "job description" in res.json()["detail"]


async def test_tailor_needs_a_resume(client, device, anthropic_key):
    res = await _tailor(client, device, source="   ")
    assert res.status_code == 400


async def test_tailor_refuses_an_enormous_job_description(client, device, anthropic_key):
    res = await _tailor(client, device, job_description="x" * 20_001)
    assert res.status_code == 413


async def test_tailor_rejects_an_unknown_engine(client, device, anthropic_key):
    # The engine reaches a subprocess, so it is a closed set rather than free text.
    res = await _tailor(client, device, engine="; rm -rf /")
    assert res.status_code == 422


async def test_tailor_returns_a_one_page_document(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    seen = _stub_compile(monkeypatch, _ONE_PAGE)
    fake_anthropic(json.dumps({"latex": _RESUME, "emphasis": "Led with API work"}))
    res = await _tailor(client, device)
    assert res.status_code == 200
    body = res.json()
    assert body["latex"] == _RESUME
    assert body["emphasis"] == "Led with API work"
    assert body["pages"] == 1
    # One compile: right first time, so no retry was spent.
    assert len(seen) == 1


async def test_tailor_retries_when_it_comes_out_too_long(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    """A two-page answer is sent back to be cut, not handed over as-is."""
    seen = _stub_compile(monkeypatch, _TWO_PAGES, _ONE_PAGE)
    long_doc = _RESUME + "\n% and more\n"
    set_responses(
        (json.dumps({"latex": long_doc, "emphasis": "first go"}), "end_turn"),
        (json.dumps({"latex": _RESUME, "emphasis": "trimmed"}), "end_turn"),
    )
    res = await _tailor(client, device)
    assert res.status_code == 200
    assert res.json()["pages"] == 1
    assert res.json()["latex"] == _RESUME
    # Two compiles, and the second saw the new document rather than the old one.
    # Compared against the stripped form: the endpoint trims surrounding
    # whitespace before compiling, so that is what TeX is actually handed.
    assert len(seen) == 2
    assert seen[0] == long_doc.strip()
    assert seen[1] == _RESUME
    # The retry told it how long it came out, so it can cut the right amount.
    follow_up = _calls[-1]["messages"][-1]
    assert follow_up["role"] == "user"
    assert "2 pages" in follow_up["content"]


async def test_tailor_refuses_a_document_that_does_not_compile(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    """The safety property the whole endpoint rests on: broken LaTeX never
    reaches the client, because this is the one endpoint that replaces the
    document rather than reaching into it."""
    _stub_compile(monkeypatch, (False, "! Undefined control sequence.", None))
    fake_anthropic(json.dumps({"latex": "\\bogus", "emphasis": "nope"}))
    res = await _tailor(client, device)
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert "compile" in detail
    # And it says the resume survived, which is what the user actually needs.
    assert "unchanged" in detail


async def test_tailor_sends_the_tex_log_back_on_a_failed_compile(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    _stub_compile(
        monkeypatch,
        (False, "! Undefined control sequence \\bogus", None),
        _ONE_PAGE,
    )
    set_responses(
        (json.dumps({"latex": "\\bogus", "emphasis": "first"}), "end_turn"),
        (json.dumps({"latex": _RESUME, "emphasis": "fixed"}), "end_turn"),
    )
    res = await _tailor(client, device)
    assert res.status_code == 200
    follow_up = _calls[-1]["messages"][-1]["content"]
    assert "did not compile" in follow_up
    assert "Undefined control sequence" in follow_up


async def test_tailor_reports_the_real_page_count_when_attempts_run_out(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    """It compiles, so it is a useful starting point — but two pages must not be
    presented as a one-page resume."""
    _stub_compile(monkeypatch, _TWO_PAGES)
    fake_anthropic(json.dumps({"latex": _RESUME, "emphasis": "still long"}))
    res = await _tailor(client, device)
    assert res.status_code == 200
    assert res.json()["pages"] == 2


async def test_tailor_stops_after_the_attempt_cap(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    seen = _stub_compile(monkeypatch, _TWO_PAGES)
    fake_anthropic(json.dumps({"latex": _RESUME, "emphasis": "still long"}))
    res = await _tailor(client, device)
    assert res.status_code == 200
    # Bounded: every attempt costs a model call and a TeX run, and someone waits.
    assert len(seen) == resume._MAX_TAILOR_ATTEMPTS


async def test_tailor_refuses_an_empty_document(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    _stub_compile(monkeypatch, _ONE_PAGE)
    fake_anthropic(json.dumps({"latex": "   ", "emphasis": ""}))
    res = await _tailor(client, device)
    assert res.status_code == 502


async def test_tailor_prompt_carries_the_commented_out_material(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    """The benched entries are the point — tailoring is mostly choosing among
    them — so the whole source including its comments must reach the model."""
    _stub_compile(monkeypatch, _ONE_PAGE)
    fake_anthropic(json.dumps({"latex": _RESUME, "emphasis": "ok"}))
    res = await _tailor(client, device)
    assert res.status_code == 200
    prompt = _calls[0]["messages"][0]["content"]
    assert "% A project not currently on the page." in prompt
    assert "Postgres and Kubernetes" in prompt
    assert "Backend Engineer" in prompt


async def test_tailor_attaches_no_fetch_tool(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    """No URL in a pasted job description is ever fetched. The adder takes links
    deliberately supplied in their own field; nothing here reads the web."""
    _stub_compile(monkeypatch, _ONE_PAGE)
    fake_anthropic(json.dumps({"latex": _RESUME, "emphasis": "ok"}))
    res = await _tailor(
        client, device, job_description="Apply at https://evil.test/x - requires Go."
    )
    assert res.status_code == 200
    assert _calls[0]["tools"] == []


async def test_tailor_says_something_sensible_when_the_page_count_is_unreadable(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    """`page_count` returns None when it can't read the log, even on a compile
    that worked. The retry message must not then read "it came out None pages"."""
    _stub_compile(monkeypatch, (True, "a log in some format we don't parse", None), _ONE_PAGE)
    set_responses(
        (json.dumps({"latex": _RESUME + "\n% more\n", "emphasis": "first"}), "end_turn"),
        (json.dumps({"latex": _RESUME, "emphasis": "second"}), "end_turn"),
    )
    res = await _tailor(client, device)
    assert res.status_code == 200
    follow_up = _calls[-1]["messages"][-1]["content"]
    assert "None pages" not in follow_up
    assert "could not confirm" in follow_up
    # And it still asks for the same fix.
    assert "Cut content" in follow_up


# --------------------------------------------------------------------------
# Reading a job posting from a link.
#
# The property worth protecting is the refusal. Most job sites cannot be read
# (LinkedIn and Workday refuse the fetch outright, Ashby is a JavaScript shell),
# and the bad outcome is not the refusal — it is a model that answers anyway.
# A fabricated posting produces a resume tailored to a page nobody read, which
# the person then sends to an employer.
# --------------------------------------------------------------------------


async def _posting(client, device, url="https://boards.example.com/jobs/1"):
    return await client.post("/resume/job-posting", json={"url": url}, headers=device)


async def test_posting_returns_503_without_an_api_key(client, device, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "anthropic_api_key", "", raising=False)
    try:
        res = await _posting(client, device)
    finally:
        get_settings.cache_clear()
    assert res.status_code == 503


async def test_posting_rejects_a_non_link_without_asking_the_model(
    client, device, anthropic_key
):
    """`no_real_anthropic_calls` is autouse, so reaching the model here would
    itself fail — which is the assertion: a malformed link costs nothing."""
    for bad in ("not a link", "", "   ", "ftp://example.com/x", "javascript:alert(1)"):
        res = await client.post("/resume/job-posting", json={"url": bad}, headers=device)
        assert res.status_code == 400, bad


async def test_posting_returns_what_the_page_said(
    client, device, anthropic_key, fake_anthropic
):
    fake_anthropic(
        json.dumps(
            {
                "readable": True,
                "company": "  Acme  ",
                "role": " Senior Backend Engineer ",
                "description": "Requires Kubernetes, Terraform and Postgres.",
            }
        )
    )
    res = await _posting(client, device)
    assert res.status_code == 200
    body = res.json()
    assert body["company"] == "Acme"
    assert body["role"] == "Senior Backend Engineer"
    assert "Kubernetes" in body["description"]


async def test_posting_refuses_when_the_page_could_not_be_read(
    client, device, anthropic_key, fake_anthropic
):
    fake_anthropic(
        json.dumps({"readable": False, "company": "", "role": "", "description": ""})
    )
    res = await _posting(client, device)
    assert res.status_code == 422
    # The client matches on this to reveal its paste fields, so the instruction
    # has to survive rewording of the rest.
    assert "aste" in res.json()["detail"]


async def test_posting_refuses_an_empty_description_even_when_claimed_readable(
    client, device, anthropic_key, fake_anthropic
):
    """`readable` is the model's own report of itself; the description is the
    check on it. A page it says it read but got nothing from is not a posting."""
    fake_anthropic(
        json.dumps(
            {"readable": True, "company": "Acme", "role": "Engineer", "description": "   "}
        )
    )
    res = await _posting(client, device)
    assert res.status_code == 422


async def test_posting_scopes_the_fetch_tool_to_that_host(
    client, device, anthropic_key, fake_anthropic
):
    """The tool will fetch any URL in the conversation, so it is confined to the
    host the person actually gave — the same rule the adder's context links use."""
    fake_anthropic(
        json.dumps(
            {
                "readable": True,
                "company": "Acme",
                "role": "Engineer",
                "description": "Requires Go.",
            }
        )
    )
    res = await _posting(client, device, url="https://boards.example.com/jobs/7")
    assert res.status_code == 200
    tools = _calls[0]["tools"]
    assert len(tools) == 1
    assert tools[0]["type"] == "web_fetch_20260209"
    assert tools[0]["allowed_domains"] == ["boards.example.com"]
    assert tools[0]["max_uses"] == 1


async def test_tailor_condenses_first_when_the_resume_is_over_a_page(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    """Two passes, in order: choose what fits, then write it for the job.

    They were one pass, and length beat selection every time — a resume arriving
    over a page got shortened rather than re-aimed, with nothing ever promoted off
    the bench. Splitting them means the choice gets a turn of its own.
    """
    seen = _stub_compile(monkeypatch, _ONE_PAGE, incoming=_TWO_PAGES)
    condensed = _RESUME + "\n% condensed\n"
    set_responses(
        (json.dumps({"latex": condensed}), "end_turn"),
        (json.dumps({"latex": _RESUME, "emphasis": "aimed"}), "end_turn"),
    )
    res = await _tailor(client, device)
    assert res.status_code == 200
    assert len(_calls) == 2
    # The first pass is told to choose and not to write...
    assert "You do not" in _calls[0]["system"]
    # ...and it is told what to choose *by*: the job's required qualifications,
    # each of which is what / how / why / where. Without that it ranks by what was
    # already on the page, which is the behaviour this pass exists to replace.
    for part in ("What a qualification is", "**What**", "**How**", "**Why**", "**Where**"):
        assert part in _calls[0]["system"], part
    # ...and the second is handed what it produced, not the original.
    assert condensed.strip() in _calls[1]["messages"][0]["content"]
    assert res.json()["latex"] == _RESUME


async def test_tailor_condenses_when_the_incoming_page_count_is_unknown(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    """`page_count` returns None when it cannot read the log. Unknown is not the
    same as "fits" — skipping the condense pass on a document that might be three
    pages is exactly the case that produced a shortened resume instead of a
    re-aimed one."""
    _stub_compile(monkeypatch, _ONE_PAGE, incoming=(True, "unparseable log", None))
    set_responses(
        (json.dumps({"latex": _RESUME}), "end_turn"),
        (json.dumps({"latex": _RESUME, "emphasis": "aimed"}), "end_turn"),
    )
    res = await _tailor(client, device)
    assert res.status_code == 200
    # Both passes ran.
    assert len(_calls) == 2


async def test_tailor_skips_the_condense_pass_when_it_already_fits(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    """A one-page resume has nothing to condense, and a selection pass over it
    would be a chance to drop something for no gain."""
    _stub_compile(monkeypatch, _ONE_PAGE, incoming=_ONE_PAGE)
    fake_anthropic(json.dumps({"latex": _RESUME, "emphasis": "aimed"}))
    res = await _tailor(client, device)
    assert res.status_code == 200
    assert len(_calls) == 1
    assert "You do not" not in _calls[0]["system"]


async def test_tailor_condense_pass_refuses_rather_than_returning_a_broken_document(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    _stub_compile(monkeypatch, (False, "! Undefined control sequence.", None),
                  incoming=_TWO_PAGES)
    fake_anthropic(json.dumps({"latex": "\\bogus"}))
    res = await _tailor(client, device)
    assert res.status_code == 422
    assert "unchanged" in res.json()["detail"]


def test_repair_unicode_escapes_restores_mangled_characters():
    """Seen in the wild: a model writing JSON full of LaTeX backslashes
    double-escapes its non-ASCII, so a degree sign arrives as six characters.

    It compiles silently when the damage lands in a commented-out entry, and
    breaks whenever that entry is next promoted onto the page.
    """
    mangled = (
        "infill patterns (+/-45\\u00b0 to +/-90\\u00b0), "
        "Young\\u2019s Modulus (1.0\\u20132.0 GPa), 3:56 \\u2192 1:28"
    )
    assert resume._repair_unicode_escapes(mangled) == (
        "infill patterns (+/-45\u00b0 to +/-90\u00b0), "
        "Young\u2019s Modulus (1.0\u20132.0 GPa), 3:56 \u2192 1:28"
    )


def test_repair_leaves_ascii_escapes_alone():
    """Only non-ASCII is repaired. A hypothetical \\u0041 in someone's document
    is theirs, and rewriting it to "A" would be this server editing their LaTeX."""
    assert resume._repair_unicode_escapes("\\u0041\\u007a") == "\\u0041\\u007a"


def test_repair_leaves_the_latex_breve_accent_alone():
    r"""``\u`` is a real LaTeX command — the breve accent — but it is written
    ``\u{o}``, braces rather than four hex digits, so the pattern cannot match
    it. This is what makes the repair safe rather than merely clever."""
    assert resume._repair_unicode_escapes(r"\u{o} and \u{a}") == r"\u{o} and \u{a}"


def test_repair_leaves_an_undamaged_document_untouched():
    document = "\\section{Experience}\n\\item 45\u00b0 and a real \u2192 arrow"
    assert resume._repair_unicode_escapes(document) == document


async def test_tailor_repairs_mangled_characters_before_compiling(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    """The repair happens before the TeX run, so what was compiled is what the
    client is handed — not a document that was checked in one form and returned
    in another."""
    seen = _stub_compile(monkeypatch, _ONE_PAGE)
    fake_anthropic(
        json.dumps(
            {"latex": "\\item 45\\u00b0 turn", "emphasis": "ok"}
        )
    )
    res = await _tailor(client, device)
    assert res.status_code == 200
    assert res.json()["latex"] == "\\item 45\u00b0 turn"
    assert seen[0] == "\\item 45\u00b0 turn"


# --------------------------------------------------------------------------
# Edit scope. A quoted span is verified against the source; a whole-document
# rewrite cannot be, so it is compiled instead. The two reaches get different
# guarantees, and the danger is a document rewrite slipping through the span
# path's checks or vice versa.
# --------------------------------------------------------------------------


async def test_document_scope_returns_the_whole_rewrite(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    seen = _stub_compile(monkeypatch, _ONE_PAGE, probe=False)
    rewritten = _RESUME + "\n% rewritten\n"
    fake_anthropic(
        json.dumps(
            {
                "scope": "document",
                "old_latex": "",
                "new_latex": rewritten,
                "summary": "Rewrote the whole resume",
            }
        )
    )
    res = await _edit(client, device, source=_RESUME)
    assert res.status_code == 200
    body = res.json()
    assert body["scope"] == "document"
    assert body["old_latex"] == ""
    assert body["new_latex"] == rewritten
    # It was compiled before it was handed over — that is the only check a
    # rewrite gets, since there is no quote left to verify.
    assert len(seen) == 1


async def test_document_scope_refuses_a_rewrite_that_does_not_compile(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    """The whole guarantee for this path: broken LaTeX never reaches the client."""
    _stub_compile(monkeypatch, (False, "! Undefined control sequence.", None), probe=False)
    fake_anthropic(
        json.dumps(
            {"scope": "document", "old_latex": "", "new_latex": "\\bogus", "summary": "x"}
        )
    )
    res = await _edit(client, device, source=_RESUME)
    assert res.status_code == 422
    assert "unchanged" in res.json()["detail"]


async def test_document_scope_refuses_a_no_op_rewrite(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    _stub_compile(monkeypatch, _ONE_PAGE)
    fake_anthropic(
        json.dumps(
            {"scope": "document", "old_latex": "", "new_latex": _RESUME, "summary": "x"}
        )
    )
    res = await _edit(client, device, source=_RESUME)
    assert res.status_code == 422
    assert "would not change anything" in res.json()["detail"]


async def test_document_scope_refuses_an_empty_rewrite(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    _stub_compile(monkeypatch, _ONE_PAGE)
    fake_anthropic(
        json.dumps({"scope": "document", "old_latex": "", "new_latex": "   ", "summary": "x"})
    )
    res = await _edit(client, device, source=_RESUME)
    assert res.status_code == 502


async def test_span_scope_is_never_compiled(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    """A quoted span changes nothing outside its quote, so there is nothing a
    compile would tell us that the occurrence check has not already."""
    seen = _stub_compile(monkeypatch, _ONE_PAGE)
    fake_anthropic(
        json.dumps(
            {
                "scope": "span",
                "old_latex": "Something I did.",
                "new_latex": "Something else I did.",
                "summary": "Reworded it",
            }
        )
    )
    res = await _edit(client, device, source=_RESUME)
    assert res.status_code == 200
    assert res.json()["scope"] == "span"
    assert seen == []


async def test_a_response_with_no_scope_reads_as_a_span(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    """The narrow path is the default, so anything ambiguous gets the checks
    rather than the compile-and-hope."""
    seen = _stub_compile(monkeypatch, _ONE_PAGE)
    fake_anthropic(
        json.dumps(
            {"old_latex": "Something I did.", "new_latex": "Changed.", "summary": "x"}
        )
    )
    res = await _edit(client, device, source=_RESUME)
    assert res.status_code == 200
    assert res.json()["scope"] == "span"
    assert seen == []


async def test_document_scope_repairs_mangled_characters(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    _stub_compile(monkeypatch, _ONE_PAGE)
    fake_anthropic(
        json.dumps(
            {
                "scope": "document",
                "old_latex": "",
                "new_latex": "\\item 45\\u00b0 turn",
                "summary": "x",
            }
        )
    )
    res = await _edit(client, device, source=_RESUME)
    assert res.status_code == 200
    assert res.json()["new_latex"] == "\\item 45\u00b0 turn"


def test_page_count_reads_the_tex_log():
    from app.routers.latex import page_count

    assert page_count("Output written on main.pdf (1 page, 900 bytes).") == 1
    assert page_count("Output written on main.pdf (12 pages, 90000 bytes).") == 12
    # A failed compile writes no such line, and unknown must not read as zero.
    assert page_count("! Undefined control sequence.") is None
    assert page_count("") is None


async def test_a_truncated_reply_says_so_rather_than_reading_as_empty(
    client, device, anthropic_key, fake_anthropic
):
    """Running out of room mid-answer used to present as an empty edit.

    The JSON is cut off, so it parses with empty fields (or not at all) and the
    endpoint reported "empty" for something that was in fact too long — which is
    the opposite of actionable. This is the branch that tells the truth.
    """
    fake_anthropic(json.dumps({"scope": "document", "old_latex": "", "new_latex": "\doc"}),
                   stop_reason="max_tokens")
    res = await _edit(client, device, source=_RESUME)
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert "longer than the server allows" in detail
    assert "smaller part" in detail


async def test_edit_asks_for_room_to_return_a_whole_document(
    client, device, anthropic_key, fake_anthropic, monkeypatch
):
    """The edit path can return a whole rewritten document, so it must ask for the
    budget that fits one — not the entry-sized default it inherited when an edit
    was only ever a short quoted span. Too small and a real resume truncates
    mid-generation, which is how this surfaced: as an empty edit."""
    _stub_compile(monkeypatch, _ONE_PAGE, probe=False)
    fake_anthropic(
        json.dumps({"scope": "span", "old_latex": "Something I did.",
                    "new_latex": "Changed.", "summary": "x"})
    )
    res = await _edit(client, device, source=_RESUME)
    assert res.status_code == 200
    assert _calls[0]["max_tokens"] == resume._MAX_TAILOR_OUTPUT_TOKENS
    assert _client_kwargs[0]["timeout"] == resume._TAILOR_CALL_TIMEOUT_SECONDS
