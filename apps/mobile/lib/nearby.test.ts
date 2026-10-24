import { expect, test } from "bun:test";
import { nearbyMac } from "./nearby";

const advert = (host: string | undefined, name = "workstation") => {
  const txt: Record<string, string> = { name };
  if (host !== undefined) txt.host = host;
  return { name, txt };
};

test("a Mac's advertisement names its MagicDNS host", () => {
  expect(nearbyMac(advert("workstation.tail023d74.ts.net"))).toEqual({
    name: "workstation",
    host: "workstation.tail023d74.ts.net",
  });
  // Tailscale reports names with a trailing dot; the phone connects without it.
  expect(nearbyMac(advert("studio.tail1.ts.net."))?.host).toBe("studio.tail1.ts.net");
});

test("anything on the Wi-Fi that isn't a tailnet name is ignored", () => {
  // Any device on the network can advertise _ponzu._tcp: the phone only ever pairs over
  // the tailnet, so a LAN address, a .local name or another domain is no Mac.
  for (const host of [
    "192.168.1.20",
    "192.168.1.20:7777",
    "10.0.0.5",
    "workstation.local",
    "evil.example.com",
    "ts.net",
    "workstation.ts.net.evil.com",
    "",
    "  ",
  ]) {
    expect(nearbyMac(advert(host))).toBeNull();
  }
  expect(nearbyMac(advert(undefined))).toBeNull();
});
