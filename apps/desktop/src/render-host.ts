import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserWindow } from "electron";
// Shared with the server's own renderers. It imports nothing, so the bundle takes just this file.
import { captureScale, IMAGES_READY_SCRIPT } from "../../../packages/render/src/capture.ts";
import {
  RenderError,
  type RenderStage,
  STAGE_BUDGET_MS,
  withBudget,
  within,
} from "../../../packages/render/src/stages.ts";

/*
 * The server asks the desktop app for screenshots: it runs no Chrome of its
 * own. Each job loads the page in an offscreen window the artboard's size and
 * captures through the DevTools protocol, which renders whatever area it's
 * asked for, inside the window or below it, at any scale.
 *
 * Not webContents.capturePage. That copies the window's last composited
 * frame, so it failed with "UnknownVizError" whenever the window had just been
 * resized or zoomed (a fit-content artboard taller than 900px, or any
 * fractional scale) and no frame at the new size had been drawn yet. And
 * growing the window to fit a tall artboard changed what 100vh meant.
 *
 * Every step has a time limit (stages.ts), so a render that stalls says
 * where instead of hanging until the server gives up on it.
 */

interface Job {
  html: string;
  width: number;
  height: number;
  selector: string;
  scale: number;
  format: "png" | "jpeg" | "pdf";
  lint: boolean;
  lintScript: string;
  /** Holds animations at the requested time; evaluates to the motion summary. */
  prepareScript?: string;
  colorScheme?: "light" | "dark";
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

type SessionOp =
  | { op: "open"; html: string; width: number; height: number; colorScheme?: "light" | "dark" }
  | { op: "eval"; session: string; expression: string }
  | { op: "capture"; session: string; box: Box; scale: number }
  | { op: "show"; session: string; html: string; width: number; height: number }
  | { op: "close"; session: string };

export const renderToken = randomBytes(24).toString("hex");
let renderDir: string | null = null;

/**
 * Writes the page to disk and loads it: file URLs reach assets and fonts like
 * the canvas does. Resolves once the page's DOM is ready. `loaded` settles
 * when the whole page has, fonts and images included, which may be never.
 */
async function loadPage(win: BrowserWindow, html: string): Promise<{ loaded: Promise<void> }> {
  renderDir ??= await mkdtemp(join(tmpdir(), "ponzu-render-"));
  const file = join(renderDir, `${randomBytes(6).toString("hex")}.html`);
  await writeFile(file, html);
  const ready = new Promise<void>((resolve) => win.webContents.once("dom-ready", () => resolve()));
  const loaded = win.loadFile(file).finally(() => void rm(file, { force: true }));
  loaded.catch(() => {});
  await Promise.race([ready, loaded]);
  return { loaded };
}

const FRAMES = "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))";
const ASSETS = `document.fonts.ready.then(() => ${IMAGES_READY_SCRIPT})`;

/**
 * Loads the page, then waits a while for its fonts and images. Ones that
 * haven't arrived by then don't stop the render: it goes on with fallbacks,
 * and lint names what's missing. Resolves with whether everything arrived.
 */
async function loadWithAssets(
  win: BrowserWindow,
  html: string,
  colorScheme?: "light" | "dark",
): Promise<boolean> {
  const { loaded } = await withBudget("load", loadPage(win, html));
  if (colorScheme) await withBudget("load", emulateScheme(win, colorScheme));
  const assets = loaded.catch(() => {}).then(() => win.webContents.executeJavaScript(ASSETS));
  const all = await within(assets, STAGE_BUDGET_MS.assets);
  // Give up on what's still coming: the page then finishes loading, fonts
  // fall back, and it draws frames again (it draws none while loading).
  if (!all) win.webContents.stop();
  await withBudget("load", win.webContents.executeJavaScript(FRAMES));
  return all;
}

/**
 * Answers prefers-color-scheme with `scheme` rather than the Mac's appearance.
 * After the page has navigated: attaching before that takes the window down.
 */
async function emulateScheme(win: BrowserWindow, scheme: "light" | "dark") {
  const cdp = win.webContents.debugger;
  if (!cdp.isAttached()) cdp.attach("1.3");
  await cdp.sendCommand("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: scheme }],
  });
}

