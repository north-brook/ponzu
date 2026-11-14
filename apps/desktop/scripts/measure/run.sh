#!/bin/bash
# Builds the unsigned packaged app as a test build whose studio carries Ponzu Cloud in memory,
# then measures it (measure.ts) on the founder-shaped canvas and on a small one. For spare,
# through fleet-work's desktop lease: it opens a window. Readings go to
# $NETWORK_JOB_DIR/artifacts/<canvas>/. Arguments after the script go to measure.ts.
#
#   CANVASES="founder small" apps/desktop/scripts/measure/run.sh --comments 20
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
out="${NETWORK_JOB_DIR:-${TMPDIR:-/tmp}/ponzu-measure}/artifacts"
mkdir -p "$out"
cd "$root"
git rev-parse HEAD >"$out/commit.txt" 2>/dev/null || true

# A worker's checkout must be left as it was found: bun install can rewrite bun.lock's
# workspace versions, so it is put back however the run ends.
trap 'git -C "$root" checkout -- bun.lock 2>/dev/null || true' EXIT
bun install
# The studio built as the headless tests build it: with the fake backend in it.
(cd apps/studio && env -u NODE_ENV bunx vite build --mode e2e)
cd apps/desktop
PONZU_TEST_BUILD=1 bun scripts/build.ts
CSC_IDENTITY_AUTO_DISCOVERY=false bunx electron-builder --dir --publish never
app="$root/apps/desktop/out/mac-arm64/Ponzu.app/Contents/MacOS/Ponzu"
cd "$root"

for canvas in ${CANVASES:-founder small}; do
  bun apps/desktop/scripts/measure/measure.ts --app "$app" --out "$out/$canvas" \
    --canvas "$canvas" "$@" 2>&1 | tee "$out/$canvas.log"
done
