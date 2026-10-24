import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspace, serve } from "./index.ts";
import { isTailnetAddress, readTailnet } from "./tailnet.ts";

test("only Tailscale's ranges count as tailnet addresses", () => {
  expect(isTailnetAddress("100.77.244.103")).toBe(true);
  expect(isTailnetAddress("::ffff:100.64.0.1")).toBe(true);
  expect(isTailnetAddress("100.127.255.255")).toBe(true);
  expect(isTailnetAddress("fd7a:115c:a1e0::3e3b:f468")).toBe(true);
  expect(isTailnetAddress("100.128.0.1")).toBe(false);
  expect(isTailnetAddress("100.63.0.1")).toBe(false);
  expect(isTailnetAddress("192.168.1.20")).toBe(false);
  expect(isTailnetAddress("127.0.0.1")).toBe(false);
  expect(isTailnetAddress("::1")).toBe(false);
});

test("runs the app bundle's Tailscale as the CLI, not the GUI", async () => {
  // Like the bundle's binary started outside a shell: without TAILSCALE_BE_CLI it tries
  // the GUI, prints that it couldn't, and still exits 0.
  const dir = await mkdtemp(join(tmpdir(), "ponzu-tailnet-"));
  const bin = join(dir, "Tailscale");
  await writeFile(
    bin,
    `#!/bin/sh
if [ "$TAILSCALE_BE_CLI" != "1" ]; then echo "The Tailscale GUI failed to start"; exit 0; fi
echo '{"BackendState":"Running","CurrentTailnet":{"MagicDNSEnabled":true},"Self":{"HostName":"Studio","DNSName":"studio.tail1.ts.net.","TailscaleIPs":["100.64.0.1"],"UserID":7},"Peer":{"a":{"HostName":"Air","DNSName":"air.tail1.ts.net.","TailscaleIPs":["100.64.0.2"],"UserID":7,"OS":"macOS","Online":true}}}'
`,
  );
  await chmod(bin, 0o755);
  const before = process.env.PONZU_TAILSCALE;
  process.env.PONZU_TAILSCALE = bin;
  try {
    expect(await readTailnet()).toEqual({
      ip: "100.64.0.1",
      user: "7",
      name: "studio",
      dns: "studio.tail1.ts.net",
      peers: [{ name: "air", ip: "100.64.0.2", online: true, dns: "air.tail1.ts.net" }],
    });
  } finally {
    if (before === undefined) delete process.env.PONZU_TAILSCALE;
    else process.env.PONZU_TAILSCALE = before;
    await rm(dir, { recursive: true, force: true });
  }
});

test("leaves out MagicDNS names when the tailnet doesn't serve them", async () => {
  // With MagicDNS off, Tailscale still reports a fully qualified DNSName that nothing resolves.
  const dir = await mkdtemp(join(tmpdir(), "ponzu-tailnet-"));
  const bin = join(dir, "tailscale");
  await writeFile(
    bin,
    `#!/bin/sh
echo '{"BackendState":"Running","CurrentTailnet":{"MagicDNSEnabled":false},"Self":{"HostName":"Studio","DNSName":"studio.tail1.ts.net.","TailscaleIPs":["100.64.0.1"],"UserID":7},"Peer":{"a":{"HostName":"Air","DNSName":"air.tail1.ts.net.","TailscaleIPs":["100.64.0.2"],"UserID":7,"OS":"macOS","Online":true}}}'
`,
  );
  await chmod(bin, 0o755);
  const before = process.env.PONZU_TAILSCALE;
  process.env.PONZU_TAILSCALE = bin;
  try {
    const net = await readTailnet();
    expect(net?.dns).toBeUndefined();
    expect(net?.peers[0]?.dns).toBeUndefined();
    expect(net?.name).toBe("studio");
  } finally {
    if (before === undefined) delete process.env.PONZU_TAILSCALE;
    else process.env.PONZU_TAILSCALE = before;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a server with the tailnet off never asks Tailscale or takes the tailnet port", async () => {
  // A Tailscale that puts this Mac's tailnet address on loopback, so binding it is safe here,
  // and notes each time it's asked. No MagicDNS, so no Bonjour advert either way.
  const dir = await mkdtemp(join(tmpdir(), "ponzu-tailnet-"));
  const bin = join(dir, "tailscale");
  const calls = join(dir, "calls");
  await writeFile(
    bin,
    `#!/bin/sh
echo "$1" >> '${calls}'
echo '{"BackendState":"Running","Self":{"HostName":"studio","TailscaleIPs":["127.0.0.1"],"UserID":7},"Peer":{}}'
`,
  );
  await chmod(bin, 0o755);
  const before = process.env.PONZU_TAILSCALE;
  process.env.PONZU_TAILSCALE = bin;
  const free = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const tailnetPort = free.port;
  free.stop(true);
  const answers = () =>
    fetch(`http://127.0.0.1:${tailnetPort}/api/info`).then(
      () => true,
      () => false,
    );
  const ws = new LocalWorkspace({ cwd: dir });
  try {
    const off = serve(ws, { port: 0, root: dir, spotlight: "roots", tailnet: false, tailnetPort });
    await Bun.sleep(300);
    expect(await answers()).toBe(false);
    expect(await Bun.file(calls).exists()).toBe(false);
    off.stop(true);

    // On, the same server takes it: the check above is the one that matters.
    const on = serve(ws, { port: 0, root: dir, spotlight: "roots", tailnet: true, tailnetPort });
    for (let i = 0; i < 40 && !(await answers()); i++) await Bun.sleep(50);
    expect(await answers()).toBe(true);
    on.stop(true);
  } finally {
    await ws.closeAll();
    if (before === undefined) delete process.env.PONZU_TAILSCALE;
    else process.env.PONZU_TAILSCALE = before;
    await rm(dir, { recursive: true, force: true });
  }
});
