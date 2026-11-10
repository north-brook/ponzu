import { createHash } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fontconfig, standInFor } from "./stand-ins.ts";

/**
 * What a Chrome launched on Linux needs so system font names draw in their
 * stand-ins: a fontconfig file, and the font behind system-ui.
 *
 * The rules travel with the renderer instead of being installed in the
 * machine's /etc/fonts, so they are the same wherever it runs, they change
 * with the code that depends on them, and a sandbox image only has to hold
 * the font files. fontconfig rather than @font-face aliases in the page: a
 * face can't take over a generic like system-ui or monospace, and fontconfig
 * also decides the fonts behind canvas text, SVG and per-glyph fallback.
 */
export function linuxFonts(): { env: Record<string, string>; args: string[] } {
  const conf = fontconfig(process.env.FONTCONFIG_FILE ?? "/etc/fonts/fonts.conf");
  // Named by its content: written once, shared by every renderer on the machine.
  const hash = createHash("sha256").update(conf).digest("hex").slice(0, 12);
  const path = join(tmpdir(), `ponzu-fonts-${hash}.conf`);
  if (!existsSync(path)) {
    const partial = `${path}.${process.pid}`;
    writeFileSync(partial, conf);
    renameSync(partial, path);
  }
  return {
    env: { FONTCONFIG_FILE: path },
    // Without a desktop, Chrome's system-ui is whatever fontconfig calls the default.
    args: [`--system-font-family=${standInFor("system-ui")!.font}`],
  };
}
