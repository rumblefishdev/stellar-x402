#!/usr/bin/env bash
# Build a milestone evidence PDF.
#
# Usage:
#   ./build-pdf.sh            # defaults to milestone 1
#   ./build-pdf.sh 1          # milestone-1-evidence.md  -> .pdf
#   ./build-pdf.sh some.md    # any source in this directory
#
# Requirements:
#   Linux (Debian/Ubuntu):
#     sudo apt install pandoc poppler-utils   # poppler-utils optional (pdfinfo)
#     typst: no apt package — install one of:
#       cargo install --locked typst-cli
#       snap install typst
#       or grab a release binary from https://github.com/typst/typst/releases
#     NOTE: pandoc must be >= 3.1 for `--pdf-engine=typst`. If the distro
#     package is older, install from https://github.com/jgm/pandoc/releases.
#   macOS (Homebrew):
#     brew install pandoc typst poppler
#
# Output:
#   docs/scf/milestone-<N>-evidence.pdf
#
# Why pandoc + typst?
#   - Typst (the engine) handles Unicode natively — no LaTeX font fiddling
#     for —, →, ✅, etc.
#   - Faster than xelatex by ~10×; cold render of this doc is under 2 s.
#   - Pandoc 3.1+ ships native `--pdf-engine=typst` support.
#   - GFM input mode gives GitHub-style heading auto-ids, so the in-doc
#     anchor links (`[section 4](#4-...)`) resolve.

set -euo pipefail

# Default to milestone 1; a later milestone passes its number. A `.md` path is taken from the
# caller's directory when it exists there, else from this script's.
ARG="${1:-1}"
case "$ARG" in
    *.md) if [[ -f "$ARG" ]]; then SRC="$(cd "$(dirname "$ARG")" && pwd)/$(basename "$ARG")"
          else SRC="$ARG"; fi ;;
    *)    SRC="milestone-${ARG}-evidence.md" ;;
esac

cd "$(dirname "$0")"
OUT="${SRC%.md}.pdf"

# ---- Tool checks ---------------------------------------------------------
command -v pandoc >/dev/null || { echo "❌ pandoc not found — see install notes at the top of this script"; exit 1; }
command -v typst  >/dev/null || { echo "❌ typst not found  — see install notes at the top of this script"; exit 1; }
[[ -f "$SRC" ]]               || { echo "❌ source not found: $SRC"; exit 1; }

# A relative or root-absolute link must leave the PDF as its GitHub URL at the tag; inside a PDF
# it points nowhere.
TAG=$(sed -n 's/^local REF = "\(.*\)"$/\1/p' repo-links.lua)
URL="https://github.com/rumblefishdev/stellar-x402/blob/$TAG"
[[ "$(printf '[x](../a.md#b) [y](/c.md)' | pandoc -f gfm -t gfm --wrap=none --lua-filter=repo-links.lua)" \
    == "[x]($URL/docs/a.md#b) [y]($URL/c.md)" ]] \
    || { echo "❌ repo-links.lua no longer rewrites relative links"; exit 1; }

# The links resolve only once the tag is on origin (README, step 4): a build before that still
# runs, for a preview, but says so.
git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1 \
    || echo "⚠  tag $TAG is not on origin: the PDF's repository links 404 until it is pushed"

# pandoc < 3.1 has no native typst engine; fail early with a clear message
# instead of a confusing "pdf-engine typst not found" further down.
PANDOC_VER=$(pandoc --version | awk 'NR==1 {print $2}')
if [[ "$(printf '%s\n3.1\n' "$PANDOC_VER" | sort -V | head -1)" != "3.1" ]]; then
    echo "❌ pandoc $PANDOC_VER is too old — need >= 3.1 for --pdf-engine=typst"
    exit 1
fi

# ---- Render --------------------------------------------------------------
echo "→ Rendering $SRC → $OUT"

pandoc "$SRC" -o "$OUT" \
    --pdf-engine=typst \
    --from=gfm+wikilinks_title_after_pipe+attributes+yaml_metadata_block \
    --include-in-header=header.typ \
    --lua-filter=full-width-tables.lua \
    --lua-filter=repo-links.lua \
    -V mainfont="Libertinus Serif" \
    -V monofont="DejaVu Sans Mono" \
    -V linkcolor:0066CC \
    -V urlcolor:0066CC

# ---- Sanity ---------------------------------------------------------------
if command -v pdfinfo >/dev/null; then
    PAGES=$(pdfinfo "$OUT" | awk '/^Pages:/ {print $2}')
    SIZE=$(du -h "$OUT" | awk '{print $1}')
    echo "✓ Built $OUT — $PAGES pages, $SIZE"
else
    SIZE=$(du -h "$OUT" | awk '{print $1}')
    echo "✓ Built $OUT — $SIZE (install poppler for page count)"
fi

# ---- Post-build reminders -------------------------------------------------
TODOS=$(grep -c '<TODO:' "$SRC" || true)
if [[ "$TODOS" -gt 0 ]]; then
    echo ""
    echo "⚠  $TODOS unresolved <TODO:> markers in $SRC."
    echo "   Capture screenshots and replace before final upload to Drive:"
    grep -n '<TODO:' "$SRC" | sed 's/^/     /'
fi
