import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkoutPort, firstFree, SOURCE_PORTS, serveDefaults, sourceCheckout } from "./source.ts";

test("knows when it runs from a checkout", async () => {
  // This test runs from one.
  expect(sourceCheckout()).toBe(resolve(import.meta.dir, "../../.."));
  // Compiled into Ponzu.app, its own path is in Bun's virtual filesystem.
  expect(sourceCheckout("/$bunfs/root/ponzu")).toBeNull();

  const dir = await mkdtemp(join(tmpdir(), "ponzu-source-"));
  try {
    // A worktree's .git is a file, a clone's a folder: either marks the root.
    await mkdir(join(dir, "wt/apps/cli/src"), { recursive: true });
    await writeFile(join(dir, "wt/.git"), "gitdir: /elsewhere\n");
    expect(sourceCheckout(join(dir, "wt/apps/cli/src/index.ts"))).toBe(join(dir, "wt"));
    // Installed as a package, even inside someone's repo.
    await mkdir(join(dir, "wt/node_modules/ponzu/src"), { recursive: true });
    expect(sourceCheckout(join(dir, "wt/node_modules/ponzu/src/index.ts"))).toBeNull();
    // Nowhere near a repo.
    await mkdir(join(dir, "loose/src"), { recursive: true });
    expect(sourceCheckout(join(dir, "loose/src/index.ts"))).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each checkout gets its own port, the same every run, clear of 7777", () => {
  const roots = Array.from({ length: 50 }, (_, i) => `/Users/sam/.t3/worktrees/ponzu/t3-${i}`);
  const ports = roots.map(checkoutPort);
  for (const p of ports) {
    expect(p).toBeGreaterThanOrEqual(SOURCE_PORTS.from);
    expect(p).toBeLessThanOrEqual(SOURCE_PORTS.to);
  }
  expect(roots.map(checkoutPort)).toEqual(ports);
  expect(new Set(ports).size).toBeGreaterThan(40);
  expect(checkoutPort("/a/ponzu")).not.toBe(checkoutPort("/b/ponzu"));
});

test("installed, serve listens as always; from a checkout, on its port and off the tailnet", () => {
  // The app's binary and an installed CLI.
  expect(serveDefaults({}, null)).toEqual({ ports: [7777], tailnet: true });
  expect(serveDefaults({ port: "0" }, null)).toEqual({ ports: [0], tailnet: true });

  const root = "/Users/sam/git/ponzu";
  const own = checkoutPort(root);
  const { ports, tailnet } = serveDefaults({}, root);
  expect(tailnet).toBe(false);
  // Its own port first, then the rest of the range, then any.
  expect(ports[0]).toBe(own);
  expect(ports.at(-1)).toBe(0);
  expect(new Set(ports).size).toBe(SOURCE_PORTS.to - SOURCE_PORTS.from + 2);
  expect(ports).not.toContain(7777);

  expect(serveDefaults({ port: "7777" }, root)).toEqual({ ports: [7777], tailnet: false });
  expect(serveDefaults({ tailnet: true }, root).tailnet).toBe(true);
});

test("a taken port falls through to the next", () => {
  const held = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = held.port!;
  try {
    expect(firstFree([port, port + 1, 0], "127.0.0.1")).not.toBe(port);
    // One port is what was asked for: serve says so if it's taken.
    expect(firstFree([port], "127.0.0.1")).toBe(port);
  } finally {
    held.stop(true);
  }
});
