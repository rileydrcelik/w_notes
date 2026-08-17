"""LaTeX compilation — turn a resume note's source into a PDF.

A "resume note" in the app holds LaTeX source instead of the app's rich-text
HTML. The client posts that source here and gets PDF bytes back; the browser
only renders the result. Compilation used to run client-side as WebAssembly,
which worked but cost every new browser an ~86MB one-time download of the engine
and its font bundles — so it moved here, where one TeX install serves everyone.

Nothing is persisted. The source arrives, compiles in a scratch directory, and
the directory is destroyed; only the note itself (in sync/SQLite) is durable.

Two engines are available, because which one runs is visible in the output.
Overleaf compiles with pdfLaTeX unless told otherwise, and templates branch on
that: ``\\ifPDFTeX`` guards the font setup in every RenderCV resume, and Jake's
Resume calls ``\\pdfgentounicode`` with no guard at all. Under the wrong engine
the first renders in the wrong font a page longer, and the second doesn't
compile. So ``pdflatex`` is the default and ``xelatex`` is there for documents
using fontspec, which pdfTeX cannot run at all.

**This endpoint executes attacker-controlled input.** TeX is a full programming
language: left unrestricted it can read arbitrary files off disk, write files,
shell out via ``\\write18``, and loop forever. Every mitigation below is
load-bearing, not defensive habit:

- ``-no-shell-escape`` — passed explicitly, because TeX Live's Debian build
  defaults to *restricted* shell escape, which still permits a list of helper
  programs. Restricted is not none.
- ``openin_any=p`` / ``openout_any=p`` — kpathsea's paranoid mode: a document
  can read and write inside its own scratch directory and the TeX trees, and
  nowhere else. Without this, ``\\input{/etc/passwd}`` typesets the file into
  the PDF and hands it back. (This is also why LuaLaTeX isn't offered: it can't
  load fonts under paranoid mode, and the looser setting reopens exactly that
  hole.)
- **Dropped privileges** — the compile runs as an unprivileged user that owns
  nothing, so a document cannot reach the process environment of the server
  holding the database URL and the API tokens.
- A **scrubbed environment**, built from nothing rather than inherited.
- A **wall-clock timeout**, because ``\\loop`` is one line of LaTeX.
- A **source size cap**, so a request can't spend the box's memory before TeX
  even starts.
- A **fresh scratch directory per request**, holding nothing but ``main.tex``,
  so a document that reads a relative path finds only its own source.

The log comes back with the PDF (or instead of it): the client parses the ``!``
lines into "Line 5: File `enumitem.sty' not found", which is the difference
between a usable editor and a blank pane.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
import shutil
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

try:  # POSIX only — absent on a Windows dev machine, where this suite also runs.
    import pwd
except ImportError:  # pragma: no cover - exercised only off-Linux
    pwd = None  # type: ignore[assignment]

from app.config import get_settings
from app.deps import get_current_user
from app.models import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/latex", tags=["latex"])

# The engines this server offers, mapped to the latexmk flag that selects one.
# A request names a key; nothing user-supplied ever reaches the command line.
#
# `pdflatex` is first because it is Overleaf's default, so it is what a pasted
# template was written against. `xelatex` exists for fontspec documents.
_ENGINE_FLAGS: dict[str, str] = {
    "pdflatex": "-pdf",
    "xelatex": "-pdfxe",
}

Engine = Literal["pdflatex", "xelatex"]

# Longest a single document may take. A resume is a few seconds — latexmk runs
# the engine two or three times to settle references, and XeLaTeX pays for font
# loading on top — so this is generous enough not to catch a real document and
# short enough to stop a runaway one.
_TIMEOUT_SECONDS = 60.0

# Cap on the source itself. Real resumes are a few KB; a megabyte is already
# absurd, and the limit exists so a request can't cost anything before TeX runs.
_MAX_SOURCE_BYTES = 1_000_000

# How much of the TeX log to hand back. The client only surfaces the first few
# diagnostics, but the tail is where the errors are and it aids debugging.
_MAX_LOG_CHARS = 20_000

# Compiling is CPU-bound and this service runs as a single small Fargate task
# that also serves sync and its own health check. Without a cap, a handful of
# simultaneous compiles starve the event loop, ECS misses the health check, and
# the task gets cycled — the whole API goes down over one user's resume. Excess
# requests are refused immediately (429) rather than queued behind a timeout.
_MAX_CONCURRENT_COMPILES = 2
_compile_slots = asyncio.Semaphore(_MAX_CONCURRENT_COMPILES)

# Rasterising is a fraction of the work TeX just did, so it gets a much shorter
# leash: past this something is wrong with the PDF or with poppler, and the
# compile itself already succeeded and is worth returning on its own.
_RASTER_TIMEOUT_SECONDS = 20.0

# Most pages we'll rasterise for one request. A resume is one or two; this is the
# runaway guard, not a judgement about length. Exceeding it costs the pages, not
# the PDF.
_MAX_RASTER_PAGES = 10

# Bounds on the pixel width a client may ask each page to be rendered at. The
# floor keeps a "preview" legible; the ceiling is what stops a request asking for
# a 50,000px-wide page and spending the task's memory before anything is drawn.
_MIN_PAGE_WIDTH = 200
_MAX_PAGE_WIDTH = 2000


class CompileRequest(BaseModel):
    source: str = Field(description="The LaTeX document to compile.")
    # Rejected by validation before any subprocess exists if it isn't one of
    # ours, which is what keeps the engine off the command line as free text.
    engine: Engine = Field(
        default="pdflatex",
        description="Which TeX engine to run. Overleaf's default is pdflatex.",
    )
    # Opt-in, and default off, so the web client — which draws the PDF itself
    # with pdf.js — never pays for pixels it won't look at.
    include_pages: bool = Field(
        default=False,
        description=(
            "Also return each page as a PNG, for clients that cannot draw a PDF."
        ),
    )
    page_width: int = Field(
        default=1000,
        ge=_MIN_PAGE_WIDTH,
        le=_MAX_PAGE_WIDTH,
        description=(
            "Pixel width to render each page at. The caller picks it because only "
            "the caller knows its screen width and pixel density."
        ),
    )


class RenderedPage(BaseModel):
    """One rasterised page. The dimensions travel with the bytes so a client can
    reserve the right space before the image decodes, instead of laying the page
    out twice and jumping."""

    width: int
    height: int
    png_base64: str


class CompileResponse(BaseModel):
    # "The document compiled." Deliberately *not* widened to mean "and we could
    # draw it": rasterising is a bonus on top of a successful compile, and a
    # client that can't preview can still download the PDF. Failing the whole
    # response because poppler had a bad day would take away the thing that
    # already worked.
    ok: bool
    # Base64 PDF rather than a raw body: the log travels with it either way, and
    # the client needs both in one round trip to show a failure without a retry.
    pdf_base64: str | None = None
    log: str = ""
    # Present only when the caller asked for pages and we produced them.
    pages: list[RenderedPage] | None = None
    # Set when the compile succeeded but the pages didn't, so a client can say
    # which of the two happened rather than showing an empty page and calling it
    # success. `ok` stays true in this case.
    pages_error: str | None = None


@asynccontextmanager
async def _temp_dir() -> AsyncIterator[Path]:
    """A scratch directory for one compile, removed however the request ends."""
    with tempfile.TemporaryDirectory(prefix="latex-") as raw:
        yield Path(raw)


class _NoCompileUser(Exception):
    """Root, but the unprivileged account to drop to is missing."""


def _compile_user() -> tuple[int, int] | None:
    """
    The unprivileged (uid, gid) a compile should run as, or ``None``.

    ``None`` means "there is no privilege to drop": the platform has no such
    concept (Windows), or this process isn't root and so cannot change user
    anyway. Both are developer situations, and running TeX as an ordinary
    developer account is no worse than the shell that started it.

    Being **root with no account to drop to** is a different thing entirely, and
    raises rather than returning ``None``. `latex_user` is a setting, so a
    typo'd env var at deploy time would otherwise silently run every pasted
    document as root in the container that holds the database credentials —
    fully working, 200 for every request, with the OS half of the sandbox
    quietly switched off. That must fail like the missing engine does.
    """
    settings = get_settings()
    if pwd is None or not hasattr(os, "geteuid") or os.geteuid() != 0:
        return None
    try:
        entry = pwd.getpwnam(settings.latex_user)
    except KeyError as exc:
        raise _NoCompileUser(settings.latex_user) from exc
    return entry.pw_uid, entry.pw_gid


def _privilege_drop(directory: Path) -> list[str]:
    """The argv prefix that runs a command as the unprivileged compile user, and
    the chown that lets it write to the scratch directory. Empty off-image, where
    there is no privilege to drop.

    Shared by TeX and by the rasteriser. The second one matters as much as the
    first for a reason worth stating: poppler is not executing the document the
    way TeX is — there is no `\\write18` equivalent — but it *is* parsing a file
    built out of untrusted input, and a renderer's parser is a memory-safety
    surface. The sandbox is already built per request; running the second
    subprocess outside it would be a choice, not a saving.

    Dropping privileges goes through `setpriv`, not a `user=` argument: asyncio's
    subprocess API accepts a narrower set of keywords than `subprocess.Popen` and
    rejects `user`/`group` outright ("unexpected kwargs"), which fails every
    compile with a 500. Wrapping the command keeps the drop visible in argv,
    where a test can assert it.

    Safe to call more than once per request: `chown` to the ids it already has is
    a no-op, so callers don't have to thread a prefix through each other.
    """
    settings = get_settings()
    credentials = _compile_user()
    if credentials is None:
        return []
    uid, gid = credentials
    # The scratch directory is created 0700 by root; hand it to the user that
    # will actually be writing there.
    os.chown(directory, uid, gid)
    return [
        settings.setpriv_path,
        f"--reuid={uid}",
        f"--regid={gid}",
        "--clear-groups",
        "--",
    ]


def _png_size(data: bytes) -> tuple[int, int]:
    """A PNG's pixel dimensions, read straight out of its IHDR chunk.

    Eight bytes of signature, then the chunk's 4-byte length and 4-byte type,
    then width and height as big-endian uint32s. Parsed by hand rather than by
    adding an imaging library for two integers we already have the bytes for.
    """
    if len(data) < 24:
        return 0, 0
    return (
        int.from_bytes(data[16:20], "big"),
        int.from_bytes(data[20:24], "big"),
    )


async def _rasterise(directory: Path, page_width: int) -> tuple[list[RenderedPage], str | None]:
    """Render ``main.pdf`` to one PNG per page. Returns (pages, error).

    Called only after a compile has succeeded, inside the same scratch directory
    and the same compile slot, so the PDF is the one that was just built and no
    second TeX run happens. Every failure path returns an error string rather
    than raising: the caller has a valid PDF in hand and must be able to answer
    with it.

    `-scale-to-x` with `-scale-to-y -1` scales to a pixel width and lets the
    height follow the page's own aspect. That avoids computing a DPI, which would
    mean knowing whether the document came out letter, A4, or something a
    `\\geometry` line invented — a question the server has no reason to answer.
    """
    settings = get_settings()
    if not shutil.which(settings.pdftoppm_path):
        # A deploy that hasn't picked up the image layer yet. The compile is
        # still good, so this is a missing bonus rather than a broken server.
        return [], "This server can't render page previews yet."

    process = await asyncio.create_subprocess_exec(
        *_privilege_drop(directory),
        settings.pdftoppm_path,
        "-png",
        # Stop *there*, rather than rendering everything and counting afterwards.
        # One page past the cap is enough to know the cap was passed, and it
        # means a thousand-page PDF costs eleven images instead of a thousand —
        # the check below would otherwise run after the disk had already been
        # spent, which is no limit at all.
        "-l",
        str(_MAX_RASTER_PAGES + 1),
        "-scale-to-x",
        str(page_width),
        "-scale-to-y",
        "-1",
        "main.pdf",
        # Output prefix; poppler appends `-1`, `-2`, … and the extension.
        "page",
        cwd=str(directory),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        # Same reasoning as the TeX run: hand the renderer nothing of ours.
        env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(directory)},
    )

    try:
        stdout, _ = await asyncio.wait_for(
            process.communicate(), timeout=_RASTER_TIMEOUT_SECONDS
        )
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        return [], "Rendering the page previews took too long."

    if process.returncode != 0:
        detail = stdout.decode("utf-8", errors="replace").strip()
        logger.warning("pdftoppm failed (%s): %s", process.returncode, detail[-500:])
        return [], "The page previews couldn't be rendered."

    # Sorted by the number poppler put in the name, not lexically — otherwise
    # page 10 files between 1 and 2, and a long document comes back shuffled.
    files = sorted(
        directory.glob("page-*.png"),
        key=lambda p: int(re.sub(r"\D", "", p.stem) or 0),
    )
    if not files:
        return [], "The page previews couldn't be rendered."
    if len(files) > _MAX_RASTER_PAGES:
        return [], f"This document is longer than {_MAX_RASTER_PAGES} pages, so it can only be downloaded."

    pages: list[RenderedPage] = []
    for path in files:
        data = path.read_bytes()
        width, height = _png_size(data)
        pages.append(
            RenderedPage(
                width=width,
                height=height,
                png_base64=base64.b64encode(data).decode("ascii"),
            )
        )
    return pages, None


async def _run_latexmk(directory: Path, engine: Engine) -> tuple[bool, str]:
    """Compile ``main.tex`` in ``directory``. Returns (succeeded, log)."""
    settings = get_settings()

    # latexmk rather than the engine directly: a resume with `\pageref{LastPage}`
    # or a two-column entry needs two or three passes to settle, and latexmk is
    # what decides when it's done. Running the engine once produces a document
    # with "Page 1 of ??" in it.
    # Dropping privileges goes through `setpriv`, not a `user=` argument:
    # asyncio's subprocess API accepts a narrower set of keywords than
    # `subprocess.Popen` and rejects `user`/`group` outright ("unexpected
    # kwargs"), which fails every compile with a 500. Wrapping the command keeps
    # the drop visible in argv, where a test can assert it.
    privilege_drop = _privilege_drop(directory)

    process = await asyncio.create_subprocess_exec(
        *privilege_drop,
        settings.latexmk_path,
        _ENGINE_FLAGS[engine],
        # Keep going after the first error so the log lists everything wrong
        # rather than stopping at the first `!`.
        "-interaction=nonstopmode",
        # Explicit, because Debian's TeX Live defaults to *restricted* shell
        # escape rather than none. See the module docstring.
        "-no-shell-escape",
        # Ignore any latexmkrc: HOME is the scratch directory so there is none
        # to find, but this is the difference between "there happens to be no
        # config" and "config is not consulted".
        "-norc",
        # The *relative* name, with the scratch directory as the working
        # directory — and consequently no `-outdir`, since output lands beside
        # the source, which is where the handler looks for it.
        #
        # It has to be relative: `openin_any=p` refuses to open an absolute path,
        # so passing `/tmp/latex-xxx/main.tex` makes TeX report "I can't find
        # file" for a file that plainly exists and is readable. The sandbox and
        # the invocation are coupled; changing one without the other breaks every
        # compile, and a stubbed subprocess cannot see it.
        "main.tex",
        cwd=str(directory),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        # A compile needs no environment of ours; don't hand the document the
        # process env, which holds the database URL and the API tokens.
        env={
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            # HOME and every TEXMF path a run might write to point at the
            # scratch directory, so nothing a document leaves behind outlives
            # its request or is visible to the next one.
            "HOME": str(directory),
            "TEXMFHOME": str(directory / "texmf"),
            "TEXMFVAR": str(directory / "texmf-var"),
            "TEXMFCONFIG": str(directory / "texmf-config"),
            # kpathsea's paranoid mode, both directions. The load-bearing pair:
            # without them a document reads any readable file on this box into
            # its own PDF.
            "openin_any": "p",
            "openout_any": "p",
            # Identical source produces an identical PDF, which keeps the
            # client's content-addressed cache honest across recompiles.
            "SOURCE_DATE_EPOCH": "0",
            "FORCE_SOURCE_DATE": "1",
        },
    )

    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        process.kill()
        # Reap it, so a killed compile can't leave a zombie behind.
        await process.wait()
        return False, (
            f"Compilation timed out after {int(_TIMEOUT_SECONDS)} seconds. "
            "A document that never finishes is usually an unterminated command "
            "or an infinite loop."
        )

    log = stdout.decode("utf-8", errors="replace")
    # latexmk's console output summarises; the engine's own log next to the
    # output is what holds the `!` lines the client parses, and the font
    # warnings that explain a document that compiled but looks wrong.
    tex_log = directory / "main.log"
    if tex_log.exists():
        log = f"{log}\n{tex_log.read_text(encoding='utf-8', errors='replace')}"

    return process.returncode == 0, log[-_MAX_LOG_CHARS:]


def page_count(log: str) -> int | None:
    """How many pages the compile produced, read out of the TeX log.

    TeX writes ``Output written on main.pdf (2 pages, 41234 bytes).`` — one page
    is ``(1 page,``. Reading the log rather than shelling out to ``pdfinfo``
    keeps this to a string match on output we already have, and adds no
    dependency to the image.

    Returns ``None`` when the log doesn't say, which a failed compile won't.
    Callers must treat that as "unknown", never as zero.
    """
    match = re.search(r"Output written on .*?\((\d+) pages?,", log)
    return int(match.group(1)) if match else None


async def compile_source(source: str, engine: Engine) -> tuple[bool, str, int | None]:
    """Compile a document in a throwaway sandbox: (succeeded, log, pages).

    The same path `POST /latex/compile` takes, factored out so other endpoints can
    compile without going back out over HTTP — `POST /resume/tailor` uses it to
    check that what the model wrote actually builds, and that it came out on one
    page. Holds a compile slot, so an internal caller queues behind the same cap
    as a client request rather than around it.

    The readiness check lives here rather than in each caller so that every route
    into a real compile passes it. `/latex/compile` inlines its own compile and
    keeps its own copy; the resume endpoints reach TeX only through this function,
    and used to reach it with no check at all — a deploy missing the engine or the
    sandbox user answered 503 there and an uncaught 500 here.
    """
    require_compile_ready()
    async with _compile_slots, _temp_dir() as directory:
        (directory / "main.tex").write_text(source, encoding="utf-8")
        succeeded, log = await _run_latexmk(directory, engine)
        if not succeeded or not (directory / "main.pdf").exists():
            return False, log, None
        return True, log, page_count(log)


def require_compile_ready() -> None:
    """Refuse the request unless this server can compile safely.

    Both failures here mean a broken deploy rather than a bad document, so they
    answer 503 and say which. Checked before any work, so a misconfigured deploy
    is a loud refusal on the first request instead of a silent loss of the
    sandbox.

    Shared rather than inlined into the handler it started in: `/resume/tailor`
    and `/resume/edit` compile too, via `compile_source`, which performs neither
    check on its own. They skipped both while `/latex/compile` had them, so the
    one deploy fault this is written to catch surfaced as a clean 503 on one
    endpoint and an uncaught 500 on the others.
    """
    settings = get_settings()
    if not shutil.which(settings.latexmk_path):
        # The image is built with TeX Live; a 503 here means a deploy problem,
        # not a bad document, so say so rather than blaming the LaTeX.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No LaTeX engine is installed on this server.",
        )

    # Same class of problem, same answer: refuse rather than compile untrusted
    # input as root.
    try:
        _compile_user()
    except _NoCompileUser:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="This server is not configured to compile safely.",
        ) from None


@router.post("/compile", response_model=CompileResponse)
async def compile_latex(
    payload: CompileRequest,
    _user: User = Depends(get_current_user),
) -> CompileResponse:
    """Compile a LaTeX document and return the PDF plus the TeX log."""
    require_compile_ready()

    source = payload.source
    if len(source.encode("utf-8")) > _MAX_SOURCE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="This document is too large to compile.",
        )
    if not source.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="There is nothing to compile.",
        )

    if _compile_slots.locked():
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="The server is compiling as much as it can right now. Try again in a moment.",
        )

    # `TemporaryDirectory` removes the tree on exit whatever happened inside it,
    # including a timeout — nothing a document writes outlives its request.
    async with _compile_slots, _temp_dir() as directory:
        (directory / "main.tex").write_text(source, encoding="utf-8")

        succeeded, log = await _run_latexmk(directory, payload.engine)

        pdf_path = directory / "main.pdf"
        if not succeeded or not pdf_path.exists():
            # A failed compile is a normal outcome for a half-written document,
            # not a server error: 200 with ok=false, and the log to explain it.
            # Nothing is rasterised on this path: there is no PDF to rasterise,
            # and a client reporting "couldn't render the preview" for a document
            # that never compiled would be answering the wrong question.
            return CompileResponse(ok=False, log=log)

        pdf = pdf_path.read_bytes()

        # Inside the same scratch directory and the same compile slot, off the
        # PDF that was just built. This is the whole reason pages live on this
        # endpoint rather than one of their own: a separate call would have to
        # either compile the document again or keep the first result somewhere,
        # and compiling one resume more than once per view is a bill this repo
        # has already paid once — see `3cd7907`.
        pages: list[RenderedPage] | None = None
        pages_error: str | None = None
        if payload.include_pages:
            rendered, pages_error = await _rasterise(directory, payload.page_width)
            pages = rendered or None

    return CompileResponse(
        ok=True,
        pdf_base64=base64.b64encode(pdf).decode("ascii"),
        log=log,
        pages=pages,
        pages_error=pages_error,
    )
