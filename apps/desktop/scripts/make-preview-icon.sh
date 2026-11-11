#!/usr/bin/env bash
# Regenerates Ponzu Preview's icons in build/preview from build/icon-1024.png: the release icon
# with a PREVIEW band (make-preview-icon.swift), as icon.icns for the Mac and icons/<size>.png
# for Linux (make-platform-icons.swift). macOS only (swift, sips, iconutil). Rerun whenever the
# app icon changes.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p build/preview
swift scripts/make-preview-icon.swift build/icon-1024.png build/preview/icon-1024.png

iconset=$(mktemp -d)/preview.iconset
mkdir "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" build/preview/icon-1024.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) build/preview/icon-1024.png --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil --convert icns --output build/preview/icon.icns "$iconset"
rm -rf "$(dirname "$iconset")"

swift scripts/make-platform-icons.swift build/preview/icon-1024.png build/preview
# The preview is never built for Windows.
rm -f build/preview/icon.ico
