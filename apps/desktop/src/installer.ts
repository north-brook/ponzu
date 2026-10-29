import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How an installed Ponzu updates itself: Squirrel on a Mac, the NSIS installer on Windows, an
 * AppImage replacing its own file, or the .deb through dpkg, which asks for an admin's password.
 */
export type Installer = "squirrel" | "nsis" | "appimage" | "deb";

/**
 * This build's installer, or null when it can't update itself: run from an unpacked folder
 * (`package:dir`, a tarball), which has no feed to read (app-update.yml) or nothing to replace.
 * An AppImage is told by the file it runs from, before the package type its resources name: the
 * .deb is built from the same folder, so an AppImage's resources can say "deb" too.
 */
export function installerOf(
  resources: string,
  os: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Installer | null {
  if (!existsSync(join(resources, "app-update.yml"))) return null;
  if (os === "darwin") return "squirrel";
  if (os === "win32") return "nsis";
  if (os !== "linux") return null;
  if (env.APPIMAGE) return "appimage";
  try {
    if (readFileSync(join(resources, "package-type"), "utf8").trim() === "deb") return "deb";
  } catch {}
  return null;
}
