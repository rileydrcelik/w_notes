"""The LaTeX compile endpoint's guard rails.

`POST /latex/compile` runs a TeX engine over text a user pasted in, which makes
it the one endpoint in this service that executes attacker-controlled input. The
protections that matter — no shell escape, paranoid file access, dropped
privileges, the timeout, the size cap, the concurrency limit, the scrubbed
environment — are all invisible in a passing happy-path test, so they're what
these cover.

The engine itself is not exercised here: TeX Live lives in the image, not on a
dev machine or a CI runner, and installing half a gigabyte of it would make the
suite depend on a package mirror. The subprocess is stubbed and the *arguments
and environment it would be given* are asserted instead — those are the security
boundary, and they're pure data.

The boundary moved when the engine did. Tectonic had one ``--untrusted`` flag
that covered everything; TeX Live has no such switch, so the same guarantees are
now assembled from several settings that each fail silently and independently.
That is exactly why they're tested one by one.
"""

from __future__ import annotations

import asyncio
import base64

import pytest

from app.routers import latex


class _FakeProcess:
    """Stands in for the latexmk subprocess."""

    def __init__(self, returncode: int = 0, output: bytes = b"", hang: bool = False):
        self.returncode = returncode
        self._output = output
        self._hang = hang
        self.killed = False
        self.waited = False

    async def communicate(self):
        if self._hang:
            await asyncio.sleep(3600)
        return self._output, b""

    def kill(self):
        self.killed = True

    async def wait(self):
        self.waited = True


@pytest.fixture
def spawned(monkeypatch):
    """Capture the argv/env a compile would launch, and write a PDF for it."""
    calls: list[dict] = []

    async def _fake_exec(*args, **kwargs):
        calls.append(
            {
                "args": args,
                "env": kwargs.get("env", {}),
                "cwd": kwargs.get("cwd"),
                "user": kwargs.get("user"),
                "group": kwargs.get("group"),
            }
        )
        # latexmk writes its output into --outdir; mimic that so the handler
        # finds a PDF exactly where it expects one.
        from pathlib import Path

        Path(kwargs["cwd"], "main.pdf").write_bytes(b"%PDF-1.5 fake")
        return _FakeProcess(returncode=0)

    monkeypatch.setattr(latex.asyncio, "create_subprocess_exec", _fake_exec)
    monkeypatch.setattr(latex.shutil, "which", lambda _p: "/usr/bin/latexmk")
    return calls


