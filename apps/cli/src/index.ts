#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { emptyDoc, newId } from "@ponzu/core";
import { serveBridge } from "@ponzu/mcp/bridge";
import { RemoteRenderer, type Renderer } from "@ponzu/render";
import {
  findDesigns,
  LocalWorkspace,
  openFromGitHub,
  remoteUpdater,
  serve,
  spawnGit,
} from "@ponzu/server";
import { Design } from "@ponzu/store";
import { FsAdapter } from "@ponzu/store/fs";
import pkg from "../package.json" with { type: "json" };
import { announceHost, findHost, ponzuHome } from "./host.ts";
import { agentStatus, installAgent } from "./install.ts";
import { firstFree, serveDefaults, sourceCheckout } from "./source.ts";
import { phoneTelemetry, startTelemetry, telemetryCommand, telemetryNotice } from "./telemetry.ts";
import { wakeCommand } from "./wake.ts";

const VERSION = pkg.version;
const here = dirname(fileURLToPath(import.meta.url));

const HELP = `Ponzu ${VERSION}: the open source canvas your agent draws on in HTML and CSS.

Usage
  ponzu serve [files.design…]   Open the canvas in your browser and serve MCP at /mcp
  ponzu open <owner/repo/x.design>
                                Clone a design from GitHub into ~/Ponzu and serve it.
                                Also takes a ponzu.design/gh or github.com link
  ponzu mcp [files.design…]     MCP over stdio: what agents launch. Joins the running
                                Ponzu, starts the desktop app in the background, or
                                runs on its own
  ponzu init [name.design]      Create a new .design folder
  ponzu install [agent]         Add Ponzu to claude, codex and cursor (all found by default)
  ponzu telemetry [on|off]      Show or change usage reporting
  ponzu wake [install|uninstall]
                                The helper that lets the iPhone app start Ponzu on this
                                Mac. The app installs it; uninstall removes it

Options
  -p, --port <n>       Port for serve (default 7777; from a checkout, one in
                       7800-7999 for that checkout)
  -H, --host <addr>    Address to bind (default 127.0.0.1). Use 0.0.0.0 or your
                       tailnet IP to reach the canvas from other machines.
      --no-open        Don't open a browser
      --tailnet        From a checkout: answer the owner's iPhone and other Macs
                       on the tailnet, as the installed app does
      --url <url>      With install: register this MCP URL instead of the command
  -h, --help
  -v, --version

With no files, serve and mcp open every .design under the current folder.

Ponzu sends pseudonymous usage (tool names, errors, versions; never your designs)
to help us improve it. Turn it off with \`ponzu telemetry off\` or PONZU_TELEMETRY=0.
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
      auto: { type: "boolean" },
      tailnet: { type: "boolean" },
    },
  });
  const [cmd = "serve", ...files] = positionals;
  if (values.version) return console.log(VERSION);
  if (values.help || cmd === "help") return console.log(HELP);
  const listen = serveDefaults(values, sourceCheckout());

  switch (cmd) {
    case "serve":
      return runServe(files, {
        ...listen,
        host: values.host ?? "127.0.0.1",
        open: !values["no-open"] && !values.dev,
        dev: Boolean(values.dev),
        studio: values.studio,
      });
    case "open": {
      const { path, clone } = await openFromGitHub(files[0], spawnGit());
      console.log(`Opening ${path.slice(clone.length + 1) || "every design"} in ${clone}`);
      process.chdir(clone);
      return runServe(path === clone ? [] : [path], {
        ...listen,
        host: values.host ?? "127.0.0.1",
        open: !values["no-open"],
        dev: false,
        studio: values.studio,
      });
    }
    case "mcp":
      return runMcp(files);
    case "init":
      return runInit(files[0]);
    case "install":
      return installAgent(files[0], { url: values.url, auto: values.auto });
    case "telemetry":
      return telemetryCommand(files[0]);
    case "wake":
      return wakeCommand(files[0]);
    default:
      if (cmd.endsWith(".design"))
        return runServe([cmd, ...files], {
          ...listen,
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
    // #chromium is @ponzu/render/chromium here, and the bundle beside the CLI on npm.
    const mod = "#chromium";
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
  const [renderer, telemetry] = await Promise.all([
    pickRenderer(),
    startTelemetry({ version: VERSION, command: "serve" }),
  ]);
  const ws = new LocalWorkspace({ renderer, telemetry: telemetry ?? undefined });
  const paths = files.length ? files.map((f) => resolve(f)) : await findDesigns(process.cwd());
  // Files named on the command line were chosen; the ones found under the folder weren't.
  const named: string[] = [];
  for (const p of paths) {
    if (!existsSync(join(p, "design.json")) && existsSync(p) === false && files.length) {
      log(`Creating ${p}`);
    }
    const { key } = await ws.open(p);
    if (files.length) named.push(key);
  }
  if (!renderer)
    log("No Chrome or Chromium found: screenshots are off. Install Chrome or set PONZU_CHROMIUM.");
  telemetry?.capture("host started", {
    launched_by: process.env.PONZU_LAUNCHED_BY ?? "person",
    designs: ws.designs().length,
    renderer: Boolean(renderer),
  });
  return { ws, telemetry, named };
}

async function runServe(
  files: string[],
  o: {
    ports: number[];
    tailnet: boolean;
    host: string;
    open: boolean;
    dev: boolean;
    studio?: string;
  },
) {
  const { ws, telemetry, named } = await openWorkspace(files, (s) => console.log(s));
  const studioDir = o.studio ?? findStudio();
  const server = serve(ws, {
    port: firstFree(o.ports, o.host),
    hostname: o.host,
    studioDir,
    root: process.cwd(),
    // The owner's other Macs list this one's designs, and it lists theirs, whenever
    // Tailscale runs. PONZU_TAILSCALE=none turns that off. Off from a checkout (see
    // serveDefaults): the tailnet port and the iPhone's Bonjour advert are the app's.
    tailnet: o.tailnet,
    tailnetPort: 7777,
    dbFile: join(ponzuHome(), "ponzu.db"),
    stateFile: join(ponzuHome(), "catalog.json"),
    // PONZU_SPOTLIGHT=0 lists only designs under the current folder, as a fresh Mac would.
    spotlight: process.env.PONZU_SPOTLIGHT === "0" ? false : undefined,
    agents: async () => agents(),
    opened: named,
    version: VERSION,
    telemetry: phoneTelemetry(),
    // The Mac app's updater, which the catalog lists and the title bar's Update drives.
    ...(process.env.PONZU_APP_ENDPOINT && process.env.PONZU_APP_TOKEN
      ? { updater: remoteUpdater(process.env.PONZU_APP_ENDPOINT, process.env.PONZU_APP_TOKEN) }
      : {}),
  });
  const local = `http://${o.host === "0.0.0.0" ? "localhost" : o.host}:${server.port}`;
  // Links agents hand the person open the Mac app, or this canvas.
  ws.opensIn = process.env.PONZU_DESKTOP ? "app" : { origin: local };
  const unannounce = await announceHost(local, { takeOver: Boolean(process.env.PONZU_DESKTOP) });
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
  // The desktop app reads stdout for PONZU_READY and nothing else.
  const notice = process.env.PONZU_DESKTOP ? null : await telemetryNotice();
  if (notice) lines.push(`  ${notice}`, ``);
  console.log(lines.join("\n"));
  if (o.dev) console.log("  Dev mode: run the studio with `bun run --filter @ponzu/studio dev`\n");
  if (o.open) {
    const first = open[0];
    const url = first ? `${local}/?file=${encodeURIComponent(first.key)}` : local;
    openBrowser(url);
  }
  const stop = async () => {
    await unannounce();
    await ws.closeAll();
    server.stop();
    await telemetry?.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/** Agent status reads a few config files; the home screen asks every few seconds. */
let agentCache: { at: number; list: ReturnType<typeof agentStatus> } | null = null;
function agents() {
  if (!agentCache || Date.now() - agentCache.at > 5_000)
    agentCache = { at: Date.now(), list: agentStatus() };
  return agentCache.list;
}

/**
 * What agents launch. Tool calls go to the machine's Ponzu (the desktop app,
 * started in the background if it's installed and not running, or a `ponzu
 * serve`), so the agent shares the canvas. With neither, it runs them here.
 */
async function runMcp(files: string[]) {
  const cwd = process.cwd();
  const designs = async () =>
    files.length ? files.map((f) => resolve(f)) : await findDesigns(cwd);
  // Tool calls that reach a host are counted there; this counts the ones run here.
  const telemetry = await startTelemetry({ version: VERSION, command: "mcp" });
  const ws = new LocalWorkspace({ cwd, telemetry: telemetry ?? undefined });
  let opened: Promise<void> | null = null;
  const openLocal = () =>
    (opened ??= (async () => {
      ws.renderer = await pickRenderer();
      for (const p of await designs()) await ws.open(p);
      telemetry?.capture("host started", {
        launched_by: "agent",
        designs: ws.designs().length,
        renderer: Boolean(ws.renderer),
      });
    })().catch((err) => {
      opened = null;
      throw err;
    }));
  const bridge = await serveBridge({
    version: VERSION,
    local: ws,
    findHost,
    // The host runs from elsewhere: open this project's files there for the agent, and send
    // it absolute paths. Opened by an agent, an example design stays off the home screen.
    onHost: async (mcp) => {
      const base = mcp.replace(/\/mcp$/, "");
      for (const path of await designs())
        await fetch(`${base}/api/files`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, by: "agent" }),
        });
    },
    prepareLocal: openLocal,
    mapArgs: (_tool, args) => absolutePaths(args, cwd),
    cwd,
  });
  // stdout belongs to the protocol; log to stderr.
  const stop = async () => {
    await bridge.close().catch(() => {});
    await ws.closeAll();
    await telemetry?.shutdown();
    process.exit(0);
  };
  process.stdin.on("close", stop);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/** Resolve relative `path` and `file` arguments (a file can also be a name) against `cwd`. */
function absolutePaths(args: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const out = { ...args };
  for (const key of ["path", "file"]) {
    const v = out[key];
    if (typeof v !== "string" || isAbsolute(v)) continue;
    if (key === "path" || v.endsWith(".design") || v.includes("/")) out[key] = resolve(cwd, v);
  }
  return out;
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
