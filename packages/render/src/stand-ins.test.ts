import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseArtboardFile } from "@ponzu/core";
import manifest from "../sandbox-fonts.json" with { type: "json" };
import { ChromiumRenderer, findChromium } from "./chromium.ts";
import { type FontCase, fontCases, fontCasesBoard } from "./fixtures/font-cases.ts";
import reference from "./fixtures/mac-font-widths.json" with { type: "json" };
import { fontconfig, STAND_INS, standInFor } from "./stand-ins.ts";

test("every stand-in is a font the sandbox image is told to install", () => {
  for (const s of STAND_INS) expect(manifest.families).toContain(s.font);
  // Pinned and checkable: a download is a file at a fixed commit with its hash.
  for (const f of manifest.download) {
    expect(f.url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//);
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
});

test("names resolve whatever their case, and only names Chrome on a Mac knows", () => {
  expect(standInFor("helvetica neue")?.font).toBe("Liberation Sans");
  expect(standInFor("SYSTEM-UI")?.font).toBe("Inter Variable");
  // Chrome on a Mac lets these fall through to the next family, so Linux does too.
  for (const name of ["-apple-system", "SF Pro", "SF Pro Text", "Segoe UI", "Consolas"])
    expect(standInFor(name)).toBeUndefined();
});

test("the fontconfig file replaces each name with its stand-in, then reads the system's", () => {
  const conf = fontconfig("/etc/fonts/fonts.conf");
  const rule = (name: string, font: string) =>
    `<test qual="any" name="family"><string>${name}</string></test><edit name="family" mode="assign" binding="same"><string>${font}</string></edit>`;
  expect(conf).toContain(rule("Helvetica Neue", "Liberation Sans"));
  expect(conf).toContain(rule("Menlo", "DejaVu Sans Mono"));
  expect(conf).toContain(rule("monospace", "Liberation Mono"));
  expect(conf).toContain(rule("BlinkMacSystemFont", "Inter Variable"));
  // system-ui is set by a Chrome switch: it never reaches fontconfig by name.
  expect(conf).not.toContain("<string>system-ui</string>");
  const rules = conf.match(/<match /g)!.length;
  expect(rules).toBe(STAND_INS.reduce((n, s) => n + s.names.length, 0) - 1);
  // The system's own configuration comes last, so the rules above win.
  expect(conf.trimEnd().split("\n").at(-2)).toBe(
    `  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>`,
  );
});

/** Families fontconfig knows on this machine; none where there is no fontconfig. */
function installed(): Set<string> {
  if (process.platform !== "linux") return new Set();
  try {
    const out = Bun.spawnSync(["fc-list", ":", "family"]).stdout.toString();
    return new Set(out.split("\n").flatMap((line) => line.split(",").map((f) => f.trim())));
  } catch {
    return new Set();
  }
}

const chromium = findChromium();
const have = installed();
const widths: Record<string, number> = reference.widths;
setDefaultTimeout(30_000);

/**
 * The stand-ins only draw on Linux, through fontconfig. Each family's test
 * runs where its stand-in is installed and skips where it isn't, so this is
 * the sandbox image's check as much as the code's.
 */
describe.skipIf(!chromium || process.platform !== "linux")("stand-ins on Linux", () => {
  const renderer = new ChromiumRenderer({ executablePath: chromium ?? undefined });
  afterAll(() => renderer.close(), 30_000);

  const cases = fontCases();
  let measured: Promise<Record<string, number>> | undefined;
  /** Every line measured once, in one page. */
  const measure = () => {
    measured ??= renderer
      .measure({ artboard: fontCasesBoard(cases), tokens: "", ids: cases.map((c) => c.id) })
      .then((out) => Object.fromEntries(cases.map((c) => [c.id, out.boxes[c.id]?.width ?? 0])));
    return measured;
  };

  test.skipIf(!have.has("Inter Variable") || !have.has("Liberation Sans"))(
    "lint names the stand-ins that set text differently, and no others",
    async () => {
      const { artboard } = parseArtboardFile(
        `<section data-artboard data-id="ab_s" style="width:600px;height:400px">
<p data-id="n_ui" style="font-family:system-ui, sans-serif">Settings</p>
<p data-id="n_ui_again" style="font-family:system-ui">Account</p>
<p data-id="n_stack" style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">Sign in</p>
<p data-id="n_neue" style="font-family:'Helvetica Neue', Helvetica, Arial, sans-serif">Sign in</p>
<p data-id="n_exact" style="font-family:Helvetica, Arial, sans-serif">Metric-compatible</p>
<code data-id="n_code" style="font-family:ui-monospace, Menlo, monospace">const a = 1;</code>
</section>`,
        { id: "ab_s", name: "Stand-ins" },
      );
      const { issues } = await renderer.render({ artboard, tokens: "", lint: true });
      const fonts = issues.filter((i) => i.kind === "stand-in-font" || i.kind === "missing-font");
      // Once per family; -apple-system and ui-monospace fall through as they do in Chrome on a Mac.
      expect(fonts.map((i) => `${i.kind} ${i.id}`)).toEqual([
        "stand-in-font n_ui",
        "stand-in-font n_stack",
        "stand-in-font n_neue",
      ]);
      expect(fonts[0]!.message).toStartWith(
        `font "system-ui" draws in Inter Variable in screenshots: people see San Francisco`,
      );
      expect(fonts[1]!.message).toStartWith(`font "BlinkMacSystemFont" draws in Inter Variable`);
      expect(fonts[2]!.message).toBe(
        `font "Helvetica Neue" draws in Liberation Sans in screenshots: regular and bold set within 1% of its width, but its thin, light and medium weights draw as regular.`,
      );
    },
  );

  const byName = new Map<string, FontCase[]>();
  for (const c of cases) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);

  for (const [name, lines] of byName) {
    const { font, tolerance } = lines[0]!.standIn;
    test.skipIf(!have.has(font))(
      `${name} sets within ${+(tolerance * 100).toFixed(1)}% of a Mac's width in ${font}`,
      async () => {
        const got = await measure();
        for (const c of lines) {
          const mac = widths[c.id]!;
          const off = Math.abs(got[c.id]! - mac) / mac;
          // Named in the failure: which line, and by how much.
          expect({ line: c.id, off: off <= tolerance ? "within" : off.toFixed(4) }).toEqual({
            line: c.id,
            off: "within",
          });
        }
      },
    );
  }
});
