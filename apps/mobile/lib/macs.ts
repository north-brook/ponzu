import AsyncStorage from "@react-native-async-storage/async-storage";
import { useMutation } from "@tanstack/react-query";
import { getJson, NetError } from "./http";
import {
  baseUrl,
  hostOf,
  isMagicDns,
  type Mac,
  type MacInfo,
  type MacList,
  PairError,
  PORT,
  PROTOCOL,
  upsertMac,
} from "./mac";
import { keys } from "./mac-queries";
import { queryClient } from "./query";
import { Store, useStore } from "./store";

export type { Mac } from "./mac";
export { PairError, pairMessage } from "./mac";

const KEY = "ponzu.macs";

/**
 * The saved Macs, in the order the phone learned them. Kept on the phone
 * (AsyncStorage), not asked of anyone, so a store rather than a query; what
 * each Mac says of itself is its info query (`keys.info`).
 */
export const macs = new Store<Mac[]>([]);
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

/** A Mac answered: keep its name and kind as it reports them now. */
export function noteAnswer(mac: Mac, info: MacInfo) {
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

/**
 * `/api/info` from `base`. Fails with how it failed (see net.ts): something
 * that answers but isn't Ponzu is an `http` failure without a status.
 */
export async function fetchInfo(base: string, timeout: number): Promise<MacInfo> {
  const info = await getJson<MacInfo>(`${base}/api/info`, timeout);
  if (typeof info?.version !== "string") throw new NetError("http", "Not Ponzu");
  return info;
}

/** Every saved Mac's last `/api/info`, from the cache, by id. */
export function cachedInfos(): Record<string, MacInfo> {
  const all: Record<string, MacInfo> = {};
  for (const m of macs.get()) {
    const info = queryClient.getQueryData<MacInfo>(keys.info(m.id));
    if (info) all[m.id] = info;
  }
  return all;
}

/**
 * Pairs with the Ponzu at `host` (a MagicDNS name, or `host:port`): asks
 * `/api/info`, checks it speaks this app's protocol, saves it, then saves the
 * other Macs it names. Returns the paired Mac.
 */
async function pair(host: string, via: Mac["via"]): Promise<Mac> {
  const dev = via === "dev";
  const name = host.trim().replace(/\.$/, "");
  // Only the development override dials an address. Any other Mac is reached by its MagicDNS
  // name: a pairing link or a Wi-Fi advert naming an address could point the phone, and a
  // Mac it already knows, at any host on the network.
  if (!dev && !isMagicDns(name)) throw new PairError("unreachable", `Not a tailnet name: ${name}`);
  const address = dev && name.includes(":") ? name : `${name}:${PORT}`;
  let info: MacInfo;
  try {
    info = await fetchInfo(`http://${address}`, 6_000);
  } catch (err) {
    const notPonzu = err instanceof NetError && err.kind === "http" && err.status === undefined;
    throw new PairError(notPonzu ? "notPonzu" : "unreachable", String(err));
  }
  if (info.protocol === undefined || info.protocol < PROTOCOL)
    throw new PairError("tooOld", `Ponzu ${info.version} on that Mac is too old`, info.version);
  if (info.protocol > PROTOCOL) throw new PairError("tooNew", "Update Ponzu on this iPhone");
  // The Mac is saved under the name the phone dialled, never one the answer claims: an answer
  // naming another Mac could otherwise take its place.
  const dns = dev ? (info.machine?.dns ?? hostOf(name)) : name;
  const mac: Mac = {
    id: dev ? DEV_ID : dns,
    name: info.machine?.name ?? hostOf(name).split(".")[0]!,
    dns,
    kind: info.machine?.kind ?? "laptop",
    addedAt: Date.now(),
    lastAnsweredAt: Date.now(),
    via,
    ...(dev ? { address } : {}),
  };
  macs.set((all) => upsertMac(all, mac));
  queryClient.setQueryData(keys.info(mac.id), info);
  save();
  return mac;
}

/**
 * Pairing, from the Wi-Fi list, a scanned code or a pairing link. Once
 * paired, the Mac's info is in the cache and the Macs it names are asked for.
 */
export function usePair() {
  return useMutation({
    mutationFn: ({ host, via }: { host: string; via: Mac["via"] }) => pair(host, via),
    onSuccess: (mac) => {
      queryClient.invalidateQueries({ queryKey: keys.mac(mac.id) });
      learnPeers(mac).catch(() => {});
    },
  });
}

/** Saves the Macs `mac` names on the tailnet. Gossip: each answering Mac may name more. */
export async function learnPeers(mac: Mac): Promise<Mac[]> {
  if (devForgotten) return [];
  const list = await queryClient.fetchQuery({
    queryKey: keys.macs(mac.id),
    queryFn: () => getJson<MacList>(`${baseUrl(mac)}/api/macs`, 4_000),
    staleTime: 0,
  });
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
  // Development may have forgotten every Mac while this one was being asked.
  if (learned.length && !devForgotten) {
    macs.set((all) => learned.reduce(upsertMac, all));
    save();
  }
  return learned;
}

export function forgetMac(id: string) {
  macs.set((all) => all.filter((m) => m.id !== id));
  queryClient.removeQueries({ queryKey: keys.mac(id) });
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
 * Development: save made-up Macs that don't answer, to look at the states
 * the design draws with them. `asleep` is a MacBook and spare that time out
 * (Connect › R3, or R2 beside a Mac that answers); `waking` is a MacBook
 * whose Ponzu refuses, so the launch screen knocks (R1).
 */
export async function devSeed(which: string) {
  await loadMacs();
  const now = new Date();
  const at = (h: number, m: number, daysAgo = 0) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, h, m).getTime();
  // Loopback ports: 7796 for a listener that holds connections and never
  // answers (or, with none there, a refusal that knocks and reads as asleep
  // 12s later), and 9, closed, so Ponzu "has quit".
  const silent = "127.0.0.1:7796";
  const refuses = "127.0.0.1:9";
  const seed: Mac[] =
    which === "waking"
      ? [
          {
            id: "seed-macbook",
            name: "MacBook",
            dns: "macbook.seed",
            kind: "laptop",
            addedAt: 0,
            via: "qr",
            address: refuses,
          },
        ]
      : [
          {
            id: "seed-macbook",
            name: "MacBook",
            dns: "macbook.seed",
            kind: "laptop",
            addedAt: 0,
            lastAnsweredAt: at(21, 12),
            via: "qr",
            address: silent,
          },
          {
            id: "seed-spare",
            name: "spare",
            dns: "spare.seed",
            kind: "desktop",
            addedAt: 0,
            lastAnsweredAt: at(18, 0, 1),
            via: "peer",
            address: silent,
          },
        ];
  macs.set((all) => seed.reduce(upsertMac, all));
  save();
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
