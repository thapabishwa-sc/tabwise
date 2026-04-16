#!/usr/bin/env bash
#
# Rasterize icon.svg into the PNG sizes referenced by the manifest.
# Renders the SVG at high resolution with macOS QuickLook (good SVG support),
# then downscales with ImageMagick (`magick`) for crisp icons.
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# QuickLook renders icon.svg (sized 512) → $TMP/icon.svg.png
qlmanage -t -s 512 -o "$TMP" icon.svg >/dev/null 2>&1
SRC="$TMP/icon.svg.png"
[ -f "$SRC" ] || { echo "QuickLook failed to render icon.svg" >&2; exit 1; }

for size in 16 48 128; do
  magick "$SRC" -resize "${size}x${size}" "icon${size}.png"
  echo "wrote icon${size}.png"
done
