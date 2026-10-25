import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardVersion, serializeArtboardElement } from "@ponzu/core";
import type { LoopRequest, LoopResult, Renderer, RenderRequest, RenderResult } from "@ponzu/render";
import { trim } from "./cache.ts";
import { boardHtml, contentHash, Pictures, pictureRoute, rangeResponse } from "./pictures.ts";
import { LocalWorkspace } from "./workspace.ts";

/** Draws a 1-byte "picture" per call and films one region; counts what it was asked. */
class FakeRenderer implements Renderer {
  renders: RenderRequest[] = [];
  loops: LoopRequest[] = [];
  /** Runs while a render is in flight, before it returns. */
  during?: () => void;
  timedOut = false;
  failFilm = 0;
  hangFilm = false;
  /** Hung films that were told to stop. */
  aborted = 0;
  async render(req: RenderRequest): Promise<RenderResult> {
    this.renders.push(req);
    this.during?.();
    await Bun.sleep(1);
    const looping = JSON.stringify(req.artboard).includes("infinite");
    return {
      ...(this.timedOut ? { assetsTimedOut: true } : {}),
      bytes: new Uint8Array([0xff, this.renders.length]),
      mime: "image/jpeg",
      width: 1,
      height: 1,
      contentHeight: 1,
      issues: [],
      motion: {
        trigger: "load",
        animations: [],
        settled: 0,
        loops: looping,
        loopSize: looping ? 100 : 0,
        cycle: 1000,
        end: 1000,
        at: 0,
      },
    };
  }
  async loop(req: LoopRequest): Promise<LoopResult> {
    this.loops.push(req);
    if (this.hangFilm)
      return new Promise((_, reject) =>
        req.signal?.addEventListener("abort", () => {
          this.aborted++;
          reject(new Error("closed"));
        }),
      );
    if (this.failFilm > 0) {
      this.failFilm--;
      throw new Error("the render host went away");
    }
    return {
      t0: 0,
      regions: [
        {
          x: 1,
          y: 2,
          width: 30,
          height: 40,
          period: 1000,
          ids: ["n_dot"],
          animations: 1,
          videoWidth: 30,
          videoHeight: 40,
          frames: 30,
          bytes: new Uint8Array([0, 0, 0, 8, 1, 2, 3, 4, 5, 6]),
          mime: "video/mp4",
        },
      ],
      still: [],
      motion: {} as LoopResult["motion"],
      ms: 1,
      ...(this.timedOut ? { assetsTimedOut: true } : {}),
    };
  }
  async close() {}
}

let dir: string;
let ws: LocalWorkspace;
let renderer: FakeRenderer;
let pictures: Pictures;
let key: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-pictures-"));
  renderer = new FakeRenderer();
  ws = new LocalWorkspace({ cwd: dir, renderer, previews: false });
  const opened = await ws.open(join(dir, "a.design"));
  key = opened.key;
  opened.design.apply(
    {
      op: "artboard.create",
      page: opened.design.doc.pages[0]!.id,
      index: 0,
      artboard: {
        id: "ab_still",
        name: "Still",
        x: 0,
        y: 0,
        root: {
          kind: "el",
          id: "ab_still",
          tag: "section",
          attrs: {},
          style: { width: "100px", height: "100px" },
          children: [],
        },
      },
    },
    { kind: "user", name: "test" },
  );
  opened.design.apply(
    {
      op: "artboard.create",
      page: opened.design.doc.pages[0]!.id,
      index: 1,
      artboard: {
        id: "ab_spin",
        name: "Spin",
        x: 200,
        y: 0,
        root: {
          kind: "el",
          id: "ab_spin",
          tag: "section",
          attrs: {},
          style: { width: "100px", height: "100px" },
          children: [
            {
              kind: "el",
              id: "n_dot",
              tag: "div",
              attrs: {},
              style: { animation: "spin 1s linear infinite" },
              children: [],
            },
          ],
        },
      },
    },
    { kind: "user", name: "test" },
  );
  pictures = new Pictures(ws, { dir: join(dir, "cache") });
});

