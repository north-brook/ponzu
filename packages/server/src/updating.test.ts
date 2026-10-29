import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearUpdating,
  markUpdating,
  replacedByUpdate,
  settleUpdate,
  UPDATING_WITHIN,
  updating,
} from "./updating.ts";

let dir: string;
const saved = process.env.PONZU_HOME;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-updating-"));
  // Never the real ~/.ponzu.
  process.env.PONZU_HOME = join(dir, "home");
});

afterAll(async () => {
  if (saved === undefined) delete process.env.PONZU_HOME;
  else process.env.PONZU_HOME = saved;
  await rm(dir, { recursive: true, force: true });
});

test("while an update installs, only the Ponzu it replaces stays out of the way", () => {
  expect(updating()).toBe(null);
  expect(replacedByUpdate("1.59.1")).toBe(false);
  markUpdating("1.59.1", "1.68.2");
  expect(updating()).toMatchObject({ from: "1.59.1", to: "1.68.2" });
  // The old Ponzu, launched again by an agent, would stop the install.
  expect(replacedByUpdate("1.59.1")).toBe(true);
  // The updated one is the Ponzu agents are waiting for.
  expect(replacedByUpdate("1.68.2")).toBe(false);
  clearUpdating();
});

test("an install that never finished doesn't keep Ponzu from starting", () => {
  markUpdating("1.59.1", "1.68.2", Date.now() - UPDATING_WITHIN - 1000);
  expect(updating()).toBe(null);
  expect(replacedByUpdate("1.59.1")).toBe(false);
  clearUpdating();
});

test("the next launch says whether the update went in, once", () => {
  expect(settleUpdate("1.68.2")).toBeUndefined();
  markUpdating("1.59.1", "1.68.2");
  expect(settleUpdate("1.68.2")).toBe("installed");
  expect(existsSync(join(dir, "home/updating.json"))).toBe(false);
  expect(settleUpdate("1.68.2")).toBeUndefined();
  markUpdating("1.59.1", "1.68.2");
  expect(settleUpdate("1.59.1")).toBe("interrupted");
});
