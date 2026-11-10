import { afterEach, expect, test } from "bun:test";
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
