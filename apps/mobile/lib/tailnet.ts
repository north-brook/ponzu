/**
 * Whether this iPhone is on a tailnet, from its interfaces' addresses
 * (modules/tailnet), with no native code: lib/use-tailnet.ts reads them.
 */
import type { Interface } from "../modules/tailnet";

/**
 * Tailscale's own addresses: IPv4 in 100.64.0.0/10 on a tunnel (`utun`)
 * interface, or IPv6 in fd7a:115c:a1e0::/48. A carrier can hand out
 * 100.64.0.0/10 on cellular too, so an IPv4 address counts only on a tunnel.
 */
export function isTailnetAddress({ name, address }: Interface): boolean {
  if (address.toLowerCase().startsWith("fd7a:115c:a1e0:")) return true;
  if (!name.startsWith("utun")) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/**
 * On a tailnet, or not; `unknown` when the build can't tell (no native
 * module), so the screen asks the person instead.
 */
export type Tailnet = "on" | "off" | "unknown";

export function tailnet(found: Interface[] | null): Tailnet {
  if (!found) return "unknown";
  return found.some(isTailnetAddress) ? "on" : "off";
}
