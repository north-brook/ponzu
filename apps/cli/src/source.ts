import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The checkout this CLI runs from, when it runs as source (`bun
 * apps/cli/src/index.ts`, `bun run dev`) rather than as the binary compiled
 * into Ponzu.app or an installed package. Compiled, its own path is in Bun's
 * virtual filesystem; installed, it's under node_modules.
 */
export function sourceCheckout(file = fileURLToPath(import.meta.url)): string | null {
  if (file.startsWith("/$bunfs/") || file.split(sep).includes("node_modules")) return null;
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir))
    if (existsSync(join(dir, ".git"))) return dir;
  return null;
}

/** Where servers run from a checkout listen: one port per checkout, clear of the app's 7777. */
export const SOURCE_PORTS = { from: 7800, to: 7999 };

/** A checkout's own port, from its path: the same every run, and another worktree's differs. */
export function checkoutPort(root: string): number {
  const span = SOURCE_PORTS.to - SOURCE_PORTS.from + 1;
  return SOURCE_PORTS.from + (createHash("sha256").update(root).digest().readUInt32BE(0) % span);
}

/**
 * How `ponzu serve` listens. Installed, as it always has: port 7777 and the
 * tailnet, so the owner's iPhone and other Macs find this Mac. From a
 * checkout, neither by default: the tailnet port and the Bonjour advert
 * belong to the installed app, and a dev server holding them is what the
 * phone would pair with. `--tailnet` joins it anyway. Ports are tried in
 * order; 0 takes any.
 */
export function serveDefaults(
  o: { port?: string; tailnet?: boolean },
  checkout: string | null,
): { ports: number[]; tailnet: boolean } {
  if (!checkout) return { ports: [Number(o.port ?? 7777)], tailnet: true };
  if (o.port) return { ports: [Number(o.port)], tailnet: Boolean(o.tailnet) };
  const own = checkoutPort(checkout);
  const ports: number[] = [];
  for (let p = own; p <= SOURCE_PORTS.to; p++) ports.push(p);
  for (let p = SOURCE_PORTS.from; p < own; p++) ports.push(p);
  return { ports: [...ports, 0], tailnet: Boolean(o.tailnet) };
}

/** The first of `ports` free on `hostname`. A single port is returned as is, for serve to report. */
export function firstFree(ports: number[], hostname: string): number {
  if (ports.length === 1) return ports[0]!;
  for (const port of ports) {
    if (port === 0) return 0;
    try {
      Bun.serve({ port, hostname, fetch: () => new Response() }).stop(true);
      return port;
    } catch {
      // Taken: try the next.
    }
  }
  return 0;
}
