import { expect, test } from "bun:test";
import { parseArtboardFile } from "@ponzu/core";
import { artboardPage, styleText } from "./document.ts";
import { fontFamilies, googleFontLinks, googleFontRequest, googleFonts } from "./fonts.ts";

test("finds families in font-family, the font shorthand and tokens", () => {
  const families = fontFamilies(
    `<h1 style="font:600 40px/1 'Inter Tight', sans-serif"></h1><p style="font-family:&quot;Instrument Serif&quot;, serif"></p>`,
    `:root { --font-mono: "JetBrains Mono", monospace; }`,
  );
  expect(families.sort()).toEqual(["Instrument Serif", "Inter Tight", "JetBrains Mono"]);
  expect(fontFamilies(`<p style="font-family:system-ui, Helvetica"></p>`, "")).toEqual([]);
  // A family the page brings itself isn't fetched from Google.
  expect(
    fontFamilies(
      `<style>@font-face { font-family: "Brand Sans"; src: url(assets/brand.woff2) }</style><p style="font-family:'Brand Sans', 'brand sans', Inter"></p>`,
      "",
    ),
  ).toEqual(["Inter"]);
});

test("asks Google only for the italics and weights a family has", () => {
  const href = (f: string) => googleFontRequest(f).href;
  // Only 400 and 400 italic: the old 100..900 request was a 400 from Google.
  expect(href("Instrument Serif")).toContain("family=Instrument+Serif:ital,wght@0,400;1,400&");
  // Variable weight axes, with and without italics.
  expect(href("Inter Tight")).toContain("family=Inter+Tight:ital,wght@0,100..900;1,100..900&");
  expect(href("Figtree")).toContain("family=Figtree:ital,wght@0,300..900;1,300..900&");
  expect(href("Caveat")).toContain("family=Caveat:wght@400..700&");
  expect(href("Sora")).toContain("family=Sora:wght@100..800&");
  expect(href("Bricolage Grotesque")).toContain(":wght@200..800&");
  expect(href("Plus Jakarta Sans")).toContain(":ital,wght@0,200..800;1,200..800&");
  expect(href("JetBrains Mono")).toContain(":ital,wght@0,100..800;1,100..800&");
  // Static families list their weights; a single regular takes no axes at all.
  expect(href("Cardo")).toContain("family=Cardo:ital,wght@0,400;0,700;1,400&");
  expect(href("Bebas Neue")).toMatch(/family=Bebas\+Neue&display=block$/);
  // Names match like CSS does, case-insensitively, and use Google's spelling.
  expect(googleFontRequest("instrument serif")).toMatchObject({
    family: "Instrument Serif",
    known: true,
  });
});

test("families Google doesn't list get one discrete-weight try and a suggestion", () => {
  const typo = googleFontRequest("Inter Tigth");
  expect(typo.known).toBe(false);
  expect(typo.suggest).toBe("Inter Tight");
  // Discrete weights: css2 answers with whichever exist instead of a 400.
  expect(typo.href).toContain(":ital,wght@0,100;0,200;");
  expect(googleFontRequest("Monsterrat").suggest).toBe("Montserrat");
  expect(googleFontRequest("Brandname Grotesk XYZ").suggest).toBeUndefined();
});

test("each family loads on its own, so one bad family can't break the rest", () => {
  const fonts = googleFonts(
    `<p style="font-family:'Instrument Serif'"></p><p style="font-family:Notafont, 'Inter Tight'"></p>`,
    "",
  );
  expect(fonts.map((f) => f.family)).toEqual(["Instrument Serif", "Notafont", "Inter Tight"]);
  const links = googleFontLinks(fonts);
  expect(links.match(/<link /g)).toHaveLength(3);
  expect(links).toContain('data-font="Instrument Serif" data-google');
  expect(links).toContain('data-font="Notafont" onerror=');

  const page = artboardPage(
    parseArtboardFile(
      `<section data-artboard data-id="ab_a" data-name="A" style="width:100px;height:100px;font-family:var(--font-display)"></section>`,
      { id: "ab_a", name: "A" },
    ).artboard,
    { tokens: `:root { --font-display: "Instrument Serif", serif; }` },
  );
  expect(page).toContain("family=Instrument+Serif:ital,wght@0,400;1,400&amp;display=block");
});

test("tokens can't end their <style> and run as markup", () => {
  const ab = parseArtboardFile(
    `<section data-artboard data-id="ab_x" data-name="X" style="width:100px;height:100px"></section>`,
    { id: "ab_x", name: "X" },
  ).artboard;
  const tokens = `:root { --a: 1px; }</STYLE><img src=x onerror="alert(1)"><style>`;
  const page = artboardPage(ab, { tokens });
  // The page's own two <style> elements, and nothing the tokens opened or closed.
  expect(page.match(/<\/style/gi)).toHaveLength(2);
  expect(page).toContain("<\\/STYLE><img");
  expect(styleText(`a::after { content: "</style>" }`)).toBe(`a::after { content: "<\\/style>" }`);
});
