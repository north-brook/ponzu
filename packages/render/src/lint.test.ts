import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseArtboardFile } from "@ponzu/core";
import { ChromiumRenderer, findChromium } from "./chromium.ts";

const chromium = findChromium();

// Real Chrome; each test launches pages, so allow for a busy machine.
setDefaultTimeout(30_000);

const board = (style: string, body: string) =>
  parseArtboardFile(
    `<section data-artboard data-id="ab_l" data-name="Lint" style="${style}">${body}</section>`,
    { id: "ab_l", name: "Lint" },
  ).artboard;

describe.skipIf(!chromium)("layout lint in Chromium", () => {
  const renderer = new ChromiumRenderer({ executablePath: chromium ?? undefined });
  afterAll(() => renderer.close(), 30_000);

  const lint = async (style: string, body: string) =>
    (await renderer.render({ artboard: board(style, body), tokens: "", lint: true })).issues;
  const ids = (issues: { id: string; kind: string }[]) => issues.map((i) => `${i.id} ${i.kind}`);

  // A mobile landing page: fixed-height blocks the artboard's flex column
  // squeezes before anything overflows, then text that does overflow.
  const landing = `
<nav data-id="n_nav" style="height:56px;flex-shrink:1"></nav>
<div data-id="n_hero" style="height:300px;margin-bottom:24px;background:#ccc"></div>
<div data-id="n_card" style="height:200px;background:#eee"></div>
<h2 data-id="n_title" style="margin:24px 0 12px;font:600 28px/1.2 sans-serif">Plants that forgive you</h2>
<p data-id="n_copy" style="margin:0 0 32px;font:16px/1.5 sans-serif">${"Water once a week and they still look great. ".repeat(4)}</p>`;
  const pad = "width:390px;padding:24px 20px 40px";

  test("the artboard overflow says how much room the content needs, and that much clears it", async () => {
    const short = await lint(`${pad};height:700px`, landing);
    const msg = short.find((i) => i.id === "ab_l" && i.kind === "overflow")?.message ?? "";
    const needed = Number(/needs (\d+)px/.exec(msg)?.[1]);
    const more = Number(/(\d+)px more/.exec(msg)?.[1]);
    expect(needed).toBeGreaterThan(700);
    expect(more).toBe(needed - 700);
    // Not just what overflows past the squeezed blocks.
    const { contentHeight } = await renderer.render({
      artboard: board(`${pad};height:700px`, landing),
      tokens: "",
    });
    expect(more).toBeGreaterThan(contentHeight - 700);

    expect(ids(await lint(`${pad};height:${needed - 2}px`, landing))).toContain("ab_l overflow");
    expect(ids(await lint(`${pad};height:${needed}px`, landing))).not.toContain("ab_l overflow");

    const m = await renderer.measure({
      artboard: board(`${pad};height:700px`, landing),
      tokens: "",
      ids: ["ab_l", "n_hero", "n_nope"],
    });
    expect(m.contentHeight).toBe(needed);
    expect(m.boxes.n_nope).toBeNull();
    // Squeezed by the short artboard, at its place below the nav.
    expect(m.boxes.n_hero).toMatchObject({ x: 20, width: 350 });
    expect(m.boxes.n_hero!.height).toBeLessThan(300);
    expect(m.boxes.n_hero!.y).toBeGreaterThan(24);
    expect(m.boxes.ab_l).toMatchObject({ x: 0, y: 0, width: 390, height: 700 });
  });

  test("an artboard with room to spare measures what its content takes", async () => {
    const m = await renderer.measure({
      artboard: board(`${pad};height:1200px`, landing),
      tokens: "",
      ids: ["ab_l"],
    });
    expect(m.contentHeight).toBeLessThan(1200);
    expect(ids(await lint(`${pad};height:${m.contentHeight}px`, landing))).not.toContain(
      "ab_l overflow",
    );
  });

  test("scroll areas and percent heights don't throw the overflow off", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => `<div style="height:40px">${i}</div>`).join(
      "",
    );
    // A flex: 1 scroll area holds more than it shows on purpose.
    const app = await lint(
      "width:390px;height:800px",
      `<header style="height:60px"></header><main data-id="n_main" style="flex:1;overflow:auto">${rows}</main><footer style="height:60px"></footer>`,
    );
    expect(ids(app)).not.toContain("ab_l overflow");
    // A child sized in % of the artboard grows with it: say so instead of a number that won't fit.
    const pct = await lint(
      "width:390px;height:400px",
      `<div style="height:100%;flex-shrink:0"></div><p style="margin:0">after</p>`,
    );
    expect(pct.find((i) => i.id === "ab_l")?.message).toContain("in % of it");
  });

  test("a chart drawn outside its slot over its labels is flagged", async () => {
    const chart = (svg: string) => `
<div data-id="n_chart" data-name="Chart" style="display:flex;gap:8px;height:160px;width:360px">
  <div data-id="n_axis" data-name="Axis" style="display:flex;flex-direction:column;justify-content:space-between;width:40px;flex-shrink:0;font:12px sans-serif">
    <span data-id="n_t1">100</span><span data-id="n_t2">0</span>
  </div>
  <div data-id="n_slot" data-name="Plot" style="flex:1;min-width:0;height:160px">${svg}</div>
</div>
<p data-id="n_note" style="margin:8px 0 0;font:12px sans-serif">Source: survey</p>`;
    // Sized bigger than its slot, and shifted left over the axis.
    const big = await lint(
      "width:400px;height:300px;padding:20px",
      chart(
        `<svg data-id="n_svg" data-name="Plot svg" width="420" height="200" viewBox="0 0 420 200" style="display:block;margin-left:-60px"><rect data-id="n_bar" width="420" height="200" fill="#4a7"/></svg>`,
      ),
    );
    const msg = big.find((i) => i.id === "n_svg")?.message ?? "";
    expect(msg).toContain("sticks out of Plot");
    expect(msg).toMatch(/px left/);
    // Drawing past the viewBox with overflow: visible.
    const spill = await lint(
      "width:400px;height:300px;padding:20px",
      chart(
        `<svg data-id="n_svg" width="100%" height="160" viewBox="0 0 300 160" style="display:block;overflow:visible"><path data-id="n_line" d="M -80 120 L 300 10" stroke="#000" fill="none" stroke-width="2"/></svg>`,
      ),
    );
    expect(spill.find((i) => i.id === "n_svg")?.message).toMatch(/draws outside its box .* over/);
    // The same chart kept inside its slot is clean.
    const fits = await lint(
      "width:400px;height:300px;padding:20px",
      chart(
        `<svg data-id="n_svg" width="100%" height="160" viewBox="0 0 300 160" style="display:block;overflow:visible"><path d="M 0 120 L 300 10" stroke="#000" fill="none" stroke-width="2"/></svg>`,
      ),
    );
    expect(fits).toEqual([]);
  });

  test("a full-bleed image that spills over nothing is fine", async () => {
    const issues = await lint(
      "width:400px;height:300px;padding:20px",
      `<div data-id="n_frame" style="height:120px"><img data-id="n_img" alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" style="display:block;width:400px;height:120px;margin-left:-20px"></div><p style="margin:16px 0 0">caption</p>`,
    );
    expect(issues.filter((i) => i.id === "n_img")).toEqual([]);
  });

  test("a wordmark squeezed onto two lines in a logo wall is flagged, wrapping copy isn't", async () => {
    const issues = await lint(
      "width:420px;height:fit-content;padding:20px;gap:24px",
      `<div data-id="n_logos" style="display:flex;gap:16px;align-items:center;font:600 18px sans-serif">
  <span data-id="n_l1">Acme</span><span data-id="n_l2" data-name="Northwind">Northwind Traders</span><span data-id="n_l3">Globex</span><span data-id="n_l4">Initech</span><span data-id="n_l5">Umbrella Corporation</span>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;font:14px/1.4 sans-serif">
  <p data-id="n_c1" style="margin:0">Water once a week and it thrives.</p><p data-id="n_c2" style="margin:0">Low light is fine.</p><p data-id="n_c3" style="margin:0">Ships in recycled boxes.</p>
</div>
<h1 data-id="n_h" style="margin:0;font:600 48px/1.1 sans-serif;width:200px">Grow more</h1>`,
    );
    const wrapped = issues.filter((i) => i.kind === "wrapped-text").map((i) => i.id);
    expect(wrapped).toContain("n_l2");
    expect(issues.find((i) => i.id === "n_l2")?.message).toContain("Northwind wraps");
    // Sentences in a grid of cards, and a big headline, wrap by design.
    expect(wrapped).not.toContain("n_c1");
    expect(wrapped).not.toContain("n_c3");
    expect(wrapped).not.toContain("n_h");
    expect(wrapped).not.toContain("n_l1");
  });

  // An app laid out for plain CSS: a rail and two panes in a display: flex root.
  const panes = (rows: number) => `
<nav data-id="n_rail" style="width:64px;flex-shrink:0;background:#222"></nav>
<aside data-id="n_list" style="width:360px;flex-shrink:0;display:flex;flex-direction:column;gap:8px;padding:16px">${'<div style="height:56px;font:14px sans-serif">Row</div>'.repeat(rows)}</aside>
<main data-id="n_detail" style="flex:1;padding:24px;font:14px/1.5 sans-serif">${"Body copy. ".repeat(60)}</main>`;
  const app = "width:1440px;height:900px";

  test("a root that sets display: flex with no direction is flagged, even when nothing overflows", async () => {
    const issues = await lint(`${app};display:flex`, panes(4));
    expect(ids(issues)).toEqual(["ab_l flex-direction"]);
    expect(issues[0]!.message).toContain("flex-direction: row");
    // Like the write tools' note, it's about the root's style, not what's in it yet.
    expect(ids(await lint(`${app};display:flex`, ""))).toEqual(["ab_l flex-direction"]);

    // Saying which way clears it, and so does leaving display to the artboard.
    for (const style of [
      "display:flex;flex-direction:row",
      "display:flex;flex-direction:column",
      "display:flex;flex-flow:row wrap",
      "",
      "display:grid;grid-template-columns:64px 360px 1fr",
    ])
      expect(ids(await lint(`${app};${style}`, panes(4)))).toEqual([]);
  });

  test("when the stacked panes overflow, the fix offered includes the direction", async () => {
    const issues = await lint(`${app};display:flex`, panes(12));
    const overflow = issues.find((i) => i.id === "ab_l" && i.kind === "overflow");
    expect(overflow?.message).toContain("set flex-direction: row");
    expect(ids(await lint(`${app};display:flex;flex-direction:row`, panes(12)))).toEqual([]);
    // Without the flex hint, the advice stays as it was.
    const tall = await lint(`${pad};height:700px`, landing);
    expect(tall.find((i) => i.id === "ab_l")?.message).toEndWith(
      "set height: fit-content or make room",
    );
  });
});
