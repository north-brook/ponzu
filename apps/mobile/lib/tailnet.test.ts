import { expect, test } from "bun:test";
import { isTailnetAddress, tailnet } from "./tailnet";

const at = (name: string, address: string) => ({ name, address });

test("Tailscale's tunnel address puts the phone on the tailnet", () => {
  expect(isTailnetAddress(at("utun4", "100.101.102.103"))).toBe(true);
  expect(isTailnetAddress(at("utun2", "100.64.0.1"))).toBe(true);
  expect(isTailnetAddress(at("utun2", "100.127.255.254"))).toBe(true);
  expect(isTailnetAddress(at("utun4", "fd7a:115c:a1e0::1234:5678"))).toBe(true);
  expect(isTailnetAddress(at("utun4", "FD7A:115C:A1E0:AB12::1"))).toBe(true);
});

test("other addresses aren't Tailscale's", () => {
  // Wi-Fi and the system's own tunnels.
  expect(isTailnetAddress(at("en0", "192.168.1.20"))).toBe(false);
  expect(isTailnetAddress(at("utun0", "fe80::1%utun0"))).toBe(false);
  // Outside 100.64.0.0/10.
  expect(isTailnetAddress(at("utun4", "100.63.255.255"))).toBe(false);
  expect(isTailnetAddress(at("utun4", "100.128.0.1"))).toBe(false);
  // A carrier's shared address space on cellular, not a tunnel.
  expect(isTailnetAddress(at("pdp_ip0", "100.72.10.4"))).toBe(false);
});

test("the phone is on, off, or can't tell", () => {
  expect(tailnet([at("en0", "192.168.1.20"), at("utun4", "100.101.102.103")])).toBe("on");
  expect(tailnet([at("en0", "192.168.1.20"), at("lo0", "127.0.0.1")])).toBe("off");
  expect(tailnet([])).toBe("off");
  expect(tailnet(null)).toBe("unknown");
});
