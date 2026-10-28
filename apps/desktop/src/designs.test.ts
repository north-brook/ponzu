import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  designPath,
  desktopEntry,
  install,
  installIcons,
  launchArgs,
  mimeXml,
  registered,
  registryCommands,
} from "./designs.ts";

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
  // A file manager hands a desktop entry's %U a file:// URL.
  const url = pathToFileURL(join(dir, "Logo.design/design.json")).href;
  expect(launchArgs(["ponzu", url], "/")).toEqual({
    links: [],
    designs: [join(dir, "Logo.design")],
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
  // Exec's quoting, \" for a quote, then the string's, \\ for each backslash.
  expect(entry).toContain('Exec="/home/me/Apps/Ponzu \\\\"x\\\\" 100%%.AppImage" %U\n');
  expect(desktopEntry("/home/a\\b/$P.AppImage")).toContain(
    'Exec="/home/a\\\\\\\\b/\\\\$P.AppImage" %U\n',
  );
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

test("Windows: a registration that's already there isn't written again", () => {
  const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\ponzu\\Ponzu.exe";
  const command = `\r\nHKEY_CURRENT_USER\\Software\\Classes\\Ponzu.Design\\shell\\open\\command\r\n    (Default)    REG_SZ    "${exe}" "%1"\r\n`;
  const openWith =
    "\r\nHKEY_CURRENT_USER\\Software\\Classes\\.json\\OpenWithProgids\r\n    Ponzu.Design    REG_NONE    \r\n";
  expect(registered(exe, command, openWith)).toBe(true);
  // Moved, missing, or never there: written.
  expect(registered("D:\\Ponzu\\Ponzu.exe", command, openWith)).toBe(false);
  expect(registered(exe, command, null)).toBe(false);
  expect(registered(exe, null, null)).toBe(false);
});

test("a database update that fails is tried again next launch", async () => {
  const path = join(dir, "share/mime/packages/ponzu-design.xml");
  let updates = 0;
  const update = (ok: boolean) => async () => {
    updates++;
    return ok;
  };
  await install(path, "xml", update(false));
  expect(await Bun.file(path).exists()).toBe(false);
  await install(path, "xml", update(true));
  expect(await readFile(path, "utf8")).toBe("xml");
  // Unchanged: no update.
  await install(path, "xml", update(true));
  expect(updates).toBe(2);
});

test("an AppImage's icons go where its desktop entry's Icon=ponzu finds them", async () => {
  const hicolor = join(dir, "appdir/usr/share/icons/hicolor");
  for (const size of ["32x32", "512x512"]) {
    await mkdir(join(hicolor, size, "apps"), { recursive: true });
    await writeFile(join(hicolor, size, "apps/ponzu.png"), `png ${size}`);
  }
  const data = join(dir, "share");
  await installIcons(hicolor, data);
  expect(await readFile(join(data, "icons/hicolor/512x512/apps/ponzu.png"), "utf8")).toBe(
    "png 512x512",
  );
  expect(await readFile(join(data, "icons/hicolor/32x32/apps/ponzu.png"), "utf8")).toBe(
    "png 32x32",
  );
  // An AppImage without its theme (or not mounted) leaves nothing behind.
  await installIcons(join(dir, "nowhere"), join(dir, "share-none"));
  expect(await Bun.file(join(dir, "share-none")).exists()).toBe(false);
});
