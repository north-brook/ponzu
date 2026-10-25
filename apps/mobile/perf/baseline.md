# Baseline: the phone on main, 2026-10-25

`origin/main` at 27f062a (Ponzu 1.51.0, iPhone app 0.1.x). Headless WebKit 27.2 (Playwright's
build 2359, the engine WKWebView uses) at 402×874 @3x with touch, on an M4 Max workstation. The
Simulator half ran on the team's spare Mac (Xcode 26.6, iOS 26.5 simulator, a Debug build). Every
number is a Mac's, not an iPhone's. An iPhone has a fraction of this CPU and GPU and kills its
web content process far sooner, so read these as relative: where it's slow here, it's slower
there.

Two full passes of `suite.sh`, each page under the machine-wide bench lock. Cells show
`run 1 / run 2` where they differ. Other agents' renders kept the workstation busy: `load1` was 15–30
for run 1 and up to 110 for run 2, so the second run's slow rows are partly load. Trust a row
where the runs agree, and the run with the lower `load1` where they don't.

## Targets

From `README.md`, set before any fix:

- pan, pinch and focus ≥ 58 camera moves/s, no gap between moves over 50 ms;
- the first frame after a pinch ≤ 33 ms;
- `drawn` ≤ 1 s;
- the WebContent process never killed;
- a canvas at rest, its WebContent and WebKit's GPU process near 0% CPU, nothing looping that
  nobody can see;
- the app at rest (Designs, a canvas, a comment sheet) near 0% CPU, and 0% in the background.

## The canvas in WebKit

| page | boards | elements | loops | drawn ms | settled ms | idle CPU % | pan moves/s | pan max gap ms | pinch moves/s | pinch max gap ms | first frame after pinch ms | focus moves/s | focus max gap ms | WebContent MB | killed | load1 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| many-boards | 150 | 29612 | 0 | 253 / 292 | 1197 / 1428 | 0 / 0 | **50.2 / 42.5** | **105 / 156** | **38.7 / 43.1** | **73 / 79** | 4 | **36.5 / 45** | **121 / 112** | 446 / 529 | no | 23 / 44 |
| tall | 4 | 7620 | 0 | 524 / 655 | 810 / 1200 | 0 / 0 | 63.1 / 55.1 | **88 / 206** | **54.1 / 56.6** | **62 / 54** | 9 | 61.6 / 42.7 | **56 / 104** | 452 / 535 | no | 19 / 54 |
| images | 40 | 3006 | 0 | 257 / 296 | 1196 / 3324 | 0.3 | **41.3 / 23.1** | **1434 / 1424** | 55.9 / 41.2 | **64 / 166** | 6 / 5 | 67.7 / 46.3 | **151 / 239** | 804 / 1356 | no | 17 / 49 |
| video | 12 | 377 | 0 | 228 / 231 | never (2 of 24 videos never load) | 1 | 68.7 / 64.5 | 44 / 65 | 58.4 / 51.7 | 30 / 58 | 7 / 0 | 63.2 / 58.8 | 47 / 87 | 614 / 622 | no | 18 / 40 |
| paint | 20 | 1110 | 0 | 141 / 166 | **8708 / 9959** | 0 / 1.3 | **0.3 / 0.4** | **5899 / 6658** | 52.6 / 43.5 | 19 / 23 | – / **986** | **0.4 / 0.2** | **6960 / 4631** | 981 / 958 | no | 17 / 44 |
| fonts | 10 | 400 | 0 | 210 / 354 | 428 / 711 | 0.3 / 0 | 67.5 / 63.9 | **139 / 79** | 60.6 / 52.6 | 30 / 43 | 10 / 12 | 69 / 58.7 | 29 / 70 | 321 / 473 | no | 30 / 109 |
| animated | 9 | 38822 | 4265 | **4161 / 4597** | **never** | **96.3 / 91.5** | **1.1 / 1** | **1006 / 1154** | **2 / 1.6** | **927 / 928** | 9 / 10 | **1.7 / 1.8** | **841 / 857** | **1471 / 1591** | no | 23 / 82 |
| mixed | 41 | 4544 | 288 | 550 / 530 | never (videos) | **29 / 25.5** | **13.4 / 12** | **1631 / 1911** | **26.1 / 21.4** | **190 / 272** | **64 / 142** | **43.6 / 10.2** | **347 / 2179** | 958 / 1060 | no | 23 / 34 |
| Applications (brand) | 7 | 38431 | 3858 | **5090 / 4883** | **never** | **25.3 / 23.5** | **0** / – | – | **3.1** / – | **388** / – | 12 / – | – | – | – | **yes / yes** | 79 / 64 |
| filmstrip | 60 | 7275 | 0 | 187 / 179 | 444 / 440 | 0 / 0.3 | 68.3 / 68.6 | 45 / 53 | 59.3 / 59.4 | 31 / 30 | 6 / 7 | 60.9 / 66.4 | **118** / 32 | 98 | no | 95 / 53 |
| loops | 24 | 1591 | 48 | 96 / 112 | 259 / 224 | 0.5 / 0.8 | 69.3 / 68.3 | 42 / **110** | 57.9 / 60.3 | 31 | 12 / 8 | 61.5 / 65.2 | **99** / 30 | 75 | no | 89 / 43 |
| loops + trace | 24 | 1621 | 48 | 116 / 103 | 240 / 229 | **12.3 / 12.3** | 68.7 / 68 | **62 / 171** | 59.1 / 60.1 | 32 / 33 | 4 / 7 | 65.1 / 66 | 41 / 32 | 84 / 83 | no | 86 / 38 |
| pins | 12 | 1179 | 0 | 78 / 72 | 164 / 159 | 0 | 68.2 / 65.9 | 48 / **157** | 59.8 / 59.7 | 29 | 5 / 8 | 60.9 / 65.9 | **126** / 30 | 731 / 692 | no | 81 / 33 |
| Kettle Brand | 6 | 435 | 0 | 33 / 12 | 268 / 239 | 0 | 67.6 / 69 | **87** / 43 | 59 / 59.2 | 34 / 31 | 7 | 65.5 / 65.9 | 44 / 30 | 53 / 51 | no | 70 / 28 |
| Kettle App | 8 | 714 | 0 | 16 / 15 | 217 / 199 | 0.3 | 68.9 / 69.1 | 42 / 43 | 59.7 / 58 | 29 / 36 | 10 / 8 | 65.7 / 66.1 | 30 | 885 / 54 | no | 57 / 24 |

