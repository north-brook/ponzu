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
   * while they're using it.
   */
  install(opts?: { quiet?: boolean; version?: string }): Promise<MachineUpdate | undefined>;
  stop(): void;
}

/** How often the app is asked what it has. It finds an update every few hours at most. */
const POLL_EVERY = 3000;

/** How often an install held for a working agent checks whether the agent is done. */
const AGENT_CHECK_EVERY = 2000;

/**
 * `updater`, but an install the person asked for waits while `busy` names an agent working
 * here, so a restart never cuts one off mid-change. It counts as installing from the moment
 * it's asked, so every Mac's Update says so, and goes ahead once the agent is done (presence
 * drops an agent's work two minutes after its last call). A quiet catch-up isn't held: the app
 * already declines one while anyone uses this Mac.
 */
export function waitForAgents(
  updater: Updater,
  busy: () => string | undefined,
  every = AGENT_CHECK_EVERY,
): Updater {
  let held: {
    opts: Parameters<Updater["install"]>[0];
    timer: ReturnType<typeof setInterval>;
  } | null = null;
  const state = (): MachineUpdate | undefined => {
    const s = updater.state();
    return s && held ? { ...s, installing: true } : s;
  };
  return {
    state,
    async install(opts = {}) {
      if (opts.quiet || !busy()) {
        if (held) {
          clearInterval(held.timer);
          held = null;
        }
        return updater.install(opts);
      }
      // Asked again while held: the newest ask is the one that goes ahead.
      if (held) held.opts = opts;
      else {
        const timer = setInterval(() => {
          if (busy() || !held) return;
          const { opts } = held;
          clearInterval(held.timer);
          held = null;
          void updater.install(opts);
        }, every);
        timer.unref?.();
        held = { opts, timer };
      }
      return state();
    },
    stop() {
      if (held) clearInterval(held.timer);
      held = null;
      updater.stop();
    },
  };
}

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
