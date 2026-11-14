/*
 * Measures the packaged Mac app as a person uses it, on Ponzu Cloud in memory: a test build
 * (PONZU_TEST_BUILD=1) whose studio was built with `--mode e2e`, launched with
 * PONZU_FAKE_BACKEND=1 (src/config.ts) and a remote debugging port, so it touches no account,
 * keychain or network. Run it where a window may open (spare, through fleet-work's desktop
 * lease; never a person's own Mac): run.sh builds the app and calls this.
 *
 *   bun apps/desktop/scripts/measure/measure.ts --app <Ponzu.app/Contents/MacOS/Ponzu> \
 *     --out <dir> [--canvas founder|small] [--comments 20] [--idle-start 120] [--idle-end 600]
 *
 * The points are round 1's (.context/cloud/program/results/studio-performance-deep-dive.json):
 * open, idle, each comment, pan and zoom, switch canvases and back, a long idle. At each, macOS
 * `footprint` of the window's renderer (by VM tag), the GPU process and the main process, with
 * no forced garbage collection: what the person's Mac would hold. A forced GC and a critical
 * memory-pressure signal come only at the very end. Counts (the window's localStorage writes and
 * their bytes, structuredClone calls, long animation frames) come from instruments put in the
 * page before the studio loads.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { synthetic } from "./synthetic.ts";

const { values: args } = parseArgs({
  options: {
    app: { type: "string" },
    out: { type: "string" },
    canvas: { type: "string", default: "founder" },
    comments: { type: "string", default: "20" },
    "idle-start": { type: "string", default: "120" },
    "idle-end": { type: "string", default: "600" },
  },
});
if (!args.app || !args.out) throw new Error("--app and --out are required");
const OUT = args.out;
const SMALL = args.canvas === "small";
const COMMENTS = Number(args.comments);
const IDLE_START_S = Number(args["idle-start"]);
const IDLE_END_S = Number(args["idle-end"]);
mkdirSync(OUT, { recursive: true });

const pw = Bun.resolveSync(
  "playwright-core",
  Bun.resolveSync("@ponzu/render/chromium", join(import.meta.dir, "../../../studio")),
);
const { chromium } = (await import(pw)) as typeof import("playwright-core");

/** Waits for `ms`: only between a person's actions, never as a test's assertion. */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const save = (name: string, data: unknown) =>
  writeFileSync(join(OUT, name), JSON.stringify(data, null, 1));

/* ------------------------------------------------------------------ */
/* macOS footprint                                                     */
/* ------------------------------------------------------------------ */

const UNIT = "[\\d.]+\\s*(?:KB|MB|GB|B)";
function mb(text: string): number {
  const m = text.match(/([\d.]+)\s*(KB|MB|GB|B)/);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]!);
  return m[2] === "GB" ? n * 1024 : m[2] === "MB" ? n : m[2] === "KB" ? n / 1024 : n / 1048576;
}

interface Footprint {
  pid: number;
  mb: number;
  /** Dirty memory by category (VM tag), in MB, for every category of at least 1 MB. */
  tags: Record<string, number>;
}

