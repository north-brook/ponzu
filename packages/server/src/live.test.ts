import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Doc } from "@ponzu/core";
import { getTool, runTool, type ToolCaller } from "@ponzu/tools";
// The canvas's own client, as the studio runs it: what it shows is what the person sees.
import { SocketSource } from "../../react/src/connection.ts";
import { LocalWorkspace, serve } from "./index.ts";

/*
 * Every open canvas shows what the server has: here and on the person's other Macs, through a
 * burst of agent changes, and over a link too slow to keep up with them.
 */

const caller: ToolCaller = {
  id: "agent_live",
  author: { kind: "agent", name: "Claude" },
  client: "claude",
};

let dir: string;
let before: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-live-"));
  before = process.env.PONZU_TAILSCALE;
  // A Tailscale that lists one other Mac, "spare", at 127.0.0.1: a second server here.
  const bin = join(dir, "tailscale");
  await writeFile(
    bin,
    `#!/bin/sh
echo '{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.0.1"],"UserID":7},"Peer":{"a":{"HostName":"spare","TailscaleIPs":["127.0.0.1"],"UserID":7,"OS":"macOS","Online":true}}}'
`,
  );
  await chmod(bin, 0o755);
  process.env.PONZU_TAILSCALE = bin;
});

afterAll(async () => {
  if (before === undefined) delete process.env.PONZU_TAILSCALE;
  else process.env.PONZU_TAILSCALE = before;
  await rm(dir, { recursive: true, force: true });
});

/**
 * A TCP pipe to `port` that can stall: while it's held, nothing reaches the reader, as on a
 * network that stops for a moment. What was sent waits, then comes through when it's let go.
 */
