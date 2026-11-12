import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseArtboardFile } from "@ponzu/core";
import { chromium as playwright } from "playwright-core";
import { BrowserProcess } from "./browser.ts";
import { ChromiumRenderer, findChromium } from "./chromium.ts";
import { ARTBOARD_BASE_CSS } from "./document.ts";
import {
  contactSheet,
  FULL_LINT_SCRIPT,
  motionCall,
  prepareScript,
  sheetLayout,
} from "./motion.ts";

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
  afterAll(() => renderer.close(), 30_000);

  const artboard = parseArtboardFile(
    `<section data-artboard data-id="ab_m" data-name="Motion" style="width:500px;height:300px;padding:32px;gap:16px">
<style>
@keyframes rise { from { opacity: 0; transform: translateY(24px) } to { opacity: 1; transform: none } }
@keyframes spin { to { transform: rotate(360deg) } }
@keyframes blink { from { opacity: 0 } to { opacity: 1 } }
@keyframes leave { from { opacity: 1 } to { opacity: 0 } }
.shop { transition: background-color 300ms ease; }
.shop:hover { background-color: rgb(220, 40, 40) !important; }
.chip:hover { color: red; }
.round:hover { border-radius: 20px; }
</style>
<h1 data-id="n_head" data-name="Headline" style="margin:0;opacity:0;animation:rise 800ms 200ms ease-out forwards">Plants</h1>
<div data-id="n_spin" style="width:24px;height:24px;background:#111;animation:spin 1s linear infinite"></div>
<button data-id="n_shop" data-name="Shop" class="shop" style="width:120px;padding:10px;border:0;color:#fff;background-color:rgb(17, 17, 17)">Shop</button>
<p data-id="n_ghost" data-name="Ghost" style="margin:0;opacity:0;animation:blink 400ms">gone</p>
<p data-id="n_typo" data-name="Typo" style="margin:0;animation:nope 1s">typo</p>
<div data-id="n_plain" data-name="Plain" style="width:12px;height:12px;background:#ccc"></div>
<span data-id="n_chip" data-name="Chip" class="chip" style="color:blue">chip</span>
<div data-id="n_round" data-name="Round" class="round" style="width:12px;height:12px;background:#ccc"></div>
<p data-id="n_leave" data-name="Leave" style="margin:0;opacity:0;animation:leave 400ms">bye</p>
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
    // The 24px spinner is the biggest thing that loops.
    expect(m.loopSize).toBe(24);
    expect(m.at).toBe(1000);
    const head = m.animations.find((a) => a.id === "n_head")!;
    expect(head).toMatchObject({ name: "rise", delay: 200, duration: 800, end: 1000 });
    expect(head.properties).toContain("opacity");
    expect(m.animations.find((a) => a.id === "n_spin")?.iterations).toBeNull();

    const kinds = out.issues.map((i) => `${i.id} ${i.kind}`);
    expect(kinds).toContain("n_typo missing-keyframes");
    expect(kinds).toContain("n_ghost hidden-after-animation");
    expect(kinds).not.toContain("n_head hidden-after-animation");
    // A fade-out is meant to end hidden.
    expect(kinds).not.toContain("n_leave hidden-after-animation");
  });

  test("a loop that starts late settles once it has started", async () => {
    // A loop's film starts at `settled` (loop.ts), so a delayed spinner is filmed spinning.
    const late = parseArtboardFile(
      `<section data-artboard data-id="ab_d" style="width:200px;height:200px">
<style>@keyframes spin { to { transform: rotate(360deg) } }</style>
<div data-id="n_late" style="width:24px;height:24px;background:#111;animation:spin 1s linear 2s infinite"></div>
</section>`,
      { id: "ab_d", name: "Late" },
    ).artboard;
    const m = (await renderer.render({ artboard: late, tokens: "" })).motion!;
    expect(m.loops).toBe(true);
    expect(m.settled).toBe(2000);
    expect(m.end).toBe(3000);
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
    // Any visible change counts, not just the usual suspects.
    const round = await renderer.render({ ...base, interact: { hover: "n_round" }, lint: true });
    expect(round.issues.some((i) => i.kind === "no-state-style")).toBe(false);
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
    // Caught rather than `expect(...).rejects`, which under Bun waits seconds
    // on a rejection that crossed Playwright.
    const still = await renderer
      .record({ artboard: scroller, tokens: "", scroll: "n_bar" })
      .catch((e) => e);
    expect(still.message).toContain("doesn't scroll");
  });

  test("an artboard that scrolls itself isn't overflowing", async () => {
    const scrolling = parseArtboardFile(
      `<section data-artboard data-id="ab_t" style="width:300px;height:200px;overflow:auto">
${Array.from({ length: 6 }, (_, i) => `<div data-id="n_t${i}" style="height:100px;flex-shrink:0">${i}</div>`).join("")}
</section>`,
      { id: "ab_t", name: "Tall" },
    ).artboard;
    const out = await renderer.render({ artboard: scrolling, tokens: "", lint: true });
    expect(out.issues.filter((i) => i.kind === "offscreen" || i.kind === "overflow")).toEqual([]);
  });

  test("videos set the pace like any animation", async () => {
    const video = parseArtboardFile(
      `<section data-artboard data-id="ab_v" style="width:200px;height:200px"><video data-id="n_v" muted src="data:video/webm;base64,${CLIP}"></video></section>`,
      { id: "ab_v", name: "Video" },
    ).artboard;
    const out = await renderer.record({ artboard: video, tokens: "", frames: 3 });
    expect(out.motion.animations[0]).toMatchObject({ kind: "video", name: "video", end: 2000 });
    expect(out.steps.map((s) => s.label)).toEqual(["0ms", "1000ms", "2000ms settled"]);
  });

  test("unknown ids are errors, not blank frames", async () => {
    const err = await renderer
      .render({ ...base, interact: { hover: "n_missing" } })
      .catch((e) => e);
    expect(err.message).toContain("No node n_missing");
  });
});

describe.skipIf(!chromium)("video stills", () => {
  // The renderer's own browser keeper: started on first use, and closed as the renderer closes
  // one, without waiting on a Chrome slow to answer (a busy Mac takes 10s and more to quit).
  const browser = new BrowserProcess(
    () => playwright.launch({ executablePath: chromium ?? undefined, headless: true }),
    Number.POSITIVE_INFINITY,
  );
  afterAll(() => browser.close());

  /** Each node's tag, box and the styles that place a video's picture in it. */
  const LAYOUT = `Object.fromEntries([...document.querySelectorAll("[data-id]")].map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const n = (v) => Math.round(v * 100) / 100;
    return [el.getAttribute("data-id"), {
      tag: el.tagName,
      box: [n(r.x), n(r.y), n(r.width), n(r.height)],
      style: [cs.objectFit, cs.objectPosition, cs.borderTopLeftRadius, cs.borderTopWidth, cs.transform, cs.opacity],
    }];
  }))`;

  /** A page with the artboard on it and its first frame decoded, laid out as it is before any seek. */
  async function page(artboard: string) {
    const lease = await browser.open(1);
    const p = lease.page;
    const url = "http://stills.test/";
    await p.route(url, (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><style>${ARTBOARD_BASE_CSS}</style></head><body>${artboard}</body></html>`,
      }),
    );
    await p.goto(url);
    await p.evaluate(`(() => {
      const v = document.querySelector("video");
      window.__video = v;
      return v.readyState >= 2 || new Promise((r) => v.addEventListener("loadeddata", r, { once: true }));
    })()`);
    return { p, close: lease.close, before: await p.evaluate<Record<string, any>>(LAYOUT) };
  }

  const board = (css: string) =>
    `<section data-artboard data-id="ab" style="width:300px;height:160px;padding:10px;flex-direction:row;gap:8px">
<style>${css}</style>
<video data-id="n_v" muted src="data:video/webm;base64,${CLIP}" style="width:120px;height:60px;object-fit:cover;object-position:20% 80%;transform:rotate(5deg);border:2px solid #000;opacity:0.9"></video>
<div data-id="n_rest" style="flex:1;height:40px;background:#ccc"></div>
</section>`;

  test("a seeked video is captured from a still of its frame, laid out and styled as the video is", async () => {
    // A rule for video, which a canvas wouldn't match, still styles the still.
    const { p, close, before } = await page(board("video { border-radius: 9px }"));
    try {
      await p.evaluate(prepareScript({ at: 1000 }));
      const held = await p.evaluate<Record<string, any>>(LAYOUT);
      expect(held.n_v.tag).toBe("CANVAS");
      expect({ ...held, n_v: { ...held.n_v, tag: "VIDEO" } } as Record<string, unknown>).toEqual(
        before,
      );
      expect(held.n_v.style[2]).toBe("9px");
      // Lint reads the video itself, then puts the still back for the capture.
      await p.evaluate(FULL_LINT_SCRIPT);
      expect(await p.evaluate(`document.querySelector('[data-id="n_v"]').tagName`)).toBe("CANVAS");
      // Back live, it's the same video, where it was.
      expect(await p.evaluate(motionCall("live"))).toBe(true);
      expect(await p.evaluate(`document.querySelector('[data-id="n_v"]') === window.__video`)).toBe(
        true,
      );
      expect(await p.evaluate(LAYOUT)).toEqual(before);
    } finally {
      await close();
    }
  });

  test("a video stays itself where a selector would read its still differently", async () => {
    const { p, close } = await page(board("video + div { outline: 1px solid red }"));
    try {
      await p.evaluate(prepareScript({ at: 1000 }));
      expect(await p.evaluate(`document.querySelector('[data-id="n_v"]').tagName`)).toBe("VIDEO");
    } finally {
      await close();
    }
  });

  test("a video showing captions stays itself, since a still would leave them out", async () => {
    const { p, close } = await page(board(""));
    try {
      await p.evaluate(`(() => {
        const t = document.querySelector("video").addTextTrack("subtitles", "en");
        t.mode = "showing";
        t.addCue(new VTTCue(0, 2, "Hello"));
      })()`);
      await p.evaluate(prepareScript({ at: 1000 }));
      expect(await p.evaluate(`document.querySelector('[data-id="n_v"]').tagName`)).toBe("VIDEO");
    } finally {
      await close();
    }
  });
});

/** Two seconds of 64×64 red, VP8. */
const CLIP =
  "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";
