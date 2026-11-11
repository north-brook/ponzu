#!/usr/bin/env bash
# Regenerates Ponzu Dev's icons in build/dev from build/icon-1024.png: the release icon on a grey
# tile (make-dev-icon.swift), as icon.icns for the Mac and icons/<size>.png for Linux
# (make-platform-icons.swift). macOS only (swift, sips, iconutil). Rerun whenever the app icon
# changes.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p build/dev
swift scripts/make-dev-icon.swift build/icon-1024.png build/dev/icon-1024.png

iconset=$(mktemp -d)/dev.iconset
mkdir "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" build/dev/icon-1024.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) build/dev/icon-1024.png --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil --convert icns --output build/dev/icon.icns "$iconset"
rm -rf "$(dirname "$iconset")"

swift scripts/make-platform-icons.swift build/dev/icon-1024.png build/dev
# Ponzu Dev is never built for Windows.
rm -f build/dev/icon.ico
