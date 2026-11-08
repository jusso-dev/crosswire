#!/usr/bin/env bash
# Render docs/design/analyst-workspace-design.html to a print-quality PDF with selectable text,
# live links and (where supported) a document outline for bookmarks.
# Usage: bash docs/design/render.sh
# Requires Google Chrome or Chromium. Override the binary with CHROME=/path/to/chrome.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
src="$here/analyst-workspace-design.html"
out="$here/analyst-workspace-design.pdf"

chrome="${CHROME:-}"
if [ -z "$chrome" ]; then
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome 2>/dev/null || true)" \
    "$(command -v chromium 2>/dev/null || true)" \
    "$(command -v chromium-browser 2>/dev/null || true)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then chrome="$c"; break; fi
  done
fi
[ -n "$chrome" ] || { echo "Chrome or Chromium not found; set CHROME=/path/to/binary" >&2; exit 1; }

profile="$(mktemp -d)"
trap 'rm -rf "$profile"' EXIT

"$chrome" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$profile" \
  --no-pdf-header-footer --generate-pdf-document-outline \
  --print-to-pdf="$out" "$(python3 -c 'import pathlib,sys;print(pathlib.Path(sys.argv[1]).as_uri())' "$src")" >/dev/null 2>&1

echo "Wrote $out"
