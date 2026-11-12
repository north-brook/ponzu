#!/usr/bin/env bun
/**
 * The runner on this machine against the fake API over HTTP, with real Claude Code:
 *
 *   ANTHROPIC_API_KEY=… bun scripts/dev.ts            the source
 *   ANTHROPIC_API_KEY=… bun scripts/dev.ts --bundle   dist/runner.js, after `bun run build`
 *
 * Each line typed is a message from Ada. `/stop` stops the turn, `/answer <words>` answers the
 * open question, `/quit` stops the runner. The thread prints as the runner writes it. The model
 * is PONZU_DEV_MODEL, Haiku by default; the canvas starts empty in a fresh folder.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { emptyDoc } from "@ponzu/core";
import { FakeRunnerApi } from "../src/api/fake.ts";
import { fakeApiHandler } from "../src/api/fake-http.ts";

const CANVAS = "cnv_dev";
const TOKEN = "pzr_dev";
/** The bearer of the runner's port, which every call to it carries. */
const PORT_TOKEN = "port_dev";
const RUNNER_PORT = Number(process.env.PONZU_RUNNER_PORT ?? 4600);

const fake = new FakeRunnerApi({
  doc: emptyDoc("Untitled"),
  session: {
    canvas: { id: CANVAS, name: "Untitled" },
    model: process.env.PONZU_DEV_MODEL ?? "haiku",
  },
});
const api = Bun.serve({
  port: Number(process.env.PONZU_DEV_API_PORT ?? 8790),
  hostname: "127.0.0.1",
  fetch: fakeApiHandler(fake, { canvasId: CANVAS, token: TOKEN }),
});

const root = mkdtempSync(join(tmpdir(), "ponzu-dev-"));
const claude = spawnSync("which", ["claude"], { encoding: "utf8" }).stdout.trim();
const entry = process.argv.includes("--bundle") ? "dist/runner.js" : "src/main.ts";
const runner = spawn(process.execPath, [join(import.meta.dir, "..", entry)], {
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    PONZU_API_URL: `http://127.0.0.1:${api.port}`,
    PONZU_CANVAS_ID: CANVAS,
    PONZU_RUNNER_TOKEN: TOKEN,
    PONZU_PORT_TOKEN: PORT_TOKEN,
    PONZU_RUNNER_PORT: String(RUNNER_PORT),
    PONZU_WORK_ROOT: join(root, "work"),
    PONZU_STATE_DIR: join(root, "state"),
    ...(claude && !process.env.PONZU_CLAUDE ? { PONZU_CLAUDE: claude } : {}),
  },
});
runner.on("exit", (code) => {
  console.log(`runner exited (${code})`);
  api.stop(true);
  process.exit(code ?? 0);
});
console.log(`fake API on ${api.port}, runner on ${RUNNER_PORT}, files in ${root}`);

const poke = () =>
  fetch(`http://127.0.0.1:${RUNNER_PORT}/poke`, {
    method: "POST",
    headers: { authorization: `Bearer ${PORT_TOKEN}` },
  }).catch(() => {});

// The thread, as it changes.
const shown = new Map<string, string>();
setInterval(() => {
  for (const item of fake.items()) {
    const line = `${item.kind}${item.streaming ? "…" : ""} ${JSON.stringify(item.payload)}`;
    if (shown.get(item.id) === line) continue;
    shown.set(item.id, line);
    if (!item.streaming || item.kind !== "assistant") console.log(`  ${line}`);
  }
}, 250);

for await (const line of createInterface({ input: process.stdin })) {
  const text = line.trim();
  if (!text) continue;
  if (text === "/quit") {
    runner.kill("SIGTERM");
    break;
  }
  if (text === "/stop") {
    fake.push({ kind: "stop", payload: {} });
  } else if (text.startsWith("/answer ")) {
    const open = [...fake.questions.values()].find((q) => q.status === "open");
    if (!open) {
      console.log("no question is open");
      continue;
    }
    const words = text.slice("/answer ".length);
    fake.answer(
      open.kind === "question"
        ? {
            questionId: open.id,
            answers: Object.fromEntries(open.payload.questions.map((q) => [q.question, words])),
          }
        : { questionId: open.id, approved: /^(y|yes|ok)\b/i.test(words), note: words },
    );
  } else {
    fake.push({ kind: "message", payload: { text } });
  }
  await poke();
}
