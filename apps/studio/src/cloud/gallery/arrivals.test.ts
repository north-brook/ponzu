/*
 * A canvas opening with its answers late, in a real Chromium (the gallery's `canvas-opening`
 * compositions, opening.tsx): each answer delivered in turn and the movement it starts stepped
 * on its own clock (stepArrival), never by counting frames or waiting. Nothing on screen before
 * an answer moves by more than a pixel when it comes, except by the one movement meant to happen (a
 * room opening or closing, whose start and end are checked), and what arrives fades in where it
 * rests. Switching canvases replays nothing; reduced motion moves nothing and lands the same.
 * Skips where there is no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  type ArrivalFrame,
  type Browser,
  buildGallery,
  chromiumPath,
  launch,
  type Page,
  serve,
  stepArrival,
} from "../../../scripts/visual-lib.ts";

setDefaultTimeout(60_000);

/** A pixel: what layout may round a still piece by. */
const PX = 1;

/** The pieces in `before` that are in every frame, and the most each moved from where it was. */
function moved(before: ArrivalFrame, frames: ArrivalFrame[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, was] of Object.entries(before.pieces)) {
    if (was.opacity === 0) continue;
    const at = frames.map((f) => f.pieces[key]);
    if (at.some((p) => !p)) continue;
    out[key] = Math.max(
      ...at.map((p) =>
        Math.max(Math.abs(p!.x - was.x), Math.abs(p!.y - was.y), Math.abs(p!.width - was.width)),
      ),
    );
  }
  return out;
}

/** Everything but `except` stayed within a pixel. */
function expectStill(
  before: ArrivalFrame,
  frames: ArrivalFrame[],
  except: string[] = [],
  /** How many pieces at least were there to stay: a launch has few. */
  least = 4,
) {
  const still = Object.entries(moved(before, frames)).filter(
    ([key]) => !except.some((e) => key.startsWith(e)),
  );
  expect(still.length).toBeGreaterThanOrEqual(least);
  for (const [key, most] of still) {
    expect({ key, most: most <= PX }).toEqual({ key, most: true });
  }
}

/** One piece's x through the frames, which runs from `from` to `to` and never past either. */
function expectGlide(frames: ArrivalFrame[], key: string, from: number, to: number) {
  const xs = frames.map((f) => f.pieces[key]!.x);
  expect(Math.abs(xs[0]! - from)).toBeLessThanOrEqual(PX);
  expect(Math.abs(xs.at(-1)! - to)).toBeLessThanOrEqual(PX);
  const lo = Math.min(from, to) - PX;
  const hi = Math.max(from, to) + PX;
  for (const x of xs) {
    expect(x).toBeGreaterThanOrEqual(lo);
    expect(x).toBeLessThanOrEqual(hi);
  }
  // One way, never back.
  const sign = Math.sign(to - from);
  for (let i = 1; i < xs.length; i++)
    expect((xs[i]! - xs[i - 1]!) * sign).toBeGreaterThanOrEqual(-0.5);
}

/** A piece that arrived: invisible at the start, whole at rest, and only ever more so. */
function expectFadesIn(frames: ArrivalFrame[], key: string) {
  const opacities = frames.map((f) => f.pieces[key]?.opacity ?? 0);
  expect(opacities[0]).toBeLessThan(0.05);
  expect(opacities.at(-1)).toBe(1);
  for (let i = 1; i < opacities.length; i++) {
    expect(opacities[i]!).toBeGreaterThanOrEqual(opacities[i - 1]! - 0.001);
  }
}

