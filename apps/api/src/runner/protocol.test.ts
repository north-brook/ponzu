import { expect, test } from "bun:test";
import { newId } from "@ponzu/db";
import { TurnLog } from "@ponzu/runner/turn";
import { Thread } from "./protocol.ts";

test("the runner's record of a very long turn is one the API takes", () => {
  // 120 different steps, then 300 messages each followed by a step of its own: the most the
  // record can be asked to hold, from a watch-mode session that runs for hours.
  const log = new TurnLog(newId("ti"));
  const step = (done: string) => ({ doing: null, done, weight: 2 });
  for (let i = 0; i < 120; i++) log.add(step(`Edited src/components/a-rather-long-name-${i}.tsx`));
  for (let i = 0; i < 300; i++) {
    log.said(newId("ti"));
    log.add(step(`Drew "Board ${i}"`));
    log.add(step(`Drew "Board ${i}" again`));
  }
  const payload = log.payload({ label: "Thinking", artboards: [], ended: "done" });
  const write = { items: [{ id: log.id, kind: "tool", streaming: false, payload }] };
  const parsed = Thread.safeParse(write);
  expect(parsed.error?.issues).toBeUndefined();
  expect(payload.turn!.log.reduce((n, g) => n + g.count, 0)).toBe(720);
  expect(JSON.stringify(payload).length).toBeLessThan(32_000);
});
