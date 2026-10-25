/*
 * The phone canvas's benchmark in headless WebKit (Playwright's, the engine WKWebView uses), at
 * an iPhone 17 Pro's size with touch. It plays the app's part as components/canvas-view.tsx
 * does: the built page (canvas/dist/index.html) loaded with the Mac as its origin, the design's
 * socket held here and the doc, ops and presence posted in over the bridge. Fingers are trusted
 * touch events from WebKit's own input protocol, sent on a steady 60 Hz clock and never awaited
 * one by one, as a finger keeps moving whether or not the page keeps up.
 *
 *   bun apps/mobile/canvas/build.ts
 *   bun apps/mobile/perf/canvas.ts <server> <label> [--file <key>] [--pages a,b] [--out dir]
 *     [--working] [--html <page>] [--no-trace] [--theme dark]
 *
 * See README.md for the pages, the metrics and the targets. Numbers are this Mac's, not an
 * iPhone's: compare runs with each other, never with a phone.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import type { Doc, Presence } from "@ponzu/core";
import { webkit } from "playwright-core";
import type { ToCanvas } from "../canvas/protocol.ts";
import {
  cameraMoves,
  cpuTime,
  frames,
  round,
  settle,
  stages,
  type TimelineRecord,
} from "./metrics.ts";
import { PROBE } from "./probe.ts";

const here = import.meta.dir;
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};
const fileArg = opt("file");
// Another build of the page to measure (a branch's canvas/dist/index.html); this checkout's by default.
const htmlPath = resolve(opt("html") ?? join(here, "../canvas/dist/index.html"));
const pagesArg = opt("pages");
const out = resolve(opt("out") ?? join(here, "results"));
const theme = (opt("theme") ?? "light") as "light" | "dark";
const noTrace = flag("no-trace");
const working = flag("working");
const [server, label] = argv;
if (!server || !label) {
  console.error(
    "usage: bun apps/mobile/perf/canvas.ts <server> <label> [--file <key>] [--pages a,b] [--working] [--no-trace] [--out dir]",
  );
  process.exit(2);
}
// Playwright's WebKit build. PONZU_WEBKIT points at another (pw_run.sh in its folder).
const executablePath = process.env.PONZU_WEBKIT;
const VIEW = { width: 402, height: 874 };
/** What the app's chrome covers on an iPhone 17 Pro: the bar and the home indicator. */
const INSETS = { top: 118, right: 0, bottom: 34, left: 0 };
const HZ = 60;
const STEP = 1000 / HZ;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The design's doc from its socket, as the app gets it: the hello. */
async function hello(key: string): Promise<{ doc: Doc; presence: Presence[] }> {
  const ws = new WebSocket(`${server!.replace(/^http/, "ws")}/ws?file=${encodeURIComponent(key)}`, {
    headers: { "user-agent": "Ponzu-iOS/perf" },
  } as unknown as string[]);
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`no hello for ${key}`)), 30_000);
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.t !== "hello") return;
      clearTimeout(t);
      ws.close();
      res({ doc: msg.doc, presence: msg.presence ?? [] });
    };
    ws.onerror = () => rej(new Error(`socket failed for ${key}`));
  });
}

async function catalogKey(name: string | undefined): Promise<string> {
  const res = await fetch(`${server}/api/catalog`, { headers: { "user-agent": "Ponzu-iOS/perf" } });
  const { files } = (await res.json()) as { files: { key: string; name: string }[] };
  const hit = name
    ? files.find((f) => f.key === name || f.key.endsWith(name) || f.name === name)
    : files.find((f) => /stress\.design$/.test(f.key));
  if (!hit) throw new Error(`no design ${name ?? "stress.design"} on ${server}`);
  return hit.key;
}