afterAll(async () => {
  await ws.closeAll();
  await rm(dir, { recursive: true, force: true });
});

const url = (path: string, q: Record<string, string>) =>
  new URL(`http://x${path}?${new URLSearchParams({ file: key, ...q })}`);
const route = (path: string, q: Record<string, string>, range?: string, etag?: string) =>
  pictureRoute(pictures, path, url(path, q), async () => true, range, etag);
/** The version the canvas would name for a board now. */
const versionOf = (id: string) => {
  const d = ws.get(key)!.doc;
  const ab = d.pages.flatMap((p) => p.artboards).find((a) => a.id === id)!;
  return boardVersion(serializeArtboardElement(ab), d.tokens);
};

test("a missing picture answers 202 at once, and is made for the next ask", async () => {
  const first = await route("/api/snapshot", { artboard: "ab_still", scale: "0.5", wait: "0" });
  expect(first!.status).toBe(202);
  const made = await route("/api/snapshot", { artboard: "ab_still", scale: "0.5", wait: "1" });
  expect(made!.status).toBe(200);
  expect(made!.headers.get("x-pz-loops")).toBe("0");
  // Cached on disk by content: a second ask draws nothing new.
  const n = renderer.renders.length;
  const again = await route("/api/snapshot", { artboard: "ab_still", scale: "0.5", wait: "0" });
  expect(again!.status).toBe(200);
  expect(renderer.renders.length).toBe(n);
  // Renders ask for image renditions.
  expect((renderer.renders[0] as RenderRequest & { thumbnail?: boolean }).thumbnail).toBe(true);
});

test("a bigger picture already made serves a smaller ask", async () => {
  await route("/api/snapshot", { artboard: "ab_still", scale: "1", wait: "1" });
  const small = await route("/api/snapshot", { artboard: "ab_still", scale: "0.25", wait: "0" });
  expect(small!.status).toBe(200);
  expect(Number(small!.headers.get("x-pz-scale"))).toBeGreaterThan(0.25);
});

test("a board that loops gets a manifest and range-served videos; one that doesn't, 204", async () => {
  const pic = await route("/api/snapshot", { artboard: "ab_spin", scale: "0.5", wait: "1" });
  expect(pic!.headers.get("x-pz-loops")).toBe("1");
  const m = await route("/api/loops", { artboard: "ab_spin", wait: "1" });
  expect(m!.status).toBe(200);
  const manifest = (await m!.json()) as { t0: number; regions: { src: string; ids: string[] }[] };
  expect(manifest.regions[0]!.ids).toEqual(["n_dot"]);
  const id = new URL(manifest.regions[0]!.src, "http://x").searchParams.get("id")!;
  const part = await pictureRoute(
    pictures,
    "/api/loop",
    new URL(`http://x/api/loop?id=${id}`),
    async () => true,
    "bytes=2-5",
  );
  expect(part!.status).toBe(206);
  expect(part!.headers.get("content-range")).toBe("bytes 2-5/10");
  expect([...new Uint8Array(await part!.arrayBuffer())]).toEqual([0, 8, 1, 2]);
  const none = await route("/api/loops", { artboard: "ab_still", wait: "1" });
  expect(none!.status).toBe(204);
  // Filmed once, at twice the scale it shows at.
  expect(renderer.loops.length).toBe(1);
  expect(renderer.loops[0]!.scale).toBe(1);
  expect(
    (await readdir(join(dir, "cache", "loops"))).filter((f) => f.endsWith(".mp4")).length,
  ).toBe(1);
});

test("an edit makes a new picture; the old one isn't served for it", async () => {
  const before = await route("/api/snapshot", { artboard: "ab_still", scale: "0.5", wait: "1" });
  const a = new Uint8Array(await before!.arrayBuffer());
  ws.get(key)!.apply(
    { op: "style", id: "ab_still", style: { width: "100px", height: "100px", background: "red" } },
    { kind: "user", name: "test" },
  );
  const after = await route("/api/snapshot", { artboard: "ab_still", scale: "0.5", wait: "1" });
  const b = new Uint8Array(await after!.arrayBuffer());
  expect([...b]).not.toEqual([...a]);
});

