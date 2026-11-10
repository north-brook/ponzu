import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { linuxFonts } from "./linux-fonts.ts";
import { fontconfig } from "./stand-ins.ts";

// Writing the file needs no Linux, so this runs everywhere.
test.skipIf(process.platform === "win32")(
  "the fontconfig file Chrome is pointed at is in a folder only this user can open",
  () => {
    const fonts = linuxFonts();
    const path = fonts.env.FONTCONFIG_FILE!;
    const dir = dirname(path);
    // Made for this process: not a name in /tmp another user could have taken first.
    expect(dirname(dir)).toBe(tmpdir());
    expect(dir).toMatch(/ponzu-fonts-[A-Za-z0-9]{6}$/);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(dir).uid).toBe(process.getuid!());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(
      fontconfig(process.env.FONTCONFIG_FILE ?? "/etc/fonts/fonts.conf"),
    );
    expect(fonts.args).toEqual(["--system-font-family=Inter Variable"]);
    // Once per process, however many browsers are launched.
    expect(linuxFonts()).toBe(fonts);
  },
);
