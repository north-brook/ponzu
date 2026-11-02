#!/usr/bin/env bash
# The Mobile iOS job's command (ci.yml): run on spare as a network iOS job,
# whose Simlock lease is IOS_SIMULATOR_UDID. The JUnit report and Maestro's
# per-flow screenshots land in the job's artifacts, which the runner uploads.
# The same run from a checkout on a master, with its edits:
#
#   network job start spare --repo ponzu --source . --include-dirty \
#     --agent command --resource ios -- scripts/ci/mobile-ios.sh
set -euo pipefail

artifacts="${NETWORK_JOB_DIR:?run as a network job}/artifacts"
mkdir -p "$artifacts"

# Build and test with the Xcode the app builds with on EAS (apps/mobile/eas.json),
# installed beside the Mac's others, whichever one the Mac selects.
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
echo "Xcode $xcode: $DEVELOPER_DIR"
bun install --frozen-lockfile
MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_OUTPUT="$artifacts/maestro.xml" MAESTRO_TEST_OUTPUT="$artifacts/maestro" \
  exec apps/mobile/maestro/run.sh "${IOS_SIMULATOR_UDID:?the job leases a simulator}"
