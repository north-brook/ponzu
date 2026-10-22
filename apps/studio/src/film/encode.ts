import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from "mp4-muxer";
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from "webm-muxer";

/**
 * Encodes frames in the page with WebCodecs: H.264 in an MP4 where the
 * browser has it (Chrome, Electron), VP9 in WebM otherwise. Frames come in
 * as images (the host captures each one), in order, at a fixed rate.
 */
export interface FilmEncoder {
  readonly codec: string;
  readonly mime: "video/mp4" | "video/webm";
  add(frame: CanvasImageSource, index: number): Promise<void>;
  finish(): Promise<Uint8Array>;
  close(): void;
}

const H264 = ["avc1.640034", "avc1.640028", "avc1.4D0028", "avc1.42E028"];
const VP9 = "vp09.00.40.08";

/** Bits per second for a crisp canvas: text and hairlines need more than footage. */
function bitrateFor(w: number, h: number, fps: number) {
  return Math.round(w * h * fps * 0.16);
}

export async function createEncoder(opts: {
  width: number;
  height: number;
  fps: number;
}): Promise<FilmEncoder> {
  if (typeof VideoEncoder === "undefined")
    throw new Error(
      "This browser can't encode video (no WebCodecs). Use Chrome or the desktop app.",
    );
  const { width, height, fps } = opts;
  const bitrate = bitrateFor(width, height, fps);
  for (const codec of H264) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      avc: { format: "avc" },
      latencyMode: "quality",
    };
    if ((await VideoEncoder.isConfigSupported(config)).supported) return mp4(config, opts);
  }
  const config: VideoEncoderConfig = { codec: VP9, width, height, bitrate, framerate: fps };
  if ((await VideoEncoder.isConfigSupported(config)).supported) return webm(config, opts);
  throw new Error("This browser can encode neither H.264 nor VP9 at this size.");
}

function mp4(config: VideoEncoderConfig, o: { width: number; height: number; fps: number }) {
  const target = new Mp4Target();
  const muxer = new Mp4Muxer({
    target,
    video: { codec: "avc", width: o.width, height: o.height, frameRate: o.fps },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  return wrap(
    config,
    o.fps,
    "video/mp4",
    (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    () => {
      muxer.finalize();
      return new Uint8Array(target.buffer);
    },
  );
}

function webm(config: VideoEncoderConfig, o: { width: number; height: number; fps: number }) {
  const target = new WebmTarget();
  const muxer = new WebmMuxer({
    target,
    video: { codec: "V_VP9", width: o.width, height: o.height, frameRate: o.fps },
    firstTimestampBehavior: "offset",
  });
  return wrap(
    config,
    o.fps,
    "video/webm",
    (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    () => {
      muxer.finalize();
      return new Uint8Array(target.buffer);
    },
  );
}

function wrap(
  config: VideoEncoderConfig,
  fps: number,
  mime: "video/mp4" | "video/webm",
  onChunk: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void,
  done: () => Uint8Array,
): FilmEncoder {
  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => onChunk(chunk, meta),
    error: (e) => {
      failure = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure(config);
  const frameUs = 1_000_000 / fps;
  return {
    codec: config.codec,
    mime,
    async add(source, index) {
      if (failure) throw failure;
      const frame = new VideoFrame(source, {
        timestamp: Math.round(index * frameUs),
        duration: Math.round(frameUs),
      });
      // A keyframe every two seconds, so the film seeks well.
      encoder.encode(frame, { keyFrame: index % (fps * 2) === 0 });
      frame.close();
      // Don't let the queue run away from us.
      while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
    },
    async finish() {
      await encoder.flush();
      if (failure) throw failure;
      encoder.close();
      return done();
    },
    close() {
      if (encoder.state !== "closed") encoder.close();
    },
  };
}
