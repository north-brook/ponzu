import { expect, test } from "bun:test";
import { RenderError, withBudget, within } from "./stages.ts";

const never = new Promise<never>(() => {});

test("withBudget passes a result through", async () => {
  expect(await withBudget("load", Promise.resolve(7), 50)).toBe(7);
});

test("withBudget names the stage that ran out", async () => {
  const err = await withBudget("prepare", never, 20).catch((e) => e);
  expect(err).toBeInstanceOf(RenderError);
  expect(err).toMatchObject({ stage: "prepare", failure: "timeout" });
  expect(err.message).toContain("settling animations");
});

test("waiting too long in line means the host is busy", async () => {
  const err = await withBudget("queue", never, 20).catch((e) => e);
  expect(err).toMatchObject({ stage: "queue", failure: "host_busy" });
});

test("withBudget passes the work's own error through", async () => {
  const err = await withBudget("lint", Promise.reject(new Error("boom")), 50).catch((e) => e);
  expect(err.message).toBe("boom");
});

test("within says whether work settled in time, and never throws", async () => {
  expect(await within(Promise.resolve(), 50)).toBe(true);
  expect(await within(Promise.reject(new Error("broken image")), 50)).toBe(true);
  expect(await within(never, 20)).toBe(false);
});
