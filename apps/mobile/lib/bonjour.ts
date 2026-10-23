import { useEffect, useState } from "react";
import { type BrowseState, type Service, useBonjour } from "../modules/bonjour";

/** A Mac advertising Ponzu on this Wi-Fi. */
export interface NearbyMac {
  /** Its host name, from the TXT record (or the instance name). */
  name: string;
  /** Its MagicDNS name, where the phone connects. Never the LAN address. */
  host: string;
}

/** A Ponzu advertisement's Mac, or null when it doesn't say where it is on the tailnet. */
export function nearbyMac(s: Service): NearbyMac | null {
  const host = s.txt.host?.trim();
  if (!host) return null;
  return { name: s.txt.name?.trim() || s.name, host };
}

/**
 * Ponzus on this Wi-Fi, while mounted, and whether the search is over: after
 * `wait` ms with nothing found, or once local network access is refused, the
 * Connect screen offers the code instead. Mounting this raises iOS's local
 * network prompt the first time.
 */
export function useNearbyMacs(wait = 4_000): {
  macs: NearbyMac[];
  state: BrowseState;
  settled: boolean;
} {
  const { services, state } = useBonjour();
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), wait);
    return () => clearTimeout(t);
  }, [wait]);
  const seen = new Set<string>();
  const macs: NearbyMac[] = [];
  for (const s of services) {
    const m = nearbyMac(s);
    if (m && !seen.has(m.host)) {
      seen.add(m.host);
      macs.push(m);
    }
  }
  const settled =
    macs.length === 0 &&
    (timedOut || state === "denied" || state === "failed" || state === "unavailable");
  return { macs, state, settled };
}