test("range responses: whole, part, suffix and out of range", async () => {
  const bytes = new Uint8Array([10, 11, 12, 13, 14]);
  const whole = rangeResponse(bytes, null, {});
  expect(whole.status).toBe(200);
  expect(whole.headers.get("accept-ranges")).toBe("bytes");
  const suffix = rangeResponse(bytes, "bytes=-2", {});
  expect([...new Uint8Array(await suffix.arrayBuffer())]).toEqual([13, 14]);
  const open = rangeResponse(bytes, "bytes=3-", {});
  expect(open.headers.get("content-range")).toBe("bytes 3-4/5");
  expect(rangeResponse(bytes, "bytes=9-", {}).status).toBe(416);
});

test("only an answer for the version asked for may be kept, and it carries its version", async () => {
  const v = versionOf("ab_still");
  const ok = await route("/api/snapshot", { artboard: "ab_still", scale: "0.5", wait: "1", v });
  expect(ok!.headers.get("x-pz-version")).toBe(v);
  expect(ok!.headers.get("cache-control")).toBe("private, no-cache");
  expect(ok!.headers.get("x-content-type-options")).toBe("nosniff");
  expect(ok!.headers.get("content-security-policy")).toContain("sandbox");
  expect(ok!.headers.get("access-control-expose-headers")).toContain("x-pz-version");
  // Revalidated by content: a cheap 304 while nothing changed.
  const etag = ok!.headers.get("etag")!;
  const again = await route(
    "/api/snapshot",
    { artboard: "ab_still", scale: "0.5", wait: "0", v },
    undefined,
    etag,
  );
  expect(again!.status).toBe(304);
  // Asked for another version (the canvas is behind or ahead): served, never kept.
  const other = await route("/api/snapshot", {
    artboard: "ab_still",
    scale: "0.5",
    wait: "1",
    v: "stale",
  });
  expect(other!.status).toBe(200);
  expect(other!.headers.get("cache-control")).toBe("no-store");
  expect(other!.headers.get("x-pz-version")).toBe(v);
});

test("a job draws the board as it is when it starts, and files it under that", async () => {
  const d = ws.get(key)!;
  const user = { kind: "user" as const, name: "test" };
  const style = (bg: string) => ({
    op: "style" as const,
    id: "ab_still",
    style: { width: "100px", height: "100px", background: bg },
  });
  d.apply(style("blue"), user);
  const blue = versionOf("ab_still");
  // An edit while the picture is drawn: the job already took its copy.
  renderer.during = () => {
    renderer.during = undefined;
    d.apply(style("green"), user);
  };
  const drawn = await route("/api/snapshot", { artboard: "ab_still", scale: "0.5", wait: "1" });
  const asked = renderer.renders.at(-1)!;
  expect(JSON.stringify(asked.artboard)).toContain("blue");
  // What it drew is blue, and says so; the board is green now and gets its own picture.
  expect(drawn!.headers.get("x-pz-version")).toBe(blue);
  const green = await route("/api/snapshot", { artboard: "ab_still", scale: "0.5", wait: "1" });
  expect(green!.headers.get("x-pz-version")).toBe(versionOf("ab_still"));
  expect(JSON.stringify(renderer.renders.at(-1)!.artboard)).toContain("green");
});

test("a picture drawn before its fonts and images came is served, not kept", async () => {
  const d = ws.get(key)!;
  d.apply(
    { op: "style", id: "ab_still", style: { width: "100px", height: "100px", background: "pink" } },
    { kind: "user", name: "test" },
  );
  renderer.timedOut = true;
  try {
    const v = versionOf("ab_still");
    const kept = async () => (await readdir(join(dir, "cache", "pictures"))).length;
    const files = await kept();
    const pic = await route("/api/snapshot", { artboard: "ab_still", scale: "1", wait: "1", v });
    expect(pic!.status).toBe(200);
    expect(pic!.headers.get("cache-control")).toBe("no-store");
    expect(pic!.headers.get("etag")).toBeNull();
    expect(await kept()).toBe(files);
  } finally {
    renderer.timedOut = false;
  }
});

