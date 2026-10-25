import { designFromParams } from "@ponzu/core";
import type { Mac } from "./mac";

/**
 * An agent's link to a design, `ponzu://open?mac=<name>&file=<path>.design&artboard=<id>`, as the
 * Mac app takes it (@ponzu/core's appLink, which ponzu.design/local hands on), read on the phone.
 * Pure, so tests run without React Native.
 */
export type OpenTarget =
  | { kind: "design"; mac: string; key: string; artboard?: string }
  /** The link's Mac isn't one this phone has paired. */
  | { kind: "unpaired"; mac: string }
  /** No paired Mac has it: a link without a Mac, and no catalog lists its path. */
  | { kind: "missing" }
  /** Not a design link: a GitHub repo link (the Mac app's), or a malformed one. */
  | { kind: "invalid" };

/**
 * The saved Mac a link names, and the design on it, from the link's query as expo-router hands it
 * over. `mac` is the tailnet host name, the first label of a saved Mac's MagicDNS name. A link
 * without one (made where there's no Tailscale) opens on the Mac whose catalog lists the path, or
 * the only Mac there is.
 */
export function openTarget(
  params: Record<string, string | string[] | undefined>,
  macs: Mac[],
  has: (mac: string, key: string) => boolean,
): OpenTarget {
  const link = designFromParams((name) => {
    const v = params[name];
    return typeof v === "string" ? v : null;
  });
  if (!link) return { kind: "invalid" };
  const at = link.artboard ? { artboard: link.artboard } : {};
  if (link.mac) {
    const mac = macs.find((m) => m.dns.split(".")[0]!.toLowerCase() === link.mac);
    return mac
      ? { kind: "design", mac: mac.id, key: link.path, ...at }
      : { kind: "unpaired", mac: link.mac };
  }
  const mac = macs.find((m) => has(m.id, link.path)) ?? (macs.length === 1 ? macs[0] : undefined);
  return mac ? { kind: "design", mac: mac.id, key: link.path, ...at } : { kind: "missing" };
}
