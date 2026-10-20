import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
let mod: typeof import("./telemetry.ts");
const file = () => join(home, "telemetry.json");

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "ponzu-home-"));
  process.env.PONZU_HOME = home;
  // A release build's key, so only the person's switches turn it off.
  process.env.PONZU_POSTHOG_KEY = "phc_test";
  for (const k of ["PONZU_TELEMETRY", "DO_NOT_TRACK", "CI"]) delete process.env[k];
  mod = await import("./telemetry.ts");
});

afterAll(async () => {
  delete process.env.PONZU_HOME;
  delete process.env.PONZU_POSTHOG_KEY;
  await rm(home, { recursive: true, force: true });
});

const status = async (arg?: string) => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await mod.telemetryCommand(arg);
    return String(log.mock.calls.at(-1)?.[0]);
  } finally {
    log.mockRestore();
  }
};

test("ponzu telemetry off sticks, and keeps the install id", async () => {
  expect(await status("on")).toContain("Telemetry is on");
  const { id } = JSON.parse(await readFile(file(), "utf8"));
  expect(await status("off")).toContain("Telemetry is off");
  expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ id, enabled: false });
  expect(await mod.startTelemetry({ version: "test", command: "serve" })).toBeNull();
});

test("an unreadable settings file means off, and is left as it is", async () => {
  await writeFile(file(), "{ not json");
  expect(await status()).toContain("can't be read");
  expect(await mod.startTelemetry({ version: "test", command: "serve" })).toBeNull();
  expect(await mod.telemetryNotice()).toBeNull();
  expect(await readFile(file(), "utf8")).toBe("{ not json");
});
