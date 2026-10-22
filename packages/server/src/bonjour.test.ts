import { expect, test } from "bun:test";
import { advertise, bonjourArgs } from "./bonjour.ts";

const advert = { name: "workstation", host: "workstation.tail1.ts.net", port: 7777 };

test("advertises the tailnet name for the phone to connect to, not the LAN address", () => {
  expect(bonjourArgs(advert)).toEqual([
    "-R",
    "workstation",
    "_ponzu._tcp",
    "local",
    "7777",
    "v=1",
    "host=workstation.tail1.ts.net",
    "name=workstation",
  ]);
});

test("PONZU_BONJOUR=0 keeps Ponzu off the local network", () => {
  const before = process.env.PONZU_BONJOUR;
  process.env.PONZU_BONJOUR = "0";
  try {
    expect(advertise(advert)).toBeNull();
  } finally {
    if (before === undefined) delete process.env.PONZU_BONJOUR;
    else process.env.PONZU_BONJOUR = before;
  }
});
