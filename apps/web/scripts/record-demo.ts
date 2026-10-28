/**
 * Records the product demo as the videos phones and tablets play instead of the live demo
 * (components/demo/demo-video.tsx): every story the demo defines (`STORIES` in
 * components/demo/script.ts), in light and dark.
 *
 *   bun run record-demo              # in apps/web: every story; or name some: … record-demo seekle
 *
 * It builds the site and serves it to record from; DEMO_BASE=http://localhost:4321 records from one
 * already running instead (`bun run dev` works, slower).
 * Rerun it after anything the demo shows changes. It uploads each video and poster to Vercel Blob
 * under a name made from its content, so a re-record never replaces what an older deploy plays,
 * and rewrites components/demo/videos.json to point at them: commit that. Uploading needs
 * BLOB_READ_WRITE_TOKEN (the `ponzu-site` store, on the `ponzu` Vercel project), so only
 * maintainers re-record: `vercel env pull` in a directory linked to the project fetches it.
 * Everyone else builds and runs the site as usual, from the public URLs the manifest holds.
 * `--local` skips the upload and leaves the files in .context/demo-videos to look at;
 * `--seconds=5` with it records only the start, to check the framing quickly.
 *
 * The demo runs on a clock, so it's recorded frame by frame rather than in real time: the page's
 * clock is faked and held (Date, performance.now, timers and requestAnimationFrame), the document's
 * animation timeline is frozen, and each frame moves both on by exactly 1/30 s before capturing.
 * Every frame is what the demo shows at that moment, however long it takes to capture.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findChromium } from "@ponzu/render/chromium";
import { head, put } from "@vercel/blob";
import { type Browser, chromium } from "playwright-core";
import type { DemoRecording } from "../components/demo/demo-video";
import { STORIES } from "../components/demo/script";

const APP = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = new URL("../components/demo/videos.json", import.meta.url);
const LOCAL = new URL("../../../.context/demo-videos/", import.meta.url);
const FPS = 30;
/**
 * The demo's width in CSS px as it's recorded, at 2×: 900 px square, sharp on a phone, a few MB for
 * the whole story. It's the narrow layout, as phones show it.
 */
const WIDTH = 450;
const SCALE = 2;
const SCHEMES = ["light", "dark"] as const;
type Scheme = (typeof SCHEMES)[number];

const args = process.argv.slice(2);
const local = args.includes("--local");
const named = args.filter((a) => !a.startsWith("--"));
const seconds = Number(args.find((a) => a.startsWith("--seconds="))?.split("=")[1] ?? Infinity);
if (seconds !== Infinity && !local)
  throw new Error("--seconds only records a check: pass --local too.");
const stories = named.length ? STORIES.filter((s) => named.includes(s.id)) : [...STORIES];
if (named.length && stories.length !== named.length)
  throw new Error(`Unknown story. The demo has: ${STORIES.map((s) => s.id).join(", ")}`);
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!local && !token)
  throw new Error("Set BLOB_READ_WRITE_TOKEN to upload, or pass --local to keep the files here.");

/** Runs in the page: every animation, the artboards' shadow roots included. */
const ANIMATIONS = `(() => {
  const all = new Set(document.getAnimations());
  for (const host of document.querySelectorAll("[data-artboard-host]"))
    for (const a of host.shadowRoot?.getAnimations() ?? []) all.add(a);
  return [...all];
})()`;

/** Runs in the page: moves every running animation on by `ms`, as a frozen timeline won't. */
const step = (ms: number) => `(() => {
  for (const a of ${ANIMATIONS})
    if (a.playState === "running" && typeof a.currentTime === "number")
      a.currentTime += ${ms} * a.playbackRate;
})()`;

/** Runs in the page: resolves once every image in the demo has decoded and the fonts are in. */
const IMAGES = `(() => {
  const frame = document.querySelector(".dm-frame");
  const hosts = [...frame.querySelectorAll("[data-artboard-host]")].map((h) => h.shadowRoot);
  const images = [frame, ...hosts].flatMap((r) => (r ? [...r.querySelectorAll("img")] : []));
  const loading = images.filter((i) => !i.complete);
  return Promise.all(loading.map((i) => i.decode().catch(() => {}))).then(() => document.fonts.ready).then(() => {});
})()`;

/**
 * Runs in the page: lets React render what the clock just changed. Its scheduler works in message
 * tasks, which the fake clock doesn't hold, so a few of our own go after them.
 */
const SETTLE = `new Promise((resolve) => {
  const c = new MessageChannel();
  let n = 0;
  c.port1.onmessage = () => (++n >= 8 ? resolve() : c.port2.postMessage(0));
  c.port2.postMessage(0);
})`;

