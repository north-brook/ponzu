import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { designPath, desktopEntry, launchArgs, mimeXml, registryCommands } from "./designs.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-designs-"));
  await mkdir(join(dir, "Logo.design"));
  await writeFile(join(dir, "Logo.design/design.json"), "{}");
  await mkdir(join(dir, "plain/sub"), { recursive: true });
  await writeFile(join(dir, "plain/design.json"), "{}");
});

afterAll(() => rm(dir, { recursive: true, force: true }));

test("a design named by its folder, its design.json, or a folder holding one", () => {
  expect(designPath(join(dir, "Logo.design"))).toBe(join(dir, "Logo.design"));
  expect(designPath(`${join(dir, "Logo.design")}/`)).toBe(join(dir, "Logo.design"));
  expect(designPath(join(dir, "Logo.design/design.json"))).toBe(join(dir, "Logo.design"));
  expect(designPath(join(dir, "plain"))).toBe(join(dir, "plain"));
  expect(designPath(join(dir, "Logo.design/Design.JSON"))).toBe(join(dir, "Logo.design"));
  expect(designPath(join(dir, "plain/sub"))).toBe(null);
  expect(designPath(join(dir, "Logo.design/tokens.css"))).toBe(null);
  expect(designPath("--no-sandbox")).toBe(null);
  expect(designPath("https://example.com/a.design")).toBe(null);
});

test("a launch's links and designs, relative to where it was launched", () => {
  expect(
    launchArgs(
      [
        "/opt/Ponzu/ponzu",
        "--no-sandbox",
        "--allow-file-access-from-files",
        "ponzu://open?file=/a.design",
        "Logo.design/design.json",
        "plain",
        ".",
      ],
      dir,
    ),
  ).toEqual({
    links: ["ponzu://open?file=/a.design"],
    designs: [join(dir, "Logo.design"), join(dir, "plain")],
  });
  // The executable itself is never a design, even one in a folder that holds one.
  expect(launchArgs([join(dir, "plain")], dir)).toEqual({ links: [], designs: [] });
});

test("Linux knows design.json by its whole name, ahead of *.json", () => {
  const xml = mimeXml();
  expect(xml).toContain('<mime-type type="application/x-ponzu-design">');
  expect(xml).toContain('<glob pattern="design.json" weight="80"/>');
  expect(xml).not.toContain("*.json");
});

test("an AppImage's desktop entry opens designs and links with that AppImage", () => {
  const entry = desktopEntry('/home/me/Apps/Ponzu "x" 100%.AppImage');
  expect(entry).toContain('Exec="/home/me/Apps/Ponzu \\"x\\" 100%%.AppImage" %U\n');
  expect(entry).toContain("MimeType=application/x-ponzu-design;x-scheme-handler/ponzu;\n");
});

test("Windows: Ponzu joins design.json's Open with, leaving .json's default alone", () => {
  const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\ponzu\\Ponzu.exe";
  const commands = registryCommands(exe);
  expect(commands).toContainEqual([
    "add",
    "HKCU\\Software\\Classes\\Ponzu.Design\\shell\\open\\command",
    "/ve",
    "/t",
    "REG_SZ",
    "/d",
    `"${exe}" "%1"`,
    "/f",
  ]);
  expect(commands).toContainEqual([
    "add",
    "HKCU\\Software\\Classes\\.json\\OpenWithProgids",
    "/v",
    "Ponzu.Design",
    "/t",
    "REG_NONE",
    "/d",
    "",
    "/f",
  ]);
  // Never .json's own default.
  expect(commands.some((c) => c[1] === "HKCU\\Software\\Classes\\.json" && c[2] === "/ve")).toBe(
    false,
  );
});
