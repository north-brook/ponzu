/**
 * A Mac the phone has paired with, or learned about from one, and how to
 * reach it. Pure, so tests run without React Native.
 */
export interface Mac {
  /** Its MagicDNS name, which is also how the phone reaches it. */
  id: string;
  /** Its tailnet host name, e.g. "workstation". */
  name: string;
  /** MagicDNS name, e.g. "workstation.tail023d74.ts.net". */
  dns: string;
  /** Its tailnet address, for the record. iOS won't load plain http from one (see docs/mobile.md). */
  ip?: string;
  kind: "laptop" | "desktop";
  addedAt: number;
  /** When it last answered `/api/info`. */
  lastAnsweredAt?: number;
  /**
   * How the phone learned of it: a scanned code, or named by another Mac.
   * `bonjour` (found on the Wi-Fi) is from builds before the code was the only way.
   */
  via: "bonjour" | "qr" | "peer" | "dev";
  /**
   * `host:port` to dial instead of `<dns>:7777`. Only the development override
   * (`EXPO_PUBLIC_PONZU_DEV_HOST`) sets it, for a branch server on this Mac.
   */
  address?: string;
}

/** `/api/info`, from a Mac's Ponzu. */
export interface MacInfo {
  version: string;
  protocol?: number;
  idle?: number;
  machine?: { name: string | null; dns: string | null; kind?: "laptop" | "desktop" };
  telemetry?: { on: boolean; owner: string | null };
}

/** `/api/macs`: this Mac first, then the owner's others on the tailnet. */
export interface MacList {
  macs: {
    name: string;
    dns: string | null;
    ip?: string;
    online: boolean;
    self: boolean;
    kind?: "laptop" | "desktop";
  }[];
}

/** The server protocol this app speaks; `/api/info` reports the Mac's. */
export const PROTOCOL = 1;
export const PORT = 7777;

/**
 * A tailnet MagicDNS name (`workstation.tail023d74.ts.net`), with or without Tailscale's
 * trailing dot. The tailnet authenticates these names, so the phone only ever pairs with one:
 * a LAN address or another domain could be anyone on the Wi-Fi.
 */
export function isMagicDns(host: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net\.?$/i.test(host.trim());
}
/** The wake helper's port: a connection there starts Ponzu in the background. */
export const WAKE_PORT = 7778;

export function baseUrl(mac: Pick<Mac, "dns" | "address">): string {
  return `http://${mac.address ?? `${mac.dns}:${PORT}`}`;
}

export function wakeUrl(mac: Pick<Mac, "dns" | "address">): string {
  const host = mac.address ? hostOf(mac.address) : mac.dns;
  return `http://${host}:${WAKE_PORT}/`;
}

/** The host of `host` or `host:port`. */
export function hostOf(address: string): string {
  const i = address.lastIndexOf(":");
  return i > 0 && /^\d+$/.test(address.slice(i + 1)) ? address.slice(0, i) : address;
}

/**
 * A pairing code's Mac: `ponzu://pair?host=<MagicDNS name>&v=1`. Null for any
 * other code, or a version this app doesn't read.
 */
export function parsePairUrl(url: string): string | null {
  const m = /^ponzu:\/\/pair\/?\?(.*)$/i.exec(url.trim());
  if (!m) return null;
  const params = new URLSearchParams(m[1]);
  const v = params.get("v");
  if (v && v !== "1") return null;
  const host = params.get("host")?.trim().replace(/\.$/, "");
  return host && isMagicDns(host) ? host : null;
}

/** Save `next` into `macs`, keeping what the phone already knew about it. */
export function upsertMac(macs: Mac[], next: Mac): Mac[] {
  const i = macs.findIndex((m) => m.id === next.id);
  if (i < 0) return [...macs, next];
  const prev = macs[i]!;
  const merged: Mac = {
    ...prev,
    ...next,
    addedAt: prev.addedAt,
    // A Mac paired directly stays paired that way when another names it.
    via: next.via === "peer" ? prev.via : next.via,
    lastAnsweredAt: Math.max(prev.lastAnsweredAt ?? 0, next.lastAnsweredAt ?? 0) || undefined,
  };
  return macs.map((m, j) => (j === i ? merged : m));
}

/** Pairing failed: the Mac didn't answer, isn't Ponzu, or speaks another protocol. */
export class PairError extends Error {
  constructor(
    readonly reason: "unreachable" | "notPonzu" | "tooOld" | "tooNew",
    message: string,
    /** The version the Mac reported, when it answered. */
    readonly version?: string,
  ) {
    super(message);
  }
}

/** What to tell the person when pairing with `name` failed. */
export function pairMessage(err: unknown, name: string): string {
  if (err instanceof PairError) {
    switch (err.reason) {
      // It answered without the phone's protocol. That may not be the installed
      // app: another Ponzu (an old one, or one run by hand) can hold the port.
      case "tooOld":
        return `${name} answered with Ponzu ${err.version ?? "of an older version"}, which can't pair yet. Update Ponzu on that computer, or quit any other Ponzu running there.`;
      case "tooNew":
        return "Update Ponzu on this iPhone, then connect again.";
      case "notPonzu":
        return `${name} answered, but not as Ponzu.`;
      default:
        return `${name} didn't answer over Tailscale. Check Tailscale is on here and on the computer.`;
    }
  }
  return `Couldn't connect to ${name}.`;
}
