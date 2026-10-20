import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseArtboardFile } from "@ponzu/core";
import { ChromiumRenderer, findChromium } from "./chromium.ts";
import { contactSheet, sheetLayout } from "./motion.ts";

test("contact sheets keep small frames at 2x and lay them out squarely", () => {
  const small = sheetLayout(9, 150, 50);
  expect(small.scale).toBe(2);
  expect(small.cols).toBeGreaterThan(1);
  expect(small.cols).toBeLessThan(9);
  // Big frames shrink to fit the 1600px budget.
  const big = sheetLayout(9, 1440, 900);
  expect(big.scale).toBeLessThan(0.5);
  const { width, height } = contactSheet(
    Array.from({ length: 9 }, (_, i) => ({ label: `${i}ms`, src: "" })),
    { width: 1440 * big.scale, height: 900 * big.scale },
    big.cols,
  );
  expect(Math.max(width, height)).toBeLessThanOrEqual(1600);
});

const chromium = findChromium();

// Real Chrome; each test launches pages, so allow for a busy machine.
setDefaultTimeout(30_000);

describe.skipIf(!chromium)("motion in Chromium", () => {
  const renderer = new ChromiumRenderer({ executablePath: chromium ?? undefined });
  afterAll(() => renderer.close());

  const artboard = parseArtboardFile(
    `<section data-artboard data-id="ab_m" data-name="Motion" style="width:500px;height:300px;padding:32px;gap:16px">
<style>
@keyframes rise { from { opacity: 0; transform: translateY(24px) } to { opacity: 1; transform: none } }
@keyframes spin { to { transform: rotate(360deg) } }
@keyframes blink { from { opacity: 0 } to { opacity: 1 } }
.shop { transition: background-color 300ms ease; }
.shop:hover { background-color: rgb(220, 40, 40) !important; }
.chip:hover { color: red; }
</style>
<h1 data-id="n_head" data-name="Headline" style="margin:0;opacity:0;animation:rise 800ms 200ms ease-out forwards">Plants</h1>
<div data-id="n_spin" style="width:24px;height:24px;background:#111;animation:spin 1s linear infinite"></div>
<button data-id="n_shop" data-name="Shop" class="shop" style="width:120px;padding:10px;border:0;color:#fff;background-color:rgb(17, 17, 17)">Shop</button>
<p data-id="n_ghost" data-name="Ghost" style="margin:0;opacity:0;animation:blink 400ms">gone</p>
<p data-id="n_typo" data-name="Typo" style="margin:0;animation:nope 1s">typo</p>
<div data-id="n_plain" data-name="Plain" style="width:12px;height:12px;background:#ccc"></div>
<span data-id="n_chip" data-name="Chip" class="chip" style="color:blue">chip</span>
</section>`,
    { id: "ab_m", name: "Motion" },
  ).artboard;
  const base = { artboard, tokens: "" };

  test("screenshots show the settled page and say what animates", async () => {
    const out = await renderer.render({ ...base, lint: true });
    const m = out.motion!;
    expect(m.settled).toBe(1000);
    expect(m.loops).toBe(true);
    expect(m.cycle).toBe(1000);
    expect(m.at).toBe(1000);
    const head = m.animations.find((a) => a.id === "n_head")!;
    expect(head).toMatchObject({ name: "rise", delay: 200, duration: 800, end: 1000 });
    expect(head.properties).toContain("opacity");
    expect(m.animations.find((a) => a.id === "n_spin")?.iterations).toBeNull();

    const kinds = out.issues.map((i) => `${i.id} ${i.kind}`);
    expect(kinds).toContain("n_typo missing-keyframes");
    expect(kinds).toContain("n_ghost hidden-after-animation");
    expect(kinds).not.toContain("n_head hidden-after-animation");
  });

  test("`at` picks a moment on the timeline", async () => {
    const first = await renderer.render({ ...base, at: 0 });
    expect(first.motion?.at).toBe(0);
    const settled = await renderer.render(base);
    expect(Buffer.from(first.bytes).equals(Buffer.from(settled.bytes))).toBe(false);
  });

  test("record returns one labeled sheet across the load", async () => {
    const out = await renderer.record({ ...base, frames: 5, lint: true });
    expect(out.mime).toBe("image/png");
    expect(out.steps.map((s) => s.label)).toEqual([
      "0ms",
      "250ms",
      "500ms",
      "750ms",
      "1000ms settled",
    ]);
    expect(out.issues.some((i) => i.kind === "missing-keyframes")).toBe(true);
    expect(out.width).toBeLessThanOrEqual(1600);
  });

  test("hover records the transition into the state", async () => {
    const out = await renderer.record({
      ...base,
      nodeId: "n_shop",
      interact: { hover: "n_shop" },
      frames: 4,
    });
    expect(out.motion.trigger).toBe("hover n_shop");
    expect(out.motion.animations).toHaveLength(1);
    expect(out.motion.animations[0]).toMatchObject({
      kind: "transition",
      name: "background-color",
      duration: 300,
    });
    expect(out.steps.at(-1)?.label).toBe("300ms settled");
  });

  test("hovering something with no :hover style says so", async () => {
    const out = await renderer.render({ ...base, interact: { hover: "n_plain" }, lint: true });
    expect(out.issues.find((i) => i.kind === "no-state-style")?.id).toBe("n_plain");
    const styled = await renderer.render({ ...base, interact: { hover: "n_shop" }, lint: true });
    expect(styled.issues.some((i) => i.kind === "no-state-style")).toBe(false);
    // Inline styles beat the :hover rule.
    const beaten = await renderer.render({ ...base, interact: { hover: "n_chip" }, lint: true });
    expect(beaten.issues.find((i) => i.kind === "no-state-style")?.message).toContain("!important");
  });

  test("scroll steps through a scroll container", async () => {
    const scroller = parseArtboardFile(
      `<section data-artboard data-id="ab_s" style="width:300px;height:fit-content">
<style>@keyframes fill { from { width: 0 } to { width: 100% } }</style>
<div data-id="n_list" style="height:200px;overflow:auto;position:relative">
  <div data-id="n_bar" style="position:sticky;top:0;z-index:1;height:4px;background:red;animation:fill linear both;animation-timeline:scroll()"></div>
  ${Array.from({ length: 6 }, (_, i) => `<div data-id="n_r${i}" style="height:100px">${i}</div>`).join("")}
</div>
</section>`,
      { id: "ab_s", name: "Scroll" },
    ).artboard;
    const out = await renderer.record({
      artboard: scroller,
      tokens: "",
      scroll: "n_list",
      frames: 3,
      lint: true,
    });
    expect(out.steps.map((s) => s.scroll)).toEqual([0, 202, 404]);
    expect(out.motion.animations.find((a) => a.id === "n_bar")?.timeline).toBe("scroll");
    // Rows scrolled out of view are meant to be out of view.
    expect(out.issues.filter((i) => i.kind === "offscreen" || i.kind === "overflow")).toEqual([]);
    await expect(
      renderer.record({ artboard: scroller, tokens: "", scroll: "n_bar" }),
    ).rejects.toThrow("doesn't scroll");
  });

  test("unknown ids are errors, not blank frames", async () => {
    await expect(renderer.render({ ...base, interact: { hover: "n_missing" } })).rejects.toThrow(
      "No node n_missing",
    );
  });
});
