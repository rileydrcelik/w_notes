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

rm -rf "$OUT"
