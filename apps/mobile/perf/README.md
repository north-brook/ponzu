# The phone's performance harness

How fast the iPhone app's canvas moves, how much it holds, and what the app burns while nobody
touches it. Two halves: the canvas page in headless WebKit (`canvas.ts`), and the real app with its
WKWebView in the iOS Simulator (`sim/`). There's no iPhone in it. Every number is this Mac's: compare
runs with each other, before and after a change, never with a phone.

| File | What it is |
| --- | --- |
| `canvas.ts` | The canvas page in Playwright's WebKit at an iPhone 17 Pro's size, played as the app plays it. |
| `probe.ts` | What's measured inside the page: frames, camera moves, `drawn`, what the page holds. |
| `metrics.ts` | The numbers, from what the probe saw. Tested in `metrics.test.ts`. |
| `corpus.ts` | The phone's own stress pages, `phone.design`. |
| `suite.sh` | Every page the targets cover, one run each. |
| `sim/sim.sh` | The app in the Simulator: CPU and memory in each state, and whether WebKit was killed. |
| `sim/*.yaml` | The Maestro flows that put the app in each state. |
| `sim/agent.ts` | An agent at work in a design (over MCP) for as long as it runs. |

## Targets

Set before any of the fixes, as desktop's were. A fix that helps one page and hurts another isn't
done. "Moves/s" is frames in which the camera actually moved, per second of moving; a page that
draws at 60 while the camera barely moves fails.

