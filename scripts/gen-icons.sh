#!/usr/bin/env bash
# Rasterise the icon sources to the PNG sizes Chrome Web Store and AMO require.
#   icons/icon.svg        -> 32, 48, 128 (full artwork)
#   icons/icon-small.svg  -> 16 (simplified, hand-tuned for the 1x toolbar)
# Requires rsvg-convert (brew install librsvg / apt install librsvg2-bin).
set -euo pipefail
cd "$(dirname "$0")/.."
command -v rsvg-convert >/dev/null || { echo "rsvg-convert not found" >&2; exit 1; }
for size in 32 48 128; do
  rsvg-convert -w "$size" -h "$size" icons/icon.svg -o "icons/icon-${size}.png"
  echo "icons/icon-${size}.png"
done
rsvg-convert -w 16 -h 16 icons/icon-small.svg -o icons/icon-16.png
echo "icons/icon-16.png"