describe.skipIf(!chromiumPath)("a canvas opening, its answers late", () => {
  let built: Awaited<ReturnType<typeof buildGallery>>;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    built = await buildGallery();
    server = serve(built.dir);
    browser = await launch();
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop();
    built?.dispose();
  });

  const open = async (board: string, motion: "reduce" | "no-preference" = "no-preference") => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: motion });
    await page.goto(`${server.url}/gallery.html?board=${board}&theme=light`);
    await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
    await page.evaluate(() => document.fonts.ready.then(() => {}));
  };
  const MARK = "button[Pull request #412]";
  const MERGE = "button[Merge]";
  const ME = "img[Ada (you)]";
  const SHARE = "button[Share]";

  test("from the row, the mark is there at the first paint and the action's room is held", async () => {
    await open("canvas-opening");
    const { before } = await stepArrival(page, "nothing", 1);
    expect(before.pieces[MARK]).toBeDefined();
    expect(before.pieces[MERGE]).toBeUndefined();
    // The room held for Merge, unseen: the mark already stands where it will.
    const room = await page.$eval(
      '[data-arrival="action"]',
      (el) => el.getBoundingClientRect().width,
    );
    expect(room).toBeGreaterThan(60);
  });

  test("the pages fade in where they rest, and nothing else moves", async () => {
    await open("canvas-opening");
    const { before, frames, animations } = await stepArrival(page, "pages");
    expect(animations.map((a) => a.id)).toContain("arrival-content");
    expectStill(before, frames);
    expectFadesIn(frames, "tab[Home]");
  });

  test("the expected action comes into its held room: nothing moves, it fades in", async () => {
    await open("canvas-opening");
    const { before, frames, animations } = await stepArrival(page, "action");
    expect(animations.map((a) => a.id)).toEqual(["arrival-content"]);
    // Its room is already there: nothing to wait for, it starts in the frame it lands.
    expect(animations[0]!.delay).toBe(0);
    expectStill(before, frames);
    expectFadesIn(frames, MERGE);
    // It rises a hair as it comes, and rests on the line it will keep.
    const ys = frames.map((f) => f.pieces[MERGE]!.y);
    expect(ys[0]! - ys.at(-1)!).toBeCloseTo(2, 0);
  });

  test("an action other than expected eases the room to its own width, the mark gliding once", async () => {
    await open("canvas-opening");
    const { before, frames, animations } = await stepArrival(page, "action:update_branch");
    const markWas = before.pieces[MARK]!.x;
    const rest = frames.at(-1)!;
    const button = rest.pieces["button[Update branch]"]!;
    // Wider than Merge: the mark moved left by exactly the difference, on the panes' clock.
    expect(rest.pieces[MARK]!.x).toBeLessThan(markWas - 20);
    expectGlide(frames, MARK, markWas, rest.pieces[MARK]!.x);
    expect(animations.find((a) => a.id === "arrival-room")?.duration).toBe(220);
    expectStill(before, frames, [MARK, "img[", SHARE, "button[Update"]);
    expectFadesIn(frames, "button[Update branch]");
    // Ends 12 before the divider, as the cluster always does.
    const divider = rest.pieces["span[divider]'"]!;
    expect(Math.round(divider.x - (button.x + button.width))).toBe(12);
  });

  test("people joining: their room opens, you glide aside once, the rest stays", async () => {
    await open("canvas-opening");
    const { before, frames } = await stepArrival(page, "people");
    const was = before.pieces[ME]!.x;
    const rest = frames.at(-1)!;
    // Three more people, each 16 past the overlap.
    expect(Math.round(was - rest.pieces[ME]!.x)).toBe(3 * 16);
    expectGlide(frames, ME, was, rest.pieces[ME]!.x);
    expectStill(before, frames, [ME]);
    expectFadesIn(frames, "img[Sam]");
  });

  test("an action shown becoming another: the new one fades in as its room eases, never cut", async () => {
    await open("canvas-opening");
    await stepArrival(page, "action");
    const { before, frames, animations } = await stepArrival(page, "action:update_branch");
    expect(animations.map((a) => a.id).sort()).toEqual(["arrival-content", "arrival-room"]);
    const markWas = before.pieces[MARK]!.x;
    expectGlide(frames, MARK, markWas, frames.at(-1)!.pieces[MARK]!.x);
    expectFadesIn(frames, "button[Update branch]");
    // Drawn whole (below), not cut by its room, and clear of the mark once it can be made out:
    // what is still to open is by then within the gap between them (a hair over the mark's
    // padding while it is the faintest ghost).
    for (const f of frames) {
      const b = f.pieces["button[Update branch]"]!;
      const mark = f.pieces[MARK]!;
      const clear = b.x - (mark.x + mark.width);
      if (b.opacity > 0.25) expect(clear).toBeGreaterThanOrEqual(-0.5);
      else if (b.opacity > 0.01) expect(clear).toBeGreaterThan(-3);
    }
    expectStill(before, frames, [MARK, "img[", SHARE, MERGE, "button[Update"]);
    // Back to Merge, looked at as it starts: its room eases, unclipped.
    const overflow = await page.evaluate(() => {
      window.galleryArrive!("action:merge");
      const room = document.querySelector('[data-arrival="action"]')!;
      const moving = room.getAnimations().some((a) => a.id === "arrival-room");
      return moving ? getComputedStyle(room).overflow : null;
    });
    expect(overflow).toBe("visible");
  });

  test("another answer landing while people join neither restarts them nor clips them", async () => {
    await open("canvas-opening");
    // Halfway through their rooms opening (held there), the pages land: a render of the whole
    // chrome while the people are still moving.
    const { mid, after, rooms } = await page.evaluate(() => {
      const look = () => {
        const room = document.querySelector('[data-arrival="presence"]')!.getBoundingClientRect();
        const first = document.querySelector('header [role="img"][aria-label]')!;
        const me = document.querySelector('[aria-label="Ada (you)"]')!;
        return {
          left: room.x,
          width: room.width,
          first: first.getBoundingClientRect().x,
          me: me.getBoundingClientRect().x,
        };
      };
      const known = new Set(document.getAnimations());
      window.galleryArrive!("people");
      for (const a of document.getAnimations().filter((a) => !known.has(a))) {
        a.pause();
        a.currentTime = 110;
      }
      const mid = look();
      const seen = new Set(document.getAnimations());
      window.galleryArrive!("pages");
      const rooms = document
        .getAnimations()
        .filter((a) => !seen.has(a) && a.id.startsWith("arrival-room")).length;
      return { mid, after: look(), rooms };
    });
    // The people's room follows theirs rather than easing again from where it was.
    expect(rooms).toBe(0);
    expect(Math.abs(after.width - mid.width)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(after.me - mid.me)).toBeLessThanOrEqual(0.5);
    // Nothing of theirs outside their room, where it would be cut.
    expect(after.first).toBeGreaterThanOrEqual(after.left - 0.5);
  });

  test("the action leaving is the arrival reversed: it fades, its room closes, the mark glides back", async () => {
    await open("canvas-opening");
    await stepArrival(page, "action");
    const { before, frames } = await stepArrival(page, "action:none");
    const action = before.pieces[MERGE]!;
    const markWas = before.pieces[MARK]!.x;
    const rest = frames.at(-1)!;
    expect(rest.pieces[MERGE]).toBeUndefined();
    // The mark moves right by the action and its gap, and only that way.
    expect(Math.round(rest.pieces[MARK]!.x - markWas)).toBe(Math.round(action.width + 10));
    expectGlide(frames, MARK, markWas, rest.pieces[MARK]!.x);
    expectStill(before, frames, [MARK, "img[", SHARE, MERGE]);
  });

  test("at launch, the mark and the action arrive together as one movement", async () => {
    await open("canvas-opening-launch");
    const title = await stepArrival(page, "title");
    // The name opens its room from the left block: the divider glides out by its width, once,
    // and everything right of the tabs (none yet) stays.
    const name = title.frames.at(-1)!.pieces["span[Quieter shop hero]"]!;
    const dividerWas = title.before.pieces["span[divider]"]!.x;
    expectGlide(title.frames, "span[divider]", dividerWas, dividerWas + name.width);
    expectStill(title.before, title.frames, ["span[Quieter", "span[divider]"], 2);
    expectFadesIn(title.frames, "span[Quieter shop hero]");
    const { before, frames, animations } = await stepArrival(page, "everything");
    const rest = frames.at(-1)!;
    expectFadesIn(frames, MARK);
    expectFadesIn(frames, MERGE);
    // One clock for every room: none starts after another.
    const rooms = animations.filter((a) => a.id === "arrival-room");
    expect(new Set(rooms.map((a) => `${a.duration} ${a.delay} ${a.easing}`)).size).toBe(1);
    // The mark ends beside the action, 10 apart, the two moving together.
    const mark = rest.pieces[MARK]!;
    expect(Math.round(rest.pieces[MERGE]!.x - (mark.x + mark.width))).toBe(10);
    expectStill(before, frames, [MARK, MERGE, "img[", SHARE, "tab[", "button[New page]"], 2);
  });

  test("at launch, the mark arriving alone opens the action's held room with it, on one clock", async () => {
    await open("canvas-opening-launch");
    await stepArrival(page, "title");
    const { frames, animations } = await stepArrival(page, "pull-request");
    // Two rooms open together: the mark's, and the one held for the action it predicts.
    const rooms = animations.filter((a) => a.id === "arrival-room");
    expect(rooms.length).toBe(2);
    expect(new Set(rooms.map((a) => `${a.duration} ${a.delay} ${a.easing}`)).size).toBe(1);
    const held = await page.$eval(
      '[data-arrival="action"]',
      (el) => el.getBoundingClientRect().width,
    );
    expect(held).toBeGreaterThan(60);
    // The mark starts where it would with no action and glides out by exactly the held room,
    // once: the held room never pushes it in a single frame.
    const first = frames[0]!.pieces[MARK]!.x;
    const rest = frames.at(-1)!.pieces[MARK]!.x;
    expect(Math.abs(first - rest - held)).toBeLessThanOrEqual(PX);
    expectGlide(frames, MARK, first, rest);
    expectFadesIn(frames, MARK);
  });

  test("switching to another canvas replays nothing: what both have is simply there", async () => {
    await open("canvas-opening");
    await stepArrival(page, "everything");
    const { frames, animations } = await stepArrival(page, "switch");
    expect(animations).toEqual([]);
    // The other canvas's mark, and its own expected action's room, from its first frame.
    expect(frames.at(-1)!.pieces["button[Pull request #405]"]?.opacity).toBe(1);
    const room = await page.$eval(
      '[data-arrival="action"]',
      (el) => el.getBoundingClientRect().width,
    );
    expect(room).toBeGreaterThan(60);
  });

  test("reduced motion: nothing eases or travels, and every answer lands where it would", async () => {
    await open("canvas-opening", "no-preference");
    await stepArrival(page, "everything");
    await stepArrival(page, "action:update_branch");
    const moving = (await stepArrival(page, "action:fix_checks")).frames.at(-1)!;
    await open("canvas-opening", "reduce");
    const steps = [
      await stepArrival(page, "everything"),
      await stepArrival(page, "action:update_branch"),
      await stepArrival(page, "action:fix_checks"),
    ];
    for (const s of steps) expect(s.animations).toEqual([]);
    const still = steps.at(-1)!.frames.at(-1)!;
    for (const key of [MARK, "button[Fix checks]", ME, SHARE]) {
      expect(still.pieces[key]).toBeDefined();
      expect(Math.abs(still.pieces[key]!.x - moving.pieces[key]!.x)).toBeLessThanOrEqual(PX);
      expect(still.pieces[key]!.opacity).toBe(moving.pieces[key]!.opacity);
    }
  });
});
