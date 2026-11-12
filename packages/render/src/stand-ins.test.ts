import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseArtboardFile } from "@ponzu/core";
import manifest from "../sandbox-fonts.json" with { type: "json" };
import { ChromiumRenderer, findChromium } from "./chromium.ts";
import { type FontCase, fontCases, fontCasesBoard } from "./fixtures/font-cases.ts";
import reference from "./fixtures/mac-fonts.json" with { type: "json" };
import {
  CLOSE_ENOUGH,
  fontconfig,
  fontFaces,
  type Metrics,
  STAND_INS,
  standInFor,
  UNNAMED_CJK,
} from "./stand-ins.ts";

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

test("a stand-in that sets text differently from the Mac's font has a caveat for lint to give", () => {
  const quiet = STAND_INS.filter((s) => !s.caveat);
  for (const s of quiet) {
    expect({ names: s.names, tolerance: s.tolerance <= CLOSE_ENOUGH }).toEqual({
      names: s.names,
      tolerance: true,
    });
    expect({ names: s.names, leading: s.leading }).toEqual({ names: s.names, leading: undefined });
  }
  // The ones that can't be made to match, because no face reaches them.
  expect(standInFor("system-ui")?.caveat).toContain("line-height");
  expect(standInFor("Apple Color Emoji")?.caveat).toContain("line-height");
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

describe("the faces that carry a Mac font's line height", () => {
  const css = fontFaces();
  const rules = css.split("\n");
  const named = (name: string) => rules.filter((r) => r.includes(`font-family:"${name}";`));

  test("each is a stand-in's installed face under the metrics recorded on a Mac", () => {
    const recorded: Record<string, Metrics> = reference.metrics;
    const withMetrics = STAND_INS.filter((s) => s.metrics);
    for (const s of withMetrics)
      for (const name of s.names) expect(recorded[name]).toEqual(s.metrics!);
    expect(Object.keys(recorded).sort()).toEqual(withMetrics.flatMap((s) => s.names).sort());

    // By full name: local() finds nothing by a family name alone.
    expect(named("Georgia")).toEqual([
      `@font-face{font-family:"Georgia";src:local("Gelasio Regular");font-weight:400;font-style:normal;ascent-override:91.7%;descent-override:21.92%;line-gap-override:0%}`,
      `@font-face{font-family:"Georgia";src:local("Gelasio Bold");font-weight:700;font-style:normal;ascent-override:91.7%;descent-override:21.92%;line-gap-override:0%}`,
      `@font-face{font-family:"Georgia";src:local("Gelasio Italic");font-weight:400;font-style:italic;ascent-override:91.7%;descent-override:21.92%;line-gap-override:0%}`,
      `@font-face{font-family:"Georgia";src:local("Gelasio Bold Italic");font-weight:700;font-style:italic;ascent-override:91.7%;descent-override:21.92%;line-gap-override:0%}`,
    ]);
    expect(named("Monaco")[0]).toBe(
      `@font-face{font-family:"Monaco";src:local("Liberation Mono");font-weight:400;font-style:normal;ascent-override:100%;descent-override:25%;line-gap-override:8.35%}`,
    );
    // One variable file, every weight.
    expect(named("BlinkMacSystemFont")).toEqual([
      `@font-face{font-family:"BlinkMacSystemFont";src:local("Inter Variable");font-weight:100 900;font-style:normal;ascent-override:96.68%;descent-override:21.09%;line-gap-override:0%}`,
    ]);
    expect(named("Hiragino Kaku Gothic ProN").map((r) => /local\("([^"]+)"\)/.exec(r)![1])).toEqual(
      ["Noto Sans CJK JP", "Noto Sans CJK JP Bold"],
    );
  });

  test("every name with metrics has one, and no other name does", () => {
    for (const s of STAND_INS)
      for (const name of s.names)
        expect({ name, faces: named(name).length > 0 }).toEqual({ name, faces: !!s.metrics });
    // A face can't stand for a keyword: Chrome never looks one up among a page's faces.
    for (const keyword of ["system-ui", "monospace"])
      expect(standInFor(keyword)?.metrics).toBeUndefined();
    expect(css).not.toContain("<");
  });
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
const heights: Record<string, number> = reference.heights;
setDefaultTimeout(30_000);

/**
 * The stand-ins only draw on Linux, through fontconfig and the faces. Each
 * family's test runs where its stand-in is installed and skips where it
 * isn't, so this is the sandbox image's check as much as the code's.
 */
describe.skipIf(!chromium || process.platform !== "linux")("stand-ins on Linux", () => {
  const renderer = new ChromiumRenderer({ executablePath: chromium ?? undefined });
  afterAll(() => renderer.close(), 30_000);

  const cases = fontCases();
  let measured: Promise<Record<string, { width: number; height: number }>> | undefined;
  /** Every line measured once, in one page. */
  const measure = () => {
    measured ??= renderer
      .measure({ artboard: fontCasesBoard(cases), tokens: "", ids: cases.map((c) => c.id) })
      .then((out) =>
        Object.fromEntries(cases.map((c) => [c.id, out.boxes[c.id] ?? { width: 0, height: 0 }])),
      );
    return measured;
  };

  test.skipIf(
    !["Inter Variable", "Liberation Sans", "DejaVu Sans Mono", "Gelasio", "Noto Color Emoji"].every(
      (font) => have.has(font),
    ),
  )("lint names the stand-ins that set text differently, and no others", async () => {
    const { artboard } = parseArtboardFile(
      `<section data-artboard data-id="ab_s" style="width:600px;height:600px">
<style>@font-face { font-family: "Brand"; src: url(data:font/woff2;base64,AAAA); }</style>
<p data-id="n_ui" style="font-family:system-ui, sans-serif">Settings</p>
<p data-id="n_ui_again" style="font-family:system-ui">Account</p>
<p data-id="n_stack" style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">Sign in</p>
<p data-id="n_neue" style="font-family:'Helvetica Neue', Helvetica, Arial, sans-serif">Sign in</p>
<p data-id="n_exact" style="font-family:Helvetica, Arial, sans-serif">Metric-compatible</p>
<p data-id="n_georgia" style="font-family:Georgia, serif">The same height through a face</p>
<code data-id="n_code" style="font-family:ui-monospace, Menlo, monospace">const a = 1;</code>
<p data-id="n_emoji" style="font-family:Helvetica, Arial, sans-serif">Shipped 🚀</p>
<p data-id="n_brand" style="font-family:Brand, Georgia, serif">A face of the board's own</p>
</section>`,
      { id: "ab_s", name: "Stand-ins" },
    );
    const lint = async (board: typeof artboard) =>
      (await renderer.render({ artboard: board, tokens: "", lint: true })).issues.filter(
        (i) => i.kind === "stand-in-font" || i.kind === "missing-font",
      );
    const fonts = await lint(artboard);
    // Once per family; -apple-system and ui-monospace fall through as they do in Chrome on a Mac.
    expect(fonts.map((i) => `${i.kind} ${i.id}`)).toEqual([
      "stand-in-font n_ui",
      "stand-in-font n_stack",
      "stand-in-font n_neue",
      "stand-in-font n_emoji",
      "missing-font n_brand",
    ]);
    expect(fonts[0]!.message).toStartWith(
      `font "system-ui" draws in Inter Variable in screenshots: people see San Francisco`,
    );
    expect(fonts[1]!.message).toStartWith(`font "BlinkMacSystemFont" draws in Inter Variable`);
    expect(fonts[2]!.message).toBe(
      `font "Helvetica Neue" draws in Liberation Sans in screenshots: regular and bold set within 1% of its width, but its thin, light and medium weights draw as regular.`,
    );
    // Drawn by fallback: nothing in the stack names an emoji font.
    expect(fonts[3]!.message).toStartWith(
      `font "Apple Color Emoji" draws in Noto Color Emoji in screenshots: emoji are Apple's`,
    );
    // The board's own face is still told from the renderer's.
    expect(fonts[4]!.message).toStartWith(`font "Brand" didn't load; check its @font-face src.`);

    // Chrome has no font for a ui- keyword, so what follows it is what draws: Tailwind's default stacks.
    const tailwind = parseArtboardFile(
      `<section data-artboard data-id="ab_t" style="width:600px;height:300px">
<h1 data-id="n_sans" style="font-family:ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'">Settings and account</h1>
<code data-id="n_mono" style="font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace">const a = 1;</code>
<h2 data-id="n_rounded" style="font-family:ui-rounded, 'SF Pro Rounded', 'Helvetica Neue'">Rounded</h2>
</section>`,
      { id: "ab_t", name: "Tailwind" },
    ).artboard;
    expect(
      (await lint(tailwind)).map((i) => `${i.kind} ${i.id} ${/"([^"]+)"/.exec(i.message)![1]}`),
    ).toEqual(["stand-in-font n_sans system-ui", "stand-in-font n_rounded Helvetica Neue"]);
  });

  test.skipIf(!have.has("Liberation Sans") || !have.has("Noto Sans CJK JP"))(
    "lint says when fallback draws Chinese, Japanese or Korean at a line height of its own",
    async () => {
      const { artboard } = parseArtboardFile(
        `<section data-artboard data-id="ab_k" style="width:600px;height:400px">
<p data-id="n_named" style="font-family:Helvetica, 'PingFang SC', sans-serif">设置与账户</p>
<p data-id="n_set" style="font:16px/1.5 Helvetica, sans-serif">設定とアカウント</p>
<p data-id="n_latin" style="font-family:Helvetica, sans-serif">Settings</p>
<p data-id="n_left" style="font-family:Helvetica, sans-serif">设置与账户</p>
<p data-id="n_again" style="font-family:sans-serif">설정 및 계정</p>
</section>`,
        { id: "ab_k", name: "Fallback" },
      );
      const { issues } = await renderer.render({ artboard, tokens: "", lint: true });
      // Once, on the first line that names no font for it and leaves its height to the font.
      expect(issues.filter((i) => i.kind === "stand-in-font")).toEqual([
        { id: "n_left", kind: "stand-in-font", message: UNNAMED_CJK },
      ]);
    },
  );

  const byName = new Map<string, FontCase[]>();
  for (const c of cases) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);

  for (const [name, lines] of byName) {
    const { font, tolerance, leading } = lines[0]!.standIn;
    const tall = leading ? `${+(leading * 100).toFixed(1)}% of` : "a pixel of";
    test.skipIf(!have.has(font) || !have.has("Liberation Sans"))(
      `${name} sets within ${+(tolerance * 100).toFixed(1)}% of a Mac's width and ${tall} its line height in ${font}`,
      async () => {
        const got = await measure();
        for (const c of lines) {
          const mac = { width: widths[c.id]!, height: heights[c.id]! };
          const wide = Math.abs(got[c.id]!.width - mac.width) / mac.width;
          const high = Math.abs(got[c.id]!.height - mac.height);
          // Named in the failure: which line, and by how much.
          expect({
            line: c.id,
            width: wide <= tolerance ? "within" : wide.toFixed(4),
            height: high <= Math.max(1, (leading ?? 0) * mac.height) ? "within" : `${high}px`,
          }).toEqual({ line: c.id, width: "within", height: "within" });
        }
      },
    );
  }
});
