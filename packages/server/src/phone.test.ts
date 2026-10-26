import { expect, setSystemTime, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { idleFor, isPage, isPhone, LocalWorkspace, peerAllowed, serve } from "./index.ts";
import { isTailnetAddress } from "./tailnet.ts";

const PHONE = "Ponzu-iOS/1.0.0 (iPhone; iOS 26.1)";
const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

test("another Ponzu server, sending no Origin, is not a page", () => {
  expect(isPage(req("http://100.64.0.1:7777/api/catalog"))).toBe(false);
});

test("a browser page is a page, whatever it claims to be", () => {
  const url = "http://100.64.0.1:7777/api/catalog";
  expect(isPage(req(url, { origin: "https://evil.example" }))).toBe(true);
  expect(isPage(req(url, { "sec-fetch-site": "cross-site" }))).toBe(true);
  // A page can set its User-Agent in some runtimes, but never its Origin or Sec-Fetch-Site.
  expect(isPage(req(url, { "user-agent": PHONE, origin: "https://evil.example" }))).toBe(true);
  expect(isPage(req(url, { "user-agent": PHONE, "sec-fetch-site": "cross-site" }))).toBe(true);
});

test("the phone's own WebSocket Origin gets through", () => {
  // iOS sends the URL it dials as the Origin; the app sends its own scheme where it can.
  const url = "http://studio.tail1.ts.net:7777/ws?file=x";
  expect(isPage(req(url, { "user-agent": PHONE, origin: "http://studio.tail1.ts.net:7777" }))).toBe(
    false,
  );
  expect(isPage(req(url, { "user-agent": PHONE, origin: "ponzu-app://ios" }))).toBe(false);
  expect(isPage(req(url, { "user-agent": PHONE, origin: "http://other.tail1.ts.net:7777" }))).toBe(
    true,
  );
});

test("the phone reaches what the home screen and a canvas need, and nothing else", () => {
  const ok = (path: string, method = "GET") =>
    peerAllowed(
      new Request(`http://m:7777${path}`, { method, headers: { "user-agent": PHONE } }),
      path,
    );
  expect(ok("/api/info")).toBe(true);
  expect(ok("/api/macs")).toBe(true);
  expect(ok("/api/catalog")).toBe(true);
  expect(ok("/api/activity")).toBe(true);
  expect(ok("/api/activity", "POST")).toBe(false);
  expect(ok("/ws")).toBe(true);
  expect(ok("/files/abc/assets/a.png")).toBe(true);
  expect(ok("/mcp", "POST")).toBe(false);
  expect(ok("/api/files", "POST")).toBe(false);
  // Another Mac asks this one to install its update; the phone can't tell from another Mac.
  expect(ok("/api/update/install", "POST")).toBe(true);
  expect(ok("/api/update", "POST")).toBe(false);
  expect(ok("/files/abc/upload", "POST")).toBe(false);
  expect(ok("/")).toBe(false);
});

test("the phone names itself in its User-Agent", () => {
  expect(isPhone(req("http://m/", { "user-agent": PHONE }))).toBe(true);
  expect(isPhone(req("http://m/", { "user-agent": "Bun/1.4.2" }))).toBe(false);
});

const MIN = 60_000;

test("a phone's request counts as use for two minutes; an open phone socket, for as long as it's open", () => {
  const now = 100 * MIN;
  // No phone yet: only agents count.
  expect(idleFor({ agentIdle: 20 * MIN, phoneAt: 0, phoneSockets: 0, now })).toBe(20 * MIN);
  // The phone just asked: not idle.
  expect(idleFor({ agentIdle: 20 * MIN, phoneAt: now, phoneSockets: 0, now })).toBe(0);
  // Ten minutes on, it's been idle for the eight since the phone's two ran out.
  expect(idleFor({ agentIdle: 20 * MIN, phoneAt: now - 10 * MIN, phoneSockets: 0, now })).toBe(
    8 * MIN,
  );
  // An agent's more recent call still wins.
  expect(idleFor({ agentIdle: 3 * MIN, phoneAt: now - 10 * MIN, phoneSockets: 0, now })).toBe(
    3 * MIN,
  );
  // A phone watching the catalog or a canvas keeps the Mac in use, however long ago it asked.
  expect(idleFor({ agentIdle: 20 * MIN, phoneAt: now - 60 * MIN, phoneSockets: 1, now })).toBe(0);
});

/** This machine's own tailnet address, when it has one: CI doesn't. */
const tailnetIp = Object.values(networkInterfaces())
  .flat()
  .find((a) => a?.family === "IPv4" && isTailnetAddress(a.address))?.address;

test.skipIf(!tailnetIp)("the phone keeps a windowless Ponzu from idle-quitting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-phone-"));
  // A Tailscale that says every address here is this Mac's owner's.
  const bin = join(dir, "tailscale");
  await writeFile(
    bin,
    `#!/bin/sh
case "$1" in
  status) echo '{"BackendState":"Running","Self":{"HostName":"studio","TailscaleIPs":["${tailnetIp}"],"UserID":7},"Peer":{}}' ;;
  whois) echo '{"Node":{"User":7}}' ;;
esac
`,
  );
  await chmod(bin, 0o755);
  const before = process.env.PONZU_TAILSCALE;
  process.env.PONZU_TAILSCALE = bin;
  const ws = new LocalWorkspace({ cwd: dir });
  // Bound to the tailnet address, so this test's own requests arrive as a tailnet device's.
  const server = serve(ws, { port: 0, hostname: tailnetIp, root: dir, spotlight: "roots" });
  const base = `http://${tailnetIp}:${server.port}`;
  const info = async (ua?: string) => {
    const res = await fetch(`${base}/api/info`, { headers: ua ? { "user-agent": ua } : {} });
    expect(res.status).toBe(200);
    return ((await res.json()) as { idle: number }).idle;
  };
  const start = Date.now();
  try {
    // Twenty minutes with no agent and no phone.
    setSystemTime(start + 20 * MIN);
    expect(await info()).toBeGreaterThanOrEqual(20 * 60);

    // The phone asks: in use now, and for two minutes more.
    expect(await info(PHONE)).toBe(0);
    setSystemTime(start + 21 * MIN);
    expect(await info()).toBe(0);
    setSystemTime(start + 30 * MIN);
    expect(await info()).toBeGreaterThanOrEqual(8 * 60 - 1);

    // A phone watching the catalog keeps it in use for as long as it watches.
    const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/catalog/stream`, {
      headers: { "user-agent": PHONE },
    } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      socket.onmessage = () => resolve();
      socket.onerror = () => reject(new Error("the phone's catalog stream didn't open"));
    });
    setSystemTime(start + 90 * MIN);
    expect(await info()).toBe(0);
    socket.close();
    await Bun.sleep(100);
    // Closed: in use for two minutes more, as after any request.
    expect(await info()).toBe(0);
    setSystemTime(start + 100 * MIN);
    expect(await info()).toBeGreaterThanOrEqual(8 * 60 - 1);

    // Pair iPhone… closes when a phone pairs: only the phone's ?pair moves pairedAt.
    const pairedAt = async (query: string, ua?: string) => {
      const res = await fetch(`${base}/api/info${query}`, {
        headers: ua ? { "user-agent": ua } : {},
      });
      return ((await res.json()) as { pairedAt: number | null }).pairedAt;
    };
    expect(await pairedAt("", PHONE)).toBeNull();
    expect(await pairedAt("?pair=1")).toBeNull();
    setSystemTime(start + 101 * MIN);
    expect(await pairedAt("?pair=1", PHONE)).toBe(start + 101 * MIN);
  } finally {
    setSystemTime();
    server.stop(true);
    await ws.closeAll();
    if (before === undefined) delete process.env.PONZU_TAILSCALE;
    else process.env.PONZU_TAILSCALE = before;
    await rm(dir, { recursive: true, force: true });
  }
});
