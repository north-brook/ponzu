import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The person's other Macs, from the Tailscale on this one. There is nothing to
 * set up: while Tailscale runs, Ponzu also listens on this Mac's tailnet
 * address, and each Mac's home screen lists the others' designs. Only Macs
 * signed in as the same Tailscale user count. A device someone shared into
 * the tailnet, or a tagged server, can't reach the designs and isn't listed.
 */
export interface Tailnet {
  /** This Mac's tailnet IPv4. */
  ip: string;
  /** This Mac's Tailscale user id. */
  user: string;
  peers: TailnetPeer[];
}

export interface TailnetPeer {
  /** Host name, e.g. "spare". */
  name: string;
  ip: string;
  online: boolean;
}

const CLI = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
];

/** PONZU_TAILSCALE overrides the CLI's path; PONZU_TAILSCALE=none turns the tailnet off. */
function tailscaleCli(): string | null {
  const override = process.env.PONZU_TAILSCALE;
  if (override === "none") return null;
  if (override) return override;
  return CLI.find((c) => existsSync(c)) ?? null;
}

/** Runs the CLI with a deadline. Null when it fails, times out or isn't installed. */
function cli(args: string[], timeoutMs = 3000): Promise<string | null> {
  const bin = tailscaleCli();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? out : null));
  });
}

interface StatusNode {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  UserID?: number;
  OS?: string;
  Online?: boolean;
  ShareeNode?: boolean;
}

/** This Mac's tailnet and its owner's other Macs. Null without a running Tailscale. */
export async function readTailnet(): Promise<Tailnet | null> {
  const text = await cli(["status", "--json"]);
  if (!text) return null;
  let status: { BackendState?: string; Self?: StatusNode; Peer?: Record<string, StatusNode> };
  try {
    status = JSON.parse(text);
  } catch {
    return null;
  }
  const self = status.Self;
  const ip = ipv4(self);
  if (status.BackendState !== "Running" || !self || !ip || self.UserID === undefined) return null;
  const peers: TailnetPeer[] = [];
  for (const p of Object.values(status.Peer ?? {})) {
    const pip = ipv4(p);
    if (!pip || p.UserID !== self.UserID || p.ShareeNode || p.OS !== "macOS") continue;
    peers.push({ name: peerName(p), ip: pip, online: Boolean(p.Online) });
  }
  peers.sort((a, b) => a.name.localeCompare(b.name));
  return { ip, user: String(self.UserID), peers };
}

function ipv4(n?: StatusNode): string | undefined {
  return n?.TailscaleIPs?.find((a) => a.includes("."));
}

function peerName(p: StatusNode): string {
  const dns = p.DNSName?.split(".")[0];
  return (dns || p.HostName || "mac").toLowerCase();
}

const refused = new Map<string, number>();

/**
 * The Tailscale user a tailnet address belongs to, as Tailscale vouches for
 * it. Null for tagged devices and nodes shared in from another account.
 * Asked on every request, so a device that's re-tagged or moves to another
 * account loses access at once. Only a refusal is remembered, for a few
 * seconds, so a stranger can't make this Mac spawn a whois per request.
 */
export async function ownerOf(ip: string): Promise<string | null> {
  const at = refused.get(ip);
  if (at && Date.now() - at < 10_000) return null;
  const text = await cli(["whois", "--json", ip]);
  let user: string | null = null;
  try {
    const who = text
      ? (JSON.parse(text) as { Node?: { User?: number; Tags?: string[]; Sharer?: number } })
      : null;
    const node = who?.Node;
    if (node?.User !== undefined && !node.Tags?.length && !node.Sharer) user = String(node.User);
  } catch {}
  if (user) refused.delete(ip);
  else refused.set(ip, Date.now());
  return user;
}

/** Whether an address is in Tailscale's ranges: 100.64.0.0/10, or fd7a:115c:a1e0::/48. */
export function isTailnetAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
}
