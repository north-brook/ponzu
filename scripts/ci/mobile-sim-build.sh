#!/usr/bin/env bash
# A Release simulator build of Ponzu Dev on the in-app fake backend, with its JavaScript inside,
# so it runs on any simulator without Metro: to walk a change by hand on a Simlock pool device
# (an iPad, iPhone Duo) from T3's Device panel. Run on spare as a network job; the zipped app
# lands in the job's artifacts.
#
#   network job start spare --repo ponzu --source . --include-dirty \
#     --agent command -- scripts/ci/mobile-sim-build.sh
#
# Then install `PonzuDev.app` on the device and open `ponzu-dev://dev?seed=signed-in`.
set -euo pipefail

artifacts="${NETWORK_JOB_DIR:?run as a network job}/artifacts"
mkdir -p "$artifacts"

# The Xcode the app builds with on EAS (apps/mobile/eas.json), as mobile-ios.sh picks it.
xcode=$(sed -nE 's/.*"image": *"[^"]*xcode-([0-9.]+)".*/\1/p' apps/mobile/eas.json | head -1)
developer=
for app in /Applications/Xcode*.app "$HOME"/Applications/Xcode*.app; do
  if [ -n "$xcode" ] && [ "$(plutil -extract CFBundleShortVersionString raw "$app/Contents/version.plist" 2>/dev/null)" = "$xcode" ]; then
    developer="$app/Contents/Developer"
    break
  fi
done
[ -n "$developer" ] || { echo "Install Xcode $xcode, which apps/mobile/eas.json builds with" >&2; exit 1; }
export DEVELOPER_DIR="$developer"
bun install --frozen-lockfile

cd apps/mobile
export APP_VARIANT=dev PONZU_BACKEND=fake CI=1
bunx expo prebuild --platform ios
workspace=$(ls -d ios/*.xcworkspace | head -1)
scheme=$(basename "$workspace" .xcworkspace)
xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release \
  -sdk iphonesimulator -destination "generic/platform=iOS Simulator" \
  -derivedDataPath ios/build/dd CODE_SIGNING_ALLOWED=NO build -quiet
built=$(ls -d ios/build/dd/Build/Products/Release-iphonesimulator/*.app | head -1)
(cd "$(dirname "$built")" && ditto -c -k --keepParent "$(basename "$built")" "$artifacts/$(basename "$built").zip")
echo "Built $(basename "$built"): $artifacts/$(basename "$built").zip"
