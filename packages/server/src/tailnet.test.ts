import { expect, test } from "bun:test";
import { isTailnetAddress } from "./tailnet.ts";

test("only Tailscale's ranges count as tailnet addresses", () => {
  expect(isTailnetAddress("100.77.244.103")).toBe(true);
  expect(isTailnetAddress("::ffff:100.64.0.1")).toBe(true);
  expect(isTailnetAddress("100.127.255.255")).toBe(true);
  expect(isTailnetAddress("fd7a:115c:a1e0::3e3b:f468")).toBe(true);
  expect(isTailnetAddress("100.128.0.1")).toBe(false);
  expect(isTailnetAddress("100.63.0.1")).toBe(false);
  expect(isTailnetAddress("192.168.1.20")).toBe(false);
  expect(isTailnetAddress("127.0.0.1")).toBe(false);
  expect(isTailnetAddress("::1")).toBe(false);
});
