import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installWake,
  peerKind,
  sockaddrIp,
  uninstallWake,
  type WakeDeps,
  wake,
  wakePlist,
  wakePlistPath,
  wakeResponse,
} from "./wake.ts";

let dir: string;
const env: Record<string, string | undefined> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-wake-"));
  for (const k of ["PONZU_LAUNCH_AGENTS", "PONZU_HOME", "PONZU_APP"]) env[k] = process.env[k];
  // Never the real ~/Library/LaunchAgents or ~/.ponzu.
  process.env.PONZU_LAUNCH_AGENTS = join(dir, "LaunchAgents");
  process.env.PONZU_HOME = join(dir, "home");
});

afterAll(async () => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

const APP = "/Applications/Ponzu.app/Contents/Resources/server/ponzu";

test("the LaunchAgent runs `ponzu wake` per connection on port 7778", () => {
  const plist = wakePlist(APP);
  expect(plist).toContain("<string>design.ponzu.app.wake</string>");
  expect(plist).toContain(`<string>${APP}</string>\n    <string>wake</string>`);
  expect(plist).toMatch(/<key>inetdCompatibility<\/key>\s*<dict>\s*<key>Wait<\/key>\s*<false\/>/);
  expect(plist).toMatch(/<key>SockServiceName<\/key>\s*<string>7778<\/string>/);
  // Every interface: launchd binds once, and the tailnet address can come and go.
  expect(plist).not.toContain("SockNodeName");
  // A path with XML in it stays one string.
  expect(wakePlist("/Users/a&b/Ponzu.app/x")).toContain(
    "<string>/Users/a&amp;b/Ponzu.app/x</string>",
  );
});

test.skipIf(process.platform !== "darwin")("macOS reads the plist as valid", async () => {
  const path = join(dir, "lint.plist");
  await writeFile(path, wakePlist(APP));
  expect(spawnSync("/usr/bin/plutil", ["-lint", path]).status).toBe(0);
});

test("installing writes the plist and loads it, and does nothing more when it's current", async () => {
  const calls: string[][] = [];
  let loaded = false;
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "bootout") loaded = false;
    return args[0] === "print" ? loaded : true;
  };
  expect(await installWake(APP, run)).toBe(true);
  expect(await readFile(wakePlistPath(), "utf8")).toBe(wakePlist(APP));
  expect(calls.map((c) => c[0])).toEqual(["bootout", "bootstrap"]);

  calls.length = 0;
  expect(await installWake(APP, run)).toBe(false);
  expect(calls.map((c) => c[0])).toEqual(["print"]);

  // The app moved: the plist follows it.
  calls.length = 0;
  const moved = "/Users/me/Applications/Ponzu.app/Contents/Resources/server/ponzu";
  expect(await installWake(moved, run)).toBe(true);
  expect(await readFile(wakePlistPath(), "utf8")).toContain(moved);
  expect(calls.map((c) => c[0])).toEqual(["bootout", "bootstrap"]);

  // Unloaded behind its back (launchctl bootout): loaded again.
  loaded = false;
  expect(await installWake(moved, run)).toBe(true);

  await uninstallWake(run);
  expect(loaded).toBe(false);
  expect(await Bun.file(wakePlistPath()).exists()).toBe(false);
});

function deps(o: { running?: boolean; app?: string | null; trusted?: boolean } = {}) {
  const started: string[] = [];
  const d: WakeDeps = {
    running: async () => (o.running ? "http://127.0.0.1:7777/mcp" : null),
    app: () => (o.app === undefined ? "/Applications/Ponzu.app" : o.app),
    start: async (app) => {
      started.push(app);
    },
    trusted: async () => o.trusted ?? true,
  };
  return { d, started };
}

test("a knock while Ponzu runs leaves it be", async () => {
  const { d, started } = deps({ running: true });
  expect(await wake({ kind: "tailnet", ip: "100.64.0.2" }, d)).toBe("running");
  expect(started).toEqual([]);
});

test("a knock from the owner's phone starts Ponzu in the background", async () => {
  const { d, started } = deps();
  expect(await wake({ kind: "tailnet", ip: "100.64.0.2" }, d)).toBe("waking");
  expect(started).toEqual(["/Applications/Ponzu.app"]);
});

