/**
 * What a Ponzu Bonjour advertisement says about its Mac, with no native
 * code: lib/bonjour.ts browses, this decides what a found service is.
 */
import { isMagicDns } from "./mac";

/** A found service's TXT record and instance name, as modules/bonjour reports it. */
export interface Advert {
  name: string;
  txt: Record<string, string>;
}

/** A Mac advertising Ponzu on this Wi-Fi. */
export interface NearbyMac {
  /** Its host name, from the TXT record (or the instance name). */
  name: string;
  /** Its MagicDNS name, where the phone connects. Never the LAN address. */
  host: string;
}

/**
 * A Ponzu advertisement's Mac, or null when it doesn't say where it is on the tailnet. Any
 * device on the Wi-Fi can advertise, so a host that isn't a MagicDNS name (a LAN address,
 * another domain) is ignored: the phone only ever pairs over the tailnet.
 */
export function nearbyMac(s: Advert): NearbyMac | null {
  const host = s.txt.host?.trim().replace(/\.$/, "");
  if (!host || !isMagicDns(host)) return null;
  return { name: s.txt.name?.trim() || s.name, host };
}