/** Runs `expression` in the page within `stage`'s time limit. */
function run<T = unknown>(win: BrowserWindow, stage: RenderStage, expression: string): Promise<T> {
  return withBudget(stage, win.webContents.executeJavaScript(expression) as Promise<T>);
}

/**
 * A couple of renders at a time. Each one is a window with its own page, and
 * a backlog of home screen previews shouldn't starve an agent's screenshot of
 * memory and GPU. A job that waits too long for its turn says the host is busy.
 */
const MAX_JOBS = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function turn<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_JOBS) {
    let ready!: () => void;
    const mine = new Promise<void>((r) => {
      ready = r;
    });
    waiting.push(ready);
    try {
      await withBudget("queue", mine);
    } catch (err) {
      // Gave up waiting: take ourselves out of line, unless our turn came just now.
      const i = waiting.indexOf(ready);
      if (i >= 0) waiting.splice(i, 1);
      else next();
      throw err;
    }
  } else running++;
  try {
    return await work();
  } finally {
    next();
  }
}

/** Hands a finished job's slot to the next in line. */
function next() {
  const go = waiting.shift();
  if (go) go();
  else running--;
}

/** The window is the viewport, so it stays the artboard's own size and 100vh means what it says. */
function renderWindow(width: number, height: number) {
  const win = new BrowserWindow({
    show: false,
    width: Math.max(1, Math.ceil(width)),
    height: Math.max(1, Math.ceil(height)),
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: {
      offscreen: true,
      javascript: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  // Seeking an animation waits for two frames, so frames have to come quickly.
  win.webContents.setFrameRate(60);
  return win;
}

/** An image of `box` (CSS px, from the top of the page) at `scale` device px per CSS px. */
async function capture(
  win: BrowserWindow,
  box: Box,
  scale: number,
  format: "png" | "jpeg" = "png",
): Promise<Buffer> {
  const cdp = win.webContents.debugger;
  // After the page loads: attaching to a window that hasn't navigated yet takes it down.
  if (!cdp.isAttached()) cdp.attach("1.3");
  // PNGs are transparent where the design is, like the Chromium renderer's; JPEGs get white.
  await cdp.sendCommand(
    "Emulation.setDefaultBackgroundColorOverride",
    format === "png" ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {},
  );
  const shot = (await cdp.sendCommand("Page.captureScreenshot", {
    format,
    ...(format === "jpeg" ? { quality: 85 } : {}),
    clip: {
      x: box.x,
      y: box.y,
      width: Math.max(box.width, 1 / scale),
      height: Math.max(box.height, 1 / scale),
      scale,
    },
    // Renders the clip even where it's below the window.
    captureBeyondViewport: true,
  })) as { data: string };
  return Buffer.from(shot.data, "base64");
}

async function renderJob(job: Job) {
  const win = renderWindow(job.width, job.height);
  try {
    const loaded = await loadWithAssets(win, job.html, job.colorScheme);
    const assetsTimedOut = loaded ? undefined : true;
    const motion = job.prepareScript
      ? await run<{ error?: string }>(win, "prepare", job.prepareScript)
      : undefined;
    if (motion?.error) return { motion };
    const box = await run<(Box & { contentHeight: number }) | null>(
      win,
      "prepare",
      `(() => { const el = document.querySelector(${JSON.stringify(job.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, contentHeight: document.querySelector('[data-artboard]')?.scrollHeight ?? 0 }; })()`,
    );
    if (!box) throw new Error("That node isn't in this artboard.");
    const issues = job.lint ? await run(win, "lint", job.lintScript) : [];
    const size = { width: box.width, height: box.height, contentHeight: box.contentHeight };
    try {
      if (job.format === "pdf") {
        const pdf = await withBudget(
          "capture",
          win.webContents.printToPDF({
            printBackground: true,
            pageSize: { width: box.width / 96, height: box.height / 96 },
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
          }),
        );
        return {
          data: pdf.toString("base64"),
          mime: "application/pdf",
          ...size,
          issues,
          motion,
          assetsTimedOut,
        };
      }
      const format = job.format === "jpeg" ? "jpeg" : "png";
      const scale = captureScale(box.width, box.height, job.scale);
      const image = await withBudget("capture", capture(win, box, scale, format));
      return {
        data: image.toString("base64"),
        mime: `image/${format}`,
        ...size,
        scale,
        issues,
        motion,
        assetsTimedOut,
      };
    } catch (err) {
      // With lint, send it back and what went wrong rather than nothing. Without, there's nothing to send.
      const message = err instanceof Error ? err.message : String(err);
      if (!job.lint) throw new RenderError(message, "capture_failed", "capture");
      return { data: "", mime: "", ...size, issues, motion, assetsTimedOut, captureError: message };
    }
  } finally {
    win.destroy();
  }
}

/* Recording steps through an animation on one live page, so it keeps a window per session. */

interface Session {
  win: BrowserWindow;
  timer: NodeJS.Timeout;
}

const sessions = new Map<string, Session>();

/** Abandoned sessions close themselves. */
function keepAlive(id: string) {
  const s = sessions.get(id);
  if (!s) throw new Error(`No render session ${id}.`);
  clearTimeout(s.timer);
  s.timer = setTimeout(() => closeSession(id), 60_000);
  return s;
}

function closeSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(id);
  s.win.destroy();
}

async function sessionOp(op: SessionOp) {
  switch (op.op) {
    case "open":
      return turn(async () => {
        const id = randomBytes(8).toString("hex");
        const win = renderWindow(op.width, op.height);
        sessions.set(id, { win, timer: setTimeout(() => closeSession(id), 60_000) });
        let loaded: boolean;
        try {
          loaded = await loadWithAssets(win, op.html, op.colorScheme);
        } catch (err) {
          closeSession(id);
          throw err;
        }
        return { session: id, ...(loaded ? {} : { assetsTimedOut: true }) };
      });
    case "eval":
      // Recording's evals seek and wait for frames; lint and settling are the slowest of them.
      return { value: await run(keepAlive(op.session).win, "prepare", op.expression) };
    // Captures and pages take the same turns as renders: they're what costs
    // memory and GPU. A session doesn't hold a turn between them, so a long
    // recording can't keep previews and screenshots out.
    case "capture":
      return turn(async () => {
        const s = keepAlive(op.session);
        const { box } = op;
        const scale = captureScale(box.width, box.height, op.scale);
        return {
          data: (await withBudget("capture", capture(s.win, box, scale))).toString("base64"),
        };
      });
    case "show":
      return turn(() => showSheet(op));
    case "close":
      closeSession(op.session);
      return {};
  }
}

/** The contact sheet: a new page at its own size. */
async function showSheet(op: Extract<SessionOp, { op: "show" }>) {
  const s = keepAlive(op.session);
  s.win.setContentSize(Math.max(1, Math.ceil(op.width)), Math.max(1, Math.ceil(op.height)));
  const { loaded } = await withBudget("load", loadPage(s.win, op.html));
  const images = loaded
    .catch(() => {})
    .then(() => s.win.webContents.executeJavaScript(IMAGES_READY_SCRIPT));
  if (!(await within(images, STAGE_BUDGET_MS.assets))) s.win.webContents.stop();
  await withBudget("load", s.win.webContents.executeJavaScript(FRAMES));
  return {};
}

/** Serves render jobs on a free local port. Resolves with the endpoint to hand the server. */
export function startRenderHost(): Promise<string> {
  return new Promise((resolve) => {
    const http = createServer(async (req, res) => {
      if (req.method !== "POST" || req.headers.authorization !== `Bearer ${renderToken}`) {
        res.writeHead(403).end();
        return;
      }
      try {
        const payload = JSON.parse(await body(req));
        const out =
          req.url === "/session" ? await sessionOp(payload) : await turn(() => renderJob(payload));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      } catch (err) {
        // Which step failed and why, so the agent hears more than "it failed".
        const error = err instanceof Error ? err.message : String(err);
        const known = err instanceof RenderError;
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            error,
            failure: known ? err.failure : "render_error",
            stage: known ? err.stage : undefined,
          }),
        );
      }
    });
    http.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(http.address() as AddressInfo).port}/render`),
    );
  });
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
