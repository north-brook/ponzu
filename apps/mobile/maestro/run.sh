#!/usr/bin/env bash
# The iPhone app's Maestro flows, against this checkout: Metro with the in-app
# fake backend (PONZU_BACKEND=fake), the fake's authorize page, and a Debug
# development client of Ponzu Dev on one simulator. Nothing here reaches a
# real API, WorkOS or GitHub.
#
#   apps/mobile/maestro/run.sh <simulator udid>
#
# Starts the authorize page and Metro on free ports unless AUTH_PORT /
# METRO_PORT say they're already running there, builds and installs the
# client unless SKIP_BUILD=1, then runs every flow (a JUnit report to
# MAESTRO_OUTPUT and each flow's screenshots to MAESTRO_TEST_OUTPUT, if set).
set -euo pipefail

UDID=${1:?simulator udid}
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
MOBILE="$ROOT/apps/mobile"
AUTH_PORT=${AUTH_PORT:-}
METRO_PORT=${METRO_PORT:-}
pids=()
cleanup() {
  # ${a[@]+...}: an empty array is "unbound" under set -u in macOS's bash 3.2.
  for p in ${pids[@]+"${pids[@]}"}; do kill "$p" 2>/dev/null || true; done
  for p in ${pids[@]+"${pids[@]}"}; do wait "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
wait_for() { for _ in $(seq 1 120); do curl -sf -m 2 "$1" >/dev/null && return 0; sleep 1; done; echo "Nothing at $1" >&2; return 1; }

# The build is Ponzu Dev (design.ponzu.app.dev, ponzu-dev://), as every cloud build is.
export APP_VARIANT=dev

if [ -z "$AUTH_PORT" ]; then
  AUTH_PORT=$(free_port)
  bun "$MOBILE/maestro/authorize.ts" "$AUTH_PORT" &
  pids+=($!)
fi
wait_for "http://127.0.0.1:$AUTH_PORT/health"

if [ -z "$METRO_PORT" ]; then
  METRO_PORT=$(free_port)
  (cd "$MOBILE" && PONZU_BACKEND=fake \
    EXPO_PUBLIC_PONZU_FAKE_AUTHORIZE_URL="http://127.0.0.1:$AUTH_PORT/authorize" CI=1 \
    exec bunx expo start --dev-client --port "$METRO_PORT") &
  pids+=($!)
fi
wait_for "http://127.0.0.1:$METRO_PORT/status"

if [ "${SKIP_BUILD:-}" != 1 ]; then
  (cd "$MOBILE" && CI=1 bunx expo prebuild --platform ios)
  # Prebuild names the project after the app ("Ponzu Dev" → PonzuDev).
  workspace=$(ls -d "$MOBILE"/ios/*.xcworkspace | head -1)
  scheme=$(basename "$workspace" .xcworkspace)
  xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Debug \
    -sdk iphonesimulator -destination "id=$UDID" -derivedDataPath "$MOBILE/ios/build/dd" \
    CODE_SIGNING_ALLOWED=NO build -quiet
  xcrun simctl boot "$UDID" 2>/dev/null || true
  xcrun simctl install "$UDID" "$(ls -d "$MOBILE"/ios/build/dd/Build/Products/Debug-iphonesimulator/*.app | head -1)"
fi

DEV_CLIENT="exp+ponzu://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A$METRO_PORT"
exec maestro --device "$UDID" test -e DEV_CLIENT="$DEV_CLIENT" \
  ${MAESTRO_OUTPUT:+--format junit --output "$MAESTRO_OUTPUT"} \
  ${MAESTRO_TEST_OUTPUT:+--test-output-dir "$MAESTRO_TEST_OUTPUT"} "$MOBILE/maestro/"