/** The WebContent processes Playwright's WebKit runs, by pid, with their footprints in MB. */
function webContent(): Map<number, number> {
  const ps = Bun.spawnSync(["pgrep", "-f", "ms-playwright/webkit.*WebContent"]).stdout.toString();
  const pids = ps.split("\n").filter(Boolean).map(Number);
  const res = new Map<number, number>();
  if (!pids.length) return res;
  const fp = Bun.spawnSync([
    "/usr/bin/footprint",
    "-f",
    "bytes",
    ...pids.flatMap((p) => ["-p", String(p)]),
  ]);
  for (const m of fp.stdout.toString().matchAll(/\[(\d+)\]: \d+-bit\s+Footprint: (\d+) B/g))
    res.set(Number(m[1]), round(Number(m[2]) / 1048576, 0));
  return res;
}

interface Finger {
  id: number;
  x: number;
  y: number;
}

async function runPage(key: string, doc: Doc, pageName: string, presence: Presence[]) {
  const page0 = doc.pages.find((p) => p.name === pageName || p.id === pageName);
  if (!page0) throw new Error(`no page ${pageName}`);
  const before = new Set(webContent().keys());
  const browser = await webkit.launch({ headless: true, executablePath });
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Ponzu-iOS/perf",
    colorScheme: theme,
  });
  const page = await context.newPage();
  const result: Record<string, unknown> = { page: pageName, load1: round(loadavg()[0]!) };
  let crashed = false;
  page.on("crash", () => {
    crashed = true;
  });
  page.on("pageerror", (e) => console.error(`[${pageName}] page error: ${e.message}`));
  // Playwright's own sessions: the page proxy takes input, the page answers Memory and Timeline.
  const impl = (page as any)._connection.toImpl(page).delegate;
  const input = impl._pageProxySession;
  const inspector = impl._session;

  try {
    const origin = `${server}/`;
    const html = readFileSync(htmlPath, "utf8");
    // The page as the app loads it: `source={{ html, baseUrl }}` with the Mac as its origin.
    await page.route(origin, (r) => r.fulfill({ contentType: "text/html", body: html }));
    await page.addInitScript(PROBE);
    const send = (msg: ToCanvas) =>
      page.evaluate((m) => (window as any).__ponzuCanvas.receive(m), msg as any);
    await page.goto(origin);
    await page.waitForFunction(() => (window as any).__ponzuCanvas, null, { timeout: 30_000 });
    const assetBase = `${server}/files/${encodeURIComponent(key)}`;
    await send({ t: "insets", insets: INSETS, sheet: 0, radius: 55 });
    // Drawn is timed from the doc arriving, as the app's placeholder waits on it.
    await page.evaluate(
      (m) => {
        (window as any).__pzPerf.docAt = performance.now();
        (window as any).__ponzuCanvas.receive(m);
      },
      { t: "doc", doc, assetBase, theme, file: key, page: page0.id } as any,
    );
    await send({ t: "presence", presence });
    await page.waitForFunction(() => (window as any).__pzPerf.drawn != null, null, {
      timeout: 60_000,
    });
    result.drawnMs = await page.evaluate(() =>
      Math.round((window as any).__pzPerf.drawn - (window as any).__pzPerf.docAt),
    );
    // Ready: every board mounted, its images loaded and its videos showing a frame, fonts in.
    const ready = await page
      .waitForFunction(
        () => {
          const s = (window as any).__pzPerf.scan();
          return (
            s.boards > 0 && s.imgsDone === s.imgs && s.vidsReady === s.vids && s.fonts === "loaded"
          );
        },
        null,
        { timeout: 60_000, polling: 100 },
      )
      .then(() => true)
      .catch(() => false);
    result.readyMs = ready
      ? await page.evaluate(() => Math.round(performance.now() - (window as any).__pzPerf.docAt))
      : null;
    // Settled: five frames in a row under 50 ms. A page of blurs can draw its first frame and
    // then stop drawing for seconds while WebKit rasterizes it; nothing is measured until then.
    result.settleMs = await page
      .evaluate(
        () =>
          new Promise<number | null>((done) => {
            const S = (window as any).__pzPerf;
            let last = 0;
            let run = 0;
            const give = setTimeout(() => done(null), 30_000);
            const f = (t: number) => {
              run = last && t - last < 50 ? run + 1 : 0;
              last = t;
              if (run >= 5) {
                clearTimeout(give);
                return done(Math.round(t - S.docAt));
              }
              requestAnimationFrame(f);
            };
            requestAnimationFrame(f);
          }),
      )
      .catch(() => null);
    await sleep(500);
    result.scan = await page.evaluate(() => (window as any).__pzPerf.scan());
    result.shot = join(out, `shot-${label}-${pageName}.png`);
    await page.screenshot({ path: result.shot as string });
    result.blank = await blank(page);

    // Idle: nobody touching it. First four seconds with nothing of the harness's running in the
    // page, for the CPU its WebContent process burns (the canvas's share of a battery), then two
    // seconds of frames.
    const pid = newest(before);
    const gpu = gpuProcess();
    const cpu0 = cpuOf(pid);
    const gpu0 = cpuOf(gpu);
    await sleep(4000);
    const cpu1 = cpuOf(pid);
    const gpu1 = cpuOf(gpu);
    await page.evaluate(() => (window as any).__pzPerf.start());
    await sleep(2000);
    const idle = await page.evaluate(() => (window as any).__pzPerf.stop());
    result.idle = {
      ...frames(idle.t, 2000),
      moves: idle.moves.length,
      cpuPct: cpu0 != null && cpu1 != null ? round(((cpu1 - cpu0) / 4000) * 100) : null,
      // WebKit's GPU process draws for every page this browser runs: one page at a time, it's
      // this page's compositing and animation work.
      gpuCpuPct: gpu0 != null && gpu1 != null ? round(((gpu1 - gpu0) / 4000) * 100) : null,
    };

    // Touches go out on a steady clock: each is sent when its time comes, not when the last one
    // was handled. The page's own clock times each gesture.
    const now = () => page.evaluate(() => performance.now());
    const touch = (type: string, points: Finger[]) =>
      input
        .send("Input.dispatchTouchEvent", {
          type,
          touchPoints: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), id: p.id })),
        })
        .catch(() => {});
    const play = async (steps: { type: string; points: Finger[] }[]) => {
      const start = performance.now();
      const sent: Promise<unknown>[] = [];
      for (let i = 0; i < steps.length; i++) {
        const due = start + i * STEP;
        const wait = due - performance.now();
        if (wait > 1) await sleep(wait);
        sent.push(touch(steps[i]!.type, steps[i]!.points));
      }
      await Promise.all(sent);
    };
    /**
     * Wait for the camera to stop (a glide or an ease) and the page to draw again, up to `max`
     * ms: three quiet checks in a row with frames coming. A page that has stopped drawing isn't
     * at rest, it's stalled, and the next gesture would land in the stall.
     */
    const rest = async (max = 8000) => {
      let last = "";
      let still = 0;
      const t = Date.now();
      while (Date.now() - t < max) {
        // A frame within 200 ms, asked for once: no loop of the harness's own keeps it drawing.
        const now = await page.evaluate(
          () =>
            new Promise<{ cam: string; drew: boolean }>((done) => {
              const cam = JSON.stringify((window as any).__pzPerf.camera());
              const t = setTimeout(() => done({ cam, drew: false }), 200);
              requestAnimationFrame(() => {
                clearTimeout(t);
                done({ cam, drew: true });
              });
            }),
        );
        still = now.cam === last && now.drew ? still + 1 : 0;
        last = now.cam;
        await sleep(50);
        if (still >= 3) return;
      }
    };

    const cx = VIEW.width / 2;
    const cy = VIEW.height / 2;
    /** One finger, flicked: 30 moves, faster at the end, then up, and the glide plays out. */
    const flick = (dx: number, dy: number) => {
      const steps = [{ type: "touchStart", points: [{ id: 1, x: cx - dx / 2, y: cy - dy / 2 }] }];
      for (let i = 1; i <= 30; i++) {
        const k = (i / 30) ** 1.6;
        steps.push({
          type: "touchMove",
          points: [{ id: 1, x: cx - dx / 2 + dx * k, y: cy - dy / 2 + dy * k }],
        });
      }
      const end = steps.at(-1)!.points[0]!;
      steps.push({ type: "touchEnd", points: [end] });
      return steps;
    };
    /** Two fingers, spreading by `scale` over 40 moves, then both up. */
    const pinch = (scale: number) => {
      const r0 = 60;
      const r1 = r0 * scale;
      const at = (r: number) => [
        { id: 1, x: cx - r, y: cy - r * 0.3 },
        { id: 2, x: cx + r, y: cy + r * 0.3 },
      ];
      const steps = [
        { type: "touchStart", points: [at(r0)[0]!] },
        { type: "touchStart", points: at(r0) },
      ];
      for (let i = 1; i <= 40; i++)
        steps.push({ type: "touchMove", points: at(r0 + ((r1 - r0) * i) / 40) });
      steps.push({ type: "touchEnd", points: [at(r1)[1]!] });
      steps.push({ type: "touchEnd", points: [at(r1)[0]!] });
      return steps;
    };
    const timeline: TimelineRecord[] = [];
    const onRecord = (e: { record: TimelineRecord }) => timeline.push(e.record);
    if (!noTrace) {
      inspector.on("Timeline.eventRecorded", onRecord);
      await inspector
        .send("Timeline.setInstruments", { instruments: ["Timeline"] })
        .catch(() => {});
    }
    const traced = async <T>(name: string, fn: () => Promise<T>) => {
      if (noTrace) return fn();
      timeline.length = 0;
      await inspector.send("Timeline.start").catch(() => {});
      const r = await fn();
      await inspector.send("Timeline.stop").catch(() => {});
      await sleep(100);
      (result.stages as Record<string, unknown>)[name] = stages(timeline);
      return r;
    };
    result.stages = {};

    // Pan: four flicks, each gliding to rest.
    result.pan = await traced("pan", async () => {
      await page.evaluate(() => (window as any).__pzPerf.start());
      const spans: [number, number][] = [];
      for (const [dx, dy] of [
        [-260, -120],
        [220, 160],
        [-180, 240],
        [200, -260],
      ] as const) {
        const a = await now();
        await play(flick(dx, dy));
        await rest();
        spans.push([a, await now()]);
      }
      const f = await page.evaluate(() => (window as any).__pzPerf.stop());
      return { ...frames(f.t), ...cameraMoves(f.moves, spans) };
    });

    // Pinch: in 2.5×, out again, in 1.6×. Settle is the first frame after the last lift.
    result.pinch = await traced("pinch", async () => {
      await page.evaluate(() => (window as any).__pzPerf.start());
      const spans: [number, number][] = [];
      let lift = 0;
      for (const s of [2.5, 0.4, 1.6]) {
        const a = await now();
        await play(pinch(s));
        lift = await now();
        await rest();
        spans.push([a, await now()]);
      }
      const f = await page.evaluate(() => (window as any).__pzPerf.stop());
      return { ...frames(f.t), ...cameraMoves(f.moves, spans), settle: settle(f.t, lift) };
    });

    // Focus: double-tap the board nearest the middle, then swipe to the next two, then pinch out.
    result.focus = await traced("focus", async () => {
      await send({ t: "focus", artboardId: null });
      await rest();
      const target = await page.evaluate(() => {
        let best: { x: number; y: number } | null = null;
        let bd = Number.POSITIVE_INFINITY;
        for (const h of Array.from(document.querySelectorAll("[data-artboard-host]"))) {
          const r = h.parentElement!.getBoundingClientRect();
          if (r.width < 20 || r.height < 20) continue;
          const x = Math.min(Math.max(innerWidth / 2, r.left + 10), r.right - 10);
          const y = Math.min(Math.max(innerHeight / 2, r.top + 10), r.bottom - 10);
          const d = (x - innerWidth / 2) ** 2 + (y - innerHeight / 2) ** 2;
          if (d < bd) {
            bd = d;
            best = { x, y };
          }
        }
        return best;
      });
      if (!target) return null;
      await page.evaluate(() => (window as any).__pzPerf.start());
      const spans: [number, number][] = [];
      const tap = [
        { type: "touchStart", points: [{ id: 1, ...target }] },
        { type: "touchEnd", points: [{ id: 1, ...target }] },
      ];
      let a = await now();
      await play([...tap, ...tap]);
      await rest();
      spans.push([a, await now()]);
      const focused = await page.evaluate(
        () =>
          (window as any).__pzPerf.messages.filter((m: any) => m.t === "focused").at(-1)
            ?.artboardId ?? null,
      );
      for (let i = 0; i < 2; i++) {
        a = await now();
        const steps = [{ type: "touchStart", points: [{ id: 1, x: cx + 140, y: cy }] }];
        for (let k = 1; k <= 12; k++)
          steps.push({
            type: "touchMove",
            points: [{ id: 1, x: cx + 140 - (280 * k) / 12, y: cy }],
          });
        steps.push({ type: "touchEnd", points: [{ id: 1, x: cx - 140, y: cy }] });
        await play(steps);
        await rest();
        spans.push([a, await now()]);
      }
      a = await now();
      await play(pinch(0.3));
      await rest();
      spans.push([a, await now()]);
      const f = await page.evaluate(() => (window as any).__pzPerf.stop());
      return { focused: Boolean(focused), ...frames(f.t), ...cameraMoves(f.moves, spans) };
    });

    result.idleAfter = await (async () => {
      await page.evaluate(() => (window as any).__pzPerf.start());
      await sleep(2000);
      const f = await page.evaluate(() => (window as any).__pzPerf.stop());
      return frames(f.t, 2000);
    })();

    const mem = await memory(inspector);
    result.memory = { ...mem, webContentMB: maxNew(webContent(), before) };
    result.scanEnd = await page.evaluate(() => (window as any).__pzPerf.scan());
    result.errors = await page.evaluate(() => (window as any).__pzPerf.errors.slice(0, 5));
  } catch (err) {
    result.error = crashed
      ? "web content process terminated"
      : String((err as Error).message ?? err);
  } finally {
    result.crashed = crashed;
    await browser.close().catch(() => {});
  }
  return result;
}

