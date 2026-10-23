import { loadCachedCatalogs } from "./catalog";
import { loadMacs, macs } from "./macs";
import { reachAll } from "./reach";
import { loadSeen } from "./seen";
import { loadThreadDocs } from "./threads";

let booted: Promise<void> | null = null;

/**
 * Everything the app reads from the phone on start, then a first ask of
 * every saved Mac. The root layout starts it, so a deep link straight into a
 * design or search has its Macs and catalogs too; the launch screen awaits it.
 */
export function boot(): Promise<void> {
  booted ??= (async () => {
    await Promise.all([loadMacs(), loadSeen()]);
    await loadCachedCatalogs();
    loadThreadDocs(macs.get().map((m) => m.id));
    reachAll();
  })();
  return booted;
}
