#!/usr/bin/env bash
# Battery and background in the iOS Simulator: how much CPU the app and its web content process
# burn in each state while nobody touches them, how much memory the web view holds, and whether
# iOS killed it. Runs where Maestro and Xcode are (the team's spare Mac, as a network job), on its
# own simulator, a Ponzu serving the examples (and any designs in PERF_DESIGNS) and Metro.
#
#   apps/mobile/perf/sim/sim.sh <udid> <label> [out dir]
#
# For each state, Maestro puts the app there (designs.yaml, canvas.yaml, comment.yaml, …), then
# nothing touches it for SAMPLE seconds while `ps` reads the CPU time of the app's process and of
# every WebContent process the simulator runs. Backgrounded is the canvas with Settings
# in front (`simctl launch` of Settings); locked isn't something simctl can do.
# Simulator numbers are this Mac's CPU, not an iPhone's: compare runs, not devices.
set -euo pipefail
UDID=${1:?simulator udid}
LABEL=${2:?label}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../.." && pwd)
MOBILE="$ROOT/apps/mobile"
OUT=${3:-${NETWORK_JOB_DIR:-$HERE}/artifacts/sim-$LABEL}
SAMPLE=${SAMPLE:-30}
STATES=${STATES:-designs canvas comment voice working standby background loops loops-working loops-background}
mkdir -p "$OUT"
pids=()
SCRATCH=$(mktemp -d -t ponzu-perf)
cleanup() {
  for p in ${pids[@]+"${pids[@]}"}; do kill "$p" 2>/dev/null || true; done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
wait_for() { for _ in $(seq 1 180); do curl -sf -m 2 "$1" >/dev/null && return 0; sleep 1; done; echo "Nothing at $1" >&2; return 1; }

# The examples, copied: the flows write comments, and an agent's presence is faked into Kettle.
mkdir -p "$SCRATCH/designs" "$SCRATCH/home"
cp -R "$ROOT/examples/kettle.design" "$SCRATCH/designs/"
for d in ${PERF_DESIGNS:-}; do cp -R "$d" "$SCRATCH/designs/"; done
# The phone's own stress pages (perf/corpus.ts): loops on two dozen boards.
bun "$HERE/../corpus.ts" "$SCRATCH/designs" >/dev/null
PONZU_PORT=$(free_port)
(cd "$SCRATCH/designs" && HOME="$SCRATCH/home" PONZU_HOME="$SCRATCH/home" PONZU_SPOTLIGHT=0 \
  PONZU_TAILSCALE=none PONZU_TELEMETRY=0 PONZU_BONJOUR=0 \
  exec bun "$ROOT/apps/cli/src/index.ts" serve --no-open --port "$PONZU_PORT" ./*.design) \
  >"$OUT/server.log" 2>&1 &
pids+=($!)
wait_for "http://127.0.0.1:$PONZU_PORT/api/info"

METRO_PORT=$(free_port)
(cd "$MOBILE" && EXPO_PUBLIC_PONZU_DEV_HOST="127.0.0.1:$PONZU_PORT" CI=1 \
  exec bunx expo start --dev-client --port "$METRO_PORT") >"$OUT/metro.log" 2>&1 &
pids+=($!)
wait_for "http://127.0.0.1:$METRO_PORT/status"

APP="$MOBILE/ios/build/dd/Build/Products/Debug-iphonesimulator/Ponzu.app"
# A warm worker keeps its last build: SKIP_BUILD=auto (the default) reuses it.
if [ "${SKIP_BUILD:-auto}" = 0 ] || { [ "${SKIP_BUILD:-auto}" = auto ] && [ ! -d "$APP" ]; }; then
  (cd "$MOBILE" && CI=1 bunx expo prebuild --platform ios) >"$OUT/build.log" 2>&1
  xcodebuild -workspace "$MOBILE/ios/Ponzu.xcworkspace" -scheme Ponzu -configuration Debug \
    -sdk iphonesimulator -destination "id=$UDID" -derivedDataPath "$MOBILE/ios/build/dd" \
    CODE_SIGNING_ALLOWED=NO build -quiet >>"$OUT/build.log" 2>&1
fi
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"

# Designs by the key the server gives them: their real path (/var is /private/var).
key() { (cd "$SCRATCH/designs/$1" && pwd -P); }
enc() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
KETTLE_KEY=$(key kettle.design)
KETTLE=$(enc "$KETTLE_KEY")
PHONE_KEY=$(key phone.design)
PHONE=$(enc "$PHONE_KEY")
DEV_CLIENT="exp+ponzu://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A$METRO_PORT"
DEVICE="$HOME/Library/Developer/CoreSimulator/Devices/$UDID"

# The processes of this simulator: the app, and the web content and GPU processes WebKit runs
# for it (WebContentExtension.appex, GPUExtension.appex, children of its launchd_sim).
app_pid() { pgrep -f "$DEVICE/data/Containers/Bundle/Application/.*/Ponzu.app/Ponzu" | head -1; }
sim_children() {
  local launchd
  launchd=$(pgrep -f "launchd_sim.*$UDID" | head -1)
  [ -n "$launchd" ] || return 0
  pgrep -P "$launchd" -f "$1" || true
}
web_pids() { sim_children "WebContentExtension.appex"; }
gpu_pids() { sim_children "GPUExtension.appex"; }
# CPU time in centiseconds and resident memory in KB for a list of pids, summed.
read_ps() { [ -n "$1" ] && ps -o time=,rss= -p "$1" | python3 -c '
import sys
cs=0; kb=0
for l in sys.stdin:
  t, r = l.split()
  p = t.replace("-", ":").split(":")
  s = 0
  for x in p: s = s * 60 + float(x)
  cs += s * 100; kb += int(r)
print(int(cs), kb)' || echo "0 0"; }
join() { tr '\n' ',' | sed 's/,$//'; }

# An agent claims Kettle's Brand boards over MCP: the canvas traces them and the title shimmers.
agent_working() {
  bun "$HERE/agent.ts" "$PONZU_PORT" "${2:-$KETTLE_KEY}" >"$OUT/agent-$1.log" 2>&1 &
  echo $!
}

flow() {
  local file=$1; shift
  maestro --device "$UDID" test -e KETTLE="$KETTLE" -e DEV_CLIENT="$DEV_CLIENT" \
    -e DESIGN="$KETTLE" -e PAGE=Brand -e EXTRA= "$@" "$HERE/$file" >"$OUT/maestro-$state.log" 2>&1
}

results="$OUT/sim-$LABEL.jsonl"
: >"$results"
for state in $STATES; do
  agent=""
  case $state in
    designs) flow designs.yaml ;;
    canvas) flow canvas.yaml ;;
    comment) flow comment.yaml ;;
    voice) flow voice.yaml ;;
    working) agent=$(agent_working working); sleep 3; flow canvas.yaml ;;
    standby) agent=$(agent_working standby); sleep 3; flow canvas.yaml -e EXTRA='&standby=1' ;;
    # The phone corpus's loops page: 24 boards with a spinner and a pulse each.
    loops) flow canvas.yaml -e DESIGN="$PHONE" -e PAGE=loops ;;
    loops-working) agent=$(agent_working loops "$PHONE_KEY"); sleep 3; flow canvas.yaml -e DESIGN="$PHONE" -e PAGE=loops ;;
    loops-background)
      flow canvas.yaml -e DESIGN="$PHONE" -e PAGE=loops
      xcrun simctl launch "$UDID" com.apple.Preferences >/dev/null 2>&1
      ;;
    background)
      flow canvas.yaml
      # Another app comes to the front (Settings) and Ponzu goes to the background, as a swipe to
      # another app would.
      xcrun simctl launch "$UDID" com.apple.Preferences >/dev/null 2>&1
      ;;
  esac
  sleep 5
  app=$(app_pid)
  webs=$(web_pids | join)
  gpus=$(gpu_pids | join)
  read -r a0 _ <<<"$(read_ps "$app")"
  read -r w0 _ <<<"$(read_ps "$webs")"
  read -r g0 _ <<<"$(read_ps "$gpus")"
  sleep "$SAMPLE"
  app2=$(app_pid)
  webs2=$(web_pids | join)
  read -r a1 arss <<<"$(read_ps "$app2")"
  read -r w1 wrss <<<"$(read_ps "$webs2")"
  read -r g1 _ <<<"$(read_ps "$gpus")"
  # Where the app's time goes, for the states that cost something.
  [ -n "$app2" ] && sample "$app2" 3 -file "$OUT/$state.sample.txt" >/dev/null 2>&1 || true
  xcrun simctl io "$UDID" screenshot "$OUT/$state.png" >/dev/null 2>&1 || true
  killed=$([ "$webs" = "$webs2" ] && echo false || echo true)
  python3 - "$state" "$a0" "$a1" "$w0" "$w1" "$arss" "$wrss" "$SAMPLE" "$killed" "$(uptime | sed 's/.*averages: //' | cut -d' ' -f1)" "$g0" "$g1" >>"$results" <<'PY'