test("someone else's device, or the LAN, can't start Ponzu", async () => {
  const stranger = deps({ trusted: false });
  expect(await wake({ kind: "tailnet", ip: "100.64.0.9" }, stranger.d)).toBe("refused");
  const lan = deps();
  expect(await wake(peerKind("192.168.1.20"), lan.d)).toBe("refused");
  expect(await wake(peerKind("unknown"), lan.d)).toBe("refused");
  expect([...stranger.started, ...lan.started]).toEqual([]);
});

test("without the app there's nothing to start", async () => {
  const { d } = deps({ app: null });
  expect(await wake({ kind: "local" }, d)).toBe("not installed");
});

test("who knocked, from the socket's address", () => {
  expect(peerKind(null)).toEqual({ kind: "local" });
  expect(peerKind("127.0.0.1")).toEqual({ kind: "local" });
  expect(peerKind("::ffff:100.64.0.2")).toEqual({ kind: "tailnet", ip: "100.64.0.2" });
  expect(peerKind("fd7a:115c:a1e0:0:0:0:3e3b:f468")).toEqual({
    kind: "tailnet",
    ip: "fd7a:115c:a1e0:0:0:0:3e3b:f468",
  });
  expect(peerKind("10.0.0.4")).toEqual({ kind: "other" });

  const v4 = new Uint8Array(16);
  v4.set([16, 2, 0x1e, 0x62, 100, 64, 0, 2]);
  expect(sockaddrIp(v4)).toBe("100.64.0.2");
  const v6 = new Uint8Array(28);
  v6.set([28, 30]);
  v6.set([0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0, 0, 0, 0, 0, 0, 0x3e, 0x3b, 0xf4, 0x68], 8);
  expect(sockaddrIp(v6)).toBe("fd7a:115c:a1e0:0:0:0:3e3b:f468");
  const mapped = new Uint8Array(28);
  mapped.set([28, 30]);
  mapped.set([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 100, 64, 0, 2], 8);
  expect(sockaddrIp(mapped)).toBe("100.64.0.2");
});

test("the answer is a complete HTTP response the phone can read", () => {
  expect(wakeResponse("waking")).toBe(
    'HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{"ponzu":"waking"}',
  );
  expect(wakeResponse("refused")).toStartWith("HTTP/1.1 403 Forbidden\r\n");
  expect(wakeResponse("refused")).toEndWith("Content-Length: 0\r\nConnection: close\r\n\r\n");
});

/** `ponzu wake` itself, run by hand: this Mac asking, with a fake host file. */
async function runWakeCli(): Promise<{ out: string; launched: boolean }> {
  const marker = join(dir, "launched");
  await rm(marker, { force: true });
  // A stand-in for the app: `--background` leaves a mark instead of starting anything.
  const app = join(dir, "fake-ponzu");
  await writeFile(app, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  // Async: a fake running Ponzu in this process has to answer it.
  const child = Bun.spawn(["bun", join(import.meta.dir, "index.ts"), "wake"], {
    env: { ...process.env, PONZU_APP: app, PONZU_TELEMETRY: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(child.stdout).text();
  await child.exited;
  await Bun.sleep(200);
  return { out, launched: await Bun.file(marker).exists() };
}

test("`ponzu wake` starts Ponzu when the host file is stale", async () => {
  await Bun.write(
    join(process.env.PONZU_HOME!, "host.json"),
    JSON.stringify({ url: "http://127.0.0.1:1", mcp: "http://127.0.0.1:1/mcp", pid: 1 }),
  );
  const { out, launched } = await runWakeCli();
  expect(out).toStartWith("HTTP/1.1 202 Accepted");
  expect(launched).toBe(true);
});

test("`ponzu wake` doesn't start a second Ponzu when one answers", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ mcp: "x" }),
  });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    await Bun.write(
      join(process.env.PONZU_HOME!, "host.json"),
      JSON.stringify({ url, mcp: `${url}/mcp`, pid: 1 }),
    );
    const { out, launched } = await runWakeCli();
    expect(out).toStartWith("HTTP/1.1 200 OK");
    expect(launched).toBe(false);
  } finally {
    server.stop(true);
  }
});
