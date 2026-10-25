import { expect, test } from "bun:test";
import { muxH264 } from "./mp4.ts";

const u32 = (b: Uint8Array, o: number) =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const type = (b: Uint8Array, o: number) => String.fromCharCode(...b.subarray(o + 4, o + 8));

/** Top-level boxes, and a box found anywhere by its path. */
function boxes(b: Uint8Array, from = 0, to = b.length) {
  const out: { type: string; at: number; size: number }[] = [];
  for (let o = from; o + 8 <= to; ) {
    const size = u32(b, o);
    out.push({ type: type(b, o), at: o, size });
    if (size < 8) break;
    o += size;
  }
  return out;
}

function find(b: Uint8Array, path: string[]): { at: number; size: number } | null {
  let from = 0;
  let to = b.length;
  let hit: { at: number; size: number } | null = null;
  for (const [i, name] of path.entries()) {
    const box = boxes(b, from, to).find((x) => x.type === name);
    if (!box) return null;
    hit = box;
    // Containers hold boxes right after their 8-byte header; stsd and dref have 8 more bytes.
    const skip = name === "stsd" || name === "dref" ? 16 : name === "avc1" ? 86 : 8;
    if (i < path.length - 1) {
      from = box.at + skip;
      to = box.at + box.size;
    }
  }
  return hit;
}

const track = {
  width: 172,
  height: 96,
  timescale: 420_000,
  sampleDuration: 7000,
  description: new Uint8Array([1, 0x4d, 0, 0x28, 0xff, 0xe1, 0, 0]),
  samples: [new Uint8Array([0, 0, 0, 1, 0x65]), new Uint8Array([0, 0, 0, 2, 0x41, 0x9a])],
  keyframes: [true, false],
};

test("an MP4 with its index before its data, so playback can start at once", () => {
  const mp4 = muxH264(track);
  expect(boxes(mp4).map((x) => x.type)).toEqual(["ftyp", "moov", "mdat"]);
  const total = boxes(mp4).reduce((n, x) => n + x.size, 0);
  expect(total).toBe(mp4.length);
});

test("timing: every sample lasts sampleDuration ticks, so a loop's length is exact", () => {
  const mp4 = muxH264(track);
  const mdhd = find(mp4, ["moov", "trak", "mdia", "mdhd"])!;
  expect(u32(mp4, mdhd.at + 20)).toBe(420_000); // timescale
  expect(u32(mp4, mdhd.at + 24)).toBe(14_000); // duration: 2 samples × 7000
  const stts = find(mp4, ["moov", "trak", "mdia", "minf", "stbl", "stts"])!;
  expect([u32(mp4, stts.at + 16), u32(mp4, stts.at + 20)]).toEqual([2, 7000]);
});

test("the chunk offset points at the first sample, and sizes and sync samples match", () => {
  const mp4 = muxH264(track);
  const stco = find(mp4, ["moov", "trak", "mdia", "minf", "stbl", "stco"])!;
  const offset = u32(mp4, stco.at + 16);
  expect([...mp4.subarray(offset, offset + 5)]).toEqual([...track.samples[0]!]);
  const stsz = find(mp4, ["moov", "trak", "mdia", "minf", "stbl", "stsz"])!;
  expect([u32(mp4, stsz.at + 20), u32(mp4, stsz.at + 24)]).toEqual([5, 6]);
  const stss = find(mp4, ["moov", "trak", "mdia", "minf", "stbl", "stss"])!;
  expect([u32(mp4, stss.at + 12), u32(mp4, stss.at + 16)]).toEqual([1, 1]);
  const avcC = find(mp4, ["moov", "trak", "mdia", "minf", "stbl", "stsd", "avc1", "avcC"])!;
  expect([...mp4.subarray(avcC.at + 8, avcC.at + avcC.size)]).toEqual([...track.description]);
});

test("refuses a track that can't start playing", () => {
  expect(() => muxH264({ ...track, keyframes: [false, true] })).toThrow();
  expect(() => muxH264({ ...track, samples: [], keyframes: [] })).toThrow();
});
