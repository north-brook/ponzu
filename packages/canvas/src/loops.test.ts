import { expect, test } from "bun:test";
import { parseArtboardFile } from "@ponzu/core";
import { boardCost, coldLive, coldSkeleton, placeholderFill } from "./coldopen.ts";
import { cssCopies } from "./images.ts";
import { askLoops, chosen, liveTimeFor, videoTimeFor } from "./loops.tsx";

test("the biggest videos on screen play, up to the cap", () => {
  const on = new Map([
    ["small", 100],
    ["big", 10_000],
    ["mid", 2_000],
  ]);
  expect(chosen(on, 2)).toEqual(new Set(["big", "mid"]));
  expect(chosen(on, 10)).toEqual(new Set(["big", "mid", "small"]));
  expect(chosen(new Map(), 4).size).toBe(0);
});

test("live time for a video time is the next one in phase, never behind the board", () => {
  // Loop of 7 s starting at t0 = 400: video 1.5 s shows 1900, 8900, 15900...
  expect(liveTimeFor(1500, 400, 7000, 0)).toBe(8900);
  expect(liveTimeFor(1500, 400, 7000, 12_000)).toBe(15_900);
  // Always a whole number of periods from the video's own time.
  for (const now of [0, 3333, 10_000, 99_999]) {
    const t = liveTimeFor(2500, 400, 7000, now);
    expect((t - 400 - 2500) % 7000).toBe(0);
    expect(t).toBeGreaterThanOrEqual(now);
  }
});

test("video time for a board time wraps by the loop's period, before t0 too", () => {
  expect(videoTimeFor(400, 400, 7000)).toBe(0);
  expect(videoTimeFor(8900, 400, 7000)).toBe(1500);
  expect(videoTimeFor(100, 400, 7000)).toBe(6700);
  // Round trip: video -> live -> video.
  expect(videoTimeFor(liveTimeFor(3210, 400, 9600, 50_000), 400, 9600)).toBe(3210);
});

const board = (html: string) => parseArtboardFile(html, { id: "ab_x", name: "Board" }).artboard;

test("cold open: small still boards go live, media, loops and big boards wait", () => {
  const small = board(
    `<section data-artboard data-id="ab_s" style="width:400px;height:300px"><h1>Hi</h1><p>Text</p></section>`,
  );
  const photos = board(
    `<section data-artboard data-id="ab_p" style="width:400px;height:300px"><img src="assets/a.jpg"><img src="assets/b.jpg"><div style="background-image:url(assets/c.jpg)"></div></section>`,
  );
  const spin = board(
    `<section data-artboard data-id="ab_l" style="width:400px;height:300px"><style>.s{animation:spin 1s linear infinite}</style><div class="s"></div></section>`,
  );
  const big = board(
    `<section data-artboard data-id="ab_b" style="width:400px;height:300px">${"<div><span>x</span></div>".repeat(900)}</section>`,
  );
  expect(boardCost(small)).toMatchObject({ media: 0, loops: false, cheap: true });
  expect(boardCost(photos)).toMatchObject({ media: 3, cheap: false });
  expect(boardCost(spin)).toMatchObject({ loops: true, cheap: false });
  expect(boardCost(big).elements).toBeGreaterThan(1500);
  expect([...coldLive([small, photos, spin, big])]).toEqual(["ab_s"]);
  // The rest show as skeletons: text and layout now, media and motion with the picture.
  expect([...coldSkeleton([small, photos, spin, big])]).toEqual(["ab_p", "ab_l", "ab_b"]);
});

test("placeholders take the board's own plain background", () => {
  expect(
    placeholderFill(
      board(
        `<section data-artboard data-id="ab_d" style="width:10px;height:10px;background:#0b0b0f"></section>`,
      ),
    ),
  ).toBe("#0b0b0f");
  expect(
    placeholderFill(
      board(
        `<section data-artboard data-id="ab_g" style="width:10px;height:10px;background:linear-gradient(red,blue)"></section>`,
      ),
    ),
  ).toBe("#fff");
});

test("a server error or no server is asked again; only an answer, or none, is kept", async () => {
  const url = "http://127.0.0.1:7777/api/loops?artboard=ab&v=1";
  const answer = (res: Response | Error) =>
    askLoops(url, (async () => {
      if (res instanceof Error) throw res;
      return res;
    }) as unknown as typeof fetch);
  expect(await answer(new Response(null, { status: 503 }))).toBe("failed");
  expect(await answer(new Response(null, { status: 500 }))).toBe("failed");
  expect(await answer(new TypeError("Failed to fetch"))).toBe("failed");
  expect(await answer(new Response(null, { status: 202 }))).toBe("pending");
  // No loops, for good.
  expect(await answer(new Response(null, { status: 204 }))).toBeNull();
  const m = await answer(
    Response.json(
      {
        t0: 0,
        regions: [
          { x: 0, y: 0, width: 1, height: 1, period: 1000, src: "/api/loop?id=a.mp4", ids: [] },
        ],
      },
      { headers: { "x-pz-version": "1" } },
    ),
  );
  expect(m && typeof m === "object" && m.regions[0]!.src).toBe(
    "http://127.0.0.1:7777/api/loop?id=a.mp4",
  );
});

test("a style sheet preloads only its images' copies, not its fonts", () => {
  const base = "http://127.0.0.1:7777/d/a.design";
  const urls = [`${base}/assets/bg.jpg`, `${base}/assets/brand.woff2`, "https://cdn.example/x.png"];
  expect(cssCopies(urls, base, "style", 512)).toEqual([`${base}/assets/bg.jpg?w=512`]);
});