/** The WebContent process this run started. */
function newest(before: Set<number>): number | null {
  for (const pid of webContent().keys()) if (!before.has(pid)) return pid;
  return null;
}

/** WebKit's GPU process: one per browser, and the harness runs one browser at a time. */
function gpuProcess(): number | null {
  const ps = Bun.spawnSync(["pgrep", "-f", "ms-playwright/webkit.*WebKit.GPU"]).stdout.toString();
  const pids = ps.split("\n").filter(Boolean).map(Number);
  return pids.at(-1) ?? null;
}

/** A process's CPU time so far, in ms. */
function cpuOf(pid: number | null): number | null {
  if (pid == null) return null;
  const t = cpuTime(Bun.spawnSync(["ps", "-o", "time=", "-p", String(pid)]).stdout.toString());
  return Number.isNaN(t) ? null : t;
}

/** The largest WebContent process this run started. */
function maxNew(now: Map<number, number>, before: Set<number>) {
  let max = 0;
  for (const [pid, mb] of now) if (!before.has(pid)) max = Math.max(max, mb);
  return max || null;
}

/** WebKit's own breakdown of the page's memory, as Web Inspector shows it, in MB. */
async function memory(inspector: {
  send(m: string, p?: object): Promise<any>;
  on(e: string, f: (e: any) => void): void;
  off?(e: string, f: (e: any) => void): void;
}) {
  const got: Record<string, number> = {};
  const on = (e: { event: { categories: { type: string; size: number }[] } }) => {
    for (const c of e.event.categories) got[c.type] = Math.max(got[c.type] ?? 0, c.size);
  };
  inspector.on("Memory.trackingUpdate", on);
  await inspector.send("Memory.startTracking").catch(() => {});
  await sleep(1200);
  await inspector.send("Memory.stopTracking").catch(() => {});
  inspector.off?.("Memory.trackingUpdate", on);
  const mb = (k: string) => round((got[k] ?? 0) / 1048576, 0);
  return {
    jsMB: mb("javascript"),
    imagesMB: mb("images"),
    layersMB: mb("layers"),
    pageMB: mb("page"),
    totalMB: round(Object.values(got).reduce((a, b) => a + b, 0) / 1048576, 0),
  };
}

