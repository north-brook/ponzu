# The studio's performance harness

How fast the studio is where people feel it: the canvas zooming, panning and taking an agent's
work, the panes resizing, a long thread opening and streaming, switching canvases, and the
client's side of a prompt. Every pull request that can change the app gets one comment with these
numbers, head against its base, and main keeps a history of them.

It runs the studio as the desktop app bundles it (`vite build --mode e2e`), in headless Chrome, on
Ponzu Cloud in memory (`src/app/fake-host.ts`), seeded with a corpus of boards made to stress the
canvas. Nothing here talks to a real service.

```sh
bun apps/studio/perf/run.ts                                   # this checkout, built now, one round
bun apps/studio/perf/run.ts --only website.zoom,thread        # some scenarios, or whole suites
bun apps/studio/perf/run.ts --head <dir> --base <dir> --rounds 3 --markdown comment.md
bun apps/studio/perf/run.ts --only website.zoom --profile traces   # keep each trace, say why
```

`--head` and `--base` are e2e builds (`cd apps/studio && bunx vite build --mode e2e --outDir
<dir>`). To compare against main locally, build main in a `git worktree` and pass it as `--base`.

| File | What it is |
| --- | --- |
| `run.ts` | The command: builds, rounds, interleaving, results and the comment. |
| `scenarios.ts` | What's played: the suites, their canvases and scenarios. |
| `corpus.ts` | The boards: real example pages and generated edge cases (`corpus.test.ts`). |
| `app.ts` | The studio in Chrome: open it, seed a canvas, open it, wait for its boards. |
| `probe.ts` | What runs in the page: the frame clock, React's commit count, event timing, the gestures. |
| `trace.ts` | Chrome's trace, summed by phase; `explain` says why a trace cost what it did. |
| `metrics.ts` | What each number means, and when a difference is a change and not noise. |
| `report.ts` | The pull request's comment, and main's history. |
| `history.ts` | One line of history from a run, for the workflow. |
| `../../../.github/workflows/perf.yml` | Measures every pull request against its base, comments, keeps main's history. |

## The numbers

**Counts** are what Chrome and React did: elements restyled and layout objects laid out per frame
of a gesture, React commits, DOM elements. A gesture is a fixed number of frames, played from inside
the page (probe.ts), so these barely depend on the machine: most repeat to within a percent or two.
They are the numbers to trust, and most regressions show here before they show in a time. A few
lean on timing (how many frames a redraw lands in, how React batches) and wander between rounds;
a count is called a change when it moves 3% and its rounds don't overlap the base's.

**Times** are the runner's: frame rate, p95 frame, long frames, main-thread, style, layout, paint,
raster and GPU milliseconds, latencies. CI builds the base beside the head and runs them in turn,
three rounds each, the order swapped every round. A time is called a change only when it moved 10%
and the two builds' rounds don't overlap. One round of every suite takes about 70 seconds on an
M-series Mac.

Nothing here fails a check. A number that moved is a question for the pull request, answered in its
description.

## The suites

| Suite | What it stresses |
| --- | --- |
| `website` | Two tall marketing pages dense with mockups and a big footer, at about 13% (the canvas that was slow to zoom): open, zoom, pan, both panes resized, an agent's edit landing. |
| `examples` | The example designs' landing pages, as an agent draws them. |
| `dom` | A dense grid, a big table, a 300-deep tree, a wall of text, a fit-content page. |
| `paint` | Shadows, filters, blends and masks; big SVG charts; many images. |
| `motion` | Hundreds of running CSS and SVG animations. |
| `many` | Sixty small boards on one page. |
| `huge` | One 8000 px board. |
| `thread` | A 300-line conversation: opening it, Claude streaming a reply, typing in the composer. |
| `sidebar` | Switching between two canvases. |
| `sandbox` | The client's side of a prompt: Enter on the create page to the first board drawn, and a wake landing, with a sandbox that answers at once. |

A scenario's id (`website.zoom`) is what history is kept by: rename one and its trend starts over.
To add a case, add a board kind to `corpus.ts` or a scenario to `scenarios.ts`, and run it twice:
its counts should come out the same both times.

The real sandbox's own times (a wake from its snapshot, the first token, the first board on the real
services) cost money and need credentials, so they are not measured per pull request. The live
lifecycle test (`packages/client/src/lifecycle.live.test.ts`) is where they are taken today.

## Profiling

When a number moves, or something feels slow and no number says so yet:

1. **Make it a scenario.** If no suite shows it, add one (a board kind, a gesture, an action) and
   check that the comment would have caught it. A slow surface with no scenario stays slow.
2. **Profile it.** `--profile <dir>` keeps each scenario's trace as `<dir>/<scenario>.json` (open it
   in Chrome DevTools' Performance panel or at ui.perfetto.dev) and prints what `explain` makes of
   it: the longest tasks, the script that ran most, and **why style and layout were invalidated**,
   with the element and the line that did it. Times under `--profile` are slower: the trace records
   every invalidation.
3. **Read the names.** The build is minified; for readable stacks build it with
   `bunx vite build --mode e2e --minify false --outDir <dir>` and pass `--head <dir>`.
4. **Fix the cause, then re-run** with `--base` on the build from before the fix, and put the table
   in the pull request.

To measure the packaged app on a Mac's GPU instead of headless Chrome, a checkout run takes
`PONZU_FAKE_BACKEND=1` (apps/desktop/src/config.ts) and then accepts a debugging port; that runs on
spare, never on a workstation.

## What we've learned

Rules each bought with a measured regression. Keep them, or change them with numbers.

- **Never write a style an ancestor of the boards passes down, while anything moves.** A CSS custom
  property set on an element is inherited by everything under it, shadow roots included, and
  Chrome restyles every one of those elements when it changes. Set on the canvas's scroll plane (the
  ground's dots, every zoom frame) or the window (the panes' widths, every drag frame), it restyled
  every element of every live board, every frame: 4,500 elements and 400 ms of each second of a
  pinch on two landing pages. Put the property on the element that uses it, or on a sibling of the
  boards, never above them. `restyledPerFrame` is the number that catches it.
- **The camera stays out of React.** A gesture fires dozens of events a second; the camera writes
  the boards' transform and scroll directly (`useCameraLayers`), and React renders only when a
  board's tier inputs change (`useCameraView`).
- **A pan is a scroll.** Chrome moves a scroll on the compositor without restyling, laying out or
  painting anything: `website.pan` restyles nothing, and should stay that way.
