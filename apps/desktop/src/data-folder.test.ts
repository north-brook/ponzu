import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFor } from "./config.ts";
import { dataFolder, removeOnceExited, throwawayDataFolder } from "./data-folder.ts";

const home = mkdtempSync(join(tmpdir(), "ponzu-home-"));
const appData = join(home, "Library/Application Support");
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("each app has its own folder, and Ponzu Preview's is never 1.x's", () => {
  const folders = [
    configFor(true, {}, false, "release"),
    configFor(true, {}, false, "preview"),
    configFor(false, {}),
  ].map((config) => dataFolder(appData, config.appName, { smoke: false }));
  expect(folders).toEqual([
    join(appData, "Ponzu"),
    join(appData, "Ponzu Preview"),
    join(appData, "Ponzu Dev"),
  ]);
});

test("the smoke check runs on a throwaway folder, for every app, outside the person's home", () => {
  const parent = mkdtempSync(join(tmpdir(), "ponzu-tmp-"));
  try {
    for (const variant of ["release", "preview"] as const) {
      const { appName } = configFor(true, {}, false, variant);
      const folder = dataFolder(appData, appName, {
        smoke: true,
        temporary: () => throwawayDataFolder(parent),
      });
      expect(folder.startsWith(parent)).toBe(true);
      expect(folder.startsWith(appData)).toBe(false);
      expect(readdirSync(folder)).toEqual([]);
    }
    // Nothing was made where the apps keep their data.
    expect(existsSync(appData)).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "the throwaway folder goes once the app has exited, with what it wrote as it went",
  async () => {
    const folder = throwawayDataFolder();
    const app = spawn("/bin/sh", ["-c", `sleep 0.4; echo late > "${folder}/Local State"`]);
    removeOnceExited(folder, app.pid!);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(folder)).toBe(true);
    await new Promise((resolve) => app.once("exit", resolve));
    for (let tries = 0; existsSync(folder) && tries < 40; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(existsSync(folder)).toBe(false);
  },
);
