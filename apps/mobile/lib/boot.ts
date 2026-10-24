import { loadMacs, macs } from "./macs";
import { reachAll } from "./reach";
import { loadSeen } from "./seen";
import { loadThreadDocs } from "./threads";

let booted: Promise<void> | null = null;

/**
 * Everything the app reads from the phone on start, then a first ask of
 * every saved Mac. The root layout starts it, so a deep link straight into a
 * design or search has its Macs too; the launch screen awaits it. The query
 * cache (each Mac's info and catalog) restores itself in QueryProvider.
 */
export function boot(): Promise<void> {
  booted ??= (async () => {
    await Promise.all([loadMacs(), loadSeen()]);
    loadThreadDocs(macs.get().map((m) => m.id));
    reachAll();
  })();
  return booted;
}
