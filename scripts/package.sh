#!/usr/bin/env bash
#
# Build a Chrome Web Store / load-unpacked zip of the extension.
# Includes only runtime files (manifest at the root), excluding dev artifacts.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="dist/ai-tab-grouper.zip"
mkdir -p dist
rm -f "$OUT"

zip -rq "$OUT" \
  manifest.json \
  background.js \
  lib \
  popup \
  options \
  icons/icon16.png \
  icons/icon48.png \
  icons/icon128.png \
  -x '*/.DS_Store'

echo "Packaged → $OUT"
unzip -l "$OUT" | tail -n +4 | sed '$d' | awk '{print "  " $4}'
