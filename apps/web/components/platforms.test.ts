import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PLATFORMS as RELEASED } from "../../../scripts/release-assets.ts";
import { AFTER_INSTALL, DRAWN_REPO } from "../app/download/steps.tsx";
import config from "../next.config.ts";
import { asset, guide, IPHONE_PATH, isDownloadHref, OSES, PLATFORMS } from "./platforms.ts";
import { IPHONE_URL_TARGET } from "./site.ts";

test("the site links exactly the downloads every release carries", () => {
  // scripts/release-assets.ts refuses a release without these files; the site links them by name.
  expect(OSES).toEqual(Object.keys(RELEASED) as typeof OSES);
  for (const os of OSES) {
    const p = PLATFORMS[os];
    expect([p.file, ...(p.alt ? [p.alt] : [])]).toEqual(RELEASED[os].downloads);
  }
  expect(asset("Ponzu-arm64.dmg")).toBe(
    "https://github.com/north-brook/ponzu/releases/latest/download/Ponzu-arm64.dmg",
  );
});

test("each desktop's install steps start its download", () => {
  expect(OSES.map(guide)).toEqual([
    "/download/mac?start=1",
    "/download/windows?start=1",
    "/download/linux?start=1",
  ]);
});

test("download clicked counts the install pages, /iphone and the installers, and nothing else", () => {
  const counted = [
    "/download",
    "/download?start=1",
    "/download/mac?start=1",
    "/download/linux",
    "/iphone",
    ...OSES.flatMap((os) => [PLATFORMS[os].file, PLATFORMS[os].alt ?? []].flat()).map(asset),
  ];
  for (const href of counted) expect([href, isDownloadHref(href)]).toEqual([href, true]);
  const ignored = [
    "/",
    "/downloads",
    "/iphone-help",
    "/pricing",
    "https://github.com/north-brook/ponzu/releases",
    "https://example.com/Ponzu-arm64.dmg",
    "https://testflight.apple.com/join/x",
  ];
  for (const href of ignored) expect([href, isDownloadHref(href)]).toEqual([href, false]);
});

test("/iphone is a temporary redirect to the iPhone app's current home", async () => {
  // The Mac's setup QR code (apps/studio/src/cloud/setup/iphone-step.tsx) prints this address,
  // so it must keep answering, and a 307 lets the target move to the App Store without caches
  // holding the old one.
  const redirects = await config.redirects!();
  const iphone = redirects.filter((r) => r.source === IPHONE_PATH);
  expect(iphone).toEqual([
    { source: "/iphone", destination: IPHONE_URL_TARGET ?? "/download", permanent: false },
  ]);
  const studio = readFileSync(
    join(import.meta.dir, "../../studio/src/cloud/setup/iphone-step.tsx"),
    "utf8",
  );
  expect(studio).toContain(`"https://ponzu.design${IPHONE_PATH}"`);
});

const WEB = join(import.meta.dir, "..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
/** The download pages and the pieces they are made of. */
const DOWNLOAD_SOURCES = [
  ...files(join(WEB, "app/download")),
  ...["download-button.tsx", "handoff.tsx", "platforms.ts"].map((f) => join(WEB, "components", f)),
].filter((p) => !p.endsWith(".test.ts"));

test("the download pages say nothing of the 1.x CLI, agents or MCP", () => {
  const words = /bunx|ponzu serve|\bMCP\b|\bCLI\b|\bagents?\b|Codex|Cursor|pairs with/;
  const found = DOWNLOAD_SOURCES.flatMap((p) =>
    readFileSync(p, "utf8")
      .split("\n")
      .filter((line) => words.test(line))
      .map((line) => `${p.slice(WEB.length + 1)}: ${line.trim()}`),
  );
  expect(found).toEqual([]);
});

test("the iPhone links on the download pages go through /iphone, never straight to the store", () => {
  const direct = DOWNLOAD_SOURCES.filter((p) =>
    /TESTFLIGHT\b|testflight\.apple\.com|apps\.apple\.com/.test(
      // The store's name may appear in a label; a link to it may not.
      readFileSync(p, "utf8").replace(/\.includes\("testflight\.apple\.com"\)/g, ""),
    ),
  );
  expect(direct).toEqual([]);
});

test("the steps after the install are the site design's words, on every desktop", () => {
  expect(AFTER_INSTALL).toEqual([
    "Open Ponzu and continue with GitHub.",
    "Install Ponzu on the GitHub account where your repos live, connect Claude, and describe what you want to make.",
  ]);
  for (const os of ["mac", "windows", "linux"]) {
    const page = readFileSync(join(WEB, `app/download/${os}/page.tsx`), "utf8");
    expect(page).toMatch(/Steps installer=/);
  }
  // The drawn repo is made up, owned by the gallery's fictional person.
  expect(DRAWN_REPO).toBe("adapark/kettle");
});
