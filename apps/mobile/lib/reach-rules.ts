import type { Failure } from "./net";

/**
 * Where a saved Mac stands, as the launch screen and Designs show it.
 * - `unknown`: not asked yet.
 * - `asking`: asking now.
 * - `answer`: Ponzu answered.
 * - `waking`: the Mac is there but Ponzu isn't; the phone knocked on the wake
 *   port and is waiting for Ponzu to start.
 * - `asleep`: nothing answered: the Mac is asleep, off or away.
 * - `noTailnet`: the phone itself can't reach the tailnet.
 */
export type Reach = "unknown" | "asking" | "answer" | "waking" | "asleep" | "noTailnet";

/** How one Mac's first ask went. */
export type FirstAsk = { ok: true } | { ok: false; failure: Failure };

/** What to do after the first ask. */
export function afterFirstAsk(ask: FirstAsk): "answer" | "wake" | "asleep" | "unreachable" {
  if (ask.ok) return "answer";
  switch (ask.failure) {
    // The Mac is up and nothing listens on 7777: Ponzu has quit. Knock and wait.
    case "refused":
      return "wake";
    // Nothing came back, or something that isn't Ponzu answered.
    case "timeout":
    case "http":
      return "asleep";
    // No name, no route, or iOS refused to try: settled once every Mac has been asked.
    default:
      return "unreachable";
  }
}

/**
 * The phone has no tailnet when no Mac could even be tried: every one failed
 * with a network error that wasn't a timeout (the name didn't resolve, or
 * there was no route), and none refused or answered. iOS can't tell an app
 * whether a VPN is up, so this is a heuristic. A refusal or a timeout means
 * packets reached the tailnet, so then the unreachable Macs count as asleep.
 */
export function settle(outcomes: ReturnType<typeof afterFirstAsk>[]): "noTailnet" | "asleep" {
  return outcomes.length > 0 && outcomes.every((o) => o === "unreachable") ? "noTailnet" : "asleep";
}

/** Waking: knock, then ask every 700ms for up to 12s. */
export const WAKE = { every: 700, for: 12_000 } as const;
/** The first ask's timeout. A Mac on the tailnet answers in well under a second. */
export const ASK_TIMEOUT = 2_500;
