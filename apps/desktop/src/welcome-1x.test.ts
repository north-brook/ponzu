import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFor } from "./config.ts";
import { hadPonzu1x, takeWelcome1x } from "./legacy.ts";

/*
 * The welcome from Ponzu 1.x (legacy.ts): shown once, on a computer 1.x was on, by a release
 * someone is using. Each case is a fake home and a fake data folder in a temporary directory.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function computer() {
  const root = mkdtempSync(join(tmpdir(), "ponzu-welcome-"));
  dirs.push(root);
  const home = join(root, "home");
  const data = join(root, "Ponzu");
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  return {
    home,
    host: { home, env: {}, exists: existsSync },
    legacyRecord: join(data, "legacy-cleanup.json"),
    welcomeRecord: join(data, "welcome-1x.json"),
  };
}

const release = configFor(true, {}, false, "release");
const ponzuDev = configFor(true, {}, false, "dev");
const local = configFor(false, {});

function take(c: ReturnType<typeof computer>, build = release, driven = false) {
  return takeWelcome1x({
    build,
    driven,
    host: c.host,
    legacyRecord: c.legacyRecord,
    welcomeRecord: c.welcomeRecord,
    version: "2.0.0",
    now: () => new Date("2026-11-12T10:00:00Z"),
  });
}

test("a home with ~/.ponzu had 1.x; a clean one didn't", () => {
  const had = computer();
  mkdirSync(join(had.home, ".ponzu"));
  expect(hadPonzu1x(had.host, had.legacyRecord)).toBe(true);

  const clean = computer();
  expect(hadPonzu1x(clean.host, clean.legacyRecord)).toBe(false);
});

test("PONZU_HOME stands for ~/.ponzu, as it did for 1.x", () => {
  const c = computer();
  const elsewhere = join(c.home, "elsewhere");
  mkdirSync(elsewhere);
  expect(hadPonzu1x({ ...c.host, env: { PONZU_HOME: elsewhere } }, c.legacyRecord)).toBe(true);
  expect(hadPonzu1x({ ...c.host, env: { PONZU_HOME: join(c.home, "none") } }, c.legacyRecord)).toBe(
    false,
  );
});

test("a cleanup record with any step says 1.x was here; one with none doesn't", () => {
  const c = computer();
  writeFileSync(c.legacyRecord, JSON.stringify({ version: "2.0.0", at: "x", steps: [] }));
  expect(hadPonzu1x(c.host, c.legacyRecord)).toBe(false);
  writeFileSync(
    c.legacyRecord,
    JSON.stringify({ version: "2.0.0", at: "x", steps: [{ what: "w", outcome: "removed" }] }),
  );
  expect(hadPonzu1x(c.host, c.legacyRecord)).toBe(true);
  // A record that isn't JSON says nothing either way.
  writeFileSync(c.legacyRecord, "{");
  expect(hadPonzu1x(c.host, c.legacyRecord)).toBe(false);
});

test("shown once: true the first time, recorded, and false ever after", () => {
  const c = computer();
  mkdirSync(join(c.home, ".ponzu"));
  expect(take(c)).toBe(true);
  expect(JSON.parse(readFileSync(c.welcomeRecord, "utf8"))).toEqual({
    version: "2.0.0",
    at: "2026-11-12T10:00:00.000Z",
  });
  expect(take(c)).toBe(false);
  expect(take(c)).toBe(false);
});

test("a computer that never had 1.x never sees it, and nothing is recorded", () => {
  const c = computer();
  expect(take(c)).toBe(false);
  expect(existsSync(c.welcomeRecord)).toBe(false);
});

test("the smoke check and test builds never show it, nor Ponzu Dev or Ponzu Local", () => {
  for (const [build, driven] of [
    [release, true],
    [ponzuDev, false],
    [local, false],
  ] as const) {
    const c = computer();
    mkdirSync(join(c.home, ".ponzu"));
    expect(take(c, build, driven)).toBe(false);
    // Nothing written: a release used later on this computer still welcomes them.
    expect(existsSync(c.welcomeRecord)).toBe(false);
  }
});

test("when the record can't be written, it isn't shown, so it can never come back", () => {
  const c = computer();
  mkdirSync(join(c.home, ".ponzu"));
  const nowhere = { ...c, welcomeRecord: join(c.home, "no-such-folder", "welcome-1x.json") };
  expect(take(nowhere)).toBe(false);
});