test("a film that fails or hangs is tried again later, not marked unfilmable", async () => {
  const d = ws.get(key)!;
  d.apply(
    {
      op: "style",
      id: "n_dot",
      style: { animation: "spin 2s linear infinite" },
    },
    { kind: "user", name: "test" },
  );
  await route("/api/snapshot", { artboard: "ab_spin", scale: "0.5", wait: "1" });
  renderer.failFilm = 1;
  const failed = await route("/api/loops", { artboard: "ab_spin", wait: "1" });
  // "Not yet", like a film in progress: the canvas asks again later rather than giving up.
  expect(failed!.status).toBe(202);
  expect(failed!.headers.get("cache-control")).toBe("no-store");
  const loops = join(dir, "cache", "loops");
  const manifests = async () => (await readdir(loops)).filter((f) => f.endsWith(".json"));
  // Nothing written for it: a null would have said "never".
  for (const m of await manifests()) expect(await Bun.file(join(loops, m)).text()).not.toBe("null");
  expect(renderer.failFilm).toBe(0);
});

test("loops filmed before their fonts or images came aren't kept", async () => {
  const r = new FakeRenderer();
  r.timedOut = true;
  const w = new LocalWorkspace({ cwd: dir, renderer: r, previews: false });
  const opened = await w.open(join(dir, "e.design"));
  opened.design.apply(
    {
      op: "artboard.create",
      page: opened.design.doc.pages[0]!.id,
      index: 0,
      artboard: {
        id: "ab_e",
        name: "e",
        x: 0,
        y: 0,
        root: {
          kind: "el",
          id: "ab_e",
          tag: "section",
          attrs: {},
          style: { animation: "e 1s linear infinite" },
          children: [],
        },
      },
    },
    { kind: "user", name: "test" },
  );
  const cache = join(dir, "cache-e");
  const p = new Pictures(w, { dir: cache });
  const m = await p.loops(opened.key, "ab_e", { wait: true, priority: "now" });
  expect(m && m !== "pending" && m.retry).toBe(true);
  expect(await readdir(join(cache, "loops")).catch(() => [])).toEqual([]);
  await w.closeAll();
});

test("a hung film gives up at its deadline and frees the loop lane", async () => {
  const r = new FakeRenderer();
  r.hangFilm = true;
  const w = new LocalWorkspace({ cwd: dir, renderer: r, previews: false });
  const opened = await w.open(join(dir, "c.design"));
  for (const id of ["ab_h1", "ab_h2"])
    opened.design.apply(
      {
        op: "artboard.create",
        page: opened.design.doc.pages[0]!.id,
        index: 0,
        artboard: {
          id,
          name: id,
          x: 0,
          y: 0,
          root: {
            kind: "el",
            id,
            tag: "section",
            attrs: {},
            style: { animation: `${id} 1s linear infinite` },
            children: [],
          },
        },
      },
      { kind: "user", name: "test" },
    );
  const p = new Pictures(w, { dir: join(dir, "cache-c"), filmDeadlineMs: 100 });
  const one = await p.loops(opened.key, "ab_h1", { wait: true, priority: "now" });
  expect(one && one !== "pending" && one.retry).toBe(true);
  // The lane is free: the next board is filmed (and gives up) too.
  const two = await p.loops(opened.key, "ab_h2", { wait: true, priority: "now" });
  expect(two && two !== "pending" && two.retry).toBe(true);
  expect(r.loops.length).toBe(2);
  // Each was told to stop, so its page closes rather than piling up.
  expect(r.aborted).toBe(2);
  await w.closeAll();
});

