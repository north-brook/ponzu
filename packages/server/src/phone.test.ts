import { expect, test } from "bun:test";
import { isPage, isPhone, peerAllowed } from "./serve.ts";

const PHONE = "Ponzu-iOS/1.0.0 (iPhone; iOS 26.1)";
const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

test("another Ponzu server, sending no Origin, is not a page", () => {
  expect(isPage(req("http://100.64.0.1:7777/api/catalog"))).toBe(false);
});

test("a browser page is a page, whatever it claims to be", () => {
  const url = "http://100.64.0.1:7777/api/catalog";
  expect(isPage(req(url, { origin: "https://evil.example" }))).toBe(true);
  expect(isPage(req(url, { "sec-fetch-site": "cross-site" }))).toBe(true);
  // A page can set its User-Agent in some runtimes, but never its Origin or Sec-Fetch-Site.
  expect(isPage(req(url, { "user-agent": PHONE, origin: "https://evil.example" }))).toBe(true);
  expect(isPage(req(url, { "user-agent": PHONE, "sec-fetch-site": "cross-site" }))).toBe(true);
});

test("the phone's own WebSocket Origin gets through", () => {
  // iOS sends the URL it dials as the Origin; the app sends its own scheme where it can.
  const url = "http://studio.tail1.ts.net:7777/ws?file=x";
  expect(isPage(req(url, { "user-agent": PHONE, origin: "http://studio.tail1.ts.net:7777" }))).toBe(
    false,
  );
  expect(isPage(req(url, { "user-agent": PHONE, origin: "ponzu-app://ios" }))).toBe(false);
  expect(isPage(req(url, { "user-agent": PHONE, origin: "http://other.tail1.ts.net:7777" }))).toBe(
    true,
  );
});

test("the phone reaches what the home screen and a canvas need, and nothing else", () => {
  const ok = (path: string, method = "GET") =>
    peerAllowed(
      new Request(`http://m:7777${path}`, { method, headers: { "user-agent": PHONE } }),
      path,
    );
  expect(ok("/api/info")).toBe(true);
  expect(ok("/api/macs")).toBe(true);
  expect(ok("/api/catalog")).toBe(true);
  expect(ok("/ws")).toBe(true);
  expect(ok("/files/abc/assets/a.png")).toBe(true);
  expect(ok("/mcp", "POST")).toBe(false);
  expect(ok("/api/files", "POST")).toBe(false);
  expect(ok("/files/abc/upload", "POST")).toBe(false);
  expect(ok("/")).toBe(false);
});

test("the phone names itself in its User-Agent", () => {
  expect(isPhone(req("http://m/", { "user-agent": PHONE }))).toBe(true);
  expect(isPhone(req("http://m/", { "user-agent": "Bun/1.4.2" }))).toBe(false);
});
