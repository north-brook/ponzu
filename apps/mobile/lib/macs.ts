import AsyncStorage from "@react-native-async-storage/async-storage";
import { getJson } from "./http";
import {
  baseUrl,
  hostOf,
  type Mac,
  type MacInfo,
  type MacList,
  PORT,
  PROTOCOL,
  upsertMac,
} from "./mac";
import { Store, useStore } from "./store";

export type { Mac } from "./mac";

const KEY = "ponzu.macs";

/** The saved Macs, in the order the phone learned them. */
export const macs = new Store<Mac[]>([]);
/** Each Mac's last `/api/info`, by id. */
export const infos = new Store<Record<string, MacInfo>>({});
let loaded: Promise<void> | null = null;

/** Reads the saved Macs once. Every screen that needs them awaits this. */
export function loadMacs(): Promise<void> {
  loaded ??= (async () => {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (raw) macs.set(JSON.parse(raw) as Mac[]);
    } catch {
      // Nothing saved, or unreadable: start over.
    }
    seedDevMac();
  })();
  return loaded;
}

function save() {
  AsyncStorage.setItem(KEY, JSON.stringify(macs.get())).catch(() => {});
}

export function useSavedMacs(): Mac[] {
  return useStore(macs);
}

export function findMac(id: string): Mac | undefined {
  return macs.get().find((m) => m.id === id);
}

/** A Mac answered: keep its info, and its name and kind as it reports them now. */
export function noteAnswer(mac: Mac, info: MacInfo) {
  infos.set((all) => ({ ...all, [mac.id]: info }));
  // A Mac forgotten while it was being asked stays forgotten.
  const current = macs.get().find((m) => m.id === mac.id);
  if (!current) return;
  macs.set((all) =>
    upsertMac(all, {
      ...current,
      name: info.machine?.name ?? current.name,
      kind: info.machine?.kind ?? current.kind,
      lastAnsweredAt: Date.now(),
    }),
  );
  save();
}

export class PairError extends Error {
  constructor(
    readonly reason: "unreachable" | "notPonzu" | "tooOld" | "tooNew",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Pairs with the Ponzu at `host` (a MagicDNS name, or `host:port`): asks
 * `/api/info`, checks it speaks this app's protocol, saves it, then saves the
 * other Macs it names. Returns the paired Mac.
 */
export async function pair(host: string, via: Mac["via"]): Promise<Mac> {
  const address = host.includes(":") ? host : `${host}:${PORT}`;
  let info: MacInfo;
  try {
    info = await getJson<MacInfo>(`http://${address}/api/info`, 6_000);
  } catch (err) {
    throw new PairError("unreachable", String(err));
  }
  if (typeof info?.version !== "string") throw new PairError("notPonzu", "Not a Ponzu");
  if (info.protocol === undefined || info.protocol < PROTOCOL)
    throw new PairError("tooOld", `Ponzu ${info.version} on that Mac is too old`);
  if (info.protocol > PROTOCOL) throw new PairError("tooNew", "Update Ponzu on this iPhone");
  const dns = info.machine?.dns ?? hostOf(host);
  const dev = via === "dev";
  const mac: Mac = {
    id: dev ? DEV_ID : dns,
    name: info.machine?.name ?? hostOf(host).split(".")[0]!,
    dns,
    kind: info.machine?.kind ?? "laptop",
    addedAt: Date.now(),
    lastAnsweredAt: Date.now(),
    via,
    ...(dev || host.includes(":") ? { address } : {}),
  };
  macs.set((all) => upsertMac(all, mac));
  infos.set((all) => ({ ...all, [mac.id]: info }));
  save();
  await learnPeers(mac).catch(() => {});
  return mac;
}

/** Saves the Macs `mac` names on the tailnet. Gossip: each answering Mac may name more. */
export async function learnPeers(mac: Mac): Promise<Mac[]> {
  if (devForgotten) return [];
  const list = await getJson<MacList>(`${baseUrl(mac)}/api/macs`, 4_000);
  const learned: Mac[] = [];
  for (const m of list.macs ?? []) {
    // This Mac is already saved; a peer without a MagicDNS name can't be reached from iOS.
    if (m.self || !m.dns) continue;
    learned.push({
      id: m.dns,
      name: m.name,
      dns: m.dns,
      ip: m.ip,
      kind: m.kind ?? "desktop",
      addedAt: Date.now(),
      via: "peer",
    });
  }
  if (learned.length) {
    macs.set((all) => learned.reduce(upsertMac, all));
    save();
  }
  return learned;
}

export function forgetMac(id: string) {
  macs.set((all) => all.filter((m) => m.id !== id));
  save();
}

/** The development Mac's id. */
export const DEV_ID = "dev";
let devForgotten = false;

/**
 * Development: forget Macs (`all`, or ids split by commas), the dev Mac
 * included, and stop learning Macs from others until the app restarts, so a
 * forgotten Mac stays forgotten.
 */
export async function devForget(which: string) {
  await loadMacs();
  const ids = which.split(",");
  const all = ids.includes("all");
  devForgotten = true;
  for (const m of macs.get()) if (all || ids.includes(m.id)) forgetMac(m.id);
}

/**
 * In development, `EXPO_PUBLIC_PONZU_DEV_HOST=127.0.0.1:7792` pairs a branch
 * server on this Mac, which the simulator reaches on loopback. Release builds
 * never read it.
 */
function seedDevMac() {
  if (!__DEV__) return;
  const host = process.env.EXPO_PUBLIC_PONZU_DEV_HOST;
  if (!host || macs.get().some((m) => m.id === DEV_ID && m.address === host)) return;
  // `ponzu://dev?forget=…` keeps it forgotten, to look at the app without it.
  if (devForgotten) return;
  macs.set((all) =>
    upsertMac(all, {
      id: DEV_ID,
      name: "This Mac",
      dns: hostOf(host),
      kind: "laptop",
      addedAt: Date.now(),
      via: "dev",
      address: host,
    }),
  );
}

/** What to tell the person when pairing with `name` failed. */
export function pairMessage(err: unknown, name: string): string {
  if (err instanceof PairError) {
    switch (err.reason) {
      case "tooOld":
        return `Update Ponzu on ${name}, then connect again.`;
      case "tooNew":
        return "Update Ponzu on this iPhone, then connect again.";
      case "notPonzu":
        return `${name} answered, but not as Ponzu.`;
      default:
        return `${name} didn't answer over Tailscale. Check Tailscale is on here and on the Mac.`;
    }
  }
  return `Couldn't connect to ${name}.`;
}
