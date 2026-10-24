import { expect, test } from "bun:test";
import {
  baseUrl,
  hostOf,
  isMagicDns,
  type Mac,
  PairError,
  pairMessage,
  parsePairUrl,
  upsertMac,
  wakeUrl,
} from "./mac";
import { classify } from "./net";
import { afterFirstAsk, settle } from "./reach-rules";

const mac = (over: Partial<Mac> = {}): Mac => ({
  id: "workstation.tail1.ts.net",
  name: "workstation",
  dns: "workstation.tail1.ts.net",
  kind: "laptop",
  addedAt: 1,
  via: "qr",
  ...over,
});

test("the pairing code names a Mac by its MagicDNS name", () => {
  expect(parsePairUrl("ponzu://pair?host=workstation.tail1.ts.net&v=1")).toBe(
    "workstation.tail1.ts.net",
  );
  expect(parsePairUrl("ponzu://pair/?host=air.tail1.ts.net")).toBe("air.tail1.ts.net");
  // A later version of the code, another app's code, or a host that isn't one.
  expect(parsePairUrl("ponzu://pair?host=air.tail1.ts.net&v=2")).toBeNull();
  expect(parsePairUrl("https://example.com/?host=x")).toBeNull();
  expect(parsePairUrl("ponzu://pair?host=a%20b")).toBeNull();
  expect(parsePairUrl("ponzu://pair?v=1")).toBeNull();
  // An address is no Mac: a link naming one could point the phone at anyone on the Wi-Fi.
  for (const host of ["192.168.1.50:8080", "10.0.0.5", "workstation.local", "evil.example.com"])
    expect(parsePairUrl(`ponzu://pair?host=${host}&v=1`)).toBeNull();
  // Tailscale's trailing dot is fine.
  expect(parsePairUrl("ponzu://pair?host=air.tail1.ts.net.&v=1")).toBe("air.tail1.ts.net");
});

test("a tailnet name is one ending in ts.net, and nothing else", () => {
  for (const host of ["workstation.tail023d74.ts.net", "a.b.ts.net", "air.tail1.ts.net."])
    expect(isMagicDns(host)).toBe(true);
  for (const host of [
    "192.168.1.50",
    "192.168.1.50:7777",
    "workstation.tail1.ts.net:7777",
    "ts.net",
    "workstation.ts.net.evil.com",
    "workstation.local",
    "",
  ])
    expect(isMagicDns(host)).toBe(false);
});

test("a Mac is reached on 7777 and woken on 7778, or at the development address", () => {
  expect(baseUrl(mac())).toBe("http://workstation.tail1.ts.net:7777");
  expect(wakeUrl(mac())).toBe("http://workstation.tail1.ts.net:7778/");
  const dev = mac({ address: "127.0.0.1:7792" });
  expect(baseUrl(dev)).toBe("http://127.0.0.1:7792");
  expect(wakeUrl(dev)).toBe("http://127.0.0.1:7778/");
  expect(hostOf("127.0.0.1:7792")).toBe("127.0.0.1");
  expect(hostOf("air.tail1.ts.net")).toBe("air.tail1.ts.net");
});

test("a Mac another names keeps how it was paired and when it was added", () => {
  const saved = [mac({ via: "bonjour", addedAt: 5, lastAnsweredAt: 100 })];
  const next = upsertMac(saved, mac({ via: "peer", addedAt: 9, name: "studio" }));
  expect(next).toHaveLength(1);
  expect(next[0]).toMatchObject({
    via: "bonjour",
    addedAt: 5,
    name: "studio",
    lastAnsweredAt: 100,
  });
  expect(upsertMac(saved, mac({ id: "air", dns: "air" }))).toHaveLength(2);
});

test("iOS's network errors say how a Mac failed", () => {
  expect(classify("Could not connect to the server.", false)).toBe("refused");
  expect(classify("A server with the specified hostname could not be found.", false)).toBe("dns");
  expect(classify("The Internet connection appears to be offline.", false)).toBe("offline");
  expect(classify("The request timed out.", false)).toBe("timeout");
  expect(classify("", true)).toBe("timeout");
  expect(classify("Something else", false)).toBe("other");
});

test("refused means Ponzu quit: knock and wait; silence means asleep", () => {
  expect(afterFirstAsk({ ok: true })).toBe("answer");
  expect(afterFirstAsk({ ok: false, failure: "refused" })).toBe("wake");
  expect(afterFirstAsk({ ok: false, failure: "timeout" })).toBe("asleep");
  expect(afterFirstAsk({ ok: false, failure: "dns" })).toBe("unreachable");
  expect(afterFirstAsk({ ok: false, failure: "offline" })).toBe("unreachable");
});

test("no tailnet only when no Mac could even be tried", () => {
  expect(settle(["unreachable", "unreachable"])).toBe("noTailnet");
  // One timed out, so packets reached the tailnet: the rest are asleep.
  expect(settle(["unreachable", "asleep"])).toBe("asleep");
  expect(settle(["wake"])).toBe("asleep");
  expect(settle([])).toBe("asleep");
});

test("a Mac too old to pair says which Ponzu answered", () => {
  const msg = pairMessage(new PairError("tooOld", "old", "0.1.0"), "workstation");
  expect(msg).toStartWith("workstation answered with Ponzu 0.1.0, which can't pair yet.");
  expect(pairMessage(new PairError("unreachable", "x"), "spare")).toContain("didn't answer");
  expect(pairMessage(new Error("x"), "spare")).toBe("Couldn't connect to spare.");
});
