#!/usr/bin/env bash
# Every page the phone's targets cover, one WebKit run each: desktop's stress corpus, the brand
# design's Applications page (if it's served), the phone's own pages and Kettle.
#
#   apps/mobile/perf/suite.sh <server> <label> [out dir]
#
# Each design runs under the machine-wide bench lock when BENCH_LOCK names it
# (/tmp/pzperf/bench-lock.sh on the team's workstation), so one benchmark measures at a time.
set -euo pipefail
SERVER=${1:?server}
LABEL=${2:?label}
OUT=${3:-$(dirname "$0")/results}
HERE=$(cd "$(dirname "$0")" && pwd)
bun "$HERE/../canvas/build.ts"
# Every run below adds its rows to <label>.jsonl and rewrites <label>.md from all of them: start
# the label afresh, so a rerun doesn't keep the last one's rows.
mkdir -p "$OUT" && rm -f "$OUT/$LABEL.jsonl"
run() {
  if [ -n "${BENCH_LOCK:-}" ]; then "$BENCH_LOCK" "mobile-perf:$LABEL" bun "$HERE/canvas.ts" "$@"
  else bun "$HERE/canvas.ts" "$@"; fi
}
run "$SERVER" "$LABEL" --file stress.design --out "$OUT" \
  --pages many-boards,tall,images,video,paint,fonts,animated,mixed
if curl -sf "$SERVER/api/catalog" | grep -q 'brand.design'; then
  run "$SERVER" "$LABEL" --file brand.design --pages Applications --out "$OUT"
fi
run "$SERVER" "$LABEL" --file phone.design --pages filmstrip,loops,pins --out "$OUT"
run "$SERVER" "$LABEL" --file phone.design --pages loops --working --out "$OUT"
run "$SERVER" "$LABEL" --file kettle.design --pages Brand,App --out "$OUT"
