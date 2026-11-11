import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/*
 * Linux, for an AppImage, which installs no desktop entry of its own: Ponzu in the launcher, and
 * the handler for `ponzu://` links, without which a link (the GitHub setup's way back included)
 * can never reach it. The .deb's package installs its own.
 */

/** The desktop entry, named as the .deb's is, which it stands in for. */
export function desktopEntry(exec: string): string {
  // Quoted as an Exec argument, then escaped as the string value that holds it, which is read
  // first: so a backslash in the path is four in the file.
  const argument = `"${exec.replace(/["`$\\]/g, "\\$&")}"`.replace(/%/g, "%%");
  return `[Desktop Entry]
Name=Ponzu
Comment=Design with Claude on a canvas, and ship pull requests
Exec=${argument.replace(/\\/g, "\\\\")} %U
Terminal=false
Type=Application
Icon=ponzu
StartupWMClass=Ponzu
Categories=Graphics;
MimeType=x-scheme-handler/ponzu;
`;
}

/** The entry and its icons, for the AppImage this launch runs from. Unchanged, they're left alone. */
export async function registerAppImage(env = process.env): Promise<void> {
  if (!env.APPIMAGE) return;
  const data = env.XDG_DATA_HOME || join(homedir(), ".local/share");
  const apps = join(data, "applications");
  // Read as it is; the database only caches which entries open which types.
  if (await write(join(apps, "ponzu.desktop"), desktopEntry(env.APPIMAGE))) {
    await new Promise((resolve) => execFile("update-desktop-database", [apps], resolve));
  }
  if (env.APPDIR) await installIcons(join(env.APPDIR, "usr/share/icons/hicolor"), data);
}

/**
 * The AppImage's icons where the desktop entry's `Icon=ponzu` finds them, as the .deb installs
 * its own in /usr/share/icons. From the AppImage's hicolor theme, every size.
 */
export async function installIcons(hicolor: string, data: string): Promise<void> {
  for (const size of await readdir(hicolor).catch(() => [])) {
    const icon = await readFile(join(hicolor, size, "apps/ponzu.png")).catch(() => null);
    if (icon) await write(join(data, "icons/hicolor", size, "apps/ponzu.png"), icon);
  }
}

/** Writes `path` unless it already says `content`. Whether it changed. */
async function write(path: string, content: string | Uint8Array): Promise<boolean> {
  try {
    if (readFileSync(path).equals(Buffer.from(content))) return false;
  } catch {}
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return true;
}
