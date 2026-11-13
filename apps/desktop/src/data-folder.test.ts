import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFor } from "./config.ts";
import { dataFolder, removeOnceExited, throwawayDataFolder } from "./data-folder.ts";
import { built } from "./testing.ts";

const home = mkdtempSync(join(tmpdir(), "ponzu-home-"));
const appData = join(home, "Library/Application Support");
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("each app has its own folder, and Ponzu Dev's is never 1.x's", () => {
  const folders = [
    configFor(true, {}, built()),
    configFor(true, {}, built({ variant: "dev" })),
    configFor(false, {}, built()),
  ].map((config) => dataFolder(appData, config.appName, { smoke: false }));
  expect(folders).toEqual([
    join(appData, "Ponzu"),
    join(appData, "Ponzu Dev"),
    join(appData, "Ponzu Local"),
  ]);
});

test("the smoke check runs on a throwaway folder, for every app, outside the person's home", () => {
  const parent = mkdtempSync(join(tmpdir(), "ponzu-tmp-"));
  try {
    for (const variant of ["release", "dev"] as const) {
      const { appName } = configFor(true, {}, built({ variant }));
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
    // The app runs until the test lets it go, by its standard input: no clock decides whether
    // it is still running when the folder is looked at.
    const app = spawn("/bin/sh", ["-c", 'read go; echo late > "$0/Local State"', folder], {
      stdio: ["pipe", "ignore", "inherit"],
    });
    const exited = new Promise<number | null>((resolve) => app.once("exit", resolve));
    // The shell that removes the folder sleeps between its looks at the app. The `sleep` it finds
    // notes each time it is called, so the test sees that shell go back to waiting. PATH is the
    // test's only for the synchronous spawn inside removeOnceExited.
    const tools = mkdtempSync(join(tmpdir(), "ponzu-tools-"));
    const sleeps = join(tools, "sleeps");
    writeFileSync(sleeps, "");
    writeFileSync(
      join(tools, "sleep"),
      `#!/bin/sh\necho >> '${sleeps}'\nexec '${Bun.which("sleep")}' "$@"\n`,
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${tools}:${path}`;
    try {
      removeOnceExited(folder, app.pid!);
    } finally {
      process.env.PATH = path;
    }
    try {
      // The folder stays while the app runs. Seen without a clock: the shell that removes it
      // goes back to waiting twice, so it has looked at the running app, slept, and looked
      // again, and the folder is still there. A shell that removes it without waiting, or
      // between one look and the next, ends this loop with the folder gone instead.
      while (existsSync(folder) && readFileSync(sleeps, "utf8").length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(existsSync(folder)).toBe(true);
      app.stdin!.end("go\n");
      // Its last write lands in the folder: had the folder gone while it ran, it would fail.
      expect(await exited).toBe(0);
      while (existsSync(folder)) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(existsSync(folder)).toBe(false);
    } finally {
      app.kill();
      rmSync(tools, { recursive: true, force: true });
    }
  },
);