function footprint(pid: number, raw?: string): Footprint {
  try {
    const out = execFileSync("footprint", ["-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (raw) writeFileSync(join(OUT, raw), out);
    const total = out.match(/Footprint:\s*([\d.]+\s*\w+)/);
    const tags: Record<string, number> = {};
    for (const line of out.split("\n")) {
      const m = line.match(
        new RegExp(`^\\s*(${UNIT})\\s+(${UNIT})\\s+(${UNIT})\\s+(\\d+)\\s+(.+?)\\s*$`),
      );
      if (m && m[5] !== "TOTAL" && mb(m[1]!) >= 1) tags[m[5]!.trim()] = Math.round(mb(m[1]!));
    }
    return { pid, mb: total ? Math.round(mb(total[1]!)) : 0, tags };
  } catch {
    return { pid, mb: 0, tags: {} };
  }
}

/** The app's processes by kind: its main process, the GPU process, renderers, utilities. */
function processes(main: number): { kind: string; pid: number }[] {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  const found = [{ kind: "main", pid: main }];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || Number(m[2]) !== main) continue;
    const type = m[3]!.match(/--type=([\w-]+)/)?.[1] ?? "other";
    const utility = m[3]!.match(/--utility-sub-type=([\w.]+)/)?.[1];
    found.push({ kind: utility ? `utility:${utility}` : type, pid: Number(m[1]) });
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* What the page counts                                                */
/* ------------------------------------------------------------------ */

const INSTRUMENTS = `(() => {
  const R = (window.__pz = { storageWrites: 0, storageBytes: 0, storageMs: 0, storageMaxMs: 0,
    clones: 0, cloneMs: 0, loaf: 0, loafBlockingMs: 0, loafMaxMs: 0 });
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    const t = performance.now();
    try { return set.call(this, key, value); } finally {
      const ms = performance.now() - t;
      R.storageWrites++; R.storageBytes += String(key).length + String(value).length;
      R.storageMs += ms; R.storageMaxMs = Math.max(R.storageMaxMs, ms);
    }
  };
  R.bigJson = 0; R.bigJsonBytes = 0; R.bigJsonMs = 0;
  const js = JSON.stringify;
  JSON.stringify = function (...a) {
    const t = performance.now();
    const out = js.apply(this, a);
    if (typeof out === "string" && out.length > 100000) {
      R.bigJson++; R.bigJsonBytes += out.length; R.bigJsonMs += performance.now() - t;
    }
    return out;
  };
  const sc = window.structuredClone.bind(window);
  window.structuredClone = (v, o) => {
    const t = performance.now();
    const out = sc(v, o);
    R.clones++; R.cloneMs += performance.now() - t;
    return out;
  };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) {
      R.loaf++; R.loafBlockingMs += e.blockingDuration; R.loafMaxMs = Math.max(R.loafMaxMs, e.duration);
    } }).observe({ type: "long-animation-frame", buffered: false });
  } catch {}
})();`;

type Counts = Record<string, number>;
type Page = import("playwright-core").Page;
const counts = (page: Page) =>
  page.evaluate(() => ({ ...(window as unknown as { __pz: Counts }).__pz }));
const minus = (a: Counts, b: Counts) =>
  Object.fromEntries(Object.keys(a).map((k) => [k, Math.round((a[k]! - (b[k] ?? 0)) * 10) / 10]));

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

const app = spawn(args.app, ["--remote-debugging-port=0"], {
  env: { ...process.env, PONZU_FAKE_BACKEND: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
const log: string[] = [];
const endpoint = new Promise<string>((resolve, reject) => {
  const hear = (chunk: Buffer) => {
    const text = chunk.toString();
    log.push(text);
    const m = text.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]!);
  };
  app.stderr.on("data", hear);
  app.stdout.on("data", hear);
  app.once("exit", (code) => reject(new Error(`the app exited ${code} before listening`)));
});
const mainPid = app.pid!;

const readings: unknown[] = [];
const timeline: { t: number; renderer: number; gpu: number; main: number }[] = [];
let sampling = true;
const t0 = Date.now();

try {
  const browser = await chromium.connectOverCDP(await endpoint);
  const context = browser.contexts()[0]!;
  await context.addInitScript(INSTRUMENTS);
  let page = context.pages().find((p) => p.url().startsWith("ponzu-studio:"));
  for (let i = 0; !page && i < 100; i++) {
    await pause(100);
    page = context.pages().find((p) => p.url().startsWith("ponzu-studio:"));
  }
  if (!page) throw new Error("no studio page");
  // Signed in, past setup, in the light theme, with the instruments in place before the studio.
  await page.goto("ponzu-studio://app/?as=returning");
  await page.locator("#sidebar").waitFor({ timeout: 60_000 });
  const isFake = await page.evaluate(() => "ponzuFake" in window);
  if (!isFake) throw new Error("the studio is not on the fake backend: build it with --mode e2e");

  const renderer = () => {
    const all = processes(mainPid).filter((p) => p.kind === "renderer");
    return all.map((p) => footprint(p.pid)).sort((a, b) => b.mb - a.mb)[0]!;
  };
  const pidOf = (kind: string) => processes(mainPid).find((p) => p.kind === kind)?.pid ?? 0;
  const reading = async (label: string, raw = false) => {
    const kinds = processes(mainPid);
    const page_ = page!;
    const r = {
      label,
      atS: Math.round((Date.now() - t0) / 1000),
      processes: kinds.map((p) => {
        const f = footprint(
          p.pid,
          raw && (p.kind === "renderer" || p.kind === "gpu-process")
            ? `footprint-${label.replace(/\W+/g, "-")}-${p.kind}-${p.pid}.txt`
            : undefined,
        );
        return { kind: p.kind, ...f };
      }),
      dom: await page_
        .evaluate(() => ({
          nodes: document.getElementsByTagName("*").length,
          heapMB: Math.round(
            ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
              ?.usedJSHeapSize ?? 0) / 1048576,
          ),
          localStorageKB: Math.round(
            Object.keys(localStorage).reduce(
              (n, k) => n + k.length + (localStorage.getItem(k) ?? "").length,
              0,
            ) / 1024,
          ),
        }))
        .catch(() => null),
      counts: await counts(page_),
    };
    const short = r.processes
      .filter((p) => p.mb >= 20)
      .map((p) => `${p.kind} ${p.mb} MB`)
      .join(", ");
    console.log(`[${r.atS}s] ${label}: ${short}; dom ${JSON.stringify(r.dom)}`);
    readings.push(r);
    save("readings.json", readings);
    return r;
  };

  // Footprint every two seconds for the whole run: the peaks between readings.
  void (async () => {
    while (sampling) {
      try {
        timeline.push({
          t: Math.round((Date.now() - t0) / 100) / 10,
          renderer: renderer().mb,
          gpu: footprint(pidOf("gpu-process")).mb,
          main: footprint(mainPid).mb,
        });
        if (timeline.length % 15 === 0) save("timeline.json", timeline);
      } catch {}
      await pause(2_000);
    }
  })();

  // The canvases, made through the in-memory API as round 1 made them.
  const ids = await page.evaluate(
    async ({ syn, small }) => {
      const world = (window as any).ponzuFake;
      const backend = world.backend;
      const repoId = backend.workspaces.get(world.workspaceId).repos[0].id;
      const mine = backend.connect(world.me).api;
      const sam = backend.connect(world.teammate).api;
      const make = async (name: string) =>
        (await mine.canvases.create({ workspaceId: world.workspaceId, repoId, name })).id;
      const a = await make(small ? "Small A" : "Synthetic A");
      const b = await make(small ? "Small B" : "Synthetic B");
      let board: string;
      if (small) {
        board = world.drawBoard(a, "Welcome");
        world.drawBoard(a, "Pick a repo", "#f4f3ef");
        world.drawBoard(b, "Other", "#e8e2d4");
      } else {
        const p1 = backend.canvas(a).sequencer.doc.pages[0].id;
        backend.agent(a).commit([
          { op: "page.create", index: 1, page: { id: "pg_synth2", name: "Page 2" } },
          ...syn.A.page1.map((artboard: unknown, index: number) => ({
            op: "artboard.create",
            page: p1,
            index,
            artboard,
          })),
          ...syn.A.page2.map((artboard: unknown, index: number) => ({
            op: "artboard.create",
            page: "pg_synth2",
            index,
            artboard,
          })),
        ]);
        board = syn.A.page1[0].id;
        // 32 threads, 34 messages: 19 by people, the rest by the agent.
        let said = 0;
        const author = (p: { id: string; name?: string; githubLogin?: string }) => ({
          kind: "user",
          id: p.id,
          name: p.name ?? p.githubLogin,
        });
        const old = Date.now() - 3_600_000;
        for (const [i, t] of syn.A.threads.entries()) {
          const messages = Array.from({ length: t.messages }, (_, k) => ({
            id: `m_seed${i}_${k}`,
            author: author(world.me),
            text: `Seed comment ${i}.${k}: tighten the spacing here and check the contrast`,
            createdAt: old,
          }));
          const op = {
            op: "thread.create",
            thread: {
              id: `th_seed${i}`,
              artboardId: t.artboardId,
              nodeId: t.nodeId,
              x: t.x,
              y: t.y,
              status: "open",
              createdAt: old,
              updatedAt: old,
              messages,
            },
          };
          if (said < 19) {
            await (i % 3 === 0 ? sam : mine).canvases.commit(a, [{ id: `op_seed${i}`, op }]);
            said += t.messages;
          } else {
            backend.agent(a).commit([op]);
          }
        }
        for (let i = 0; i < 16; i++) {
          backend.agent(a).tool(`Edited the Home board (${i})`, { streaming: false, steps: 3 });
          backend
            .agent(a)
            .say(
              `I tightened the hero and the cards, step ${i}. The gradients now share one token, and the shadows step down with depth.`,
            );
        }
        const docB = backend.canvas(b).sequencer.doc;
        backend.agent(b).commit(
          syn.B.page1.map((artboard: unknown, index: number) => ({
            op: "artboard.create",
            page: docB.pages[0].id,
            index,
            artboard,
          })),
        );
      }
      // The in-memory API keeps the whole document after every op, for undo. The real API is not
      // in the window, so that history is let go of and not kept from now on.
      for (const id of [a, b]) {
        const h = backend.canvas(id).sequencer.history;
        h.length = 0;
        h.push = () => 0;
      }
      return {
        a,
        b,
        board,
        bytesA: JSON.stringify(backend.canvas(a).sequencer.doc).length,
        bytesB: JSON.stringify(backend.canvas(b).sequencer.doc).length,
      };
    },
    { syn: SMALL ? null : synthetic(), small: SMALL },
  );
  console.log("seeded", ids);
  await reading("signed in, before opening");

  const open = (id: string) =>
    page!.evaluate((canvasId) => (window as any).ponzuFake.link({ kind: "canvas", canvasId }), id);
  const opened = Date.now();
  await open(ids.a);
  await page.locator(`[data-pz-board="${ids.board}"]`).waitFor({ timeout: 120_000 });
  await page.locator("#thread").waitFor({ timeout: 60_000 });
  const openMs = Date.now() - opened;
  console.log(`opened in ${openMs} ms`);
  await pause(8_000);
  await page.screenshot({ path: join(OUT, "opened.png") });
  await reading("opened, 8 s later", true);
  await pause(IDLE_START_S * 1000);
  await reading(`idle ${IDLE_START_S} s`, true);

  // Where to click: the board's visible part, a different spot each time.
  const spot = async (k: number) => {
    const box = (await page!.locator(`[data-pz-board="${ids.board}"]`).boundingBox())!;
    const pane = (await page!.locator(".pz-root").first().boundingBox())!;
    const x0 = Math.max(box.x, pane.x) + 40;
    const x1 = Math.min(box.x + box.width, pane.x + pane.width) - 40;
    const y0 = Math.max(box.y, pane.y) + 60;
    const y1 = Math.min(box.y + box.height, pane.y + pane.height) - 60;
    return {
      x: x0 + (x1 - x0) * (0.15 + 0.17 * (k % 5)),
      y: y0 + (y1 - y0) * (0.2 + 0.15 * Math.floor(k / 5)),
    };
  };

  const comments: unknown[] = [];
  for (let k = 0; k < COMMENTS; k++) {
    await page.keyboard.press("c");
    await pause(300);
    const at = await spot(k);
    await page.mouse.click(at.x, at.y);
    const box = page.getByPlaceholder("Leave a comment…");
    await box.waitFor({ timeout: 30_000 });
    const text = `Synthetic comment ${k + 1}: the cards feel heavy, try a lighter shadow`;
    await box.fill(text);
    await pause(500);
    const before = await counts(page);
    const peak = { renderer: 0, gpu: 0 };
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        peak.renderer = Math.max(peak.renderer, renderer().mb);
        peak.gpu = Math.max(peak.gpu, footprint(pidOf("gpu-process")).mb);
        await pause(250);
      }
    })();
    await page.keyboard.press("Enter");
    // When the comment shows in the rail, and its picture: watched in the page for 10 s.
    const marks = await page.evaluate(async (text) => {
      const t = performance.now();
      const seen: Record<string, number> = {};
      while (performance.now() - t < 10_000) {
        const lines = [...document.querySelectorAll("#thread p")].filter((p) =>
          (p.textContent ?? "").includes(text.slice(0, 20)),
        );
        if (lines.length && seen.inRail === undefined) seen.inRail = performance.now() - t;
        const line = lines[0]?.parentElement?.parentElement;
        if (
          line?.querySelector('button[aria-label^="Open the comment"] img') &&
          seen.picture === undefined
        ) {
          seen.picture = performance.now() - t;
        }
        await new Promise((r) => setTimeout(r, 16));
      }
      return Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, Math.round(v)]));
    }, text);
    watching = false;
    await watcher;
    const did = minus(await counts(page), before);
    await page.keyboard.press("Escape");
    await pause(300);
    const r = await reading(`after comment ${k + 1}`, k === COMMENTS - 1);
    const result = { k: k + 1, marks, did, peak, renderer: r.processes };
    comments.push(result);
    console.log(
      `comment ${k + 1}: ${JSON.stringify(marks)} ${JSON.stringify(did)} peak ${JSON.stringify(peak)}`,
    );
  }
  await page.screenshot({ path: join(OUT, "after-comments.png") });

  // Pan and zoom over the boards: across, far in, far out and back, as a person looks around.
  const pane = (await page.locator(".pz-root").first().boundingBox())!;
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  const gesture = { renderer: 0, gpu: 0, gpuSamples: [] as number[] };
  let moving = true;
  const gestureWatcher = (async () => {
    while (moving) {
      const gpu = footprint(pidOf("gpu-process")).mb;
      gesture.gpu = Math.max(gesture.gpu, gpu);
      gesture.gpuSamples.push(gpu);
      gesture.renderer = Math.max(gesture.renderer, renderer().mb);
      await pause(250);
    }
  })();
  const before = await counts(page);
  // Frames the window drew during the gesture, and the longest gap between two: counted only now,
  // so the idle readings have no frame loop running.
  await page.evaluate(() => {
    const w = window as unknown as { __pzFrames: { n: number; maxGap: number; on: boolean } };
    w.__pzFrames = { n: 0, maxGap: 0, on: true };
    let last = performance.now();
    const tick = (t: number) => {
      const f = w.__pzFrames;
      if (!f.on) return;
      f.n++;
      f.maxGap = Math.max(f.maxGap, t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(i % 20 < 10 ? 60 : -60, 30);
    await pause(16);
  }
  await page.keyboard.down("Meta");
  for (const [steps, dy] of [
    [25, -40],
    [50, 40],
    [25, -40],
  ] as const) {
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, dy);
      await pause(16);
    }
  }
  await page.keyboard.up("Meta");
  await pause(2_000);
  moving = false;
  await gestureWatcher;
  const frames = await page.evaluate(() => {
    const f = (window as unknown as { __pzFrames: { n: number; maxGap: number; on: boolean } })
      .__pzFrames;
    f.on = false;
    return { n: f.n, maxGapMs: Math.round(f.maxGap) };
  });
  await page.screenshot({ path: join(OUT, "after-pan-and-zoom.png") });
  const panned = { ...gesture, frames, did: minus(await counts(page), before) };
  console.log(`pan and zoom: peak ${JSON.stringify({ ...panned, gpuSamples: undefined })}`);
  await reading("after pan and zoom", true);
  await pause(10_000);
  await reading("12 s after pan and zoom", true);
  await pause(20_000);
  await reading("32 s after pan and zoom");

  await open(ids.b);
  await pause(6_000);
  await reading("on canvas B");
  await open(ids.a);
  await pause(8_000);
  await reading("switched to B and back", true);

  for (let s = 60; s <= IDLE_END_S; s += 60) {
    await pause(60_000);
    await reading(`idle ${s} s at the end`, s === IDLE_END_S);
  }

  // Only now: what the window would give back if it were asked.
  const cdp = await context.newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  await pause(3_000);
  await reading("after a forced GC", true);
  await cdp.send("Memory.simulatePressureNotification", { level: "critical" });
  await pause(3_000);
  await reading("after a critical memory pressure signal", true);

  save("summary.json", {
    canvas: SMALL ? "small" : "founder",
    ids,
    panned,
    openMs,
    readings,
    comments,
    timeline,
    electron: await page.evaluate(() => navigator.userAgent),
  });
  await browser.close().catch(() => {});
} finally {
  sampling = false;
  save("timeline.json", timeline);
  writeFileSync(join(OUT, "app.log"), log.join(""));
  app.kill("SIGTERM");
  await pause(2_000);
  if (app.exitCode === null) app.kill("SIGKILL");
}
