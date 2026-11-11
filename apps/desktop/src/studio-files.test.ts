import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { studioFile } from "./studio-files.ts";

const parent = mkdtempSync(join(tmpdir(), "ponzu-studio-"));
const root = join(parent, "studio");
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "index.html"), "<!doctype html>");
writeFileSync(join(root, "assets/index-abc.js"), "");
writeFileSync(join(root, "favicon.svg"), "<svg/>");
writeFileSync(join(parent, "secret.json"), "{}");
afterAll(() => rmSync(parent, { recursive: true, force: true }));

test("the studio's files, by their path", () => {
  expect(studioFile(root, "ponzu-studio://app/assets/index-abc.js")).toEqual({
    path: join(root, "assets/index-abc.js"),
    type: "text/javascript; charset=utf-8",
  });
  expect(studioFile(root, "ponzu-studio://app/favicon.svg")?.type).toBe("image/svg+xml");
});

test("a route is the app's own: it gets index.html", () => {
  for (const url of ["ponzu-studio://app/", "ponzu-studio://app/design/dsn_1?page=pg_1"]) {
    expect(studioFile(root, url)?.path).toBe(join(root, "index.html"));
  }
});

test("nothing outside the studio, nothing missing, nothing of another host", () => {
  for (const url of [
    "ponzu-studio://app/../secret.json",
    "ponzu-studio://app/%2e%2e/secret.json",
    "ponzu-studio://app/assets/%2e%2e%2f%2e%2e%2fsecret.json",
    "ponzu-studio://app/missing.js",
    "ponzu-studio://app/index.html.bak",
    "ponzu-studio://other/index.html",
    "https://app/index.html",
    "ponzu-studio://app/%E0%A4%A",
  ]) {
    expect(studioFile(root, url)).toBeNull();
  }
});