| What | Target |
| --- | --- |
| Pan, pinch and focus (double-tap, swipe) | ≥ 58 camera moves/s, no gap between moves over 50 ms |
| The first frame after a pinch stops | ≤ 33 ms |
| `drawn` (the app's placeholder gives way) | ≤ 1 s after the doc arrives |
| WebContent process | never killed on any page |
| A canvas at rest | its WebContent and WebKit GPU processes near 0% CPU, and nothing looping nobody can see |
| The app at rest (Designs, a canvas, a comment sheet, standby's camera between moves) | near 0% CPU |
| The app in the background | 0% CPU, its WebContent too |

## The canvas in WebKit

```sh
bun apps/mobile/canvas/build.ts
bun apps/mobile/perf/corpus.ts <dir>                     # <dir>/phone.design
PONZU_HOME=<scratch> HOME=<scratch> PONZU_SPOTLIGHT=0 PONZU_TAILSCALE=none PONZU_TELEMETRY=0 \
  PONZU_BONJOUR=0 ponzu serve --no-open --port 7861 <dir>/*.design <stress.design> <brand.design>
bun apps/mobile/perf/canvas.ts http://127.0.0.1:7861 <label> --file stress.design --pages paint,images
apps/mobile/perf/suite.sh http://127.0.0.1:7861 <label> [out]   # every page
```

Each page's row goes into `<out>/<label>.jsonl` (`results/` by default) and `<label>.md` is the table
of every row under the label; `suite.sh` starts its label afresh.

Serve copies of the designs from a scratch folder with `HOME` and `PONZU_HOME` pointed at scratch
and `PONZU_SPOTLIGHT=0`: otherwise the server lists every design on the Mac, and its previews get
redrawn into other checkouts.

`canvas.ts` needs the WebKit of the `playwright-core` it launches it with (`cd apps/mobile && bunx
playwright-core install webkit`, which runs the workspace's own version, or `PONZU_WEBKIT=<its
pw_run.sh>` for another build). It launches one browser per page, so a page's memory is its own.
It loads the built page (or `--html <file>`, another build of it) with the server as its origin,
as the app's `baseUrl` does, takes the doc from the design's socket and posts it in over the bridge
with insets for the app's bar (118 pt) and home indicator. `--working` adds an agent working on
every board of the page, so each draws its trace.

Fingers are trusted touch events from WebKit's own input protocol (`Input.dispatchTouchEvent`,
through the page proxy Playwright already holds), sent on a fixed 60 Hz clock and never awaited one
by one: a finger keeps moving whether the page keeps up or not, as Playwright's own `mouse.wheel`
does not. Each page gets:

- **drawn**: from the doc arriving to the canvas's `drawn` message. **ready**: every board mounted,
  its images loaded, its videos showing a frame, its fonts in. **settled**: five frames in a row
  under 50 ms after drawn, watched alongside ready, not after it; nothing is measured before then. A
  page of blurs can draw once and then stop drawing for seconds.
- **idle**: four seconds with nothing of the harness's running in the page, for the CPU of the
  WebContent process and of WebKit's GPU process; then two seconds of frames.
- **pan**: four one-finger flicks, each left to glide to rest. **pinch**: in 2.5×, out, in 1.6×.
  **focus**: a double-tap on the board nearest the middle, two swipes to the next boards, then a
  pinch out. Each gesture waits for the camera to stop *and* the page to draw again: a page that
  has stopped drawing is stalled, not at rest.
  For each: rAF fps, **moves/s** and the longest gap between moves (`cameraMoves`), counting only
  inside gestures. For pinch, **first frame after the last lift** and the longest frame in the
  second after, and the first frame past it, so a stall over its end shows (`settle`). The lift is
  when the last touch went out, on the page's clock, not when the page next answered.
- **stages**: main-thread self time by stage (script, style, layout, paint) from Web Inspector's
  timeline, per phase.
- **memory**: WebKit's own breakdown (JS, images, layers, page) and the WebContent process's
  footprint. **crashed**: the WebContent process died, a failure, never a missing number.
- **shot** and **blank**: a screenshot after it's drawn, and whether any board on screen painted.
  Look at the screenshot: a blank page scores 60.
- `load1` when the page started. Distrust a row above about 25.

Run one benchmark on the machine at a time. On the team's workstation that's the bench lock:
`BENCH_LOCK=/tmp/pzperf/bench-lock.sh apps/mobile/perf/suite.sh …`.

### Pages

Desktop's stress corpus (`stress.design`: many-boards, tall, images, video, paint, fonts, animated,
mixed; see its README), the brand design's Applications page (about 2,400 animated SVG slices),
Kettle's Brand and App pages, and `phone.design` from `corpus.ts`:

| page | what it stresses |
| --- | --- |
| `filmstrip` | 60 fit-content phone screens, 6 rows of 10: each measured before the page frames itself |
| `loops` | 24 phone screens, each with a spinner and a pulse; most are off screen at the opening zoom |
| `loops+trace` | the same with an agent working on every board: each draws the trace |
| `pins` | 12 screens with 8 open threads each, half pinned to nodes |

### The desktop mechanisms

Cached board pictures, recorded loops and image renditions (desktop's `perf/canvas-tiers-wip`) will
reach the phone through `ArtboardView`. Measure them the same way: build the page with them and
pass it as `--html`, against the same server and pages.

## The app in the Simulator

```sh
apps/mobile/perf/sim/sim.sh <simulator udid> <label> [out]
```

It needs Xcode, Maestro and Java (as `maestro/run.sh` does), so on the team's Macs it runs on
`spare` as a network job, on its own simulator:

```sh
network job start spare --repo ponzu --source . --include-dirty --agent command --resource ios -- \
  /bin/bash -lc 'export PATH=$HOME/.local/bin:$PATH; bun install --frozen-lockfile >/dev/null &&
  apps/mobile/perf/sim/sim.sh "$IOS_SIMULATOR_UDID" <label>'
```

It starts a Ponzu on a copy of Kettle and `phone.design`, Metro, and a Debug development client
(built once per worker: `SKIP_BUILD=0` rebuilds; a JavaScript change needs no rebuild). For each
state in `STATES`, a flow puts the app there, then nothing touches it for `SAMPLE` seconds (30)
while `ps` reads the CPU time of the app and of the simulator's WebKit processes
(`WebContentExtension.appex`, `GPUExtension.appex`), and `sample` records where the app's time goes
(`<state>.sample.txt`). Each process is compared only with itself: one that started during the
sample counts all its time, one that exited is reported as replaced (WebContent) or **app
exited**, and the run goes on to the next state. A screenshot of each state shows it was where it
should be.

| state | what it is |
| --- | --- |
| `designs` | the Designs list |
| `canvas` | Kettle's Brand page, drawn |
| `comment` | the comment sheet in typing, text in it, the keyboard up |
| `voice` | the comment sheet in voice (the microphone refused) |
| `working` | Kettle's canvas while an agent works on four of its boards: traces, the title's shimmer |
| `standby` | the same, in standby (`?standby=1`) |
| `background` | Kettle's canvas with Settings brought to the front |
| `loops`, `loops-working`, `loops-background` | `phone.design`'s loops page, at rest, with an agent, behind Settings |

A locked screen isn't something `simctl` can do. A Debug build runs its JavaScript slower than a
release does, and the Simulator's CPU is the Mac's: compare states and runs, not devices.
