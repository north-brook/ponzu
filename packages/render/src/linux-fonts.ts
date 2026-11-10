import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fontconfig, standInFor } from "./stand-ins.ts";

/** What a Chrome is launched with so system font names draw in their stand-ins. */
export interface LinuxFonts {
  env: Record<string, string>;
  args: string[];
}

let made: LinuxFonts | undefined;

/**
 * What a Chrome launched on Linux needs so system font names draw in their
 * stand-ins: a fontconfig file, and the font behind system-ui.
 *
 * The rules travel with the renderer instead of being installed in the
 * machine's /etc/fonts, so they are the same wherever it runs, they change
 * with the code that depends on them, and a sandbox image only has to hold
 * the font files. fontconfig is what resolves a generic like system-ui or
 * monospace, and decides the fonts behind canvas text, SVG and per-glyph
 * fallback; the page's own @font-face rules (`fontFaces` in stand-ins.ts)
 * only add line heights on top.
 *
 * The file is written once per process, into a folder made for it that only
 * this user can open. Chrome reads its font folders and includes from the
 * file, so on a machine with other users it can't sit at a name in /tmp they
 * could have put there first.
 */
export function linuxFonts(): LinuxFonts {
  if (made) return made;
  const dir = mkdtempSync(join(tmpdir(), "ponzu-fonts-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "fonts.conf");
  writeFileSync(path, fontconfig(process.env.FONTCONFIG_FILE ?? "/etc/fonts/fonts.conf"), {
    // Fails rather than follow anything already at the name.
    flag: "wx",
    mode: 0o600,
  });
  made = {
    env: { FONTCONFIG_FILE: path },
    // Without a desktop, Chrome's system-ui is whatever fontconfig calls the default.
    args: [`--system-font-family=${standInFor("system-ui")!.font}`],
  };
  return made;
}
