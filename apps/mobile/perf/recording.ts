/*
 * Frame pacing from a screen recording of the canvas on a real iPhone: where the picture moved,
 * frames it held while moving, the longest hitch, moves per second, and how evenly it stepped.
 * The phone's screen recorder (Control Center) captures at 60 fps; record the same gesture on the
 * same page before and after a change, and compare.
 *
 *   bun apps/mobile/perf/recording.ts <video> [--crop top,right,bottom,left] [--size 256]
 *     [--json] [--csv <file>] [--shots <dir>]
 *
 * ffmpeg decodes it: each frame cropped to the canvas (the status bar and floating chrome left
 * out; `--crop` is fractions of the frame, 0.13,0,0.11,0.05 by default, the app's bar, the
 * comment button and the iPhone Duo's side tab), squeezed to `size`×`size` gray. Each frame
 * against the one before: how different it is, and how far its content moved (phase
 * correlation), in the recording's px. `motion.ts` has the definitions. `--shots` saves the
 * frames around the worst hitches, to look at.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { round } from "./metrics.ts";
import {
  DEFAULTS,
  type FrameStep,
  hitches,
  meanDiff,
  motions,
  overall,
  shiftBetween,
  spectrum,
} from "./motion.ts";

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
const crop = (opt("crop") ?? "0.13,0,0.11,0.05").split(",").map(Number);
const size = Number(opt("size") ?? 256);
const json = flag("json");
const csv = opt("csv");
const shots = opt("shots");
const [video] = argv;
if (
  !video ||
  crop.length !== 4 ||
  crop.some((c) => !(c >= 0 && c < 1)) ||
  // A power of two, at least 8.
  !(Number.isInteger(size) && size >= 8 && !(size & (size - 1)))
) {
  console.error(
    "usage: bun apps/mobile/perf/recording.ts <video> [--crop top,right,bottom,left] [--size 256] [--json] [--csv <file>] [--shots <dir>]",
  );
  process.exit(2);
}
const file = resolve(video);

async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).arrayBuffer(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${err.slice(-2000)}`);
  return { out: new Uint8Array(out), err };
}

const info = JSON.parse(
  new TextDecoder().decode(
    (
      await run([
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,avg_frame_rate,codec_name",
        "-of",
        "json",
        file,
      ])
    ).out,
  ),
).streams[0] as { width: number; height: number; avg_frame_rate: string; codec_name: string };

const [top, right, bottom, left] = crop as [number, number, number, number];
const cw = Math.round(info.width * (1 - left - right));
const ch = Math.round(info.height * (1 - top - bottom));
// Every decoded frame once, in order, with its time (showinfo's `pts_time`): no frame dropped or
// repeated to make a constant rate, since repeats are what's measured.
const { out: raw, err } = await run([
  "ffmpeg",
  "-hide_banner",
  "-nostdin",
  "-i",
  file,
  "-map",
  "0:v:0",
  "-an",
  "-fps_mode",
  "passthrough",
  "-vf",
  `crop=${cw}:${ch}:${Math.round(info.width * left)}:${Math.round(info.height * top)},scale=${size}:${size}:flags=area,format=gray,showinfo`,
  "-f",
  "rawvideo",
  "-pix_fmt",
  "gray",
  "-",
]);
const times = [...err.matchAll(/\bpts_time:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]) * 1000);
const n = Math.floor(raw.length / (size * size));
if (n !== times.length) throw new Error(`decoded ${n} frames but ${times.length} times`);

// The recording's px per downscaled px, on each axis.
const kx = cw / size;
const ky = ch / size;
const steps: FrameStep[] = [];
let prev: { gray: Uint8Array; spec: ReturnType<typeof spectrum> } | null = null;
for (let i = 0; i < n; i++) {
  const gray = raw.subarray(i * size * size, (i + 1) * size * size);
  const spec = spectrum(gray, size);
  if (!prev) steps.push({ t: times[i]! - times[0]!, diff: 0, dx: 0, dy: 0, peak: 0 });
  else {
    const s = shiftBetween(prev.spec, spec);
    steps.push({
      t: times[i]! - times[0]!,
      diff: meanDiff(prev.gray, gray),
      dx: s.dx * kx,
      dy: s.dy * ky,
      peak: s.peak,
    });
  }
  prev = { gray, spec };
}

const ms = motions(steps);
const worst = hitches(steps, ms);
const all = overall(steps, ms);

if (csv)
  await Bun.write(
    csv,
    "t_ms,diff,dx,dy,peak\n" +
      steps
        .map((s) => [s.t, s.diff, s.dx, s.dy, s.peak].map((v) => round(v, 3)).join(","))
        .join("\n") +
      "\n",
  );

if (shots) {
  // For each of the worst three: the last frame before it, the first held frame, and the frame it ended on.
  mkdirSync(shots, { recursive: true });
  for (const [k, h] of worst.slice(0, 3).entries()) {
    // `at` and `ms` are rounded to 0.1 ms: compare with a tolerance far below a frame.
    const frame = steps.findIndex((s) => s.t >= h.at - 0.5);
    const end = steps.findIndex((s) => s.t >= h.at + h.ms - 0.5);
    const pick = [frame, frame + 1, end].map((i) => `eq(n\\,${i})`).join("+");
    await run([
      "ffmpeg",
      "-v",
      "error",
      "-nostdin",
      "-i",
      file,
      "-vf",
      `select='${pick}',scale=480:-2,tile=3x1`,
      "-fps_mode",
      "passthrough",
      "-frames:v",
      "1",
      "-y",
      join(shots, `hitch-${k + 1}-${(h.at / 1000).toFixed(2)}s.png`),
    ]);
  }
}

if (json) {
  const opts = { ...DEFAULTS, crop, size };
  console.log(
    JSON.stringify({ video: file, info, opts, overall: all, motions: ms, hitches: worst }, null, 2),
  );
  process.exit(0);
}

const sec = (t: number) => (t / 1000).toFixed(2);
const pxs = (v: number) => (Number.isNaN(v) ? "?" : String(v));
const j = all.jitter;
// How many waits of each length: one held frame, two, more.
const waits = new Map<number, number>();
for (const h of worst) waits.set(h.held, (waits.get(h.held) ?? 0) + 1);
const byLength = [...waits.entries()].sort((a, b) => a[0] - b[0]);
console.log(
  `${video}: ${info.width}×${info.height} ${info.codec_name}, ${all.frames} frames at ${all.videoFps} fps`,
);
console.log(
  `moving ${sec(all.movingMs)} s in ${all.motions} motions: ${all.moved} frames moved, ${all.held} held (${all.heldPct}%); ${all.movesPerS} moves/s, longest wait ${all.maxGapMs} ms`,
);
console.log(
  `waits: ${byLength.map(([held, k]) => `${k} of ${held} frame${held > 1 ? "s" : ""}`).join(", ") || "none"}`,
);
console.log(
  `steps off a smooth curve by ${j.median}% (median), ${j.p95}% (p95); ${j.uneven}% of ${j.n} steps by more than a quarter`,
);
console.log("");
console.log(
  "| from s | to s | moved | held | moves/s | longest wait ms | peak px/s | px | off-curve median / p95 % | uneven % |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const m of ms)
  console.log(
    `| ${sec(m.start)} | ${sec(m.end)} | ${m.moved} | ${m.held} | ${m.movesPerS} | ${m.maxGapMs} | ${m.peakSpeed} | ${m.distance} | ${m.jitter.n ? `${m.jitter.median} / ${m.jitter.p95}` : "–"} | ${m.jitter.n ? m.jitter.uneven : "–"} |`,
  );
if (worst.length) {
  console.log("");
  console.log("Longest waits (from the last change before each):");
  for (const h of worst.slice(0, 8))
    console.log(
      `  ${sec(h.at)} s  ${h.ms} ms (${h.held} held)  ${pxs(h.before)} px/s into it, ${pxs(h.after)} out`,
    );
}
