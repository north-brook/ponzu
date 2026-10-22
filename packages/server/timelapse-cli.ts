/**
 * Render a timelapse of a .design headlessly, the way the MCP tool does:
 * serves the built studio and the design, drives /film in Chrome, encodes in
 * the page with WebCodecs and writes the film.
 *
 *   bun packages/server/timelapse-cli.ts path/to/file.design [--shape 16:9|1:1|9:16]
 *     [--length 15|30|60] [--theme light|dark] [--out film.mp4] [--all]
 *
 * --all films the whole journal rather than the last session. Needs
 * `bun run --filter @ponzu/studio build` first.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { FilmShape } from "@ponzu/core";
import { lastSession, parseJournal } from "@ponzu/core";
import { ChromiumRenderer } from "@ponzu/render/chromium";
import { LocalWorkspace, readJournal, serve } from "@ponzu/server";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    shape: { type: "string" },
    length: { type: "string" },
    theme: { type: "string" },
    out: { type: "string" },
    all: { type: "boolean" },
    port: { type: "string" },
  },
});
const file = positionals[0];
if (!file) throw new Error("Pass a .design folder.");

const here = dirname(new URL(import.meta.url).pathname);
const renderer = new ChromiumRenderer();
const ws = new LocalWorkspace({ renderer, previews: false });
const { key } = await ws.open(resolve(file));
const server = serve(ws, {
  port: Number(values.port ?? 0),
  studioDir: join(here, "../../apps/studio/dist"),
  spotlight: false,
  dbFile: ":memory:",
});
const entries = await readJournal(key);
const range = values.all
  ? (() => {
      const ops = entries.filter((e) => e.kind === "op");
      return ops.length ? { from: ops[0]!.t, to: ops[ops.length - 1]!.t } : undefined;
    })()
  : (lastSession(entries) ?? undefined);
void parseJournal;
const started = Date.now();
let last = 0;
const job = ws.timelapses.start(key, {
  shape: (values.shape ?? "16:9") as FilmShape,
  length: Number(values.length ?? 30),
  theme: values.theme === "dark" ? "dark" : "light",
  range,
});
ws.timelapses.onChange((j) => {
  if (j.id !== job.id || j.state.status !== "rendering") return;
  const pct = Math.floor(j.state.done * 100);
  if (pct >= last + 10) {
    last = pct;
    console.log(`${pct}%${j.state.left ? `, about ${j.state.left}s left` : ""}`);
  }
});
const state = await job.promise;
if (state.status !== "done") {
  console.error(state);
  process.exit(1);
}
let path = state.path;
if (values.out) {
  await mkdir(dirname(resolve(values.out)), { recursive: true });
  await copyFile(state.path, resolve(values.out));
  path = resolve(values.out);
}
console.log(
  `Wrote ${path} (${state.codec}, ${state.duration.toFixed(1)}s, ${Math.round(state.bytes / 1024)} KB) in ${((Date.now() - started) / 1000).toFixed(0)}s`,
);
server.stop(true);
await ws.closeAll();
process.exit(0);
