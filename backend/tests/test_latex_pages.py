"""Rasterising a compiled resume into per-page PNGs.

Native clients can't draw a PDF — a real viewer is a native module, and this app
ships fixes over the air — so the server renders the PDF it just built into
images the phone can show. Two properties carry the design, and both are pinned
here:

1. It happens inside the compile that already ran. A second compile per view is
   the bill commit ``3cd7907`` was written to stop paying.
2. It can never take the PDF away. Rasterising is a bonus on top of a successful
   compile, so every way it can fail still answers ``ok: true`` with the document
   attached, and the client falls back to downloading it — which is exactly what
   shipped before any of this existed. That makes the feature unable to regress
   below where it started.
"""

from __future__ import annotations

import asyncio
import base64
import struct
import zlib
from pathlib import Path

import pytest

from app.routers import latex

from tests.test_latex_compile import _FakeProcess


def _png(width: int, height: int) -> bytes:
    """A byte-valid PNG header of the given size — enough for `_png_size`."""
    ihdr = struct.pack(">II", width, height) + bytes([8, 6, 0, 0, 0])
    chunk = struct.pack(">I", len(ihdr)) + b"IHDR" + ihdr
    chunk += struct.pack(">I", zlib.crc32(b"IHDR" + ihdr))
    return b"\x89PNG\r\n\x1a\n" + chunk


async def _compile(client, **payload):
    return await client.post(
        "/latex/compile",
        json={"source": "hello", **payload},
        headers={"Authorization": "Bearer device-key-1"},
    )


@pytest.fixture
def rasterised(monkeypatch):
    """Stub both subprocesses: latexmk writes a PDF, pdftoppm writes PNGs.

    `pages` sets how many pages come out, so a test can drive the cap; `fail`
    makes the rasteriser exit non-zero while the compile still succeeds.
    """
    state: dict = {"pages": 2, "fail": False, "calls": []}

    async def _fake_exec(*args, **kwargs):
        state["calls"].append({"args": args, "env": kwargs.get("env", {})})
        cwd = Path(kwargs["cwd"])
        if "-png" in args:  # the rasteriser
            if state["fail"]:
                return _FakeProcess(returncode=1, output=b"pdftoppm: bad PDF")
            for n in range(1, state["pages"] + 1):
                (cwd / f"page-{n}.png").write_bytes(_png(800, 1035))
            return _FakeProcess(returncode=0)
        (cwd / "main.pdf").write_bytes(b"%PDF-1.5 fake")
        return _FakeProcess(returncode=0)

    monkeypatch.setattr(latex.asyncio, "create_subprocess_exec", _fake_exec)
    monkeypatch.setattr(latex.shutil, "which", lambda p: f"/usr/bin/{p}")
    return state


async def test_pages_come_back_when_asked_for(client, rasterised):
    res = await _compile(client, include_pages=True, page_width=800)
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["pages_error"] is None
    assert len(body["pages"]) == 2
    first = body["pages"][0]
    assert (first["width"], first["height"]) == (800, 1035)
    assert base64.b64decode(first["png_base64"]).startswith(b"\x89PNG")
    # The PDF is still there: pages are an addition, not a substitution.
    assert base64.b64decode(body["pdf_base64"]).startswith(b"%PDF")


async def test_web_gets_no_pages_and_pays_for_none(client, rasterised):
    """The default. Web draws the PDF itself with pdf.js, so asking the server
    for pixels would be bytes over the wire and CPU on a shared task, for an
    image it is never going to show."""
    body = (await _compile(client)).json()
    assert body["pages"] is None
    assert body["pages_error"] is None
    assert not any("-png" in call["args"] for call in rasterised["calls"])


async def test_one_compile_serves_both_the_pdf_and_the_pages(client, rasterised):
    """The reason pages live on this endpoint rather than one of their own: a
    separate call would have to compile the document again, or keep the first
    result somewhere."""
    await _compile(client, include_pages=True)
    tex_runs = [c for c in rasterised["calls"] if "-no-shell-escape" in c["args"]]
    assert len(tex_runs) == 1


async def test_a_broken_rasteriser_still_returns_the_document(client, rasterised):
    rasterised["fail"] = True
    body = (await _compile(client, include_pages=True)).json()
    assert body["ok"] is True
    assert base64.b64decode(body["pdf_base64"]).startswith(b"%PDF")
    assert body["pages"] is None
    assert body["pages_error"]


async def test_a_server_without_poppler_says_so_and_keeps_the_pdf(client, monkeypatch):
    """A deploy that hasn't picked up the image layer yet. Web calls this same
    endpoint constantly and must not start failing because of it."""

    async def _fake_exec(*args, **kwargs):
        Path(kwargs["cwd"], "main.pdf").write_bytes(b"%PDF-1.5 fake")
        return _FakeProcess(returncode=0)

    monkeypatch.setattr(latex.asyncio, "create_subprocess_exec", _fake_exec)
    monkeypatch.setattr(
        latex.shutil, "which", lambda p: None if "pdftoppm" in p else "/usr/bin/latexmk"
    )
    body = (await _compile(client, include_pages=True)).json()
    assert body["ok"] is True
    assert body["pdf_base64"]
    assert body["pages"] is None
    assert body["pages_error"]


async def test_a_document_past_the_page_cap_is_download_only(client, rasterised):
    rasterised["pages"] = latex._MAX_RASTER_PAGES + 1
    body = (await _compile(client, include_pages=True)).json()
    assert body["ok"] is True
    assert body["pdf_base64"]
    assert body["pages"] is None
    assert str(latex._MAX_RASTER_PAGES) in body["pages_error"]


