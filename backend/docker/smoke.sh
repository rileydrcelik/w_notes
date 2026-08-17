#!/bin/sh
# Build-time only: compiles the smoke documents with every engine the image
# ships, and fails the build if any of them doesn't produce a PDF.
#
# It exists as a script rather than a RUN one-liner for one reason: when a
# compile fails, it prints the TeX log. A build that stops with latexmk's
# "you will need to correct the file(s)" and nothing else tells you an engine is
# broken but not which package, font or map is missing, and the layer is gone
# by the time you want to look.
set -eu

OUT=/tmp/smoke-out

run() {
    engine="$1"
    document="$2"
    rm -rf "$OUT"
    mkdir -p "$OUT"
    printf '\n--- %s with %s ---\n' "$document" "$engine"
    if ! latexmk "$engine" -interaction=nonstopmode -no-shell-escape \
        -outdir="$OUT" "/tmp/$document.tex" >"$OUT/console" 2>&1; then
        echo "COMPILE FAILED. TeX log follows:"
        sed -n '/^!/,+6p' "$OUT/$document.log" 2>/dev/null || cat "$OUT/console"
        exit 1
    fi
    if [ ! -s "$OUT/$document.pdf" ]; then
        echo "latexmk reported success but produced no PDF. TeX log follows:"
        cat "$OUT/$document.log" 2>/dev/null || cat "$OUT/console"
        exit 1
    fi
    echo "ok"
}

# The packages a resume uses, under both engines.
run -pdf smoke
run -pdfxe smoke

# System fonts via fontspec — XeLaTeX only, since pdfTeX cannot run fontspec.
run -pdfxe smoke-fontspec

# Rasterising, on the PDF the last run just produced. Here for the same reason
# the compiles are: `-scale-to-x`/`-scale-to-y` are the flags the server passes,
# and whether this poppler build accepts them is a property of the base image,
# not of any document. Finding that out from a user whose preview came back
# empty would cost far more than one build step.
printf '\n--- rasterise with pdftoppm ---\n'
# `prlimit` is what stops a document's own page geometry turning into a
# multi-gigabyte bitmap, and the server refuses to rasterise without it — so a
# base image that lost it would silently disable previews for everyone. Cheaper
# to find out here.
if ! command -v prlimit >/dev/null 2>&1; then
    echo "prlimit is missing from this image; the rasteriser would refuse to run."
    exit 1
fi
if ! prlimit --as=1073741824 -- pdftoppm -png -scale-to-x 800 -scale-to-y -1 \
    "$OUT/smoke-fontspec.pdf" "$OUT/page" >"$OUT/raster" 2>&1; then
    echo "RASTERISE FAILED:"
    cat "$OUT/raster"
    exit 1
fi
if [ ! -s "$OUT/page-1.png" ]; then
    echo "pdftoppm reported success but produced no PNG. Output was:"
    cat "$OUT/raster"
    ls -la "$OUT"
    exit 1
fi
echo "ok"

rm -rf "$OUT"
