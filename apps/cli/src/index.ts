#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { emptyDoc, newId } from "@ponzu/core";
import { serveStdio } from "@ponzu/mcp";
import { RemoteRenderer, type Renderer } from "@ponzu/render";
import { findDesigns, LocalWorkspace, serve } from "@ponzu/server";
import { Design } from "@ponzu/store";
import { FsAdapter } from "@ponzu/store/fs";
import { installAgent } from "./install.ts";

const VERSION = "0.1.0";
const here = dirname(fileURLToPath(import.meta.url));

const HELP = `Ponzu ${VERSION}: a design canvas your coding agent drives with HTML and CSS.

Usage
  ponzu serve [files.design…]   Open the canvas in your browser and serve MCP at /mcp
  ponzu mcp [files.design…]     MCP over stdio, for agents that launch their own servers
  ponzu init [name.design]      Create a new .design folder
  ponzu install <agent>         Add Ponzu to claude, codex or cursor

Options
  -p, --port <n>       Port for serve (default 7777)
  -H, --host <addr>    Address to bind (default 127.0.0.1). Use 0.0.0.0 or your
                       tailnet IP to reach the canvas from other machines.
      --no-open        Don't open a browser
  -h, --help
  -v, --version

With no files, serve and mcp open every .design under the current folder.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string", short: "H" },
      "no-open": { type: "boolean" },
      open: { type: "boolean" },
      dev: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      url: { type: "string" },
      studio: { type: "string" },
    },
  });
  const [cmd = "serve", ...files] = positionals;
  if (values.version) return console.log(VERSION);
  if (values.help || cmd === "help") return console.log(HELP);

  switch (cmd) {
    case "serve":
      return runServe(files, {
        port: Number(values.port ?? 7777),
        host: values.host ?? "127.0.0.1",
        open: !values["no-open"] && !values.dev,
        dev: Boolean(values.dev),
        studio: values.studio,
      });
    case "mcp":
      return runMcp(files);
    case "init":
      return runInit(files[0]);
    case "install":
      return installAgent(files[0], {
        url: values.url ?? `http://127.0.0.1:${values.port ?? 7777}/mcp`,
      });
    default:
      if (cmd.endsWith(".design"))
        return runServe([cmd, ...files], {
          port: Number(values.port ?? 7777),
          host: values.host ?? "127.0.0.1",
          open: !values["no-open"],
          dev: false,
        });
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

/** The desktop app hands us its offscreen renderer; otherwise use a local Chrome. */
async function pickRenderer(): Promise<Renderer | undefined> {
  const endpoint = process.env.PONZU_RENDER_ENDPOINT;
  if (endpoint) return new RemoteRenderer(endpoint, process.env.PONZU_RENDER_TOKEN);
  try {
    // Kept as a runtime specifier so the desktop build doesn't bundle Playwright.
    const mod = "@ponzu/render/chromium";
    const { ChromiumRenderer, findChromium } = (await import(
      mod
    )) as typeof import("@ponzu/render/chromium");
    const chromium = findChromium();
    return chromium ? new ChromiumRenderer({ executablePath: chromium }) : undefined;
  } catch {
    return undefined;
  }
}

async function openWorkspace(files: string[], log: (s: string) => void) {
  const renderer = await pickRenderer();
  const ws = new LocalWorkspace({ renderer });
  const paths = files.length ? files.map((f) => resolve(f)) : await findDesigns(process.cwd());
  for (const p of paths) {
    if (!existsSync(join(p, "design.json")) && existsSync(p) === false && files.length) {
      log(`Creating ${p}`);
    }
    await ws.open(p);
  }
  if (!renderer)
    log("No Chrome or Chromium found: screenshots are off. Install Chrome or set PONZU_CHROMIUM.");
  return ws;
}

async function runServe(
  files: string[],
  o: { port: number; host: string; open: boolean; dev: boolean; studio?: string },
) {
  const ws = await openWorkspace(files, (s) => console.log(s));
  const studioDir = o.studio ?? findStudio();
  const server = serve(ws, { port: o.port, hostname: o.host, studioDir, root: process.cwd() });
  const local = `http://${o.host === "0.0.0.0" ? "localhost" : o.host}:${server.port}`;
  // The desktop app reads this line to find the server.
  if (process.env.PONZU_DESKTOP)
    console.log(`PONZU_READY ${JSON.stringify({ url: local, mcp: `${local}/mcp` })}`);
  const lines = [``, `  Ponzu ${VERSION}`, ``, `  Canvas   ${local}`];
  if (o.host === "0.0.0.0")
    for (const ip of lanAddresses()) lines.push(`           http://${ip}:${server.port}`);
  lines.push(`  MCP      ${local}/mcp`);
  const open = ws.designs();
  lines.push(
    `  Files    ${open.length ? open.map((d) => d.key.replace(process.cwd() + "/", "")).join(", ") : "none yet (ponzu init, or ask your agent to create_file)"}`,
  );
  lines.push(``, `  Connect an agent:  ponzu install claude  (or codex, cursor)`, ``);
  console.log(lines.join("\n"));
  if (o.dev) console.log("  Dev mode: run the studio with `bun run --filter @ponzu/studio dev`\n");
  if (o.open) {
    const first = open[0];
    const url = first ? `${local}/?file=${encodeURIComponent(first.key)}` : local;
    openBrowser(url);
  }
  const stop = async () => {
    await ws.closeAll();
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function runMcp(files: string[]) {
  // stdout belongs to the protocol; log to stderr.
  const ws = await openWorkspace(files, (s) => console.error(s));
  await serveStdio(ws);
  const stop = async () => {
    await ws.closeAll();
    process.exit(0);
  };
  process.stdin.on("close", stop);
  process.on("SIGINT", stop);
}

async function runInit(target = "design/untitled.design") {
  const path = resolve(target.endsWith(".design") ? target : `${target}.design`);
  if (existsSync(join(path, "design.json"))) {
    console.error(`${path} already exists.`);
    process.exit(1);
  }
  const name = path
    .split("/")
    .pop()!
    .replace(/\.design$/, "");
  const doc = emptyDoc(name);
  doc.pages.push({ id: newId("pg"), name: "Home", artboards: [] });
  doc.tokens = `:root {\n  --color-ground: #ffffff;\n  --color-ink: #0e0e0e;\n  --color-muted: #6b6b6b;\n  --font-sans: "Inter", system-ui, sans-serif;\n}\n`;
  const design = await Design.create(new FsAdapter(path), doc);
  await design.close();
  console.log(`Created ${path}\n\nNext: ponzu serve ${target}`);
}

function findStudio(): string | undefined {
  const candidates = [
    join(here, "../studio"),
    join(here, "../../studio/dist"),
    join(here, "../../../apps/studio/dist"),
  ];
  return candidates.find((c) => existsSync(join(c, "index.html")));
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {}
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
