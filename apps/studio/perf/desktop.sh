#!/bin/bash
# The harness on the desktop app, on a Mac's own GPU and display (README.md, "Profiling"). It
# opens windows, so it runs on spare through fleet-work's desktop lease, never a person's Mac.
# Builds this checkout's studio with the fake in it (--mode e2e), and PERF_BASE's beside it when
# set, and the checkout's main process; then runs run.ts with --electron, the two builds in turn,
# and once more in headless Chrome on the same machine, for the difference. Readings go to
# $NETWORK_JOB_DIR/artifacts. Arguments go to run.ts.
#
#   PERF_BASE=<ref> apps/studio/perf/desktop.sh --only website,examples --rounds 3
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
job="${NETWORK_JOB_DIR:-${TMPDIR:-/tmp}/ponzu-perf-desktop}"
out="$job/artifacts"
work="$job/builds"
mkdir -p "$out" "$work"
cd "$root"

base_src=""
# A worker's checkout is left as it was found: bun install can rewrite bun.lock, and the base's
# checkout is removed however the run ends.
cleanup() {
  git -C "$root" checkout -- bun.lock 2>/dev/null || true
  if [ -n "$base_src" ]; then git -C "$root" worktree remove --force "$base_src" 2>/dev/null || true; fi
}
trap cleanup EXIT
# The display stays awake while windows are measured: a sleeping one stops their frames.
caffeinate -dimu -w $$ &

bun install
studio() { (cd "$1/apps/studio" && env -u NODE_ENV bunx vite build --mode e2e --outDir "$2" >/dev/null); }
studio "$root" "$work/head"
head_sha="$(git rev-parse HEAD)"
args=(--head "$work/head" --head-sha "$head_sha")
if [ -n "${PERF_BASE:-}" ]; then
  base_sha="$(git rev-parse "$PERF_BASE^{commit}")"
  base_src="$work/base-src"
  git worktree add --detach "$base_src" "$base_sha" >/dev/null
  (cd "$base_src" && bun install >/dev/null)
  studio "$base_src" "$work/base"
  args+=(--base "$work/base" --base-sha "$base_sha")
fi
# The checkout's main process (Ponzu Local), which takes PONZU_STUDIO_URL and the fake backend.
(cd apps/desktop && bun scripts/build.ts)
sw_vers >"$out/machine.txt"
system_profiler SPDisplaysDataType >>"$out/machine.txt" 2>/dev/null || true

# PERF_RECORD=<seconds>: a recording of the screen from the start, if the lease may take one.
if [ -n "${PERF_RECORD:-}" ]; then
  (screencapture -x -v -V "$PERF_RECORD" "$out/screen.mov" >"$out/screen.log" 2>&1 || true) &
fi

bun apps/studio/perf/run.ts --electron "$root/apps/desktop/run-dev.sh" "${args[@]}" "$@" \
  --out "$out/electron.json" --markdown "$out/electron.md" 2>&1 | tee "$out/electron.log" || true
bun apps/studio/perf/run.ts "${args[@]}" "$@" \
  --out "$out/headless.json" --markdown "$out/headless.md" 2>&1 | tee "$out/headless.log"
