import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopEntry, installIcons } from "./linux.ts";

const dir = await mkdtemp(join(tmpdir(), "ponzu-linux-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

test("an AppImage's desktop entry opens ponzu:// links with that AppImage", () => {
  const entry = desktopEntry('/home/me/Apps/Ponzu "x" 100%.AppImage');
  // Exec's quoting, \" for a quote, then the string's, \\ for each backslash.
  expect(entry).toContain('Exec="/home/me/Apps/Ponzu \\\\"x\\\\" 100%%.AppImage" %U\n');
  expect(desktopEntry("/home/a\\b/$P.AppImage")).toContain(
    'Exec="/home/a\\\\\\\\b/\\\\$P.AppImage" %U\n',
  );
  // Links only: the cloud app opens no files.
  expect(entry).toContain("MimeType=x-scheme-handler/ponzu;\n");
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
