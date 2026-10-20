import { expect, test } from "bun:test";
import { googleFontsLink } from "./document.ts";

test("finds families in font-family, the font shorthand and tokens", () => {
  const link = googleFontsLink(
    `<h1 style="font:600 40px/1 'Inter Tight', sans-serif"></h1><p style="font-family:&quot;Instrument Serif&quot;, serif"></p>`,
    `:root { --font-mono: "JetBrains Mono", monospace; }`,
  );
  expect(link).toContain("family=Inter+Tight");
  expect(link).toContain("family=Instrument+Serif");
  expect(link).toContain("family=JetBrains+Mono");
  expect(googleFontsLink(`<p style="font-family:system-ui, Helvetica"></p>`, "")).toBe("");
});
