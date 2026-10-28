import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/*
 * Opening designs on Windows and Linux. A .design is a folder, which only the
 * Mac can treat as a document. Elsewhere Ponzu opens its design.json instead:
 * double-clicked (Linux), with Open with (Windows), dropped on the window, or
 * handed over on the command line. electron-builder's fileAssociations can't
 * name one file: they claim an extension (`*.json` on Linux, every .json on
 * Windows), so Ponzu registers design.json itself, for the person, at launch.
 */

/** The design an argument names: a .design folder, its design.json, or a folder holding one. */
export function designPath(arg: string): string | null {
  const path = arg.replace(/[\\/]+$/, "");
  if (!path || path.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  if (basename(path).toLowerCase() === "design.json") return dirname(path);
  if (path.endsWith(".design")) return path;
  try {
    if (statSync(path).isDirectory() && existsSync(join(path, "design.json"))) return path;
  } catch {}
  return null;
}

/**
 * What a launch's arguments ask to open: ponzu:// links and designs, a relative path from the
 * folder it was launched in. Skips the executable and switches.
 */
export function launchArgs(
  argv: readonly string[],
  cwd: string,
): { links: string[]; designs: string[] } {
  const links: string[] = [];
  const designs: string[] = [];
  for (const arg of argv.slice(1)) {
    if (/^ponzu:/i.test(arg)) links.push(arg);
    else if (!arg.startsWith("-")) {
      const design = designPath(resolve(cwd, arg));
      if (design) designs.push(design);
    }
  }
  return { links, designs };
}

export const DESIGN_MIME = "application/x-ponzu-design";

/** Linux: design.json is a Ponzu design, by its whole name, ahead of the JSON every *.json is. */
export function mimeXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="${DESIGN_MIME}">
    <comment>Ponzu design</comment>
    <sub-class-of type="application/json"/>
    <glob pattern="design.json" weight="80"/>
  </mime-type>
</mime-info>
`;
}

/**
 * Linux, for an AppImage, which installs no desktop entry of its own: Ponzu in the
 * launcher, opening designs and ponzu:// links. Named as the .deb's is, which it stands in for.
 */
export function desktopEntry(exec: string): string {
  const quoted = `"${exec.replace(/["`$\\]/g, "\\$&")}"`;
  return `[Desktop Entry]
Name=Ponzu
Comment=A design canvas you drive with HTML and CSS
Exec=${quoted.replace(/%/g, "%%")} %U
Terminal=false
Type=Application
Icon=ponzu
StartupWMClass=Ponzu
Categories=Graphics;
MimeType=${DESIGN_MIME};x-scheme-handler/ponzu;
`;
}

export const PROG_ID = "Ponzu.Design";

/**
 * Windows: a Ponzu Design type that opens with this executable, and Ponzu under design.json's
 * (every .json's) Open with, without taking .json's default from whatever opens it now.
 */
export function registryCommands(exe: string): string[][] {
  const classes = "HKCU\\Software\\Classes";
  const add = (key: string, value: string | null, data: string, type = "REG_SZ") => [
    "add",
    `${classes}\\${key}`,
    ...(value === null ? ["/ve"] : ["/v", value]),
    "/t",
    type,
    "/d",
    data,
    "/f",
  ];
  return [
    add(PROG_ID, null, "Ponzu Design"),
    add(`${PROG_ID}\\DefaultIcon`, null, `"${exe}",0`),
    add(`${PROG_ID}\\shell\\open\\command`, null, `"${exe}" "%1"`),
    add(".json\\OpenWithProgids", PROG_ID, "", "REG_NONE"),
  ];
}

const run = (cmd: string, args: string[]) =>
  new Promise<boolean>((resolve) => execFile(cmd, args, { windowsHide: true }, (e) => resolve(!e)));

/** Writes `path` unless it already says `content`. Whether it changed. */
async function write(path: string, content: string): Promise<boolean> {
  try {
    if (readFileSync(path, "utf8") === content) return false;
  } catch {}
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return true;
}

/**
 * Register design.json with the desktop, for this person, on each launch of an installed build:
 * the registry on Windows, shared-mime-info (and, for an AppImage, a desktop entry) on Linux.
 * Unchanged, it's left alone. Nothing on a Mac, where .design itself is the document.
 */
export async function associateDesigns(exe: string, env = process.env): Promise<void> {
  if (process.platform === "win32") {
    for (const args of registryCommands(exe)) await run("reg.exe", args);
    return;
  }
  if (process.platform !== "linux") return;
  const data = env.XDG_DATA_HOME || join(homedir(), ".local/share");
  if (await write(join(data, "mime/packages/ponzu-design.xml"), mimeXml()))
    await run("update-mime-database", [join(data, "mime")]);
  if (env.APPIMAGE) {
    const apps = join(data, "applications");
    if (await write(join(apps, "ponzu.desktop"), desktopEntry(env.APPIMAGE)))
      await run("update-desktop-database", [apps]);
  }
}
