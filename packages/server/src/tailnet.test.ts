import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
echo '{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.0.1"],"UserID":7},"Peer":{"a":{"HostName":"Air","TailscaleIPs":["100.64.0.2"],"UserID":7,"OS":"macOS","Online":true}}}'
`,
  );
  await chmod(bin, 0o755);
  const before = process.env.PONZU_TAILSCALE;
  process.env.PONZU_TAILSCALE = bin;
  try {
    expect(await readTailnet()).toEqual({
      ip: "100.64.0.1",
      user: "7",
      peers: [{ name: "air", ip: "100.64.0.2", online: true }],
    });
  } finally {
    if (before === undefined) delete process.env.PONZU_TAILSCALE;
    else process.env.PONZU_TAILSCALE = before;
    await rm(dir, { recursive: true, force: true });
  }
});
