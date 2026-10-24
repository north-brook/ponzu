/**
 * How a request to a Mac failed, from what iOS reports. `fetch` in React
 * Native turns every failure into "Network request failed"; XMLHttpRequest
 * keeps NSURLError's description and whether it timed out, which is enough to
 * tell a Mac where nothing listens on the port from one that isn't there.
 *
 * - `refused`: the Mac answered and nothing listens there (Ponzu has quit).
 *   NSURLErrorCannotConnectToHost, "Could not connect to the server.", fast.
 * - `dns`: the name doesn't resolve: no MagicDNS, so most likely no tailnet.
 *   NSURLErrorCannotFindHost, "A server with the specified hostname could not be found."
 * - `offline`: no route at all. NSURLErrorNotConnectedToInternet / NetworkConnectionLost.
 * - `timeout`: nothing came back in time: the Mac is asleep or gone.
 * - `http`: it answered, with an error status or something that isn't Ponzu.
 */
export type Failure = "refused" | "dns" | "offline" | "timeout" | "http" | "other";

export class NetError extends Error {
  constructor(
    readonly kind: Failure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "NetError";
  }
}

/** A failure from NSURLError's description, and whether XMLHttpRequest flagged a timeout. */
export function classify(description: string, timedOut: boolean): Failure {
  if (timedOut) return "timeout";
  const d = description.toLowerCase();
  if (d.includes("timed out")) return "timeout";
  if (d.includes("could not connect") || d.includes("connection refused")) return "refused";
  if (d.includes("hostname could not be found") || d.includes("dns")) return "dns";
  if (
    d.includes("offline") ||
    d.includes("not connected to the internet") ||
    d.includes("network connection was lost")
  )
    return "offline";
  return "other";
}