import json, sys
s, a0, a1, w0, w1, arss, wrss, sec, killed, load, g0, g1 = sys.argv[1:]
pct = lambda a, b: round((int(b) - int(a)) / float(sec), 1)
print(json.dumps({"state": s, "appCpuPct": pct(a0, a1), "webCpuPct": pct(w0, w1), "gpuCpuPct": pct(g0, g1),
  "appMB": round(int(arss) / 1024), "webMB": round(int(wrss) / 1024),
  "webReplaced": killed == "true", "load1": float(load.rstrip(","))}))
PY
  tail -1 "$results"
  [ -n "$agent" ] && kill "$agent" 2>/dev/null || true
  xcrun simctl terminate "$UDID" design.ponzu.app >/dev/null 2>&1 || true
  sleep 2
done
python3 - "$results" >"$OUT/sim-$LABEL.md" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
print("| state | app CPU % | WebContent CPU % | WebKit GPU CPU % | app MB | WebContent MB | web content replaced | load1 |")
print("|---|---|---|---|---|---|---|---|")
for r in rows:
  print(f"| {r['state']} | {r['appCpuPct']} | {r['webCpuPct']} | {r['gpuCpuPct']} | {r['appMB']} | {r['webMB']} | {r['webReplaced']} | {r['load1']} |")
PY
cat "$OUT/sim-$LABEL.md"