async function link(port: number) {
  const ups = new Set<Socket>();
  const server = createServer((client) => {
    const up = netConnect(port, "127.0.0.1");
    ups.add(up);
    client.pipe(up);
    up.pipe(client);
    client.on("error", () => up.destroy());
    up.on("error", () => client.destroy());
    client.on("close", () => {
      up.destroy();
      ups.delete(up);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as { port: number }).port,
    hold: () => ups.forEach((u) => u.pause()),
    release: () => ups.forEach((u) => u.resume()),
    close: () => server.close(),
  };
}

/** Two Macs: "spare" has the design and the agent; this one shows it through /peers/spare. */
async function macs(name: string, opts: { backpressureLimit?: number } = {}) {
  const spareDir = join(dir, name, "spare");
  const spareWs = new LocalWorkspace({ cwd: spareDir });
  const spare = serve(spareWs, { port: 0, backpressureLimit: opts.backpressureLimit });
  // Between the Macs: the tailnet, which can stall.
  const net = await link(spare.port!);
  const here = serve(new LocalWorkspace({ cwd: join(dir, name, "here") }), {
    port: 0,
    tailnet: true,
    tailnetPort: net.port,
  });
  await runTool(getTool("create_file")!, { path: `${name}.design` }, { ws: spareWs, caller });
  const key = join(spareDir, `${name}.design`);
  const design = spareWs.get(key)!;
  // A watch the system only just started can miss the first changes: wait until it hears one.
  const probe = join(key, "notes", "probe.md");
  await mkdir(dirname(probe), { recursive: true });
  for (let i = 0; !design.doc.notes.probe; i++) {
    if (i > 100) throw new Error("the design never noticed a file change");
    await writeFile(probe, `${i}\n`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const sources: SocketSource[] = [];
  const canvas = (origin: string) => {
    const s = new SocketSource(origin, key);
    sources.push(s);
    return s;
  };
  return {
    spareWs,
    net,
    key,
    design,
    /** A canvas on the same Mac as the design. */
    local: () => canvas(`http://127.0.0.1:${spare.port}`),
    /** A canvas on this Mac, showing the design on spare. */
    remote: () => canvas(`http://127.0.0.1:${here.port}/peers/spare`),
    tool: async (name: string, args: Record<string, unknown>) =>
      (await runTool(getTool(name)!, { file: key, ...args }, { ws: spareWs, caller })).text,
    async close() {
      for (const s of sources) s.close();
      here.stop(true);
      net.close();
      await spareWs.closeAll();
      spare.stop(true);
    },
  };
}

/** What a canvas shows of a page: each board and what's in it. */
function shown(doc: Doc | null, pageId: string) {
  return doc?.pages
    .find((p) => p.id === pageId)
    ?.artboards.map((a) => ({ id: a.id, children: a.root.children }));
}

async function until(pred: () => boolean, ms: number, what: () => string) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`never happened: ${what()}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const ready = (s: SocketSource) =>
  until(
    () => s.getState().status === "ready",
    3000,
    () => `${s.file} connected`,
  );

test("new artboards an agent fills on disk right away reach every open canvas", async () => {
  const m = await macs("burst");
  try {
    const local = m.local();
    const remote = m.remote();
    await Promise.all([ready(local), ready(remote)]);

    const pg = /page (pg_\w+)/.exec(await m.tool("create_page", { name: "Screens" }))![1]!;
    const made = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        m.tool("create_artboard", {
          page: pg,
          name: `Screen ${i + 1}`,
          width: 390,
          height: 844,
          html: "<span>…</span>",
        }),
      ),
    );
    // Each one's file, written the moment the call returns, at the path it gave.
    await Promise.all(
      made.map(async (text, i) => {
        const id = /artboard (ab_\w+)/.exec(text)![1]!;
        const file = / · file (\S+)\./.exec(text)![1]!;
        const path = join(m.key, file);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
          path,
          `<section data-artboard data-id="${id}" data-name="Screen ${i + 1}" data-x="${i * 430}" data-y="0" style="width: 390px; height: 844px">\n<h1>Step ${i + 1}</h1>\n<p>Generated from a script.</p>\n</section>\n`,
        );
      }),
    );

    const filled = () =>
      (shown(m.design.doc, pg) ?? []).filter((a) => JSON.stringify(a.children).includes("Step"))
        .length;
    // Ponzu's own save of the empty boards never lands over the agent's files.
    await until(
      () => filled() === 6,
      5000,
      () => `server shows ${filled()} of 6 boards filled`,
    );
    const want = JSON.stringify(shown(m.design.doc, pg));
    for (const s of [local, remote])
      await until(
        () => JSON.stringify(shown(s.getState().doc, pg)) === want,
        5000,
        () => `${s === local ? "local" : "remote"} canvas shows the page`,
      );
  } finally {
    await m.close();
  }
}, 20_000);

test("a canvas on another Mac that falls behind a burst of changes catches up on its own", async () => {
  // A small buffer, so a stall on the link overflows it as a burst of big boards does a real one.
  const m = await macs("stall", { backpressureLimit: 64 * 1024 });
  const resyncs: unknown[] = [];
  m.spareWs.telemetry = {
    capture: (event: string, props?: Record<string, unknown>) => {
      if (event === "canvas resynced") resyncs.push(props);
    },
  } as never;
  try {
    const remote = m.remote();
    await ready(remote);
    const pg = /page (pg_\w+)/.exec(await m.tool("create_page", { name: "Tables" }))![1]!;
    const files: { id: string; path: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const text = await m.tool("create_artboard", { page: pg, name: `Table ${i + 1}` });
      files.push({
        id: /artboard (ab_\w+)/.exec(text)![1]!,
        path: join(m.key, / · file (\S+)\./.exec(text)![1]!),
      });
    }
    await until(
      () => shown(remote.getState().doc, pg)?.length === 4,
      5000,
      () => "remote canvas has the empty boards",
    );

    // The link stalls while the agent rewrites the files, a few times over: more than the
    // network holds while it waits, so some of it is dropped.
    m.net.hold();
    for (let round = 0; round < 3; round++) {
      for (const [i, f] of files.entries()) {
        const rows = Array.from(
          { length: 4000 },
          (_, r) => `<tr><td>Round ${round} row ${r}</td><td>${r * (i + 2)}</td></tr>`,
        ).join("\n");
        await writeFile(
          f.path,
          `<section data-artboard data-id="${f.id}" data-name="Table ${i + 1}" style="width: 800px; height: fit-content">\n<table>${rows}</table>\n</section>\n`,
        );
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    await until(
      () =>
        (shown(m.design.doc, pg) ?? []).every((a) =>
          JSON.stringify(a.children).includes("Round 2 row 3999"),
        ),
      5000,
      () => "server read every file",
    );
    m.net.release();

    const want = JSON.stringify(shown(m.design.doc, pg));
    await until(
      () => JSON.stringify(shown(remote.getState().doc, pg)) === want,
      10_000,
      () => `remote canvas caught up (resyncs: ${JSON.stringify(resyncs)})`,
    );
    // Some of it was dropped on the way and the canvas got the whole doc, not every op.
    expect(resyncs).toContainEqual(expect.objectContaining({ reason: "backpressure" }));
  } finally {
    m.spareWs.telemetry = undefined;
    await m.close();
  }
}, 30_000);
