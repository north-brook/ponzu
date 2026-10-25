import type { MachineUpdate } from "@ponzu/core";

/**
 * The Mac app's updater, as the server it started sees it. The catalog lists its state on this
 * Mac's machine, so every Mac's studio sees what every Mac has; `POST /api/update` installs on
 * them all. `ponzu serve` has none.
 */
export interface Updater {
  /** What it has, as last heard. Undefined until the app first answers. */
  state(): MachineUpdate | undefined;
  /**
   * Install `version`, or a newer Ponzu: restart into it, downloading it first when what's here
   * is older. `quiet` is Ponzu's own idea rather than the person's, and the app declines it
   * while they're using it. `here`: the person clicked Update on this Mac and read its notes, so
   * What's new needn't show them again.
   */
  install(opts?: {
    quiet?: boolean;
    here?: boolean;
    version?: string;
  }): Promise<MachineUpdate | undefined>;
  stop(): void;
}

/** How often the app is asked what it has. It finds an update every few hours at most. */
const POLL_EVERY = 3000;

/**
 * The desktop app's updater, over the endpoint it hands the server
 * (`PONZU_APP_ENDPOINT`, apps/desktop/src/updater.ts), authorized by its token.
 */
export function remoteUpdater(endpoint: string, token: string): Updater {
  let last: MachineUpdate | undefined;
  const headers = { authorization: `Bearer ${token}` };
  const read = async (res: Response) => {
    if (res.ok) last = (await res.json()) as MachineUpdate;
    return last;
  };
  const poll = () =>
    fetch(endpoint, { headers, signal: AbortSignal.timeout(POLL_EVERY) })
      .then(read)
      .catch(() => undefined);
  void poll();
  const timer = setInterval(poll, POLL_EVERY);
  timer.unref?.();
  return {
    state: () => last,
    install: (opts = {}) =>
      fetch(`${endpoint}/install`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(opts),
        signal: AbortSignal.timeout(5000),
      })
        .then(read)
        .catch(() => last),
    stop: () => clearInterval(timer),
  };
}
