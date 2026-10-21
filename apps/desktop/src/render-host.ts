import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserWindow } from "electron";
// Shared with the server's own renderers. It imports nothing, so the bundle takes just this file.
import {
  captureLimit,
  captureScale,
  IMAGES_READY_SCRIPT,
  MAX_TEXTURE_SCRIPT,
} from "../../../packages/render/src/capture.ts";

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
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

type SessionOp =
  | { op: "open"; html: string; width: number; height: number }
  | { op: "eval"; session: string; expression: string }
  | { op: "capture"; session: string; box: Box; scale: number }
  | { op: "show"; session: string; html: string; width: number; height: number }
  | { op: "close"; session: string };

export const renderToken = randomBytes(24).toString("hex");
let renderDir: string | null = null;

/** Writes the page to disk and loads it: file URLs reach assets and fonts like the canvas does. */
async function loadPage(win: BrowserWindow, html: string) {
  renderDir ??= await mkdtemp(join(tmpdir(), "ponzu-render-"));
  const file = join(renderDir, `${randomBytes(6).toString("hex")}.html`);
  await writeFile(file, html);
  await win.loadFile(file);
  void rm(file, { force: true });
}

const FRAMES = "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))";
const LOADED = `document.fonts.ready.then(() => ${IMAGES_READY_SCRIPT}).then(() => ${FRAMES})`;

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

/** The longest capture this GPU draws in one piece, measured once. */
let limit: number | null = null;
async function maxCapture(win: BrowserWindow): Promise<number> {
  if (limit === null)
    limit = captureLimit(
      await win.webContents.executeJavaScript(MAX_TEXTURE_SCRIPT).catch(() => 0),
    );
  return limit;
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
    await loadPage(win, job.html);
    await win.webContents.executeJavaScript(LOADED);
    const motion = job.prepareScript
      ? await win.webContents.executeJavaScript(job.prepareScript)
      : undefined;
    if (motion?.error) return { motion };
    const box = (await win.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(job.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, contentHeight: document.querySelector('[data-artboard]')?.scrollHeight ?? 0 }; })()`,
    )) as (Box & { contentHeight: number }) | null;
    if (!box) throw new Error("That node isn't in this artboard.");
    const issues = job.lint ? await win.webContents.executeJavaScript(job.lintScript) : [];
    if (job.format === "pdf") {
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: { width: box.width / 96, height: box.height / 96 },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      return {
        data: pdf.toString("base64"),
        mime: "application/pdf",
        width: box.width,
        height: box.height,
        contentHeight: box.contentHeight,
        issues,
        motion,
      };
    }
    const format = job.format === "jpeg" ? "jpeg" : "png";
    const scale = captureScale(box.width, box.height, job.scale, await maxCapture(win));
    const image = await capture(win, box, scale, format);
    return {
      data: image.toString("base64"),
      mime: `image/${format}`,
      width: box.width,
      height: box.height,
      contentHeight: box.contentHeight,
      scale,
      issues,
      motion,
    };
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
    case "open": {
      const id = randomBytes(8).toString("hex");
      const win = renderWindow(op.width, op.height);
      sessions.set(id, { win, timer: setTimeout(() => closeSession(id), 60_000) });
      try {
        await loadPage(win, op.html);
        await win.webContents.executeJavaScript(LOADED);
      } catch (err) {
        closeSession(id);
        throw err;
      }
      return { session: id };
    }
    case "eval":
      return {
        value: await keepAlive(op.session).win.webContents.executeJavaScript(op.expression),
      };
    case "capture": {
      const s = keepAlive(op.session);
      const { box } = op;
      const scale = captureScale(box.width, box.height, op.scale, await maxCapture(s.win));
      return { data: (await capture(s.win, box, scale)).toString("base64") };
    }
    case "show": {
      // The contact sheet: a new page at its own size.
      const s = keepAlive(op.session);
      s.win.setContentSize(Math.max(1, Math.ceil(op.width)), Math.max(1, Math.ceil(op.height)));
      await loadPage(s.win, op.html);
      await s.win.webContents.executeJavaScript(`${IMAGES_READY_SCRIPT}.then(() => ${FRAMES})`);
      return {};
    }
    case "close":
      closeSession(op.session);
      return {};
  }
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
        const out = req.url === "/session" ? await sessionOp(payload) : await renderJob(payload);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(500).end(err instanceof Error ? err.message : String(err));
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
