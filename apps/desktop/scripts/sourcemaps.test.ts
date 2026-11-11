import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSourceMaps, uploadsSourceMaps } from "./sourcemaps.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function built(): string {
  const dir = mkdtempSync(join(tmpdir(), "ponzu-maps-"));
  dirs.push(dir);
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "assets", "index.js"),
    "console.log(1);\n//# sourceMappingURL=index.js.map",
  );
  writeFileSync(join(dir, "assets", "index.js.map"), "{}");
  return dir;
}

const release = { name: "ponzu-desktop", version: "2.0.0" };

/** A stand-in for the PostHog CLI that keeps what it was asked, and answers `ok`. */
function cli(calls: string[][], ok = true) {
  return (args: string[]) => {
    calls.push(args);
    return { ok, output: ok ? "" : "503" };
  };
}
const credentials = { POSTHOG_CLI_API_KEY: "phx_x", POSTHOG_CLI_PROJECT_ID: "1" };

test("without the CLI's credentials nothing is uploaded, and no map ships", () => {
  const dir = built();
  const calls: string[][] = [];
  expect(uploadsSourceMaps({})).toBe(false);
  expect(prepareSourceMaps([dir], {}, release, cli(calls))).toBe("strip");
  expect(calls).toEqual([]);
  expect(existsSync(join(dir, "assets", "index.js.map"))).toBe(false);
  expect(readFileSync(join(dir, "assets", "index.js"), "utf8")).not.toContain("sourceMappingURL");
});

test("with them, each folder is injected then uploaded, and the maps go after", () => {
  const dir = built();
  const calls: string[][] = [];
  expect(uploadsSourceMaps(credentials)).toBe(true);
  prepareSourceMaps([dir], credentials, release, cli(calls));
  expect(calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
    "sourcemap inject",
    "sourcemap upload",
  ]);
  expect(calls[1]).toContain("--delete-after");
  expect(calls[0]).toContain("2.0.0");
  expect(existsSync(join(dir, "assets", "index.js.map"))).toBe(false);
});

test("PostHog failing costs the stack traces, never the build", () => {
  const dir = built();
  const calls: string[][] = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    prepareSourceMaps([dir], credentials, release, cli(calls, false));
  } finally {
    console.warn = warn;
  }
  expect(calls).toHaveLength(1);
  expect(existsSync(join(dir, "assets", "index.js.map"))).toBe(false);
});