async def test_the_cap_is_enforced_on_poppler_not_after_it(client, rasterised):
    """`-l` makes poppler stop one page past the cap. Counting the files it
    produced instead would run *after* a thousand-page document had already
    written a thousand images — a limit that costs exactly what it was meant to
    prevent."""
    await _compile(client, include_pages=True)
    raster = next(c for c in rasterised["calls"] if "-png" in c["args"])
    args = list(raster["args"])
    assert "-l" in args
    assert args[args.index("-l") + 1] == str(latex._MAX_RASTER_PAGES + 1)


async def test_pages_are_ordered_by_number_not_by_name(client, monkeypatch):
    """poppler names them `page-1` … `page-10`, which sort lexically as 1, 10, 2.
    A resume whose pages came back shuffled would read as a bug in the document
    rather than in the transport. Ten pages, because the reordering only shows
    up once the numbers reach two digits."""

    async def _exec(*args, **kwargs):
        cwd = Path(kwargs["cwd"])
        if "-png" in args:
            # Height encodes the page number, so the response's order is legible.
            for n in range(1, 11):
                (cwd / f"page-{n}.png").write_bytes(_png(800, 1000 + n))
            return _FakeProcess(returncode=0)
        (cwd / "main.pdf").write_bytes(b"%PDF-1.5 fake")
        return _FakeProcess(returncode=0)

    monkeypatch.setattr(latex.asyncio, "create_subprocess_exec", _exec)
    monkeypatch.setattr(latex.shutil, "which", lambda p: f"/usr/bin/{p}")
    body = (await _compile(client, include_pages=True)).json()
    assert [p["height"] for p in body["pages"]] == list(range(1001, 1011))


async def test_a_failed_compile_never_reaches_the_rasteriser(client, monkeypatch):
    """There is no PDF to draw, and "couldn't render the preview" would answer a
    question nobody asked — the document didn't compile."""
    calls: list[tuple] = []

    async def _failing_exec(*args, **kwargs):
        calls.append(args)
        return _FakeProcess(returncode=1, output=b"! Undefined control sequence.")

    monkeypatch.setattr(latex.asyncio, "create_subprocess_exec", _failing_exec)
    monkeypatch.setattr(latex.shutil, "which", lambda p: f"/usr/bin/{p}")
    body = (await _compile(client, include_pages=True)).json()
    assert body["ok"] is False
    assert body["pages"] is None
    assert body["pages_error"] is None
    assert not any("-png" in call for call in calls)


async def test_the_rasteriser_runs_as_the_unprivileged_user_too(
    client, rasterised, monkeypatch
):
    """poppler isn't executing the document the way TeX is — there's no
    `\\write18` equivalent — but it is parsing a file built from untrusted input,
    and a renderer's parser is a memory-safety surface. The sandbox is already
    built per request; running outside it would be a choice, not a saving."""
    monkeypatch.setattr(latex, "_compile_user", lambda: (4242, 4243))
    monkeypatch.setattr(latex.os, "chown", lambda *a, **k: None, raising=False)
    await _compile(client, include_pages=True)
    raster = next(c for c in rasterised["calls"] if "-png" in c["args"])
    assert "--reuid=4242" in raster["args"]
    assert "--regid=4243" in raster["args"]
    assert "--clear-groups" in raster["args"]


async def test_the_rasteriser_gets_none_of_our_environment(
    client, rasterised, monkeypatch
):
    monkeypatch.setenv("DATABASE_URL", "postgresql://secret@host/db")
    await _compile(client, include_pages=True)
    raster = next(c for c in rasterised["calls"] if "-png" in c["args"])
    assert "DATABASE_URL" not in raster["env"]


@pytest.mark.parametrize("width", [10, 99_999])
async def test_an_absurd_page_width_is_refused_before_any_work(
    client, monkeypatch, width
):
    """The ceiling stops a request spending the task's memory on a 50,000px
    page; the floor stops a "preview" nobody could read. Refused by validation,
    so no subprocess is ever launched."""
    calls: list[tuple] = []

    async def _record(*args, **kwargs):
        calls.append(args)
        return _FakeProcess(returncode=0)

    monkeypatch.setattr(latex.asyncio, "create_subprocess_exec", _record)
    monkeypatch.setattr(latex.shutil, "which", lambda p: f"/usr/bin/{p}")
    res = await _compile(client, include_pages=True, page_width=width)
    assert res.status_code == 422
    assert calls == []


async def test_rasterising_that_hangs_is_killed_and_the_pdf_still_returned(
    client, monkeypatch
):
    """Its own timeout, well short of TeX's: by this point the document has
    already compiled, and waiting a further minute to decide we can't draw it
    would hold a compile slot for nothing."""

    async def _exec(*args, **kwargs):
        cwd = Path(kwargs["cwd"])
        if "-png" in args:
            return _FakeProcess(returncode=0, hang=True)
        (cwd / "main.pdf").write_bytes(b"%PDF-1.5 fake")
        return _FakeProcess(returncode=0)

    monkeypatch.setattr(latex.asyncio, "create_subprocess_exec", _exec)
    monkeypatch.setattr(latex.shutil, "which", lambda p: f"/usr/bin/{p}")
    monkeypatch.setattr(latex, "_RASTER_TIMEOUT_SECONDS", 0.05)
    body = (await _compile(client, include_pages=True)).json()
    assert body["ok"] is True
    assert body["pdf_base64"]
    assert body["pages"] is None
    assert body["pages_error"]
