import { expect, test } from "bun:test";
import { HeldEvents } from "./held.ts";

test("a mark always says a number: 0 while the runner knows of nothing the session took in", () => {
  const held = new HeldEvents();
  expect(held.begin([]).read()).toBe(0);
});

test("with nothing unsettled the mark is the newest event taken in as the archive was taken", () => {
  const held = new HeldEvents();
  held.settled(4);
  const mark = held.begin([]);
  expect(mark.read()).toBe(4);
  // Taken in after the archive (as the checkpoint's call is on its way): not in it.
  held.settled(5);
  held.handedThrough(9);
  expect(mark.read()).toBe(4);
});

test("a claim that was not full says the session took in everything up to its head", () => {
  const held = new HeldEvents();
  // Events up to 12 were delivered before this process, or handed to it and settled.
  held.handedThrough(12);
  expect(held.begin([]).read()).toBe(12);
  // One of them is still on its way into the session: the archive stops below it.
  expect(held.begin([10]).read()).toBe(9);
});

test("an event still on its way into the session bounds the archive below it", () => {
  const held = new HeldEvents();
  held.settled(4);
  held.handedThrough(9);
  // 7 and 9 were handed over and are not in the session yet.
  expect(held.begin([9, 7]).read()).toBe(6);
});

test("an event that settles while the archive is packed or uploaded is not in it", () => {
  const held = new HeldEvents();
  held.settled(4);
  held.handedThrough(6);
  const mark = held.begin([5, 6]);
  // The next turn's message went into the session while the last turn's checkpoint was uploading.
  held.settled(5);
  expect(mark.read()).toBe(4);
  // A later archive's mark begins after it: it is in that one.
  expect(held.begin([6]).read()).toBe(5);
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
