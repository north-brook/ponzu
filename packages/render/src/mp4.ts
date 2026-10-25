/**
 * The smallest MP4 that browsers play: one H.264 track, no audio, moov
 * before mdat so playback can start before the last byte. Samples come from
 * WebCodecs in AVCC form (length-prefixed NAL units) with the avcC record
 * as the decoder description. No imports, so any host can bundle it.
 */

export interface H264Track {
  width: number;
  height: number;
  /** Ticks per second. */
  timescale: number;
  /** Every sample lasts this many ticks. */
  sampleDuration: number;
  /** The avcC record (AVCDecoderConfigurationRecord). */
  description: Uint8Array;
  /** Encoded samples in decode order, which is also presentation order (no B-frames). */
  samples: Uint8Array[];
  /** Which samples are sync samples (IDR). */
  keyframes: boolean[];
}

type Box = Uint8Array;

const enc = new TextEncoder();

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
function u16(n: number): number[] {
  return [(n >>> 8) & 255, n & 255];
}

function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function box(type: string, ...body: (Uint8Array | number[])[]): Box {
  const payload = concat(body);
  return concat([u32(8 + payload.length), enc.encode(type), payload]);
}

function full(type: string, version: number, flags: number, ...body: (Uint8Array | number[])[]) {
  return box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...body);
}

const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].flatMap(u32);

/** An MP4 file holding the track. */
export function muxH264(t: H264Track): Uint8Array {
  const n = t.samples.length;
  if (!n || t.keyframes.length !== n)
    throw new Error("A track needs samples and a keyframe flag for each.");
  if (!t.keyframes[0]) throw new Error("The first sample must be a keyframe.");
  const duration = n * t.sampleDuration;
  const ftyp = box("ftyp", enc.encode("isom"), u32(0x200), enc.encode("isomiso2avc1mp41"));
  const mvhd = full(
    "mvhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(t.timescale),
    u32(duration),
    u32(0x10000),
    u16(0x100),
    new Array(10).fill(0),
    MATRIX,
    new Array(24).fill(0),
    u32(2),
  );
  const tkhd = full(
    "tkhd",
    0,
    3,
    u32(0),
    u32(0),
    u32(1),
    u32(0),
    u32(duration),
    new Array(8).fill(0),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    MATRIX,
    u32(t.width << 16),
    u32(t.height << 16),
  );
  const mdhd = full(
    "mdhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(t.timescale),
    u32(duration),
    u16(0x55c4),
    u16(0),
  );
  const hdlr = full(
    "hdlr",
    0,
    0,
    u32(0),
    enc.encode("vide"),
    new Array(12).fill(0),
    enc.encode("Ponzu\0"),
  );
  const vmhd = full("vmhd", 0, 1, new Array(8).fill(0));
  const dinf = box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1)));
  const avc1 = box(
    "avc1",
    new Array(6).fill(0),
    u16(1),
    new Array(16).fill(0),
    u16(t.width),
    u16(t.height),
    u32(0x480000),
    u32(0x480000),
    u32(0),
    u16(1),
    new Array(32).fill(0),
    u16(0x18),
    u16(0xffff),
    box("avcC", t.description),
  );
  const stsd = full("stsd", 0, 0, u32(1), avc1);
  const stts = full("stts", 0, 0, u32(1), u32(n), u32(t.sampleDuration));
  const syncs = t.keyframes.flatMap((k, i) => (k ? [i + 1] : []));
  const stss = full("stss", 0, 0, u32(syncs.length), syncs.flatMap(u32));
  const stsz = full(
    "stsz",
    0,
    0,
    u32(0),
    u32(n),
    t.samples.flatMap((s) => u32(s.length)),
  );
  const stsc = full("stsc", 0, 0, u32(1), u32(1), u32(n), u32(1));
  // One chunk: every sample back to back in mdat. Its offset depends on moov's size, which doesn't.
  const stbl = (offset: number) =>
    box("stbl", stsd, stts, stss, stsz, stsc, full("stco", 0, 0, u32(1), u32(offset)));
  const moov = (offset: number) =>
    box(
      "moov",
      mvhd,
      box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", vmhd, dinf, stbl(offset)))),
    );
  const size = moov(0).length;
  const data = concat(t.samples);
  const mdatHeader = concat([u32(8 + data.length), enc.encode("mdat")]);
  return concat([ftyp, moov(ftyp.length + size + 8), mdatHeader, data]);
}
