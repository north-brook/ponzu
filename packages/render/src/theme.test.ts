import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseArtboardFile } from "@ponzu/core";
import { ChromiumRenderer, findChromium } from "./chromium.ts";

const chromium = findChromium();

setDefaultTimeout(30_000);

const tokens = `:root {
  --bg: light-dark(#f3f3f1, #121212);
  --card: light-dark(#ffffff, #1a1a1a);
  --ink: light-dark(#111110, #f2f2f2);
  --muted: light-dark(#6b6b6b, #8a8a8a);
}`;

const board = (body: string) =>
  parseArtboardFile(
    `<section data-artboard data-id="ab_t" data-name="Theme" style="width:600px;height:400px;background:var(--bg);color:var(--ink);font:16px sans-serif">${body}</section>`,
    { id: "ab_t", name: "Theme" },
  ).artboard;

describe.skipIf(!chromium)("theme lint in Chromium", () => {
  const renderer = new ChromiumRenderer({ executablePath: chromium ?? undefined });
  afterAll(() => renderer.close());

  const lint = async (body: string, colorScheme?: "light" | "dark", css = tokens) =>
    (
      await renderer.render({ artboard: board(body), tokens: css, lint: true, colorScheme })
    ).issues.filter((i) => i.kind === "theme");

  test("a design that uses its tokens throughout is clean in both themes", async () => {
    const body = `<div data-id="n_card" data-name="Card" style="background:var(--card);padding:16px"><p data-id="n_p" style="color:var(--muted)">Quiet</p></div>`;
    expect(await lint(body)).toEqual([]);
    expect(await lint(body, "dark")).toEqual([]);
  });

  test("raw text and surfaces beside themed ones are flagged, from either theme", async () => {
    const body = `
<p data-id="n_gray" data-name="Caption" style="color:#111110">Fixed ink</p>
<div data-id="n_bar" data-name="Controls bar" style="background:rgba(255,255,255,0.82);padding:8px">
  <span data-id="n_pct" style="color:var(--muted)">64%</span>
</div>
<div data-id="n_dots" data-name="Dot grid" style="height:40px;background-image:radial-gradient(rgba(0,0,0,0.07) 1px,transparent 1px)"></div>`;
    for (const scheme of ["light", "dark"] as const) {
      const issues = await lint(body, scheme);
      const by = Object.fromEntries(issues.map((i) => [i.id, i.message]));
      expect(by.n_gray).toContain("Caption text is");
      expect(by.n_gray).toContain("its background changes with the theme and its color doesn't");
      expect(by.n_bar).toContain("Controls bar stays the same in both themes");
      expect(by.n_bar).toContain("light-dark()");
    }
  });

  test("a part pinned to one scheme, and a design with no theme, are left alone", async () => {
    const pinned = `<div data-id="n_mock" data-name="Light mock" style="color-scheme:light;background:#ffffff;padding:16px"><p data-id="n_t" style="color:#111110">Always light</p></div>`;
    expect(await lint(pinned, "dark")).toEqual([]);
    const fixed = `<div data-id="n_card" style="background:#fff"><p data-id="n_t" style="color:#111">Hi</p></div>`;
    expect(await lint(fixed, "dark", ":root { --bg: #f3f3f1; --ink: #111; }")).toEqual([]);
  });

  test("a dark card that stays dark reads fine in both and isn't flagged", async () => {
    const body = `<div data-id="n_term" style="background:#0e0e0e;color:#f2f2f2;padding:12px"><code data-id="n_c">ponzu</code></div>`;
    expect(await lint(body)).toEqual([]);
    expect(await lint(body, "dark")).toEqual([]);
  });

  test("checking leaves the page in the scheme it rendered in", async () => {
    const { issues } = await renderer.render({
      artboard: board(`<p data-id="n_gray" style="color:#111110">Fixed</p>`),
      tokens,
      lint: true,
      colorScheme: "dark",
    });
    expect(issues.find((i) => i.id === "n_gray")?.message).toMatch(/in dark and .* in light/);
  });
});
