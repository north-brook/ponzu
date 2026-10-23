import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type FilmShape,
  filmKind,
  JOURNAL_FILE,
  lastSession,
  parseJournal,
  type Range,
} from "@ponzu/core";
import { driveFilm, FilmCancelled, type FilmProgress, type Renderer } from "@ponzu/render";

export interface TimelapseRequest {
  shape: FilmShape;
  /** Leave out for the timelapse (its length follows from what was made). */
  length?: number;
  range?: Range;
  theme: "light" | "dark";
}

export type TimelapseState =
  | { status: "rendering"; done: number; started: number; left?: number }
  | { status: "done"; path: string; mime: string; codec: string; bytes: number; duration: number }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

export interface TimelapseJob {
  id: string;
  key: string;
  request: TimelapseRequest;
  state: TimelapseState;
  /** The latest poster frame, JPEG. */
  poster?: Uint8Array;
  abort: AbortController;
  promise: Promise<TimelapseState>;
}

/** `exports/timelapse-YYYY-MM-DD.mp4`, then -2, -3… when that's taken, like export does. */
export function timelapsePath(root: string, ext: "mp4" | "webm", now = new Date()): string {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const base = join(root, "exports", `timelapse-${d}`);
  if (!existsSync(`${base}.${ext}`)) return `${base}.${ext}`;
  for (let n = 2; ; n++) if (!existsSync(`${base}-${n}.${ext}`)) return `${base}-${n}.${ext}`;
}

/** A film's sidecar: `timelapse-2026-10-22.mp4` → `timelapse-2026-10-22.json`. */
export function filmSidecar(path: string): string {
  return path.replace(/\.(mp4|webm)$/, ".json");
}

async function readEntries(root: string) {
  return parseJournal(
    await Bun.file(join(root, JOURNAL_FILE))
      .text()
      .catch(() => ""),
  );
}

/** What the composer needs about a design's history: its range and comment ticks. */
export async function timelapseInfo(root: string) {
  const text = await Bun.file(join(root, JOURNAL_FILE))
    .text()
    .catch(() => "");
  const entries = parseJournal(text);
  const ops = entries.filter((e) => e.kind === "op");
  const session = lastSession(entries);
  return {
    first: ops[0]?.t ?? null,
    last: ops[ops.length - 1]?.t ?? null,
    session,
    comments: entries.flatMap((e) =>
      e.kind === "op" && e.origin.kind === "user" && filmKind(e) === "comment" ? [e.t] : [],
    ),
    ops: ops.map((e) => e.t),
  };
}

/**
 * Films being made, one at a time per file. Each drives the studio's /film
 * page through the workspace's renderer and writes into the design's
 * exports/ folder.
 */
export class Timelapses {
  private jobs = new Map<string, TimelapseJob>();
  private seq = 0;
  private listeners = new Set<(job: TimelapseJob) => void>();

  constructor(
    private host: {
      renderer?: Renderer;
      /** Where the studio (and /film) is served, e.g. http://127.0.0.1:7777. */
      origin?: string;
      flush(key: string): Promise<void>;
    },
  ) {}

  onChange(fn: (job: TimelapseJob) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(id: string): TimelapseJob | undefined {
    return this.jobs.get(id);
  }

  /** The newest job for a file. */
  latest(key: string): TimelapseJob | undefined {
    return [...this.jobs.values()].filter((j) => j.key === key).at(-1);
  }

  start(key: string, request: TimelapseRequest): TimelapseJob {
    const renderer = this.host.renderer;
    if (!renderer?.filmDriver)
      throw new Error(
        "No renderer here can make films. Install Google Chrome, or use the desktop app.",
      );
    if (!this.host.origin)
      throw new Error("The studio isn't being served, so there's no film page.");
    const running = this.latest(key);
    if (running?.state.status === "rendering")
      throw new Error("A timelapse of this file is already rendering.");
    const id = `tl_${++this.seq}_${Date.now().toString(36)}`;
    const abort = new AbortController();
    const job: TimelapseJob = {
      id,
      key,
      request,
      state: { status: "rendering", done: 0, started: Date.now() },
      abort,
      promise: Promise.resolve({ status: "cancelled" }),
    };
    this.jobs.set(id, job);
    // Keep the last few per file.
    const mine = [...this.jobs.values()].filter((j) => j.key === key);
    for (const old of mine.slice(0, -3)) this.jobs.delete(old.id);
    const emit = () => {
      for (const l of this.listeners) l(job);
    };
    job.promise = (async (): Promise<TimelapseState> => {
      try {
        await this.host.flush(key);
        const driver = await renderer.filmDriver!();
        const out = await driveFilm(
          driver,
          {
            url: `${this.host.origin}/film`,
            file: key,
            shape: request.shape,
            length: request.length,
            range: request.range,
            theme: request.theme,
          },
          {
            signal: abort.signal,
            onProgress: (p: FilmProgress) => {
              const started = job.state.status === "rendering" ? job.state.started : Date.now();
              const spent = (Date.now() - started) / 1000;
              const left =
                p.done > 0.04
                  ? Math.max(1, Math.round((spent / p.done) * (1 - p.done)))
                  : undefined;
              job.state = { status: "rendering", done: p.done, started, left };
              if (p.poster) job.poster = Buffer.from(p.poster, "base64");
              emit();
            },
          },
        );
        const path = timelapsePath(key, out.mime === "video/mp4" ? "mp4" : "webm");
        await mkdir(join(key, "exports"), { recursive: true });
        await writeFile(path, out.bytes);
        // What it covered, beside it: the composer places past films on the history by it.
        const covered = request.range ?? lastSession(await readEntries(key)) ?? undefined;
        await writeFile(
          filmSidecar(path),
          `${JSON.stringify({ range: covered, duration: out.duration }, null, 2)}\n`,
        ).catch(() => {});
        job.state = {
          status: "done",
          path,
          mime: out.mime,
          codec: out.codec,
          bytes: out.bytes.length,
          duration: out.duration,
        };
      } catch (err) {
        job.state =
          err instanceof FilmCancelled || abort.signal.aborted
            ? { status: "cancelled" }
            : { status: "failed", error: err instanceof Error ? err.message : String(err) };
      }
      emit();
      return job.state;
    })();
    emit();
    return job;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.state.status !== "rendering") return false;
    job.abort.abort();
    return true;
  }
}