/** Whether the screenshot is one flat color: a page that drew nothing also scores 60. */
async function blank(page: import("playwright-core").Page) {
  return page.evaluate(() => {
    const boards = Array.from(document.querySelectorAll("[data-artboard-host]"));
    const shown = boards.filter((h) => {
      const r = h.parentElement!.getBoundingClientRect();
      return (
        r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && r.width > 4
      );
    });
    const painted = shown.some(
      (h) => (h.shadowRoot?.querySelector("[data-artboard]") as HTMLElement | null)?.offsetHeight,
    );
    return !painted;
  });
}

const key = await catalogKey(fileArg);
const { doc, presence: live } = await hello(key);
const pages = pagesArg
  ? pagesArg.split(",")
  : doc.pages.map((p) => p.name).filter((n) => n !== "start");
mkdirSync(out, { recursive: true });
const rows: Record<string, unknown>[] = [];
for (const name of pages) {
  const p = doc.pages.find((x) => x.name === name || x.id === name);
  // --working: an agent working on every board of the page, as presence says, so each traces.
  const presence: Presence[] =
    working && p
      ? [
          {
            id: "perf-agent",
            name: "Claude",
            kind: "agent",
            client: "claude",
            working: p.artboards.map((a) => a.id),
            file: key,
            since: Date.now(),
            lastSeen: Date.now(),
          },
        ]
      : live;
  const r = await runPage(key, doc, name, presence);
  if (working) r.page = `${name}+trace`;
  r.label = label;
  r.design = key.split("/").at(-1);
  console.log(JSON.stringify(r));
  appendFileSync(join(out, `${label}.jsonl`), `${JSON.stringify(r)}\n`);
  rows.push(r);
}
writeFileSync(join(out, `${label}.md`), table(rows));
console.log(table(rows));