async def test_compiles_and_returns_the_pdf(client, spawned):
    res = await client.post(
        "/latex/compile",
        json={"source": "\\documentclass{article}\\begin{document}hi\\end{document}"},
        headers={"Authorization": "Bearer device-key-1"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert base64.b64decode(body["pdf_base64"]).startswith(b"%PDF")


async def _compile(client, **payload):
    """POST a compile with the auth header these tests all need."""
    return await client.post(
        "/latex/compile",
        json={"source": "hello", **payload},
        headers={"Authorization": "Bearer device-key-1"},
    )


async def test_shell_escape_is_disabled(client, spawned):
    """Without this, `\\write18` in a pasted resume runs shell commands as the
    API process, which owns the database credentials.

    It has to be passed explicitly: Debian's TeX Live defaults to *restricted*
    shell escape, which still permits a list of helper programs. The flag is the
    difference between "some programs" and "none".
    """
    await _compile(client)
    assert "-no-shell-escape" in spawned[0]["args"]


async def test_the_document_cannot_read_or_write_outside_its_own_directory(client, spawned):
    """kpathsea's paranoid mode, and the reason LuaLaTeX isn't offered.

    Set to anything looser, `\\input{/etc/passwd}` typesets the file into the PDF
    and hands it back to whoever pasted the document. There is no flag for this —
    it is only these two environment variables.
    """
    await _compile(client)
    env = spawned[0]["env"]
    assert env["openin_any"] == "p"
    assert env["openout_any"] == "p"


async def test_the_compile_runs_as_an_unprivileged_user(client, spawned, monkeypatch):
    """A document that escapes TeX must not land as the user holding the task's
    environment. In the image the account exists and this process is root, so the
    drop happens; the patches below are that situation.

    `os.chown` is patched rather than guarded in the router because a non-None
    credential can only come from a platform that has `pwd` and `geteuid` — it
    implies POSIX. This suite also runs on Windows, where forcing the credential
    creates a state the router can't otherwise reach.
    """
    chowned: list[tuple] = []
    monkeypatch.setattr(latex, "_compile_user", lambda: (4242, 4243))
    monkeypatch.setattr(latex.os, "chown", lambda p, u, g: chowned.append((p, u, g)), raising=False)

    await _compile(client)
    argv = [str(a) for a in spawned[0]["args"]]
    # Via `setpriv`, not a `user=` keyword: asyncio's subprocess API rejects
    # `user`/`group` ("unexpected kwargs") where subprocess.Popen accepts them,
    # and that mistake 500s every compile while looking correct in review.
    assert argv[0].endswith("setpriv"), f"the compile is not wrapped: {argv[0]!r}"
    assert "--reuid=4242" in argv
    assert "--regid=4243" in argv
    assert "--clear-groups" in argv
    # setpriv must come first, or it drops privileges for nothing.
    assert argv.index("--reuid=4242") < argv.index(latex._ENGINE_FLAGS["pdflatex"])
    # Without handing the scratch directory over, the dropped user cannot write
    # its own .aux/.log and every compile fails — silently, as a TeX error.
    assert chowned and chowned[0][1:] == (4242, 4243)


async def test_runs_as_ourselves_when_there_is_nobody_to_drop_to(client, spawned, monkeypatch):
    """Off-image — a dev machine, this suite — there is no `latex` account and no
    root to drop from. That must degrade to "run as us", not crash the endpoint,
    and the command must then start with the engine rather than a wrapper that
    would fail because there is no privilege to drop."""
    monkeypatch.setattr(latex, "_compile_user", lambda: None)

    res = await _compile(client)
    assert res.status_code == 200
    argv = [str(a) for a in spawned[0]["args"]]
    assert "setpriv" not in argv[0]
    assert not any(a.startswith("--reuid") for a in argv)


async def test_does_not_hand_the_document_our_environment(client, spawned, monkeypatch):
    """A compile gets a scrubbed env — not the process's, which holds the
    database URL and the Sentry/GitHub tokens."""
    monkeypatch.setenv("DATABASE_URL", "postgresql://secret@host/db")

    await _compile(client)
    env = spawned[0]["env"]
    assert "DATABASE_URL" not in env
    assert set(env) == {
        "PATH",
        "HOME",
        "TEXMFHOME",
        "TEXMFVAR",
        "TEXMFCONFIG",
        "openin_any",
        "openout_any",
        "SOURCE_DATE_EPOCH",
        "FORCE_SOURCE_DATE",
    }


async def test_every_writable_tex_path_stays_in_the_scratch_directory(client, spawned):
    """A TeX run writes font caches and config of its own. Every path it might
    choose points inside the directory that gets destroyed with the request, so
    nothing one document leaves behind is visible to the next."""
    await _compile(client)
    env = spawned[0]["env"]
    scratch = env["HOME"]
    for key in ("TEXMFHOME", "TEXMFVAR", "TEXMFCONFIG"):
        assert env[key].startswith(scratch), f"{key} escapes the scratch directory"


async def test_the_source_is_named_relatively_from_the_scratch_directory(client, spawned):
    """The invocation and the sandbox are coupled.

    `openin_any=p` refuses to open an absolute path, so passing the full
    `/tmp/latex-xxx/main.tex` makes TeX report "I can't find file" for a file
    that exists and is readable — every compile fails. The pairing that works is
    cwd = the scratch directory and a bare `main.tex`.
    """
    await _compile(client)
    argv = [str(a) for a in spawned[0]["args"]]
    assert argv[-1] == "main.tex", f"the source must be named relatively, got {argv[-1]!r}"
    assert spawned[0]["cwd"], "…which only works with the scratch directory as cwd"
    assert not any(a.startswith("-outdir") for a in argv), (
        "no -outdir: output lands beside the source, where the handler looks"
    )


async def test_the_default_engine_is_the_one_overleaf_uses(client, spawned):
    """pdfLaTeX, because that is what a pasted template was written against.
    Under XeTeX a RenderCV resume silently loses its font and Jake's Resume does
    not compile at all — see the router docstring."""
    await _compile(client)
    assert latex._ENGINE_FLAGS["pdflatex"] in spawned[0]["args"]


async def test_the_engine_can_be_chosen_per_document(client, spawned):
    """fontspec templates need XeLaTeX; pdfTeX cannot run fontspec at all."""
    await _compile(client, engine="xelatex")
    assert latex._ENGINE_FLAGS["xelatex"] in spawned[0]["args"]


async def test_an_unknown_engine_never_reaches_the_command_line(client, spawned):
    """The engine is the one request field that becomes argv. It's an enum so
    that validation rejects anything else before a subprocess exists."""
    res = await _compile(client, engine="pdflatex; rm -rf /")
    assert res.status_code == 422
    assert spawned == []


async def test_a_runaway_document_is_killed_not_waited_on(client, monkeypatch):
    """`\\loop` is one line of LaTeX. A compile that never ends must not hold the
    request (or the process) open."""

    async def _hanging_exec(*args, **kwargs):
        return _FakeProcess(hang=True)

    monkeypatch.setattr(latex.asyncio, "create_subprocess_exec", _hanging_exec)
    monkeypatch.setattr(latex.shutil, "which", lambda _p: "/usr/bin/latexmk")
    monkeypatch.setattr(latex, "_TIMEOUT_SECONDS", 0.05)

    res = await client.post(
        "/latex/compile",
        json={"source": "\\loop\\repeat"},
        headers={"Authorization": "Bearer device-key-1"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "timed out" in body["log"].lower()


async def test_an_oversized_document_is_refused_before_tex_runs(client, spawned):
    huge = "x" * (latex._MAX_SOURCE_BYTES + 1)
    res = await client.post(
        "/latex/compile",
        json={"source": huge},
        headers={"Authorization": "Bearer device-key-1"},
    )
    assert res.status_code == 413
    assert spawned == []  # never reached the engine


async def test_an_empty_document_is_refused(client, spawned):
    res = await client.post(
        "/latex/compile",
        json={"source": "   \n  "},
        headers={"Authorization": "Bearer device-key-1"},
    )
    assert res.status_code == 400
    assert spawned == []


async def test_requires_authentication(client, spawned):
    res = await client.post("/latex/compile", json={"source": "hello"})
    assert res.status_code in (401, 403, 422)
    assert spawned == []


async def test_refuses_work_when_every_compile_slot_is_busy(client, spawned, monkeypatch):
    """A single small task serves sync, the health check and this. Unbounded
    concurrent compiles starve the event loop until ECS kills the task — so a
    saturated server says no rather than queueing everyone into a timeout."""
    monkeypatch.setattr(latex, "_compile_slots", asyncio.Semaphore(1))
    await latex._compile_slots.acquire()
    try:
        # Bounded wait on purpose. Without the guard the request doesn't fail —
        # it blocks forever on the semaphore this test is holding, and an
        # unbounded await would hang the suite instead of reporting the
        # regression.
        res = await asyncio.wait_for(
            client.post(
                "/latex/compile",
                json={"source": "hello"},
                headers={"Authorization": "Bearer device-key-1"},
            ),
            timeout=5,
        )
    finally:
        latex._compile_slots.release()

    assert res.status_code == 429
    assert spawned == []


async def test_a_failed_compile_is_a_200_with_the_log(client, monkeypatch):
    """A half-written resume is a normal outcome, not a server error — the client
    needs the log to show "Line 5: …" rather than a generic failure."""

    async def _failing_exec(*args, **kwargs):
        return _FakeProcess(
            returncode=1,
            output=b"error: main.tex:5: ! LaTeX Error: File `nope.sty' not found.\n",
        )

    monkeypatch.setattr(latex.asyncio, "create_subprocess_exec", _failing_exec)
    monkeypatch.setattr(latex.shutil, "which", lambda _p: "/usr/bin/latexmk")

    res = await client.post(
        "/latex/compile",
        json={"source": "\\usepackage{nope}"},
        headers={"Authorization": "Bearer device-key-1"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert body["pdf_base64"] is None
    assert "nope.sty" in body["log"]


async def test_refuses_to_compile_as_root_when_the_unprivileged_account_is_missing(
    client, spawned, monkeypatch
):
    """Fail closed, not open.

    `latex_user` is a setting, so a typo'd env var at deploy time would
    otherwise leave every pasted document running as root in the container that
    holds the database credentials — with the endpoint still returning 200 and
    nothing in the logs. It has to fail the way a missing engine does.
    """

    def _no_account():
        raise latex._NoCompileUser("latex")

    monkeypatch.setattr(latex, "_compile_user", _no_account)

    res = await _compile(client)
    assert res.status_code == 503
    assert spawned == []  # never reached TeX


async def test_reports_a_missing_engine_as_a_server_problem(client, monkeypatch):
    """No TeX Live in the image is a deploy failure. Saying so beats blaming the
    user's LaTeX for something no document could cause."""
    monkeypatch.setattr(latex.shutil, "which", lambda _p: None)

    res = await client.post(
        "/latex/compile",
        json={"source": "hello"},
        headers={"Authorization": "Bearer device-key-1"},
    )
    assert res.status_code == 503


class TestLogClamping:
    """What survives when a TeX log is too big to hand back whole.

    This is not a formatting nicety. The cap used to keep the *last*
    `_MAX_LOG_CHARS`, and a real two-page resume logs about 36k — so the window
    began past every `! LaTeX Error` line and past `Output written on`, leaving
    the font dump. The client parses `!` lines out of what it is given, found
    none, and showed "This document could not be compiled." with no message and
    no line number, for a document whose log named the error twice.

    So both ends have to survive: the head, where TeX reports what went wrong,
    and the tail, where a successful run says how many pages it made.
    """

    def _oversized_log(self) -> str:
        head = "! LaTeX Error: Missing \begin{document}.\n"
        tail = "\nOutput written on main.pdf (2 pages, 111127 bytes).\n"
        filler = "(/usr/share/texlive/texmf-dist/fonts/type1/public/amsfonts/cm/cmr10.pfb)\n"
        middle = filler * ((latex._MAX_LOG_CHARS * 3) // len(filler))
        return head + middle + tail

    def test_a_log_within_the_cap_is_returned_untouched(self):
        log = "! LaTeX Error: Undefined control sequence.\n"
        assert latex._clamp_log(log) == log

    def test_an_oversized_log_keeps_the_error_at_the_head(self):
        clamped = latex._clamp_log(self._oversized_log())
        assert "! LaTeX Error: Missing \begin{document}." in clamped

    def test_an_oversized_log_keeps_the_page_count_at_the_tail(self):
        clamped = latex._clamp_log(self._oversized_log())
        # `page_count` reads this line; losing it costs the page count on a
        # document that compiled perfectly well.
        assert "Output written on main.pdf (2 pages," in clamped
        assert latex.page_count(clamped) == 2

    def test_an_oversized_log_says_that_it_was_cut(self):
        clamped = latex._clamp_log(self._oversized_log())
        assert "characters of log elided" in clamped

    def test_the_clamped_log_never_exceeds_the_cap(self):
        # The marker counts against the budget rather than being added on top.
        assert len(latex._clamp_log(self._oversized_log())) <= latex._MAX_LOG_CHARS
