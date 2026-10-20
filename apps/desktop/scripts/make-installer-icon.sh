#!/usr/bin/env bash
# Regenerates build/installer-icon.{png,icns} from build/icon-1024.png. macOS only
# (sips, iconutil). Rerun whenever the app icon changes.
set -euo pipefail
cd "$(dirname "$0")/.."

swift scripts/make-installer-icon.swift build/icon-1024.png build/installer-icon.png

iconset=$(mktemp -d)/installer.iconset
mkdir "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" build/installer-icon.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) build/installer-icon.png --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil --convert icns --output build/installer-icon.icns "$iconset"
rm -rf "$(dirname "$iconset")"
