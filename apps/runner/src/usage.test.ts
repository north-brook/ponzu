import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelUsage } from "./api/protocol.ts";
import { UsageMeter } from "./usage.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function path(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-usage-"));
  dirs.push(dir);
  return join(dir, "usage.json");
}

const total = (model: string, inputTokens: number): ModelUsage => ({
  model,
  inputTokens,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
});

test("each turn is the change in the running totals, by model, leaving out models it did not use", async () => {
  const meter = new UsageMeter(await path());
  expect(meter.turn("s1", [total("opus", 100)])).toEqual([total("opus", 100)]);
  expect(meter.turn("s1", [total("opus", 160), total("haiku", 5)])).toEqual([
    { ...total("opus", 60), outputTokens: 0 },
    total("haiku", 5),
  ]);
});

test("a runner that starts again counts from the totals the last one saw, never below zero", async () => {
  const file = await path();
  new UsageMeter(file).turn("s1", [total("opus", 100)]);
  const again = new UsageMeter(file);
  // Claude Code restored less than was last reported (it crashed): that turn counts nothing.
  expect(again.turn("s1", [total("opus", 90)])).toEqual([]);
  expect(again.turn("s1", [total("opus", 120)])).toEqual([
    { ...total("opus", 30), outputTokens: 0 },
  ]);
  // Another session starts from nothing.
  expect(new UsageMeter(file).turn("s2", [total("opus", 7)])).toEqual([total("opus", 7)]);
});

test("the totals a checkpoint carries are the disk's, and only for the session it saves", async () => {
  const file = await path();
  const meter = new UsageMeter(file);
  expect(meter.saved("s1")).toBeNull();
  meter.turn("s1", [total("opus", 100)]);
  expect(JSON.parse(meter.saved("s1")!)).toEqual({ sessionId: "s1", totals: [total("opus", 100)] });
  expect(meter.saved("s2")).toBeNull();
});

test("a disk that came back old takes the checkpoint's totals: the turn reported before is not counted again", async () => {
  const file = await path();
  // Before the checkpoint: two turns reported, 100 then 160.
  const before = new UsageMeter(file);
  before.turn("s1", [total("opus", 100)]);
  before.turn("s1", [total("opus", 160)]);
  const carried = before.saved("s1")!;
  // The disk comes back as it was after the first turn.
  const old = await path();
  new UsageMeter(old).turn("s1", [total("opus", 100)]);
  const after = new UsageMeter(old);
  expect(after.restore(carried)).toBe(true);
  // Claude Code resumes from the transcript at 160: the next turn is only what it adds.
  expect(after.turn("s1", [total("opus", 175)])).toEqual([
    { ...total("opus", 15), outputTokens: 0 },
  ]);
});

test("a restore never lowers the disk's totals: each count is the larger", async () => {
  const file = await path();
  const meter = new UsageMeter(file);
  meter.turn("s1", [total("opus", 200), { ...total("haiku", 3), outputTokens: 9 }]);
  const older = JSON.stringify({
    sessionId: "s1",
    totals: [{ ...total("opus", 150), outputTokens: 4 }, total("haiku", 1), total("sonnet", 20)],
  });
  expect(meter.restore(older)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    sessionId: "s1",
    totals: [
      { ...total("opus", 200), outputTokens: 4 },
      { ...total("haiku", 3), outputTokens: 9 },
      total("sonnet", 20),
    ],
  });
  // Nothing in it above the disk's: nothing changes.
  expect(meter.restore(JSON.stringify({ sessionId: "s1", totals: [total("opus", 10)] }))).toBe(
    false,
  );
  expect(meter.turn("s1", [total("opus", 200)])).toEqual([]);
});

test("totals of another session replace the disk's, and a file that is not totals is ignored", async () => {
  const file = await path();
  const meter = new UsageMeter(file);
  meter.turn("old", [total("opus", 500)]);
  expect(meter.restore(JSON.stringify({ sessionId: "s2", totals: [total("opus", 40)] }))).toBe(
    true,
  );
  expect(meter.turn("s2", [total("opus", 50)])).toEqual([
    { ...total("opus", 10), outputTokens: 0 },
  ]);
  for (const junk of ["not json", "{}", '{"sessionId":"s2","totals":[{"model":"opus"}]}'])
    expect(meter.restore(junk)).toBe(false);
  const negative = { sessionId: "s2", totals: [{ ...total("opus", -1) }] };
  expect(meter.restore(JSON.stringify(negative))).toBe(false);
});
