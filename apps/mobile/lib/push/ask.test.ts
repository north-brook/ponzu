import { expect, test } from "bun:test";
import { FakeClock } from "@ponzu/client/testing";
import { KEPT_KEYS } from "../cloud/sign-out";
import {
  afterComment,
  asked,
  declined,
  NEVER_ASKED,
  PING_ASK_KEY,
  type PingAsk,
  parseAsk,
  REASK_AFTER_MS,
  readAsk,
  writeAsk,
} from "./ask";

const DAY = 24 * 60 * 60 * 1000;

test("the first comment from this phone asks, when iOS hasn't been asked", () => {
  expect(afterComment({ pushOn: true, permission: "undetermined", ask: NEVER_ASKED, now: 0 })).toBe(
    "ask",
  );
});

test("with pings off at the API, nothing is asked or registered, whatever iOS says", () => {
  for (const permission of ["undetermined", "granted", "denied"] as const) {
    expect(afterComment({ pushOn: false, permission, ask: NEVER_ASKED, now: 0 })).toBe("none");
  }
});

test("allowed already: register without a sheet; refused: never a sheet", () => {
  expect(afterComment({ pushOn: true, permission: "granted", ask: NEVER_ASKED, now: 0 })).toBe(
    "register",
  );
  expect(afterComment({ pushOn: true, permission: "denied", ask: NEVER_ASKED, now: 0 })).toBe(
    "none",
  );
});

test("Not now: quiet for seven days, then once more after a comment, then never", async () => {
  const clock = new FakeClock(Date.UTC(2026, 10, 13));
  let ask: PingAsk = asked(NEVER_ASKED, clock.now());
  ask = declined(ask, clock.now());
  const next = () =>
    afterComment({ pushOn: true, permission: "undetermined", ask, now: clock.now() });

  expect(next()).toBe("none");
  await clock.advance(REASK_AFTER_MS - 1);
  expect(next()).toBe("none");
  await clock.advance(1);
  expect(next()).toBe("ask");

  ask = declined(asked(ask, clock.now()), clock.now());
  await clock.advance(30 * DAY);
  expect(next()).toBe("none");
  await clock.advance(365 * DAY);
  expect(next()).toBe("none");
});

test("a sheet left unanswered (the app closed under it) counts as Not now from when it showed", async () => {
  const clock = new FakeClock(0);
  const ask = asked(NEVER_ASKED, clock.now());
  await clock.advance(REASK_AFTER_MS - 1);
  expect(afterComment({ pushOn: true, permission: "undetermined", ask, now: clock.now() })).toBe(
    "none",
  );
  await clock.advance(1);
  expect(afterComment({ pushOn: true, permission: "undetermined", ask, now: clock.now() })).toBe(
    "ask",
  );
});

test("what was asked is kept on the phone, survives sign-out, and anything unreadable is as never asked", async () => {
  expect(KEPT_KEYS).toContain(PING_ASK_KEY);
  const kept = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => kept.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      kept.set(key, value);
    },
  };
  expect(await readAsk(storage)).toEqual(NEVER_ASKED);
  const ask = declined(asked(NEVER_ASKED, 1000), 2000);
  await writeAsk(storage, ask);
  expect(await readAsk(storage)).toEqual({ times: 1, askedAt: 1000, declinedAt: 2000 });
  expect(parseAsk("later")).toEqual(NEVER_ASKED);
  expect(parseAsk('{"times":-3,"askedAt":"x"}')).toEqual(NEVER_ASKED);
  const broken = {
    getItem: async () => {
      throw new Error("locked");
    },
    setItem: async () => {
      throw new Error("locked");
    },
  };
  expect(await readAsk(broken)).toEqual(NEVER_ASKED);
  await writeAsk(broken, ask);
});
