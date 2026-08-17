# FastAPI sync backend. Slim Python base; uvicorn serves the ASGI app.
FROM python:3.12-slim

WORKDIR /app

# System deps are minimal — asyncpg ships wheels, so no build toolchain needed.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# Install deps first so the layer caches across code edits.
COPY pyproject.toml ./
RUN pip install --upgrade pip && pip install .

# --- LaTeX engines, for POST /latex/compile --------------------------------
# TeX Live rather than Tectonic. Tectonic is one 20MB static binary that fetches
# TeX Live files on demand, and on image size alone it wins by a mile — but it
# is XeTeX, and resumes are written on Overleaf, which is pdfLaTeX.
#
# That is not a cosmetic difference. Templates branch on the engine:
# `\ifPDFTeX` guards the font setup in every RenderCV resume, so under XeTeX the
# whole block is skipped and the document silently renders in the wrong font, a
# page longer. Jake's Resume — the most-used template there is — calls
# `\pdfgentounicode` unguarded and doesn't compile under XeTeX at all. Neither
# failure is fixable from our side of the wire.
#
# So both engines ship, and the note picks one (see routers/latex.py):
#   pdflatex — the default, and what Overleaf runs unless told otherwise.
#   xelatex  — for templates using fontspec/system fonts, which pdfTeX cannot run.
# LuaLaTeX is deliberately absent: it cannot load fonts under `openin_any=p`,
# and loosening that to make it work would let any document read any readable
# file on this box straight into its PDF. 85MB for a security downgrade on the
# least-used engine is a bad trade.
#
# The cost of all this is ~500MB of image, pulled on every Fargate Spot task
# placement. It buys documents that render the way their author saw them.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      texlive-latex-base \
      texlive-latex-recommended \
      texlive-latex-extra \
      texlive-fonts-recommended \
      texlive-xetex \
      latexmk \
      # Latin Modern's font definitions. Explicit because nothing here depends
      # on it: LuaLaTeX used to pull it in, and dropping LuaLaTeX took it away —
      # at which point `\usepackage[T1]{fontenc}` under XeLaTeX has no `t1lmr.fd`
      # to select and dies with "Corrupted NFSS tables". The build-time smoke
      # compile is what caught that; it is not obvious from any error the user
      # would ever see.
      lmodern \
      fontconfig \
      fonts-liberation2 \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      fonts-texgyre \
      fonts-lato \
      fonts-roboto-unhinted \
      # Rasterises a compiled PDF into per-page PNGs, for clients with no PDF
      # renderer of their own — every phone, since a real viewer is a native
      # module and this app ships fixes over the air. poppler and not
      # ImageMagick or Ghostscript: it draws PDF directly, where the other two
      # route through a far larger PostScript interpreter, so a document built
      # from untrusted input meets one parser instead of two. Small next to the
      # TeX trees above, and it runs under the same dropped privileges.
      poppler-utils \
      ca-certificates curl xz-utils; \
    rm -rf /var/lib/apt/lists/*

# fontawesome5, which resume headers use for the mail/phone/GitHub icons. The
# Debian package carrying it is texlive-fonts-extra: 1.7GB for one family. The
# TeX Live archive is 900KB and TDS-ready — Type1 for pdfLaTeX, OpenType for
# XeLaTeX, and the dvips map that makes the Type1 side work at all.
#
# Pinned to a named mirror, not the mirrors.ctan.org round-robin: that
# redirector hands out a different mirror each request and some have broken
# certificate chains, which fails the build at random.
RUN set -eux; \
    curl -fsSL -o /tmp/fontawesome5.tar.xz \
      https://ctan.math.illinois.edu/systems/texlive/tlnet/archive/fontawesome5.tar.xz; \
    mkdir -p /usr/local/share/texmf; \
    tar -xJf /tmp/fontawesome5.tar.xz -C /usr/local/share/texmf --exclude=tlpkg; \
    mktexlsr; \
    updmap-sys --enable Map=fontawesome5.map; \
    mktexlsr; \
    rm -f /tmp/fontawesome5.tar.xz; \
    apt-get purge -y curl xz-utils; \
    apt-get autoremove -y; \
    fc-cache -fs

# The compile runs as this user, never as root — see routers/latex.py. It owns
# nothing and cannot log in; its only job is to be someone other than the user
# holding the database credentials in its environment.
RUN useradd --system --no-create-home --shell /usr/sbin/nologin latex

# Prove both engines work while the image is being built, rather than finding
# out from a user's failed compile. A missing font map or a half-installed
# package fails here instead of in production.
COPY docker/smoke.tex docker/smoke-fontspec.tex docker/smoke.sh /tmp/
RUN set -eux; \
    sh /tmp/smoke.sh; \
    rm -f /tmp/smoke.sh /tmp/smoke.tex /tmp/smoke-fontspec.tex

COPY . .

EXPOSE 8000

# Run migrations, then start the server. `alembic upgrade head` is idempotent.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
