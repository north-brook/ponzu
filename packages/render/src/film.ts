/**
 * Timelapse films are rendered by the studio's film page (/film), which a
 * host loads, steps frame by frame and captures. These are the shapes both
 * sides share, and the loop that drives any host.
 */
export interface FilmJob {
  /** URL of the film page on the server, e.g. http://127.0.0.1:7777/film. */
  url: string;
  /** The design's key on that server. */
  file: string;
  shape: "16:9" | "1:1" | "9:16";
  /** Leave out for the timelapse (its length follows from what was made). */
  length?: number;
  range?: { from: number; to: number };
  theme: "light" | "dark";
  fps?: number;
}

export interface FilmProgress {
  /** 0–1 */
  done: number;
  frame: number;
  frames: number;
  /** A JPEG of the latest frame, base64, now and then: the poster filling in. */
  poster?: string;
}

export interface FilmResult {
  bytes: Uint8Array;
  mime: "video/mp4" | "video/webm";
  codec: string;
  width: number;
  height: number;
  frames: number;
  duration: number;
}

export interface FilmInfo {
  frames: number;
  fps: number;
  width: number;
  height: number;
  scale: number;
  duration: number;
}

/** What a host must do to run a film page. */
export interface FilmDriver {
  /** Open the page at this CSS viewport and device scale, wait for window.ponzuFilm. */
  open(url: string, width: number, height: number, scale: number): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  /** The viewport as a PNG at the device scale, base64. */
  capture(format: "png" | "jpeg"): Promise<string>;
  close(): Promise<void>;
}

/** The film page's CSS viewport per shape (see filmViewport in @ponzu/core). */
export function filmPageSize(shape: FilmJob["shape"]) {
  if (shape === "1:1") return { w: 720, h: 720, scale: 1.5 };
  if (shape === "9:16") return { w: 540, h: 960, scale: 2 };
  return { w: 960, h: 540, scale: 2 };
}

export class FilmCancelled extends Error {
  constructor() {
    super("The timelapse was cancelled.");
    this.name = "FilmCancelled";
  }
}

/**
 * Load the film, show and capture each frame, hand each to the page's
 * encoder, and return the video. Frame-exact: each frame is the film at
 * i / fps, however long it takes to draw.
 */
export async function driveFilm(
  driver: FilmDriver,
  job: FilmJob,
  opts: { signal?: AbortSignal; onProgress?: (p: FilmProgress) => void } = {},
): Promise<FilmResult> {
  const size = filmPageSize(job.shape);
  await driver.open(job.url, size.w, size.h, size.scale);
  try {
    const spec = {
      file: job.file,
      shape: job.shape,
      length: job.length,
      range: job.range,
      theme: job.theme,
      fps: job.fps ?? 30,
    };
    const info = await driver.evaluate<FilmInfo>(`window.ponzuFilm.load(${JSON.stringify(spec)})`);
    await driver.evaluate("window.ponzuFilm.begin()");
    const posterEvery = Math.max(1, Math.round(info.fps * 1.5));
    for (let i = 0; i < info.frames; i++) {
      if (opts.signal?.aborted) throw new FilmCancelled();
      await driver.evaluate(`window.ponzuFilm.frame(${i})`);
      const shot = await driver.capture("png");
      await driver.evaluate(`window.ponzuFilm.add(${JSON.stringify(shot)}, ${i})`);
      const poster =
        opts.onProgress && (i % posterEvery === 0 || i === info.frames - 1)
          ? await driver.capture("jpeg")
          : undefined;
      opts.onProgress?.({ done: (i + 1) / info.frames, frame: i + 1, frames: info.frames, poster });
    }
    const out = await driver.evaluate<{ data: string; mime: FilmResult["mime"]; codec: string }>(
      "window.ponzuFilm.finish()",
    );
    return {
      bytes: Uint8Array.from(Buffer.from(out.data, "base64")),
      mime: out.mime,
      codec: out.codec,
      width: info.width,
      height: info.height,
      frames: info.frames,
      duration: info.duration,
    };
  } finally {
    await driver.close().catch(() => {});
  }
}
