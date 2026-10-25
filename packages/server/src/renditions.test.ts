import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trim } from "./cache.ts";
import { fileSource, imageKind, Renditions, renditionWidth } from "./renditions.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-renditions-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A w×h test image in a format Bun encodes. */
const image = (w: number, h: number, fmt: "jpeg" | "png" | "webp") => {
  // Any source will do: a 1×1 PNG stretched to size.
  const px = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    ),
    (c) => c.charCodeAt(0),
  );
  const img = new Bun.Image(px).resize(w, h, { fit: "fill" });
  return (fmt === "jpeg" ? img.jpeg() : fmt === "png" ? img.png() : img.webp()).bytes();
};

test("copy widths step up, and an image about that small is served as it is", () => {
  expect(renditionWidth(10, 4000)).toBe(256);
  expect(renditionWidth(300, 4000)).toBe(512);
  expect(renditionWidth(1024, 4000)).toBe(1024);
  expect(renditionWidth(1100, 1200)).toBeNull();
  expect(renditionWidth(9000, 20000)).toBeNull();
  expect(renditionWidth(Number.NaN, 4000)).toBeNull();
});

test("an opaque image's copy is a JPEG that lays out at the original's size", async () => {
  const file = join(dir, "photo.jpg");
  await writeFile(file, await image(3001, 2001, "jpeg"));
  const r = new Renditions({ dir });
  const copy = await r.get((await fileSource(file))!, 300);
  expect(copy?.type).toBe("image/jpeg");
  const md = await new Bun.Image(copy!.bytes).metadata();
  expect(md.width).toBe(512);
  expect(md.height).toBe(341);
  // EXIF says how big the original is: PixelXDimension and PixelYDimension.
  const exif = Buffer.from(copy!.bytes);
  expect(exif.includes(Buffer.from("Exif\0\0"))).toBe(true);
  const at = exif.indexOf(Buffer.from([0xa0, 0x02, 0x00, 0x04]));
  expect(exif.readUInt32BE(at + 8)).toBe(3001);
  // Cached on disk: the second ask reads it back.
  expect((await r.get((await fileSource(file))!, 400))?.bytes).toEqual(copy!.bytes);
});

test("an image with transparency gets a WebP in an SVG of the original's size", async () => {
  const file = join(dir, "logo.png");
  await writeFile(file, await image(2000, 1000, "png"));
  const kind = imageKind(new Uint8Array(await Bun.file(file).bytes()));
  const copy = await new Renditions({ dir }).get((await fileSource(file))!, 256);
  if (kind.opaque) {
    expect(copy?.type).toBe("image/jpeg");
  } else {
    expect(copy?.type).toBe("image/svg+xml");
    const svg = new TextDecoder().decode(copy!.bytes);
    expect(svg).toContain('width="2000" height="1000"');
    expect(svg).toContain("data:image/webp;base64,");
  }
});

test("animated images and small ones serve as they are", async () => {
  const small = join(dir, "small.jpg");
  await writeFile(small, await image(200, 100, "jpeg"));
  const r = new Renditions({ dir });
  expect(await r.get((await fileSource(small))!, 256)).toBeNull();
  const gif = join(dir, "anim.gif");
  await writeFile(gif, new TextEncoder().encode("GIF89a\x01\x00\x01\x00"));
  expect(await r.get((await fileSource(gif))!, 256)).toBeNull();
});

test("a changed original gets new copies", async () => {
  const file = join(dir, "edit.jpg");
  await writeFile(file, await image(3000, 1000, "jpeg"));
  const r = new Renditions({ dir });
  const a = await r.get((await fileSource(file))!, 256);
  await Bun.sleep(5);
  await writeFile(file, await image(3000, 2000, "jpeg"));
  const b = await r.get((await fileSource(file))!, 256);
  expect((await new Bun.Image(a!.bytes).metadata()).height).toBe(85);
  expect((await new Bun.Image(b!.bytes).metadata()).height).toBe(171);
});

test("headers tell opaque, transparent and animated images apart", () => {
  const png = (colorType: number, chunks: string[] = []) => {
    const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const chunk = (type: string, len: number) => {
      out.push(0, 0, 0, len, ...[...type].map((c) => c.charCodeAt(0)));
      for (let i = 0; i < len + 4; i++) out.push(0);
    };
    chunk("IHDR", 13);
    out[8 + 8 + 9] = colorType;
    for (const c of chunks) chunk(c, 0);
    chunk("IDAT", 0);
    return new Uint8Array(out);
  };
  expect(imageKind(png(2))).toEqual({ known: true, opaque: true, animated: false });
  expect(imageKind(png(6))).toEqual({ known: true, opaque: false, animated: false });
  expect(imageKind(png(2, ["tRNS"])).opaque).toBe(false);
  expect(imageKind(png(2, ["acTL"])).animated).toBe(true);
  expect(imageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).opaque).toBe(true);
  expect(imageKind(new TextEncoder().encode("GIF89a")).animated).toBe(true);
  expect(imageKind(new TextEncoder().encode("<svg")).known).toBe(false);
});

test("trimming drops the least recently used copies", async () => {
  const d = join(dir, "trim");
  await Bun.write(join(d, "a"), new Uint8Array(600));
  await Bun.sleep(10);
  await Bun.write(join(d, "b"), new Uint8Array(600));
  await trim(d, 1000);
  expect(await readdir(d)).toEqual(["b"]);
});

test("an image claiming a huge size isn't decoded to make a copy", async () => {
  // A PNG header that says 60000 × 60000: 3.6 billion pixels from a few bytes.
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, 60000);
  v.setUint32(4, 60000);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const d = new DataView(out.buffer);
    d.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    return out;
  };
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const bytes = new Uint8Array([
    ...sig,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", new Uint8Array(8)),
    ...chunk("IEND", new Uint8Array()),
  ]);
  const r = new Renditions({ dir: join(dir, "huge") });
  expect(await r.get({ bytes, v: "1" }, 512)).toBeNull();
});
