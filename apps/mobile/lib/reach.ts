import { useEffect } from "react";
import { AppState } from "react-native";
import { NetError, request } from "./http";
import { baseUrl, type Mac, type MacInfo, wakeUrl } from "./mac";
import { keys } from "./mac-queries";
import { fetchInfo, learnPeers, loadMacs, macs, noteAnswer } from "./macs";
import { queryClient } from "./query";
import { ASK_TIMEOUT, afterFirstAsk, type Reach, settle, WAKE } from "./reach-rules";
import { Store, useStore } from "./store";

export type { Reach } from "./reach-rules";

/** Each saved Mac's reach, by id. */
export const reach = new Store<Record<string, Reach>>({});
/** A pass over every Mac is running. */
export const reaching = new Store<boolean>(false);

function setReach(id: string, r: Reach) {
  reach.set((all) => (all[id] === r ? all : { ...all, [id]: r }));
}

/** Asks `mac` for its info, through the cache, so an answer is the info every screen reads. */
async function ask(mac: Mac, timeout = ASK_TIMEOUT): Promise<MacInfo> {
  const info = await queryClient.fetchQuery({
    queryKey: keys.info(mac.id),
    queryFn: () => fetchInfo(baseUrl(mac), timeout),
    staleTime: 0,
  });
  noteAnswer(mac, info);
  return info;
}

/** Knocks on the wake port, then asks until Ponzu answers or 12s pass. */
async function wake(mac: Mac): Promise<boolean> {
  setReach(mac.id, "waking");
  // The helper starts Ponzu on any connection and sends nothing back: the result doesn't matter.
  request(wakeUrl(mac), { timeout: 2_000 }).catch(() => {});
  const until = Date.now() + WAKE.for;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, WAKE.every));
    try {
      await ask(mac, 1_500);
      return true;
    } catch {
      // Not yet.
    }
  }
  return false;
}

let pass: Promise<void> | null = null;

/**
 * Asks every saved Mac where it stands, all at once: on launch, on coming
 * back to the foreground, and on Try again. A Mac that answers names the
 * others it knows, and new ones are asked too.
 */
export function reachAll(): Promise<void> {
  pass ??= (async () => {
    reaching.set(true);
    try {
      await loadMacs();
      const asked = new Set<string>();
      const outcomes: ReturnType<typeof afterFirstAsk>[] = [];
      const unreachable: string[] = [];
      const one = async (mac: Mac) => {
        asked.add(mac.id);
        setReach(mac.id, "asking");
        let outcome: ReturnType<typeof afterFirstAsk>;
        try {
          await ask(mac);
          outcome = "answer";
        } catch (err) {
          outcome = afterFirstAsk({
            ok: false,
            failure: err instanceof NetError ? err.kind : "other",
          });
        }
        outcomes.push(outcome);
        if (outcome === "unreachable") unreachable.push(mac.id);
        if (outcome === "answer") {
          setReach(mac.id, "answer");
          const learned = await learnPeers(mac).catch(() => []);
          await Promise.all(learned.filter((m) => !asked.has(m.id)).map(one));
        } else if (outcome === "wake") {
          setReach(mac.id, (await wake(mac)) ? "answer" : "asleep");
        } else if (outcome === "asleep") {
          setReach(mac.id, "asleep");
        }
      };
      await Promise.all(macs.get().map(one));
      // Unreachable Macs: no tailnet if none could be tried at all, else asleep.
      const verdict = settle(outcomes);
      for (const id of unreachable) setReach(id, verdict);
    } finally {
      reaching.set(false);
      pass = null;
    }
  })();
  return pass;
}

/** Asks one Mac again, e.g. when its catalog socket drops. */
export async function reachOne(mac: Mac): Promise<Reach> {
  try {
    await ask(mac);
    setReach(mac.id, "answer");
  } catch (err) {
    const next = afterFirstAsk({
      ok: false,
      failure: err instanceof NetError ? err.kind : "other",
    });
    setReach(mac.id, next === "wake" ? ((await wake(mac)) ? "answer" : "asleep") : "asleep");
  }
  return reach.get()[mac.id]!;
}

/** Where the phone stands overall, for the launch screen. */
export type Overall =
  | { state: "none" }
  | { state: "asking" }
  | { state: "waking"; mac: Mac }
  | { state: "answer" }
  | { state: "noTailnet" }
  | { state: "asleep" };

export function overall(saved: Mac[], r: Record<string, Reach>): Overall {
  if (!saved.length) return { state: "none" };
  const states = saved.map((m) => r[m.id] ?? "unknown");
  if (states.includes("answer")) return { state: "answer" };
  const waking = saved.find((m) => r[m.id] === "waking");
  if (waking) return { state: "waking", mac: waking };
  if (states.some((s) => s === "asking" || s === "unknown")) return { state: "asking" };
  if (states.every((s) => s === "noTailnet")) return { state: "noTailnet" };
  return { state: "asleep" };
}

/** The saved Macs and each one's reach. */
export function useMacs() {
  const saved = useStore(macs);
  const r = useStore(reach);
  const busy = useStore(reaching);
  return { macs: saved, reach: r, reaching: busy, overall: overall(saved, r) };
}

/** Mounted once, at the root: asks every Mac again when the app comes back to the foreground. */
export function useReachOnForeground() {
  useEffect(() => {
    let last = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      if (last !== "active" && next === "active") reachAll();
      last = next;
    });
    return () => sub.remove();
  }, []);
}