async function record(browser: Browser, story: (typeof STORIES)[number], scheme: Scheme) {
  const context = await browser.newContext({
    viewport: { width: WIDTH + 72, height: 1000 },
    deviceScaleFactor: SCALE,
    colorScheme: scheme,
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  // Hold the design until the clock is held too, so the story starts at a known moment.
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/demo/seekle.json", async (route) => {
    await held;
    await route.continue();
  });
  await page.clock.install();
  await page.goto(`${BASE}/?demo=record&story=${story.id}`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const frame = page.locator(".dm-frame");
  await frame.waitFor();
  // Fit the frame to exactly WIDTH, whatever the page's padding.
  const width = await frame.evaluate((el) => el.clientWidth);
  if (width !== WIDTH)
    await page.setViewportSize({ width: WIDTH + 72 + (WIDTH - width), height: 1000 });
  await page.waitForFunction((w) => document.querySelector(".dm-frame")?.clientWidth === w, WIDTH);
  await page.evaluate(() => document.querySelector("nextjs-portal")?.remove());
  // All of it on screen, so it plays and can be captured whole.
  await frame.evaluate((el) => el.scrollIntoView({ block: "center" }));

  const cdp = await context.newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  const loaded = page.waitForResponse("**/demo/seekle.json");
  release();
  await loaded;
  // The design's in, and the story starts at this moment on the held clock.
  await page.waitForTimeout(500);
  await page.evaluate(SETTLE);

  // Where it sits on the page, which is what a capture's clip is measured from.
  const clip = await frame.evaluate((el, scale) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale };
  }, SCALE);
  const capture = async (quality: number) => {
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality,
      clip,
      optimizeForSpeed: false,
    });
    return Buffer.from(data, "base64");
  };

  mkdirSync(LOCAL, { recursive: true });
  const name = `${story.id}-${scheme}`;
  const out = fileURLToPath(new URL(`${name}.mp4`, LOCAL));
  const ffmpeg = spawn(
    "ffmpeg",
    [
      ...["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-"],
      ...["-c:v", "libx264", "-preset", "slow", "-crf", "30", "-pix_fmt", "yuv420p"],
      ...["-profile:v", "high", "-level", "4.0", "-movflags", "+faststart", "-an", out],
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const done = new Promise<void>((resolve, reject) => {
    ffmpeg.on("error", reject);
    ffmpeg.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
  });

  const frames = Math.round((Math.min(story.ms, seconds * 1000) / 1000) * FPS);
  let at = 0;
  let last = Buffer.alloc(0);
  for (let i = 0; i < frames; i++) {
    if (i > 0) {
      const next = Math.round((i * 1000) / FPS);
      const ms = next - at;
      at = next;
      await page.evaluate(step(ms));
      await page.clock.runFor(ms);
      await page.evaluate(SETTLE);
    }
    // An image that never decodes shouldn't stall the recording.
    await Promise.race([page.evaluate(IMAGES), new Promise((r) => setTimeout(r, 2000))]);
    last = await capture(92);
    if (!ffmpeg.stdin.write(last)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
    if (i % (FPS * 5) === 0)
      console.log(`${name}: ${Math.round(at / 1000)}s of ${Math.round(story.ms / 1000)}s`);
  }
  ffmpeg.stdin.end();
  await done;
  // The poster is the last frame: the story finished, as reduced motion shows it.
  const poster = await capture(80);
  writeFileSync(fileURLToPath(new URL(`${name}.jpg`, LOCAL)), poster);
  await context.close();
  return { name, video: readFileSync(out), poster, ms: story.ms };
}

/** Uploads `body` under a name made from its content, unless it's there already. */
async function upload(name: string, ext: string, body: Buffer, contentType: string) {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  const pathname = `demo/${name}-${hash}.${ext}`;
  try {
    return (await head(pathname, { token })).url;
  } catch {
    const blob = await put(pathname, body, {
      access: "public",
      addRandomSuffix: false,
      contentType,
      cacheControlMaxAge: 60 * 60 * 24 * 365,
      token,
    });
    return blob.url;
  }
}

/** The site to record from: DEMO_BASE, or a production build of this checkout, served. */
async function serve(): Promise<{ base: string; stop: () => void }> {
  const given = process.env.DEMO_BASE;
  if (given) return { base: given, stop: () => {} };
  const build = spawn("bun", ["run", "build"], { cwd: APP, stdio: "inherit" });
  const built = await new Promise<number | null>((r) => build.on("exit", r));
  if (built !== 0) throw new Error("The site didn't build.");
  const port = 4399;
  const next = fileURLToPath(import.meta.resolve("next/dist/bin/next"));
  const server = spawn("node", [next, "start", "--port", String(port)], {
    cwd: APP,
    stdio: "ignore",
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; ; i++) {
    if (
      await fetch(base).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    if (i > 100) throw new Error(`The site didn't start on ${base}.`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return { base, stop: () => server.kill() };
}

const site = await serve();
const BASE = site.base;
const executablePath = findChromium();
if (!executablePath) throw new Error("No Chromium-based browser found. Set PONZU_CHROMIUM.");
const browser = await chromium.launch({ executablePath });
const manifest: Record<string, Partial<Record<Scheme, DemoRecording>>> = JSON.parse(
  readFileSync(MANIFEST, "utf8"),
);
try {
  for (const story of stories) {
    // Light and dark side by side: each is its own page on its own held clock.
    const recordings = await Promise.all(SCHEMES.map((s) => record(browser, story, s)));
    for (const [i, r] of recordings.entries()) {
      const scheme = SCHEMES[i]!;
      const size = WIDTH * SCALE;
      const entry: DemoRecording = {
        src: local ? "" : await upload(r.name, "mp4", r.video, "video/mp4"),
        poster: local ? "" : await upload(r.name, "jpg", r.poster, "image/jpeg"),
        width: size,
        height: size,
        ms: Math.round(r.ms),
        bytes: r.video.length,
      };
      console.log(
        `${r.name}: ${(r.video.length / 1e6).toFixed(1)} MB, poster ${Math.round(r.poster.length / 1e3)} kB`,
      );
      if (!local) manifest[story.id] = { ...manifest[story.id], [scheme]: entry };
    }
  }
} finally {
  await browser.close();
  site.stop();
}
if (!local) {
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("Wrote components/demo/videos.json");
}