function table(rs: Record<string, any>[]) {
  const head =
    "| page | boards | elements | anims | drawn ms | ready ms | settled ms | idle fps | idle CPU % (web + GPU) | pan moves/s | pan max gap | pinch moves/s | pinch max gap | settle first / max ms | focus moves/s | focus max gap | heap MB | images MB | WebContent MB | crashed | blank | load1 |";
  const sep = `|${head
    .split("|")
    .slice(2)
    .map(() => "---|")
    .join("")}`;
  const line = (r: Record<string, any>) =>
    `| ${r.page} | ${r.scan?.boards ?? "–"} | ${r.scan?.elements ?? "–"} | ${r.scan?.anims ?? "–"} | ${r.drawnMs ?? "–"} | ${r.readyMs ?? "–"} | ${r.settleMs ?? "**never**"} | ${r.idle?.fps ?? "–"} | ${r.idle?.cpuPct ?? "–"} + ${r.idle?.gpuCpuPct ?? "–"} | ${r.pan?.movesPerS ?? "–"} | ${r.pan?.maxGapMs ?? "–"} | ${r.pinch?.movesPerS ?? "–"} | ${r.pinch?.maxGapMs ?? "–"} | ${r.pinch?.settle?.firstMs ?? "–"} / ${r.pinch?.settle?.maxMs ?? "–"} | ${r.focus?.movesPerS ?? "–"} | ${r.focus?.maxGapMs ?? "–"} | ${r.memory?.jsMB ?? "–"} | ${r.memory?.imagesMB ?? "–"} | ${r.memory?.webContentMB ?? "–"} | ${r.crashed ? "**yes**" : "no"} | ${r.blank ? "**yes**" : "no"} | ${r.load1} |${r.error ? ` ${r.error}` : ""}`;
  return [head, sep, ...rs.map(line)].join("\n") + "\n";
}