Bold: misses a target. Idle CPU is the WebContent process over four quiet seconds. Settled is
the first run of five frames under 50 ms after the doc arrives. Videos that never load hold off
"ready", not "settled". "never" means it didn't settle within the harness's 30 s (60 s with
videos still loading).

Main-thread time by stage (Web Inspector's timeline, ms of self time over each phase; run 1):

| page | pan: script / style / layout / paint | pinch | focus |
|---|---|---|---|
| many-boards | **7679** / 161 / 226 / 380 | **1244** / 27 / 40 / 154 | **1507** / 28 / 42 / 170 |
| images | 657 / 102 / 33 / **4262** | 224 / 25 / 9 / 15 | 662 / 100 / 1 / 0 |
| animated | 83 / **2702** / 451 / **8414** | 85 / **1386** / 299 / **2516** | 142 / **2008** / 420 / **5697** |
| Applications | 66 / **2329** / 460 / **16100** | 77 / **1051** / 159 / **5787** | – |
| mixed | **1291** / **1047** / 408 / **1035** | 200 / 255 / 100 / 31 | 402 / 449 / 181 / 60 |

## The app in the Simulator

`sim/sim.sh` on spare, Kettle (and `phone.design`'s loops page), 30 s per state, nobody touching it.
Two runs (the second at a lower load, 4–10).

| state | app CPU % | WebContent CPU % | WebKit GPU CPU % | app MB | WebContent MB | WebContent killed |
|---|---|---|---|---|---|---|
| Designs | 2.5 / 1.4 | 0 | 0 | 1121 / 1133 | – | no |
| canvas | 1.8 / 1.6 | 0 | 0 | 1159 / 1160 | 283 / 277 | no |
| comment sheet (typing, keyboard up) | **2.0 / 30.0**, then **29.6** in a third run | 0 | 0 | 1217 / 1229 | 289 | no |
| comment sheet (voice, microphone refused) | **28.9 / 29.6** | 0 | 0 | 1207 / 1216 | 292 | no |
| an agent working (traces, the title's shimmer) | 2.0 / **16.7** | 0 / **10.7** | 0 / **33.8** | 1160 / 1173 | 282 / 288 | no |
| standby (`?standby=1`), agent working | 2.1 / **17.6** | 0 / **9.7** | 0 / **13.6** | 1142 / 1156 | 284 / 348 | no |
| backgrounded (Settings in front) | 0 | 0 | 0 | 1159 / 1163 | 279 / 284 | no |
| loops page at rest | 1.3 | 0.8 | 0.1 | 1191 | 334 | no |
| loops page, agent working | **17.9** | **9.5** | **7.2** | 1188 | 336 | no |
| loops page backgrounded | 0 | 0 | 0 | 1184 | 338 | no |

The first run's agent named the design by `/var/…` rather than the `/private/var/…` key the phone
opened, so its presence never matched the open design: its "working" and "standby" rows are a
canvas at rest. The second run's are real.
The Debug app's resident memory (about 1.1 GB) is mostly the development client and Hermes's
debugger; the release build is far smaller. Backgrounded, iOS suspends the app and its web view,
which is why that row is 0 on main already.

## Where it hurts, ranked

1. **Thousands of animated elements (`animated`, brand `Applications`).** About one move a second
   panning, 92–96% idle CPU in the web view, `drawn` 4–5 s, and Applications' WebContent process
   is **killed** in both runs (headless WebKit's own limit here; an iPhone's is lower). Paint and
   style take the main thread: 8–16 s of paint and 2.3–2.7 s of style per pan phase. Every loop
   repaints its board every frame, and the boards are live at every zoom. Holding the loops
   doesn't help in WebKit: setting `playbackRate`, pausing, `animation-play-state` and
   `content-visibility` on the 3 of 7 Applications boards out of sight *raised* the web view's
   CPU (26% → 87–97%, measured with each), and holding or releasing one loop costs about
   0.65 ms, so 4,265 of them stall for 2.8 s at each end. What reaches the target is not
   drawing those boards live: desktop's cached board pictures and recorded loops.
2. **The comment sheet's waveform clock (app, Simulator).** About **30% CPU** while the comment
   sheet is open in typing (the waveform is hidden) or in voice with the microphone refused (the
   waveform has nothing to follow). `sample` puts it in Reanimated's frame callback
   (`AnimationFrameBatchinator::flush` → `REANodesManager performOperations` → commit), restyling
   the waveform's 34 bars every frame. This is the user's lead: their Duo simulator at 24% with the
   sheet in typing. The 2% in one typing run is when the sheet opened straight in typing
   (`withRepeat` started before the first frame and was dropped); it opens in the last mode used.
3. **The camera in React state (`many-boards`, every page a little).** Each frame of a pan
   re-rendered the whole canvas: every board's wrapper, `boxes.find` per board, every label and
   pin. On `many-boards` that's **7.7 s of script** per 4-flick pan phase, 50/43 moves/s, gaps
   over 100 ms and 37–45 moves/s focusing. Phone-only; desktop's new camera is on its branch.
4. **Big images (`images`, `mixed`).** Panning across 388 full-size originals: 4.3–4.8 s of paint
   (decode) per pan phase, gaps of 1.4 s, 23–41 moves/s, 0.8–1.4 GB in the web view. Desktop's
   image renditions are the lever; nothing phone-specific.
5. **Heavy paint (`paint`).** Blurs, backdrop filters and blends take 9–10 s to draw at all, and
   then WebKit stalls 5–7 s on the first gesture: the camera barely moves (0.3 moves/s). Holding
   `will-change` on or off doesn't change it (measured both). Cached board pictures are the lever.
6. **An agent at work (Simulator and `loops + trace`).** The canvas's trace march (an SVG dash
   offset animated every frame, on screen above the boards) costs **9–19% of the web view** and
   7–34% of WebKit's GPU process with one board traced or 24, and the app 17–18% with the title's
   shimmer and the session card. While an agent works for an hour, that's the battery.
7. **Smaller hitches everywhere.** Gaps of 80–170 ms on light pages (fonts, filmstrip, pins, Kettle)
   come from the React re-render each frame (3), on a loaded machine.

What was already right: the app and its web view at 0% in the background (iOS suspends them),
nothing killed but Applications, `drawn` well under a second except the animated pages, and the
first frame after a pinch inside 33 ms on all but `paint` and `mixed`.