test("background work waits while an agent renders; the canvas's asks still go, one at a time", async () => {
  let busy = true;
  const r = new FakeRenderer();
  const w = new LocalWorkspace({ cwd: dir, renderer: r, previews: false });
  const opened = await w.open(join(dir, "b.design"));
  opened.design.apply(
    {
      op: "artboard.create",
      page: opened.design.doc.pages[0]!.id,
      index: 0,
      artboard: {
        id: "ab_q",
        name: "Q",
        x: 0,
        y: 0,
        root: { kind: "el", id: "ab_q", tag: "section", attrs: {}, style: {}, children: [] },
      },
    },
    { kind: "user", name: "test" },
  );
  const p = new Pictures(w, { dir: join(dir, "cache-b"), agentBusy: () => busy });
  p.warm(opened.key);
  await Bun.sleep(50);
  expect(r.renders.length).toBe(0);
  // The canvas asks for what's on screen: it's drawn even now.
  const now = await p.picture(opened.key, "ab_q", 1, { wait: true, priority: "now" });
  expect(now && now !== "pending").toBeTruthy();
  busy = false;
  await Bun.sleep(1200);
  expect(r.renders.length).toBeGreaterThan(1);
  await w.closeAll();
});

test("a picture and its metadata are trimmed together; one without the other is drawn again", async () => {
  const d = join(dir, "units");
  await mkdir(d, { recursive: true });
  const old = new Date(Date.now() - 10_000);
  await writeFile(join(d, "aaa.json"), "{}");
  await writeFile(join(d, "aaa-0.5.jpg"), new Uint8Array(600));
  await writeFile(join(d, "bbb.json"), "{}");
  await writeFile(join(d, "bbb-0.5.jpg"), new Uint8Array(600));
  for (const f of ["aaa.json", "aaa-0.5.jpg"]) await utimes(join(d, f), old, old);
  await trim(d, 1000);
  expect((await readdir(d)).sort()).toEqual(["bbb-0.5.jpg", "bbb.json"]);
});

test("a design closed and opened again is watched afresh", async () => {
  const before = renderer.renders.length;
  pictures.opened(key);
  await ws.close(key);
  const reopened = await ws.open(join(dir, "a.design"));
  pictures.opened(reopened.key);
  reopened.design.apply(
    { op: "style", id: "ab_still", style: { width: "100px", height: "100px", background: "teal" } },
    { kind: "user", name: "test" },
  );
  // Edits redraw a moment after they settle.
  await Bun.sleep(2500);
  expect(
    renderer.renders.slice(before).some((r) => JSON.stringify(r.artboard).includes("teal")),
  ).toBe(true);
});

test("a picture's name changes with every asset the board uses, however it's written", async () => {
  const design = join(dir, "assets-test.design");
  await mkdir(join(design, "assets"), { recursive: true });
  const photo = join(design, "assets", "my photo.png");
  const logo = join(design, "assets", "logo.svg");
  await writeFile(photo, "a");
  await writeFile(logo, "a");
  const ab = {
    id: "ab_a",
    name: "A",
    x: 0,
    y: 0,
    root: {
      kind: "el",
      id: "ab_a",
      tag: "section",
      attrs: {},
      style: { "background-image": 'url("assets/my photo.png")' },
      children: [
        {
          kind: "el",
          id: "n_img",
          tag: "img",
          attrs: { srcset: "./assets/logo.svg 1x, assets/missing.png 2x" },
          style: {},
          children: [],
        },
      ],
    },
  } as unknown as Parameters<typeof boardHtml>[0];
  const { html, assets } = boardHtml(ab, "");
  expect([...assets].sort()).toEqual([
    "assets/logo.svg",
    "assets/missing.png",
    "assets/my photo.png",
  ]);
  const before = await contentHash(html, "", "light", design, assets);
  await writeFile(photo, "bb");
  expect(await contentHash(html, "", "light", design, assets)).not.toBe(before);
  const mid = await contentHash(html, "", "light", design, assets);
  await utimes(logo, new Date(), new Date(Date.now() + 5000));
  expect(await contentHash(html, "", "light", design, assets)).not.toBe(mid);
});
