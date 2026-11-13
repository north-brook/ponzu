import { expect, test } from "bun:test";
import { HeldEvents } from "./held.ts";

test("nothing unsettled and nothing settled since: the runner does not say, as before", () => {
  const held = new HeldEvents();
  held.settled(4);
  const mark = held.begin([]);
  expect(mark.read()).toBeUndefined();
});

test("an event still on its way into the session bounds the archive below it", () => {
  const held = new HeldEvents();
  held.settled(4);
  // 7 and 9 were handed over and are not in the session yet.
  const mark = held.begin([9, 7]);
  expect(mark.read()).toBe(6);
});

test("an event that settles while the archive is packed or uploaded is not in it", () => {
  const held = new HeldEvents();
  held.settled(4);
  const mark = held.begin([]);
  // The next turn's message went into the session while the last turn's checkpoint was uploading.
  held.settled(5);
  expect(mark.read()).toBe(4);
  // A later archive's mark begins after it: it is in that one.
  const next = held.begin([]);
  expect(next.read()).toBeUndefined();
});

test("an ended mark follows nothing more, and is never below zero", () => {
  const held = new HeldEvents();
  const mark = held.begin([1]);
  expect(mark.read()).toBe(0);
  mark.end();
  mark.end();
  held.settled(1);
  expect(mark.read()).toBe(0);
});
