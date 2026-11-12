// One real ping to the founder's own phone through Expo, then its receipt. Skipped unless
// PONZU_LIVE_PUSH=1 with EXPO_ACCESS_TOKEN (Ponzu's Expo project) and PONZU_LIVE_PUSH_TOKEN (an
// Expo push token of that phone, from the cloud iPhone app). CI never sets them. No token is
// printed: a failure names only codes.
//
//   PONZU_LIVE_PUSH=1 bun test apps/api/src/deps/push.live.test.ts
import { describe, expect, test } from "bun:test";
import { systemClock } from "@ponzu/sandbox";
import { createLogger, type LogLine } from "../http/log.ts";
import { createExpoPush } from "./push.ts";

const env = process.env;
const configured =
  env.PONZU_LIVE_PUSH === "1" && !!env.EXPO_ACCESS_TOKEN && !!env.PONZU_LIVE_PUSH_TOKEN;

/** How long Expo may take to settle a receipt here. It allows itself up to 30 minutes under load. */
const RECEIPT_DEADLINE_MS = 120_000;
const RECEIPT_POLL_MS = 5_000;

describe.skipIf(!configured)("Expo push, for real", () => {
  test(
    "a ping is accepted and its receipt settles ok",
    async () => {
      const logs: LogLine[] = [];
      const push = createExpoPush({
        accessToken: env.EXPO_ACCESS_TOKEN ?? "",
        clock: systemClock,
        log: createLogger((line) => logs.push(line)),
      });
      const [ticket] = await push.send([
        {
          to: env.PONZU_LIVE_PUSH_TOKEN ?? "",
          title: "Ponzu",
          body: "A test ping from push.live.test.ts.",
          sound: "default",
          priority: "high",
          interruptionLevel: "active",
          ttl: 600,
          data: { v: 1, k: "test" },
        },
      ]);
      expect(ticket?.ok ? "ok" : ticket?.error).toBe("ok");
      const id = ticket?.ok ? ticket.id : "";

      // A poll with a deadline: Expo settles a receipt when Apple has answered.
      const until = systemClock.now() + RECEIPT_DEADLINE_MS;
      let receipt = (await push.receipts([id]))[id];
      while (!receipt && systemClock.now() < until) {
        await systemClock.sleep(RECEIPT_POLL_MS);
        receipt = (await push.receipts([id]))[id];
      }
      expect(receipt?.ok ? "ok" : (receipt?.error ?? "not settled")).toBe("ok");
      expect(logs).toEqual([]);
    },
    RECEIPT_DEADLINE_MS + 30_000,
  );
});
