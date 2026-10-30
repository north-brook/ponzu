#!/usr/bin/env bash
# The iPhone app's Maestro flows, against this checkout: a Ponzu serving the
# three examples, Metro, and a Debug development client on one simulator.
#
#   apps/mobile/maestro/run.sh <simulator udid>
#
# Starts the server and Metro on free ports unless PONZU_PORT / METRO_PORT
# say they're already running there, builds and installs the client unless
# SKIP_BUILD=1, then runs every flow (a JUnit report to MAESTRO_OUTPUT, if
# set). Fails if examples/ isn't left as it was found.
set -euo pipefail

UDID=${1:?simulator udid}
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
MOBILE="$ROOT/apps/mobile"
PONZU_PORT=${PONZU_PORT:-}
METRO_PORT=${METRO_PORT:-}
pids=()
SCRATCH=$(mktemp -d -t ponzu-maestro)
cleanup() {
  # ${a[@]+...}: an empty array is "unbound" under set -u in macOS's bash 3.2.
  for p in ${pids[@]+"${pids[@]}"}; do kill "$p" 2>/dev/null || true; done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
wait_for() { for _ in $(seq 1 120); do curl -sf -m 2 "$1" >/dev/null && return 0; sleep 1; done; echo "Nothing at $1" >&2; return 1; }

if [ -z "$PONZU_PORT" ]; then
  PONZU_PORT=$(free_port)
  # Its own catalog database and agents' history, not this Mac's; never on the
  # tailnet (it would take the tailnet port from the installed Ponzu).
  (cd "$ROOT" && PONZU_HOME="$SCRATCH/home" PONZU_TAILSCALE=none PONZU_TELEMETRY=0 PONZU_BONJOUR=0 exec bun apps/cli/src/index.ts serve \
    examples/halon.design examples/kettle.design examples/weft.design --port "$PONZU_PORT") &
  pids+=($!)
fi
wait_for "http://127.0.0.1:$PONZU_PORT/api/info"

if [ -z "$METRO_PORT" ]; then
  METRO_PORT=$(free_port)
  (cd "$MOBILE" && EXPO_PUBLIC_PONZU_DEV_HOST="127.0.0.1:$PONZU_PORT" CI=1 \
    exec bunx expo start --dev-client --port "$METRO_PORT") &
  pids+=($!)
fi
wait_for "http://127.0.0.1:$METRO_PORT/status"

if [ "${SKIP_BUILD:-}" != 1 ]; then
  (cd "$MOBILE" && CI=1 bunx expo prebuild --platform ios)
  xcodebuild -workspace "$MOBILE/ios/Ponzu.xcworkspace" -scheme Ponzu -configuration Debug \
    -sdk iphonesimulator -destination "id=$UDID" -derivedDataPath "$MOBILE/ios/build/dd" \
    CODE_SIGNING_ALLOWED=NO build -quiet
  xcrun simctl boot "$UDID" 2>/dev/null || true
  xcrun simctl install "$UDID" "$MOBILE/ios/build/dd/Build/Products/Debug-iphonesimulator/Ponzu.app"
fi

KETTLE=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' \
  "$ROOT/examples/kettle.design")
DEV_CLIENT="exp+ponzu://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A$METRO_PORT"
status=0
maestro --device "$UDID" test -e KETTLE="$KETTLE" -e DEV_CLIENT="$DEV_CLIENT" \
  ${MAESTRO_OUTPUT:+--format junit --output "$MAESTRO_OUTPUT"} "$MOBILE/maestro/" || status=$?
git -C "$ROOT" diff --exit-code examples/
test -z "$(git -C "$ROOT" status --porcelain --untracked-files=all examples/)"
exit "$status"
